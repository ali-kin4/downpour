//! The compact progress window.
//!
//! A small always-on-top panel showing what is transferring right now, in the
//! spirit of IDM's download dialog. It is a second webview pointed at the same
//! bundle with `?view=progress`, so it shares the store, the event stream and
//! the design tokens instead of being a second frontend to maintain.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "progress";

/// Opens the window, or focuses it if it is already open.
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?view=progress".into()),
    )
    .title("Downpour — downloading")
    .inner_size(460.0, 250.0)
    .min_inner_size(380.0, 180.0)
    .resizable(true)
    // Always on top is the entire point of a progress panel: it exists to
    // be glanceable while you work in something else.
    .always_on_top(true)
    // Kept out of the taskbar so it reads as an accessory to the main
    // window rather than a second application.
    .skip_taskbar(true)
    .decorations(true)
    .center()
    .build()?;
    Ok(())
}

pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}
