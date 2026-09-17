---
name: prove-the-fix
description: Verify a bug fix actually fixes the bug before shipping it, by making the test fail without it. Use after writing any fix in this repo, before committing or releasing. Exists because fixes here have shipped twice that did not work.
---

# Proving a fix

Two fixes have shipped from this repo that did not work. Both had passing tests.
Neither test could have failed.

## The rule

**A test that passes with the fix removed has proved nothing.** Before shipping
any fix, delete the fix, run the test, and watch it fail. Then restore it.

```bash
git add -A && git commit -m "wip: fix"     # commit FIRST -- see below
# remove the fix, e.g. with an editor or a patch
cargo test -p downpour-core --offline <test_name>     # must FAIL, with the right message
git checkout -- <file>                                 # restore
cargo test -p downpour-core --offline <test_name>     # must PASS
```

**Commit before mutating.** `git checkout`/`git stash` to undo a mutation has
twice discarded the uncommitted fix along with it, leaving a "restored" tree
that silently still had the bug.

## Test the behaviour, not the helper

The 1.3.1 failure: a unit test covered the sidecar guard in isolation and
passed, while the feature did not work at all — the *caller* undid the decision
the guard had made. A unit test on the piece you changed cannot see that.

Drive the whole path. `crates/downpour-core/tests/` has a controllable HTTP
server for exactly this.

## Assert on something the bug would change

Filenames, statuses and final checksums are usually identical whether the bug is
present or not. Find the observable that differs:

- **Resume vs restart** → `server.state.bytes_served()`. Both end with a correct
  file; only the bytes on the wire differ.
- **Responsiveness** → elapsed time against a deliberately slow server
  (`server.state.trickle(ms)`). A local server answers instantly and hides every
  latency bug.
- **Ordering, concurrency caps** → `request_count()`, `ranged_count()`.

Pick a threshold far from both sides. A 700ms bar against a 1500ms trickle
proves something and will not flake; 1400ms would do neither.

## Timing assertions

Prefer a counter to a clock. When only a clock will do, make the margin wide
enough that a loaded CI runner cannot cross it, and say in a comment why the
number is what it is.

## Before saying it works

- Ran the test with the fix removed and saw it fail, for the right reason
- The assertion names what the user would notice, not what the code does
- `cargo fmt --all --check`, clippy with `-D warnings`, and the full suite pass

If you have not done the first one, say so rather than implying the fix is
verified.
