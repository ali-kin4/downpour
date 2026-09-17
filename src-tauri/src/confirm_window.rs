//! The capture confirmation window.
//!
//! When the extension intercepts a click and the user has asked to be
//! consulted, this is what asks. A small panel near the corner of the screen
//! carrying the filename, size and destination, in the spirit of IDM's
//! download dialog -- not the main window brought to the front, which is a
//! whole application arriving to ask a one-line question and is what the
//! feature did before.
//!
//! Like the progress panel it is a second webview pointed at the same bundle,
//! here with `?view=confirm`, so it shares the store, the event stream and the
//! design tokens instead of being a second frontend to maintain.
//!
//! One window, not one per download. A page that fires four downloads at once
//! would otherwise stack four dialogs on the screen; instead the window keeps a
//! queue and asks about them in turn, and closes itself when the last one is
//! answered.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "confirm";

/// Opens the window, or brings the existing one forward.
///
/// Called immediately before the pending download is emitted. The window
/// listens for that event itself, so one already open simply adds the new
/// download to its queue.
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
        WebviewUrl::App("index.html?view=confirm".into()),
    )
    .title("Downpour")
    // Sized to its contents. It was taller than what it holds, which left a
    // band of empty panel under the destination and made a small question look
    // like an unfinished window.
    .inner_size(460.0, 258.0)
    .resizable(false)
    // It is a question, and it is answered with the keyboard as often as with
    // the mouse, so it has to be in front and it has to take focus.
    .always_on_top(true)
    .focused(true)
    // An accessory to the main window rather than a second application in the
    // taskbar -- the same reasoning as the progress panel.
    .skip_taskbar(true)
    .decorations(true)
    .center()
    .build()?;
    Ok(())
}
