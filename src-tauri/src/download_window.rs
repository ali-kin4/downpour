//! A progress box for one specific download.
//!
//! The compact panel in `progress_window.rs` is queue-shaped: one window that
//! pages through whatever is moving. This is the other half of IDM's
//! behaviour -- you pick a download out of the tray and get a box for that one
//! download, and you can have several of them open side by side.
//!
//! Like the other panels it is a second webview pointed at the same bundle,
//! here with `?view=download&id=...`, so it inherits the event stream and the
//! design tokens rather than being another frontend to maintain.
//!
//! The label is what makes "several at once" work. One window per download
//! means one label per download, so it is derived from the id; picking the
//! same download twice finds the existing window and focuses it instead of
//! stacking a duplicate.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Namespace for the per-download labels.
///
/// A hyphen, not a colon: download ids are hyphenated UUIDs, so the whole
/// label stays `[0-9a-f-]` and cannot run into whatever a platform or a future
/// Tauri thinks a label may contain. It also keeps the set disjoint from the
/// singleton `"progress"` panel, which a `"progress"`-based prefix would not --
/// `"progress".starts_with("progress")` is true, and every count and sweep
/// below would have quietly included it.
const LABEL_PREFIX: &str = "download-";

/// The window label for a download, and the menu id that opens it.
///
/// Deliberately the same string for both: the tray builds a menu item with
/// this id, the menu handler turns it back into a download id with
/// [`id_from_label`], and there is only one spelling to keep in step.
pub fn label_for(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

/// The inverse of [`label_for`]. `None` for anything that is not one of ours.
pub fn id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX)
}

/// Opens the box for `id`, or brings the existing one forward.
///
/// `name` is only the window title; everything the box displays it reads from
/// the engine itself, so a rename mid-flight is not this function's problem.
pub fn open<R: Runtime>(app: &AppHandle<R>, id: &str, name: &str) -> tauri::Result<()> {
    let label = label_for(id);

    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    // How many boxes are already up, so the next one does not land exactly on
    // top of the last. Six steps before wrapping: past that the cascade walks
    // off the bottom of a small screen, which is worse than an overlap.
    let step = (open_count(app) % 6) as f64;

    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?view=download&id={id}").into()),
    )
    .title(format!("Downpour — {name}"))
    // Smaller than the queue panel's 460x250, which has to fit a filmstrip of
    // prev/next controls and a queue count. One download is a name, a bar, two
    // numbers and two buttons -- about 121px of content, so this is snug on
    // purpose rather than a panel with a download in the corner of it.
    .inner_size(360.0, 146.0)
    .min_inner_size(300.0, 132.0)
    .resizable(true)
    // The whole point of asking for a box is to watch it while you work in
    // something else, so unlike the queue panel this one is pinned from the
    // start -- you went and fetched it deliberately.
    .always_on_top(true)
    // An accessory to the main window, not a second application per download;
    // four open boxes must not become four taskbar buttons.
    .skip_taskbar(true)
    .decorations(true)
    .center()
    .build()?;

    if step > 0.0 {
        // Offset from wherever centring put it, rather than doing monitor
        // arithmetic: this is right on any DPI and any number of screens.
        if let Ok(pos) = window.outer_position() {
            let d = (28.0 * window.scale_factor().unwrap_or(1.0) * step) as i32;
            let _ = window.set_position(tauri::PhysicalPosition::new(pos.x + d, pos.y + d));
        }
    }

    Ok(())
}

fn open_count<R: Runtime>(app: &AppHandle<R>) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| id_from_label(label).is_some())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_round_trips() {
        let id = "3f2a1b4c-0d5e-4f60-9a7b-8c9d0e1f2a3b";
        let label = label_for(id);
        assert_eq!(id_from_label(&label), Some(id));
    }

    #[test]
    fn labels_stay_within_a_conservative_charset() {
        let label = label_for("3f2a1b4c-0d5e-4f60-9a7b-8c9d0e1f2a3b");
        assert!(label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    /// The singleton progress panel must never be mistaken for one of these,
    /// or opening a per-download box would push the cascade along for a window
    /// that is not part of it.
    #[test]
    fn the_shared_progress_panel_is_not_one_of_ours() {
        assert_eq!(id_from_label(crate::progress_window::LABEL), None);
        assert_eq!(id_from_label("confirm"), None);
        assert_eq!(id_from_label("main"), None);
    }
}
