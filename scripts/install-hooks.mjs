/**
 * Points git at `.githooks/`, so the hooks are version-controlled rather than
 * living in one clone's `.git/hooks`.
 *
 * Run by `npm install` through `prepare`. It must never fail: `prepare` runs on
 * `npm ci` in CI too, where there may be no git directory at all, and a failure
 * here would fail the install and take both workflows down with it.
 */

import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // No git, no repository, or a checkout that cannot be configured. The hook is
  // a convenience; CI enforces the same checks either way.
}
