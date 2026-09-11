# Security Policy

## Supported versions

Downpour is pre-1.0 and moves fast. Only the latest release receives security
fixes.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Older | No |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub Security Advisories:

**<https://github.com/ali-kin4/downpour/security/advisories/new>**

That form is private to the maintainers until an advisory is published, and it
lets us credit you and coordinate a fix and a release in one place.

What to include, as much of it as you have:

- What the issue is, and what an attacker gains.
- Steps to reproduce, or a proof of concept.
- The Downpour version, and how you installed it.
- Whether you intend to disclose publicly, and on what timeline.

What to expect:

- An acknowledgement within **5 days**.
- An assessment, with severity and a rough fix timeline, within **14 days**.
- Credit in the advisory and the changelog, unless you would rather not be named.

Please give us a reasonable window to ship a fix before disclosing publicly.
There is no bug bounty; this is an unfunded open-source project. Careful reports
are appreciated all the same.

## Explicitly in scope: the local HTTP listener

Downpour runs an HTTP listener so the browser extension can hand it downloads.
This is the most security-relevant surface in the application, and **reports
about it are firmly in scope.** Its contract is documented in
[`docs/rpc-protocol.md`](docs/rpc-protocol.md).

The properties it is required to hold:

- It binds **`127.0.0.1` only** — never `0.0.0.0`, never any other interface.
  Anything that causes it to be reachable from the local network is a
  vulnerability.
- Every endpoint except `GET /health` requires an `X-Downpour-Token` header
  holding a 64-hex-character secret generated on first run. `/health` is
  unauthenticated deliberately: it reports only presence and version, and
  requiring a token to detect the app would make the extension's pairing flow
  impossible to explain.
- The token is compared in **constant time**. A timing oracle here is a real
  leak, because any tab in the browser can make timed requests to loopback.
- A missing or wrong token returns `401` with `{"error":"unauthorized"}` and no
  further detail.
- Regenerating the token in Settings **immediately** invalidates the old one.
- CORS reflects the request `Origin` back **only** when it starts with
  `chrome-extension://` or `moz-extension://`. A reflected origin outside that
  set, or a wildcard, is a vulnerability.
- Request bodies are capped at **256 KB** and the listener accepts at most
  **32** concurrent connections.

Things we would very much like to hear about:

- Any way to add, list, modify or read downloads without a valid token.
- Any way to recover or narrow the token — timing, error-message differences,
  logs, crash dumps, or a world-readable file.
- A web page (not an extension) getting a request past the CORS policy.
- Reaching the listener from another machine.
- Path traversal or filename handling that writes outside the download directory
  — the derived name is meant to be sanitised for Windows and stripped of path
  separators.
- Header injection through the headers the extension forwards.
- Anything that turns a downloaded file into code execution: unsafe handling of
  `Content-Disposition`, an installer or updater that fetches over plain HTTP or
  skips verification.
- Resume logic that can be induced to stitch mismatched content into a file that
  still verifies.

## Out of scope

- The absence of code signing on the installers. It is known, and it is why
  SmartScreen warns; checksums are published with every release.
- Vulnerabilities in a site you download *from*, or in a third-party tool you
  point Downpour at.
- Reports whose only finding is that a dependency has a CVE, with no argument
  that Downpour reaches the affected code path.
- Anything requiring an attacker who already has administrator rights on the
  machine, or physical access to an unlocked session.
- Volumetric denial of service against your own loopback listener.
