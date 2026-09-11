<div align="center">

# Downpour

**A fast, modern download manager for Windows.**

Segmented multi-connection transfers, resume that refuses to corrupt your file,
batch link capture, overnight scheduling and bandwidth limits — in a native
desktop app that installs in a few seconds.

[![CI](https://github.com/ali-kin4/downpour/actions/workflows/ci.yml/badge.svg)](https://github.com/ali-kin4/downpour/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ali-kin4/downpour?sort=semver)](https://github.com/ali-kin4/downpour/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D4)](https://github.com/ali-kin4/downpour/releases/latest)

</div>

<!--
SCREENSHOT REQUIRED BEFORE THIS REPO GOES PUBLIC.

Add a real screenshot of the running app at docs/images/screenshot.png and
delete this comment. Do not ship a mockup, a render, or a placeholder image —
a README whose screenshot does not match the app is worse than one with no
screenshot at all. Then un-comment the line below:

![Downpour](docs/images/screenshot.png)
-->

---

## What it is

Downpour is a general-purpose download manager. You give it a link — or forty
links, or a page full of them — and it pulls each file down over several
connections at once, keeps a resumable record on disk so a dropped Wi-Fi
connection costs you seconds instead of gigabytes, and gets out of the way.

It is written in Rust. The engine that does the actual work is a standalone
crate with no idea a window exists, which is why it can be tested against
deliberately hostile HTTP servers instead of hoped about.

## Install

**The short version: download `Downpour_x.y.z_x64-setup.exe` from the
[latest release](https://github.com/ali-kin4/downpour/releases/latest), run it,
and you are done.**

1. Open the [releases page](https://github.com/ali-kin4/downpour/releases/latest).
2. Under **Assets**, click the file ending in **`-setup.exe`**.
3. Run the downloaded file and follow the installer.
4. Launch Downpour from the Start menu.

Windows SmartScreen may warn you the first time, because the installer is not
code-signed yet. Click **More info → Run anyway** if you are comfortable doing
so, or verify the checksum first (below).

Prefer an MSI for Group Policy or a managed deployment? The same release page
carries `Downpour_x.y.z_x64_en-US.msi`.

Requires 64-bit Windows 10 or 11. Nothing else — the app is a few megabytes and
uses the WebView2 runtime that Windows 11 already includes.

<details>
<summary><b>Verifying the download</b></summary>

Every release includes a `checksums.txt` in `sha256sum` format. To check the
file you downloaded, in PowerShell:

```powershell
Get-FileHash .\Downpour_0.1.0_x64-setup.exe -Algorithm SHA256
```

Compare the result with the matching line in `checksums.txt`.

</details>

## Features

Everything in this list is implemented today. Things that are not, are in
[Planned](#planned) — and are not counted as features until they ship.

**Speed**

- **Segmented downloads.** Each file is split across multiple connections
  (8 by default, up to 32) and reassembled in place.
- **Work-stealing between connections.** A connection that finishes early takes
  work from the busiest one instead of retiring, so the tail of a download does
  not crawl. [Why that matters ↓](#why-it-is-fast)
- **Range support is proven, not assumed.** Downpour sends a real ranged request
  and believes only the response status. Plenty of servers and CDNs advertise
  `Accept-Ranges: bytes` and then hand back the whole file anyway; a downloader
  that trusts the advertisement writes a corrupt file that passes every length
  check.

**Reliability**

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

**Control**

- **Global bandwidth limit** as a shared token bucket — "2 MB/s" means the app
  as a whole, not 2 MB/s per connection.
- **Time-window scheduling**, including windows that cross midnight. A
  "weeknights 22:00–06:00" window that opened on Friday is still open at 02:00
  on Saturday, which is the case most schedulers get wrong.
- **A separate, lower speed limit inside scheduled windows**, so overnight
  downloads can be told to leave headroom.
- **Queue management**: concurrency cap, move to top/bottom, force-start past
  the cap, pause/resume all, retry every failed item.

**Getting links in**

- **Batch capture from pasted text.** Drop in a wall of text, a `.txt` file, or
  a clipboard full of links; Downpour extracts every http(s) URL, in the order
  you wrote them, deduplicated, and it copes with links embedded in prose. The
  count is shown before you commit, so a paste that only found three links out
  of twenty cannot slip past you.
- **Add without starting.** Queue twenty links now and start them tonight;
  "not started" is a real state, not a paused download pretending.
- **A browser extension** that captures downloads out of Chrome and hands them
  over with their cookies attached. See [below](#browser-integration).

**The app itself**

- **Checks a link before adding it.** The New Download dialog probes as you
  type and shows the real filename, the size, and whether the server will even
  serve byte ranges — which is *why* a particular file ends up on one
  connection instead of eight.
- **Lives in the tray**, with a live tooltip and pause/resume, because a
  downloader that quits when you close the window cannot honour a 2 a.m.
  schedule.
- **Desktop notifications** on completion and failure, and a completion dialog
  with Open / Show in folder / Copy link when a single download finishes.
- **When the queue finishes**: nothing, sleep, hibernate, shut down, or exit.
  The destructive ones arm a 60-second countdown you can cancel, and they fire
  only on the transition from busy to idle — opening the app with an empty
  queue can never shut your machine down.
- **A command palette** on `Ctrl K` for every action, plus a menu bar,
  multi-select with bulk actions, sortable columns, and a right-click menu.
- **Light and dark**, following Windows or pinned, with the Windows 11 Mica
  backdrop on the window chrome.

**Files**

- **Sensible filenames.** `Content-Disposition` beats the URL path, which beats a
  fallback, and the result is sanitised for Windows' naming rules.
- **Sorting into category folders**, on by default, the way IDM does it:
  `Video`, `Music`, `Pictures`, `Documents`, `Compressed`, `Programs`. They are
  created inside your download folder on the **first run only** — folders you
  already have are reused and never touched, and one you delete on purpose does
  not come back on the next launch. Each folder and its extension list is
  editable, and the whole thing can be switched off.
- **Conflict policy** per your preference: rename to `file (1).zip`, overwrite,
  or skip.

## Browser integration

**Included** in [`extension/`](extension/) as an unpacked Manifest V3
extension: load it in Chrome, paste the pairing token from
**Settings → Browser**, and downloads are handed to Downpour instead of the
browser. If Downpour is not running, the browser download proceeds normally —
the extension only cancels it *after* the hand-over is accepted, so closing the
app can never cost you a file.

The contract it is built on is specified and frozen in
[`docs/rpc-protocol.md`](docs/rpc-protocol.md): HTTP on `127.0.0.1` only — never
`0.0.0.0` — with every endpoint but `/health` requiring a 64-character token you
pair once.

It exists so the browser can hand over a download *with its request headers*
(`Cookie`, `Referer`, `User-Agent`). That is what stops a session-gated file from
arriving as 4 KB of login HTML, and it is the piece Manifest V3 removed when it
took away blocking `webRequest`.

## Why it is fast

Not because of a trick. Downpour is fast for one structural reason and one
engineering reason.

**Several connections instead of one.** Many servers rate-limit per connection
rather than per client. Requesting eight byte ranges in parallel and writing
them into their own offsets of the same file often multiplies throughput on
exactly the hosts where a single stream feels artificially slow.

**No slow tail.** The naive version of segmented downloading splits a file into
N equal parts and waits for all of them. Real connection speeds differ by an
order of magnitude, so the last stretch of the download regularly runs at 1/Nth
of the achievable rate while N−1 connections sit idle. Downpour instead lets a
finished worker *steal*: it finds the segment with the most bytes outstanding,
halves it, and takes the tail; the donor notices its end boundary moved and
stops early. Work keeps redistributing until no remaining piece is big enough to
be worth splitting, which keeps every connection busy right up to the last byte.

**And the honest part.** No client can make a server send data faster than it is
willing to, or make your link wider than it is. If a host caps you at 1 MB/s
across all connections, or your line is saturated, Downpour will be exactly as
fast as everything else. What it removes is the *client-side* waste — the idle
connections, the restart-from-zero after a dropped socket, the single stream
against a per-connection cap. On some downloads that is a large multiple; on
others it is nothing at all, and any tool that promises you otherwise is
guessing.

## Planned

Clearly not built yet. Listed so you know where this is going, not as a promise
of a date.

- **Media-site support via [yt-dlp](https://github.com/yt-dlp/yt-dlp)**, invoked
  as an external tool downloaded at runtime by the user, with `ffmpeg` used for
  muxing where a site serves separate audio and video streams. Downpour will
  never vendor, bundle, mirror or auto-install those binaries, and it is not a
  "YouTube downloader" — it is a download manager that can hand a URL to a tool
  you already have.
- Command-line interface (the `downpour-cli` crate is currently a stub).
- Clipboard monitoring (the settings exist; nothing reads them yet).
- Per-download bandwidth limits.
- Torrent and magnet links are **not** supported and are not planned. Downpour
  is an HTTP(S) download manager; BitTorrent is a different protocol and a
  different program.

## Build from source

You need [Rust](https://rustup.rs/) (stable), [Node 22](https://nodejs.org/),
and the Tauri v2 prerequisites for Windows (Visual Studio Build Tools with the
C++ workload, and the WebView2 runtime — already present on Windows 11).

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
the desktop crate will compile.

## How it works

```
crates/downpour-core/     the engine — no UI, no Tauri, no window
  probe.rs                size, range support, validators, suggested filename
  transfer.rs             segmented download, work-stealing, verification
  resume.rs               the .dpart / .dpmeta sidecar and its validator checks
  engine.rs               queue, concurrency cap, scheduling, event stream
  scheduler.rs            time windows, including the midnight-crossing case
  throttle.rs             the shared token bucket
  store.rs                SQLite persistence
  naming.rs               filename derivation and Windows sanitisation

crates/downpour-cli/      a thin CLI over the same engine (stub)
src-tauri/                the desktop shell
src/                      the frontend (Vite + React + TypeScript + Tailwind)
extension/                the browser extension
docs/rpc-protocol.md      the frozen local RPC contract, v1
```

The split is deliberate. `downpour-core` is `#![forbid(unsafe_code)]`, owns every
state transition in a single background pump, and exposes the same API to the
desktop app, the CLI and the test suite. That is what makes it possible to test
the hard parts — segmentation, resume, scheduling — against a local HTTP server
that lies about range support, drops connections mid-body and changes files
underneath a resume, all without opening a window. There are 161 tests.

## Contributing

Bug reports, especially ones with a reproducible URL or host, are genuinely
useful — most download bugs are really server-behaviour bugs, and the ones that
matter are the ones nobody thought to simulate.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). By taking part you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

The app runs an authenticated HTTP listener bound to `127.0.0.1`. If you find a
way around that authentication — or anything else — please report it privately.
See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © ali-kin4

Downpour downloads what you point it at. What you are allowed to download is
between you, the site's terms, and the law where you live.
