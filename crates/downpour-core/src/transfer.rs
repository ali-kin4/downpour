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
use crate::origin::{ConnectionBudget, Lease, Permit};
use crate::probe;
use crate::resume::{connections_for_size, plan_segments, Sidecar};
use crate::throttle::RateLimiter;
use futures::StreamExt;
use parking_lot::Mutex;
use reqwest::header::{
    HeaderMap, HeaderValue, CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE,
    RETRY_AFTER,
};
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

/// Hard ceiling on connections to a single origin, across every download from
/// it -- enforced by [`ConnectionBudget`], not by any one transfer.
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
    /// Shared by every transfer the engine runs, so downloads from one origin
    /// draw on one ceiling. A budget made per transfer would bound nothing.
    pub budget: Arc<ConnectionBudget>,
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

    // Keyed on the final URL: that is the server every request below goes to,
    // whatever host the link started on.
    let lease = Arc::new(ctx.budget.lease(&remote.final_url));
    let downloaded_total = if remote.supports_range && total.unwrap_or(0) > 0 {
        segmented_transfer(ctx, remote, &lease, part_path, meta_path, config).await?
    } else {
        plain_transfer(ctx, remote, &lease, part_path, config).await?
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
    lease: &Arc<Lease>,
    part_path: &Path,
    meta_path: &Path,
    config: &TransferConfig,
) -> Result<u64> {
    let total = remote.size.expect("segmented path requires a known size");

    // A paused run may still be writing its last checkpoint for this file in
    // the background (see `finish_in_background`). Reading the sidecar before
    // that lands would resume from an older snapshot -- safe, but it would
    // refetch what the pause had kept -- and writing one alongside it would
    // race it.
    drop(finalizer(meta_path).lock_owned().await);

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

    // The last snapshot whose bytes are known to be on the disk. The final
    // write below records this rather than syncing again, which is what keeps
    // a pause from waiting on the disk (see `record`).
    {
        let first = sync_part(&table, part_path).await?;
        record(first, meta_path, remote, total).await?;
    }

    let mut workers = tokio::task::JoinSet::new();
    for worker_id in 0..worker_count {
        let table = Arc::clone(&table);
        let client = ctx.client.clone();
        let headers = ctx.headers.clone();
        let control = ctx.control.clone();
        let limiter = ctx.limiter.clone();
        let progress = Arc::clone(&ctx.progress);
        let budget = Arc::clone(&ctx.budget);
        let lease = Arc::clone(lease);
        let remote = remote.clone();
        let part_path = part_path.to_path_buf();
        let config = config.clone();

        workers.spawn(async move {
            let ctx = TransferContext {
                client,
                headers,
                control,
                limiter,
                progress,
                budget,
            };
            worker_loop(
                worker_id, &ctx, &remote, &lease, &part_path, &table, &config,
            )
            .await
        });
    }

    // Persist the sidecar while the workers run, so a crash or a power cut
    // loses at most a second of progress rather than the whole download.
    //
    // Stopped by a signal rather than aborted: a checkpoint runs on the
    // blocking pool, where an abort cannot reach it, so the only way to know
    // none is still in flight is for the saver to finish and say so.
    let (stop_saver, mut saver_stopped) = tokio::sync::oneshot::channel::<()>();
    //
    // A sync can take seconds on a busy disk, so the saver gives up waiting for
    // one the moment it is told to stop: the sync carries on harmlessly on the
    // blocking pool, and since the sidecar is written only after it, nothing
    // lands late. A pause therefore never queues behind the disk.
    let saver = {
        let table = Arc::clone(&table);
        let part_path = part_path.to_path_buf();
        let meta_path = meta_path.to_path_buf();
        let remote = remote.clone();
        let control = ctx.control.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(1000));
            tick.tick().await;
            loop {
                tokio::select! {
                    _ = &mut saver_stopped => break,
                    _ = tick.tick() => {}
                }
                if control.is_stopped() {
                    break;
                }
                let synced = tokio::select! {
                    _ = &mut saver_stopped => break,
                    synced = sync_part(&table, &part_path) => synced,
                };
                let result = match synced {
                    Ok(segments) => record(segments, &meta_path, &remote, total).await,
                    Err(e) => Err(e),
                };
                if let Err(e) = result {
                    tracing::warn!(error = %e, "failed to persist resume sidecar");
                }
            }
        })
    };

    let mut first_error: Option<Error> = None;
    while let Some(joined) = workers.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                // Once one worker has seen a different version of the file,
                // every byte the others fetch from here on is wasted at best.
                if matches!(e, Error::RemoteChanged { .. }) {
                    workers.abort_all();
                }
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
            // Our own `abort_all` above, not a failure in its own right.
            Err(join) if join.is_cancelled() => {}
            Err(join) => {
                if first_error.is_none() {
                    first_error = Some(Error::Other(format!("worker panicked: {join}")));
                }
            }
        }
    }
    // The saver must have actually finished before the final write below, or
    // a checkpoint it had already started can land afterwards and put back a
    // sidecar that was just removed or superseded.
    let _ = stop_saver.send(());
    let _ = saver.await;

    if let Some(Error::RemoteChanged { reason }) = &first_error {
        // The bytes on disk belong to a version the server no longer has. The
        // sidecar is what would vouch for them on a resume, so it goes, and
        // the part file is left to be overwritten by a fresh start.
        tracing::warn!(%reason, "remote file changed mid-transfer; discarding resume state");
        let _ = std::fs::remove_file(meta_path);
        return Err(first_error.unwrap());
    }

    // The final checkpoint: the snapshot a later resume depends on, synced
    // before it is recorded like every other.
    let last_checkpoint = {
        let table = Arc::clone(&table);
        let part_path = part_path.to_path_buf();
        let meta_path = meta_path.to_path_buf();
        let remote = remote.clone();
        async move {
            // The download may have been removed with its files while this
            // waited for the disk; a sidecar for bytes that are gone would only
            // be litter.
            if !part_path.exists() {
                return Ok(());
            }
            let segments = sync_part(&table, &part_path).await?;
            record(segments, &meta_path, &remote, total).await
        }
    };

    match first_error {
        // Nothing to keep: the download is being thrown away.
        Some(Error::Cancelled) => return Err(Error::Cancelled),
        // A pause must not wait on the disk -- on a busy one a sync takes
        // seconds, and the user is watching -- but it must keep its progress.
        // So the checkpoint completes in the background, fully synced, and the
        // next run of this file waits for it before reading the sidecar.
        Some(Error::Paused) => {
            finish_in_background(meta_path, last_checkpoint);
            return Err(Error::Paused);
        }
        Some(e) => {
            last_checkpoint.await?;
            return Err(e);
        }
        None => last_checkpoint.await?,
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

/// Snapshots the cursors, then syncs the part file, and returns the snapshot:
/// every byte it claims is on the disk once this returns.
///
/// The order is the whole point. Every byte the cursors claim had already
/// reached the OS before its cursor moved (see `stream_range`), so the sync
/// after the snapshot covers all of it. A sidecar written from a snapshot that
/// was never synced can survive a power cut that the data does not, and the
/// resume after it treats a run of zeros as downloaded: a finished file, the
/// right length, silently wrong.
///
/// Runs on the blocking pool, since a sync takes as long as the disk needs.
async fn sync_part(table: &Arc<Mutex<SegmentTable>>, part_path: &Path) -> Result<Vec<Segment>> {
    let segments = table.lock().snapshot();
    let part_path = part_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let part = std::fs::OpenOptions::new()
            .write(true)
            .open(&part_path)
            .map_err(|source| Error::Io {
                path: part_path.clone(),
                source,
            })?;
        part.sync_data().map_err(|source| Error::Io {
            path: part_path.clone(),
            source,
        })?;
        Ok(segments)
    })
    .await
    .map_err(|e| Error::Other(format!("checkpoint task failed: {e}")))?
}

/// One lock per sidecar, held by a checkpoint finishing in the background.
fn finalizer(meta_path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::LazyLock<
        Mutex<std::collections::HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    > = std::sync::LazyLock::new(Default::default);
    let mut locks = LOCKS.lock();
    // Forget the locks nobody holds, so the map stays the size of the
    // checkpoints actually in flight.
    locks.retain(|_, l| Arc::strong_count(l) > 1);
    Arc::clone(locks.entry(meta_path.to_path_buf()).or_default())
}

/// Runs a paused transfer's last checkpoint without making the pause wait for
/// it. The lock is taken before this returns, so a resume that starts the
/// instant after cannot read the sidecar ahead of it.
fn finish_in_background(
    meta_path: &Path,
    checkpoint: impl std::future::Future<Output = Result<()>> + Send + 'static,
) {
    let lock = finalizer(meta_path);
    match Arc::clone(&lock).try_lock_owned() {
        Ok(held) => {
            tokio::spawn(async move {
                if let Err(e) = checkpoint.await {
                    tracing::warn!(error = %e, "failed to write the final resume checkpoint");
                }
                drop(held);
            });
        }
        // Only another background checkpoint of this same file holds it, and
        // this one is newer: queue behind it.
        Err(_) => {
            tokio::spawn(async move {
                let held = lock.lock_owned().await;
                if let Err(e) = checkpoint.await {
                    tracing::warn!(error = %e, "failed to write the final resume checkpoint");
                }
                drop(held);
            });
        }
    }
}

/// Writes the sidecar for a snapshot [`sync_part`] has already made durable.
async fn record(
    segments: Vec<Segment>,
    meta_path: &Path,
    remote: &RemoteInfo,
    total: u64,
) -> Result<()> {
    let sidecar = Sidecar::new(remote.final_url.clone(), remote.clone(), segments, total);
    // A snapshot taken mid-steal is still structurally sound, but assert it
    // rather than writing a sidecar that will be rejected on resume.
    sidecar.validate()?;
    let meta_path = meta_path.to_path_buf();
    tokio::task::spawn_blocking(move || sidecar.save(&meta_path))
        .await
        .map_err(|e| Error::Other(format!("checkpoint task failed: {e}")))?
}

async fn worker_loop(
    worker_id: usize,
    ctx: &TransferContext,
    remote: &RemoteInfo,
    lease: &Lease,
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

        let result = fetch_segment(ctx, remote, lease, idx, table, &mut file, config).await;
        table.lock().release(idx);
        result?;
    }
}

/// Drives one segment to completion, retrying transient failures with
/// exponential backoff.
async fn fetch_segment(
    ctx: &TransferContext,
    remote: &RemoteInfo,
    lease: &Lease,
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

        // A slot is held for this one request and no longer: everything below
        // that sleeps does so after it has been given back.
        let permit = acquire_unless_stopped(&ctx.control, lease).await?;
        let in_flight = ctx
            .progress
            .active_connections
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        ctx.progress
            .peak_connections
            .fetch_max(in_flight, Ordering::Relaxed);
        let outcome = stream_range(ctx, remote, lease, idx, table, file, cursor, end).await;
        ctx.progress
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);
        drop(permit);

        match outcome {
            Ok(Streamed::Complete) => return Ok(()),
            // Handed the connection to another download; queue for the next
            // one. Not a failure, so it costs no retry.
            Ok(Streamed::Yielded) => {}
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
                wait_unless_stopped(&ctx.control, wait).await?;
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
                wait_unless_stopped(&ctx.control, backoff).await?;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Probes `url` inside the origin's connection budget.
///
/// The probe is a request like any other, and the ceiling is a promise about
/// connections to a server, not just about the segments that follow. It is
/// keyed on the address asked for, since the final one is what it finds out.
pub async fn probe(ctx: &TransferContext, url: &str) -> Result<RemoteInfo> {
    let lease = ctx.budget.lease(url);
    let _permit = acquire_unless_stopped(&ctx.control, &lease).await?;
    probe::probe(&ctx.client, url, &ctx.headers).await
}

/// Waits for a connection slot on the origin, unless the transfer is told to
/// stop first. A download queued behind others when the user pauses it must
/// stop now, not when a slot frees up.
async fn acquire_unless_stopped(control: &Control, lease: &Lease) -> Result<Permit> {
    tokio::select! {
        biased;
        () = control.stopped() => Err(control.check().err().unwrap_or(Error::Cancelled)),
        permit = lease.acquire() => Ok(permit),
    }
}

/// How a ranged request ended without an error.
enum Streamed {
    /// The segment is done, or what remains of it was stolen.
    Complete,
    /// Stopped early to give the connection to another download.
    Yielded,
}

/// Sleeps out a retry delay, unless the transfer is told to stop first.
///
/// These waits run to tens of seconds -- a server's `Retry-After`, or backoff
/// near its cap -- and a pause that queued behind one would leave the user
/// watching a download they had stopped, for the same reason the chunk loop
/// races its reads.
async fn wait_unless_stopped(control: &Control, delay: Duration) -> Result<()> {
    tokio::select! {
        biased;
        () = control.stopped() => control.check(),
        () = tokio::time::sleep(delay) => Ok(()),
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

/// What a response says about the file it came from, in the shape
/// [`RemoteInfo::conflicts_with`] compares.
fn observed(h: &HeaderMap, size: Option<u64>) -> RemoteInfo {
    RemoteInfo {
        size,
        etag: probe::header_string(h, ETAG),
        last_modified: probe::header_string(h, LAST_MODIFIED),
        ..Default::default()
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_range(
    ctx: &TransferContext,
    remote: &RemoteInfo,
    lease: &Lease,
    idx: usize,
    table: &Arc<Mutex<SegmentTable>>,
    file: &mut tokio::fs::File,
    start: u64,
    end: u64,
) -> Result<Streamed> {
    let url = remote.final_url.as_str();
    let mut headers = probe::headers_for(&ctx.headers, remote);
    let range = format!("bytes={start}-{end}");
    headers.insert(
        RANGE,
        HeaderValue::from_str(&range).map_err(|e| Error::Other(e.to_string()))?,
    );
    // Every range is conditional on the version the bytes already on disk came
    // from. Without this, a file replaced between two requests -- a retry
    // after a dropped connection, a steal, a resume -- is served as a slice of
    // the new version and written beside slices of the old one.
    if let Some(validator) = remote.validator() {
        if let Ok(value) = HeaderValue::from_str(validator.as_header()) {
            headers.insert(IF_RANGE, value);
        }
    }

    let response = ctx.client.get(url).headers(headers).send().await?;
    let status = response.status();

    if status != StatusCode::PARTIAL_CONTENT {
        if status.is_success() {
            // A 200 is the server either refusing our If-Range because the file
            // changed, or ignoring Range altogether; its validators say which.
            // Either way a full body must never be written into a mid-file
            // segment slot.
            let length = probe::header_string(response.headers(), CONTENT_LENGTH)
                .and_then(|v| v.parse::<u64>().ok());
            if let Err(reason) = observed(response.headers(), length).conflicts_with(remote) {
                return Err(Error::RemoteChanged { reason });
            }
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
    // A 206 without a Content-Range cannot be placed in the file at all.
    let Some(cr) = probe::header_string(response.headers(), CONTENT_RANGE) else {
        return Err(Error::Other(
            "server sent a partial response with no Content-Range".to_string(),
        ));
    };
    match probe::parse_content_range_span(&cr) {
        Some((got_start, got_end)) if got_start == start && got_end >= got_start => {}
        Some((got_start, got_end)) => {
            return Err(Error::Other(format!(
                "server returned bytes {got_start}-{got_end} when {start}-{end} was requested"
            )));
        }
        None => {
            return Err(Error::Other(format!("unparseable Content-Range: {cr}")));
        }
    }

    // A server that ignores If-Range still labels what it sent. A different
    // total or validator means this slice is from another version of the
    // file, and it is refused before a byte of it reaches the disk.
    let served_total = probe::parse_content_range_total_str(&cr);
    if let Err(reason) = observed(response.headers(), served_total).conflicts_with(remote) {
        return Err(Error::RemoteChanged { reason });
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
        // tokio's `write_all` returns once the chunk is buffered, before the
        // OS has it. The cursor is what a checkpoint vouches for, so it moves
        // only once the bytes are really in the file.
        file.flush().await.map_err(Error::PlainIo)?;
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

        // Another download is queued for this origin and this one holds more
        // than its share. Every byte so far is written and counted, so the
        // segment simply carries on from its cursor when a slot comes back.
        if cursor <= table.lock().bounds(idx).1 && lease.should_yield() {
            return Ok(Streamed::Yielded);
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
    Ok(Streamed::Complete)
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
    lease: &Lease,
    part_path: &Path,
    _config: &TransferConfig,
) -> Result<u64> {
    // One connection for the whole body, and it is never yielded: a single
    // stream cannot resume, so giving the slot back would mean starting over.
    let _permit = acquire_unless_stopped(&ctx.control, lease).await?;
    ctx.progress.downloaded.store(0, Ordering::Relaxed);
    ctx.progress.active_connections.store(1, Ordering::Relaxed);
    ctx.progress
        .peak_connections
        .fetch_max(1, Ordering::Relaxed);

    let headers = probe::headers_for(&ctx.headers, remote);
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
