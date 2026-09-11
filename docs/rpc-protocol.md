# Downpour local RPC protocol

**Version 1.** This is the contract between the Downpour desktop app and any
local client — primarily the browser extension, but also scripts and the CLI.

It is frozen: the extension and the app are built against it independently, so
changes are breaking changes and require a version bump on the path prefix.

---

## Why this exists

Manifest V3 removed blocking `webRequest`, so a browser extension can no longer
intercept a download and hand it to an external app the way IDM did on MV2. The
working pattern is:

1. The extension observes `chrome.downloads.onDeterminingFilename`.
2. It cancels the browser's download.
3. It POSTs the URL **plus the request headers** to Downpour on loopback.

Step 3 is the entire reason this protocol carries a `headers` map. A large share
of real downloads are session-gated: without the browser's `Cookie`, `Referer`
and `User-Agent`, the server returns a login page instead of the file, and the
download silently "succeeds" at 4 KB of HTML.

## Transport and binding

- **HTTP/1.1 over TCP, `127.0.0.1` only.** Never `0.0.0.0`: binding to all
  interfaces would expose the download queue to the local network.
- Default port **47113**, configurable. If the port is taken, the app tries the
  next 10 ports and records the live one; clients discover it by probing
  `/health` across that range.
- All bodies are `application/json; charset=utf-8`.

## Authentication

Every endpoint except `/health` requires:

```
X-Downpour-Token: <64 hex characters>
```

The token is generated on first run, shown in **Settings → Browser integration**,
and pasted into the extension's options page. Rules:

- Compared in constant time. A timing oracle on loopback is a real leak with
  many browser tabs able to make requests.
- A missing or wrong token returns `401` with `{"error":"unauthorized"}` and no
  other detail.
- Regenerating the token in Settings immediately invalidates the old one.

Without the token, any web page in the browser could POST downloads into the
app. The token is what makes `Access-Control-Allow-Origin` safe to be permissive.

## CORS

An extension service worker sends `Origin: chrome-extension://<id>`, and the
extension ID is not known ahead of time. The app therefore reflects the origin
back when — and only when — it is an extension origin:

```
Access-Control-Allow-Origin: <the request Origin, if it starts with
                              chrome-extension:// or moz-extension://,
                              otherwise omitted entirely>
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Downpour-Token
Access-Control-Max-Age: 86400
Vary: Origin
```

`OPTIONS` on any path returns `204` with those headers and no body. **A missing
preflight response makes every POST fail silently in the browser with no error
the extension can see**, so this is not optional.

---

## Endpoints

### `GET /health` — unauthenticated

Used by the extension to show "Downpour is running" and to find the port.

```json
{ "app": "downpour", "version": "0.1.0", "protocol": 1, "ok": true }
```

On a `protocol` mismatch a client should **warn and continue**, not refuse: a
newer app is expected to keep serving version 1 routes, and hard-failing would
break every user whose extension updates on a different schedule to their app.

Unauthenticated on purpose: presence is not a secret, and requiring a token to
detect the app would make the extension's setup flow impossible to explain.

### `GET /api/v1/capture` — authenticated

What the extension needs in order to decide whether to intercept, without
round-tripping per download.

```json
{
  "enabled": true,
  "minSizeBytes": 1048576,
  "includeExtensions": ["zip", "iso", "mp4"],
  "excludeHosts": ["mail.google.com"],
  "excludeExtensions": ["html", "htm", "css", "js", "json", "svg"]
}
```

- `includeExtensions` empty means "capture everything not excluded".
- `minSizeBytes` `0` means no size floor. The floor is **best-effort and
  client-side**: at the moment a browser extension decides whether to
  intercept, it frequently does not yet know the size. A client that cannot
  determine a size should intercept rather than skip, and let the app's own
  probe be authoritative.
- The extension must treat this as advisory and cache it for ~30s.

### `POST /api/v1/downloads` — authenticated

Adds one download.

**Request**

```json
{
  "url": "https://example.com/big.iso",
  "headers": {
    "Cookie": "session=abc123",
    "Referer": "https://example.com/downloads",
    "User-Agent": "Mozilla/5.0 ..."
  },
  "filename": "big.iso",
  "destDir": null,
  "startMode": "start",
  "source": "extension",
  "sizeHint": 4823449600,
  "pageTitle": "Downloads — Example"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | Must be `http` or `https`. Anything else is `400`. |
| `headers` | object | no | String→string. `Range` is stripped by the app. |
| `filename` | string | no | Sanitised app-side; path separators are stripped. |
| `destDir` | string \| null | no | `null` uses the configured download folder. |
| `startMode` | enum | no | `start` (default), `addonly`, `schedule`. |
| `source` | string | no | Free-form tag shown in the UI. |
| `sizeHint` | number | no | Display only; the probe is authoritative. |
| `pageTitle` | string | no | Display only. |

**Response `201`**

```json
{ "id": "6f1c…", "filename": "big.iso", "status": "queued" }
```

**Errors**

| Status | Body | When |
|---|---|---|
| `400` | `{"error":"invalid_url"}` | Not http/https, or unparseable. |
| `401` | `{"error":"unauthorized"}` | Missing or wrong token. |
| `413` | `{"error":"payload_too_large"}` | Body over 256 KB. |
| `500` | `{"error":"internal","detail":"…"}` | Anything else. |

### `POST /api/v1/downloads/batch` — authenticated

For "download all links on this page". Each entry accepts **every field** the
single-download endpoint accepts, `headers` included — a batch of session-gated
links is useless without per-item cookies.

**Request**

```json
{
  "items": [
    { "url": "https://example.com/a.zip", "headers": { "Cookie": "…" } },
    { "url": "https://example.com/b.zip", "startMode": "addonly" }
  ]
}
```

At most **500** items per request, and the 256 KB body cap applies. Cookie
headers are long, so clients should chunk by serialised size rather than by
count.

**Response `201`**

```json
{ "ids": ["…", "…"], "accepted": 2, "rejected": 0 }
```

Malformed entries are **skipped, not fatal** — one bad link in a page scrape
must not discard the other nineteen. `rejected` reports how many were dropped.

### `POST /api/v1/show` — authenticated

Brings the Downpour window to the foreground. Returns `204` with no body.
Exists so a client does not need a registered URL scheme just to focus the app.

### `POST /api/v1/downloads/text` — authenticated

Takes a blob of text and extracts every http(s) URL from it. This backs
"paste a list of links" and drag-and-dropping a `.txt` file.

```json
{ "text": "https://a.com/1.zip\nhttps://b.com/2.zip", "startMode": "addonly" }
```

Response is the same shape as `/batch`.

---

## Limits

- Request body: **256 KB** maximum. Cookie headers get long; batches get big.
- The listener accepts at most **32** concurrent connections.
- No endpoint blocks on network I/O: adding a download returns as soon as it is
  queued, never after it has probed. An extension that waits on a probe would
  hang the browser's download UI.

## Client checklist

For anyone implementing against this:

1. Probe `GET /health` on 47113…47123 to find the app. Cache the port.
2. Read `GET /api/v1/capture` and cache for 30s.
3. On interception, POST to `/api/v1/downloads` with the full header set.
4. On `401`, surface "token invalid — re-pair in Downpour Settings". Do not
   retry: retrying a bad token forever is how you end up rate-limited.
5. On connection refused, fall back to letting the browser download normally.
   Silently swallowing the download because the app is closed loses the file.
