//! Clipboard monitoring — the IDM "copy a link and it offers to grab it" trick.
//!
//! Polling rather than an OS clipboard listener: Windows clipboard-chain
//! notifications need a message-pump window and are famously fragile when
//! another badly-behaved app is in the chain. A one-second poll of a string
//! costs nothing measurable and cannot be broken by someone else's bug.
//!
//! Three rules keep it from becoming a nuisance, which is the usual fate of
//! this feature:
//!
//! 1. **Off by default.** An app that watches your clipboard without being
//!    asked is spyware-shaped, however good the intent.
//! 2. **Never re-offers the same text.** Copying a link, dismissing the offer
//!    and copying something else must not bring it back.
//! 3. **Ignores what Downpour itself copied.** "Copy source link" putting a URL
//!    on the clipboard must not immediately offer to download it again.

use downpour_core::{Engine, StartMode};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Event the UI listens on to offer a captured link.
pub const EVENT: &str = "downpour://clipboard";

const POLL_INTERVAL: Duration = Duration::from_millis(1200);

/// Text Downpour itself placed on the clipboard, so the watcher can skip it.
///
/// A hash rather than the string: the watcher only needs to recognise it, and
/// keeping a copy of everything the app ever copied is pointless.
static SELF_COPIED: AtomicU64 = AtomicU64::new(0);

/// Call after the app writes to the clipboard.
pub fn note_self_copy(text: &str) {
    SELF_COPIED.store(hash(text), Ordering::Relaxed);
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardCapture {
    pub urls: Vec<String>,
    /// Already added to the queue, so the UI confirms rather than asks.
    pub auto_added: bool,
}

pub fn spawn(app: AppHandle, engine: Engine) {
    tauri::async_runtime::spawn(async move {
        let mut last_seen: u64 = 0;

        loop {
            tokio::time::sleep(POLL_INTERVAL).await;

            let settings = engine.settings();
            if !settings.clipboard_watch {
                // Keep the loop alive rather than returning: the setting can be
                // switched on without restarting the app, and re-reading a bool
                // once a second is free.
                continue;
            }

            let Ok(text) = app.clipboard().read_text() else {
                // An empty clipboard, or one holding an image, is not an error.
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }

            let digest = hash(&text);
            if digest == last_seen || digest == SELF_COPIED.load(Ordering::Relaxed) {
                continue;
            }
            last_seen = digest;

            // The engine owns URL extraction, so what is offered here is
            // exactly what would be added. A second parser would eventually
            // disagree with the first.
            let urls: Vec<String> = downpour_core::extract_urls(&text)
                .into_iter()
                .filter(|u| settings.clipboard_matches(u))
                .collect();
            if urls.is_empty() {
                continue;
            }

            tracing::debug!(count = urls.len(), "captured links from the clipboard");

            let auto_added = settings.clipboard_auto_add;
            if auto_added {
                let start_mode = if settings.schedule_new_downloads && settings.schedule.enabled {
                    StartMode::Schedule
                } else {
                    StartMode::Start
                };
                let joined = urls.join("\n");
                if let Err(e) =
                    engine.add_from_text(&joined, start_mode, None, Some("clipboard".into()))
                {
                    tracing::warn!(error = %e, "could not add clipboard links");
                    continue;
                }
            }

            let _ = app.emit(EVENT, ClipboardCapture { urls, auto_added });
        }
    });
}

/// FNV-1a. Not cryptographic and does not need to be — this is change
/// detection on a string we already hold.
fn hash(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // Zero is the "nothing recorded" sentinel, so never return it.
    if h == 0 {
        1
    } else {
        h
    }
}

/// Exposed so the frontend can tell the watcher "this text came from us".
#[tauri::command]
pub fn note_clipboard_copy(app: AppHandle, text: String) {
    let _ = app;
    note_self_copy(&text);
}

/// Lets Settings verify the feature works without waiting for a poll.
#[tauri::command]
pub fn read_clipboard_urls(app: AppHandle) -> Vec<String> {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return Vec::new();
    };
    let settings = state.engine.settings();
    let Ok(text) = app.clipboard().read_text() else {
        return Vec::new();
    };
    downpour_core::extract_urls(&text)
        .into_iter()
        .filter(|u| settings.clipboard_matches(u))
        .collect()
}

#[allow(dead_code)]
type Shared = Arc<()>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_discriminating() {
        assert_eq!(hash("https://a.com/x.zip"), hash("https://a.com/x.zip"));
        assert_ne!(hash("https://a.com/x.zip"), hash("https://a.com/y.zip"));
    }

    #[test]
    fn hash_never_returns_the_empty_sentinel() {
        // Zero means "nothing recorded"; a real string colliding with it would
        // make the watcher skip that text forever.
        for s in ["", "a", "https://example.com", "\u{1f600}"] {
            assert_ne!(hash(s), 0);
        }
    }

    #[test]
    fn self_copied_text_is_recognised() {
        note_self_copy("https://example.com/from-downpour.zip");
        assert_eq!(
            SELF_COPIED.load(Ordering::Relaxed),
            hash("https://example.com/from-downpour.zip")
        );
    }
}
