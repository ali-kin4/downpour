//! Public data model shared by the engine, the CLI, the Tauri layer and the UI.
//!
//! Every type here is `serde`-serialisable and is the exact shape the frontend
//! receives over IPC, so changing one is a breaking API change for the UI.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Stable identifier for a download. UUID v4 rendered as a plain string, so the
/// frontend never has to care about the representation.
pub type DownloadId = String;

/// Where a download sits in its lifecycle.
///
/// `Queued` and `Scheduled` are deliberately distinct: `Queued` means "ready to
/// run, waiting for a concurrency slot", `Scheduled` means "held until a time
/// window opens". Collapsing them would make the scheduler indistinguishable
/// from a busy queue in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    /// Added but intentionally not started (batch import, "add without starting").
    Idle,
    /// Wants to run; waiting for a free slot under the concurrency cap.
    Queued,
    /// Held until its scheduler window opens.
    Scheduled,
    /// Fetching headers, determining size and range support.
    Probing,
    /// Actively transferring.
    Running,
    /// Stopped by the user; resumable from the sidecar.
    Paused,
    /// Finished and verified.
    Completed,
    /// Stopped by an error the engine will not retry.
    Failed,
    /// Removed from the active set by the user.
    Cancelled,
}

impl DownloadStatus {
    /// Terminal states never transition on their own.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// States that occupy a concurrency slot.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Probing | Self::Running)
    }

    /// States the user can resume from.
    pub fn is_resumable(self) -> bool {
        matches!(self, Self::Paused | Self::Failed | Self::Idle)
    }
}

/// What should happen the moment a download is added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum StartMode {
    /// Enter the queue immediately, subject to the concurrency cap.
    #[default]
    Start,
    /// Sit in `Idle` until the user explicitly starts it. This is what "add my
    /// 20 clipboard links but do not download yet" produces.
    AddOnly,
    /// Sit in `Scheduled` until the active scheduler window opens.
    Schedule,
}

/// Everything needed to begin a download. Built by the UI, the CLI, the
/// clipboard watcher or the browser extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadSpec {
    pub url: String,
    /// Per-download request headers. This carries `Cookie`, `Referer` and
    /// `User-Agent` captured by the browser extension, which is the only way
    /// session-gated files download correctly. Present from schema v1 on purpose.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Explicit filename. When `None` the engine derives one from
    /// `Content-Disposition`, then the URL path, then a fallback.
    #[serde(default)]
    pub filename: Option<String>,
    pub dest_dir: PathBuf,
    /// Desired parallel connections. `None` uses the global default.
    #[serde(default)]
    pub connections: Option<u8>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub start_mode: StartMode,
    /// Optional expected checksum, formatted `sha256:<hex>`.
    #[serde(default)]
    pub checksum: Option<String>,
    /// Free-form origin tag for the UI: clipboard, extension, batch, cli.
    #[serde(default)]
    pub source: Option<String>,
}

/// One byte range of the target file, and how far into it we have written.
///
/// `end` is **inclusive**, matching HTTP `Range` semantics, so a finished
/// segment is represented by `cursor > end` rather than by a zero length.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub cursor: u64,
}

impl Segment {
    pub fn new(start: u64, end: u64) -> Self {
        Self { start, end, cursor: start }
    }
    /// Bytes still to fetch. Saturating, so a finished segment reports 0.
    pub fn remaining(&self) -> u64 {
        (self.end + 1).saturating_sub(self.cursor)
    }
    pub fn is_complete(&self) -> bool {
        self.cursor > self.end
    }
    pub fn downloaded(&self) -> u64 {
        self.cursor.saturating_sub(self.start)
    }
}

/// What the server told us about the resource during the probe.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RemoteInfo {
    /// URL after redirects; all subsequent range requests use this.
    pub final_url: String,
    pub size: Option<u64>,
    pub supports_range: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub suggested_filename: Option<String>,
}

impl RemoteInfo {
    /// Whether this resource still looks like the one we started downloading.
    ///
    /// A strong `ETag` is authoritative. Failing that we compare
    /// `Last-Modified`, then size. When the server gives us nothing to compare
    /// we accept the resume, because refusing every resume against a
    /// header-less server would make resume useless on exactly the servers that
    /// need it most.
    pub fn matches(&self, prior: &RemoteInfo) -> std::result::Result<(), String> {
        if let (Some(a), Some(b)) = (&self.etag, &prior.etag) {
            // Weak validators (`W/"..."`) only promise semantic equivalence,
            // not byte equality, so they cannot authorise stitching.
            let weak = a.starts_with("W/") || b.starts_with("W/");
            if !weak {
                return if a == b {
                    Ok(())
                } else {
                    Err(format!("ETag changed ({b} -> {a})"))
                };
            }
        }
        if let (Some(a), Some(b)) = (&self.last_modified, &prior.last_modified) {
            if a != b {
                return Err(format!("Last-Modified changed ({b} -> {a})"));
            }
        }
        if let (Some(a), Some(b)) = (self.size, prior.size) {
            if a != b {
                return Err(format!("size changed ({b} -> {a} bytes)"));
            }
        }
        Ok(())
    }
}

/// A download as the UI sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadItem {
    pub id: DownloadId,
    pub url: String,
    pub final_url: Option<String>,
    pub filename: String,
    /// The user picked this name explicitly, so `Content-Disposition` must not
    /// override it.
    pub user_named: bool,
    /// The on-disk name has been claimed by creating its part file. Once set,
    /// the name is reused verbatim; re-deriving it on a resume would pick a
    /// fresh `(1)` suffix every attempt and restart the download each time.
    pub name_locked: bool,
    pub dest_dir: PathBuf,
    pub headers: BTreeMap<String, String>,
    pub status: DownloadStatus,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    /// Bytes per second, exponentially smoothed. Zero unless running.
    pub speed_bps: u64,
    /// Seconds remaining; `None` when size or speed is unknown.
    pub eta_secs: Option<u64>,
    pub connections: u8,
    pub supports_range: bool,
    pub category: Option<String>,
    pub source: Option<String>,
    /// Whether this item is gated by the scheduler. Per-item rather than
    /// global so a user with a 2am window can still force one file through at
    /// 3pm without disarming the schedule.
    pub scheduled: bool,
    pub error: Option<String>,
    pub checksum: Option<String>,
    /// Unix seconds. Display only -- whole-second resolution cannot order a
    /// batch of links added in the same instant, which is what `sequence` is for.
    pub created_at: i64,
    /// Monotonic insertion counter. This is the queue order, so a batch of
    /// pasted links downloads in the order they were pasted rather than in
    /// whatever order their UUIDs happen to sort.
    pub sequence: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    /// Sum of active seconds, so the UI can show an honest average speed.
    pub elapsed_secs: u64,
}

impl DownloadItem {
    pub fn progress(&self) -> f64 {
        match self.total_bytes {
            Some(t) if t > 0 => (self.downloaded_bytes as f64 / t as f64).clamp(0.0, 1.0),
            _ => 0.0,
        }
    }
    /// Full path of the finished file.
    pub fn target_path(&self) -> PathBuf {
        self.dest_dir.join(&self.filename)
    }
    /// Path of the in-progress file.
    pub fn part_path(&self) -> PathBuf {
        self.dest_dir.join(format!("{}.dpart", self.filename))
    }
    /// Path of the resume sidecar.
    pub fn meta_path(&self) -> PathBuf {
        self.dest_dir.join(format!("{}.dpmeta", self.filename))
    }
}

/// Events broadcast by the engine. The Tauri layer forwards these to the UI and
/// the CLI renders them as log lines.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineEvent {
    Added { item: Box<DownloadItem> },
    StatusChanged { id: DownloadId, status: DownloadStatus, error: Option<String> },
    Progress {
        id: DownloadId,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        speed_bps: u64,
        eta_secs: Option<u64>,
        connections: u8,
    },
    Completed { id: DownloadId, path: PathBuf },
    Failed { id: DownloadId, error: String },
    Removed { id: DownloadId },
    /// Emitted when the scheduler opens or closes a window, so the UI can show
    /// "downloading until 07:00" instead of leaving the user guessing.
    SchedulerWindow { open: bool, label: Option<String> },
}
