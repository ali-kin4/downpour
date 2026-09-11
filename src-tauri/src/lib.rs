//! Downpour desktop shell.
//!
//! The shell owns everything that needs a window, a tray or the operating
//! system; all download logic lives in `downpour-core` so it can be tested
//! headlessly. Keeping that line clean is what let the engine ship with 161
//! tests before a window existed.

mod commands;
mod power;
mod rpc;
mod state;
mod tray;

use downpour_core::{Engine, EngineConfig, EngineEvent};
use state::AppState;
use std::sync::atomic::Ordering;
use tauri::{Manager, WindowEvent};

pub fn run() {
    init_tracing();

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
            commands::app_version,
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

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let db_path = state::data_dir(&handle).join("downpour.db");
    tracing::info!(path = %db_path.display(), "opening database");

    // The engine spawns its pump on construction, so it must be built inside
    // the async runtime context. `block_on` puts us there; constructing it on
    // a bare thread would panic with "no reactor running".
    let engine = tauri::async_runtime::block_on(async { Engine::new(EngineConfig { db_path }) })?;

    app.manage(AppState::new(engine.clone()));
    state::spawn_event_bridge(handle.clone(), &engine);
    spawn_power_watcher(handle.clone(), &engine);
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

/// Watches for the queue draining and runs the configured post-queue action.
fn spawn_power_watcher(app: tauri::AppHandle, engine: &Engine) {
    let mut rx = engine.subscribe();
    let engine = engine.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if let EngineEvent::QueueDrained { completed, .. } = event {
                let action = engine.settings().on_queue_complete;
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

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_env("DOWNPOUR_LOG")
        .unwrap_or_else(|_| EnvFilter::new("downpour=info,downpour_core=info,warn"));
    let _ = fmt().with_env_filter(filter).try_init();
}
