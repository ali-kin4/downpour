# Media pages

How Downpour turns "paste a video page URL" into a fast, resumable download —
and, just as importantly, what it deliberately does not do.

- Backend: `src-tauri/src/media.rs`
- Frontend: `src/components/MediaDialog.tsx`
- IPC wrappers: `src/lib/api.ts` (the *Media pages* section)

---

## The legal position — read this before changing anything

**Downpour never vendors, bundles, mirrors or commits yt-dlp or ffmpeg, and
never installs either one silently.**

This is not caution for its own sake:

- **yt-dlp has been taken down from GitHub under the DMCA before** (October
  2020, restored two weeks later after the EFF intervened). A copy of the
  binary sitting in this repository, or in the MSI, makes Downpour a
  redistributor of it and inherits that exposure.
- **ffmpeg carries GPL/LGPL redistribution duties.** Shipping it means
  shipping the corresponding licence text, the written offer for source, and
  in the GPL build's case, licensing implications for what it is shipped
  alongside. That is a decision to take deliberately, with a lawyer, not by
  adding a build step.
- **Silently downloading an executable onto someone's machine is not
  acceptable behaviour** regardless of licensing, and antivirus vendors quite
  reasonably treat it as malware behaviour.

So the rules the code enforces:

1. yt-dlp is fetched **only** from the official GitHub releases:
   `https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest`, and then only
   from the `browser_download_url` of an asset in that release.
2. It is fetched **only** after the user clicks a button that has already told
   them what will be downloaded, from where, and where it will be saved. There
   is no install-on-startup, no install-on-first-probe and no automatic retry.
   `install_yt_dlp` is unreachable from any other code path.
3. The download is **verified against `SHA2-256SUMS` from the same release**
   before it is allowed anywhere near the real path, let alone executed. If
   that manifest is missing, or has no line for the exact asset name, the
   install **fails** — an unlisted asset is an unverifiable asset, and the code
   fails closed rather than skipping the check.
4. It is written to a `.part` file and only renamed into place after the hash
   matches. An interrupted install leaves nothing runnable behind.
5. It lands in the app data directory (`…/tools/yt-dlp.exe`) and nowhere else.
   Deleting that one file uninstalls it completely.
6. **ffmpeg is never fetched at all.** That is the direct cause of the
   progressive-only default below.

---

## The key design decision: the direct URL goes to our engine

yt-dlp is used as a **metadata source**, not as a downloader.

`probe_media` asks yt-dlp what a page offers; `resolve_media` asks it for the
direct media URL of one chosen format plus the HTTP headers that URL requires.
That URL is then handed to Downpour's own segmented engine through the normal
add path — the same path the Add dialog, the CLI and the browser extension use.

**Why not just run `yt-dlp <url>` and let it download?** Because that would
make the one feature people came to Downpour for unavailable for exactly the
files they most want it for. yt-dlp downloads on a single connection. It has no
queue, no scheduler, no per-download speed limit, no pause, and no resume that
Downpour's UI can see or drive. Routing through our own engine means a video:

- downloads on up to sixteen connections, with work-stealing between them;
- pauses and resumes from its sidecar, for as long as the link stays valid
  (see the caveat below — media URLs expire, ordinary ones do not);
- honours the scheduler, the concurrency cap and the speed limit;
- appears in the list, the progress window and the tray like anything else;
- is verified and named by the same code as every other download.

The cost is that Downpour can only fetch what a byte-range engine can fetch —
which is what the next two sections are about.

### The headers are not optional

The URLs yt-dlp returns are almost always signed CDN links that are served only
to a request carrying the right `Referer` and `User-Agent`. Fetch the identical
URL without them and the CDN returns **403**, which to a user looks like a
broken feature rather than a missing header.

yt-dlp reports the exact header set it used in each format's `http_headers`.
`resolve_media` forwards that map into `DownloadSpec.headers`, which the engine
already supports for exactly this reason (it is how the browser extension
passes `Cookie`).

**One filter is applied, and it matters.** `Accept-Encoding` is stripped, along
with `Accept-Charset`, `Range`, `Host`, `Content-Length`, `Connection`,
`Transfer-Encoding`, `TE` and `Upgrade`. yt-dlp routinely reports
`Accept-Encoding: gzip, deflate`, but `downpour-core`'s client is built with
compression switched off on purpose — a transfer-encoded body makes the byte
arithmetic that ranged requests depend on ambiguous. Forwarding the header
would request a compressed body that reqwest would then *not* decompress: the
engine would write gzipped bytes to disk and report success. That is silent
corruption, so the header never crosses the boundary. Format-level headers win
over page-level ones; everything else is passed through untouched.

---

## Progressive-only by default

A "progressive" format has **both video and audio in one stream**. Those are
the formats Downpour can download unaided, so they are the only ones shown
until the user asks for more.

Everything else is DASH: a video-only stream and an audio-only stream that have
to be **muxed** into one file. Muxing needs ffmpeg. Downpour does not ship
ffmpeg (see the licensing section), so combining them is out of scope.

The alternative — showing every format and letting someone pick 1080p — would
mean routinely handing a user a 1080p file with no sound. **Downpour must never
silently produce a file with no audio.** So:

- The quality picker defaults to **Video with sound**.
- An **All formats** toggle sits directly above the list, clearly labelled.
- Selecting a non-progressive format shows a plain warning before the Download
  button is ever pressed: *"This is a video-only stream. The file will have no
  sound."* (or the audio-only equivalent).

### The cost of this decision, stated plainly

On YouTube, progressive means format 18 (360p mp4) and sometimes 22 (720p).
Everything above that is DASH. So on YouTube the default list is often a single
360p entry, and on HLS-only sites it is **empty**.

An empty picker with no explanation reads as a broken feature, so the empty
case is handled explicitly: the dialog says the site only offers separate video
and audio streams, that combining them needs ffmpeg which Downpour does not
bundle, and points at the **All formats** toggle in the same sentence.

If Downpour ever ships ffmpeg support, this default is the thing to revisit —
not the direct-URL-to-our-engine decision, which stays correct either way. A
future muxing path would download both streams through our engine and then
invoke ffmpeg locally.

### Playlists (HLS/DASH manifests) are excluded entirely

Separately from progressive-ness, a format whose `protocol` is not plain `http`
or `https` — `m3u8_native`, `http_dash_segments` and friends — is a *manifest*,
not a file. A byte-range engine cannot fetch it at all. Those formats are
listed under **All formats** for honesty, flagged with `directHttp: false`, and
the Download button is disabled with an explanation when one is selected.

---

## The IPC surface

All four commands live in `media.rs` and are registered in `lib.rs`. Errors
cross as plain strings, matching the rest of `commands.rs`.

| Command | Purpose |
| --- | --- |
| `yt_dlp_status()` → `YtDlpStatus` | Is it installed, which version, at what path. Infallible: "not installed" is a normal state the UI renders, not an error. |
| `install_yt_dlp()` → `YtDlpStatus` | Downloads and verifies. **Explicit user action only.** Pushes progress on `downpour://media`. |
| `probe_media(url)` → `MediaInfo` | Title, duration, thumbnail, uploader, and the normalised format list. |
| `resolve_media(url, formatId)` → `ResolvedMedia` | Direct URL, required headers, suggested filename, size. |

`MediaFormat` carries `formatId`, `ext`, `resolution`, `height`, `fps`,
`filesize` (+ `filesizeIsEstimate`), `vcodec`, `acodec`, `progressive`,
`directHttp`, `protocol`, a display `label` and yt-dlp's `format_note`.

Sizes come from `filesize`, then `filesize_approx`, then `tbr × duration`, with
`filesizeIsEstimate` set for the latter two so the UI can say "about" rather
than lying with a precise number. A quality picker with no numbers next to it
is not a choice anyone can make, so an estimate beats a blank.

`resolve_media` **re-runs yt-dlp** rather than reusing the URL from the probe.
That is deliberate, not wasteful: signed URLs expire within minutes, so a link
captured while the user was still choosing a quality is frequently dead by the
time they click Download.

### Expiring URLs are this design's main failure mode

The same expiry that justifies re-resolving also limits what "resumable" means
here. Once a media download is in the queue it holds a signed URL with a
lifetime measured in minutes to hours, so a download that sits behind the
concurrency cap, is paused overnight, or is resumed after a reboot can come
back with a **403** rather than the rest of the file. The engine is behaving
correctly; the link simply died.

The fix, when it is worth building, is to carry the *page* URL and format id
alongside the download and re-resolve on resume instead of retrying the stale
direct URL. Downpour does not do that today — see Known gaps.

---

## Treating yt-dlp as the hostile external process it is

Every invocation:

- runs through `tokio::process::Command` and is fully async, so the Tauri main
  thread is never blocked;
- is spawned with **`CREATE_NO_WINDOW`** on Windows, or a console flashes on
  top of whatever the user is doing on every single probe;
- passes **`--ignore-config`**, so a user's global yt-dlp configuration cannot
  inject an output template, a proxy or a format filter that changes the JSON
  shape or hangs the process;
- passes `--no-playlist --no-warnings --no-progress -J`, and still collapses a
  `_type: playlist` wrapper to its first entry, because some extractors return
  one anyway;
- is bounded by a **timeout** (90s for a probe, 20s for `--version`) with
  `kill_on_drop(true)`, so a hung extractor kills the child rather than the
  dialog waiting forever;
- validates that the URL starts with `http://` or `https://` before it is
  passed as an argument, which is also why no `--` separator is needed.

Four failure modes are handled distinctly, because they need different answers
from the user:

| What happened | What the user sees |
| --- | --- |
| Binary missing | The install offer, naming the tool, the source and the destination. |
| Binary present but will not run | "A copy is already there but will not run: …" — usually antivirus quarantine or an interrupted install. Re-installing fixes it. |
| Non-zero exit | **yt-dlp's stderr, verbatim.** It is genuinely readable — "Video unavailable", "Sign in to confirm your age", "Unsupported URL" — and paraphrasing it into "probe failed" throws away the only useful information in the failure. |
| Timeout / unparseable JSON | An explicit message saying the tool did not answer, or produced output Downpour could not read and may need updating. |

---

## The Add dialog hook

`MediaDialog.tsx` exports `looksLikeMediaPage(url)`, a host allowlist plus a
generic `/watch|/video|/embed|…` path check, with direct file extensions
excluded — a link ending in `.mp4` never needs yt-dlp, even on a video host.

It is a **hint, not a gate**. A false positive costs one dismissible banner; a
false negative just means the user downloads the page's HTML and wonders why.
yt-dlp supports well over a thousand sites and no static list will ever match
that, so anything the sniffer misses is still reachable by pasting the URL.

The whole route is wired into the Add dialog with one line:

```tsx
{looksLikeMediaPage(url.trim()) && <MediaSuggestion url={url.trim()} />}
```

`MediaSuggestion` owns the banner, the dialog and its open state, and pulls
`run`, `toast` and `setAddOpen` from the store itself.

---

## Known gaps

- **Signed URLs expire.** A media download left queued or paused for too long
  will fail with a 403 on resume, because the direct URL it holds has died.
  It has to be re-added from the page. Fixing this properly means storing the
  page URL and format id with the download and re-resolving on resume, which
  needs a field the engine does not have yet.
- **No muxing.** By design; see above. Requires ffmpeg.
- **No HLS/DASH assembly.** Requires a segment-stitching downloader, which is a
  different engine from a byte-range one.
- **No playlist or channel downloads.** `--no-playlist` is hard-coded; batch
  media downloads would want their own flow.
- **Automatic install is written for the Windows asset**, with the macOS and
  Linux asset names and exec bit handled but untested — Downpour is a Windows
  application first.
- **Remote thumbnails need `https:` in the webview `img-src`.** Until then the
  dialog falls back to a placeholder tile rather than a broken-image icon.
- **No auto-update for yt-dlp.** It goes stale, and a stale yt-dlp is the most
  common cause of "this site stopped working". Re-running the install replaces
  it; a periodic "an update is available" check would be a reasonable addition,
  as long as it stays a prompt and never becomes a silent download.
