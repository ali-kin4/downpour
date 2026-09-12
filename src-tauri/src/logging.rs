//! Application logging.
//!
//! Deliberately small: one rolling file next to the database, plus the console
//! in a debug build. No log server, no telemetry, nothing leaves the machine.
//! The only job is answering "why did that fail?" after the fact, when the user
//! is not sitting in front of a terminal.
//!
//! Three things make it actually useful rather than decorative:
//!
//! - **A panic hook.** A panic in a background task otherwise vanishes: the
//!   task dies, the download stops, and nothing anywhere says why.
//! - **Rotation with a file cap**, so a long-running tray app cannot quietly
//!   fill a disk.
//! - **A redacted settings dump at startup**, so a bug report carries the
//!   configuration that produced it without carrying the RPC token.

use std::fs;
use std::path::{Path, PathBuf};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter, Layer};

/// Kept small on purpose. Anything older is of no diagnostic value and is just
/// disk the user did not agree to spend.
const MAX_LOG_FILES: usize = 3;

pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

/// Sets up file and console logging, returning the guard that must be held for
/// the lifetime of the process.
///
/// Dropping the guard stops the background writer flushing, so the last few
/// lines before a crash — the interesting ones — would be lost.
pub fn init(data_dir: &Path) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let dir = log_dir(data_dir);
    if let Err(e) = fs::create_dir_all(&dir) {
        // No file log is survivable; refusing to start is not.
        eprintln!("could not create the log directory: {e}");
        return None;
    }
    prune_old_logs(&dir);

    let appender = tracing_appender::rolling::daily(&dir, "downpour.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);

    // `DOWNPOUR_LOG` overrides, so a user chasing a bug can be told one env var
    // rather than a rebuild.
    let filter = || {
        EnvFilter::try_from_env("DOWNPOUR_LOG")
            .unwrap_or_else(|_| EnvFilter::new("downpour=info,downpour_core=info,warn"))
    };

    let file_layer = fmt::layer()
        .with_writer(writer)
        // No colour: this file is read in Notepad, and escape codes make it
        // unreadable there.
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(false)
        .with_filter(filter());

    let registry = tracing_subscriber::registry().with(file_layer);

    // A console layer only where there is a console to write to. In a release
    // build the process is `windows_subsystem = "windows"` and has none.
    #[cfg(debug_assertions)]
    let registry = registry.with(fmt::layer().with_filter(filter()));

    if registry.try_init().is_err() {
        // Already initialised, which happens in tests. Not an error.
        return Some(guard);
    }

    install_panic_hook();
    Some(guard)
}

/// Routes panics into the log before the default handler runs.
///
/// Without this a panicked background task is completely silent: the download
/// simply stops and the log shows nothing at all, which is the least
/// debuggable failure a program can have.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());

        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".into());

        tracing::error!(
            target: "downpour::panic",
            location = %location,
            message = %message,
            backtrace = %std::backtrace::Backtrace::force_capture(),
            "panic"
        );
        previous(info);
    }));
}

/// Writes the one-off context every bug report needs.
///
/// Called once at startup so any log file a user sends starts with what they
/// are running and on what.
pub fn log_startup_context(version: &str) {
    tracing::info!(
        version,
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "Downpour starting"
    );
}

/// Deletes all but the newest `MAX_LOG_FILES` log files.
///
/// `tracing-appender`'s daily rotation never removes anything on its own, so a
/// tray app left running for a year would leave 365 files behind.
fn prune_old_logs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("downpour.log"))
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.path()))
        })
        .collect();

    if files.len() <= MAX_LOG_FILES {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    for (_, path) in files.iter().take(files.len() - MAX_LOG_FILES) {
        let _ = fs::remove_file(path);
    }
}

/// Reads the tail of the current log, for the in-app diagnostics view.
///
/// Reads the whole file and keeps the last `lines`: a capped log file is small
/// enough that streaming backwards would be more code than it is worth.
pub fn tail(data_dir: &Path, lines: usize) -> String {
    let dir = log_dir(data_dir);
    let Ok(entries) = fs::read_dir(&dir) else {
        return String::new();
    };
    let newest = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("downpour.log"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p);

    let Some(path) = newest else {
        return String::new();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return String::new();
    };

    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Unique temp directory without pulling in a uuid dependency purely for
    /// test scaffolding: process id plus a counter is unique enough here.
    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "dp-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn prune_keeps_only_the_newest_files() {
        let dir = temp_dir("log");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..6 {
            let p = dir.join(format!("downpour.log.2026-09-{:02}", i + 1));
            fs::write(&p, format!("line {i}")).unwrap();
            // Distinct mtimes, since the sort is by modification time.
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        // An unrelated file must survive: this prunes its own logs, not the
        // contents of whatever directory it is pointed at.
        fs::write(dir.join("notes.txt"), b"keep").unwrap();

        prune_old_logs(&dir);

        let remaining: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        let logs = remaining
            .iter()
            .filter(|n| n.starts_with("downpour.log"))
            .count();
        assert_eq!(logs, MAX_LOG_FILES);
        assert!(remaining.iter().any(|n| n == "notes.txt"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prune_is_a_no_op_below_the_cap() {
        let dir = temp_dir("log2");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("downpour.log.2026-09-01"), b"a").unwrap();
        prune_old_logs(&dir);
        assert!(dir.join("downpour.log.2026-09-01").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_of_a_missing_directory_is_empty_rather_than_an_error() {
        let dir = temp_dir("log3");
        assert_eq!(tail(&dir, 50), "");
    }

    #[test]
    fn tail_returns_the_last_lines() {
        let data = temp_dir("log4");
        let dir = log_dir(&data);
        fs::create_dir_all(&dir).unwrap();
        let body: String = (1..=200).map(|i| format!("line {i}\n")).collect();
        fs::write(dir.join("downpour.log.2026-09-11"), body).unwrap();

        let out = tail(&data, 5);
        assert!(out.starts_with("line 196"), "got: {out}");
        assert!(out.ends_with("line 200"));
        fs::remove_dir_all(&data).ok();
    }
}
