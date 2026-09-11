# Downpour browser extension

A Manifest V3 extension that hands your browser's downloads to the **Downpour**
desktop app — **with the cookies, referer and user-agent the browser would have
sent**, so session-gated files download as the file and not as a login page.

Plain JavaScript. No build step, no bundler, no npm dependencies. What is in
this folder is what runs.

---

## Install (load unpacked)

Chrome, Edge, Brave, Opera, Vivaldi — anything Chromium 102+:

1. Start the Downpour desktop app at least once.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose this `extension/` folder.
5. The options page opens automatically on first install. If it does not, click
   the Downpour toolbar icon → **Settings**.

To install from a zip, zip the *contents* of this folder (so `manifest.json` is
at the archive root) and drag it onto `chrome://extensions` in developer mode.

Firefox is not supported yet: it uses `browser.*`/MV2-style download events and
a different `onDeterminingFilename` story. The protocol itself already allows
`moz-extension://` origins, so a port is possible later.

## Pairing

The app listens on `127.0.0.1` only, on the first free port in **47113–47123**,
and every endpoint except `/health` requires a token.

1. In Downpour: **Settings → Browser integration**. Copy the 64-character token.
2. In the extension's options page: paste it into **Pairing token** → **Save token**.
3. Press **Test connection**. It reports the two legs separately, because they
   fail for completely different reasons:
   - **1/2 App reachable** — `GET /health` found the app and which port it is on.
     If this fails, Downpour is not running (or is blocked from binding).
   - **2/2 Authentication** — an authenticated `GET /api/v1/capture` was
     accepted. If *this* fails while 1/2 passed, the app is running but the
     token is wrong: regenerate it in Settings and paste it again.

Regenerating the token in the app invalidates the old one immediately. The
extension shows `!` on its toolbar badge and stops sending until you re-pair —
it never retries a rejected token in a loop.

The extension talks to nothing except `http://127.0.0.1:<port>`. No telemetry,
no remote endpoints, no analytics.

## What it does

**Download capture.** On `chrome.downloads.onDeterminingFilename` the extension
checks the capture rules (from the app, cached 30s, or your browser-side
overrides) and if the download qualifies it POSTs the URL plus headers to
`POST /api/v1/downloads`. Only after the app answers `201` does it cancel and
erase the browser's own download.

> **If Downpour is not running, nothing is cancelled.** The POST fails first,
> the browser download continues untouched, and the popup says "Downpour is not
> running". Losing a file because the app was closed is not an acceptable
> failure mode, so the ordering is POST-then-cancel and never the reverse.

**Context menus.**

| Menu item | Where | Endpoint |
|---|---|---|
| Download with Downpour | links, images, video, audio | `POST /api/v1/downloads` |
| Download all links on this page | page / frame background | `POST /api/v1/downloads/batch` |
| Send selected text links to Downpour | text selection | `POST /api/v1/downloads/text` |

"All links on this page" injects a one-off function with `chrome.scripting` to
read `href`s, de-duplicates them, drops non-http(s) ones, attaches per-origin
cookies, and splits the batch so no request approaches the protocol's 256 KB
body limit. Those links are queued with `startMode: "addonly"` so a page full of
links does not start fifty transfers at once.

**Popup.** Connection status, the capture on/off switch, and **Open Downpour**.

**Options.** Token, connection test, capture toggle, and either the app's rules
or browser-side rules: size floor, include extensions, exclude extensions,
excluded hosts.

### Open Downpour

The button navigates to `downpour://open`, which requires the desktop app to
have registered that URL scheme with Windows. Protocol v1 has no
"show the window" endpoint, so there is no way to do this over HTTP. If the
scheme is not registered the browser simply does nothing — open the app from
the Start menu instead.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `downloads` | The whole point. Needed for `downloads.onDeterminingFilename` (to see a download starting), `downloads.cancel` (to take it away from the browser once Downpour has accepted it) and `downloads.erase` (to remove the cancelled entry from the download shelf). |
| `cookies` | To read the cookies that apply to the download URL — including `httpOnly` session cookies, which page scripts cannot see — and send them as a `Cookie` header. Without this, a large share of real downloads come back as a login page and "succeed" at a few KB of HTML. This is the single reason the extension exists rather than a plain "paste the URL" workflow. |
| `storage` | `chrome.storage.local` holds the pairing token, your capture preferences, the discovered port and the cached capture rules. An MV3 service worker is killed whenever the browser feels like it, so anything that must survive has to be on disk — nothing here is kept only in memory. |
| `contextMenus` | The three right-click entries listed above. |
| `scripting` | Only for "Download all links on this page": `chrome.scripting.executeScript` injects a function that reads the page's `href`s, on the tab you right-clicked, at the moment you click it. There is no declared content script, so the extension never runs code on a page you did not ask about. (MV3 removed `tabs.executeScript`, so this permission is unavoidable for that feature.) |
| `host_permissions: <all_urls>` | Two things. (1) `chrome.cookies.getAll({url})` returns cookies for a host only if the extension has host permission for it — and a download can come from any host, so the set cannot be narrowed ahead of time. (2) It covers `http://127.0.0.1:47113–47123`, letting the service worker POST to the app. Broad host access is what makes cookie forwarding possible at all; the extension reads cookies **only** for a URL that is actually being downloaded or scraped on request, and sends them **only** to `127.0.0.1`. |

Not requested, deliberately: `tabs` (context-menu clicks already carry the tab,
and `tabs.create` needs no permission), `notifications` (status goes on the
toolbar badge and in the popup), `webRequest` (removed as a blocking API in MV3,
which is why this protocol exists), and `alarms` (all TTLs are timestamp
comparisons evaluated on read, because timers do not survive worker shutdown).

## Troubleshooting

| Symptom | Cause |
|---|---|
| Popup says "Downpour is not running" | The app is closed, or no port in 47113–47123 answered `/health`. Downloads keep working in the browser. |
| Badge shows a red `!` and "Token invalid" | The token was regenerated in the app. Re-paste it in options. |
| Badge shows an amber `?` | No token saved yet. |
| Nothing is captured | Check the capture switch in the popup; then the rules — a size floor, an include list that does not contain the extension, or an excluded host. Downloads whose size the browser does not yet know are *not* filtered by the size floor, on purpose. |
| "Cannot read this page" on the page-links menu | Chrome forbids extension injection on `chrome://` pages, the Web Store, and PDF viewers. |
| A file downloaded twice | Chrome finished its own copy before the app answered `201`; the extension reports this instead of hiding it. Raise the size floor if it keeps happening on tiny files. |

## Debugging

`chrome://extensions` → Downpour → **service worker** opens the worker console.
Capture decisions are logged at `debug` level with the reason a download was
skipped; enable "Verbose" in the console filter to see them.

## Protocol

Implements `docs/rpc-protocol.md` (protocol version 1) — `GET /health`,
`GET /api/v1/capture`, `POST /api/v1/downloads`, `POST /api/v1/downloads/batch`,
`POST /api/v1/downloads/text`, all against `127.0.0.1` with the
`X-Downpour-Token` header.
