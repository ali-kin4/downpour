//! Error taxonomy for the engine.
//!
//! Errors are split by *who can act on them*: `Transient` errors are retried by
//! the worker loop, `Fatal` errors stop the download and surface to the user.

use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("io error: {0}")]
    PlainIo(#[from] std::io::Error),

    #[error("invalid url: {0}")]
    InvalidUrl(String),

    #[error("server returned status {status} for {url}")]
    BadStatus { status: u16, url: String },

    /// The server advertised `Accept-Ranges: bytes` but did not honour a real
    /// range request. Callers fall back to a single stream rather than writing
    /// a full body into a segment slot.
    #[error("server advertised range support but returned {status} for a ranged request")]
    RangeNotHonoured { status: u16 },

    /// The remote file changed between the original download and the resume
    /// attempt. Stitching old and new bytes would silently corrupt the file.
    #[error("remote file changed since download started ({reason}); restarting")]
    RemoteChanged { reason: String },

    #[error("checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("resume metadata is corrupt or from an incompatible version: {0}")]
    CorruptMetadata(String),

    #[error("download was cancelled")]
    Cancelled,

    #[error("download was paused")]
    Paused,

    #[error("storage error: {0}")]
    Storage(#[from] rusqlite::Error),

    #[error("serialisation error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("no download with id {0}")]
    NotFound(String),

    #[error("{0}")]
    Other(String),
}

impl Error {
    /// Whether the worker loop should retry after a backoff rather than fail.
    pub fn is_transient(&self) -> bool {
        match self {
            Error::Network(e) => {
                e.is_timeout() || e.is_connect() || e.is_request() || e.is_body()
            }
            Error::PlainIo(e) => matches!(
                e.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::Interrupted
            ),
            Error::BadStatus { status, .. } => {
                // 408 timeout, 429 rate limit, 5xx server-side.
                *status == 408 || *status == 429 || (*status >= 500 && *status < 600)
            }
            _ => false,
        }
    }
}
