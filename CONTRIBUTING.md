# Contributing to Downpour

Thanks for being here. This document is the short version of everything you need
to get a working checkout, run the tests, and open a change that can be reviewed
quickly.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Before you write code

- **Bugs**: open an issue first if the fix is not obvious. Include the URL or at
  least the host if you can — most download bugs are server-behaviour bugs, and
  a reproducing host is worth more than a stack trace.
- **Features**: open an issue before building. A large PR that solves a problem
  the project deliberately does not want is a bad afternoon for everyone.
- **Small fixes** — typos, a clippy warning, a missing test — just send the PR.

`docs/rpc-protocol.md` is **frozen**. The browser extension and the app are built
against it independently, so any change there is a breaking change requiring a
protocol version bump and coordinated releases. Do not edit it as part of an
unrelated PR.

## Development setup

You need:

| Tool | Version |
|---|---|
| Rust | stable (workspace MSRV is 1.82) |
| Node | 22 |
| `tauri-cli` | v2 |
| Visual Studio Build Tools | with the "Desktop development with C++" workload |
| WebView2 runtime | preinstalled on Windows 11 |

```bash
git clone https://github.com/ali-kin4/downpour.git
cd downpour

rustup component add rustfmt clippy
cargo install tauri-cli --version "^2" --locked

npm ci
cargo tauri dev
```

### One gotcha on a clean clone

`src-tauri/tauri.conf.json` points `frontendDist` at `../dist`, and Tauri
resolves that directory **at compile time**. `dist/` is gitignored, so on a fresh
checkout `cargo check`, `cargo clippy` and `cargo test --workspace` all fail
until it exists.

Fix it either way:

```bash
npm run build                              # the real thing
# or, if you only care about the engine:
mkdir -p dist && echo '<!doctype html>' > dist/index.html
```

CI does exactly this before it lints or tests.

## Running the tests

```bash
cargo test --workspace       # everything (needs dist/, see above)
cargo test -p downpour-core  # the engine only — no frontend, no window
```

`cargo test -p downpour-core` is what you will run 95% of the time. There are 161
tests and they take seconds.

### The integration test harness

`crates/downpour-core/tests/common/` contains a local HTTP server whose entire
purpose is to behave badly on demand. Testing a download engine against a
well-behaved server proves almost nothing; the bugs that corrupt files come from
servers that misbehave in specific, boring ways.

It can be told to:

| Mode / control | What it simulates |
|---|---|
| `Mode::Honest` | Correct RFC 7233 range handling. |
| `Mode::LiesAboutRanges` | Advertises `Accept-Ranges: bytes`, then returns `200` with the whole body. The case that silently corrupts naive downloaders. |
| `Mode::NoRanges` | Honestly does not support ranges. |
| `Mode::UnknownLength` | Streams with no `Content-Length`. |
| `Mode::ServerError` | `500` for everything. |
| `drop_connection_after(bytes, times)` | A connection cut mid-body, N times, then normal service. |
| `replace_data(bytes, etag)` | The file changing underneath an in-progress resume. |

It also counts requests, ranged requests and bytes served, so a test can *prove*
that segmentation happened and that a resume fetched less than the whole file
rather than assuming it from a passing checksum.

**If you change engine behaviour, add a test here.** A new failure mode you hit
in the wild is one of the most valuable things you can contribute: teach the
fake server to do the bad thing, then fix it.

## Before you open a PR

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI runs the same three on `windows-latest` and treats warnings as errors, so
running them locally saves a round trip. It also syntax-checks the extension's
`.js` and `.json` files with Node.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/). The subject line
is `type(scope): summary`, in the imperative mood, no trailing period, ideally
under 72 characters.

```
feat(transfer): steal from the largest outstanding segment
fix(resume): refuse to resume when the ETag changed
perf(throttle): avoid waking every worker on each refill
docs(readme): document the checksum verification step
test(engine): cover force-start past the concurrency cap
refactor(store): fold the two settings queries into one
chore(deps): bump reqwest to 0.12.9
ci(release): attach checksums.txt to the release
```

Types in use: `feat`, `fix`, `perf`, `docs`, `test`, `refactor`, `chore`, `ci`,
`build`, `style`.

Common scopes: `core`, `engine`, `transfer`, `resume`, `probe`, `scheduler`,
`throttle`, `store`, `naming`, `settings`, `cli`, `tauri`, `ui`, `extension`,
`rpc`, `readme`, `deps`.

Breaking changes get a `!` before the colon (`feat(rpc)!: …`) and a
`BREAKING CHANGE:` footer explaining the migration.

The body is for *why*, not *what* — the diff already says what. If the change is
subtle or the obvious alternative is wrong, say so; that note is usually the
most valuable line in the commit.

## Code style

- `cargo fmt` decides formatting. There is nothing to discuss.
- Clippy is clean at `-D warnings`. If a lint is genuinely wrong, `#[allow]` it
  narrowly with a comment saying why.
- `downpour-core` is `#![forbid(unsafe_code)]`. Keep it that way.
- Comments explain reasoning, not mechanics. The existing module headers are the
  house style: they say why the design is what it is, and what breaks under the
  obvious alternative.
- Errors belong in the `Transient` / `Fatal` split in `error.rs` — the worker
  loop retries the first and gives up on the second, so putting an error in the
  wrong bucket means either an infinite retry or a download that dies for no
  good reason.
- User-visible changes get a line in `CHANGELOG.md` under `[Unreleased]`.

## Releasing

Maintainers only:

1. Move `[Unreleased]` items into a new `## [x.y.z] - YYYY-MM-DD` section in
   `CHANGELOG.md`.
2. Bump `version` in the workspace `Cargo.toml` and in
   `src-tauri/tauri.conf.json`, and refresh `Cargo.lock`.
3. Tag `vx.y.z` and push the tag.

`.github/workflows/release.yml` builds the installers, generates
`checksums.txt`, pulls the release notes out of `CHANGELOG.md` for that version,
and publishes the GitHub Release. Tags containing `-rc`, `-beta` or `-alpha` are
marked as prereleases automatically.
