# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

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
- Optional sorting into category folders (Video, Audio, Documents, Archives,
  Programs, Images) with editable extension lists, and a conflict policy of
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

[Unreleased]: https://github.com/ali-kin4/downpour/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ali-kin4/downpour/releases/tag/v0.1.0
