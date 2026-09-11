<!--
Thanks for contributing to Downpour. Keep this short - a PR that explains
itself in three lines is easier to review than one that explains itself in
thirty.
-->

## What this changes

<!-- One or two sentences. What is different after this is merged? -->

## Why

<!-- The problem being solved. Link the issue if there is one: "Fixes #123". -->

## How it was tested

<!--
Say what you actually ran, not what could in principle be run.
For engine changes, mention which tests you added or extended - the harness in
crates/downpour-core/tests/common/ can simulate servers that lie about range
support, drop connections mid-body, or change the file underneath a resume.
-->

- [ ] `cargo fmt --all`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] Tested manually in the app (describe how)

## Notes for the reviewer

<!--
Anything that would otherwise be a surprise: a behaviour change, a new
dependency, a migration, a deliberate trade-off, or a part you are unsure about.
-->

- [ ] This changes behaviour a user would notice, and CHANGELOG.md is updated
- [ ] This changes the local RPC contract (`docs/rpc-protocol.md` is frozen -
      changes there need a protocol version bump and coordination with the
      browser extension)
