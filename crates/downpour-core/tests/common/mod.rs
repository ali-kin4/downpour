//! A local HTTP server that can be told to misbehave.
//!
//! Testing a download engine against a well-behaved server proves almost
//! nothing: the bugs that corrupt files come from servers that advertise range
//! support and ignore it, that drop connections mid-body, and that change the
//! file underneath a resume. This server can do all three on demand.

#![allow(dead_code)]

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Response, StatusCode};
use axum::routing::get;
use axum::Router;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

/// How the server responds to a ranged request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Correct RFC 7233 behaviour.
    Honest,
    /// Advertises `Accept-Ranges: bytes` and then returns `200` with the whole
    /// body anyway. This is the case that silently corrupts naive downloaders.
    LiesAboutRanges,
    /// Honest about not supporting ranges.
    NoRanges,
    /// Streams without a `Content-Length`, so the size is unknowable up front.
    UnknownLength,
    /// Returns 500 for everything.
    ServerError,
}

pub struct ServerState {
    pub data: Mutex<Vec<u8>>,
    pub etag: Mutex<Option<String>>,
    pub last_modified: Mutex<Option<String>>,
    pub mode: Mutex<Mode>,
    pub content_disposition: Mutex<Option<String>>,
    /// Truncate the body after this many bytes, simulating a dropped
    /// connection. Consumed `truncate_times` times, then normal service.
    pub truncate_after: Mutex<Option<usize>>,
    pub truncate_times: AtomicUsize,
    /// Every request the server has handled, for asserting on connection counts.
    pub requests: AtomicUsize,
    /// Ranged requests specifically, to prove segmentation actually happened.
    pub ranged_requests: AtomicUsize,
    /// Total payload bytes handed out, so a resume can be proven to have
    /// fetched less than the whole file.
    pub bytes_served: AtomicUsize,
    /// Milliseconds to wait between body chunks. Lets a test reproduce the one
    /// thing a local server otherwise cannot: a worker parked waiting on the
    /// network, which is where a download spends nearly all of its life.
    pub chunk_delay_ms: AtomicUsize,
}

impl ServerState {
    pub fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
    pub fn ranged_count(&self) -> usize {
        self.ranged_requests.load(Ordering::SeqCst)
    }
    pub fn bytes_served(&self) -> usize {
        self.bytes_served.load(Ordering::SeqCst)
    }
    /// Trickles the body out in `parts` pieces, pausing between each.
    pub fn trickle(&self, delay_ms: usize) {
        self.chunk_delay_ms.store(delay_ms, Ordering::SeqCst);
    }
    pub fn reset_counters(&self) {
        self.requests.store(0, Ordering::SeqCst);
        self.ranged_requests.store(0, Ordering::SeqCst);
        self.bytes_served.store(0, Ordering::SeqCst);
    }
    pub async fn set_mode(&self, mode: Mode) {
        *self.mode.lock().await = mode;
    }
    /// Replaces the file contents and its ETag, simulating an upstream change.
    pub async fn replace_data(&self, data: Vec<u8>, etag: Option<&str>) {
        *self.data.lock().await = data;
        *self.etag.lock().await = etag.map(|s| s.to_string());
    }
    /// Makes the next `times` responses cut off after `bytes` bytes.
    pub async fn drop_connection_after(&self, bytes: usize, times: usize) {
        *self.truncate_after.lock().await = Some(bytes);
        self.truncate_times.store(times, Ordering::SeqCst);
    }
}

pub struct TestServer {
    pub base_url: String,
    pub state: Arc<ServerState>,
}

impl TestServer {
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

/// Starts a server on an ephemeral port serving `data` at `/file`.
pub async fn start(data: Vec<u8>) -> TestServer {
    start_with(data, Mode::Honest, Some("\"v1\"")).await
}

pub async fn start_with(data: Vec<u8>, mode: Mode, etag: Option<&str>) -> TestServer {
    let state = Arc::new(ServerState {
        data: Mutex::new(data),
        etag: Mutex::new(etag.map(|s| s.to_string())),
        last_modified: Mutex::new(Some("Wed, 21 Oct 2026 07:28:00 GMT".to_string())),
        mode: Mutex::new(mode),
        content_disposition: Mutex::new(None),
        truncate_after: Mutex::new(None),
        truncate_times: AtomicUsize::new(0),
        requests: AtomicUsize::new(0),
        ranged_requests: AtomicUsize::new(0),
        bytes_served: AtomicUsize::new(0),
        chunk_delay_ms: AtomicUsize::new(0),
    });

    let app = Router::new()
        .route("/file", get(serve))
        .route("/file/{*rest}", get(serve))
        .with_state(Arc::clone(&state));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    TestServer {
        base_url: format!("http://{addr}"),
        state,
    }
}

async fn serve(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response<Body> {
    state.requests.fetch_add(1, Ordering::SeqCst);

    let mode = *state.mode.lock().await;
    if mode == Mode::ServerError {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::from("boom"))
            .unwrap();
    }

    let data = state.data.lock().await.clone();
    let etag = state.etag.lock().await.clone();
    let last_modified = state.last_modified.lock().await.clone();
    let disposition = state.content_disposition.lock().await.clone();
    let total = data.len();

    let range_header = headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    if range_header.is_some() {
        state.ranged_requests.fetch_add(1, Ordering::SeqCst);
    }

    let mut builder = Response::builder().header("content-type", "application/octet-stream");
    if let Some(e) = &etag {
        builder = builder.header("etag", e);
    }
    if let Some(lm) = &last_modified {
        builder = builder.header("last-modified", lm);
    }
    if let Some(cd) = &disposition {
        builder = builder.header("content-disposition", cd);
    }

    match mode {
        Mode::UnknownLength => {
            // Streamed in chunks so hyper uses chunked transfer encoding and
            // emits no Content-Length. Handing hyper a complete buffer would
            // let it compute the length and this case would never be tested.
            state.bytes_served.fetch_add(data.len(), Ordering::SeqCst);
            let chunks: Vec<Result<axum::body::Bytes, std::io::Error>> = data
                .chunks(64 * 1024)
                .map(|c| Ok(axum::body::Bytes::copy_from_slice(c)))
                .collect();
            return builder
                .status(StatusCode::OK)
                .body(Body::from_stream(futures::stream::iter(chunks)))
                .unwrap();
        }
        Mode::NoRanges => {
            return builder
                .status(StatusCode::OK)
                .header("content-length", total.to_string())
                .body(body_for(&state, data).await)
                .unwrap();
        }
        Mode::LiesAboutRanges => {
            // The trap: claim range support, then ignore the Range header.
            return builder
                .status(StatusCode::OK)
                .header("accept-ranges", "bytes")
                .header("content-length", total.to_string())
                .body(body_for(&state, data).await)
                .unwrap();
        }
        Mode::Honest | Mode::ServerError => {}
    }

    builder = builder.header("accept-ranges", "bytes");

    let Some(raw) = range_header else {
        return builder
            .status(StatusCode::OK)
            .header("content-length", total.to_string())
            .body(body_for(&state, data).await)
            .unwrap();
    };

    let Some((start, end)) = parse_range(&raw, total) else {
        return builder
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("content-range", format!("bytes */{total}"))
            .body(Body::empty())
            .unwrap();
    };

    let slice = data[start..=end].to_vec();
    builder
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-range", format!("bytes {start}-{end}/{total}"))
        .header("content-length", slice.len().to_string())
        .body(body_for(&state, slice).await)
        .unwrap()
}

/// Wraps the payload, honouring a pending "drop the connection" instruction.
async fn body_for(state: &Arc<ServerState>, payload: Vec<u8>) -> Body {
    state
        .bytes_served
        .fetch_add(payload.len(), Ordering::SeqCst);
    let delay = state.chunk_delay_ms.load(Ordering::SeqCst);
    if delay > 0 {
        // Eight pieces with a wait before each: long enough that a client which
        // only notices a pause between chunks is plainly distinguishable from
        // one that can be woken mid-wait.
        let piece = payload.len().div_ceil(8).max(1);
        let pieces: Vec<Vec<u8>> = payload.chunks(piece).map(|c| c.to_vec()).collect();
        let stream = futures::stream::unfold(pieces.into_iter(), move |mut it| async move {
            let next = it.next()?;
            tokio::time::sleep(std::time::Duration::from_millis(delay as u64)).await;
            Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(next)), it))
        });
        return Body::from_stream(stream);
    }

    let truncate_at = *state.truncate_after.lock().await;
    let remaining = state.truncate_times.load(Ordering::SeqCst);

    let Some(cut) = truncate_at else {
        return Body::from(payload);
    };
    if remaining == 0 || payload.len() <= cut {
        return Body::from(payload);
    }
    state.truncate_times.fetch_sub(1, Ordering::SeqCst);

    // Send a prefix, then abort the body with an error. The client sees a
    // connection that died mid-transfer, which is exactly what a flaky link
    // looks like.
    let prefix = payload[..cut].to_vec();
    let stream = futures::stream::iter(vec![
        Ok::<_, std::io::Error>(axum::body::Bytes::from(prefix)),
        Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "simulated connection drop",
        )),
    ]);
    Body::from_stream(stream)
}

/// Minimal `bytes=start-end` parser, inclusive, matching RFC 7233.
fn parse_range(raw: &str, total: usize) -> Option<(usize, usize)> {
    if total == 0 {
        return None;
    }
    let spec = raw.trim().strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    let start: usize = if s.is_empty() {
        // Suffix range: `bytes=-500` means the last 500 bytes.
        let n: usize = e.trim().parse().ok()?;
        return Some((total.saturating_sub(n), total - 1));
    } else {
        s.trim().parse().ok()?
    };
    let end = if e.trim().is_empty() {
        total - 1
    } else {
        e.trim().parse::<usize>().ok()?.min(total - 1)
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Deterministic pseudo-random payload. Real-looking data matters: a buffer of
/// zeroes would hide an off-by-one that writes a segment at the wrong offset.
pub fn payload(len: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(len);
    let mut x: u32 = 0x9E37_79B9;
    for _ in 0..len {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        v.push((x & 0xFF) as u8);
    }
    v
}

pub fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

pub struct TempDir(pub std::path::PathBuf);

impl TempDir {
    pub fn new() -> Self {
        let p = std::env::temp_dir().join(format!("downpour-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
    pub fn join(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Polls `check` until it returns true or the timeout expires.
///
/// The engine is event-driven and its pump runs on a timer, so tests wait for a
/// condition rather than sleeping a fixed amount and hoping.
pub async fn wait_for<F>(timeout: std::time::Duration, mut check: F) -> bool
where
    F: FnMut() -> bool,
{
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if check() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    check()
}
