# Downpour browser protocol, version 2 -- DRAFT

**Status: draft, not frozen.** This document becomes frozen, as
`docs/rpc-protocol.md` (v1) is, the day the first release that speaks it
ships. Until then it is the design both halves are built against. Version 1
is unchanged and stays supported: every `/api/v1/*` route, the token, pairing,
and the `source` strings keep working for extensions that never learn v2.

Version 2 is one generation that carries three features which only work
together:

- **refreshing a download's address** -- a signed or session-bound link that
  expired while the partial file is still good;
- **capturing the browser's request as faithfully as the browser allows**, and
  saying which parts were seen and which were rebuilt;
- **native messaging** as the preferred transport, and Firefox.

Shipping them as three protocol changes would mean three versions to support
forever. This is the single change.

---

## 1. Decisions

Each is the default the implementation follows. The reasoning is here so a
later change is a decision, not an accident.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Native host: separate binary, or the app in a special mode? | **Separate small binary** `downpour-native-host.exe`, its own crate. | Starts in milliseconds without a webview; holds no download logic; the smallest possible surface reachable from a browser. |
| D2 | How the host reaches the app | **Relays to the existing loopback server**, `POST /api/v2/message`, authenticating with the pairing token it reads from the app's per-user data directory. | One server, one schema, two carriers. A named pipe is a second IPC surface to secure for no capability v2 needs; it can replace the relay later without touching the message schema. |
| D3 | App not running | **The host launches it** (breaking away from the browser's job object, which Firefox requires) and waits up to 10 s; otherwise answers `app_unavailable` and the browser keeps its download. | A download manager that silently does nothing because its window was closed is the commonest complaint about this class of tool. |
| D4 | v1 loopback once native works | **Stays on by default**, as the fallback carrier. | Existing installs keep working; nothing is broken to make the architecture tidier. |
| D5 | Extension identity for native messaging | Chromium: **learned at pairing.** The v1 `/api/v1/pair` request already carries `Origin: chrome-extension://<id>`; the app records that ID and registers the native host for exactly it. Firefox: a fixed `browser_specific_settings.gecko.id`. | The extension is loaded unpacked, so its Chromium ID is derived from each user's folder path and cannot be listed in advance. Pinning it with a manifest `key` would change every existing install's ID and wipe its stored settings. |
| D6 | Firefox capture | `downloads.onCreated` → hand off → cancel and erase only after the app accepts -- the same order as Chromium. A blocking `onHeadersReceived` interception may come later. | Firefox has no `onDeterminingFilename` and no `finalUrl`; `onCreated` is the dependable hook. |
| D7 | Firefox packaging | The code stays build-free. A second manifest, `extension/manifest.firefox.json` (event page, `gecko.id`), is swapped in by the packaging script. | The only real difference is the manifest. |
| D8 | Where refresh matching happens | **In the app**, not the extension. Every capture already reaches the app; the app checks it against downloads that are waiting for a new address. | Works with every extension version -- v1 included -- and keeps matching policy in one place, as capture policy already is. |
| D9 | Refresh when identity cannot be proven | The new address is attached; the **existing resume rules** then decide: validators confirmed → resume, anything else → restart from zero, in the same item. | Refreshing an address proves nothing about the bytes on disk. The resume rules already encode exactly what does. |
| D10 | Request bodies and POST downloads | **Not captured.** Non-GET downloads stay with the browser (commit 4115e20). `method` travels so the app can decline. | Replaying a form POST is unsafe to get wrong and rarely what the user meant. |
| D11 | `Authorization` | **Never captured from the browser** -- Chrome does not expose it. Marked `unavailable`. | Honest provenance beats an invented value. |
| D12 | Stored secrets | Cookies and other credentials in stored request context are **encrypted at rest with DPAPI** (per-user) and dropped when the download completes or is removed. | The store currently keeps captured `Cookie` headers in plaintext. |
| D13 | Browser cookies for yt-dlp | **Not passed in this version.** | Writing a cookie file for a third-party tool is a privacy decision of its own. |

The only input the implementation still needs from outside the repository:
the Chrome Web Store / Edge Add-ons IDs, if and when the extension is listed
there, to add to the host's allowlist alongside paired IDs.

---

## 2. Architecture

```
 browser extension ──connectNative──► downpour-native-host.exe ──HTTP──► app (loopback, /api/v2/message)
        │                                (validate, relay only)                │
        └──────────── fallback: HTTP to the same loopback server ─────────────┘
                                                                               │
                                                                       downpour-core Engine
```

- The extension prefers the native port. If no host is registered, or it
  cannot connect, it falls back to the loopback server -- v2 messages over
  `POST /api/v2/message` when the app advertises v2, v1 endpoints otherwise.
  If neither answers, the browser keeps the download (as today).
- The open `connectNative` port keeps the MV3 service worker alive (Chrome
  105+). The extension reconnects in `onDisconnect`, with backoff.
- The host never interprets a message beyond validating it. It has no
  filesystem or process surface except reading the token and launching the
  app executable at a fixed path.

### Registration (Windows)

The app writes one host manifest per browser family and points these per-user
keys at it on install and on every pairing, and removes them on uninstall:

- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.downpour.host`
  (also read by Edge as a fallback)
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.downpour.host`
- `HKCU\Software\Chromium\...` and `HKCU\Software\BraveSoftware\Brave-Browser\...`
  -- best effort, verified empirically
- `HKCU\Software\Mozilla\NativeMessagingHosts\com.downpour.host`
  (`allowed_extensions`, not `allowed_origins`)

`allowed_origins` lists every ID that has paired, plus any listed store IDs.
The host additionally checks the caller ID it is given on the command line
against the same list, and refuses anything else.

---

## 3. Wire format

### Framing

Native: UTF-8 JSON preceded by a 32-bit little-endian length, as both browsers
define. Loopback: the same JSON as the body of `POST /api/v2/message`, with
`X-Downpour-Token`.

**Limits, enforced by the host and again by the app:** a frame is at most
**1 MiB** in either direction (Chrome's host-to-browser cap is the binding
one); at most 64 headers per request context, 8 KiB per header value, 32 KiB
of headers in total; URLs `http`/`https` only, at most 8 KiB.

### Envelope

```json
{ "v": 2, "id": "<uuid>", "type": "capture.offer", "replyTo": null, "body": { } }
```

Unknown fields in the envelope are rejected; unknown fields inside `body` are
ignored, so either side can add optional fields within v2. An unknown `type`
gets `error { code: "unsupported_type" }` -- the connection is never dropped
for it.

### Handshake

`hello` (extension → app):
`{ browser, browserVersion, extensionVersion, protocolVersions: [2], capabilities: [...] }`.
Capabilities the extension may claim: `webRequest.extraHeaders`,
`downloads.onDeterminingFilename`, `downloads.finalUrl`, `redirectChain`.

`welcome` (app → extension): `{ appVersion, protocol: 2, capabilities, limits }`.
No other message is accepted before `hello`.

---

## 4. Request context and provenance

Every capture carries a `RequestContext`:

```json
{
  "url": "...", "finalUrl": "...", "method": "GET",
  "redirectChain": ["...", "..."],
  "headers": { "User-Agent": { "value": "...", "provenance": "observed" } },
  "cookies":  { "value": "...", "provenance": "cookies_api" },
  "referrer": "...", "initiator": "https://...",
  "tabUrl": "...", "pageTitle": "...", "incognito": false,
  "mime": "...", "sizeHint": 123, "filename": "...",
  "browserDownloadId": 42, "source": "extension"
}
```

`provenance` is one of:

- `observed` -- seen on the actual request through `webRequest` (with
  `extraHeaders` where Chrome requires it);
- `cookies_api` -- read from the browser's cookie jar for that URL, not seen
  on the wire;
- `browser_reported` -- from the browser's own download record (`referrer`,
  `mime`, `fileSize`);
- `reconstructed` -- built by the extension (e.g. `navigator.userAgent`);
- `unavailable` -- the browser does not expose it (`Authorization` in Chrome).

The app keeps provenance with the stored context, so a failure can be
diagnosed ("the cookie was rebuilt, not observed") instead of guessed at.

**What the app does with captured headers.** It takes only what a downloader
legitimately needs and its own stack does not generate: `Cookie`, `Referer`,
`User-Agent`, `Accept-Language`, and site-specific `X-*`/`Sec-*` tokens. It
always drops, whatever the provenance: `Host`, `Connection`, `Keep-Alive`,
`Proxy-*`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Content-Length`,
`Content-Type`, `Expect`, `Range`, `If-Range`, `If-*`, `Accept-Encoding`
(its own stack decides these), and `Origin` on a GET. The cross-origin rule
stays an invariant: credentials go only to the scheme, host and port they
were captured for (`RemoteInfo::credentials_follow`).

`source` is a closed set in v2 -- the v1 strings plus nothing else --
because the app's policy (whether to prompt) is keyed on it.

---

## 5. Messages

### Capture

- `capture.offer` (ext → app): `{ context: RequestContext }`.
- Reply `capture.accepted { itemId, disposition }`, where `disposition` is
  `queued`, `awaiting_confirmation` or **`refreshed_existing`** (the capture
  was the new address for a download that was waiting for one, §6). The
  extension cancels and erases the browser's copy **only** on `accepted` --
  the v1 rule.
- Or `capture.declined { reason }`: `post_request`, `policy`, `unsupported_url`,
  `invalid`.

### Rules and status

- `capture.rules` (ext → app) → the v1 `/capture` rules, plus `refreshHosts`:
  origins with a download waiting for a new address, so the extension
  captures a retriggered download from them even if its usual rules would not.
- `status.subscribe` / `status.update` -- item progress for the popup.
- `ping` / `pong`; `app.show`.

### Media

- `media.probe`, `media.resolve` -- the v1 operations.
- `capture.offer` for a resolved format additionally carries
  `media: { pageUrl, formatId, extractor }`, which the app stores so it can
  re-resolve on its own later (§6.2).

---

## 6. Refreshing a download's address

A link stops working while the partial file is still good: it was signed for
an hour, bound to a session, or single-use. The answer is a new link for the
**same item** -- never a second download beside the first.

### 6.1 What the engine does with a new address

`Engine::refresh_address(id, url, headers)` replaces the item's address and
request context and leaves the part file and sidecar where they are. Starting
the item then runs the ordinary path: probe the new address, compare against
the sidecar, and either resume (validators confirmed, same size) or restart
from zero (anything else). No new identity logic exists for refresh; the safe
resume rules are the whole of it.

**When an address has expired.** The engine reports a structured reason
instead of a generic failure when the server answers `401`, `403`, `404` or
`410` to a download that has bytes on disk, or answers a resume with
`text/html` where the file was not HTML. The second matters most: an expired
link that redirects to a login page must never be "restarted" into an HTML
file saved under the download's name. Both put the item in `Paused` with the
reason `address_expired`.

### 6.2 Automatic: media

An item with stored `media` identity whose address expires is re-resolved by
the app: run the resolver on `pageUrl`, pick `formatId`, call
`refresh_address`, start. At most once per failure and three times per item,
so a page that keeps handing out dead links ends in `Paused` with the reason,
not a loop.

### 6.3 Browser-assisted: everything else

1. The user chooses **Refresh download address** on a paused or failed item.
2. The item is marked waiting (`awaitingAddressUntil`, 10 minutes) and the
   app shows: "Open the page the file came from and start the download again".
   The item's origin joins `refreshHosts` (§5).
3. The extension captures the retriggered download and offers it as usual.
4. The app scores the capture against every waiting item:
   - **filename** (from the capture, or its Content-Disposition) equals the
     item's original name -- strong;
   - **size** (`sizeHint`, or the app's own probe) equals the item's total --
     strong;
   - **where it came from** -- required: the capture's address or final
     address is on the same host as one the item is known by (its address,
     its final address), or the capture's page is the item's original page.
     Host equality, not "same site": a public-suffix list is not something
     the app carries, and a link handing off to a CDN on another domain is
     the ordinary case the page check exists for;
   - **MIME type** compatible -- supporting.
   Exactly one waiting item with both strong signals: attached automatically,
   and the reply is `refreshed_existing`. A partial or ambiguous match: the
   user is asked which item it belongs to, or whether it is a new download.
   No match: an ordinary new capture. Nothing is attached on a guess.
5. The wait ends on attach, on cancel, or after 10 minutes, and the item's
   origin leaves `refreshHosts`.

Step 4 decides which item a capture belongs to. Whether its bytes can be kept
is decided afterwards by the resume rules (§6.1), never by the match score.

---

## 7. Storage

Migration to store schema 3 adds a `download_origin` table, one row per item:
`kind` (`browser_capture`, `media_page`, `manual`), `page_url`, `media_format_id`,
`extractor`, `original_url`, `redirect_chain`, `provenance` (JSON),
`captured_at`, `awaiting_address_until`, and the credentials-bearing context,
encrypted (D12). Rows for v1 captures are synthesised with provenance
`reconstructed`.

---

## 8. Compatibility

| Extension | App | Result |
|---|---|---|
| v1 | v2 | Works exactly as today over loopback. Browser-assisted refresh also works: matching is in the app. |
| v2 | v1 | `/health` reports protocol 1; the extension uses v1 endpoints only. |
| v2 | v2, host registered | Native port; loopback as fallback. |
| v2 | v2, no host | v2 messages over loopback. |

---

## 9. Implementation order

1. **Refresh address** (§6), over the transports that exist: engine
   `refresh_address` and the `address_expired` reason with tests on the
   misbehaving server; the app-side matcher; media re-resolution; the UI action.
2. **Capture fidelity** (§4): `webRequest` observation keyed by `requestId`
   across redirects, provenance, header policy; `POST /api/v2/message` and
   `hello`/`welcome`.
3. **Native messaging and Firefox**: the host crate, registration on pairing,
   the extension's transport selection, `manifest.firefox.json`.
