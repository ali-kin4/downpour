# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Downpour is a Windows HTTP(S) download manager: a Rust engine, a Tauri v2 shell,
a React interface, and an optional Manifest V3 browser extension.

## Commands

```bash
# The full gate — CI runs all of these (fmt first, warnings are errors)
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace && npx tsc --noEmit && npm run test:frontend

cargo test -p downpour-core                 # engine only; what you run most
cargo test -p downpour-core <test_name>     # a single test
npm run test:frontend                       # column maths, release-notes consistency, video overlay

npm run dev        # UI in a plain browser against src/dev/mockBackend.ts (no Rust build)
npm run app:dev    # the real app (tauri dev)
npm run build      # writes dist/
```

**`dist/` must exist before any cargo command on the workspace.**
`src-tauri/tauri.conf.json` points `frontendDist` at `../dist` and Tauri resolves
it at compile time; it is gitignored. Run `npm run build`, or for engine-only
work `mkdir -p dist && echo '<!doctype html>' > dist/index.html`. For the same
reason, rebuild `dist/` before `npm run app:build` or the binary embeds the old
frontend.

CI also runs `node --check` on every `extension/*.js` and parses every
`extension/*.json`.

## Architecture

Cargo workspace: `crates/downpour-core` (engine), `src-tauri` (desktop shell),
`crates/downpour-cli` (an empty stub — `fn main() {}`).

**`downpour-core` knows no window exists.** All download logic lives here so it
can be tested headlessly; `#![forbid(unsafe_code)]`. Key ideas, each explained in
its module header:
- `engine.rs` — the `Engine` handle. A single background "pump" loop is the only
  place downloads are promoted/demoted, which is what keeps the concurrency cap
  and scheduler windows honest. Emits `EngineEvent`s on a broadcast channel.
- `probe.rs` — never trusts `Accept-Ranges`; range support is proven by a `206`
  to a real one-byte ranged GET.
- `transfer.rs` — segmented download with work-stealing (a finished worker halves
  the largest outstanding segment). Hard cap of 16 connections per host, by design.
- `resume.rs` — each in-flight download is `name.dpart` (bytes) + `name.dpmeta`
  (segment cursors + validators). A resume is refused unless validators match.
  Nothing is written under the final name until complete and verified.
- `store.rs` — SQLite (rusqlite, bundled) with versioned migrations; persists
  status transitions, not progress ticks.
- `error.rs` — `Transient` (worker retries) vs `Fatal` (stops, surfaces to user).
  Putting an error in the wrong bucket means infinite retry or a needless failure.
- `scheduler.rs` — time windows; a window crossing midnight is keyed to the day it opened.

**`src-tauri`** is thin glue: `commands.rs` is the entire IPC surface (errors cross
as strings); `state.rs` forwards every engine event to the webview on one channel,
`downpour://event`, dropping to the newest on lag (the UI re-reads the list);
`rpc.rs` is the loopback server for the extension (bound to `127.0.0.1` only,
explicit CORS preflight, constant-time token compare); `media.rs` uses a
user-installed yt-dlp only to *resolve* media URLs and headers — the download
itself always goes through Downpour's engine.

**`src/`** — React 19 + Zustand + Tailwind v4. `src/lib/api.ts` is the only place
that calls `invoke`; components must not import it directly. Styling uses CSS
custom properties (`var(--accent)` etc.) — never hardcode colours, eleven themes
resolve through them. Shared controls live in `src/components/ui.tsx`. The compact
panels (`?view=progress|confirm|download&id=`) are separate Tauri windows on the
same bundle, routed in `main.tsx`; they do not share the main window's store and
each listens to the event stream itself. The download table's header sits above
the scroll area, so every width change in `src/store/columns.ts` is clamped —
run `npm run test:frontend` after touching that maths.

**`extension/`** — plain JS, no build step, no dependencies. It only cancels the
browser's download *after* the app accepts the hand-off. The app decides policy
(capture rules, confirmation prompt) keyed on the request's `source`; deliberate
sources (`extension-context-menu`, `-video-overlay`, `-link-grabber`,
`-page-links`) are never second-guessed with a prompt.

**`docs/rpc-protocol.md` is frozen.** The app and extension are built against it
independently; any change is breaking and needs a protocol version bump and
coordinated releases.

## Testing engine changes

`crates/downpour-core/tests/common/` is a local HTTP server that misbehaves on
demand (`Mode::LiesAboutRanges`, `NoRanges`, `UnknownLength`, `ServerError`,
`drop_connection_after`, `replace_data`, `trickle`) and counts requests, ranged
requests and bytes served. Engine behaviour changes get a test there, asserting
on something the bug would change (bytes served, elapsed time vs. a trickling
server) — not the filename or final checksum. Use the `prove-the-fix` skill: the
test must fail with the fix removed. Commit before mutating code to check this;
`git checkout` has discarded uncommitted fixes here twice.

## Versioning and releases

The version lives in `package.json`, `Cargo.toml`, `src-tauri/tauri.conf.json`
and `extension/manifest.json`, plus `CHANGELOG.md` and the in-app notes in
`src/lib/release-notes.ts` (newest entry first in `RELEASES`, written for users,
not copied from the changelog). `src/lib/release-notes.test.mjs` enforces that
they agree, in the pre-commit hook (`.githooks/`, installed by `npm install`),
CI and the release workflow. Use the `release` skill and `npm run release:prep
<x.y.z>`; pushing a tag publishes, so ask before tagging. Release builds use
`CARGO_BUILD_JOBS=6` — ask before starting one.

User-visible changes get a line under `[Unreleased]` in `CHANGELOG.md`.

## Conventions

- Conventional Commits: `type(scope): summary` (scopes like `engine`, `transfer`,
  `resume`, `probe`, `store`, `rpc`, `ui`, `extension`, `tauri`). Body explains why.
- Comments explain reasoning in prose, not mechanics; module headers set the
  house voice. Read the file first and match it.
- Don't silently widen scope — report a second bug rather than fixing it unasked.
- Subagents `engine` and `interface` (`.claude/agents/`) cover the Rust and
  React/extension halves respectively.
