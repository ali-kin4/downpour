# Downpour browser extension

A Manifest V3 extension that hands your browser's downloads to the **Downpour**
desktop app — **with the cookies, referer and user-agent the browser would have
sent**, so session-gated files download as the file and not as a login page.

It also grabs every downloadable link off a page and lets you pick through them
before anything is queued.

Plain JavaScript. No build step, no bundler, no npm dependencies. What is in
this folder is what runs.

---

## Contents

1. [Install it](#1-install-it)
2. [Pair it with the app](#2-pair-it-with-the-app)
3. [What it does](#3-what-it-does)
4. [Permissions, and why each one is needed](#4-permissions-and-why-each-one-is-needed)
5. [Troubleshooting](#5-troubleshooting)
6. [For developers](#6-for-developers)

---

## 1. Install it

Works in Chrome, Edge, Brave, Opera and Vivaldi — anything Chromium 102 or
newer. (Firefox is not supported yet; see [For developers](#6-for-developers).)

There is nothing to compile and nothing to download from a store. You are
loading this folder directly into the browser.

**Step 1 — install and run the Downpour app first.**
Start it at least once so it can generate your pairing token. Leave it running.

**Step 2 — find this folder on your computer.**
It is the `extension` folder inside the Downpour source. It must contain a file
called `manifest.json`. If you are looking at a folder that contains
`manifest.json`, you are in the right place.

**Step 3 — open the browser's extensions page.**
Type one of these into the address bar and press Enter:

| Browser | Address |
|---|---|
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Opera / Vivaldi | `opera://extensions` / `vivaldi://extensions` |

**Step 4 — turn on Developer mode.**
It is a switch in the **top-right** corner of that page (in Edge it is on the
**left**, near the bottom of the sidebar). Turn it on. Three new buttons appear.

**Step 5 — click "Load unpacked".**
A folder picker opens. Select the `extension` folder from Step 2 — select the
folder itself, do not go inside it and pick `manifest.json`.

**Step 6 — the settings page opens by itself.**
On a first install the extension opens its own settings page so you can pair it.
Keep that tab open; you need it for Section 2.

**Step 7 — pin the toolbar icon (recommended).**
Click the jigsaw-piece **Extensions** button in the toolbar, find **Downpour**,
and click the pin next to it. The icon is how you reach the popup and how the
extension tells you when something is wrong.

> **A note about the warning.** Chrome will show "Disable developer mode
> extensions" on startup, and the extensions page will say the extension was
> "loaded unpacked". Both are normal for an extension installed this way, not a
> sign that anything is broken.

> **Keep the folder where it is.** The browser loads it from that path every
> time it starts. If you move or delete the folder, the extension stops
> working. If you update Downpour and the folder's contents change, go back to
> `chrome://extensions` and press the ↻ **reload** arrow on the Downpour card.

---

## 2. Pair it with the app

The app listens on your own machine only (`127.0.0.1`), on the first free port
in the range **47113–47123**, and everything except the "are you there?" check
requires a secret token. Without that token, any web page you visit could queue
downloads into your app — so pairing is not optional.

**Step 1 — copy the token from Downpour.**
In the Downpour app: **Settings → Browser integration**. There is a
64-character token there. Copy it.

**Step 2 — paste it into the extension.**
On the extension's settings page (Downpour toolbar icon → **Settings**), paste
it into **Pairing token** and press **Save token**.

**Step 3 — press "Test connection".**
It reports two things separately, because they fail for completely different
reasons and need completely different fixes:

- **1/2 App reachable** — the extension found the app and which port it is on.
  If this fails, the app is not running, or something is stopping it from
  opening a port.
- **2/2 Authentication** — the app accepted your token. If this fails while
  1/2 passed, the app is running fine and the token is simply wrong: copy it
  again, or regenerate it in the app and paste the new one.

Regenerating the token in the app invalidates the old one immediately. The
extension then shows a red `!` on its toolbar badge and stops sending anything
until you re-pair. It never retries a rejected token in a loop.

**The extension talks to nothing except `http://127.0.0.1:<port>`.** No
telemetry, no remote servers, no analytics. Your cookies go to the app on your
own machine and nowhere else.

---

## 3. What it does

### Download capture

When you start a download in the browser, the extension checks the capture
rules and — if the download qualifies — sends the URL plus its headers to the
app, then cancels the browser's own copy.

> **If Downpour is not running, nothing is cancelled and nothing is lost.**
> The order is deliberate: send first, cancel only after the app has confirmed
> it accepted the download. If the app is closed, the send fails, the browser's
> download carries on untouched, and the popup says "Downpour is not running".
> Losing a file because the app was closed is not an acceptable failure, so the
> ordering is never reversed.

Which downloads qualify is decided by, in order:

1. **The capture switch** in the popup. Off means off.
2. **The bypass key** (below) — a per-download escape hatch.
3. **Per-site rules** (below) — your blocklist and allowlist, plus the list of
   excluded hosts the app itself reports.
4. **Size and extension rules** — either the app's, or your browser-side
   overrides, whichever the settings page is set to.

A download whose size the browser does not know yet is **never** filtered out
by the size floor. At the moment capture has to decide, the size is genuinely
unknown for a large share of real downloads, and treating "unknown" as "too
small" would skip almost everything.

### The bypass key — let one download through

Sometimes you want a single file to land in the browser: a small file you are
about to open, a login-protected page that behaves oddly, a site whose
downloads Downpour handles badly.

**Hold the bypass key while starting the download.** The default is
**Alt**. The extension notices the key was held within about two seconds of the
download starting, and stays out of the way for that one download only. Capture
stays on for everything else.

You can change the key — Alt, Ctrl/Cmd or Shift — or switch the bypass off entirely,
on the settings page under **Bypass key**. The popup always shows which key is
currently configured, so you never have to remember.

Alt is the default because Chrome already treats **Alt+click** on a link as
"download this". So Alt+click reads naturally as "download it here, in the
browser". Ctrl+click and Shift+click already mean "open in a new tab" and "open
in a new window" to Chrome, so if you pick one of those, hold it while starting
a download some other way (a download button, a right-click → Save as…). On
macOS, **Cmd** counts as Ctrl.

How it works, in case you are wondering why a page-level script is involved: a
tiny script watches for the modifier keys and tells the extension "Alt was held
at 12:03:44". Nothing else. See the permissions table.

### Grab links from this page

This is the big one. It finds everything downloadable on a page and shows you a
picker **before anything is queued**.

Start it from the Downpour popup (**Grab links from this page…**) or by
right-clicking the page and choosing **Grab links from this page…**. A new tab
opens with everything it found.

It collects from:

- every `<a href>` link,
- every `<img>`, including all the alternatives in `srcset`,
- `<video>` and `<audio>` sources, including their `<source>` children and
  video poster images,
- `<embed>` and `<object>`,
- CSS `background-image` on elements that are actually visible.

Everything is turned into a full absolute address, duplicates are merged, and
`data:`, `blob:` and `javascript:` addresses are dropped — the app cannot fetch
those. Where a link has visible text or an image has `alt` text, that is shown
as its label.

In the picker you can:

- **See everything grouped** by Video, Audio, Images, Archives, Documents,
  Programs and Other. Each group shows how many it holds.
- **Filter by kind** with the buttons across the top.
- **Filter by extension** with the dropdown — every extension found on the page
  is listed with a count, so "only the .mp4s" is one click.
- **Filter by text**, matching the address and the label. Tick **Regex** to
  type a regular expression instead. A half-typed, invalid expression shows an
  error and leaves the list alone rather than emptying it.
- **Select all shown**, **Select none**, **Invert shown**, or tick a whole
  group with the checkbox in its heading. "Select all shown" respects your
  filters — it never quietly selects the things you filtered out. "Select none"
  is the panic button and clears everything.
- Watch the **running count** of what is selected against what is shown.

Then choose what happens:

- **Add to queue** (the default) puts them in Downpour without starting them —
  the sane choice for forty links.
- **Start now** starts them immediately.

Press **Send to Downpour**. Cookies for each link are attached automatically, so
links behind a login still work. Whatever was just sent is unticked, so pressing
Send twice cannot queue anything twice.

If the app is not running when you press Send, nothing is queued, the list stays
exactly as it is, and you can start the app and press Send again.

The list lives only for the current browser session. Close the browser and the
grabber tab has nothing to show — run the grab again.

There is also a plain **Download all links on this page** in the right-click
menu, which skips the picker and queues every `<a href>` without starting them.

### Send selected links

Select some text containing links — an email, a forum post, a list you pasted
somewhere — right-click it, and choose **Send selected links to Downpour**.

The whole selection is sent to the app as text, and **the app** picks the
addresses out of it. The extension deliberately does not do its own parsing:
one extractor, in one place, means the same selection always gives the same
result no matter how you sent it.

Links found this way are added to the queue without starting.

### Per-site rules

Two lists, on the settings page under **Per-site rules**:

- **Never capture from these sites** — downloads from these hosts always stay
  in the browser.
- **Only capture from these sites** — leave it empty for normal behaviour. Put
  anything in it and capture runs *only* on those sites and nowhere else.

One host per line (pasting a full address is fine — it is reduced to the host
and shown back to you). Subdomains are included: `example.com` also covers
`files.example.com`.

**Both the download's own host and the page it came from are checked.** Plenty
of sites serve their files from a separate download domain, and a rule that
only looked at the file's address would appear broken every time.

For the site you are on right now, the popup has a **Never capture from this
site** switch — one click, no typing. It adds and removes entries in the
blocklist above.

The app's own list of excluded hosts (from its settings) is honoured too, and
it is honoured **whether or not** you have the extension set to follow the
app's rules. A host the app refuses to handle is not worth sending to it. The
capture settings are therefore read from the app roughly every 30 seconds
either way.

### The popup

Click the toolbar icon:

- **Connection status** — connected and on which port, not running, not paired,
  or token rejected.
- **Capture downloads** — the master switch.
- **The bypass hint** — which key to hold to let one download through.
- **Never capture from this site** — a per-site switch for the tab you are on.
- **Grab links from this page…**
- **Open Downpour** — brings the app's window to the front.
- **Settings** and **Re-check connection**.

### The settings page

Pairing token and connection test, the capture switch, the bypass key, the
per-site rules, and a choice between the app's capture rules and browser-side
ones (size floor, only-these extensions, never-these extensions, never-these
hosts).

---

## 4. Permissions, and why each one is needed

Chrome shows a scary list when you install any extension. Here is exactly what
each entry is for, and what it is *not* used for.

| Permission | Why it is needed |
|---|---|
| `downloads` | The whole point. Needed to see a download starting (`downloads.onDeterminingFilename`), to take it away from the browser once Downpour has accepted it (`downloads.cancel`) and to tidy the cancelled entry off the download shelf (`downloads.erase`). |
| `cookies` | To read the cookies that apply to a download's address — including `httpOnly` session cookies, which page scripts are not allowed to see — and send them as a `Cookie` header. Without this, a large share of real downloads come back as a login page and "succeed" at a few KB of HTML. This is the single reason the extension exists rather than a "copy the link and paste it" workflow. |
| `storage` | Holds your pairing token, your preferences, the discovered port, the cached capture rules, and (for the current browser session only) the grabbed link list and the modifier-key timestamps. An MV3 service worker is shut down whenever the browser feels like it, so anything that must survive has to be written down. |
| `contextMenus` | The four right-click entries. |
| `scripting` | Runs a one-off function inside a page, only at the moment you ask for it: the link collector for "Grab links", the `href` reader for "Download all links", and reading the full selected text for "Send selected links" (the right-click menu itself only hands over a truncated copy of your selection). |
| `activeTab` | Lets the popup see the address of **the tab whose toolbar button you just clicked**, and nothing else. That address is what "Never capture from this site" needs to know which site you mean, and what tells the popup whether "Grab links" can work on this page at all. This is the narrowest permission that does the job — it grants nothing until you click the icon, and nothing about any other tab. |
| `host_permissions: <all_urls>` | Two things. (1) `chrome.cookies.getAll({url})` returns cookies for a host only if the extension has permission for that host — and a download can come from anywhere, so the set cannot be narrowed ahead of time. (2) It covers `http://127.0.0.1:47113–47123`, which is how the extension reaches the app. Cookies are read **only** for a URL actually being downloaded or grabbed, and are sent **only** to `127.0.0.1`. |
| A content script on every http/https page (`modifier-keys.js`) | **The bypass key.** The extension has to already know that Alt was held at the moment a download starts — by the time it knows a download is happening, the click has long since happened, so there is nothing to hang a just-in-time injection off. This file is about sixty lines and does exactly one thing: it listens for `keydown`, `keyup`, `mousedown` and `auxclick` on the window, and when a modifier key is held it sends the extension three true/false values and a timestamp. It never reads the page, never reads its content, never touches cookies, never makes a network request and never changes anything you can see. It sends nothing at all unless a modifier key is actually down, and no more than a few messages a second while one is. If you would rather not have it at all, set the bypass key to **Nothing** in settings — it then reports nothing that is ever acted on. |

**Deliberately not requested:** `tabs` (`activeTab` covers what the popup needs
and `tabs.create` needs no permission at all), `notifications` (status goes on
the toolbar badge and in the popup), `webRequest` (removed as a blocking API in
MV3, which is the reason this whole app-plus-extension design exists) and
`alarms` (every expiry here is a timestamp comparison made when the value is
read, because timers do not survive the service worker shutting down).

**Web accessible resources:** none. No web page can reach any file in this
extension.

---

## 5. Troubleshooting

| Symptom | What is going on |
|---|---|
| The popup says **"Downpour is not running"** | The app is closed, or nothing answered on ports 47113–47123. Your downloads keep working in the browser; start the app and press **Re-check connection**. |
| Badge shows a red **`!`** and "Token invalid" | The token was regenerated in the app. Copy the new one from **Settings → Browser integration** and paste it in again. |
| Badge shows an amber **`?`** | No token saved yet. Open Settings and pair. |
| **Nothing is captured** | Work down the list: is the capture switch on in the popup? Is this site on your "never capture" list? Do you have an "only capture from these sites" list that does not include it? Then the size and extension rules — an include list that does not mention the extension, or an excluded host. |
| **Everything is captured except one site** | Check the popup's "Never capture from this site" switch for that site, and the app's own excluded-hosts list — that one applies even when the extension is using browser-side rules. |
| **The bypass key does nothing** | Hold it *before and during* the click that starts the download, and make sure the browser window has focus. It is remembered for about two seconds. If the page was opened before you last reloaded the extension, reload the page — the watcher script is only injected into pages loaded after the extension started. |
| **Alt+click downloads things I did not want** | That is Chrome's own behaviour, not the extension's: Alt+click on a link has always meant "download it". Change the bypass key to Ctrl or Shift in settings if you keep hitting it. |
| **"Cannot read this page"** on Grab links | Chrome forbids extensions on `chrome://` pages, the Chrome Web Store, and the built-in PDF viewer. Nothing can be done about it from inside an extension. |
| **Grab links found nothing** | The page builds its content after loading, and had not finished. Let it finish loading (scroll to the bottom of an infinite-scroll page) and grab again. |
| **The grabber tab says the list has expired** | The list is only kept for the current browser session. Run the grab again. |
| **A file downloaded twice** | The browser finished its own copy before the app confirmed it had taken over. The extension tells you rather than hiding it. It only happens on files small enough to finish in a fraction of a second. |
| **The extension vanished after restarting the browser** | The folder was moved, renamed or deleted. Put it back and **Load unpacked** it again. |
| **Everything worked, then stopped after an update** | Go to `chrome://extensions` and press the ↻ reload arrow on the Downpour card. |

If something failed and you dismissed the message before reading it, open the
popup — errors stay visible until you click them away.

---

## 6. For developers

### Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. |
| `background.js` | Service worker: port discovery, the API client, capture decisions, header collection, context menus, the link collector and every message handler. All protocol knowledge lives here and nowhere else. |
| `modifier-keys.js` | The only declared content script. Reports held modifier keys and nothing else. |
| `popup.html` / `popup.js` | The toolbar popup. |
| `options.html` / `options.js` | The settings page. |
| `grabber.html` / `grabber.js` | The link picker, opened in a tab. |
| `styles.css` | Shared styling for all three pages. |

### Why the picker is its own page

Not a popup: a 320px popup cannot host a filterable list of 400 links, and it
closes the moment focus moves. Not an injected overlay: that inherits the host
page's CSS resets, z-index wars and `!important` rules, and would have to be
defended against every site on the internet. An extension page has its own
origin, its own stylesheet, and nothing to fight with.

The collected list is handed over through `chrome.storage.session` rather than a
message, because the service worker can be killed between opening the tab and
the tab asking for its data.

### Service worker rules

The worker is killed aggressively. Consequently: every `chrome.*` listener is
registered synchronously at the top level of `background.js`; anything that must
survive is in `chrome.storage.local` (settings, token, port) or
`chrome.storage.session` (grabs, modifier timestamps); module-scope variables
are caches that every read path must work without; and there are no timers for
expiry, only timestamp comparisons made when a value is read.

### Validate a change

```sh
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json'))"
node --check extension/background.js
node --check extension/modifier-keys.js
node --check extension/popup.js
node --check extension/options.js
node --check extension/grabber.js
```

Then `chrome://extensions` → Downpour → ↻, and **service worker** to open the
worker console. Capture decisions are logged at `debug` level with the reason a
download was skipped — turn on "Verbose" in the console's level filter to see
them.

### Protocol

Implements `docs/rpc-protocol.md`, protocol version 1, against `127.0.0.1` with
the `X-Downpour-Token` header:

| Endpoint | Used for |
|---|---|
| `GET /health` | Finding the app and its port; the first leg of the connection test. |
| `GET /api/v1/capture` | Capture rules, cached ~30s. Also the second (authenticated) leg of the connection test. |
| `POST /api/v1/downloads` | One captured download, or one right-clicked link. |
| `POST /api/v1/downloads/batch` | The link grabber and "download all links". Chunked so no request exceeds either the 256 KB body cap or the 500-item cap. |
| `POST /api/v1/downloads/text` | The selected-text menu item. The app does the URL extraction. |
| `POST /api/v1/show` | "Open Downpour" — brings the app window to the front. |

`POST /api/v1/show` replaced an earlier attempt to navigate to a `downpour://`
URL. That scheme was never registered by the app, so the button silently did
nothing; the endpoint is authenticated and reports "not running" and "bad token"
through the same paths as every other call, so the popup can now say why.

### Firefox

Not supported yet: it uses `browser.*` and a different `onDeterminingFilename`
story. The protocol already allows `moz-extension://` origins, so a port is
possible later.
