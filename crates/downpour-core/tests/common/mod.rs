//! A local HTTP server that can be told to misbehave.
//!
//! Testing a download engine against a well-behaved server proves almost
//! nothing: the bugs that corrupt files come from servers that advertise range
//! support and ignore it, that drop connections mid-body, and that change the
//! file underneath a resume. This server can do all three on demand.

#![allow(dead_code)]

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Response, StatusCode};
use axum::routing::get;
use axum::Router;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    /// Answers every ranged request with `416` and `Content-Range: bytes */N`
    /// -- a non-empty file whose server will not serve parts of it -- and the
    /// whole file to a plain GET.
    RejectsRanges,
    /// Answers everything with `403`: a signed address that has expired.
    Forbidden,
    /// Answers everything with a small `200 text/html` page: an expired
    /// address that redirects to a login page, which is what many sites do
    /// instead of saying 403.
    LoginPage,
}

pub struct ServerState {
    /// `Bytes` so every response is a cheap slice of one buffer: several
    /// concurrent downloads of a large file must not each copy all of it.
    pub data: Mutex<Bytes>,
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
    /// Response bodies being sent right now, and the most there ever were at
    /// once. One server is one origin, so the peak is exactly what a
    /// per-origin connection limit promises to bound.
    pub in_flight: AtomicUsize,
    pub peak_in_flight: AtomicUsize,
    /// Whether `If-Range` is honoured. A real server answers a stale `If-Range`
    /// with `200` and the whole new file; switching this off reproduces the
    /// servers that ignore it and serve a `206` of whatever they hold now, so
    /// the client's own checks on the response are all that stands between it
    /// and a spliced file.
    pub honour_if_range: AtomicBool,
    /// Treat every `If-Range` as stale, matching or not. RFC 9110 lets a
    /// server do this for a date it does not consider strong, and some do it
    /// for everything; the client must still finish the download.
    pub refuse_every_if_range: AtomicBool,
    /// Requests for the file that carried a `Cookie` or `Authorization`
    /// header, so a test can prove a session never reached a host it was not
    /// captured for.
    pub credentialed_requests: AtomicUsize,
    /// When set, a request without exactly this `Cookie` gets `403`: a file
    /// behind a login, which only the captured session can fetch.
    pub required_cookie: Mutex<Option<String>>,
    /// Answer this many ranged requests with `429` and `Retry-After`.
    pub rate_limit_remaining: AtomicUsize,
    pub retry_after_secs: AtomicUsize,
    /// `429`s actually sent, so a test can wait until a client is in its wait.
    pub rate_limited: AtomicUsize,
    /// Where `/redirect` sends the client with a `302`.
    pub redirect_target: Mutex<Option<String>>,
    /// Requests that carried an `If-Range` header.
    pub if_range_requests: AtomicUsize,
    /// A replacement applied the moment the request counter reaches the given
    /// number, before that request is answered. The only deterministic way to
    /// change the file *during* a transfer: a sleep-and-swap races the workers.
    pub pending_change: Mutex<Option<(usize, Change)>>,
    /// A mode switch applied the moment the request counter reaches the given
    /// number -- an address that expires partway through a download.
    pub pending_mode: Mutex<Option<(usize, Mode)>>,
}

/// A new version of the file, applied by [`ServerState::change_at_request`].
#[derive(Debug, Clone)]
pub struct Change {
    pub data: Vec<u8>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
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
    /// Makes the next `times` ranged requests answer `429` with this
    /// `Retry-After`.
    pub fn rate_limit(&self, times: usize, retry_after_secs: usize) {
        self.retry_after_secs
            .store(retry_after_secs, Ordering::SeqCst);
        self.rate_limit_remaining.store(times, Ordering::SeqCst);
    }
    pub fn rate_limited_count(&self) -> usize {
        self.rate_limited.load(Ordering::SeqCst)
    }
    pub async fn require_cookie(&self, cookie: &str) {
        *self.required_cookie.lock().await = Some(cookie.to_string());
    }
    pub fn credentialed_count(&self) -> usize {
        self.credentialed_requests.load(Ordering::SeqCst)
    }
    /// Makes `/redirect` answer with a `302` to `url`.
    pub async fn redirect_to(&self, url: &str) {
        *self.redirect_target.lock().await = Some(url.to_string());
    }
    pub fn peak_in_flight(&self) -> usize {
        self.peak_in_flight.load(Ordering::SeqCst)
    }
    pub fn if_range_count(&self) -> usize {
        self.if_range_requests.load(Ordering::SeqCst)
    }
    pub fn reset_counters(&self) {
        self.requests.store(0, Ordering::SeqCst);
        self.ranged_requests.store(0, Ordering::SeqCst);
        self.bytes_served.store(0, Ordering::SeqCst);
        self.if_range_requests.store(0, Ordering::SeqCst);
        self.credentialed_requests.store(0, Ordering::SeqCst);
    }
    pub fn honour_if_range(&self, honour: bool) {
        self.honour_if_range.store(honour, Ordering::SeqCst);
    }
    /// Replaces the file, both validators included. `None` removes a
    /// validator, which is how a server that stops sending one is simulated.
    pub async fn replace_all(
        &self,
        data: Vec<u8>,
        etag: Option<&str>,
        last_modified: Option<&str>,
    ) {
        *self.data.lock().await = Bytes::from(data);
        *self.etag.lock().await = etag.map(|s| s.to_string());
        *self.last_modified.lock().await = last_modified.map(|s| s.to_string());
    }
    /// Switches to `mode` just before the `nth` request (counting from 1 since
    /// the last counter reset) is answered.
    pub async fn mode_at_request(&self, nth: usize, mode: Mode) {
        *self.pending_mode.lock().await = Some((nth, mode));
    }
    /// Swaps in `change` just before the `nth` request (counting from 1 since
    /// the last counter reset) is answered.
    pub async fn change_at_request(&self, nth: usize, change: Change) {
        *self.pending_change.lock().await = Some((nth, change));
    }
    pub async fn set_mode(&self, mode: Mode) {
        *self.mode.lock().await = mode;
    }
    /// Replaces the file contents and its ETag, simulating an upstream change.
    pub async fn replace_data(&self, data: Vec<u8>, etag: Option<&str>) {
        *self.data.lock().await = Bytes::from(data);
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
        data: Mutex::new(Bytes::from(data)),
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
        in_flight: AtomicUsize::new(0),
        peak_in_flight: AtomicUsize::new(0),
        honour_if_range: AtomicBool::new(true),
        refuse_every_if_range: AtomicBool::new(false),
        credentialed_requests: AtomicUsize::new(0),
        required_cookie: Mutex::new(None),
        rate_limit_remaining: AtomicUsize::new(0),
        retry_after_secs: AtomicUsize::new(0),
        rate_limited: AtomicUsize::new(0),
        redirect_target: Mutex::new(None),
        if_range_requests: AtomicUsize::new(0),
        pending_change: Mutex::new(None),
        pending_mode: Mutex::new(None),
    });

    let app = Router::new()
        .route("/file", get(serve))
        .route("/file/{*rest}", get(serve))
        .route("/redirect", get(redirect))
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

/// A `302` to wherever the test pointed it. Not counted as a request for the
/// file: the counters describe what the file's own host was asked for.
async fn redirect(State(state): State<Arc<ServerState>>) -> Response<Body> {
    let target = state.redirect_target.lock().await.clone();
    match target {
        Some(url) => Response::builder()
            .status(StatusCode::FOUND)
            .header("location", url)
            .body(Body::empty())
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap(),
    }
}

async fn serve(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response<Body> {
    if headers.contains_key("cookie") || headers.contains_key("authorization") {
        state.credentialed_requests.fetch_add(1, Ordering::SeqCst);
    }
    let nth = state.requests.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(required) = state.required_cookie.lock().await.as_deref() {
        let sent = headers.get("cookie").and_then(|v| v.to_str().ok());
        if sent != Some(required) {
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Body::empty())
                .unwrap();
        }
    }
    {
        let mut pending = state.pending_change.lock().await;
        if pending.as_ref().is_some_and(|(at, _)| nth >= *at) {
            let (_, change) = pending.take().unwrap();
            *state.data.lock().await = Bytes::from(change.data);
            *state.etag.lock().await = change.etag;
            *state.last_modified.lock().await = change.last_modified;
        }
    }

    {
        let mut pending = state.pending_mode.lock().await;
        if pending.as_ref().is_some_and(|(at, _)| nth >= *at) {
            let (_, mode) = pending.take().unwrap();
            *state.mode.lock().await = mode;
        }
    }
    let mode = *state.mode.lock().await;
    if mode == Mode::Forbidden {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("forbidden"))
            .unwrap();
    }
    if mode == Mode::LoginPage {
        let page = "<!doctype html><title>Sign in</title><form>...</form>";
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/html; charset=utf-8")
            .header("content-length", page.len().to_string())
            .body(Body::from(page))
            .unwrap();
    }
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
        let remaining = &state.rate_limit_remaining;
        let mut n = remaining.load(Ordering::SeqCst);
        let limited = loop {
            if n == 0 {
                break false;
            }
            match remaining.compare_exchange(n, n - 1, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => break true,
                Err(actual) => n = actual,
            }
        };
        if limited {
            state.rate_limited.fetch_add(1, Ordering::SeqCst);
            return Response::builder()
                .status(StatusCode::TOO_MANY_REQUESTS)
                .header(
                    "retry-after",
                    state.retry_after_secs.load(Ordering::SeqCst).to_string(),
                )
                .body(Body::empty())
                .unwrap();
        }
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
            // Streamed in pieces with no Content-Length header, so hyper uses
            // chunked transfer encoding. Through `body_for` like every other
            // body, so it is counted in flight too.
            return builder
                .status(StatusCode::OK)
                .body(body_for(&state, data).await)
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
        Mode::RejectsRanges => {
            if range_header.is_some() {
                return builder
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("content-range", format!("bytes */{total}"))
                    .body(Body::empty())
                    .unwrap();
            }
            return builder
                .status(StatusCode::OK)
                .header("content-length", total.to_string())
                .body(body_for(&state, data).await)
                .unwrap();
        }
        Mode::Honest | Mode::ServerError | Mode::Forbidden | Mode::LoginPage => {}
    }

    builder = builder.header("accept-ranges", "bytes");

    // RFC 9110 13.1.5: a range is served only if the validator in `If-Range`
    // still matches -- a strong comparison for an entity tag, an exact one for
    // a date. Otherwise the whole current file goes back with a 200.
    let if_range = headers
        .get("if-range")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    if if_range.is_some() {
        state.if_range_requests.fetch_add(1, Ordering::SeqCst);
    }
    let stale = match &if_range {
        Some(v) if v.starts_with('"') || v.starts_with("W/") => {
            v.starts_with("W/")
                || etag
                    .as_deref()
                    .is_none_or(|e| e.starts_with("W/") || e != v)
        }
        Some(v) => last_modified.as_deref() != Some(v.as_str()),
        None => false,
    } || (if_range.is_some() && state.refuse_every_if_range.load(Ordering::SeqCst));
    let range_header = if stale && state.honour_if_range.load(Ordering::SeqCst) {
        None
    } else {
        range_header
    };

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

    let slice = data.slice(start..=end);
    builder
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-range", format!("bytes {start}-{end}/{total}"))
        .header("content-length", slice.len().to_string())
        .body(body_for(&state, slice).await)
        .unwrap()
}

/// Counts one response body as in flight for as long as it lives.
struct InFlight(Arc<ServerState>);

impl InFlight {
    fn enter(state: &Arc<ServerState>) -> Self {
        let now = state.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        state.peak_in_flight.fetch_max(now, Ordering::SeqCst);
        InFlight(Arc::clone(state))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Wraps the payload, honouring a pending "drop the connection" instruction,
/// and counts it in flight until its last piece is handed over.
async fn body_for(state: &Arc<ServerState>, payload: Bytes) -> Body {
    state
        .bytes_served
        .fetch_add(payload.len(), Ordering::SeqCst);
    let delay = state.chunk_delay_ms.load(Ordering::SeqCst);

    let pieces: Vec<Result<Bytes, std::io::Error>> = if delay > 0 {
        // Eight pieces with a wait before each: long enough that a client which
        // only notices a pause between chunks is plainly distinguishable from
        // one that can be woken mid-wait.
        let piece = payload.len().div_ceil(8).max(1);
        (0..payload.len().max(1))
            .step_by(piece)
            .map(|i| Ok(payload.slice(i.min(payload.len())..(i + piece).min(payload.len()))))
            .collect()
    } else {
        let truncate_at = *state.truncate_after.lock().await;
        let remaining = state.truncate_times.load(Ordering::SeqCst);
        match truncate_at {
            Some(cut) if remaining > 0 && payload.len() > cut => {
                state.truncate_times.fetch_sub(1, Ordering::SeqCst);
                // Send a prefix, then abort the body with an error. The client
                // sees a connection that died mid-transfer, which is exactly
                // what a flaky link looks like.
                vec![
                    Ok(payload.slice(..cut)),
                    Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "simulated connection drop",
                    )),
                ]
            }
            // Pieces, not one buffer: handed over whole, a body would leave
            // the in-flight count the instant it started, and the count would
            // measure nothing. In pieces, backpressure from a client still
            // reading keeps it counted for as long as it is really in flight.
            _ => (0..payload.len().max(1))
                .step_by(64 * 1024)
                .map(
                    |i| Ok(payload.slice(i.min(payload.len())..(i + 64 * 1024).min(payload.len()))),
                )
                .collect(),
        }
    };

    // The count ends as the last piece is handed over -- before the client can
    // have read it -- so a client that finishes and immediately opens its next
    // request is never counted twice. A body dropped early (the client went
    // away) ends the count on drop.
    let guard = InFlight::enter(state);
    let stream = futures::stream::unfold(
        (pieces.into_iter(), Some(guard)),
        move |(mut it, mut guard)| async move {
            let next = it.next()?;
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay as u64)).await;
            }
            if it.len() == 0 {
                guard.take();
            }
            Some((next, (it, guard)))
        },
    );
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
