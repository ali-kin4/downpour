---
name: release
description: Cut a Downpour release - version bump, changelog, build, install locally, tag. Use when asked to release, ship, publish a version, bump the version, or get a change onto the user's machine. Encodes the traps that have actually broken releases here.
---

# Releasing Downpour

A release is mechanical, and every step below exists because skipping it broke
something real. Follow it in order.

## 0. Gate: all three checks, as one command

CI runs `cargo fmt --check` **before** anything else, so a formatting slip fails
the build before a single test runs — and the badge goes red on a change that
was otherwise fine. Clippy runs with `-D warnings`, so an unused helper is a
failure, not a warning.

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace && npx tsc --noEmit && npm run test:frontend
```

Running the tests alone is not the gate. Formatting and clippy have each broken
CI here on a change whose tests passed.

## 1. Pick the number

Semver against the **last published** release, not the last version in the
manifests — a version can be prepared and never shipped (1.2.1 was).

- Fixes only → patch
- New behaviour, or behaviour that visibly changes → minor

## 2. Prepare it: `npm run release:prep <x.y.z>`

One command does everything mechanical, because six files that must agree by
hand will not:

- `package.json`, `Cargo.toml`, `src-tauri/tauri.conf.json` and
  `extension/manifest.json` — the extension manifest is bumped here too, even
  though CI stamps it from the tag when packaging: the repo should not claim a
  version it is not.
- `Cargo.lock`, through `cargo update -p downpour --offline`. Never by hand.
- `CHANGELOG.md`: moves whatever sits under `[Unreleased]` into
  `## [x.y.z] - YYYY-MM-DD` and rewrites the link references at the bottom. The
  release workflow extracts the notes by matching that heading exactly, so a
  mistyped one produces a release with empty notes — which is why this is
  generated rather than typed.

It refuses to run on an empty `[Unreleased]`: what is written there *is* the
release. Write that entry first, for the person who hit the bug — what went
wrong from their side, then what changed. Not the diff.

Then it exits **non-zero on purpose**, with the one step it will not do for you.

## 3. Write what the app will say

`src/lib/release-notes.ts` is what users read in Help → What's new. The script
leaves it alone deliberately: seeding it from the changelog would turn a loud
failure into a quiet wrong answer — diff-voiced text in a window written for
people who do not read diffs. That is the bug this whole apparatus exists to
prevent, so the last step stays human.

Add the release at the **top** of `RELEASES` — the newest entry is `RELEASES[0]`
by position, so notes appended to the bottom fix nothing. Two lines per change
is plenty, and no internals in either.

`npm run test:frontend` is the gate: it fails if the manifests disagree, if the
version has no notes, if they are not first, if the changelog heading or its
links are missing, or if a note was pasted from the changelog. The same check
runs in the pre-commit hook, in CI, and on the tag — so a forgotten entry can no
longer reach a release. It reached eight.

## 4. Build the frontend *before* the app

```bash
npm run build          # writes dist/
CARGO_BUILD_JOBS=6 npm run app:build
```

`tauri.conf.json` sets `frontendDist: "../dist"` and the assets are **embedded
into the binary at compile time**. Build the app without rebuilding `dist/`
first and you ship a binary containing the previous frontend, which looks
exactly like your change not working.

`CARGO_BUILD_JOBS=6` is not optional here: the machine has 24 cores and a
failing PSU, and an unthrottled all-core release build is the load that risks
it. Ask before starting one at all.

## 5. Install locally, and verify by hash

```bash
taskkill //F //IM downpour.exe     # it minimises to the tray; a normal close does not release the exe
cp target/release/downpour.exe /c/Users/Ali/AppData/Local/downpour/downpour.exe
sha256sum target/release/downpour.exe /c/Users/Ali/AppData/Local/downpour/downpour.exe
```

The two hashes must match. Windows locks a running executable, so a copy over a
live app silently fails — the hash is what proves it landed.

## 6. Commit, push, tag

```bash
git push origin main
git tag -a vx.y.z -m "Downpour vx.y.z" && git push origin vx.y.z
```

**The tag is the release.** Pushing it runs `.github/workflows/release.yml`,
which builds the installers on a runner, runs the whole suite as a gate,
packages the extension, generates `checksums.txt` and publishes.

Never upload a locally built installer to a release. The README tells users the
installers are built by a runner from a tagged commit, and hand-uploading makes
that false — as well as skipping the test gate.

## 7. Confirm it actually published

```bash
gh run list --workflow=release.yml --limit 1
gh release view vx.y.z --json assets --jq '[.assets[].name]'
curl -sI https://github.com/ali-kin4/downpour/releases/latest | grep -i location
```

Expect four assets: setup.exe, msi, extension zip, checksums.txt. A **zero-second
failure** means the workflow file itself is unparseable — validate the YAML
rather than re-running.

## Publishing is the user's call

Building, installing and committing are routine. Pushing a tag publishes
something public and permanent, so ask first unless the user has already said to
ship it.
