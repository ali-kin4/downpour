# What actually makes an HTTP download faster (2026)

Applied research for Downpour. Written 2026-09-11 against the engine as it
stands in `crates/downpour-core`.

**Method and honesty note.** Everything below is either (a) read directly out of
our own source, (b) read out of a primary document — reqwest/hyper source and
docs, an RFC, a vendor manual, a maintainer comment — or (c) explicitly labelled
as *unmeasured*. No benchmark was run while writing this: the brief was one
file, so every "how to measure" below is an instruction for whoever implements
the change, not a result. Where the evidence is thin I say so rather than
rounding it up to a recommendation.

The single most important finding is not in the list of nine questions I was
asked. It is that **we are probably not opening N connections at all.** See R1.

---

## Do this / Don't bother

| # | Change | Expected gain | Effort | Confidence |
|---|---|---|---|---|
| **R1** | **Force HTTP/1.1 on the transfer client (`.http1_only()`)** | Potentially large. Restores real per-segment TCP connections; removes a hard 5 MiB-per-RTT aggregate ceiling | ~1 line + a version assertion in tests | **High** on the mechanism, **medium** on the size of the win — needs measuring |
| **R2** | **Send `Accept-Encoding: identity`; strip caller-supplied `Accept-Encoding`** | Little raw speed; closes a real corruption hole and stops wasting CPU on both ends | Small | **High** |
| **R3** | **Lower connection defaults (4–6 typical, hard cap 16) and back off on 429/503** | Usually neutral-to-positive; avoids throttling and bans. Politeness fix as much as a speed fix | Small | **High** |
| **R4** | **Coalesce writes per worker into a ~2 MiB buffer** | Meaningful above ~500 Mbps and on slow/HDD targets; ~100× fewer `spawn_blocking` round trips | Medium — carries **three** non-negotiable correctness rules | **Medium-high** |
| **R5** | **Adaptive connection count (probe early, keep only if aggregate improves)** | Modest but real on per-connection-throttled hosts; mainly it finds the ceiling instead of guessing | Medium-large | **Medium** |
| R6 | Verify `Repr-Digest` / `Content-Digest` (RFC 9530) when offered | No speed. Free correctness for reassembled multi-connection downloads | Small | High that it's correct; **low** that many servers send it |
| R7 | Consider marking `.dpart` sparse before `set_len` on NTFS | Removes a possible multi-second stall on the first high-offset write | Small | **Low — contested, must be measured** |
| — | HTTP/3 / QUIC | ~0 for large single-file throughput; often negative | Large (unstable feature, `RUSTFLAGS` hack) | High |
| — | Congestion control (BBR vs CUBIC) | 0 — not client-controllable for a download | n/a | High |
| — | `SO_RCVBUF` / manual receive window | 0 or negative on Windows; not exposed by reqwest anyway | n/a | High |
| — | Single writer task fed by a channel | 0 or negative | Medium | High |
| — | `seek_write` / positional writes | ~0 — we already seek once per range, not per chunk | Small | High |
| — | `O_DIRECT` / `FILE_FLAG_NO_BUFFERING` | Negative | Medium | High |
| — | DNS caching / happy-eyeballs / pre-warming | Noise on a multi-minute transfer | Small | High |
| — | Metalink / mirror racing | ~0 for our users; niche | Large | Medium |
| — | `SetFileValidData` | Not shippable (needs admin; leaks stale disk contents) | Small | High |

---

## R1 — We are probably running 16 "connections" over one TCP connection

### The finding

`Cargo.toml` enables reqwest's `http2` feature. reqwest negotiates HTTP/2 by
ALPN whenever the origin offers it — which every major CDN does. And reqwest
**does not open a TCP connection per concurrent request under HTTP/2**; it
multiplexes them as streams onto one connection (or, at most, a small number
bounded by the server's `SETTINGS_MAX_CONCURRENT_STREAMS` — typically 100–128,
so our ≤32 segments all land on one). seanmonstar, 2025-07-10, in
[reqwest discussion #2757](https://github.com/seanmonstar/reqwest/discussions/2757):

> "Trying to add support directly in reqwest…to use multiple http2 connections
> would be quite a bit of work"

Corroboration from a second project hitting exactly this:
[astral-sh/uv#17204](https://github.com/astral-sh/uv/issues/17204) (opened
2025-12-21), *"Option to disable HTTP/2 multiplexing / force separate TCP
connections per download"* — the reporter measures ~100 Mbps instead of ~300 Mbps
because "all concurrent downloads to the same host … are sent over a **single TCP
connection**", and notes the fix is `.http1_only()`.

Two consequences for us, both bad:

**(a) Segmentation stops doing the thing it exists to do.** The honest reason
segmented downloads are faster is not "more TCP is more bandwidth" — it is that
many origins shape *per connection*. Sixteen streams on one TCP connection sit
inside one shaping bucket. We pay 16× the request overhead and 16× the
politeness cost for none of the benefit. Work-stealing in
`transfer.rs::SegmentTable::steal` still helps with per-segment variance, but
the headline mechanism is gone.

**(b) A hard aggregate throughput ceiling from HTTP/2 flow control.** From
hyper's client source (`src/proto/h2/client.rs`):

```rust
const DEFAULT_CONN_WINDOW: u32 = 1024 * 1024 * 5; // 5mb
const DEFAULT_STREAM_WINDOW: u32 = 1024 * 1024 * 2; // 2mb
const DEFAULT_MAX_FRAME_SIZE: u32 = 1024 * 16; // 16kb
```

reqwest's `http2_adaptive_window` defaults to `false`, so those are the values in
force. Throughput over a flow-controlled connection is `window / RTT`:

| RTT | Aggregate cap (5 MiB conn window) | Per-stream cap (2 MiB) |
|---|---|---|
| 20 ms | 262 MB/s (~2.1 Gbps) | 105 MB/s |
| 50 ms | 105 MB/s (~840 Mbps) | 42 MB/s |
| 100 ms | 52 MB/s (~420 Mbps) | 21 MB/s |
| 200 ms | 26 MB/s (~210 Mbps) | 10 MB/s |

Be precise about where this bites: a CDN edge is usually 5–30 ms away, where
5 MiB/RTT is 175–1000 MB/s and the window is *not* binding. Ceiling (b) is a
**distant-origin** problem — a university mirror, an object store in another
region, a self-hosted server across an ocean. At 100 ms the entire download is
capped at ~420 Mbps regardless of how many segments we plan, because they all
share one 5 MiB window. N real TCP connections have no such shared cap: each
gets its own OS receive window, and Windows autotunes those up to 16 MB per
connection (see R-not-doing-4).

Problem (a), by contrast, bites at **any** RTT, on any host that shapes per
connection — which is the common case and the larger, more general win. Keep the
two apart when you test (see below).

Note also that `pool_max_idle_per_host(32)` in `transfer.rs::build_client` is
largely inert under HTTP/2 — it bounds *idle* connections in the pool, and under
h2 there is one active connection being reused, not 32 idle ones. (Aside: reqwest
0.13 documents the default for that setting as `usize::MAX`, so our "generous"
32 is actually a tightening, not a loosening. Harmless either way.)

### What to change

`crates/downpour-core/src/transfer.rs`, `build_client()`:

```rust
Client::builder()
    .user_agent(user_agent)
    .http1_only()                    // ← segmented downloads want real connections
    .pool_max_idle_per_host(32)
    ...
```

Keep `pool_max_idle_per_host(32)` — under HTTP/1.1 it now actually matters,
because it stops the 16 connections being torn down and re-handshaked between
segments (which is exactly what the existing doc comment claims it is for, and
is true only once h2 is off).

Note there is only **one** `Client` in the engine — `engine.rs:115`
(`Engine::with_store`) builds it and `probe`, `plain_transfer` and every
`stream_range` share it. So `http1_only` applies to probing too. That is
harmless: `probe::probe` is a single 1-byte ranged GET and does not care about
protocol version. If you ever want them to differ you must build a second
`Client`; today the code offers no such split.

If you would rather not commit to h1 globally, the *mitigation* (not the fix) is
`.http2_adaptive_window(true)`, which lets hyper grow the windows from a BDP
estimate. That removes ceiling (b) but not problem (a). I would take
`http1_only`.

### Why it works mechanically

Each HTTP/1.1 request gets its own socket, its own kernel receive buffer, its
own autotuned receive window, its own congestion window, and — critically — its
own slot in whatever per-connection token bucket the origin runs.

### How to measure

1. **First, confirm the premise.** In `stream_range`, log `response.version()`
   once per segment. If it prints `HTTP/2.0` for your test URLs, you have the
   bug. This is a two-line temporary patch and settles the whole question.
2. Count sockets while a download runs:
   `Get-NetTCPConnection -State Established | Where-Object RemotePort -eq 443 | Measure-Object`.
   Before: expect ~1 per host. After: expect ~N.
3. A/B `http1_only` on/off across a **2×2 matrix**, because the two mechanisms
   have opposite profiles and a single test will mislead you:

   | | Low RTT (<30 ms) | High RTT (>80 ms) |
   |---|---|---|
   | **Unthrottled host** | expect ~no change (neither mechanism binds) | expect a win from ceiling (b) |
   | **Per-connection-throttled host** | **expect the biggest win** — mechanism (a) | expect a win from both |

   3 runs per cell, alternating order to cancel network drift, comparing
   `SpeedTracker::average_bps` at completion. A "no difference" result in the
   top-left cell is the *expected* outcome, not evidence against R1 — the common
   mistake is testing only a nearby CDN and concluding the change does nothing.

### Caveats

- A handful of origins are h2-only in practice (rare over TLS; ALPN will simply
  not offer h1 and the connection fails). If you see that, make it a per-host
  fallback rather than reverting globally.
- This makes us *more* visible to origins as a multi-connection client. Pair it
  with R3.

---

## R2 — Stop asking for content encoding

### What is actually true (and what is folklore)

The widely repeated claim is: "`Accept-Encoding: gzip` plus `Range` corrupts
segmented downloads, because byte ranges are defined over the *encoded*
representation (RFC 9110 §14.1) but the client writes *decoded* bytes."

The premise is correct. **But reqwest already guards the common case**, and it
is worth knowing that before writing a panicked fix. From the reqwest
`ClientBuilder::gzip` docs (identical wording in 0.12 and 0.13.5):

> "When sending a request and if the request's headers do not already contain an
> `Accept-Encoding` **and** `Range` values, the `Accept-Encoding` header is set
> to `gzip`."

We set `RANGE` in both `probe::probe` and `transfer::stream_range`, so reqwest
does not add `Accept-Encoding` there and does not decode. The segmented path is
safe today. Good.

### The hole that is actually open

1. **`probe::build_headers` strips `Range` but not `Accept-Encoding`.** If a
   caller supplies one — the CLI's header flag, or a future extension change —
   reqwest sees `Accept-Encoding` already present, so it *does not* auto-decode,
   and we write raw gzip/zstd bytes into the file at range offsets. Silent
   corruption that passes the length check in `run_transfer` (the file was
   `set_len`'d, so the length is right by construction) and is caught only by a
   user-supplied sha256. The current extension (`extension/background.js`,
   `collectHeaders`) sends only `Cookie`, `Referer` and `User-Agent`, so this is
   not live — but it is one commit away.
2. **`plain_transfer` sends no `Range`**, so reqwest *does* advertise
   `gzip, br, deflate` and decode. For a download manager this is pure waste:
   the server burns CPU compressing, we burn CPU decompressing, and for the
   .zip/.mp4/.iso payloads that dominate a download queue the ratio is ~1.0.
   It also destroys `Content-Length`, which is how
   [aria2#2210](https://github.com/aria2/aria2/issues/2210) (2024-05-09)
   describes the same problem: "the length of the Body after Compress is
   uncertain, the response header does not exist `Content-Length`, and the file
   size cannot be obtained."
3. **`zstd` is not in our feature list** (`gzip`, `brotli`, `deflate` only).
   A caller-supplied `Accept-Encoding: …, zstd` that a server honours produces
   undecodable bytes on disk.

### What every other download manager does

- **aria2**: `--http-accept-gzip`, "Default: `false`"
  ([aria2c(1) manual](https://aria2.github.io/manual/en/html/aria2c.html)).
- **curl**: compression is opt-in via `--compressed`; without it curl sends no
  `Accept-Encoding`.
- **wget**: no compression by default.

Nobody requests compression when the job is to fetch a file. We should match.

**Precision on what "match" means:** all three send *no* `Accept-Encoding`
header at all, which is what `.no_gzip().no_brotli().no_deflate()` alone
achieves. Sending an explicit `Accept-Encoding: identity` goes one step further —
it actively declares every other coding unacceptable, and a strict server is
entitled to answer 406. I still favour it, because it makes our intent legible on
the wire instead of resting on a library heuristic (below), and 406-on-identity
is a theoretical rather than observed problem. But it is our choice, not
precedent from curl/wget/aria2.

### What to change

`crates/downpour-core/src/transfer.rs`, `build_client()`:

```rust
.no_gzip().no_brotli().no_deflate()
```

and in `crates/downpour-core/src/probe.rs`, `build_headers()`, extend the
existing `Range` filter to also drop `accept-encoding`, then insert
`ACCEPT_ENCODING: identity` unconditionally. The existing test
`build_headers_drops_caller_supplied_range` is the obvious place to add the
mirror case.

Doing *both* matters: `.no_*()` makes reqwest stop advertising and stop
decoding; `identity` makes our intent explicit on the wire so behaviour no longer
depends on an undocumented-feeling library rule about the `Range` header. Add a
regression test that asserts no `Content-Encoding` comes back — the axum test
server in `tests/common/mod.rs` can serve a gzip response and assert we reject
or refuse it.

### Cost

Losing compression on the rare genuinely-compressible download (a big .csv, .log
or .json). That is a real but small loss, and it is the trade every other
download tool makes. If you want it back, gate it on `Content-Type` after the
probe and only for the non-segmented path.

---

## R3 — Fewer connections, and back off when told to

### Evidence

- **Microsoft Edge ships parallel downloads with 3 connections.** Eric Lawrence
  (Edge/Fiddler), [*Parallel Downloading*](https://textslashplain.com/2024/11/22/parallel-downloading/),
  2024-11-22: "Edge 148 enables parallel downloads by default, using 3
  simultaneous connections."
- The same article states the mechanism plainly, and it is the most useful
  sentence in this whole document: parallel downloads *"should never be faster"*
  in theory — the wins come only from (1) circumventing per-connection
  throttling and (2) mitigating TCP head-of-line blocking on lossy links. If
  neither applies, extra connections are pure overhead: extra handshakes, extra
  slow-starts, extra TLS.
- Common practitioner guidance converges on 4 being a good number, 2 already
  capturing most of the win on lossy links, and >16 essentially never paying.
  Many origins cap connections per client outright and some will throttle or
  temporarily ban above their limit.

Our current settings: `settings.rs` defaults `max_connections_per_download: 8`
and clamps to `1..=32`; `resume.rs::connections_for_size` ramps 1/2/4/8/16 by
size. The ramp is sensible. The 32 cap is not.

### What to change

- `crates/downpour-core/src/settings.rs`: clamp `max_connections_per_download`
  to `1..=16`, not `1..=32`. Consider dropping the default from 8 to 6.
  (`max_concurrent_downloads` clamping to 32 is a different axis and is fine.)
- `crates/downpour-core/src/resume.rs::connections_for_size`: leave the shape;
  cap the top tier at 8–12 rather than 16 unless R5 lands.
- `crates/downpour-core/src/transfer.rs::fetch_segment`: **handle 429 and 503
  properly.** I checked `error.rs::is_transient` — 429 *is* treated as
  retryable:

  ```rust
  Error::BadStatus { status, .. } => {
      // 408 timeout, 429 rate limit, 5xx server-side.
      *status == 408 || *status == 429 || (*status >= 500 && *status < 600)
  }
  ```

  So today a rate-limited segment is retried on **our** `backoff_delay`
  schedule, with `Retry-After` never read, at the same connection count that
  earned the 429. Worse, `fetch_segment` resets `attempts = 0` whenever the
  cursor moved since the last attempt — so a host that 429s intermittently while
  still dribbling out bytes is retried *indefinitely*, never exhausting
  `max_retries`. That is the shape of a client that gets IP-banned.

  It should (a) parse `Retry-After` and honour it instead of `backoff_delay`,
  and (b) *reduce the connection count for this host* rather than retrying at
  the same width — retire the worker and let the survivors steal its range
  (`SegmentTable::steal` already handles the redistribution). A sticky per-host
  ceiling in a small map on the engine, seeded from past 429s, is the polite
  version.

### Politeness flag

**32 connections to one origin is antisocial and I would not ship it.** It is
indistinguishable from a small DoS from the origin's side, it is exactly the
signature CDNs rate-limit on, and it demonstrably does not make downloads
faster. Lower the cap and treat 429 as a hard instruction, not a transient blip.

### How to measure

Log final `average_bps` across N ∈ {1, 2, 4, 8, 16} against 3–4 real origins
(a CDN-backed release binary, a university mirror, a cloud object store, a
throttled file host), 3 runs each, alternating order to cancel out network
drift. Expect a knee somewhere between 2 and 6 for most, and a much later knee
only for hosts that shape per connection. Record 429/503 counts alongside.

---

## R4 — Coalesce writes per worker

### The current cost

`transfer.rs::stream_range` does, per chunk from `response.bytes_stream()`:
a `control.check()` atomic load, a `table.lock()` to read bounds, a
`limiter.acquire()` (mutex), `file.write_all(...)`, a second `table.lock()` to
advance, and an atomic add on progress. Then `file.flush()` once per range.

Chunk size is set by the transport. Under HTTP/2 it is bounded by
`DEFAULT_MAX_FRAME_SIZE = 16 KiB`; under HTTP/1.1 hyper's read buffer is
adaptive but still in the tens of KiB. Call it 16–64 KiB. At 1 Gbps
(125 MB/s) that is roughly 2,000–8,000 iterations per second per download.

The expensive one is `write_all`. `tokio::fs::File` is not async I/O; every
operation is a `spawn_blocking` round trip to the blocking thread pool, plus a
copy into its internal buffer. Tokio's own docs are explicit that the fix is
batching:

> "Use `tokio::fs::read`/`write` for small files… Wrap `File` in `BufReader` or
> `BufWriter`… `File::set_max_buf_size` controls the byte limit per
> `spawn_blocking` call (default 2 MB)."

Thousands of blocking-pool dispatches per second per download, times several
concurrent downloads, is measurable scheduler pressure and thread churn. It is
not the dominant cost at 100 Mbps. It plausibly is at 1 Gbps+, and it is
definitely worse on a spinning disk where each small write extends NTFS's valid
data length.

### What to change

In `transfer.rs::stream_range`, accumulate into a `Vec<u8>` (or `BytesMut`)
sized ~2 MiB and flush when full, when the segment boundary is reached, or when
the stream ends. Do **not** introduce a `BufWriter` wrapper naïvely — each
worker seeks its own handle, and a `BufWriter` whose buffer straddles a seek
will write bytes at the wrong offset. Own the buffer explicitly alongside the
`cursor` variable that already exists.

### The correctness rules this change must carry — all three

Buffering separates *receipt* from *write*. Two invariants that hold today only
because those are the same instant now come apart.

**Rule 1 — advance the segment cursor only on flush.** Today
`table.lock().advance(idx, n)` runs after `write_all` returns, so a sidecar
cursor implies the bytes reached the OS. Buffer 2 MiB in user space without
changing that and a process kill leaves a sidecar claiming bytes that were never
written — and `load_resumable` accepts it, because it only checks the part
file's *length*, which `set_len` already made correct. Silent corruption on
resume: exactly the failure class this engine's comments say it exists to
prevent. Keep a separate in-flight counter for the progress bar if you want
smooth UI. This also fixes the 1-second `saver` task for free — it can no longer
`persist()` a snapshot ahead of what was flushed.

**Rule 2 — move the boundary clamp from receipt to flush.** This is the
subtle one, and it is a live bug, not a theoretical race. `SegmentTable::steal`
computes `split_at = seg.cursor + remaining / 2`. If our cursor lags 2 MiB
behind what we have received, a thief can set our `end` to a value *below* bytes
already sitting in our buffer. On flush we would then write bytes that now
belong to another worker (same content, so not data corruption — but a duplicate
write), and `advance` would push `cursor` past `end + 1`. That trips
`Sidecar::validate`'s `cursor > s.end + 1` check, so the very next `persist()`
returns `CorruptMetadata` and `segmented_transfer` fails a download that
actually succeeded.

The existing per-chunk clamp

```rust
let allowed = (current_end - cursor + 1) as usize;
```

protects against this today *only* because receipt and write coincide. It must
be re-evaluated against a freshly read `bounds(idx).1` **at flush time**, with
any buffered bytes past the new boundary discarded.

**Rule 3 — `DEFAULT_MIN_STEAL_BYTES` must be ≥ the write buffer.** It is
currently 1 MiB, and `steal` only fires when `remaining >= min_steal_bytes * 2`,
so the smallest possible split lands 1 MiB ahead of the donor's cursor. With a
2 MiB buffer that is *inside* the buffer — Rule 2's situation is the common case,
not an edge case. Either raise `DEFAULT_MIN_STEAL_BYTES` to at least the buffer
size, or size the buffer below it. Pick one deliberately and add a
`const _: () = assert!(...)` or a unit test in `transfer.rs::tests` so a later
tuning change cannot quietly break the relationship.

While you are here, a pre-existing weakness worth writing down: **`file.flush()`
on `tokio::fs::File` is not an fsync.** The docs say so:

> "Note that this does not ensure that the file has been fully written to disk;
> the operating system might keep the changes around in an in-memory buffer."

So the sidecar's durability is already weaker than the module comments imply: a
process crash is safe, a power cut is not. `sync_data()` before each `persist`
would close it, at a cost you probably do not want once per second. My advice is
to accept it and correct the comment rather than pay for fsync — but decide
deliberately.

### How to measure

- CPU: run a 5 GB download from a LAN HTTP server (so the network is not the
  limit) and compare process CPU% and wall time before/after. A LAN source is
  essential; over the internet the network will mask everything.
- Blocking-pool pressure: `tokio-console`, or simply count `write_all` calls
  with a counter and log it at completion.
- Disk: `Get-Counter '\PhysicalDisk(*)\Avg. Disk sec/Write'` during the run.
- Buffer size sweep: 256 KiB / 1 MiB / 2 MiB / 8 MiB. Expect the curve to
  flatten by 1–2 MiB; larger buffers only increase what a crash loses.

---

## R5 — Adaptive connection count

The defensible algorithm, and the traps:

1. Start at `connections_for_size(total, max)` (unchanged).
2. **Only probe during the first ~40% of the transfer.** Late in a transfer
   the work-stealing in `SegmentTable::steal` already owns the tail, and adding
   a connection then just creates a segment nobody has time to finish.
3. Sample aggregate throughput over a fixed window (≥5 s — anything shorter is
   dominated by TCP slow-start on the new connection and by `SpeedTracker`'s own
   smoothing). `speed.rs::SpeedTracker::sample_at` already gives you the number.
4. Add **one** connection. Wait a **hold-down** of ≥10 s (new connection must
   exit slow start). Re-sample.
5. Keep it only if aggregate improved by a clear margin — 10% is a defensible
   threshold; smaller than that is inside the noise of a real internet path.
   Otherwise retire the worker and **stop probing for this transfer** (one
   failed probe is enough; repeatedly re-testing is how you end up hammering).
6. Any 429/503 → decrement, mark the host sticky-limited, stop probing.

Traps, in order of how likely they are to bite:

- **Without a hold-down you will measure slow-start, conclude "no gain", and
  retire a connection that would have helped.**
- **Without hysteresis you oscillate**, which is worse than a fixed count
  because every add/remove costs a handshake.
- **Aggregate, never per-connection.** Per-connection throughput *falling* while
  aggregate rises is the expected and correct outcome of adding a connection to
  a shared bottleneck.
- **Nothing works until R1 lands.** Under HTTP/2 multiplexing, adding a
  "connection" adds a stream to the same 5 MiB window; the probe will correctly
  measure "no gain" every time and the whole feature will look useless.

### What to change

`transfer.rs::segmented_transfer` currently fixes `worker_count` at spawn time
and joins a fixed `Vec` of handles. Adaptivity needs workers that can be spawned
mid-flight and retired cleanly. The cheapest shape: keep a `JoinSet`, have a
supervisor task hold the `Arc<TransferProgress>` and the `Arc<Mutex<SegmentTable>>`,
and let a retiring worker simply return `Ok(())` — `worker_loop` already retires
gracefully when `claim_or_steal()` returns `None`, so you mainly need a
"please stop after this segment" flag per worker.

This is the highest-effort item on the list and the one I would do last.

---

## R6 — RFC 9530 digest verification (new since 2024)

[RFC 9530 *Digest Fields*](https://www.rfc-editor.org/rfc/rfc9530.html)
(Standards Track, February 2024) replaces the old `Digest`/`Want-Digest` of
RFC 3230 with `Content-Digest` (integrity of the bytes on *this* message) and
`Repr-Digest` (integrity of the whole representation). Its stated use cases
include, verbatim, validating "the integrity of a resource that was
reconstructed from parts retrieved using multiple requests or connections" —
which is a one-sentence description of what `transfer.rs` does.

`Repr-Digest` is the useful one for us: it is stable across ranged responses,
so if a server sends it on the probe response we get a free end-to-end checksum
for a download where the user supplied none.

**What to change:** capture `Repr-Digest` in `probe.rs::probe` into
`RemoteInfo`, and in `run_transfer` use it as `config.checksum` when the user
did not supply one. Store it in the sidecar so a resume can re-validate it
(`resume.rs::Sidecar::check_still_valid` is the natural home).

**Caveat — the reason this is R6 and not R2:** I found no evidence of meaningful
CDN deployment. Treat this as cheap insurance that fires rarely, not as a
feature. Do not make it mandatory, and do not fail a download because a server
sent a digest in a format we did not parse.

Also new-ish and worth a line: `zstd` is now a widely supported content coding,
and reqwest has a `zstd` feature. Given R2 says we should stop accepting content
codings entirely, the only relevance is defensive — we must not end up with
`zstd` bytes we cannot decode, which R2's header stripping prevents.

---

## R7 — NTFS preallocation (contested; measure before acting)

`segmented_transfer` does `File::create` + `set_len(total)`. On Windows that
sets end-of-file but leaves NTFS's *valid data length* at 0. When a worker then
writes at, say, offset 900 MB of a 1 GB file — which is exactly what segment 15
does, immediately — NTFS must zero-fill everything between the current valid
data length and that offset before the write lands.

Eric Lawrence reports Edge hitting something in this family: pre-allocating the
destination "causing UI freezes on slow storage devices"
([textslashplain, 2024-11-22](https://textslashplain.com/2024/11/22/parallel-downloading/)).

The three options:

- **Mark the file sparse** (`FSCTL_SET_SPARSE`) before `set_len`. No zero-fill;
  blocks allocate on write. Costs fragmentation, and you must decide whether to
  clear the sparse flag before the rename in `run_transfer`. Edge appears to do
  the sparse thing.
- **`SetFileValidData`** — instant, and **not shippable**. It requires
  `SE_MANAGE_VOLUME_NAME` (administrator), and it exposes whatever stale bytes
  were previously on those disk sectors to the file. Microsoft's own docs warn
  it has "no performance gain… and sometimes a performance penalty" outside
  large random-write workloads. libtorrent's
  [issue #3622](https://github.com/arvidn/libtorrent/issues/3622) is a long
  account of how badly this fails for unprivileged users — it silently no-ops
  and leaves a sparse file while "lying to the users". Don't.
- **Leave it alone.** Defensible. The cost is paid once, lazily, and modern NVMe
  zeroes fast.

**I do not have data on whether this matters for us, and I am not going to
pretend otherwise.** Measure it: time from `run_transfer` entry to the first
`advance()` on the *highest-offset* segment, for a 4 GB file, on (a) NVMe and
(b) a USB HDD, with and without the sparse flag. Check the flag with
`fsutil sparse queryflag <file>`. If NVMe shows <200 ms, ship nothing.

---

## Don't bother — with reasons

### HTTP/3 and QUIC

**Status of reqwest support:** still unstable in 2026. It requires both the
`http3` cargo feature *and* `RUSTFLAGS="--cfg reqwest_unstable"`, and reqwest's
own docs say unstable features may change in patch releases. The tracking issue
[seanmonstar/reqwest#2303](https://github.com/seanmonstar/reqwest/issues/2303)
(opened 2024-06-04) still lists open blockers — streaming request bodies, h3/quic
types leaking into the public API, and a `Sync` breaking change — with little
movement. Not production-ready.

**Would it even help?** For *large single-file throughput*, no. QUIC's wins are
handshake latency (0-RTT/1-RTT), connection migration, and per-stream loss
recovery without TCP head-of-line blocking. Throughput on a clean path is at
best a wash, and userspace per-packet processing costs CPU that kernel TCP does
not: current measurements put QUIC within a few percent of TCP on clean paths
and *behind* on fast, low-loss wired links, with pathological cases much worse.
Eric Lawrence makes the structural point from the other direction: HTTP/3 fixes
TCP head-of-line blocking, which is one of only two reasons parallel downloading
helps at all — so a hypothetical h3 download manager would want *fewer* streams,
not more, and would still be inside one connection's shaping bucket. That is R1's
problem again, in a new protocol.

**Verdict:** the multiplexing-vs-N-connections question answers itself. For a
download manager, single-connection multiplexing (h2 *or* h3) removes exactly
the mechanism that makes segmentation work. Revisit if and when a significant
number of origins become h3-only.

### Congestion control (BBRv3 vs CUBIC)

**Blunt answer: we cannot influence it, and it is not ours to influence.** For a
GET the client sends almost nothing; the download's sending congestion control
runs on the *server*. What the client controls is its *receive window*, which is
flow control, not congestion control.

On Windows the algorithm is a machine-wide, admin-only setting
(`netsh int tcp set supplemental Template=Internet CongestionProvider=…`);
CUBIC has been the default since Windows 10, with BBR2 available from 11 22H2.
There is no per-application or per-socket knob. Worse, enabling BBR2 on
Windows 11 23H2/24H2 is widely reported to break local TCP connections. A
download manager that changed a system-wide TCP template would be doing
something indefensible.

The only client-side lever in this family is the reqwest HTTP/3 builder's
`http3_congestion_bbr()` — which selects BBR for *our sending* over QUIC, which
for a download is ~nothing, on a feature we are not shipping (see above).

### `SO_RCVBUF` and socket tuning

`reqwest::ClientBuilder` exposes `tcp_nodelay` (default `true` — correct for us,
leave it), `tcp_keepalive`, `local_address`, `interface`. **It exposes no receive
buffer option at all**, so this is moot without dropping to a custom connector.

And you would not want to. Since Vista, Windows Receive Window Auto-Tuning
measures BDP and application retrieve rate per connection and scales the window
up to 16 MB. Microsoft's own description of the pre-Vista world is the argument
against doing it manually: a fixed size "can increase throughput for some
connections and decrease throughput for others" and "does not vary with changes
in the application retrieve rate or congestion in the transmission path"
([The Cable Guy: TCP Receive Window Auto-Tuning](https://learn.microsoft.com/en-us/previous-versions/technet-magazine/cc162519(v=msdn.10))).
Setting `SO_RCVBUF` explicitly is the documented way to *opt out* of autotuning.
Do not.

Read buffer sizes on our side are hyper's business and hyper sizes them
adaptively. There is nothing here.

### A single writer task fed by a channel

**No.** Workers write to *disjoint* offsets through *separate* file handles.
There is no lock contention to remove and no ordering to enforce. A channel
would add a copy, add a queue, and cap the whole download at one thread's write
rate — converting an embarrassingly parallel write pattern into a serial one.
The win available on the write path is batching (R4), not centralisation.

### `seek_write` / positional writes

Marginal at best. We call `file.seek()` **once per `stream_range` invocation**,
not per chunk — each worker holds its own handle with its own file position, and
sequential `write_all`s advance it. Replacing one seek per segment-attempt with
positional writes saves one syscall per segment. If you implement R4 the
per-write count drops another 100×, making this even less interesting. Skip.

### `O_DIRECT` / `FILE_FLAG_NO_BUFFERING`

Actively wrong for this workload. It demands sector-aligned buffers, offsets and
lengths — our segment boundaries are arbitrary — and it bypasses the page cache,
which is precisely where a just-downloaded file wants to be when the user opens
it or when we hash it in `sha256_file`. It exists for databases that manage
their own cache. Not us.

**Writeback stalls on slow disks** are real, and there is no good client-side
lever. When Windows hits its dirty-page threshold it throttles writers, and a
bigger user-space buffer only moves where the stall appears. The honest answer
is: measure `Avg. Disk sec/Write`, and if the disk is the bottleneck, no HTTP
tuning will help — surface it in the UI instead of pretending it is a network
problem.

### DNS, happy eyeballs, connection pre-warming

Noise. One DNS lookup and one TLS handshake is maybe 50–300 ms at the front of a
transfer that lasts minutes. Optimising it is rounding error. It *could* matter
across a 20-link queue of small files — and the engine already gets that for
free, because `engine.rs` builds one `Client` in `with_store()` and shares it, so
the connection pool and hyper's DNS resolution are already reused across items.
Nothing to do.

The one genuine caveat: rebuilding the client in `update_settings` (engine.rs
~line 550) throws the pool away. That is correct behaviour for a UA change and
happens rarely. Leave it.

### Metalink and mirror racing

[RFC 5854](https://datatracker.ietf.org/doc/rfc5854/) (Metalink XML) and
[RFC 6249](https://www.rfc-editor.org/rfc/rfc6249.html) (Metalink/HTTP via `Link`
headers) are both still alive in 2026 — aria2 supports both, and Fedora's
MirrorManager and Ubuntu ISO distribution still emit metalinks. So "is it dead"
is: **no, but it is confined to Linux distribution mirrors.**

For Downpour's users — browser-captured downloads, release binaries, media —
essentially nothing they download will have mirrors. Racing several mirrors and
cancelling losers also wastes other people's bandwidth by design, which is the
same politeness problem as R3 with a worse ratio. Build it only if a user asks,
and if you do, use it for *failover* (retry the next mirror on error) rather
than racing.

---

## Myths

**"More connections means more bandwidth."** False as stated. TCP gives each
connection a share of a bottleneck; N connections at a congested link get N/(N+k)
instead of 1/(1+k), which is a fairness grab, not free bandwidth. The real
mechanisms are only two, per Lawrence: defeating per-connection server
throttling, and independent loss recovery on lossy links. If neither applies,
extra connections are strictly worse — more handshakes, more slow-starts, more
TLS, and more chance of a 429.

**"Set `pool_max_idle_per_host` high and you get many connections."** No. It
bounds *idle* connections retained for reuse. Under HTTP/2 there is one active
connection regardless (R1). Our own doc comment in `build_client` reads as if
this setting produces parallelism; it does not.

**"HTTP/2 makes downloads faster."** For a download manager it is a
pessimisation: it collapses N segments into one TCP connection and imposes a
5 MiB-per-RTT aggregate flow-control ceiling that plain TCP does not have. This
is the opposite of the received wisdom, and it is the finding I am most
confident about mechanically and least confident about in magnitude.

**"HTTP/3 is faster."** For page loads on lossy mobile links, often. For a
single large file on a wired link, no — QUIC's userspace packet processing costs
CPU that kernel TCP does not, and current measurements put it at parity to
modestly behind on clean paths.

**"Enable BBR to download faster."** Not a client-side thing for downloads. The
server's congestion control governs the send rate. The Windows setting is
machine-wide, admin-only, and currently buggy on 23H2+.

**"Bump `SO_RCVBUF` / disable Windows autotuning / apply a registry 'TCP
optimizer'."** Fixed windows were the pre-Vista world and Microsoft replaced
them for good reasons. Setting the buffer explicitly opts you *out* of the
per-connection BDP measurement that is doing the right thing for you.

**"`Accept-Encoding: gzip` corrupts ranged downloads in reqwest."** Not by
default — reqwest documents that it skips adding `Accept-Encoding` when a `Range`
header is present, which covers our segmented path. The exposure is narrower
than the folklore: *caller-supplied* encoding headers, and the non-ranged
`plain_transfer`. Fix it anyway (R2), because relying on a library's header
heuristic for a correctness property is not a good place to be.

**"Preallocate with `SetFileValidData` for instant allocation."** Requires
administrator, exposes stale disk sectors into the file, and Microsoft documents
it as usually offering no gain. Every torrent client that tried it has a bug
report about it.

**"A single writer thread avoids disk contention."** There is no contention:
disjoint offsets, separate handles. It would serialise a parallel workload.

---

## Correctness and politeness flags

Things below trade something real for speed. My recommendation is that we do not
ship any of them:

1. **32 connections per host.** Antisocial, gets users rate-limited or IP-banned,
   and does not make downloads faster (R3). Cap at 16, default lower.
2. **Ignoring 429 / `Retry-After` and retrying with our own backoff.** That is
   what `fetch_segment` effectively does today. A 429 is an instruction, not a
   transient network blip.
3. **Mirror racing** (if R-not-doing-metalink were ever revisited): downloading
   the same bytes from several servers and throwing most away wastes other
   people's bandwidth proportionally to the number of mirrors raced.
4. **`SetFileValidData`**: a genuine information-disclosure bug, not just bad
   manners — it makes previously-deleted disk contents readable through our
   part file.
5. **Buffering writes without all three of R4's rules** (cursor advances on
   flush; boundary clamp re-evaluated at flush; `min_steal_bytes` ≥ buffer):
   trades resume correctness — and, via rule 2, spurious `CorruptMetadata`
   failures on successful downloads — for throughput. Not negotiable.

---

## A benchmark harness worth building first

None of the above is worth implementing blind. Before R1, I would build a small
`benches/` or an ignored integration test that:

- serves a 2–5 GB file from the existing axum harness in
  `crates/downpour-core/tests/common/mod.rs`, with switchable per-connection
  rate limiting and switchable artificial RTT (a `tokio::time::sleep` in the
  handler approximates it well enough to expose window-size ceilings);
- runs `run_transfer` with a matrix of (connections, http1_only, buffer size);
- reports `average_bps`, wall time, peak RSS, process CPU seconds, and count of
  `write_all` calls.

An artificial-RTT knob is the single most valuable thing in that list, because
every flow-control ceiling in this document is invisible at 1 ms RTT and
dominant at 100 ms. Most "we benchmarked it and saw no difference" results in
this space are LAN tests.

---

## Ranked: top 5 by gain/effort

1. **R1 — `.http1_only()` on the transfer client.** One line. Restores the
   mechanism segmentation depends on and removes a hard per-RTT ceiling.
   *Verify the premise first with a `response.version()` log.*
2. **R2 — `Accept-Encoding: identity` + strip caller-supplied encodings.**
   Small, closes a corruption hole, matches curl/wget/aria2, saves CPU.
3. **R3 — Connection cap 16, default 6, honour 429/`Retry-After` per host.**
   Small, and it is the difference between a good citizen and a client CDNs
   learn to block.
4. **R4 — Per-worker write coalescing at ~2 MiB.** Medium effort; the gain shows
   up exactly where our users on fast lines and slow disks live. Read all three
   correctness rules before writing a line of it — rule 2 (re-clamp against the
   segment boundary at flush time, because a thief can move `end` backwards past
   buffered bytes) is the one that will otherwise fail successful downloads with
   `CorruptMetadata`.
5. **R5 — Adaptive connection count with hold-down and hysteresis.** The most
   work, and pointless until R1 lands — but it is the only item that replaces a
   guess (`connections_for_size`) with a measurement.

---

## Sources

- [reqwest `ClientBuilder` docs (0.13.5, 2026-09-08)](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html) — `gzip` Accept-Encoding/Range rule, h2 knobs, h3 knobs, `tcp_nodelay` default, absence of any receive-buffer option
- [reqwest `ClientBuilder` docs (0.12.x)](https://docs.rs/reqwest/0.12.23/reqwest/struct.ClientBuilder.html) — same Range rule in the version we pin
- [seanmonstar/reqwest discussion #2757, "HTTP2 multiple connection pooling" (2025-07-10)](https://github.com/seanmonstar/reqwest/discussions/2757) — maintainer confirms one h2 connection per host
- [seanmonstar/reqwest issue #2303, "Stabilize HTTP/3 feature" (opened 2024-06-04)](https://github.com/seanmonstar/reqwest/issues/2303) — open blockers, still unstable
- [astral-sh/uv issue #17204 (2025-12-21)](https://github.com/astral-sh/uv/issues/17204) — measured ~100 vs ~300 Mbps from h2 multiplexing; `.http1_only()` named as the fix
- [hyper `src/proto/h2/client.rs`](https://github.com/hyperium/hyper/blob/master/src/proto/h2/client.rs) — `DEFAULT_CONN_WINDOW = 5 MiB`, `DEFAULT_STREAM_WINDOW = 2 MiB`, `DEFAULT_MAX_FRAME_SIZE = 16 KiB`
- [hyper `client::conn::http2::Builder` docs](https://docs.rs/hyper/latest/hyper/client/conn/http2/struct.Builder.html) — `adaptive_window` default `false`
- [Eric Lawrence, "Parallel Downloading", text/plain (2024-11-22)](https://textslashplain.com/2024/11/22/parallel-downloading/) — Edge 148 uses 3 connections; why parallel downloads "should never be faster"; sparse pre-allocation UI freezes; HTTP/3 implications
- [aria2c(1) manual, `--http-accept-gzip`](https://aria2.github.io/manual/en/html/aria2c.html) — default `false`
- [aria2 issue #2210 (2024-05-09)](https://github.com/aria2/aria2/issues/2210) — gzip destroys `Content-Length` and therefore range/resume
- [RFC 9530, *Digest Fields* (February 2024)](https://www.rfc-editor.org/rfc/rfc9530.html) — `Content-Digest`/`Repr-Digest`; multi-connection reassembly use case
- [RFC 5854, *The Metalink Download Description Format*](https://datatracker.ietf.org/doc/rfc5854/) and [RFC 6249, *Metalink/HTTP*](https://www.rfc-editor.org/rfc/rfc6249.html)
- [Microsoft, "The Cable Guy: TCP Receive Window Auto-Tuning"](https://learn.microsoft.com/en-us/previous-versions/technet-magazine/cc162519(v=msdn.10)) — BDP, `SO_RCVBUF` as the manual opt-out, 16 MB autotuning ceiling
- [Microsoft, `SetFileValidData`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfilevaliddata) — privilege requirement, stale-data exposure, "usually no performance gain"
- [arvidn/libtorrent issue #3622 (2019-02-11)](https://github.com/arvidn/libtorrent/issues/3622) — `SetFileValidData` failing silently for unprivileged users
- [tokio `fs::File` docs](https://docs.rs/tokio/latest/tokio/fs/struct.File.html) and [`tokio::fs` module docs](https://docs.rs/tokio/latest/tokio/fs/index.html) — `spawn_blocking` per operation, `set_max_buf_size` (2 MB default), `flush()` is not durable, `sync_all`/`sync_data`
- Windows congestion-control configuration: `netsh int tcp set supplemental Template=Internet CongestionProvider=…`; CUBIC default since Windows 10, BBR2 available from 11 22H2 (machine-wide, admin only)
