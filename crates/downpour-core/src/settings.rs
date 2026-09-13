//! User-facing configuration.
//!
//! Every field has a defensible default, because the app must be useful the
//! second it opens without anyone visiting a settings screen.

use crate::scheduler::Schedule;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Default User-Agent. Presenting as a mainstream browser matters in practice:
/// a meaningful number of hosts serve a different (or no) file to clients they
/// do not recognise, and a downloader that silently 403s looks broken.
pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
     Chrome/140.0.0.0 Safari/537.36";

/// A folder rule: files whose extension matches land in this subfolder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub name: String,
    /// Lowercase, without the leading dot.
    pub extensions: Vec<String>,
    /// Subfolder under the download directory. Empty means the root.
    pub folder: String,
    /// Shown in the sidebar; a Lucide icon name.
    pub icon: String,
}

impl Category {
    fn new(name: &str, icon: &str, folder: &str, exts: &[&str]) -> Self {
        Self {
            name: name.to_string(),
            icon: icon.to_string(),
            folder: folder.to_string(),
            extensions: exts.iter().map(|s| s.to_string()).collect(),
        }
    }
}

pub fn default_categories() -> Vec<Category> {
    vec![
        Category::new(
            "Video",
            "clapperboard",
            "Video",
            &[
                "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts",
                "m2ts", "vob", "ogv", "3gp", "rmvb", "divx", "mts",
            ],
        ),
        Category::new(
            "Music",
            "music",
            "Music",
            &[
                "mp3", "flac", "wav", "aac", "ogg", "opus", "m4a", "wma", "alac", "aiff", "ape",
                "mid", "midi", "amr", "dsf",
            ],
        ),
        Category::new(
            "Pictures",
            "image",
            "Pictures",
            &[
                "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tiff", "tif", "heic", "avif",
                "raw", "cr2", "nef", "arw", "psd", "ai", "eps",
            ],
        ),
        Category::new(
            "Documents",
            "file-text",
            "Documents",
            &[
                "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
                "mobi", "azw3", "djvu", "txt", "rtf", "csv", "tex", "md",
            ],
        ),
        Category::new(
            "Compressed",
            "archive",
            "Compressed",
            &[
                "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso", "cab", "tgz", "lz",
                "lzma", "arj", "z", "dmg", "img", "wim",
            ],
        ),
        Category::new(
            "Programs",
            "app-window",
            "Programs",
            &[
                "exe",
                "msi",
                "msix",
                "appx",
                "appxbundle",
                "bat",
                "cmd",
                "ps1",
                "pkg",
                "deb",
                "rpm",
                "apk",
                "appimage",
                "jar",
                "run",
            ],
        ),
    ]
}

/// What to do when a file with the same name already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    /// `file (1).zip`. The least destructive option, so it is the default.
    #[default]
    Rename,
    Overwrite,
    /// Skip the download entirely and mark it complete.
    Skip,
}

/// What to do when the queue drains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OnQueueComplete {
    #[default]
    Nothing,
    Sleep,
    Hibernate,
    Shutdown,
    /// Just close Downpour, which is the safe version of "shut down when done".
    Exit,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub download_dir: PathBuf,

    // --- Throughput -------------------------------------------------------
    /// How many files transfer at once. This is the "I do not want four files
    /// downloading at the same time" control.
    pub max_concurrent_downloads: u8,
    /// Ceiling on parallel connections within one file.
    pub max_connections_per_download: u8,
    /// Global cap in bytes per second. `0` means unlimited.
    pub speed_limit_bps: u64,
    /// A second, lower cap applied only inside scheduler windows, so overnight
    /// downloads can be told to leave headroom.
    pub scheduled_speed_limit_bps: u64,
    pub max_retries: u32,
    pub request_timeout_secs: u64,

    // --- Organisation -----------------------------------------------------
    pub sort_into_categories: bool,
    pub categories: Vec<Category>,
    pub conflict_policy: ConflictPolicy,

    // --- Scheduling -------------------------------------------------------
    pub schedule: Schedule,
    /// New downloads arrive scheduler-gated rather than starting immediately.
    pub schedule_new_downloads: bool,
    /// Pause running downloads when a window closes, instead of letting them
    /// run past it. On by default: a window the app ignores is not a window.
    pub pause_outside_window: bool,
    pub on_queue_complete: OnQueueComplete,

    // --- Capture ----------------------------------------------------------
    pub clipboard_watch: bool,
    /// Only offer to capture clipboard URLs whose extension is in this list.
    /// Empty means offer for every URL.
    pub clipboard_extensions: Vec<String>,
    /// Add captured links straight to the queue instead of showing a prompt.
    pub clipboard_auto_add: bool,
    /// Loopback port the browser extension talks to.
    pub rpc_port: u16,
    /// Shared secret the extension must present. Regenerated on demand.
    pub rpc_token: String,
    pub rpc_enabled: bool,

    // --- Application ------------------------------------------------------
    pub user_agent: String,
    pub theme: String,
    pub accent: String,
    /// The colour theme laid over `theme`. Orthogonal to light/dark/auto: a
    /// palette supplies both modes, so someone on "auto" keeps their theme when
    /// the system flips at dusk. Lives here rather than in browser storage
    /// because the compact progress panel is a second webview reading the same
    /// settings, and it must not sit there in a different palette.
    pub palette: String,
    pub start_minimized: bool,
    pub launch_at_login: bool,
    pub close_to_tray: bool,
    pub notify_on_complete: bool,
    pub notify_on_error: bool,
    /// Pop the compact always-on-top progress panel when a transfer starts.
    pub progress_window: bool,
    /// Play the completion sound. Off by default; unsolicited noise is rude.
    pub sound_on_complete: bool,
}

/// Hand-written so the pairing token can never be logged.
///
/// `Settings` is exactly the sort of struct someone reaches for when adding a
/// diagnostic `tracing::debug!(?settings)`, and the log file is exactly the
/// sort of thing a user attaches to a bug report. A derived `Debug` would put
/// the token in both. The rest of the struct prints normally, because the whole
/// point of logging it is to see the configuration that produced a bug.
impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("download_dir", &self.download_dir)
            .field("max_concurrent_downloads", &self.max_concurrent_downloads)
            .field(
                "max_connections_per_download",
                &self.max_connections_per_download,
            )
            .field("speed_limit_bps", &self.speed_limit_bps)
            .field("scheduled_speed_limit_bps", &self.scheduled_speed_limit_bps)
            .field("max_retries", &self.max_retries)
            .field("request_timeout_secs", &self.request_timeout_secs)
            .field("sort_into_categories", &self.sort_into_categories)
            .field("categories", &self.categories.len())
            .field("conflict_policy", &self.conflict_policy)
            .field("schedule", &self.schedule)
            .field("schedule_new_downloads", &self.schedule_new_downloads)
            .field("pause_outside_window", &self.pause_outside_window)
            .field("on_queue_complete", &self.on_queue_complete)
            .field("clipboard_watch", &self.clipboard_watch)
            .field("clipboard_auto_add", &self.clipboard_auto_add)
            .field("rpc_port", &self.rpc_port)
            .field("rpc_enabled", &self.rpc_enabled)
            .field("rpc_token", &"<redacted>")
            .field("user_agent", &self.user_agent)
            .field("theme", &self.theme)
            .field("palette", &self.palette)
            .field("accent", &self.accent)
            .field("start_minimized", &self.start_minimized)
            .field("launch_at_login", &self.launch_at_login)
            .field("close_to_tray", &self.close_to_tray)
            .field("notify_on_complete", &self.notify_on_complete)
            .field("notify_on_error", &self.notify_on_error)
            .field("progress_window", &self.progress_window)
            .field("sound_on_complete", &self.sound_on_complete)
            .finish()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: default_download_dir(),
            max_concurrent_downloads: 3,
            max_connections_per_download: 8,
            speed_limit_bps: 0,
            scheduled_speed_limit_bps: 0,
            max_retries: 8,
            request_timeout_secs: 60,
            sort_into_categories: true,
            categories: default_categories(),
            conflict_policy: ConflictPolicy::default(),
            schedule: Schedule::default(),
            schedule_new_downloads: false,
            pause_outside_window: true,
            on_queue_complete: OnQueueComplete::default(),
            clipboard_watch: false,
            clipboard_extensions: Vec::new(),
            clipboard_auto_add: false,
            rpc_port: 47_113,
            rpc_token: generate_token(),
            rpc_enabled: true,
            user_agent: DEFAULT_USER_AGENT.to_string(),
            theme: "system".to_string(),
            palette: "downpour".to_string(),
            accent: "aurora".to_string(),
            start_minimized: false,
            launch_at_login: false,
            close_to_tray: true,
            notify_on_complete: true,
            notify_on_error: true,
            progress_window: true,
            sound_on_complete: false,
        }
    }
}

impl Settings {
    /// Clamps user input to values the engine can actually honour. Called on
    /// every save, so a hand-edited config file cannot wedge the app.
    pub fn normalise(&mut self) {
        self.max_concurrent_downloads = self.max_concurrent_downloads.clamp(1, 32);
        self.max_connections_per_download = self
            .max_connections_per_download
            .clamp(1, crate::transfer::MAX_CONNECTIONS);
        self.max_retries = self.max_retries.min(100);
        self.request_timeout_secs = self.request_timeout_secs.clamp(5, 3600);
        if self.user_agent.trim().is_empty() {
            self.user_agent = DEFAULT_USER_AGENT.to_string();
        }
        if self.rpc_token.trim().is_empty() {
            self.rpc_token = generate_token();
        }
        // Port 0 would bind to a random port the extension could never find.
        if self.rpc_port < 1024 {
            self.rpc_port = 47_113;
        }
        for c in &mut self.categories {
            for e in &mut c.extensions {
                *e = e.trim().trim_start_matches('.').to_ascii_lowercase();
            }
            c.extensions.retain(|e| !e.is_empty());
        }
    }

    /// The subfolder a file with this name belongs in, honouring
    /// `sort_into_categories`.
    pub fn category_for(&self, filename: &str) -> Option<&Category> {
        if !self.sort_into_categories {
            return None;
        }
        let ext = filename.rsplit_once('.')?.1.to_ascii_lowercase();
        self.categories.iter().find(|c| c.extensions.contains(&ext))
    }

    /// Full destination directory for a given filename.
    pub fn dest_dir_for(&self, filename: &str) -> PathBuf {
        match self.category_for(filename) {
            Some(c) if !c.folder.is_empty() => self.download_dir.join(&c.folder),
            _ => self.download_dir.clone(),
        }
    }

    /// The speed limit that applies right now.
    pub fn effective_speed_limit(&self, inside_window: bool) -> u64 {
        if inside_window && self.scheduled_speed_limit_bps > 0 {
            self.scheduled_speed_limit_bps
        } else {
            self.speed_limit_bps
        }
    }

    /// Whether a clipboard URL is interesting enough to offer.
    pub fn clipboard_matches(&self, url: &str) -> bool {
        if self.clipboard_extensions.is_empty() {
            return true;
        }
        let path = url.split(['?', '#']).next().unwrap_or(url);
        let ext = match path.rsplit_once('.') {
            Some((_, e)) => e.to_ascii_lowercase(),
            None => return false,
        };
        self.clipboard_extensions
            .iter()
            .any(|e| e.trim().trim_start_matches('.').eq_ignore_ascii_case(&ext))
    }
}

impl Settings {
    /// Every distinct subfolder the categories route into.
    ///
    /// Deduplicated and ordered, because two categories are allowed to share a
    /// folder and we should not try to create it twice.
    pub fn category_folders(&self) -> Vec<PathBuf> {
        let mut seen = std::collections::BTreeSet::new();
        self.categories
            .iter()
            .filter(|c| !c.folder.trim().is_empty())
            .filter(|c| seen.insert(c.folder.clone()))
            .map(|c| self.download_dir.join(&c.folder))
            .collect()
    }
}

/// The user's Downloads folder, used directly.
///
/// Not a `Downpour` subfolder inside it. An app that invents its own parent
/// directory makes people hunt for their files in a place they did not choose,
/// and "where did it go?" is the last question a download manager should
/// provoke. The category folders sit directly in Downloads, so a video lands in
/// `Downloads\Video` — one level, exactly where you would look.
pub fn default_download_dir() -> PathBuf {
    dirs_download().unwrap_or_else(|| PathBuf::from("."))
}

/// The old default, kept only so a existing install can be migrated off it.
pub fn legacy_download_dir() -> PathBuf {
    default_download_dir().join("Downpour")
}

fn dirs_download() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let p = PathBuf::from(profile).join("Downloads");
            if p.exists() {
                return Some(p);
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            let p = PathBuf::from(home).join("Downloads");
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// 64 hex characters of entropy for the loopback RPC token.
///
/// This is what stops any web page on the machine from POSTing downloads into
/// the app, so it is generated from a real UUID rather than anything guessable.
pub fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[cfg(test)]
// Varying one field off a default is the clearest way to express these
// cases; struct-update syntax would bury the field under test.
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    #[test]
    fn the_download_folder_is_downloads_itself() {
        // Not Downloads\Downpour. The category folders provide the structure;
        // an extra parent directory only hides files from the person who
        // asked for them.
        let s = Settings::default();
        assert!(
            !s.download_dir.ends_with("Downpour"),
            "got {:?}",
            s.download_dir
        );
        assert_eq!(
            legacy_download_dir(),
            default_download_dir().join("Downpour")
        );
    }

    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert_eq!(s.max_concurrent_downloads, 3);
        assert!(!s.schedule.enabled, "scheduler must be off until asked for");
        assert!(!s.clipboard_watch, "clipboard watching must be opt-in");
        assert_eq!(s.speed_limit_bps, 0);
        assert_eq!(s.rpc_token.len(), 64);
    }

    #[test]
    fn normalise_clamps_out_of_range_values() {
        let mut s = Settings::default();
        s.max_concurrent_downloads = 0;
        s.max_connections_per_download = 200;
        s.request_timeout_secs = 1;
        s.rpc_port = 80;
        s.user_agent = "  ".into();
        s.normalise();
        assert_eq!(s.max_concurrent_downloads, 1);
        assert_eq!(s.max_connections_per_download, 16);
        assert_eq!(s.request_timeout_secs, 5);
        assert_eq!(s.rpc_port, 47_113);
        assert_eq!(s.user_agent, DEFAULT_USER_AGENT);
    }

    #[test]
    fn normalise_cleans_category_extensions() {
        let mut s = Settings::default();
        s.categories = vec![Category::new("X", "x", "X", &[".MP4", " mkv ", ""])];
        s.normalise();
        assert_eq!(s.categories[0].extensions, vec!["mp4", "mkv"]);
    }

    #[test]
    fn category_lookup_respects_the_master_switch() {
        let mut s = Settings::default();
        assert_eq!(s.category_for("movie.mp4").unwrap().name, "Video");
        assert_eq!(s.category_for("song.FLAC").unwrap().name, "Music");
        assert_eq!(s.category_for("photo.HEIC").unwrap().name, "Pictures");
        assert_eq!(s.category_for("book.epub").unwrap().name, "Documents");
        assert_eq!(s.category_for("pack.7z").unwrap().name, "Compressed");
        assert_eq!(s.category_for("setup.msi").unwrap().name, "Programs");
        assert!(s.category_for("thing.qqq").is_none());
        assert!(s.category_for("noextension").is_none());

        s.sort_into_categories = false;
        assert!(s.category_for("movie.mp4").is_none());
    }

    #[test]
    fn no_extension_belongs_to_two_categories() {
        // A file landing in the wrong folder is confusing; a file that could
        // land in either is a bug in the table, so assert the table is a
        // partition rather than an overlapping set.
        let s = Settings::default();
        let mut seen = std::collections::HashMap::new();
        for c in &s.categories {
            for e in &c.extensions {
                if let Some(other) = seen.insert(e.clone(), c.name.clone()) {
                    panic!("`{e}` is in both {other} and {}", c.name);
                }
            }
        }
    }

    #[test]
    fn category_folders_are_the_ones_first_run_creates() {
        let s = Settings::default();
        let folders: Vec<&str> = s.categories.iter().map(|c| c.folder.as_str()).collect();
        assert_eq!(
            folders,
            vec![
                "Video",
                "Music",
                "Pictures",
                "Documents",
                "Compressed",
                "Programs"
            ]
        );
    }

    #[test]
    fn dest_dir_appends_the_category_folder() {
        let mut s = Settings::default();
        s.download_dir = PathBuf::from("D:/dl");
        assert_eq!(s.dest_dir_for("a.mp4"), PathBuf::from("D:/dl/Video"));
        assert_eq!(s.dest_dir_for("a.qqq"), PathBuf::from("D:/dl"));
        s.sort_into_categories = false;
        assert_eq!(s.dest_dir_for("a.mp4"), PathBuf::from("D:/dl"));
    }

    #[test]
    fn scheduled_speed_limit_only_applies_inside_a_window() {
        let mut s = Settings::default();
        s.speed_limit_bps = 5_000_000;
        s.scheduled_speed_limit_bps = 1_000_000;
        assert_eq!(s.effective_speed_limit(false), 5_000_000);
        assert_eq!(s.effective_speed_limit(true), 1_000_000);
        s.scheduled_speed_limit_bps = 0;
        assert_eq!(
            s.effective_speed_limit(true),
            5_000_000,
            "0 means unset, not zero speed"
        );
    }

    #[test]
    fn clipboard_filter_matches_extensions_ignoring_query_strings() {
        let mut s = Settings::default();
        assert!(
            s.clipboard_matches("https://x.com/anything"),
            "empty list matches all"
        );
        s.clipboard_extensions = vec!["zip".into(), ".ISO".into()];
        assert!(s.clipboard_matches("https://x.com/a.zip"));
        assert!(s.clipboard_matches("https://x.com/a.iso?token=1"));
        assert!(!s.clipboard_matches("https://x.com/a.txt"));
        assert!(!s.clipboard_matches("https://x.com/page"));
    }

    #[test]
    fn settings_round_trip_through_json() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.max_concurrent_downloads, s.max_concurrent_downloads);
        assert_eq!(back.categories, s.categories);
    }

    #[test]
    fn partial_json_fills_in_defaults() {
        // A config file written by an older version must still load.
        let s: Settings = serde_json::from_str(r#"{"maxConcurrentDownloads": 7}"#).unwrap();
        assert_eq!(s.max_concurrent_downloads, 7);
        assert_eq!(s.max_connections_per_download, 8, "missing field defaulted");
        assert!(!s.categories.is_empty());
    }

    #[test]
    fn debug_output_never_contains_the_pairing_token() {
        // The log file is the thing users attach to bug reports, so a derived
        // Debug here would hand out the credential that lets anything on the
        // machine queue downloads.
        let s = Settings::default();
        let printed = format!("{s:?}");
        assert!(
            !printed.contains(&s.rpc_token),
            "the token leaked into Debug output"
        );
        assert!(printed.contains("<redacted>"));
        // The rest must still be there, or logging it is pointless.
        assert!(printed.contains("max_concurrent_downloads"));
        assert!(printed.contains("download_dir"));
    }

    #[test]
    fn tokens_are_unique() {
        assert_ne!(generate_token(), generate_token());
    }
}
