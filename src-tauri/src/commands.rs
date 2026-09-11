//! Tauri IPC commands: the complete surface the frontend can call.
//!
//! Every command is thin. Business logic lives in `downpour-core` so it can be
//! tested without a window; these functions translate types and turn engine
//! errors into strings the UI can display.

use downpour_core::model::{DownloadItem, DownloadSpec, RemoteInfo, StartMode};
use downpour_core::settings::Settings;
use downpour_core::{probe, QueueStats};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

/// Errors cross the IPC boundary as plain strings; the frontend has no use for
/// a structured error type it cannot match on exhaustively anyway.
type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_downloads(state: State<'_, AppState>) -> Vec<DownloadItem> {
    state.engine.list()
}

#[tauri::command]
pub fn get_download(state: State<'_, AppState>, id: String) -> Option<DownloadItem> {
    state.engine.get(&id)
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> QueueStats {
    state.engine.stats()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.engine.settings()
}

#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<Settings> {
    state.engine.update_settings(settings).map_err(err)
}

/// Inspects a URL without adding it, so the Add dialog can show the real
/// filename and size before the user commits.
#[tauri::command]
pub async fn probe_url(
    state: State<'_, AppState>,
    url: String,
    headers: Option<BTreeMap<String, String>>,
) -> CmdResult<RemoteInfo> {
    let settings = state.engine.settings();
    let client = downpour_core::transfer::build_client(
        &settings.user_agent,
        std::time::Duration::from_secs(settings.request_timeout_secs),
    )
    .map_err(err)?;
    probe::probe(&client, &url, &headers.unwrap_or_default())
        .await
        .map_err(err)
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

/// What the Add dialog sends. Distinct from `DownloadSpec` because the UI
/// should not have to know about defaulting rules like "empty dest means use
/// the configured folder".
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRequest {
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub dest_dir: Option<PathBuf>,
    #[serde(default)]
    pub connections: Option<u8>,
    #[serde(default)]
    pub start_mode: StartMode,
    #[serde(default)]
    pub checksum: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

impl From<AddRequest> for DownloadSpec {
    fn from(r: AddRequest) -> Self {
        DownloadSpec {
            url: r.url,
            headers: r.headers,
            filename: r.filename,
            dest_dir: r.dest_dir.unwrap_or_default(),
            connections: r.connections,
            category: None,
            start_mode: r.start_mode,
            checksum: r.checksum,
            source: r.source.or_else(|| Some("ui".into())),
        }
    }
}

#[tauri::command]
pub fn add_download(state: State<'_, AppState>, request: AddRequest) -> CmdResult<String> {
    state.engine.add(request.into()).map_err(err)
}

#[tauri::command]
pub fn add_downloads(
    state: State<'_, AppState>,
    requests: Vec<AddRequest>,
) -> CmdResult<Vec<String>> {
    state
        .engine
        .add_many(requests.into_iter().map(Into::into).collect())
        .map_err(err)
}

/// Backs "paste a list of links" and dropping a `.txt` file on the window.
#[tauri::command]
pub fn add_from_text(
    state: State<'_, AppState>,
    text: String,
    start_mode: StartMode,
    dest_dir: Option<PathBuf>,
) -> CmdResult<Vec<String>> {
    state
        .engine
        .add_from_text(&text, start_mode, dest_dir, Some("paste".into()))
        .map_err(err)
}

/// Counts the links in a blob of text without adding anything, so the paste
/// dialog can say "24 links found" as the user types.
#[tauri::command]
pub fn preview_links(text: String) -> Vec<String> {
    downpour_core::extract_urls(&text)
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn start_download(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.start(&id).map_err(err)
}

#[tauri::command]
pub fn force_start_download(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.force_start(&id).map_err(err)
}

#[tauri::command]
pub fn pause_download(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.pause(&id).map_err(err)
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.cancel(&id).map_err(err)
}

#[tauri::command]
pub fn remove_download(
    state: State<'_, AppState>,
    id: String,
    delete_files: bool,
) -> CmdResult<()> {
    state.engine.remove(&id, delete_files).map_err(err)
}

#[tauri::command]
pub fn set_scheduled(state: State<'_, AppState>, id: String, scheduled: bool) -> CmdResult<()> {
    state.engine.set_scheduled(&id, scheduled).map_err(err)
}

#[tauri::command]
pub fn move_to_top(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.move_to_top(&id).map_err(err)
}

#[tauri::command]
pub fn move_to_bottom(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.move_to_bottom(&id).map_err(err)
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn pause_all(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.pause_all().map_err(err)
}

#[tauri::command]
pub fn resume_all(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.resume_all().map_err(err)
}

#[tauri::command]
pub fn retry_failed(state: State<'_, AppState>) -> CmdResult<usize> {
    state.engine.retry_failed().map_err(err)
}

#[tauri::command]
pub fn clear_completed(state: State<'_, AppState>) -> CmdResult<usize> {
    state.engine.clear_completed().map_err(err)
}

#[tauri::command]
pub fn clear_finished(state: State<'_, AppState>) -> CmdResult<usize> {
    state.engine.clear_finished().map_err(err)
}

#[tauri::command]
pub fn remove_many(
    state: State<'_, AppState>,
    ids: Vec<String>,
    delete_files: bool,
) -> CmdResult<usize> {
    let mut removed = 0;
    for id in ids {
        // One bad id must not abort the rest of a multi-select delete.
        if state.engine.remove(&id, delete_files).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn start_many(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<usize> {
    let mut started = 0;
    for id in ids {
        if state.engine.start(&id).is_ok() {
            started += 1;
        }
    }
    Ok(started)
}

#[tauri::command]
pub fn pause_many(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<usize> {
    let mut paused = 0;
    for id in ids {
        if state.engine.pause(&id).is_ok() {
            paused += 1;
        }
    }
    Ok(paused)
}

// ---------------------------------------------------------------------------
// Shell integration
// ---------------------------------------------------------------------------

/// Opens a finished file with its default application.
#[tauri::command]
pub fn open_path(app: AppHandle, path: PathBuf) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    if !path.exists() {
        return Err(format!("{} no longer exists", path.display()));
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(err)
}

/// Opens the containing folder with the file selected.
#[tauri::command]
pub fn reveal_path(app: AppHandle, path: PathBuf) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    if path.exists() {
        return app.opener().reveal_item_in_dir(&path).map_err(err);
    }
    // The file is gone but the folder usually is not; showing the folder beats
    // an error dialog when a user cleans up a download themselves.
    match path.parent() {
        Some(dir) if dir.exists() => app
            .opener()
            .open_path(dir.to_string_lossy(), None::<&str>)
            .map_err(err),
        _ => Err(format!("{} no longer exists", path.display())),
    }
}

#[tauri::command]
pub fn path_exists(path: PathBuf) -> bool {
    path.exists()
}

// ---------------------------------------------------------------------------
// Browser integration
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcInfo {
    pub port: u16,
    pub token: String,
    pub enabled: bool,
    /// True once the listener is actually bound, so Settings can show a live
    /// status rather than just echoing the configuration back.
    pub listening: bool,
}

#[tauri::command]
pub fn get_rpc_info(state: State<'_, AppState>) -> RpcInfo {
    let settings = state.engine.settings();
    let bound = state.rpc_port.load(std::sync::atomic::Ordering::Relaxed);
    RpcInfo {
        port: if bound > 0 { bound } else { settings.rpc_port },
        token: settings.rpc_token,
        enabled: settings.rpc_enabled,
        listening: bound > 0,
    }
}

/// Invalidates the current token and issues a new one. Any paired extension
/// must be re-paired, which is the point.
#[tauri::command]
pub fn regenerate_rpc_token(state: State<'_, AppState>) -> CmdResult<String> {
    let mut settings = state.engine.settings();
    settings.rpc_token = downpour_core::settings::generate_token();
    let saved = state.engine.update_settings(settings).map_err(err)?;
    Ok(saved.rpc_token)
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Reads a UTF-8 text file so the "import links from a .txt" flow works.
///
/// A dedicated command rather than the filesystem plugin: the plugin would
/// grant the webview broad read access through a capability, and all this
/// needs is one small text file the user explicitly picked.
#[tauri::command]
pub async fn read_text_file(path: PathBuf) -> CmdResult<String> {
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    let meta = tokio::fs::metadata(&path).await.map_err(err)?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "{} is {} bytes; link lists are expected to be small",
            path.display(),
            meta.len()
        ));
    }
    tokio::fs::read_to_string(&path).await.map_err(err)
}

/// Shuts the app down cleanly.
///
/// Pauses every transfer first so each sidecar is flushed; killing the process
/// outright would cost up to a second of progress on every running download.
#[tauri::command]
pub async fn quit_app(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.shutdown().await;
    app.exit(0);
    Ok(())
}

/// Cancels a pending "shut down when finished" countdown.
#[tauri::command]
pub fn abort_power_action() {
    crate::power::abort_shutdown();
}

/// The folder each file type is routed into, for the Settings screen.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryFolder {
    pub name: String,
    pub icon: String,
    pub path: PathBuf,
    pub exists: bool,
    pub extensions: Vec<String>,
}

#[tauri::command]
pub fn category_folders(state: State<'_, AppState>) -> Vec<CategoryFolder> {
    let s = state.engine.settings();
    s.categories
        .iter()
        .map(|c| {
            let path = if c.folder.trim().is_empty() {
                s.download_dir.clone()
            } else {
                s.download_dir.join(&c.folder)
            };
            CategoryFolder {
                name: c.name.clone(),
                icon: c.icon.clone(),
                exists: path.is_dir(),
                path,
                extensions: c.extensions.clone(),
            }
        })
        .collect()
}

/// Creates any category folder that is missing, on demand from Settings.
#[tauri::command]
pub fn create_category_folders(state: State<'_, AppState>) -> CmdResult<usize> {
    let s = state.engine.settings();
    let mut made = 0;
    for folder in s.category_folders() {
        if !folder.is_dir() {
            std::fs::create_dir_all(&folder).map_err(err)?;
            made += 1;
        }
    }
    Ok(made)
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
