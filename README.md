<div align="center">

<img src="src-tauri/icons/128x128.png" alt="" width="96" height="96">

# Downpour

**A fast, modern download manager for Windows.**

Segmented multi-connection transfers, resume that refuses to corrupt your file,
batch link capture, overnight scheduling and bandwidth limits — in a native
desktop app that installs in a few seconds and needs no administrator rights.

[![CI](https://github.com/ali-kin4/downpour/actions/workflows/ci.yml/badge.svg)](https://github.com/ali-kin4/downpour/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ali-kin4/downpour?sort=semver)](https://github.com/ali-kin4/downpour/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D4)](https://github.com/ali-kin4/downpour/releases/latest)

</div>

<div align="center">

![Downpour running on Windows 11, showing seven downloads in various states](docs/images/screenshot.png)

</div>

---

## What it is

Downpour is a general-purpose download manager. You give it a link — or forty
links, or a page full of them — and it pulls each file down over several
connections at once, keeps a resumable record on disk so a dropped Wi-Fi
connection costs you seconds instead of gigabytes, and gets out of the way.

If you are here from IDM, the short pitch is: the parts you actually use —
segmented transfers, the browser hand-off with your cookies attached, category
folders, the scheduler, the tray — with an engine you can read, a test suite you
can run, and an MIT licence.

It is written in Rust. The engine that does the actual work is a standalone
crate with no idea a window exists, which is why it can be tested against
deliberately hostile HTTP servers instead of hoped about.

---

## Install

**Download `Downpour_x.y.z_x64-setup.exe` from the
[latest release](https://github.com/ali-kin4/downpour/releases/latest), run it,
and you are done.**

1. Open the [releases page](https://github.com/ali-kin4/downpour/releases/latest).
2. Under **Assets**, click the file ending in **`-setup.exe`**. It is about 4 MB.
3. Run it. **Windows will show a warning** — see the next paragraph, it is
   expected.
4. Click through the installer. **No administrator prompt appears**: Downpour
   installs into your own user folder (`%LOCALAPPDATA%\Downpour`), not into
   Program Files.
5. A **Downpour icon appears on your desktop**, and an entry appears in the Start
   menu and in Add or remove programs. Launch it from any of those.

### About that warning

The installer is **not code-signed** — a certificate costs money this project
does not have — so Microsoft Defender SmartScreen shows a blue panel saying
**"Windows protected your PC"** and offers only a **Don't run** button.

Click **More info**, then **Run anyway**.

That is a real warning and you should not be in the habit of clicking through
them. If you would rather verify than trust: every release ships a
`checksums.txt`, and

```powershell
Get-FileHash .\Downpour_0.1.0_x64-setup.exe -Algorithm SHA256
```

should match the line for your file. The installers are built by a GitHub
Actions runner from a tagged commit, and the build log is public.

Requires **64-bit Windows 10 or 11**. Nothing else — Windows 11 already has the
WebView2 runtime the window is drawn with, and on Windows 10 the installer
fetches it for you if it is missing. Idle memory use is around **30 MB** with the
window open.

Prefer an MSI for Group Policy or a managed deployment? The same release page
carries `Downpour_x.y.z_x64_en-US.msi`.

**Longer version — system requirements, where every file goes, how to change the
install folder, how to uninstall cleanly, and troubleshooting for SmartScreen,
antivirus false positives, port conflicts and corporate proxies:
[`docs/install.md`](docs/install.md).**

---

## Features

Everything in this list is implemented today. Things that are not are in
[Planned](#planned), and are not counted as features until they ship.

### Speed

- **Segmented downloads.** Each file is split across multiple connections — 8 by
  default, up to 16 — and written in place at their own offsets.
- **Real TCP connections, not HTTP/2 streams.** The most consequential line in
  the engine, and the reason segmentation actually does anything.
  [Why ↓](#why-it-is-fast)
- **Work-stealing between connections.** A connection that finishes early takes
  work from the busiest one instead of retiring, so the tail of a download does
  not crawl at 1/Nth of the achievable rate while the other connections idle.
- **Range support is proven, not assumed.** Downpour sends a real ranged request
  and believes only the response status. Plenty of servers and CDNs advertise
  `Accept-Ranges: bytes` and then hand back the whole file anyway; a downloader
  that trusts the advertisement writes a corrupt file that passes every length
  check.

### Reliability

- **Resume that verifies before it stitches.** Bytes go to `name.dpart` and the
  per-segment cursors to `name.dpmeta`, alongside the remote's `ETag` and
  `Last-Modified`. If those validators no longer match on resume, Downpour
  refuses to continue rather than splicing two different versions of a file into
  one plausible-looking, corrupt result.
- **Automatic retries** with a transient/fatal split: a reset connection is
  retried, a `404` is not.
- **Optional SHA-256 verification** against an expected `sha256:` digest,
  checked before the finished file is moved into place.
- **A crash-durable queue.** The download list lives in SQLite, so a reboot or a
  3 a.m. Windows update does not lose it.
- **No compression, ever.** `gzip`, `brotli` and `deflate` are all switched off
  at the client. A transfer-encoded body makes the byte arithmetic that ranged
  requests depend on ambiguous, and the payload is normally compressed already.

### Control

- **Global bandwidth limit** as a shared token bucket — "2 MB/s" means the app as
  a whole, not 2 MB/s per connection. Set it in Settings, or from the chip in the
  status bar.
- **Time-window scheduling**, including windows that cross midnight. A
  "weeknights 22:00–06:00" window that opened on Friday is still open at 02:00 on
  Saturday, which is the case most schedulers get wrong. Multiple named windows,
  per-day toggles, presets, and a badge telling you whether a window is open now
  or in how long.
- **A separate, lower speed limit inside scheduled windows**, so overnight
  downloads can be told to leave headroom.
- **Queue management**: concurrency cap (3 files at a time by default), move to
  top/bottom, force-start past the cap, pause/resume all, retry every failed
  item, clear completed.
- **When the queue finishes**: nothing, sleep, hibernate, shut down, or exit.
  These fire only on the transition from busy to idle, so opening the app with an
  empty queue can never shut your machine down. Shutdown arms Windows' own
  60-second countdown, which **Tools → Cancel pending shutdown** aborts; sleep
  and hibernate take effect immediately.

### Getting links in

- **Clipboard monitoring.** Copy a link anywhere and Downpour offers it, with
  one click to accept. Off by default. It never re-offers the same text, and it
  ignores links Downpour itself put on the clipboard, so "Copy source link" does
  not loop back into an offer. Optionally filtered to chosen file types, or set
  to add straight to the queue without asking.
- **Drag and drop.** Drag a link out of a browser onto the window, or drop a
  `.txt` full of them. A single link starts immediately; a batch lands in the
  list for review first.

- **Batch capture from pasted text.** Drop in a wall of text, or import a `.txt`
  file; Downpour extracts every http(s) URL, in the order you wrote them,
  deduplicated, coping with links embedded in prose and trailing sentence
  punctuation. The count is shown before you commit — "37 links found across 4
  sites" — so a paste that only found three links out of twenty cannot slip past
  you.
- **Add without starting.** Queue twenty links now and start them tonight; "not
  started" is a real state, not a paused download pretending.
- **Duplicate detection on add.** Before a single download starts, Downpour
  checks the URL against your history and the destination path, and tells you
  which of four things it found: it is already in the list (go to it), you
  downloaded it before and the file is still there (open it), you downloaded it
  before and the file is gone, or an unrelated file already occupies the name. It
  is advisory — every panel has an "add anyway" — and it is deliberately
  query-string-insensitive, because signed CDN links change every time.
- **A browser extension** that captures downloads out of Chrome and hands them
  over with their cookies attached. See [below](#browser-integration).

### The app itself

- **Checks a link before adding it.** The New Download dialog probes as you type
  and shows the real filename, the size, and whether the server will serve byte
  ranges at all — which is *why* a particular file ends up on one connection
  instead of eight.
- **Lives in the tray**, with a live tooltip (*"3 downloading at 12.4 MB/s"*) and
  pause-all / resume-all, because a downloader that quits when you close the
  window cannot honour a 2 a.m. schedule.
- **A compact, always-on-top progress panel** that appears when a transfer starts
  — current file, percentage, speed, ETA, queue counts, pause/resume — and closes
  itself a couple of seconds after the queue empties. Dismiss it permanently with
  the checkbox on the panel itself.
- **Desktop notifications** on completion and failure, and a **completion dialog**
  with Open, Show in folder and Copy link — shown only when nothing else is still
  running and the window is actually visible, so it never ambushes you mid-batch.
- **A command palette** on `Ctrl K` for every action, and for jumping straight to
  any download by name or URL. Plus a menu bar, `Ctrl N` / `Ctrl V` / `Ctrl ,` /
  `Ctrl A`, multi-select with bulk start/pause/remove/delete, and a per-row
  right-click menu.
- **A download list built for long queues**: virtualised rows, live search across
  filename *and* URL, sortable columns, **resizable columns** that remember their
  widths (double-click an edge to fit the content), and a **collapsible sidebar**
  with live status counts, file-type categories and the scheduler state.
- **Five accent themes**, **light and dark**, following Windows or pinned, with the Windows 11 Mica
  backdrop on the window chrome. Settings apply immediately — there is no Save
  button — and values the engine clamps are written back into the field so you
  can see it happen.

### Files

- **Sensible filenames.** `Content-Disposition` beats the URL path, which beats a
  fallback, and the result is sanitised for Windows' naming rules.
- **Sorting into category folders**, on by default, the way IDM does it: `Video`,
  `Music`, `Pictures`, `Documents`, `Compressed`, `Programs`. They are created
  inside your download folder on the **first run only** — folders you already
  have are reused and never touched, and one you delete on purpose does not come
  back on the next launch. Each folder and its extension list is editable, the
  whole thing can be switched off, and Settings can recreate any that go missing.
- **Conflict policy** per your preference: rename to `file (1).zip`, overwrite,
  or skip.

---

## Browser integration

**Included** in [`extension/`](extension/) as an unpacked Manifest V3
extension for Chrome, Edge, Brave, Opera and Vivaldi. Load the folder, paste the
pairing token from **Settings → Browser integration**, and downloads are handed
to Downpour instead of the browser.
[Full install and pairing guide →](extension/README.md)

It exists so the browser can hand over a download *with its request headers*
(`Cookie`, `Referer`, `User-Agent`). That is what stops a session-gated file from
arriving as 4 KB of login HTML, and it is the piece Manifest V3 removed when it
took away blocking `webRequest`.

What it does:

- **Captures downloads** as they start, subject to a capture switch, your
  per-site block/allow lists, and size and extension rules. If Downpour is not
  running, the browser download proceeds normally — the extension only cancels
  it *after* the hand-over is accepted, so closing the app can never cost you a
  file.
- **A bypass key.** Hold **Alt** (configurable, or off) while starting a download
  and that one file lands in the browser instead. Capture stays on for everything
  else.
- **A link grabber.** Right-click a page → *Grab links from this page…* and it
  collects every `<a href>`, image (including `srcset`), video and audio source,
  `<embed>`, `<object>` and visible CSS background image, then opens a picker:
  grouped by kind, filterable by kind, by extension and by text or regex, with
  select-all-shown / invert / per-group checkboxes and a live count. Nothing is
  queued until you press Send. Cookies for each link are attached automatically.
- **Send selected links.** Select text containing URLs anywhere, right-click, and
  the whole selection goes to the app, which does the extraction — one extractor,
  in one place, so the same selection always gives the same result.

The contract it is built on is specified and frozen in
[`docs/rpc-protocol.md`](docs/rpc-protocol.md): HTTP on `127.0.0.1` only — never
`0.0.0.0` — with every endpoint but `/health` requiring a 64-character token you
pair once, compared in constant time, and CORS reflected only for extension
origins.

---

## Why it is fast

Not because of a trick. Downpour is fast for one structural reason, one bug that
was found and fixed, and one piece of scheduling.

### It forces HTTP/1.1, and that is the whole ballgame

This is the most interesting thing in the codebase, and it started as a bug.

Over TLS, ALPN negotiates HTTP/2 with essentially every CDN and release host.
`reqwest` then **multiplexes every concurrent request to an origin onto a single
TCP connection**. So a 16-way segmented download was opening sixteen *streams
inside one connection* — sixteen requests, sixteen sets of overhead, and all of
them sitting in the same per-connection shaping bucket that segmentation exists
to escape. The headline mechanism was simply not happening.

It was worse than neutral. hyper's HTTP/2 connection window defaults to 5 MiB and
`reqwest` leaves adaptive windowing off, so the entire transfer was capped at
roughly one window per round trip — about **420 Mbit/s at 100 ms RTT**, no matter
how many segments were planned. That ceiling is invisible on a LAN or against a
nearby CDN edge, which is exactly why it is easy to benchmark and miss.

The fix is one line, `.http1_only()` in
[`transfer.rs::build_client`](crates/downpour-core/src/transfer.rs). Each segment
now gets its own socket, its own kernel receive buffer, its own autotuned receive
window, its own congestion window, and — the point of the exercise — its own slot
in whatever per-connection token bucket the origin runs. HTTP/2's real advantages
(header compression, no head-of-line blocking across many small requests) are
worth nothing to a client fetching a handful of very large byte ranges.

It is guarded by a test, because nothing user-visible breaks when it regresses —
downloads just quietly get slower. `tests/protocol_probe.rs` asserts against real
public hosts that every response comes back `HTTP/1.1`, including four concurrent
ranged requests to the same origin. It needs the network, so it is `#[ignore]`d
by default rather than run in CI:

```bash
cargo test -p downpour-core --test protocol_probe -- --ignored --nocapture
```

The full write-up, including the measurement plan and the eight other things that
were investigated and mostly rejected, is in
[`docs/research/throughput.md`](docs/research/throughput.md).

### Several connections instead of one

With real connections restored, the structural reason works again: many servers
rate-limit per connection rather than per client. Requesting eight byte ranges in
parallel and writing them into their own offsets of the same file often
multiplies throughput on exactly the hosts where a single stream feels
artificially slow.

### No slow tail

The naive version of segmented downloading splits a file into N equal parts and
waits for all of them. Real connection speeds differ by an order of magnitude, so
the last stretch regularly runs at 1/Nth of the achievable rate while N−1
connections sit idle. Downpour instead lets a finished worker *steal*: it finds
the segment with the most bytes outstanding, halves it, and takes the tail; the
donor notices its end boundary moved and stops early. Work keeps redistributing
until no remaining piece is big enough to be worth splitting, which keeps every
connection busy right up to the last byte.

### And the honest part

**No client can make a server send data faster than it is willing to, or make
your link wider than it is.** If a host caps you at 1 MB/s across all
connections, or your line is already saturated, Downpour will be exactly as fast
as everything else. What it removes is the *client-side* waste — the idle
connections at the end of a transfer, the restart-from-zero after a dropped
socket, the single stream against a per-connection cap, the invisible protocol
ceiling described above. On some downloads that is a large multiple; on others it
is nothing at all, and any tool that promises you otherwise is guessing.

Two limits worth knowing before you install:

- Downpour reads proxy settings from the `HTTPS_PROXY` / `HTTP_PROXY` /
  `NO_PROXY` environment variables only — not from Internet Options, and not
  from a PAC script.
- Its TLS trust comes from a bundled Mozilla root store, not the Windows
  certificate store. **Behind a corporate TLS-inspecting proxy, downloads will
  fail with a certificate error** even though the same URL works in your browser,
  and there is no setting that fixes it today. Details and workarounds in
  [`docs/install.md`](docs/install.md#downloads-fail-behind-a-corporate-proxy).

---

## Media pages

Downpour can download from video pages — and it is worth being precise about how,
because the honest version of this feature is a small one.

**It is not a "YouTube downloader".** It is a download manager that can ask
[yt-dlp](https://github.com/yt-dlp/yt-dlp) what a page offers, take the direct
media URL and the headers that URL needs, and then fetch it through the same
segmented, resumable, schedulable engine as everything else. yt-dlp is used as a
*metadata source*, not as a downloader, which is why a video gets connections,
work-stealing, the queue, the speed limit and the tray like any other file.

**yt-dlp is never bundled, vendored, mirrored or silently installed.** The rules
the code enforces:

- It is fetched only from the **official GitHub releases API**, and only from the
  `browser_download_url` of an asset in that release.
- It is fetched only **after you click a button** that has already told you what
  will be downloaded, from where, and where it will be saved. There is no
  install-on-startup and no automatic retry; the install function is unreachable
  from any other code path.
- The download is **verified against the `SHA2-256SUMS` manifest published in the
  same release** before it goes near the real path, let alone gets executed. A
  missing manifest, or one with no line for the exact asset, **fails the install**
  — the code fails closed rather than skipping the check.
- It is written to a `.part` file and renamed into place only after the hash
  matches, so an interrupted install leaves nothing runnable behind.
- It lands in one place, `…\com.alikin4.downpour\tools\yt-dlp.exe`. Deleting that
  single file uninstalls it completely.

**ffmpeg is never fetched at all**, and that has a visible cost. Combining a
separate video stream and audio stream needs ffmpeg, so by default the quality
picker shows only *progressive* formats — the ones with sound already in them. On
YouTube that often means 360p, and on HLS-only sites it means an empty list. The
dialog says so in plain words rather than looking broken, and an **All formats**
toggle shows everything, with a warning before you pick a video-only stream.
Downpour will not silently hand you a 1080p file with no audio.

Signed media URLs expire in minutes to hours, which is the design's main failure
mode: a media download left paused overnight can come back with a `403` rather
than the rest of the file, and has to be re-added from the page.

The full design, including what is deliberately not built and why,
is in [`docs/media.md`](docs/media.md).

---

## Planned

Clearly not built yet. Listed so you know where this is going, not as a promise
of a date.

- **A command-line interface.** The `downpour-cli` crate exists, declares a
  `downpour` binary, and its `main` is empty. It does nothing at all today.
- **Per-download bandwidth limits.** The limit is global today.
- **Code signing**, which is what would remove the SmartScreen warning.
- **Re-resolving expiring media URLs on resume**, which needs a field the engine
  does not carry yet.
- **Torrent and magnet links are not supported and are not planned.** Downpour is
  an HTTP(S) download manager; BitTorrent is a different protocol and a different
  program.
- **macOS and Linux builds.** The engine is portable Rust and its tests pass
  anywhere, but the desktop shell is neither built nor tested off Windows, and
  nothing is promised.

---

## Build from source

You need [Rust](https://rustup.rs/) (stable; the workspace MSRV is 1.82),
[Node 22](https://nodejs.org/), and the Tauri v2 prerequisites for Windows
(Visual Studio Build Tools with the "Desktop development with C++" workload, and
the WebView2 runtime — already present on Windows 11).

```bash
git clone https://github.com/ali-kin4/downpour.git
cd downpour

npm ci                      # frontend dependencies
cargo install tauri-cli --version "^2" --locked

cargo tauri dev             # run with hot reload
cargo tauri build           # produce the MSI and the NSIS installer
```

`cargo tauri build` writes both installers under `target/release/bundle/`:
`msi/Downpour_0.1.0_x64_en-US.msi` and `nsis/Downpour_0.1.0_x64-setup.exe`.

To work on the engine alone, no frontend or window required:

```bash
cargo test -p downpour-core
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development setup, including
one gotcha: `cargo test --workspace` needs a `dist/` directory to exist before
the desktop crate will compile, and `dist/` is gitignored.

---

## How it works

```
crates/downpour-core/     the engine — no UI, no Tauri, no window
  probe.rs                size, range support, validators, suggested filename
  transfer.rs             segmented download, work-stealing, the HTTP client
  resume.rs               the .dpart / .dpmeta sidecar and its validator checks
  engine.rs               queue, concurrency cap, scheduling, event stream
  scheduler.rs            time windows, including the midnight-crossing case
  throttle.rs             the shared token bucket
  store.rs                SQLite persistence
  naming.rs               filename derivation and Windows sanitisation

crates/downpour-cli/      a thin CLI over the same engine (a stub today)
src-tauri/                the desktop shell — tray, notifications, power
                          actions, the loopback RPC listener, media pages
src/                      the frontend (Vite + React + TypeScript + Tailwind)
extension/                the browser extension (plain JS, no build step)
docs/rpc-protocol.md      the frozen local RPC contract, v1
docs/media.md             the yt-dlp design and its legal constraints
docs/research/throughput.md   what actually makes an HTTP download faster
```

The split is deliberate. `downpour-core` is `#![forbid(unsafe_code)]`, owns every
state transition in a single background pump, and exposes the same API to the
desktop app, the CLI and the test suite. That is what makes it possible to test
the hard parts — segmentation, resume, scheduling — against a local HTTP server
that lies about range support, drops connections mid-body and changes files
underneath a resume, all without opening a window.

`cargo test --workspace` runs **189 tests**, 177 of them in the engine (129 unit,
31 engine-integration, 17 transfer-integration) and 12 in the desktop shell. One
further test, the HTTP/1.1 guard described [above](#why-it-is-fast), needs the
public internet and is ignored by default.

---

## Contributing

Bug reports, especially ones with a reproducible URL or host, are genuinely
useful — most download bugs are really server-behaviour bugs, and the ones that
matter are the ones nobody thought to simulate.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). By taking part you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

---

## Security

The app runs an authenticated HTTP listener bound to `127.0.0.1` so the browser
extension can reach it. That is the most security-relevant surface in the
application, and reports about it are firmly in scope — if you find a way around
the authentication, past the CORS policy, or onto any other interface, please
report it privately through
[GitHub Security Advisories](https://github.com/ali-kin4/downpour/security/advisories/new)
rather than opening a public issue.

Full policy, including the properties the listener is required to hold and what
is explicitly out of scope: [SECURITY.md](SECURITY.md).

---

## Licence

[MIT](LICENSE) © ali-kin4

Downpour downloads what you point it at. What you are allowed to download is
between you, the site's terms, and the law where you live.
