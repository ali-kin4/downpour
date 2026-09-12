//! Media-page support: turning "paste a video page URL" into a real download.
//!
//! # The shape of this feature
//!
//! Downpour cannot extract a media URL from a video page on its own — every
//! site does it differently and they all change constantly. [yt-dlp] already
//! solves that problem and nothing else comes close. So this module treats
//! yt-dlp as an **optional, user-installed metadata source**: it asks yt-dlp
//! *where the media actually lives* and *what headers are needed to fetch it*,
//! and then hands that to Downpour's own segmented engine.
//!
//! ## Why we do not let yt-dlp download
//!
//! yt-dlp is a single-connection downloader with no resume UI, no queue, no
//! scheduler and no speed limiting. Downpour's engine has all of those, plus
//! multi-connection segmentation, which is the entire reason this application
//! exists. Handing the direct URL to our own engine means a video downloads on
//! sixteen connections, survives a dropped link, honours the scheduler and
//! appears in the list next to everything else. Letting yt-dlp download would
//! make the one feature people came for unavailable for exactly the files
//! they most want it for.
//!
//! ## Why the headers matter
//!
//! The URLs yt-dlp returns are usually signed CDN links that are only served
//! to a request carrying the right `Referer` and `User-Agent`. Fetch the same
//! URL without them and the CDN answers `403`, which looks to a user like a
//! broken feature rather than a missing header. yt-dlp reports the exact set
//! it used in `http_headers`; we forward it (minus a few headers that are the
//! transport's business — see [`is_forwardable_header`]).
//!
//! ## Licensing — read before changing anything here
//!
//! yt-dlp is **never** vendored, bundled, mirrored or committed, and is
//! **never** installed without an explicit click. It is fetched from the
//! official yt-dlp GitHub releases into the app data directory, and the
//! download is verified against the `SHA2-256SUMS` file published in the same
//! release before it is allowed to run. ffmpeg is not fetched at all, which is
//! why muxing separate audio and video streams is out of scope. See
//! `docs/media.md`.
//!
//! [yt-dlp]: https://github.com/yt-dlp/yt-dlp

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Errors cross the IPC boundary as plain strings, matching `commands.rs`.
type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The one and only place yt-dlp is ever fetched from.
const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

/// The checksum manifest yt-dlp publishes alongside every release asset.
const CHECKSUM_ASSET: &str = "SHA2-256SUMS";

/// The release asset for this platform. Also the name it is stored under, so
/// the checksum line and the local file always refer to the same thing.
#[cfg(windows)]
const BINARY_NAME: &str = "yt-dlp.exe";
#[cfg(target_os = "macos")]
const BINARY_NAME: &str = "yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const BINARY_NAME: &str = "yt-dlp_linux";

/// yt-dlp can legitimately take a while: some extractors solve a JS challenge
/// on the first call. But an external process that never returns must not hang
/// a dialog forever, so every invocation is bounded.
const PROBE_TIMEOUT: Duration = Duration::from_secs(90);
const VERSION_TIMEOUT: Duration = Duration::from_secs(20);

/// Stops a console window flashing on every probe. Without it, `yt-dlp.exe`
/// briefly pops a black box on top of whatever the user is doing — several
/// times per Add dialog, because we re-probe as they type.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Install progress is pushed on its own channel rather than the engine's:
/// installing a tool is not a download and does not belong in the queue's
/// event union.
pub const MEDIA_EVENT_CHANNEL: &str = "downpour://media";

/// Serialises installs. Two concurrent installs would race on the same part
/// file and one would rename out from under the other.
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpStatus {
    pub installed: bool,
    /// Where it is, or where it would go. Shown to the user before they agree
    /// to an install, so they know exactly what lands where.
    pub path: PathBuf,
    pub version: Option<String>,
    /// Set when the file exists but will not run — a partial download, an
    /// antivirus quarantine, a blocked executable.
    pub error: Option<String>,
}

/// One downloadable rendition of a media page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormat {
    pub format_id: String,
    pub ext: String,
    pub resolution: Option<String>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    /// Bytes. Exact when the server reported it, otherwise derived.
    pub filesize: Option<u64>,
    /// True when `filesize` came from `filesize_approx` or a bitrate estimate,
    /// so the UI can say "about" rather than lying with a precise number.
    pub filesize_is_estimate: bool,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    /// Has **both** audio and video in one stream. These are the formats
    /// Downpour can download on its own; everything else would need ffmpeg to
    /// mux, which we deliberately do not ship.
    pub progressive: bool,
    /// A plain HTTP(S) resource rather than a segmented playlist. HLS and DASH
    /// manifests cannot be handed to a byte-range engine at all.
    pub direct_http: bool,
    pub protocol: Option<String>,
    pub label: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub title: String,
    pub duration_secs: Option<f64>,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
    pub webpage_url: Option<String>,
    pub extractor: Option<String>,
    /// A live stream has no fixed length and no byte range to segment.
    pub is_live: bool,
    pub formats: Vec<MediaFormat>,
}

/// Everything the add path needs to fetch one chosen format.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMedia {
    pub url: String,
    /// The headers yt-dlp says this URL requires. Omitting them is usually a
    /// `403`, not a slow download.
    pub headers: BTreeMap<String, String>,
    pub filename: String,
    pub filesize: Option<u64>,
    pub format_id: String,
    pub ext: String,
    pub progressive: bool,
    pub direct_http: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// `resolving` | `checksum` | `downloading` | `verifying` | `done`
    pub phase: &'static str,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub message: String,
}

impl InstallProgress {
    fn step(phase: &'static str, message: impl Into<String>) -> Self {
        Self {
            phase,
            downloaded: 0,
            total: None,
            message: message.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Tools live beside the database, not next to the executable: Program Files
/// is not writable by a normal user, and a per-user tool is easier to remove.
fn tools_dir(app: &AppHandle) -> PathBuf {
    crate::state::data_dir(app).join("tools")
}

fn binary_path(app: &AppHandle) -> PathBuf {
    tools_dir(app).join(BINARY_NAME)
}

fn user_agent(app: &AppHandle) -> String {
    format!("Downpour/{}", app.package_info().version)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Whether yt-dlp is present, and if so which version.
///
/// Deliberately infallible: "not installed" is a normal state the UI must
/// render, not an error to toast.
#[tauri::command]
pub async fn yt_dlp_status(app: AppHandle) -> YtDlpStatus {
    let path = binary_path(&app);
    if !path.is_file() {
        return YtDlpStatus {
            installed: false,
            path,
            version: None,
            error: None,
        };
    }
    // The file existing is not the same as it working: an interrupted install
    // or an antivirus quarantine both leave something on disk.
    match run_tool(&path, &["--version"], VERSION_TIMEOUT).await {
        Ok(out) => YtDlpStatus {
            installed: true,
            path,
            version: Some(out.trim().to_string()),
            error: None,
        },
        Err(e) => YtDlpStatus {
            installed: false,
            path,
            version: None,
            error: Some(e),
        },
    }
}

/// Downloads yt-dlp from its official GitHub release and verifies it.
///
/// **This must only ever be reached from an explicit user action** that names
/// what is being downloaded and where it comes from. It is never called on
/// startup, never called speculatively from a probe, and never retried
/// automatically.
///
/// The verification is not decoration. We are fetching an executable over the
/// network and then running it; the release's own `SHA2-256SUMS` is the only
/// thing standing between "the official build" and "whatever the connection
/// handed us". A missing checksum line is treated as a failure, not as
/// permission to skip the check.
#[tauri::command]
pub async fn install_yt_dlp(app: AppHandle) -> CmdResult<YtDlpStatus> {
    let _guard = INSTALL_LOCK
        .try_lock()
        .map_err(|_| "yt-dlp is already being installed.".to_string())?;

    let client = downpour_core::transfer::build_client(&user_agent(&app), Duration::from_secs(60))
        .map_err(err)?;

    // 1. Resolve the latest release. Pinning to one resolved tag (rather than
    //    hitting `/releases/latest/download/` twice) guarantees the binary and
    //    the checksums come from the same release.
    emit(
        &app,
        InstallProgress::step("resolving", "Finding the latest yt-dlp release…"),
    );
    let release_body = client
        .get(RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("could not reach the yt-dlp releases API: {e}"))?
        .error_for_status()
        .map_err(|e| format!("the yt-dlp releases API refused the request: {e}"))?
        .text()
        .await
        .map_err(err)?;
    // reqwest is not built with its `json` feature here, so parse by hand.
    let release: Value = serde_json::from_str(&release_body)
        .map_err(|e| format!("the yt-dlp releases API returned something unreadable: {e}"))?;

    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("latest")
        .to_string();
    let assets = release
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("release {tag} lists no assets"))?;
    let asset_url = |name: &str| -> Option<String> {
        assets
            .iter()
            .find(|a| a.get("name").and_then(Value::as_str) == Some(name))
            .and_then(|a| a.get("browser_download_url").and_then(Value::as_str))
            .map(str::to_string)
    };

    let binary_url = asset_url(BINARY_NAME)
        .ok_or_else(|| format!("yt-dlp release {tag} does not publish {BINARY_NAME}"))?;
    let sums_url = asset_url(CHECKSUM_ASSET).ok_or_else(|| {
        format!("yt-dlp release {tag} does not publish {CHECKSUM_ASSET}; refusing to install a binary that cannot be verified")
    })?;

    // 2. Fetch the checksums first. If they are unavailable there is no point
    //    spending 30 MB of someone's bandwidth on a file we would then refuse.
    emit(
        &app,
        InstallProgress::step("checksum", format!("Reading the checksums for {tag}…")),
    );
    let sums = client
        .get(&sums_url)
        .send()
        .await
        .map_err(|e| format!("could not fetch {CHECKSUM_ASSET}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("could not fetch {CHECKSUM_ASSET}: {e}"))?
        .text()
        .await
        .map_err(err)?;
    let expected = expected_sha256(&sums, BINARY_NAME).ok_or_else(|| {
        format!("{CHECKSUM_ASSET} for release {tag} has no entry for {BINARY_NAME}; refusing to install a binary that cannot be verified")
    })?;

    // 3. Download to a part file, so an interrupted install never leaves
    //    something runnable at the real path.
    let dir = tools_dir(&app);
    tokio::fs::create_dir_all(&dir).await.map_err(err)?;
    let part = dir.join(format!("{BINARY_NAME}.part"));
    let final_path = dir.join(BINARY_NAME);

    // Resume an interrupted install instead of restarting it.
    //
    // The binary is ~17 MB and the first attempt is often cut short by exactly
    // the sort of connection that makes yt-dlp worth having. Re-spending those
    // megabytes on a metered connection is not acceptable when the server will
    // happily send only the tail. Resuming cannot install a bad binary: the
    // SHA-256 below is computed over the whole assembled file, and a mismatch
    // already deletes the part file, so the next attempt starts clean.
    let mut resume_from = match tokio::fs::metadata(&part).await {
        Ok(m) if m.is_file() => m.len(),
        _ => 0,
    };

    let send = |from: u64| {
        let mut request = client.get(&binary_url);
        if from > 0 {
            // Spelled as a string so this module needs no direct reqwest
            // dependency; the client is built by the core crate.
            request = request.header("Range", format!("bytes={from}-"));
        }
        request.send()
    };

    let mut response = send(resume_from)
        .await
        .map_err(|e| format!("could not download {BINARY_NAME}: {e}"))?;

    // A part file that is already the full length (or longer, from a truncated
    // release) makes the server answer 416. That is not a failure, it just
    // means the leftover is useless: drop it and fetch the whole thing.
    if response.status().as_u16() == 416 {
        let _ = tokio::fs::remove_file(&part).await;
        resume_from = 0;
        response = send(0)
            .await
            .map_err(|e| format!("could not download {BINARY_NAME}: {e}"))?;
    }

    let mut response = response
        .error_for_status()
        .map_err(|e| format!("could not download {BINARY_NAME}: {e}"))?;

    // Only a real 206 proves the range was honoured. A 200 means the server
    // ignored it and is sending the file from the start, so the part file has
    // to be overwritten rather than appended to.
    let resumed = resume_from > 0 && response.status().as_u16() == 206;
    let already = if resumed { resume_from } else { 0 };
    // `content_length` is what is still coming, so the bar needs the head back.
    let total = response.content_length().map(|len| len + already);
    if resumed {
        tracing::info!(
            resumed_from = already,
            "resuming the yt-dlp download instead of restarting it"
        );
    }

    {
        use tokio::io::AsyncWriteExt;
        let mut file = if resumed {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(&part)
                .await
                .map_err(err)?
        } else {
            tokio::fs::File::create(&part).await.map_err(err)?
        };
        let mut downloaded: u64 = already;
        let mut last_tick = Instant::now();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("the download was interrupted: {e}"))?
        {
            file.write_all(&chunk).await.map_err(err)?;
            downloaded += chunk.len() as u64;
            // Throttled: a progress event per 8 KB chunk would flood the
            // webview with more messages than it can paint.
            if last_tick.elapsed() >= Duration::from_millis(150) {
                last_tick = Instant::now();
                emit(
                    &app,
                    InstallProgress {
                        phase: "downloading",
                        downloaded,
                        total,
                        message: format!("Downloading {BINARY_NAME} {tag}…"),
                    },
                );
            }
        }
        file.flush().await.map_err(err)?;
        file.sync_all().await.map_err(err)?;
    }

    // The release assets for macOS and Linux arrive without an exec bit.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&part).await.map_err(err)?.permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&part, perms)
            .await
            .map_err(err)?;
    }

    // 4. Verify before anything is allowed to occupy the real path.
    emit(
        &app,
        InstallProgress::step("verifying", "Verifying the SHA-256 checksum…"),
    );
    let actual = downpour_core::transfer::sha256_file(&part)
        .await
        .map_err(err)?;
    if !actual.eq_ignore_ascii_case(&expected) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "checksum mismatch: yt-dlp release {tag} publishes {expected} for {BINARY_NAME}, but the downloaded file hashes to {actual}. Nothing was installed."
        ));
    }

    // Windows will not rename over an existing file.
    let _ = tokio::fs::remove_file(&final_path).await;
    tokio::fs::rename(&part, &final_path).await.map_err(err)?;

    let version = run_tool(&final_path, &["--version"], VERSION_TIMEOUT)
        .await
        .map_err(|e| {
            format!(
                "yt-dlp was installed to {} but would not run: {e}",
                final_path.display()
            )
        })?;
    let version = version.trim().to_string();

    emit(
        &app,
        InstallProgress::step("done", format!("yt-dlp {version} is ready.")),
    );
    tracing::info!(version = %version, path = %final_path.display(), "installed yt-dlp");

    Ok(YtDlpStatus {
        installed: true,
        path: final_path,
        version: Some(version),
        error: None,
    })
}

/// Asks yt-dlp what a page offers, without downloading anything.
#[tauri::command]
pub async fn probe_media(app: AppHandle, url: String) -> CmdResult<MediaInfo> {
    let root = dump_json(&app, &url).await?;
    let entry = primary_entry(&root);
    let duration = entry.get("duration").and_then(Value::as_f64);

    let mut formats: Vec<MediaFormat> = raw_formats(entry)
        .into_iter()
        .filter_map(|f| normalise_format(f, duration))
        .collect();

    // Best first. Audio-only formats have no height and therefore sink to the
    // bottom, which is where someone looking for "the 1080p one" expects them.
    formats.sort_by(|a, b| {
        b.height
            .unwrap_or(0)
            .cmp(&a.height.unwrap_or(0))
            .then_with(|| {
                b.fps
                    .unwrap_or(0.0)
                    .partial_cmp(&a.fps.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| b.filesize.unwrap_or(0).cmp(&a.filesize.unwrap_or(0)))
    });

    if formats.is_empty() {
        return Err("yt-dlp read the page but reported no downloadable formats.".into());
    }

    Ok(MediaInfo {
        title: entry
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled")
            .to_string(),
        duration_secs: duration,
        thumbnail: string_field(entry, "thumbnail"),
        uploader: string_field(entry, "uploader")
            .or_else(|| string_field(entry, "channel"))
            .or_else(|| string_field(entry, "uploader_id")),
        webpage_url: string_field(entry, "webpage_url"),
        extractor: string_field(entry, "extractor_key")
            .or_else(|| string_field(entry, "extractor")),
        is_live: entry
            .get("is_live")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        formats,
    })
}

/// Resolves one chosen format to a direct URL plus its required headers.
///
/// This re-runs yt-dlp rather than reusing the probe's URLs on purpose: the
/// links most sites hand out are signed and expire within minutes, so a URL
/// captured while the user was still deciding on a quality is frequently dead
/// by the time they click Download.
#[tauri::command]
pub async fn resolve_media(
    app: AppHandle,
    url: String,
    format_id: String,
) -> CmdResult<ResolvedMedia> {
    let root = dump_json(&app, &url).await?;
    let entry = primary_entry(&root);
    let duration = entry.get("duration").and_then(Value::as_f64);

    let raw = raw_formats(entry)
        .into_iter()
        .find(|f| f.get("format_id").and_then(Value::as_str) == Some(format_id.as_str()))
        .ok_or_else(|| {
            format!(
                "this page no longer offers format {format_id}; re-check the link and pick again"
            )
        })?;

    let format = normalise_format(raw, duration)
        .ok_or_else(|| format!("format {format_id} has no usable media URL"))?;

    let media_url = raw
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("yt-dlp gave no URL for format {format_id}"))?
        .to_string();

    let title = entry
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("video");
    let filename = downpour_core::naming::sanitize(&format!("{title}.{}", format.ext))
        .unwrap_or_else(|| format!("{format_id}.{}", format.ext));

    Ok(ResolvedMedia {
        url: media_url,
        headers: required_headers(raw, entry),
        filename,
        filesize: format.filesize,
        format_id: format.format_id.clone(),
        ext: format.ext.clone(),
        progressive: format.progressive,
        direct_http: format.direct_http,
    })
}

// ---------------------------------------------------------------------------
// Running yt-dlp
// ---------------------------------------------------------------------------

/// Runs yt-dlp and returns its stdout, or a message the user can act on.
async fn run_tool(bin: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // On a timeout the future below is dropped, which drops the `Child`.
        // Without this the process would be orphaned and keep working.
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("yt-dlp is not installed at {}", bin.display())
        } else {
            format!("could not start yt-dlp: {e}")
        }
    })?;

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "yt-dlp did not answer within {}s and was stopped. The site may be blocking it, or the link may need a login.",
                timeout.as_secs()
            )
        })?
        .map_err(|e| format!("yt-dlp failed: {e}"))?;

    if !output.status.success() {
        // yt-dlp's stderr is genuinely readable ("Video unavailable", "Sign in
        // to confirm your age"), so it is shown verbatim rather than replaced
        // with a generic failure.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }
        return Err(match output.status.code() {
            Some(code) => format!("yt-dlp exited with status {code} and said nothing"),
            None => "yt-dlp was terminated before it finished".to_string(),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `yt-dlp -J` for one page.
async fn dump_json(app: &AppHandle, url: &str) -> Result<Value, String> {
    let trimmed = url.trim();
    // Also the reason no `--` separator is needed below: an argument starting
    // with `-` cannot get this far.
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Only http and https pages can be read.".into());
    }

    let bin = binary_path(app);
    if !bin.is_file() {
        return Err(format!("yt-dlp is not installed at {}", bin.display()));
    }

    let stdout = run_tool(
        &bin,
        &[
            // A user's global yt-dlp config can inject an output template, a
            // proxy or a format filter that changes the JSON shape or hangs
            // the process. This integration wants a predictable tool.
            "--ignore-config",
            "--no-warnings",
            "--no-playlist",
            "--no-progress",
            "-J",
            trimmed,
        ],
        PROBE_TIMEOUT,
    )
    .await?;

    serde_json::from_str(&stdout).map_err(|e| {
        format!("yt-dlp produced output Downpour could not read ({e}). It may need updating.")
    })
}

// ---------------------------------------------------------------------------
// JSON normalisation
// ---------------------------------------------------------------------------

/// `--no-playlist` usually collapses a playlist page to one video, but some
/// extractors still answer with a playlist wrapper. Take the first entry.
fn primary_entry(root: &Value) -> &Value {
    if root.get("_type").and_then(Value::as_str) == Some("playlist") {
        if let Some(first) = root
            .get("entries")
            .and_then(Value::as_array)
            .and_then(|e| e.first())
        {
            return first;
        }
    }
    root
}

/// The `formats` array, or the entry itself for extractors that return a
/// single direct URL with no format list at all.
fn raw_formats(entry: &Value) -> Vec<&Value> {
    match entry.get("formats").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => list.iter().collect(),
        _ => vec![entry],
    }
}

fn string_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A codec field, with yt-dlp's `"none"` sentinel mapped to absence.
fn codec_field(v: &Value, key: &str) -> Option<String> {
    string_field(v, key).filter(|s| s != "none")
}

fn normalise_format(f: &Value, duration: Option<f64>) -> Option<MediaFormat> {
    let format_id = string_field(f, "format_id").unwrap_or_else(|| "0".to_string());
    // No URL means nothing to hand to the engine, whatever else it claims.
    f.get("url").and_then(Value::as_str)?;

    let ext = string_field(f, "ext").unwrap_or_else(|| "bin".to_string());
    let vcodec = codec_field(f, "vcodec");
    let acodec = codec_field(f, "acodec");
    let has_video = vcodec.is_some();
    let has_audio = acodec.is_some();
    // Some extractors report neither codec. Treating that as "probably both"
    // matches reality — it is nearly always a plain progressive file.
    let unknown_codecs = !has_video && !has_audio;
    let progressive = (has_video && has_audio) || unknown_codecs;

    let protocol = string_field(f, "protocol");
    let direct_http = match protocol.as_deref() {
        Some(p) => p == "https" || p == "http",
        // No protocol field: fall back to the URL's own scheme.
        None => f
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|u| u.starts_with("http://") || u.starts_with("https://")),
    };

    let height = f
        .get("height")
        .and_then(Value::as_u64)
        .map(|h| h as u32)
        .filter(|h| *h > 0);
    let width = f.get("width").and_then(Value::as_u64).filter(|w| *w > 0);
    let fps = f.get("fps").and_then(Value::as_f64).filter(|v| *v > 0.0);
    let resolution = string_field(f, "resolution")
        .filter(|r| r != "audio only")
        .or_else(|| match (width, height) {
            (Some(w), Some(h)) => Some(format!("{w}x{h}")),
            _ => None,
        });

    let (filesize, filesize_is_estimate) = size_of(f, duration);

    // Quality half of the label.
    let quality = if has_video || unknown_codecs {
        match (height, fps) {
            // 50/60 fps is worth calling out: it is the difference people
            // actually notice between two "1080p" entries.
            (Some(h), Some(rate)) if rate >= 50.0 => format!("{h}p{}", rate.round()),
            (Some(h), _) => format!("{h}p"),
            _ => resolution.clone().unwrap_or_else(|| "video".to_string()),
        }
    } else {
        match f.get("abr").and_then(Value::as_f64) {
            Some(abr) if abr > 0.0 => format!("{} kbps", abr.round()),
            _ => "audio".to_string(),
        }
    };

    // Content half: the thing that decides whether the file will have sound.
    let kind = if progressive {
        "video + audio"
    } else if has_video {
        "video only"
    } else {
        "audio only"
    };

    Some(MediaFormat {
        label: format!("{quality} · {ext} · {kind}"),
        note: string_field(f, "format_note").filter(|n| n != &quality),
        format_id,
        ext,
        resolution,
        height,
        fps,
        filesize,
        filesize_is_estimate,
        vcodec,
        acodec,
        progressive,
        direct_http,
        protocol,
    })
}

/// Exact size, then yt-dlp's own approximation, then bitrate × duration.
///
/// A size of some sort matters more than precision here: "pick a quality" with
/// no numbers next to it is not a choice anyone can make.
fn size_of(f: &Value, duration: Option<f64>) -> (Option<u64>, bool) {
    if let Some(exact) = f.get("filesize").and_then(Value::as_u64).filter(|n| *n > 0) {
        return (Some(exact), false);
    }
    if let Some(approx) = f
        .get("filesize_approx")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
    {
        return (Some(approx), true);
    }
    // `tbr` is the total bitrate in kbit/s.
    match (f.get("tbr").and_then(Value::as_f64), duration) {
        (Some(tbr), Some(secs)) if tbr > 0.0 && secs > 0.0 => {
            (Some((tbr * 1000.0 / 8.0 * secs) as u64), true)
        }
        _ => (None, false),
    }
}

/// Headers Downpour must never forward to its own engine.
///
/// `Accept-Encoding` is the dangerous one. yt-dlp routinely reports
/// `gzip, deflate`, but `downpour-core`'s client is built with compression
/// switched off (`no_gzip`/`no_brotli`/`no_deflate`) because a transfer-encoded
/// body makes the byte arithmetic that ranged requests depend on ambiguous.
/// Forwarding it would ask for a compressed body that reqwest then would not
/// decompress: the engine would write gzipped bytes to disk and report
/// success. The rest are per-connection details the transport owns.
const BLOCKED_HEADERS: &[&str] = &[
    "accept-encoding",
    "accept-charset",
    "range",
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "te",
    "upgrade",
];

fn is_forwardable_header(name: &str) -> bool {
    !BLOCKED_HEADERS.contains(&name.to_ascii_lowercase().as_str())
}

/// The headers yt-dlp says this URL needs, format-level ones winning over the
/// page-level defaults.
fn required_headers(format: &Value, entry: &Value) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for source in [format.get("http_headers"), entry.get("http_headers")] {
        let Some(Value::Object(map)) = source else {
            continue;
        };
        for (name, value) in map {
            let Some(value) = value.as_str() else {
                continue;
            };
            if value.is_empty() || !is_forwardable_header(name) {
                continue;
            }
            out.entry(name.clone()).or_insert_with(|| value.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/// Pulls one asset's hash out of a `sha256sum`-style manifest.
///
/// Returns `None` when the asset is not listed, which callers must treat as a
/// failure: an unlisted asset is an unverifiable asset.
fn expected_sha256(manifest: &str, asset: &str) -> Option<String> {
    manifest.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        // Binary-mode entries are written `<hash>  *<name>`.
        let name = parts.next()?.trim_start_matches('*');
        let looks_like_hash = hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit());
        (looks_like_hash && name.eq_ignore_ascii_case(asset)).then(|| hash.to_ascii_lowercase())
    })
}

fn emit(app: &AppHandle, progress: InstallProgress) {
    if let Err(e) = app.emit(MEDIA_EVENT_CHANNEL, &progress) {
        tracing::debug!(error = %e, "could not forward install progress");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_checksum_line() {
        let manifest = "\
aaaa  yt-dlp
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  yt-dlp.exe
ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  yt-dlp_linux";
        assert_eq!(
            expected_sha256(manifest, "yt-dlp.exe").as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
    }

    #[test]
    fn missing_asset_is_not_a_silent_skip() {
        let manifest =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  yt-dlp_linux";
        assert!(expected_sha256(manifest, "yt-dlp.exe").is_none());
    }

    #[test]
    fn accept_encoding_never_reaches_the_engine() {
        assert!(!is_forwardable_header("Accept-Encoding"));
        assert!(!is_forwardable_header("accept-encoding"));
        assert!(is_forwardable_header("Referer"));
        assert!(is_forwardable_header("User-Agent"));
    }

    #[test]
    fn format_headers_win_over_page_headers() {
        let format = serde_json::json!({
            "http_headers": { "Referer": "https://example.com/watch", "Accept-Encoding": "gzip" }
        });
        let entry = serde_json::json!({
            "http_headers": { "Referer": "https://example.com/", "User-Agent": "Mozilla/5.0" }
        });
        let headers = required_headers(&format, &entry);
        assert_eq!(
            headers.get("Referer").map(String::as_str),
            Some("https://example.com/watch")
        );
        assert_eq!(
            headers.get("User-Agent").map(String::as_str),
            Some("Mozilla/5.0")
        );
        assert!(!headers.contains_key("Accept-Encoding"));
    }

    #[test]
    fn a_stream_with_both_codecs_is_progressive() {
        let f = serde_json::json!({
            "format_id": "22", "ext": "mp4", "url": "https://cdn.example/v.mp4",
            "vcodec": "avc1.64001F", "acodec": "mp4a.40.2",
            "height": 720, "fps": 30, "filesize": 12_345_678u64, "protocol": "https"
        });
        let out = normalise_format(&f, Some(60.0)).expect("format");
        assert!(out.progressive);
        assert!(out.direct_http);
        assert_eq!(out.filesize, Some(12_345_678));
        assert!(!out.filesize_is_estimate);
        assert!(out.label.starts_with("720p · mp4 · video + audio"));
    }

    #[test]
    fn a_video_only_dash_stream_is_flagged() {
        let f = serde_json::json!({
            "format_id": "137", "ext": "mp4", "url": "https://cdn.example/v.mp4",
            "vcodec": "avc1.640028", "acodec": "none",
            "height": 1080, "fps": 60, "tbr": 4000.0, "protocol": "https"
        });
        let out = normalise_format(&f, Some(100.0)).expect("format");
        assert!(!out.progressive);
        assert!(out.label.contains("1080p60"));
        assert!(out.label.ends_with("video only"));
        // 4000 kbit/s over 100s, estimated rather than reported.
        assert_eq!(out.filesize, Some(50_000_000));
        assert!(out.filesize_is_estimate);
    }

    #[test]
    fn an_hls_playlist_is_not_direct_http() {
        let f = serde_json::json!({
            "format_id": "hls-720", "ext": "mp4", "url": "https://cdn.example/master.m3u8",
            "vcodec": "avc1", "acodec": "mp4a", "height": 720, "protocol": "m3u8_native"
        });
        let out = normalise_format(&f, None).expect("format");
        assert!(out.progressive);
        assert!(!out.direct_http);
    }

    #[test]
    fn a_playlist_wrapper_collapses_to_its_first_entry() {
        let root = serde_json::json!({
            "_type": "playlist",
            "entries": [{ "title": "First" }, { "title": "Second" }]
        });
        assert_eq!(
            primary_entry(&root).get("title").and_then(Value::as_str),
            Some("First")
        );
    }
}
