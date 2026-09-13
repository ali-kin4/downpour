//! Downpour desktop shell.
//!
//! The shell owns everything that needs a window, a tray or the operating
//! system; all download logic lives in `downpour-core` so it can be tested
//! headlessly. Keeping that line clean is what let the engine ship with 161
//! tests before a window existed.

mod clipboard;
mod commands;
mod logging;
mod media;
mod power;
mod progress_window;
mod rpc;
mod state;
mod tray;
mod update;

use downpour_core::{Engine, EngineConfig, EngineEvent};
use state::AppState;
use std::sync::atomic::Ordering;
use tauri::{Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        // Re-focus the existing window instead of starting a second copy: two
        // engines against one SQLite file would fight over the queue.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(autostart_plugin())
        .setup(setup)
        .on_window_event(handle_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::list_downloads,
            commands::get_download,
            commands::get_stats,
            commands::get_settings,
            commands::update_settings,
            commands::probe_url,
            commands::add_download,
            commands::add_downloads,
            commands::add_from_text,
            commands::preview_links,
            commands::start_download,
            commands::force_start_download,
            commands::pause_download,
            commands::cancel_download,
            commands::remove_download,
            commands::set_scheduled,
            commands::move_to_top,
            commands::move_to_bottom,
            commands::pause_all,
            commands::resume_all,
            commands::retry_failed,
            commands::clear_completed,
            commands::clear_finished,
            commands::remove_many,
            commands::start_many,
            commands::pause_many,
            commands::open_path,
            commands::reveal_path,
            commands::path_exists,
            commands::get_rpc_info,
            commands::regenerate_rpc_token,
            commands::show_main_window,
            commands::abort_power_action,
            commands::read_text_file,
            commands::quit_app,
            commands::category_folders,
            commands::create_category_folders,
            commands::check_duplicate,
            commands::reset_settings,
            commands::open_log_folder,
            commands::read_log_tail,
            commands::copy_diagnostics,
            commands::open_progress_window,
            commands::close_progress_window,
            commands::progress_window_open,
            clipboard::note_clipboard_copy,
            clipboard::read_clipboard_urls,
            commands::app_version,
            media::yt_dlp_status,
            media::install_yt_dlp,
            media::probe_media,
            media::resolve_media,
            update::check_for_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Downpour");
}

/// The autostart plugin only exists on desktop targets we support it on; this
/// keeps the builder chain readable rather than sprinkling `cfg` through it.
#[cfg(windows)]
fn autostart_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--minimized"]),
    )
}

#[cfg(not(windows))]
fn autostart_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_opener::init()
}

/// Keeps the log writer's flush thread alive for as long as the app runs.
struct LogGuard(#[allow(dead_code)] tracing_appender::non_blocking::WorkerGuard);

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let data_dir = state::data_dir(&handle);

    // Held for the lifetime of the process: dropping it stops the background
    // writer flushing, which loses exactly the lines before a crash.
    if let Some(guard) = logging::init(&data_dir) {
        app.manage(LogGuard(guard));
    }
    logging::log_startup_context(&app.package_info().version.to_string());

    let db_path = data_dir.join("downpour.db");
    tracing::info!(path = %db_path.display(), "opening database");

    // The engine spawns its pump on construction, so it must be built inside
    // the async runtime context. `block_on` puts us there; constructing it on
    // a bare thread would panic with "no reactor running".
    let engine = tauri::async_runtime::block_on(async { Engine::new(EngineConfig { db_path }) })?;

    app.manage(AppState::new(engine.clone()));

    // Materialise the category folders on the very first launch, the way IDM
    // does. Guarded internally so it runs once, reuses anything already there,
    // and never fails startup.
    match engine.run_first_run_setup() {
        Ok(created) if !created.is_empty() => {
            tracing::info!(count = created.len(), "created download category folders")
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "first-run folder setup failed"),
    }

    state::spawn_event_bridge(handle.clone(), &engine);
    spawn_power_watcher(handle.clone(), &engine);
    spawn_progress_window_watcher(handle.clone(), &engine);
    clipboard::spawn(handle.clone(), engine.clone());
    tray::build(&handle)?;
    apply_autostart(&handle);

    // Binding the listener is not allowed to fail startup: the app is fully
    // usable without browser integration.
    {
        let engine = engine.clone();
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(port) = rpc::serve(engine, handle.clone()).await {
                if let Some(state) = handle.try_state::<AppState>() {
                    state.rpc_port.store(port, Ordering::Relaxed);
                }
            }
        });
    }

    if engine.settings().start_minimized {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    }

    Ok(())
}

/// Pops the compact progress panel the moment a transfer starts.
///
/// Driven by the event stream rather than by the add path, so it appears for a
/// download that started from the tray, the browser extension or a scheduler
/// window opening at 2am — not only for one the user clicked Add on.
fn spawn_progress_window_watcher(app: tauri::AppHandle, engine: &Engine) {
    let mut rx = engine.subscribe();
    let engine = engine.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = rx.recv().await {
            let started = matches!(
                event,
                EngineEvent::StatusChanged {
                    status: downpour_core::DownloadStatus::Running,
                    ..
                }
            );
            if !started || !engine.settings().progress_window {
                continue;
            }
            if let Err(e) = progress_window::open(&app) {
                tracing::warn!(error = %e, "could not open the progress window");
            }
        }
    });
}

/// Watches for the queue draining and runs the configured post-queue action.
fn spawn_power_watcher(app: tauri::AppHandle, engine: &Engine) {
    let mut rx = engine.subscribe();
    let engine = engine.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if let EngineEvent::QueueDrained { completed, .. } = event {
                let settings = engine.settings();
                let action = settings.on_queue_complete;
                // Disarm before dispatching, not after: the action is a choice
                // about *this* queue, and leaving "sleep when finished" set
                // means the next download that ever finishes puts the machine
                // to sleep without anyone asking for it again. Only when it is
                // actually going to fire, though — a drain that completed
                // nothing must leave the user's setting exactly where it was.
                if power::will_act(action, completed) {
                    let mut next = settings;
                    next.on_queue_complete = downpour_core::settings::OnQueueComplete::Nothing;
                    if let Err(e) = engine.update_settings(next) {
                        tracing::warn!(error = %e, "could not disarm the post-queue action");
                    }
                }
                power::on_queue_drained(&app, action, completed);
            }
        }
    });
}

/// Honours the "start with Windows" setting on every launch, so toggling it in
/// Settings and the registry state cannot drift apart.
#[cfg(windows)]
fn apply_autostart(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let wanted = state.engine.settings().launch_at_login;
    let mgr = app.autolaunch();
    let current = mgr.is_enabled().unwrap_or(false);
    if wanted == current {
        return;
    }
    let result = if wanted { mgr.enable() } else { mgr.disable() };
    if let Err(e) = result {
        tracing::warn!(error = %e, wanted, "could not update the autostart entry");
    }
}

#[cfg(not(windows))]
fn apply_autostart(_app: &tauri::AppHandle) {}

fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        // Only the main window hides instead of closing. Closing the compact
        // progress panel must genuinely close it -- and must never touch the
        // downloads, which live in the engine and know nothing about windows.
        if window.label() != "main" {
            return;
        }
        let Some(state) = window.try_state::<AppState>() else {
            return;
        };
        if !state.engine.settings().close_to_tray {
            return;
        }
        // Closing hides rather than exits: an always-resident downloader that
        // quits on the X button cannot honour a 2am schedule.
        api.prevent_close();
        let _ = window.hide();
    }
}
