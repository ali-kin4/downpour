//! Shared application state and the bridge from engine events to the webview.

use downpour_core::{Engine, EngineEvent};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// The single event channel the frontend listens on. One channel with a tagged
/// payload beats a dozen named events: the UI reducer stays in one place and
/// adding an event variant does not require touching the listener setup.
pub const EVENT_CHANNEL: &str = "downpour://event";

pub struct AppState {
    pub engine: Engine,
    /// The port the loopback RPC server actually bound, which may differ from
    /// the configured one if it was taken.
    pub rpc_port: std::sync::atomic::AtomicU16,
    /// Unix seconds until which `/api/v1/pair` will hand out the token, or 0.
    ///
    /// Pairing has to be unauthenticated -- handing over the token is the point
    /// -- so what makes it safe is that it only answers during a window the
    /// user opened by clicking in the app. Outside that window there is nothing
    /// to attack. A deadline rather than a flag so it cannot be left open by a
    /// path that forgot to close it.
    pub pairing_until: std::sync::atomic::AtomicI64,
    /// Downloads the browser handed over that are waiting to be confirmed.
    ///
    /// Held here rather than pushed straight at the window, because the window
    /// is opened by the same request that produces one: an event emitted in
    /// that instant arrives before the webview exists to hear it, and is simply
    /// lost. The panel reads this list when it loads and the event only tells
    /// an *already open* panel that the list has grown.
    pub pending: parking_lot::Mutex<Vec<PendingDownload>>,
}

/// A download waiting for the user to say yes.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDownload {
    /// Identifies this request while it waits. Nothing is in the engine yet, so
    /// there is no download id to use.
    pub id: String,
    pub url: String,
    pub headers: std::collections::BTreeMap<String, String>,
    pub filename: Option<String>,
    pub dest_dir: Option<std::path::PathBuf>,
    pub size_hint: Option<u64>,
    pub source: Option<String>,
}

impl AppState {
    pub fn new(engine: Engine) -> Self {
        Self {
            engine,
            pairing_until: std::sync::atomic::AtomicI64::new(0),
            pending: parking_lot::Mutex::new(Vec::new()),
            rpc_port: std::sync::atomic::AtomicU16::new(0),
        }
    }
}

/// Where Downpour keeps its database and logs.
pub fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("downpour"))
}

/// Forwards every engine event to the webview.
///
/// The engine broadcasts on a bounded channel; if the UI is slow enough to lag
/// behind we skip to the newest events rather than blocking the engine, and the
/// frontend recovers by re-reading the full list. Dropping progress ticks is
/// harmless, and a stalled engine is not.
pub fn spawn_event_bridge(app: AppHandle, engine: &Engine) {
    let mut rx = engine.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Err(e) = app.emit(EVENT_CHANNEL, &event) {
                        tracing::warn!(error = %e, "failed to forward engine event");
                    }
                    notify_if_needed(&app, &event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "UI fell behind engine events");
                    // Tell the frontend to resynchronise from a full list().
                    let _ = app.emit(EVENT_CHANNEL, serde_json::json!({ "kind": "resync" }));
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Raises a desktop notification for the events worth interrupting someone over.
fn notify_if_needed(app: &AppHandle, event: &EngineEvent) {
    use tauri_plugin_notification::NotificationExt;

    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let settings = state.engine.settings();

    let (title, body) = match event {
        EngineEvent::Completed { id, path, .. } => {
            if !settings.notify_on_complete {
                return;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| id.clone());
            ("Download complete".to_string(), name)
        }
        EngineEvent::Failed { id, error } => {
            if !settings.notify_on_error {
                return;
            }
            let name = state
                .engine
                .get(id)
                .map(|i| i.filename)
                .unwrap_or_else(|| id.clone());
            ("Download failed".to_string(), format!("{name}: {error}"))
        }
        _ => return,
    };

    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::debug!(error = %e, "notification suppressed");
    }
}
