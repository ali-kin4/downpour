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
        Category::new("Video", "clapperboard", "Video", &[
            "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts",
        ]),
        Category::new("Audio", "music", "Audio", &[
            "mp3", "flac", "wav", "aac", "ogg", "opus", "m4a", "wma", "alac", "aiff",
        ]),
        Category::new("Documents", "file-text", "Documents", &[
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "epub", "mobi",
            "txt", "rtf", "csv",
        ]),
        Category::new("Archives", "archive", "Archives", &[
            "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso", "cab",
        ]),
        Category::new("Programs", "app-window", "Programs", &[
            "exe", "msi", "msix", "appx", "dmg", "pkg", "deb", "rpm", "apk", "appimage",
        ]),
        Category::new("Images", "image", "Images", &[
            "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tiff", "heic", "avif", "raw",
        ]),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
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
    pub start_minimized: bool,
    pub launch_at_login: bool,
    pub close_to_tray: bool,
    pub notify_on_complete: bool,
    pub notify_on_error: bool,
    /// Play the completion sound. Off by default; unsolicited noise is rude.
    pub sound_on_complete: bool,
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
            sort_into_categories: false,
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
            accent: "aurora".to_string(),
            start_minimized: false,
            launch_at_login: false,
            close_to_tray: true,
            notify_on_complete: true,
            notify_on_error: true,
            sound_on_complete: false,
        }
    }
}

impl Settings {
    /// Clamps user input to values the engine can actually honour. Called on
    /// every save, so a hand-edited config file cannot wedge the app.
    pub fn normalise(&mut self) {
        self.max_concurrent_downloads = self.max_concurrent_downloads.clamp(1, 32);
        self.max_connections_per_download = self.max_connections_per_download.clamp(1, 32);
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
        self.categories
            .iter()
            .find(|c| c.extensions.iter().any(|e| *e == ext))
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

/// Best guess at the user's Downloads folder, with a subfolder so Downpour
/// never mixes its files in with the browser's.
pub fn default_download_dir() -> PathBuf {
    dirs_download()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Downpour")
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

/// 32 hex characters of entropy for the loopback RPC token.
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
mod tests {
    use super::*;

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
        assert_eq!(s.max_connections_per_download, 32);
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
    fn category_lookup_is_off_unless_enabled() {
        let mut s = Settings::default();
        assert!(s.category_for("movie.mp4").is_none());
        s.sort_into_categories = true;
        assert_eq!(s.category_for("movie.mp4").unwrap().name, "Video");
        assert_eq!(s.category_for("song.FLAC").unwrap().name, "Audio");
        assert!(s.category_for("thing.qqq").is_none());
        assert!(s.category_for("noextension").is_none());
    }

    #[test]
    fn dest_dir_appends_the_category_folder() {
        let mut s = Settings::default();
        s.download_dir = PathBuf::from("D:/dl");
        s.sort_into_categories = true;
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
        assert_eq!(s.effective_speed_limit(true), 5_000_000, "0 means unset, not zero speed");
    }

    #[test]
    fn clipboard_filter_matches_extensions_ignoring_query_strings() {
        let mut s = Settings::default();
        assert!(s.clipboard_matches("https://x.com/anything"), "empty list matches all");
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
        let s: Settings = serde_json::from_str(r#"{"max_concurrent_downloads": 7}"#).unwrap();
        assert_eq!(s.max_concurrent_downloads, 7);
        assert_eq!(s.max_connections_per_download, 8, "missing field defaulted");
        assert!(!s.categories.is_empty());
    }

    #[test]
    fn tokens_are_unique() {
        assert_ne!(generate_token(), generate_token());
    }
}
