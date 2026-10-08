# Security Policy

## Supported versions

Only the latest stable release receives security fixes. A fix ships as a new
release, not as a patch to an older line, so the remedy for any advisory is to
update. Downpour checks GitHub for a newer version from **About**; it does not
update itself.

| Version | Supported |
|---|---|
| Latest stable release (currently 1.x) | Yes |
| Any earlier release | No |

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
- `POST /api/v1/pair` is the one other unauthenticated endpoint. It returns
  the token only while a pairing window the user opened in the app is running
  (a few seconds), only to a `chrome-extension://` or `moz-extension://`
  origin, and only once per window.
- Request bodies are capped at **256 KB**.

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
  still verifies. A resume must be confirmed by the validator (strong ETag, or
  Last-Modified without one) the download began with, and every ranged response
  is checked against it.
- Credentials leaking somewhere they were not captured for. Cookies and
  authorization handed over by the browser are sent only to the scheme, host
  and port they were captured for -- never to the host a link redirects to.

## Explicitly in scope: stored browser sessions

A download captured from the browser carries that session's `Cookie` and
`Authorization` headers, because a session-gated file cannot be fetched without
them. The properties Downpour is required to hold for them:

- They are **never written to disk in the clear.** The database keeps them only
  sealed with Windows DPAPI in the current-user scope, so they open only for the
  same Windows account on the same machine. No encryption key is stored by
  Downpour or built into it. Where the platform protection is unavailable, they
  are not stored at all.
- They are kept **only while the download can still use them.** A completed
  download forgets them, and so does any download moved to the history.
- They do not reach the user interface, the confirmation panel, events, or log
  output, and the log text included in copied diagnostics is masked.

Any way to read a stored session without being that Windows user, a session
that survives a download's completion or removal, or one that turns up in the
window, a log or the diagnostics, is a vulnerability.

What is **not** protected against: malware or another program already running
as the same Windows user. DPAPI's current-user scope opens for any process of
that user, which is also true of the browser's own cookie store.

## Out of scope

- The absence of code signing on the installers. It is known, and it is why
  SmartScreen warns; checksums are published with every release.
- Vulnerabilities in a site you download *from*, or in a third-party tool you
  point Downpour at.
- Reports whose only finding is that a dependency has a CVE, with no argument
  that Downpour reaches the affected code path.
- Anything requiring an attacker who already has administrator rights on the
  machine, code running as the same Windows user, or physical access to an
  unlocked session.
- Volumetric denial of service against your own loopback listener.
