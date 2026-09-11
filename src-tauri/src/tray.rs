//! System tray icon and menu.
//!
//! The tray is not decoration: with `close_to_tray` on, it is the only way back
//! into a running app, and the tooltip is where a user checks progress without
//! restoring the window.

use crate::state::AppState;
use downpour_core::speed::format_speed;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Downpour", true, None::<&str>)?;
    let pause_all = MenuItem::with_id(app, "pause_all", "Pause all", true, None::<&str>)?;
    let resume_all = MenuItem::with_id(app, "resume_all", "Resume all", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Downpour", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&show, &sep1, &pause_all, &resume_all, &sep2, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Downpour")
        .menu(&menu)
        // Left-clicking the icon should open the window, which is what every
        // Windows user expects; without this the menu is the only way in.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "pause_all" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.engine.pause_all();
                }
            }
            "resume_all" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.engine.resume_all();
                }
            }
            "quit" => {
                let app = app.clone();
                // Pause cleanly first so every sidecar is flushed and the next
                // launch resumes instead of restarting from zero.
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.engine.shutdown().await;
                    }
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    spawn_tooltip_updater(app.clone());
    Ok(())
}

fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Keeps the tray tooltip showing live totals.
///
/// Two seconds rather than the engine's 500ms: the tooltip is only visible on
/// hover, and rewriting it four times a second is pure wasted syscalls.
fn spawn_tooltip_updater<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;

            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let stats = state.engine.stats();

            let text = if stats.running > 0 {
                format!(
                    "Downpour — {} downloading at {}",
                    stats.running,
                    format_speed(stats.total_speed_bps)
                )
            } else if stats.queued > 0 || stats.scheduled > 0 {
                format!("Downpour — {} waiting", stats.queued + stats.scheduled)
            } else {
                "Downpour — idle".to_string()
            };

            if text == last {
                continue;
            }
            last = text.clone();
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(&text));
            }
        }
    });
}
