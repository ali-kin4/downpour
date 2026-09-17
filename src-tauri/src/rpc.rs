//! The loopback RPC server the browser extension talks to.
//!
//! Implements `docs/rpc-protocol.md` v1. Three things here are load-bearing and
//! easy to get wrong:
//!
//! 1. **Bind `127.0.0.1`, never `0.0.0.0`.** Binding all interfaces would let
//!    anything on the local network queue downloads on this machine.
//! 2. **Answer CORS preflight explicitly.** A browser extension's `fetch` sends
//!    `OPTIONS` first; without a correct response every POST fails inside the
//!    browser with no error the extension can observe or report.
//! 3. **Compare the token in constant time.** Loopback is not a safe channel
//!    when every tab in the browser can make requests to it.

// The handlers below return `Result<_, Response>`. Clippy flags the error
// variant as large, but an axum `Response` is what the framework requires and
// boxing it would only add an allocation on a path that is already returning a
// full HTTP response.
#![allow(clippy::result_large_err)]

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use downpour_core::model::{DownloadSpec, StartMode};
use downpour_core::Engine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// A download the browser handed over that is waiting to be confirmed.
///
/// Emitted instead of queueing when the user has asked to be consulted. The
/// whole payload travels to the window -- headers included -- because the
/// answer has to be able to start the *same* download, cookies and all, and a
/// second fetch of the URL from the app would arrive without the browser's
/// session.
pub const CONFIRM_EVENT: &str = "downpour://confirm-download";

/// Bodies larger than this are refused. Cookie headers get long and batches get
/// big, but nothing legitimate approaches a quarter of a megabyte.
const MAX_BODY_BYTES: usize = 256 * 1024;

/// How many ports past the configured one to try before giving up.
const PORT_SCAN_RANGE: u16 = 10;

#[derive(Clone)]
struct RpcState {
    engine: Engine,
    /// Needed only so `/show` can raise the window; the rest of the surface is
    /// pure engine and stays testable without a running app.
    app: tauri::AppHandle,
}

/// Starts the listener, returning the port it actually bound.
///
/// Returns `None` when the feature is disabled or no port in the range is free;
/// the app runs perfectly well without it, so this is never fatal.
pub async fn serve(engine: Engine, app: tauri::AppHandle) -> Option<u16> {
    let settings = engine.settings();
    if !settings.rpc_enabled {
        tracing::info!("browser integration disabled; not starting the local listener");
        return None;
    }

    let state = RpcState { engine, app };
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/v1/capture", get(capture_settings))
        .route("/api/v1/downloads", post(add_one))
        .route("/api/v1/downloads/batch", post(add_batch))
        .route("/api/v1/downloads/text", post(add_text))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/show", post(show_window))
        .route("/api/v1/media/probe", post(media_probe))
        .route("/api/v1/media/resolve", post(media_resolve))
        // A catch-all so preflight to an unknown path still gets CORS headers
        // rather than a bare 404 the extension cannot diagnose.
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), gate))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state);

    let base = settings.rpc_port;
    for offset in 0..PORT_SCAN_RANGE {
        let port = base.saturating_add(offset);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                tracing::info!(%addr, "local RPC listening");
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = axum::serve(listener, app).await {
                        tracing::error!(error = %e, "local RPC server stopped");
                    }
                });
                return Some(port);
            }
            Err(e) => {
                tracing::debug!(port, error = %e, "port unavailable, trying the next");
            }
        }
    }
    tracing::warn!(
        base,
        "no free port in range; browser integration is unavailable this session"
    );
    None
}

// ---------------------------------------------------------------------------
// CORS and authentication
// ---------------------------------------------------------------------------

/// Single middleware for preflight, CORS headers and token checking.
///
/// Combining them is deliberate: a `401` that lacks CORS headers is invisible
/// to the extension, which sees only an opaque network failure and reports
/// "Downpour not running" when the real problem is a stale token.
async fn gate(State(state): State<RpcState>, req: Request<Body>, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    if req.method() == Method::OPTIONS {
        return cors(StatusCode::NO_CONTENT.into_response(), origin.as_deref());
    }

    // Presence is not a secret, and requiring a token to detect the app would
    // make the extension's pairing flow impossible to explain.
    let path = req.uri().path();
    if path != "/health" && path != "/api/v1/pair" {
        let token = state.engine.settings().rpc_token;
        let presented = req
            .headers()
            .get("x-downpour-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !constant_time_eq(presented.as_bytes(), token.as_bytes()) {
            let body = Json(ErrorBody {
                error: "unauthorized".into(),
                detail: None,
            });
            return cors(
                (StatusCode::UNAUTHORIZED, body).into_response(),
                origin.as_deref(),
            );
        }
    }

    cors(next.run(req).await, origin.as_deref())
}

/// Reflects extension origins only. A page on the open web gets no CORS headers
/// at all, so even with a leaked token it cannot read a response.
fn cors(mut response: Response, origin: Option<&str>) -> Response {
    let allowed = matches!(origin, Some(o)
        if o.starts_with("chrome-extension://") || o.starts_with("moz-extension://"));

    let headers = response.headers_mut();
    if allowed {
        if let Ok(v) = HeaderValue::from_str(origin.unwrap()) {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        }
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type, X-Downpour-Token"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
    // Without Vary, a cache could serve one extension's CORS headers to another.
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    response
}

/// Whether this `Origin` belongs to a browser extension.
///
/// Load-bearing for pairing: a web page can reach `127.0.0.1`, but it cannot
/// claim an extension origin -- the browser sets this header and will not let a
/// page lie about it. So this is what separates "the user's extension is
/// asking" from "a page the user happened to visit is asking".
fn is_extension_origin(origin: &str) -> bool {
    origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://")
}

/// Length-independent comparison. Returns false for differing lengths without
/// leaking where the difference is.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ErrorBody {
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    app: &'static str,
    version: &'static str,
    protocol: u32,
    ok: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PendingDownload {
    url: String,
    headers: BTreeMap<String, String>,
    filename: Option<String>,
    dest_dir: Option<PathBuf>,
    size_hint: Option<u64>,
    source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSettings {
    enabled: bool,
    min_size_bytes: u64,
    include_extensions: Vec<String>,
    exclude_hosts: Vec<String>,
    exclude_extensions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddItem {
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    dest_dir: Option<PathBuf>,
    #[serde(default)]
    start_mode: StartMode,
    #[serde(default)]
    source: Option<String>,
    // Accepted and ignored: display-only hints from the browser. Declaring
    // them keeps a well-formed request from being rejected as malformed.
    #[serde(default, rename = "sizeHint")]
    size_hint: Option<u64>,
    #[serde(default, rename = "pageTitle")]
    _page_title: Option<String>,
}

impl From<AddItem> for DownloadSpec {
    fn from(i: AddItem) -> Self {
        DownloadSpec {
            url: i.url,
            headers: i.headers,
            filename: i.filename,
            dest_dir: i.dest_dir.unwrap_or_default(),
            connections: None,
            category: None,
            start_mode: i.start_mode,
            checksum: None,
            source: i.source.or_else(|| Some("extension".into())),
        }
    }
}

#[derive(Deserialize)]
struct BatchBody {
    items: Vec<AddItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaProbeBody {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaResolveBody {
    url: String,
    format_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextBody {
    text: String,
    #[serde(default)]
    start_mode: StartMode,
    #[serde(default)]
    dest_dir: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddedOne {
    id: String,
    filename: String,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddedMany {
    ids: Vec<String>,
    accepted: usize,
    rejected: usize,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn health() -> Json<Health> {
    Json(Health {
        app: "downpour",
        version: env!("CARGO_PKG_VERSION"),
        protocol: 1,
        ok: true,
    })
}

/// Whether this hand-off should be put to the user rather than simply queued.
///
/// A click the extension intercepted is the one hand-off the user has not
/// actually agreed to -- they clicked a link, not a download button in
/// Downpour. Every other source is already an explicit choice: the context
/// menu, the video overlay and the link grabber all mean "download this", and
/// asking again would be a dialog in the way of an answered question. That is
/// why this keys on the source and not on the endpoint, which they all share.
fn should_confirm(source: Option<&str>, mode: StartMode, enabled: bool) -> bool {
    enabled && mode == StartMode::Start && source == Some("extension")
}

async fn capture_settings(State(state): State<RpcState>) -> Json<CaptureSettings> {
    let s = state.engine.settings();
    Json(CaptureSettings {
        enabled: s.rpc_enabled,
        min_size_bytes: 0,
        include_extensions: s.clipboard_extensions.clone(),
        exclude_hosts: Vec::new(),
        // Intercepting these would break ordinary browsing: every page, script
        // and stylesheet would be handed to the download manager.
        exclude_extensions: [
            "html", "htm", "xhtml", "css", "js", "mjs", "json", "xml", "svg", "ico", "woff",
            "woff2", "ttf", "map",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
    })
}

async fn add_one(
    State(state): State<RpcState>,
    Json(item): Json<AddItem>,
) -> Result<(StatusCode, Json<AddedOne>), Response> {
    if !is_http_url(&item.url) {
        return Err(bad_request("invalid_url"));
    }
    // A media *page* is not a file. Queueing one downloads the HTML and reports
    // success, which is worse than refusing: the user gets a 300 KB ".html"
    // named after the video and no error anywhere.
    if looks_like_media_page(&item.url) && item.start_mode == StartMode::Start {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorBody {
                error: "media_page".into(),
                detail: Some(
                    "This looks like a video page rather than a file. Use                      /api/v1/media/probe to list its formats, or send it with                      startMode \"addonly\" to hand it to the app."
                        .into(),
                ),
            }),
        )
            .into_response());
    }
    if should_confirm(
        item.source.as_deref(),
        item.start_mode,
        state.engine.settings().extension_confirm_downloads,
    ) {
        use tauri::Emitter;
        // The compact window, not the main one. Bringing the whole application
        // forward to ask about a single file interrupts far more than the
        // question is worth, and it buries whatever the user was actually
        // looking at. The panel listens for the event below, so one already on
        // screen just adds this download to its queue.
        if let Err(e) = crate::confirm_window::open(&state.app) {
            tracing::warn!(error = %e, "could not open the confirmation window");
        }
        let filename = item.filename.clone().unwrap_or_default();
        let _ = state.app.emit(
            CONFIRM_EVENT,
            PendingDownload {
                url: item.url,
                headers: item.headers,
                filename: item.filename,
                dest_dir: item.dest_dir,
                size_hint: item.size_hint,
                source: item.source,
            },
        );
        // 202 rather than 201: nothing was created. The extension still takes
        // Chrome's copy away on any 2xx, which is what we want -- the download
        // is Downpour's to run or to drop now, and a duplicate arriving in the
        // browser's folder because the user was still reading the dialog is
        // the one outcome nobody wants.
        return Ok((
            StatusCode::ACCEPTED,
            Json(AddedOne {
                id: String::new(),
                filename,
                status: "awaiting_confirmation".into(),
            }),
        ));
    }

    let id = state
        .engine
        .add(item.into())
        .map_err(|e| internal(&e.to_string()))?;
    let item = state.engine.get(&id);
    Ok((
        StatusCode::CREATED,
        Json(AddedOne {
            filename: item
                .as_ref()
                .map(|i| i.filename.clone())
                .unwrap_or_default(),
            status: item
                .as_ref()
                .map(|i| format!("{:?}", i.status).to_lowercase())
                .unwrap_or_else(|| "queued".into()),
            id,
        }),
    ))
}

async fn add_batch(
    State(state): State<RpcState>,
    Json(body): Json<BatchBody>,
) -> Result<(StatusCode, Json<AddedMany>), Response> {
    let submitted = body.items.len();
    // One dead link in a page scrape must not discard the other nineteen.
    let specs: Vec<DownloadSpec> = body
        .items
        .into_iter()
        .filter(|i| is_http_url(&i.url))
        .map(Into::into)
        .collect();

    let ids = state
        .engine
        .add_many(specs)
        .map_err(|e| internal(&e.to_string()))?;
    Ok((
        StatusCode::CREATED,
        Json(AddedMany {
            accepted: ids.len(),
            rejected: submitted.saturating_sub(ids.len()),
            ids,
        }),
    ))
}

async fn add_text(
    State(state): State<RpcState>,
    Json(body): Json<TextBody>,
) -> Result<(StatusCode, Json<AddedMany>), Response> {
    let ids = state
        .engine
        .add_from_text(
            &body.text,
            body.start_mode,
            body.dest_dir,
            Some("extension".into()),
        )
        .map_err(|e| internal(&e.to_string()))?;
    Ok((
        StatusCode::CREATED,
        Json(AddedMany {
            accepted: ids.len(),
            rejected: 0,
            ids,
        }),
    ))
}

/// Brings the Downpour window to the foreground.
///
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Paired {
    token: String,
}

/// Hands the pairing token to a browser extension, during a window the user
/// opened in the app.
///
/// Unauthenticated by necessity: the token is what this returns, so requiring
/// it would be circular. Three things make that safe.
///
/// The user must have opened a pairing window seconds earlier by clicking in
/// the app, so there is nothing here to attack the rest of the time. The caller
/// must present an extension origin, which a web page cannot forge -- a page
/// can reach `127.0.0.1`, but it cannot claim to be `chrome-extension://`. And
/// the window is short, so a request that arrives while one is open is one the
/// user is sitting in front of, waiting for.
///
/// It is single-use: the first caller closes the window. Two extensions racing
/// for one click should not both win.
async fn pair(State(state): State<RpcState>, headers: HeaderMap) -> Result<Json<Paired>, Response> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !is_extension_origin(origin) {
        tracing::warn!(%origin, "pairing refused: not a browser extension");
        return Err(forbidden("not_an_extension"));
    }

    use tauri::Manager;
    let app_state = state.app.state::<crate::state::AppState>();
    let until = app_state.pairing_until.load(Ordering::Relaxed);
    if downpour_core::resume::now_unix() > until {
        return Err(forbidden("no_pairing_window"));
    }
    // Consume it, so the click authorises one pairing and not a stream of them.
    app_state.pairing_until.store(0, Ordering::Relaxed);

    tracing::info!(%origin, "paired a browser extension");
    Ok(Json(Paired {
        token: state.engine.settings().rpc_token,
    }))
}

/// The extension needs this for its "Open Downpour" button; the alternative
/// was registering a custom URL scheme, which is far more machinery for one
/// action and leaves a protocol handler installed system-wide.
async fn show_window(State(state): State<RpcState>) -> StatusCode {
    use tauri::Manager;
    if let Some(w) = state.app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    StatusCode::NO_CONTENT
}

/// Lists the formats available for a media page.
///
/// The browser extension needs this to show a quality menu with sizes. Without
/// it the extension can only hand the page URL over blind, and a watch page is
/// not a file: posting one to `/downloads` used to save the page's HTML and
/// report success.
async fn media_probe(
    State(state): State<RpcState>,
    Json(body): Json<MediaProbeBody>,
) -> Result<Json<serde_json::Value>, Response> {
    if !is_http_url(&body.url) {
        return Err(bad_request("invalid_url"));
    }
    let info = crate::media::probe_media(state.app.clone(), body.url)
        .await
        .map_err(|e| media_error(&e))?;
    Ok(Json(
        serde_json::to_value(info).map_err(|e| internal(&e.to_string()))?,
    ))
}

/// Turns a chosen format into a direct URL plus the headers it requires.
async fn media_resolve(
    State(state): State<RpcState>,
    Json(body): Json<MediaResolveBody>,
) -> Result<Json<serde_json::Value>, Response> {
    if !is_http_url(&body.url) {
        return Err(bad_request("invalid_url"));
    }
    let resolved = crate::media::resolve_media(state.app.clone(), body.url, body.format_id)
        .await
        .map_err(|e| media_error(&e))?;
    Ok(Json(
        serde_json::to_value(resolved).map_err(|e| internal(&e.to_string()))?,
    ))
}

/// yt-dlp failures are the user's problem to fix (not installed, unsupported
/// site, private video), so its own message is passed through rather than
/// flattened into a generic 500.
fn media_error(detail: &str) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(ErrorBody {
            error: "media_unavailable".into(),
            detail: Some(detail.to_string()),
        }),
    )
        .into_response()
}

async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: "not_found".into(),
            detail: None,
        }),
    )
        .into_response()
}

/// Hosts whose URLs are pages describing media rather than the media itself.
///
/// Deliberately a small, obvious list rather than a clever heuristic: a false
/// positive refuses a download the user asked for, which is far worse than a
/// false negative (they simply get the page and can retry through the app).
fn looks_like_media_page(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").trim_start_matches("www.");
    const PAGE_HOSTS: &[&str] = &[
        "youtube.com",
        "youtu.be",
        "m.youtube.com",
        "vimeo.com",
        "dailymotion.com",
        "twitch.tv",
        "soundcloud.com",
        "bilibili.com",
        "nicovideo.jp",
        "rumble.com",
        "odysee.com",
    ];
    if !PAGE_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
    {
        return false;
    }
    // A direct media file served from one of those hosts is still a file.
    let path = parsed.path().to_ascii_lowercase();
    !path.ends_with(".mp4") && !path.ends_with(".webm") && !path.ends_with(".m4a")
}

fn is_http_url(url: &str) -> bool {
    url::Url::parse(url)
        .map(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn forbidden(code: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(ErrorBody {
            error: code.into(),
            detail: None,
        }),
    )
        .into_response()
}

fn bad_request(code: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorBody {
            error: code.into(),
            detail: None,
        }),
    )
        .into_response()
}

fn internal(detail: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorBody {
            error: "internal".into(),
            detail: Some(detail.to_string()),
        }),
    )
        .into_response()
}

/// Unused today, but kept so the type is exercised if the server later needs to
/// hand headers back to a caller.
#[allow(dead_code)]
fn header_map_to_btree(h: &HeaderMap) -> BTreeMap<String, String> {
    h.iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|v| (k.as_str().to_string(), v.to_string()))
        })
        .collect()
}

#[allow(dead_code)]
type Shared = Arc<RpcState>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_intercepted_click_is_put_to_the_user() {
        let on = |source, mode| should_confirm(source, mode, true);

        assert!(on(Some("extension"), StartMode::Start));

        // Deliberate choices. The user has already said to download these.
        assert!(!on(Some("extension-context-menu"), StartMode::Start));
        assert!(!on(Some("extension-video-overlay"), StartMode::Start));
        assert!(!on(Some("extension-link-grabber"), StartMode::Start));
        assert!(!on(Some("extension-page-links"), StartMode::Start));

        // A prefix match would have caught every one of those, so guard it.
        assert!(!on(Some("extensionsomething"), StartMode::Start));
        assert!(!on(None, StartMode::Start));

        // Queued without starting, or held for the scheduler: nothing is about
        // to happen, so there is nothing to interrupt the user about.
        assert!(!on(Some("extension"), StartMode::AddOnly));
        assert!(!on(Some("extension"), StartMode::Schedule));

        // Switched off, the intercepted click just starts, as it used to.
        assert!(!should_confirm(Some("extension"), StartMode::Start, false));
    }

    #[test]
    fn constant_time_eq_matches_only_identical_input() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        assert!(!constant_time_eq(b"abc", b"abcd"), "differing lengths");
        assert!(
            !constant_time_eq(b"", b""),
            "an empty token never authorises"
        );
    }

    #[test]
    fn only_extensions_may_ask_to_pair() {
        assert!(is_extension_origin("chrome-extension://abcdef"));
        assert!(is_extension_origin("moz-extension://abcdef"));

        // The cases that matter. A page cannot set its own Origin, so these
        // are what an attacker would have to be able to produce.
        assert!(!is_extension_origin("https://evil.example.com"));
        assert!(!is_extension_origin("http://127.0.0.1:8080"));
        assert!(!is_extension_origin("null"));
        assert!(!is_extension_origin(""));

        // Prefix matching is the whole implementation, so pin the near misses.
        assert!(!is_extension_origin("https://chrome-extension://spoof"));
        assert!(!is_extension_origin("chrome-extension:/abcdef"));
    }

    #[test]
    fn only_extension_origins_are_reflected() {
        let with = |origin: Option<&str>| {
            let r = cors(StatusCode::OK.into_response(), origin);
            r.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .map(|v| v.to_str().unwrap().to_string())
        };
        assert_eq!(
            with(Some("chrome-extension://abcdef")),
            Some("chrome-extension://abcdef".into())
        );
        assert_eq!(
            with(Some("moz-extension://abcdef")),
            Some("moz-extension://abcdef".into())
        );
        assert_eq!(
            with(Some("https://evil.example.com")),
            None,
            "web origins get nothing"
        );
        assert_eq!(with(None), None);
    }

    #[test]
    fn cors_headers_are_always_present_even_without_an_origin() {
        // The extension needs these on the 401 too, or a stale token looks
        // identical to the app being closed.
        let r = cors(StatusCode::UNAUTHORIZED.into_response(), None);
        assert!(r
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .is_some());
        assert!(r
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_METHODS)
            .is_some());
        assert_eq!(r.headers().get(header::VARY).unwrap(), "Origin");
    }

    #[test]
    fn media_pages_are_recognised_but_direct_files_are_not() {
        assert!(looks_like_media_page("https://www.youtube.com/watch?v=abc"));
        assert!(looks_like_media_page("https://youtu.be/abc"));
        assert!(looks_like_media_page("https://vimeo.com/12345"));
        assert!(looks_like_media_page("https://m.youtube.com/watch?v=abc"));

        // A real file, even on one of those hosts, is still a file.
        assert!(!looks_like_media_page("https://youtube.com/clip/thing.mp4"));
        // Everything else is a download, and a false positive would refuse a
        // download the user explicitly asked for.
        assert!(!looks_like_media_page("https://example.com/video.mp4"));
        assert!(!looks_like_media_page("https://notyoutube.com/watch?v=abc"));
        assert!(!looks_like_media_page(
            "https://github.com/a/b/releases/x.zip"
        ));
        assert!(!looks_like_media_page("not a url"));
    }

    #[test]
    fn url_scheme_validation() {
        assert!(is_http_url("https://example.com/a.zip"));
        assert!(is_http_url("http://example.com/a.zip"));
        assert!(!is_http_url("ftp://example.com/a.zip"));
        assert!(!is_http_url("file:///c:/secret.txt"));
        assert!(!is_http_url("magnet:?xt=urn:btih:abc"));
        assert!(!is_http_url("not a url"));
    }
}
