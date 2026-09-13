# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-09-13

### Added

- **An About window that answers the three things it is opened for**: which
  version is running, what changed in it, and whether there is a newer one.
  Reachable from Help, and shown once on the first launch after an upgrade --
  only an upgrade, because release notes are not how anyone wants to be greeted
  by an app they have just installed.
- **A manual check for updates**, against the GitHub releases API. Manual is the
  design, not a shortcut: nothing polls at launch or on a timer, because an
  unprompted request every time the app opens is exactly what someone on a
  metered connection does not want. The check distinguishes "this is the newest
  release" from "I could not find out" -- a rate-limited request reported as up
  to date is how people miss releases for months -- and compares versions
  numerically, so a `v` on a tag is not mistaken for a new release forever.
- **Proper attribution and legal footing.** The copyright holder is now Ali
  Jabbary by name rather than a GitHub handle, across `LICENSE`, the crate
  manifest and the installer metadata. The About window carries the notices a
  person needs to judge a build: who holds copyright, that the source is MIT,
  and that the name and logo are not covered by it.
- **`TRADEMARK.md`**, reserving the Downpour name and droplet logo while leaving
  the code MIT -- the Firefox and Chromium arrangement. A fork is welcome under
  its own name; a modified build calling itself Downpour is not, because a
  broken or malicious one carrying this name damages everyone who trusts it. The
  marks are unregistered and asserted under common law, so the notices say
  "trademarks" and never "registered".
- **Open-source acknowledgements** in the About window: the principal components
  Downpour is built on, each with the licence read from the package as installed
  rather than from memory, and yt-dlp marked "not bundled" because Downpour
  fetches it from its own releases on request rather than shipping it.
- **Plain-language release notes** in `src/lib/release-notes.ts`, shown in the
  About window. This file is what changed *for the user*; `CHANGELOG.md` stays
  the technical record. It holds the current release and a couple behind it
  rather than mirroring this file, because two documents that must be edited
  together will drift, and a short one is the one that actually gets updated.

### Fixed

- **Pause All did not stop a pinned download.** A download gated by the
  scheduler was reported as `Scheduled` whenever it stopped, on the assumption
  that only a closing window ever stops one. When the user paused it, the
  scheduler saw an item waiting for a window that was already open, promoted it
  back into the queue on its next half-second tick and started it again -- so
  Pause All appeared to do nothing and the file downloaded to completion. The
  transfer now records *why* it stopped: a user pause always lands on `Paused`,
  and only the engine's own parking -- a window closing, or the app shutting
  down -- sends a scheduled item back to wait for its next window. Unpinned
  downloads were never affected, which is why it looked intermittent.
- **A download could start moments after being paused.** The queue pump chose
  which item to start, released its lock, and then set the item running without
  looking again. A pause landing in that gap was overwritten and the transfer
  ran regardless. The pump now re-checks, under the lock that starts the
  transfer, that the item is still queued, and a pause that crosses a start
  signals the transfer it just missed.
- **"Sleep when finished" could put the machine to sleep seconds after a
  download was started.** Three bugs stacked up. The drain report counted every
  `Completed` row in the list rather than the run that had just ended, so a
  queue whose only download failed immediately still reported the downloads
  that had finished earlier in the session, and the shell acted on it; a paused
  download counted as no work outstanding, so pausing the last active item read
  as the queue finishing; and the action was never disarmed, so a choice made
  once for one overnight queue fired again on every later drain, indefinitely.
  Together these turned a broken link into "the PC dies the moment I hit
  download". The post-queue action now only runs when something actually
  completed in that run, pausing is not a drain, and firing resets the setting
  to "Do nothing".
- **Sleep is no longer forced, and no longer instant.** It was dispatched as
  `SetSuspendState(..., bForce = TRUE, ...)`, which skips the window in which
  drivers and applications acknowledge the transition; a machine that cannot
  service a suspend that way does not sleep, it drops. It now requests a normal
  suspend and, like shutdown and hibernate, does so after a 60-second countdown
  that "Cancel power action" calls off.
- **Cancelling a power countdown no longer leaks into the next one.** The
  pending-hibernate flag was never cleared on the path that did not fire, so a
  cancellation could silently swallow an action armed later. Countdowns are
  now generation-stamped, and one Cancel covers sleep, hibernate and shutdown.

## [1.0.1] - 2026-09-11

Everything here landed hours after the 1.0.0 tag was cut, so 1.0.0's published
installers do not contain it. 1.0.1 is the first release whose artifacts match
the source.

### Added

- **A video button in the browser**, in the spirit of IDM's. It appears over a
  video on hover or after a couple of seconds of playback, never on page load,
  never in fullscreen, and never over a decorative or DRM-protected player.
  Clicking it lists the real qualities with sizes, sound-carrying formats
  first. Off per-site or entirely, in one click from its own menu.
- **`POST /api/v1/media/probe` and `/api/v1/media/resolve`**, so the extension
  can list qualities itself. yt-dlp was previously reachable only from the
  app's own window.
- **A 24-hour clock face for scheduler windows.** Midnight sits at the top, so
  an overnight window is one unbroken sweep through it rather than two numbers
  to subtract. Night hours are shaded and the span is written in the middle.

### Fixed

- **The progress panel's percentage never moved.** Its window was missing from
  the capability file, so it was denied permission to listen for events.
  Custom commands are not permission-gated, which is why it rendered its first
  frame correctly and then froze — the most confusing possible symptom.
- **Sending a video page to `/api/v1/downloads` saved the page's HTML** under
  the video's name and reported success. Known media pages are now refused
  with an explanation and a pointer at the probe endpoint.
- The progress panel no longer forces itself above other windows, and closing
  it closes it rather than hiding it. It has never stopped a download; the
  button now says so.

### Changed

- Release builds use thin LTO. Fat LTO took about fifty minutes on a two-core
  CI runner to buy a percent or two on a program bottlenecked by a socket.
- The release workflow builds with the pinned npm Tauri CLI instead of
  compiling `tauri-cli` from source on every run, and the extension zip now
  includes its README, which is the install guide.

## [1.0.0] - 2026-09-11

The first release intended for other people to install.

### Added

- **Clipboard monitoring.** Copy a link anywhere and Downpour offers it, with
  one click to accept. Off by default; never re-offers the same text; ignores
  links Downpour itself copied.
- **Drag and drop.** A link dragged from a browser, or a `.txt` full of them,
  dropped anywhere on the window.
- **Five accent themes**, alongside light, dark and follow-Windows.
- **A settings screen with a search box.** Nine tabs, every control indexed, and
  matches revealed across tabs as you type.
- **Reset to defaults**, which deliberately keeps the download folder, the
  browser pairing token and your scheduler windows — the first is a place you
  chose, the second would silently unpair your extension, and the third is
  hand-authored content rather than a preference.
- The browser extension gained a **link grabber** with a filterable picker,
  **selection capture**, **per-site rules** and a **hold-Alt-to-bypass** key.
- **Media pages** via yt-dlp, fetched from its official releases on request and
  checksum-verified, never bundled.

### Changed

- Hibernate now gets the same cancellable 60-second countdown as shutdown.
  Sleep still fires immediately, because moving the mouse undoes it.

### Fixed

- **Segmented downloads now open real TCP connections again.** Over TLS, ALPN
  negotiates HTTP/2 with essentially every CDN and release host, and `reqwest`
  multiplexes every concurrent request to an origin onto a *single* TCP
  connection. A sixteen-way segmented download was therefore opening sixteen
  HTTP/2 *streams* inside one connection: sixteen sets of request overhead, all
  of them inside the one per-connection shaping bucket that segmentation exists
  to escape. It was also capped by hyper's 5 MiB HTTP/2 connection window —
  roughly 420 Mbit/s at 100 ms RTT — regardless of how the file was split.

  The engine's client is now built with `.http1_only()`, so each segment gets its
  own socket, its own receive window, its own congestion window and its own slot
  in the origin's per-connection limits. Nothing user-visible breaks when this
  regresses — downloads just quietly get slower — so it is guarded by
  `crates/downpour-core/tests/protocol_probe.rs`, which asserts `HTTP/1.1` on
  every response from three real public hosts, including four concurrent ranged
  requests to one origin. It needs the network, so it is `#[ignore]`d by default:
  `cargo test -p downpour-core --test protocol_probe -- --ignored --nocapture`.

  Full analysis, including the eight other throughput changes that were
  investigated and mostly rejected, in `docs/research/throughput.md`.
- Content encoding is now refused outright (`no_gzip`, `no_brotli`, `no_deflate`)
  rather than relying on `reqwest` skipping it when a `Range` header is present.
  Byte ranges are defined over the *encoded* representation, so a decoded body
  makes the arithmetic a segmented download depends on ambiguous.

### Changed

- The per-download connection ceiling is **16**, down from 32. Beyond that point
  extra connections stop buying throughput and start looking, to the server, like
  something to rate-limit or ban. The default is still 8.

### Added

**Desktop application**

- The full application window: a virtualised download list with live search over
  filename and URL, sortable columns, resizable columns that persist their widths
  (double-click an edge to fit the content), multi-select with bulk
  start/pause/remove/delete, and a per-row context menu.
- A collapsible sidebar with live status counts, the six file-type categories,
  scheduler state and the active speed limit.
- A command palette on `Ctrl K` covering every global action and jump-to-download
  by name or URL, plus a menu bar and shortcuts for new download, new batch,
  settings and select-all.
- A New Download dialog that probes the URL as you type and reports the real
  filename, the size and whether the server serves byte ranges, with a save-as
  path, a start mode and an advanced section for connections, custom request
  headers and an expected SHA-256.
- A batch dialog: paste text or import a `.txt`, with a debounced live count of
  the links found — delegated to the engine's own extractor so the preview and
  the queue can never disagree — a per-batch destination, and a start mode.
- Duplicate detection on single adds. Before starting, a URL is checked against
  the download history and the destination path, and one of four distinct panels
  is shown: already in the list, downloaded before with the file present,
  downloaded before with the file gone, or an unrelated file occupying the name.
  Advisory only — every panel offers to continue. URLs are compared with the
  query string and fragment stripped, because signed CDN links change every time.
- A system tray icon with Open, Pause all, Resume all and Quit, and a tooltip
  that updates every two seconds with what is running and how fast. Closing the
  window minimises to the tray by default.
- A compact, always-on-top progress panel that opens when a transfer starts —
  driven by the event stream, so it appears for a download started from the tray,
  the extension or a scheduler window opening at 2 a.m. — and closes itself once
  the queue drains.
- Desktop notifications on completion and failure, and a completion dialog with
  Open, Show in folder and Copy link, shown only when nothing else is running and
  the window is visible.
- Post-queue actions: nothing, sleep, hibernate, shut down or exit, fired on the
  busy-to-idle edge so an empty queue at launch can never trigger one. Shutdown
  arms Windows' 60-second countdown, cancellable from Tools → Cancel pending
  shutdown; sleep and hibernate take effect immediately.
- Settings covering downloads, scheduling, notifications, browser integration and
  appearance, applied immediately with no Save button, and with engine-clamped
  values written back into the field so the clamp is visible.
- A schedule editor for multiple named windows with per-day toggles, presets, and
  open-now / next-open badges that mirror the engine's midnight-crossing
  semantics exactly.
- Light and dark themes following Windows or pinned, with the Windows 11 Mica
  backdrop on the main window and opaque list rows so the grid stays legible over
  it. Reduced-motion is honoured.
- First-run setup: the download folder and its category subfolders are created
  once, guarded by a database flag, reusing anything already present and never
  failing startup. Settings can recreate any that are later removed.
- NSIS installer hooks that create a desktop shortcut on install and, more
  importantly, delete it on uninstall.

**Browser extension**

- A Manifest V3 extension for Chrome, Edge, Brave, Opera and Vivaldi that hands
  browser downloads to the app with their `Cookie`, `Referer` and `User-Agent`
  attached. The browser's own download is cancelled only *after* the app confirms
  it accepted the hand-over, so closing the app can never cost a file.
- A configurable bypass key (Alt by default) that lets a single download through
  to the browser without turning capture off.
- A link grabber: collects every anchor, image (including `srcset`), video and
  audio source, `<embed>`, `<object>` and visible CSS background image on a page,
  then opens a picker grouped by kind with filters by kind, extension and
  text-or-regex, select-all-shown / invert / per-group selection, and a running
  count. Nothing is queued until Send is pressed.
- A right-click "Send selected links" that posts the raw selection to the app and
  lets the app's extractor find the URLs, so there is exactly one extractor.
- Per-site block and allow lists, honoured for both the file's host and the page
  it came from, plus the app's own excluded-host list regardless of which rule
  source is selected.

**Media pages**

- Optional support for video pages through yt-dlp, used as a *metadata source*
  rather than as a downloader: the direct media URL and its required headers are
  handed to Downpour's own segmented engine, so a video gets connections,
  work-stealing, the queue, the scheduler and the speed limit like any other file.
- yt-dlp is never bundled, vendored, mirrored or silently installed. It is
  fetched only from the official GitHub releases API, only after an explicit
  click on a button that names the tool, the source and the destination, and only
  after the download is verified against the `SHA2-256SUMS` manifest from the
  same release. A missing manifest or an unlisted asset fails the install rather
  than skipping the check. It is written to a `.part` file and renamed into place
  only once the hash matches, and it lives at one path that can be deleted to
  uninstall it.
- ffmpeg is never fetched. Muxing is therefore out of scope, so the quality
  picker defaults to progressive formats — the ones that already contain audio —
  with an All formats toggle and an explicit warning before a video-only or
  audio-only stream can be chosen. Downpour never silently produces a file with
  no sound.
- `Accept-Encoding` and other hop-by-hop headers are stripped from the header set
  yt-dlp reports, because a compressed body would make the engine's ranged byte
  arithmetic ambiguous and write gzipped bytes to disk while reporting success.
- Every yt-dlp invocation is async, spawned with `CREATE_NO_WINDOW`, passed
  `--ignore-config`, bounded by a timeout with `kill_on_drop`, and reports the
  tool's own stderr verbatim on failure rather than paraphrasing it away.

**Documentation**

- `docs/install.md`: the long-form install guide — requirements, the SmartScreen
  walkthrough, every path the installer writes, silent-install flags, a clean
  uninstall including what is deliberately left behind, and troubleshooting for
  SmartScreen, antivirus false positives, the RPC port range being in use, and
  corporate proxies.
- `docs/research/throughput.md`: what actually makes an HTTP download faster,
  with each finding marked as read-from-source, read-from-a-primary-document, or
  unmeasured.
- `docs/media.md`: the media-page design, its legal constraints, and its known
  gaps.
- `docs/images/README.md`: which screenshots the README needs, at what size.

### Known limitations

- The `downpour-cli` crate is still a stub: it declares a `downpour` binary whose
  `main` is empty.
- Clipboard monitoring is not implemented. The settings fields exist and nothing
  reads them; what works is clipboard prefill in the two add dialogs.
- Proxy configuration is read from the `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
  / `NO_PROXY` environment variables only — Windows Internet Options, PAC scripts
  and WPAD are not consulted.
- TLS trust comes from the bundled Mozilla root store (`webpki-roots`), not the
  Windows certificate store, so downloads fail with a certificate error behind a
  TLS-inspecting corporate proxy whose private root CA is trusted by the browser.
  There is no setting that changes this.
- Media downloads hold a signed URL that expires in minutes to hours, so one left
  paused or queued for too long fails with a `403` on resume and must be re-added
  from the page.
- The installers are not code-signed, which is why SmartScreen warns.

## [0.1.0] - 2026-09-11

First public release. Windows 10/11, 64-bit, shipped as an NSIS installer
(`-setup.exe`) and an MSI.

### Added

**Download engine (`downpour-core`)**

- Segmented multi-connection transfers, 8 connections per download by default
  and up to 32, written in place at their own offsets.
- Work-stealing between connections: a worker that finishes its segment halves
  the largest outstanding segment and takes the tail, so the end of a download
  does not run at 1/Nth of the achievable rate while other connections idle.
- Range support proven by a real ranged request rather than trusted from an
  `Accept-Ranges` header, so servers and CDNs that advertise range support and
  then return `200` with the whole body cannot produce a corrupt file.
- Resume through a `name.dpart` / `name.dpmeta` pair holding the partial bytes
  and the per-segment cursors, with the remote's `ETag` and `Last-Modified`
  recorded alongside. A resume is refused when those validators no longer match,
  rather than stitching two versions of a file into one of the right length.
- Retry handling split by who can act on the error: transient failures are
  retried by the worker loop, fatal ones stop the download and surface.
- Optional SHA-256 verification against an expected `sha256:` digest, checked
  before the completed file is moved into place.
- Global bandwidth limiting as a shared token bucket, so a limit means the
  application total and not a per-connection allowance.
- Time-window scheduling, including windows that cross midnight — the
  day-of-week filter applies to the day the window opened, so a weeknights
  22:00–06:00 window is still open at 02:00 on Saturday.
- A separate, lower speed limit that applies only inside scheduled windows.
- Queue orchestration in a single background pump: concurrency cap, move to
  top/bottom, force-start past the cap, pause/resume all, retry all failed,
  clear completed or finished.
- SQLite persistence for the queue and settings, so the list survives a crash or
  a reboot mid-download.
- URL extraction from arbitrary text — one per line, comma or whitespace
  separated, or embedded in prose — deduplicated, order preserving, with
  trailing sentence punctuation stripped and balanced parentheses kept.
- Filename derivation with an explicit precedence (`Content-Disposition`, then
  the URL path, then a fallback) and sanitisation for Windows' naming rules.
- Optional sorting into category folders (Video, Music, Pictures, Documents,
  Compressed, Programs) with editable extension lists, and a conflict policy of
  rename, overwrite or skip.
- Exponential-moving-average speed and ETA estimation, smoothed by elapsed time
  rather than per tick so a late tick does not distort the figure.
- `#![forbid(unsafe_code)]`, and 161 tests including an integration harness whose
  HTTP server can lie about range support, drop connections mid-body and change
  a file underneath an in-progress resume.

**Desktop application**

- Tauri v2 shell for Windows, packaged as both MSI and NSIS installers.

**Documentation**

- `docs/rpc-protocol.md`: version 1 of the local RPC contract between the app and
  local clients — authenticated HTTP on `127.0.0.1` only, a 64-hex-character
  token compared in constant time, CORS reflected only for extension origins,
  and endpoints for adding a single download, a batch, or a blob of text.

[Unreleased]: https://github.com/ali-kin4/downpour/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ali-kin4/downpour/releases/tag/v1.1.0
[1.0.1]: https://github.com/ali-kin4/downpour/releases/tag/v1.0.1
[1.0.0]: https://github.com/ali-kin4/downpour/releases/tag/v1.0.0
[0.1.0]: https://github.com/ali-kin4/downpour/releases/tag/v0.1.0
