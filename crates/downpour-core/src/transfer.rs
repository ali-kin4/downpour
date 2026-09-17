//! The transfer engine: probing, segmented download, resume and verification.
//!
//! # Why work-stealing
//!
//! The naive segmented downloader splits a file into N equal parts and waits.
//! That is only as fast as its slowest connection, and connection speeds on the
//! real internet differ by an order of magnitude, so the last 10% of a download
//! regularly runs at 1/Nth of the achievable rate while N-1 connections sit
//! idle. Instead, when a worker finishes its segment it *steals*: it finds the
//! segment with the most bytes outstanding, halves it, and takes the tail. The
//! donor notices its `end` moved and stops early. Work therefore keeps
//! redistributing until no remaining piece is big enough to be worth splitting,
//! which is what keeps every connection busy to the very end.
//!
//! # Why the segment table is a mutex, not atomics
//!
//! A steal has to move a boundary and create a segment atomically with respect
//! to the donor's cursor update. Doing that with individual atomics needs a CAS
//! protocol that is easy to get subtly wrong; a `parking_lot::Mutex` held for a
//! few dozen nanoseconds per 64 KiB chunk costs nothing measurable and is
//! obviously correct.

use crate::error::{Error, Result};
use crate::model::{RemoteInfo, Segment};
use crate::probe;
use crate::resume::{connections_for_size, plan_segments, Sidecar};
use crate::throttle::RateLimiter;
use futures::StreamExt;
use parking_lot::Mutex;
use reqwest::header::{HeaderValue, CONTENT_RANGE, RANGE, RETRY_AFTER};
use reqwest::{Client, StatusCode};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

/// Below this, halving a segment costs more in request overhead than it saves.
pub const DEFAULT_MIN_STEAL_BYTES: u64 = 1024 * 1024;

/// Hard ceiling on connections to a single host.
///
/// Sixteen is where the evidence stops showing gains and starts showing
/// rate-limiting. Beyond it a download manager is not fast, it is antisocial:
/// it crowds out other traffic, trips CDN abuse heuristics, and gets the user
/// a 429 or an IP ban. This is a correctness-of-behaviour limit, not a tuning
/// knob, so it is not configurable upward.
pub const MAX_CONNECTIONS: u8 = 16;

/// How many times one segment may be rate-limited before the download fails.
///
/// Deliberately small and, unlike the ordinary retry counter, **not** reset by
/// progress. A host that dribbles bytes while intermittently returning 429 is
/// telling us to go away; retrying it indefinitely is how a downloader earns
/// an IP ban for its users.
const MAX_RATE_LIMIT_RETRIES: u32 = 5;

/// Ceiling on an honoured `Retry-After`. Some servers send absurd values, and
/// a download that silently sleeps for an hour looks like a hang.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(120);

const CONTROL_RUN: u8 = 0;
const CONTROL_PAUSE: u8 = 1;
const CONTROL_CANCEL: u8 = 2;
const CONTROL_PARK: u8 = 3;

/// Why a paused transfer stopped, which decides the state it lands in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseReason {
    /// The user asked. Nothing may start it again on its own.
    User,
    /// The engine parked it -- a scheduler window closed, or the app is
    /// shutting down. A scheduled item may go back to waiting for its window.
    Parked,
}

/// Pause/cancel signalling, checked between chunks so it takes effect in
/// milliseconds without tearing a write.
///
/// The flag alone was not enough. A worker spends nearly all its time parked in
/// `stream.next()` waiting for the network, and a flag is only read once that
/// returns -- so a pause was not felt until the next chunk arrived, on every
/// connection at once, and the transfer trickled on for seconds after the user
/// asked it to stop. `notify` makes the wait itself interruptible: setting the
/// flag wakes every worker immediately, whether or not any data ever comes.
#[derive(Debug, Clone, Default)]
pub struct Control {
    flag: Arc<AtomicU8>,
    notify: Arc<tokio::sync::Notify>,
}

impl Control {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn pause(&self) {
        self.flag.store(CONTROL_PAUSE, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    /// Stops the transfer the way a closed window or a shutdown does. It ends
    /// with the same `Error::Paused`; only `pause_reason` tells the two apart,
    /// and the engine uses that to decide between `Paused` and `Scheduled`.
    pub fn park(&self) {
        // Only a still-running transfer may be parked. A plain store would let
        // a shutdown landing just after a user pause -- or after a cancel --
        // overwrite that decision, and the item would come back on the next
        // window as though the user had never touched it.
        let _ = self.flag.compare_exchange(
            CONTROL_RUN,
            CONTROL_PARK,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        self.notify.notify_waiters();
    }
    /// `Parked` only when the engine parked this transfer. Anything else --
    /// including a flag that has since been reset -- counts as the user's own
    /// pause, because resuming on its own is the wrong way to be wrong.
    pub fn pause_reason(&self) -> PauseReason {
        match self.flag.load(Ordering::Relaxed) {
            CONTROL_PARK => PauseReason::Parked,
            _ => PauseReason::User,
        }
    }
    pub fn cancel(&self) {
        self.flag.store(CONTROL_CANCEL, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn reset(&self) {
        self.flag.store(CONTROL_RUN, Ordering::SeqCst);
    }
    pub fn is_stopped(&self) -> bool {
        self.flag.load(Ordering::Relaxed) != CONTROL_RUN
    }
    /// Resolves as soon as the transfer is asked to stop, and never otherwise.
    ///
    /// Raced against a read in the chunk loops, so a pause interrupts the wait
    /// for data rather than queueing behind it. The `notified()` future is
    /// created *before* the flag is read: built afterwards, a stop landing
    /// between the two would be missed and the worker would wait for a wake-up
    /// that had already happened.
    async fn stopped(&self) {
        loop {
            let waiter = self.notify.notified();
            if self.is_stopped() {
                return;
            }
            waiter.await;
        }
    }

    /// `Ok(())` while running, otherwise the error the transfer should end with.
    fn check(&self) -> Result<()> {
        match self.flag.load(Ordering::Relaxed) {
            CONTROL_PAUSE | CONTROL_PARK => Err(Error::Paused),
            CONTROL_CANCEL => Err(Error::Cancelled),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TransferConfig {
    /// Upper bound on parallel connections for this file.
    pub connections: u8,
    /// Retries per segment before the whole transfer fails. The counter resets
    /// whenever a retry makes progress, so a long download over a flaky link
    /// is not killed by an unlucky total.
    pub max_retries: u32,
    pub min_steal_bytes: u64,
    /// Expected checksum, `sha256:<hex>`. Verified before the rename.
    pub checksum: Option<String>,
    /// Applied per request; a stalled connection is retried rather than hung on.
    pub request_timeout: Duration,
}

impl Default for TransferConfig {
    fn default() -> Self {
        Self {
            connections: 8,
            max_retries: 8,
            min_steal_bytes: DEFAULT_MIN_STEAL_BYTES,
            checksum: None,
            request_timeout: Duration::from_secs(60),
        }
    }
}

/// Live counters the engine samples for progress reporting.
#[derive(Debug, Default)]
pub struct TransferProgress {
    pub downloaded: AtomicU64,
    pub total: AtomicU64,
    /// Workers currently inside a request. Drops to zero as they retire.
    pub active_connections: AtomicU64,
    /// The most that were ever in flight at once.
    ///
    /// Reported to the UI instead of the live count, because the live count is
    /// zero the instant a download finishes: a row that used eight connections
    /// would otherwise settle on "1" and claim it never segmented at all.
    pub peak_connections: AtomicU64,
}

#[derive(Debug)]
pub struct TransferOutcome {
    pub path: PathBuf,
    pub total_bytes: u64,
    pub sha256: Option<String>,
    pub remote: RemoteInfo,
}

/// Everything a transfer needs from the outside world.
pub struct TransferContext {
    pub client: Client,
    pub headers: BTreeMap<String, String>,
    pub control: Control,
    pub limiter: RateLimiter,
    pub progress: Arc<TransferProgress>,
}

// ---------------------------------------------------------------------------
// Segment table
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Slot {
    seg: Segment,
    /// A worker currently owns this slot. Prevents two workers fetching the
    /// same bytes, which would be correct but would halve effective throughput.
    claimed: bool,
}

#[derive(Debug)]
struct SegmentTable {
    slots: Vec<Slot>,
    min_steal_bytes: u64,
}

impl SegmentTable {
    fn new(segments: Vec<Segment>, min_steal_bytes: u64) -> Self {
        Self {
            slots: segments
                .into_iter()
                .map(|seg| Slot {
                    seg,
                    claimed: false,
                })
                .collect(),
            min_steal_bytes,
        }
    }

    fn snapshot(&self) -> Vec<Segment> {
        let mut v: Vec<Segment> = self.slots.iter().map(|s| s.seg).collect();
        v.sort_by_key(|s| s.start);
        v
    }

    fn all_complete(&self) -> bool {
        self.slots.iter().all(|s| s.seg.is_complete())
    }

    fn downloaded(&self) -> u64 {
        self.slots.iter().map(|s| s.seg.downloaded()).sum()
    }

    /// Takes an unclaimed, unfinished segment.
    fn claim_free(&mut self) -> Option<usize> {
        let idx = self
            .slots
            .iter()
            .position(|s| !s.claimed && !s.seg.is_complete())?;
        self.slots[idx].claimed = true;
        Some(idx)
    }

    /// Splits the segment with the most outstanding bytes and returns the index
    /// of the newly created tail, already claimed by the caller.
    ///
    /// Returns `None` when no segment is large enough to be worth splitting,
    /// which is the signal for the calling worker to retire.
    fn steal(&mut self) -> Option<usize> {
        let (victim, remaining) = self
            .slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.claimed && !s.seg.is_complete())
            .map(|(i, s)| (i, s.seg.remaining()))
            .max_by_key(|(_, r)| *r)?;

        // Splitting is only worth it if *both* halves clear the threshold;
        // otherwise we trade a fresh TCP handshake for a few hundred kilobytes.
        if remaining < self.min_steal_bytes.saturating_mul(2) {
            return None;
        }

        let seg = self.slots[victim].seg;
        // Split at the midpoint of what is *left*, not of the whole segment, so
        // the donor keeps the part it is already streaming into.
        let split_at = seg.cursor + remaining / 2;
        debug_assert!(split_at > seg.cursor && split_at <= seg.end);

        let old_end = seg.end;
        self.slots[victim].seg.end = split_at - 1;

        self.slots.push(Slot {
            seg: Segment::new(split_at, old_end),
            claimed: true,
        });
        Some(self.slots.len() - 1)
    }

    fn claim_or_steal(&mut self) -> Option<usize> {
        self.claim_free().or_else(|| self.steal())
    }

    fn release(&mut self, idx: usize) {
        self.slots[idx].claimed = false;
    }

    fn advance(&mut self, idx: usize, n: u64) {
        self.slots[idx].seg.cursor += n;
    }

    fn bounds(&self, idx: usize) -> (u64, u64) {
        let s = self.slots[idx].seg;
        (s.cursor, s.end)
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Downloads `url` into `part_path`, then renames it to `final_path`.
///
/// Resumes automatically when a valid sidecar sits next to the part file and
/// the remote validators still match.
pub async fn run_transfer(
    ctx: &TransferContext,
    remote: &RemoteInfo,
    final_path: &Path,
    part_path: &Path,
    meta_path: &Path,
    config: &TransferConfig,
) -> Result<TransferOutcome> {
    ctx.control.check()?;
    tracing::debug!(
        url = %remote.final_url,
        size = ?remote.size,
        range = remote.supports_range,
        "starting transfer"
    );

    if let Some(parent) = part_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|source| Error::Io {
                path: parent.to_path_buf(),
                source,
            })?;
    }

    let total = remote.size;
    ctx.progress
        .total
        .store(total.unwrap_or(0), Ordering::Relaxed);

    let downloaded_total = if remote.supports_range && total.unwrap_or(0) > 0 {
        segmented_transfer(ctx, remote, part_path, meta_path, config).await?
    } else {
        plain_transfer(ctx, remote, part_path, config).await?
    };

    ctx.control.check()?;

    // Length check before anything else: a mismatch here means the transfer
    // logic itself is wrong, and we would rather fail loudly than rename a
    // short file into place looking finished.
    let actual = tokio::fs::metadata(part_path)
        .await
        .map_err(|source| Error::Io {
            path: part_path.to_path_buf(),
            source,
        })?
        .len();
    if let Some(expected) = total {
        if actual != expected {
            return Err(Error::Other(format!(
                "downloaded {actual} bytes but the server declared {expected}"
            )));
        }
    }

    let digest = if config.checksum.is_some() {
        Some(sha256_file(part_path).await?)
    } else {
        None
    };
    if let (Some(expected), Some(actual)) = (&config.checksum, &digest) {
        let expected = expected
            .strip_prefix("sha256:")
            .unwrap_or(expected)
            .trim()
            .to_ascii_lowercase();
        if &expected != actual {
            return Err(Error::ChecksumMismatch {
                expected,
                actual: actual.clone(),
            });
        }
    }

    tokio::fs::rename(part_path, final_path)
        .await
        .map_err(|source| Error::Io {
            path: final_path.to_path_buf(),
            source,
        })?;
    // The sidecar has done its job; leaving it behind would litter the
    // download folder with files the user did not ask for.
    let _ = tokio::fs::remove_file(meta_path).await;

    Ok(TransferOutcome {
        path: final_path.to_path_buf(),
        total_bytes: downloaded_total,
        sha256: digest,
        remote: remote.clone(),
    })
}

// ---------------------------------------------------------------------------
// Segmented path
// ---------------------------------------------------------------------------

async fn segmented_transfer(
    ctx: &TransferContext,
    remote: &RemoteInfo,
    part_path: &Path,
    meta_path: &Path,
    config: &TransferConfig,
) -> Result<u64> {
    let total = remote.size.expect("segmented path requires a known size");

    let (segments, resumed) = match load_resumable(meta_path, part_path, remote, total) {
        Some(sidecar) => {
            tracing::info!(
                done = sidecar.downloaded_bytes(),
                total,
                "resuming from sidecar"
            );
            (sidecar.segments, true)
        }
        None => {
            let n = connections_for_size(total, config.connections);
            (plan_segments(total, n), false)
        }
    };

    if !resumed {
        // Preallocating means every worker can seek to its offset immediately,
        // and it surfaces a full disk now rather than at 98%.
        let file = tokio::fs::File::create(part_path)
            .await
            .map_err(|source| Error::Io {
                path: part_path.to_path_buf(),
                source,
            })?;
        file.set_len(total).await.map_err(|source| Error::Io {
            path: part_path.to_path_buf(),
            source,
        })?;
        drop(file);
    }

    let already = segments.iter().map(|s| s.downloaded()).sum::<u64>();
    ctx.progress.downloaded.store(already, Ordering::Relaxed);

    let table = Arc::new(Mutex::new(SegmentTable::new(
        segments,
        config.min_steal_bytes,
    )));

    // One worker per planned segment, capped by the configured connection
    // count. Extra workers would simply steal on their first iteration, which
    // is harmless but wastes a connection slot.
    let worker_count = {
        let t = table.lock();
        t.slots.iter().filter(|s| !s.seg.is_complete()).count()
    }
    .min(config.connections.max(1) as usize)
    .max(1);

    persist(&table, meta_path, remote, total)?;

    let mut workers = Vec::with_capacity(worker_count);
    for worker_id in 0..worker_count {
        let table = Arc::clone(&table);
        let client = ctx.client.clone();
        let headers = ctx.headers.clone();
        let control = ctx.control.clone();
        let limiter = ctx.limiter.clone();
        let progress = Arc::clone(&ctx.progress);
        let url = remote.final_url.clone();
        let part_path = part_path.to_path_buf();
        let config = config.clone();

        workers.push(tokio::spawn(async move {
            let ctx = TransferContext {
                client,
                headers,
                control,
                limiter,
                progress,
            };
            worker_loop(worker_id, &ctx, &url, &part_path, &table, &config).await
        }));
    }

    // Persist the sidecar while the workers run, so a crash or a power cut
    // loses at most a second of progress rather than the whole download.
    let saver = {
        let table = Arc::clone(&table);
        let meta_path = meta_path.to_path_buf();
        let remote = remote.clone();
        let control = ctx.control.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(1000));
            tick.tick().await;
            loop {
                tick.tick().await;
                if control.is_stopped() {
                    break;
                }
                if let Err(e) = persist(&table, &meta_path, &remote, total) {
                    tracing::warn!(error = %e, "failed to persist resume sidecar");
                }
            }
        })
    };

    let mut first_error: Option<Error> = None;
    for w in workers {
        match w.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                // Report the first real failure; a pause that races with a
                // genuine error should not mask the error.
                let replace = match (&first_error, &e) {
                    (None, _) => true,
                    (Some(Error::Paused | Error::Cancelled), e2)
                        if !matches!(e2, Error::Paused | Error::Cancelled) =>
                    {
                        true
                    }
                    _ => false,
                };
                if replace {
                    first_error = Some(e);
                }
            }
            Err(join) => {
                if first_error.is_none() {
                    first_error = Some(Error::Other(format!("worker panicked: {join}")));
                }
            }
        }
    }
    saver.abort();

    // Always flush the final state, including on pause: this is precisely the
    // snapshot a later resume depends on.
    persist(&table, meta_path, remote, total)?;

    if let Some(e) = first_error {
        return Err(e);
    }

    let done = {
        let t = table.lock();
        if !t.all_complete() {
            return Err(Error::PlainIo(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "workers retired with segments outstanding",
            )));
        }
        t.downloaded()
    };
    Ok(done)
}

/// Returns a sidecar only if everything about it still checks out.
///
/// Any doubt at all results in `None`, which restarts the download from zero.
/// Restarting wastes bandwidth; resuming against a changed file silently
/// corrupts the result, and that is the worse failure by a wide margin.
fn load_resumable(
    meta_path: &Path,
    part_path: &Path,
    fresh: &RemoteInfo,
    total: u64,
) -> Option<Sidecar> {
    if !meta_path.exists() || !part_path.exists() {
        return None;
    }
    let sidecar = match Sidecar::load(meta_path) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "discarding unusable resume sidecar");
            return None;
        }
    };
    if sidecar.total_bytes != total {
        tracing::warn!("remote size changed; restarting download");
        return None;
    }
    if let Err(e) = sidecar.check_still_valid(fresh) {
        tracing::warn!(error = %e, "remote file changed; restarting download");
        return None;
    }
    // The part file must still be the preallocated full length. A truncated or
    // externally modified part file cannot be trusted to hold the bytes the
    // cursors claim it holds.
    match std::fs::metadata(part_path) {
        Ok(m) if m.len() == total => Some(sidecar),
        Ok(m) => {
            tracing::warn!(
                actual = m.len(),
                expected = total,
                "part file is the wrong size; restarting download"
            );
            None
        }
        Err(_) => None,
    }
}

fn persist(
    table: &Arc<Mutex<SegmentTable>>,
    meta_path: &Path,
    remote: &RemoteInfo,
    total: u64,
) -> Result<()> {
    let segments = table.lock().snapshot();
    let sidecar = Sidecar::new(remote.final_url.clone(), remote.clone(), segments, total);
    // A snapshot taken mid-steal is still structurally sound, but assert it
    // rather than writing a sidecar that will be rejected on resume.
    sidecar.validate()?;
    sidecar.save(meta_path)
}

async fn worker_loop(
    worker_id: usize,
    ctx: &TransferContext,
    url: &str,
    part_path: &Path,
    table: &Arc<Mutex<SegmentTable>>,
    config: &TransferConfig,
) -> Result<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(part_path)
        .await
        .map_err(|source| Error::Io {
            path: part_path.to_path_buf(),
            source,
        })?;

    loop {
        ctx.control.check()?;

        let idx = match table.lock().claim_or_steal() {
            Some(i) => i,
            None => {
                tracing::trace!(worker_id, "no work left to claim or steal; retiring");
                return Ok(());
            }
        };

        let in_flight = ctx
            .progress
            .active_connections
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        ctx.progress
            .peak_connections
            .fetch_max(in_flight, Ordering::Relaxed);
        let result = fetch_segment(ctx, url, idx, table, &mut file, config).await;
        ctx.progress
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);

        table.lock().release(idx);
        result?;
    }
}

/// Drives one segment to completion, retrying transient failures with
/// exponential backoff.
async fn fetch_segment(
    ctx: &TransferContext,
    url: &str,
    idx: usize,
    table: &Arc<Mutex<SegmentTable>>,
    file: &mut tokio::fs::File,
    config: &TransferConfig,
) -> Result<()> {
    let mut attempts: u32 = 0;
    let mut rate_limited: u32 = 0;
    let mut last_cursor = table.lock().bounds(idx).0;

    loop {
        ctx.control.check()?;
        let (cursor, end) = table.lock().bounds(idx);
        if cursor > end {
            return Ok(());
        }

        match stream_range(ctx, url, idx, table, file, cursor, end).await {
            Ok(()) => return Ok(()),
            Err(Error::RateLimited { retry_after_secs }) => {
                rate_limited += 1;
                if rate_limited > MAX_RATE_LIMIT_RETRIES {
                    tracing::warn!(
                        rate_limited,
                        "server kept rate limiting us; giving up rather than hammering it"
                    );
                    return Err(Error::RateLimited { retry_after_secs });
                }
                // The server's own number wins when it gave one; otherwise back
                // off harder than for an ordinary error, since the problem is
                // that we are asking for too much.
                let wait = retry_after_secs
                    .map(Duration::from_secs)
                    .unwrap_or_else(|| backoff_delay(rate_limited + 2))
                    .min(MAX_RETRY_AFTER);
                tracing::info!(?wait, rate_limited, "rate limited; waiting");
                tokio::time::sleep(wait).await;
            }
            Err(e) if e.is_transient() => {
                let (now_cursor, _) = table.lock().bounds(idx);
                if now_cursor > last_cursor {
                    // The attempt moved the file forward, so the link is
                    // working and this is not a repeating failure.
                    attempts = 0;
                    last_cursor = now_cursor;
                }
                attempts += 1;
                if attempts > config.max_retries {
                    tracing::warn!(error = %e, attempts, "segment exhausted its retries");
                    return Err(e);
                }
                let backoff = backoff_delay(attempts);
                tracing::debug!(error = %e, attempts, ?backoff, "retrying segment");
                tokio::time::sleep(backoff).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Exponential backoff, jittered and capped.
///
/// The jitter matters: without it, sixteen connections that all drop when a
/// flaky router reboots retry in lockstep and knock it over again.
fn backoff_delay(attempt: u32) -> Duration {
    const CAP_MS: u64 = 30_000;
    let base = 250u64.saturating_mul(1u64 << attempt.min(7));
    let base = base.min(CAP_MS);
    // Deterministic jitter derived from the clock, so no rand dependency in
    // the hot path: +/- 25%.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let jitter = base / 2;
    let offset = nanos % jitter.max(1);
    Duration::from_millis(
        base.saturating_sub(jitter / 2)
            .saturating_add(offset % jitter.max(1)),
    )
}

/// Reads `Retry-After`, which RFC 9110 allows as either a delay in seconds or
/// an HTTP date. Only the delay form is honoured; a date needs clock-skew
/// handling to be worth anything, and servers that rate-limit overwhelmingly
/// send seconds.
fn parse_retry_after(value: Option<&HeaderValue>) -> Option<u64> {
    let raw = value?.to_str().ok()?.trim();
    raw.parse::<u64>().ok()
}

async fn stream_range(
    ctx: &TransferContext,
    url: &str,
    idx: usize,
    table: &Arc<Mutex<SegmentTable>>,
    file: &mut tokio::fs::File,
    start: u64,
    end: u64,
) -> Result<()> {
    let mut headers = probe::build_headers(&ctx.headers);
    let range = format!("bytes={start}-{end}");
    headers.insert(
        RANGE,
        HeaderValue::from_str(&range).map_err(|e| Error::Other(e.to_string()))?,
    );

    let response = ctx.client.get(url).headers(headers).send().await?;
    let status = response.status();

    if status != StatusCode::PARTIAL_CONTENT {
        // A 200 here means the server ignored our Range header. Writing a full
        // body into a mid-file segment slot is exactly the corruption this
        // engine exists to avoid, so refuse rather than guess.
        if status.is_success() {
            return Err(Error::RangeNotHonoured {
                status: status.as_u16(),
            });
        }
        if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE {
            return Err(Error::RateLimited {
                retry_after_secs: parse_retry_after(response.headers().get(RETRY_AFTER)),
            });
        }
        return Err(Error::BadStatus {
            status: status.as_u16(),
            url: url.to_string(),
        });
    }

    // Verify the server gave us the window we asked for. Some CDNs round or
    // clamp ranges; honouring that silently scatters bytes at wrong offsets.
    if let Some(cr) = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        match probe::parse_content_range_span(cr) {
            Some((got_start, _)) if got_start == start => {}
            Some((got_start, got_end)) => {
                return Err(Error::Other(format!(
                    "server returned bytes {got_start}-{got_end} when {start}-{end} was requested"
                )));
            }
            None => {
                return Err(Error::Other(format!("unparseable Content-Range: {cr}")));
            }
        }
    }

    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(Error::PlainIo)?;

    let mut cursor = start;
    let mut stream = response.bytes_stream();

    loop {
        // Racing the read means a pause lands now rather than whenever the
        // next chunk happens to arrive -- which on a stalled connection could
        // be never. `biased` so a stop already asked for wins over data that
        // arrived in the same instant.
        let next = tokio::select! {
            biased;
            () = ctx.control.stopped() => {
                ctx.control.check()?;
                break;
            }
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk?;
        if chunk.is_empty() {
            continue;
        }

        // Re-read the boundary every chunk: another worker may have stolen our
        // tail since the last one.
        let current_end = table.lock().bounds(idx).1;
        if cursor > current_end {
            break;
        }
        let allowed = (current_end - cursor + 1) as usize;
        let take = chunk.len().min(allowed);

        // Same reasoning as the read: under a speed limit this sleeps, and a
        // pause must not have to wait for that sleep to finish.
        tokio::select! {
            biased;
            () = ctx.control.stopped() => {
                ctx.control.check()?;
                break;
            }
            () = ctx.limiter.acquire(take as u64) => {}
        }

        file.write_all(&chunk[..take])
            .await
            .map_err(Error::PlainIo)?;
        cursor += take as u64;

        table.lock().advance(idx, take as u64);
        ctx.progress
            .downloaded
            .fetch_add(take as u64, Ordering::Relaxed);

        if take < chunk.len() {
            // We reached our (possibly stolen) boundary mid-chunk; the rest
            // belongs to another worker.
            break;
        }
    }

    file.flush().await.map_err(Error::PlainIo)?;

    let current_end = table.lock().bounds(idx).1;
    if cursor <= current_end {
        // The body ended before the range did: a dropped connection, not a
        // completed segment. Transient, so the caller retries from `cursor`.
        return Err(Error::PlainIo(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            format!("stream ended at byte {cursor}, expected through {current_end}"),
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Single-stream path
// ---------------------------------------------------------------------------

/// Used when the server does not honour ranges, or will not tell us the size.
/// Neither resume nor segmentation is possible, so this is a plain sequential
/// write that restarts from zero if it fails.
async fn plain_transfer(
    ctx: &TransferContext,
    remote: &RemoteInfo,
    part_path: &Path,
    _config: &TransferConfig,
) -> Result<u64> {
    ctx.progress.downloaded.store(0, Ordering::Relaxed);
    ctx.progress.active_connections.store(1, Ordering::Relaxed);
    ctx.progress
        .peak_connections
        .fetch_max(1, Ordering::Relaxed);

    let headers = probe::build_headers(&ctx.headers);
    let response = ctx
        .client
        .get(&remote.final_url)
        .headers(headers)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        ctx.progress.active_connections.store(0, Ordering::Relaxed);
        return Err(Error::BadStatus {
            status: status.as_u16(),
            url: remote.final_url.clone(),
        });
    }

    let mut file = tokio::fs::File::create(part_path)
        .await
        .map_err(|source| Error::Io {
            path: part_path.to_path_buf(),
            source,
        })?;

    let mut written = 0u64;
    let mut stream = response.bytes_stream();
    let result = async {
        loop {
            let next = tokio::select! {
                biased;
                () = ctx.control.stopped() => {
                    ctx.control.check()?;
                    break;
                }
                next = stream.next() => next,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk?;
            // Under a speed limit this sleeps, and sleeping through a pause is
            // the same bug in a different place.
            tokio::select! {
                biased;
                () = ctx.control.stopped() => {
                    ctx.control.check()?;
                    break;
                }
                () = ctx.limiter.acquire(chunk.len() as u64) => {}
            }
            file.write_all(&chunk).await.map_err(Error::PlainIo)?;
            written += chunk.len() as u64;
            ctx.progress.downloaded.store(written, Ordering::Relaxed);
        }
        Ok::<(), Error>(())
    }
    .await;

    file.flush().await.map_err(Error::PlainIo)?;
    drop(file);
    ctx.progress.active_connections.store(0, Ordering::Relaxed);
    result?;

    Ok(written)
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// Hashes a file without loading it into memory.
pub async fn sha256_file(path: &Path) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|source| Error::Io {
            path: path.to_path_buf(),
            source,
        })?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 256];
    loop {
        let n = file.read(&mut buf).await.map_err(Error::PlainIo)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        // Hashing a multi-gigabyte file would otherwise monopolise this worker
        // thread and stall other downloads' progress updates.
        tokio::task::yield_now().await;
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Builds the HTTP client the engine uses.
///
/// # Why HTTP/1.1 only
///
/// This is the single most consequential line in the engine, and it is not an
/// oversight.
///
/// Over TLS, ALPN negotiates HTTP/2 with essentially every CDN and release
/// host. `reqwest` then **multiplexes every concurrent request to an origin
/// onto one TCP connection**. A sixteen-way segmented download therefore opens
/// sixteen *streams* inside a single connection — which defeats the entire
/// reason for segmenting, because the thing being worked around is
/// *per-connection* server shaping, and all sixteen streams sit in the same
/// shaping bucket.
///
/// It is also a hard throughput ceiling. hyper's HTTP/2 connection window
/// defaults to 5 MiB and reqwest leaves adaptive windowing off, so the whole
/// download is capped at roughly one window per round trip: about 420 Mbit/s
/// at 100 ms RTT, no matter how the file is split. That ceiling is invisible
/// on a LAN, which is why it is easy to benchmark and miss.
///
/// Forcing HTTP/1.1 gives one real TCP connection per segment, which is what
/// segmentation is for. HTTP/2's advantages — header compression, no
/// head-of-line blocking across many small requests — are worth nothing to a
/// client fetching a handful of very large byte ranges.
///
/// # Why no compression
///
/// Asking for gzip on a download manager is close to always wrong: the payload
/// is usually already compressed, so it costs CPU for no gain, and a
/// transfer-encoded body makes the byte arithmetic that ranged requests depend
/// on ambiguous. `curl`, `wget` and `aria2` all send no `Accept-Encoding` for
/// the same reasons.
pub fn build_client(user_agent: &str, timeout: Duration) -> Result<Client> {
    Client::builder()
        .user_agent(user_agent)
        .http1_only()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        // A segmented download deliberately holds several connections to one
        // host; without a generous idle pool they are torn down and rebuilt
        // between segments, paying a fresh TCP and TLS handshake each time.
        .pool_max_idle_per_host(MAX_CONNECTIONS as usize)
        .pool_idle_timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(Error::Network)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(total: u64, n: u8) -> SegmentTable {
        SegmentTable::new(plan_segments(total, n), DEFAULT_MIN_STEAL_BYTES)
    }

    #[test]
    fn claim_free_hands_out_each_segment_once() {
        let mut t = table(1000, 4);
        let mut seen = vec![];
        while let Some(i) = t.claim_free() {
            seen.push(i);
        }
        assert_eq!(seen.len(), 4);
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 4, "no segment handed out twice");
    }

    #[test]
    fn steal_refuses_when_nothing_is_big_enough() {
        // 1000 bytes total is far below the 1 MiB steal threshold.
        let mut t = table(1000, 2);
        t.claim_free();
        t.claim_free();
        assert_eq!(t.steal(), None);
    }

    #[test]
    fn steal_splits_the_largest_outstanding_segment() {
        let total = 100 * 1024 * 1024;
        let mut t = table(total, 2);
        let a = t.claim_free().unwrap();
        let b = t.claim_free().unwrap();
        // Worker A finishes almost all of its half.
        let (_, a_end) = t.bounds(a);
        t.slots[a].seg.cursor = a_end; // one byte left
        let before_b = t.bounds(b);

        let stolen = t.steal().expect("B has plenty outstanding");
        let (s_start, s_end) = t.bounds(stolen);
        let after_b = t.bounds(b);

        assert_eq!(
            after_b.1,
            s_start - 1,
            "donor end moved to just before the tail"
        );
        assert_eq!(s_end, before_b.1, "tail keeps the original end");
        assert!(
            s_start > before_b.0,
            "tail starts ahead of the donor cursor"
        );
    }

    #[test]
    fn steal_preserves_total_coverage() {
        let total = 64 * 1024 * 1024;
        let mut t = table(total, 4);
        for _ in 0..4 {
            t.claim_free();
        }
        // Advance a couple of cursors, then steal repeatedly.
        t.slots[0].seg.cursor += 1_000_000;
        t.slots[1].seg.cursor += 5_000_000;
        for _ in 0..10 {
            if t.steal().is_none() {
                break;
            }
        }
        let snap = t.snapshot();
        let mut expected = 0u64;
        for s in &snap {
            assert_eq!(s.start, expected, "gap or overlap after stealing");
            expected = s.end + 1;
        }
        assert_eq!(expected, total, "stealing lost bytes");
    }

    #[test]
    fn steal_never_takes_bytes_the_donor_already_wrote() {
        let total = 32 * 1024 * 1024;
        let mut t = table(total, 1);
        let a = t.claim_free().unwrap();
        t.slots[a].seg.cursor += 10 * 1024 * 1024;
        let cursor = t.bounds(a).0;

        let stolen = t.steal().unwrap();
        assert!(
            t.bounds(stolen).0 > cursor,
            "stolen range must start after the donor cursor"
        );
    }

    #[test]
    fn all_complete_and_downloaded_agree() {
        let mut t = table(1000, 4);
        assert!(!t.all_complete());
        assert_eq!(t.downloaded(), 0);
        for s in &mut t.slots {
            s.seg.cursor = s.seg.end + 1;
        }
        assert!(t.all_complete());
        assert_eq!(t.downloaded(), 1000);
    }

    #[test]
    fn control_transitions() {
        let c = Control::new();
        assert!(c.check().is_ok());
        assert!(!c.is_stopped());
        c.pause();
        assert!(matches!(c.check(), Err(Error::Paused)));
        assert!(c.is_stopped());
        c.reset();
        assert!(c.check().is_ok());
        c.cancel();
        assert!(matches!(c.check(), Err(Error::Cancelled)));
    }

    #[test]
    fn parking_never_overrides_a_decision_already_made() {
        // Shutdown parks everything still running. It must not rewrite a pause
        // or a cancel the user asked for a moment earlier.
        let c = Control::new();
        c.pause();
        c.park();
        assert_eq!(c.pause_reason(), PauseReason::User);
        assert!(matches!(c.check(), Err(Error::Paused)));

        let c = Control::new();
        c.cancel();
        c.park();
        assert!(matches!(c.check(), Err(Error::Cancelled)));

        // A running transfer parks normally, and parking twice is idempotent.
        let c = Control::new();
        c.park();
        c.park();
        assert_eq!(c.pause_reason(), PauseReason::Parked);
        assert!(matches!(c.check(), Err(Error::Paused)));
    }

    #[test]
    fn backoff_grows_and_stays_capped() {
        let d1 = backoff_delay(1);
        let d8 = backoff_delay(8);
        assert!(d1 < Duration::from_secs(1));
        assert!(d8 <= Duration::from_secs(40), "{d8:?}");
        assert!(d8 > d1);
    }

    #[test]
    fn retry_after_reads_the_delay_form() {
        let h = |v: &str| parse_retry_after(Some(&HeaderValue::from_str(v).unwrap()));
        assert_eq!(h("30"), Some(30));
        assert_eq!(h("  5 "), Some(5));
        assert_eq!(h("0"), Some(0));
        // The HTTP-date form is not honoured; sleeping on a parsed date needs
        // clock-skew handling to be safe, and the caller falls back to its own
        // backoff when this returns None.
        assert_eq!(h("Wed, 21 Oct 2026 07:28:00 GMT"), None);
        assert_eq!(h("soon"), None);
        assert_eq!(parse_retry_after(None), None);
    }

    #[test]
    fn rate_limiting_is_transient_but_a_404_is_not() {
        assert!(Error::RateLimited {
            retry_after_secs: None
        }
        .is_transient());
        assert!(Error::BadStatus {
            status: 503,
            url: "u".into()
        }
        .is_transient());
        assert!(Error::BadStatus {
            status: 408,
            url: "u".into()
        }
        .is_transient());
        assert!(!Error::BadStatus {
            status: 404,
            url: "u".into()
        }
        .is_transient());
        assert!(!Error::BadStatus {
            status: 403,
            url: "u".into()
        }
        .is_transient());
    }

    #[test]
    fn hex_encodes_lowercase_fixed_width() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[tokio::test]
    async fn sha256_of_a_known_file() {
        let dir = std::env::temp_dir().join(format!("dp-hash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
