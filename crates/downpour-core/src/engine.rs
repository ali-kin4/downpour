//! The orchestrator: queue, concurrency cap, scheduler enforcement and events.
//!
//! Everything the UI can do goes through [`Engine`]. It owns the item list, the
//! persistence store and the set of in-flight transfers, and it runs a single
//! background "pump" that is the only place downloads are promoted or demoted.
//! Concentrating every state transition in one loop is what keeps the
//! concurrency cap honest: with transitions scattered across callbacks it is
//! very easy to end up starting a fourth download while three are running.

use crate::error::{Error, Result};
use crate::model::{
    DownloadId, DownloadItem, DownloadSpec, DownloadStatus, EngineEvent, StartMode,
};
use crate::naming;
use crate::probe;
use crate::resume::now_unix;
use crate::scheduler::LocalMoment;
use crate::settings::{ConflictPolicy, Settings};
use crate::speed::SpeedTracker;
use crate::store::Store;
use crate::throttle::RateLimiter;
use crate::transfer::{
    self, Control, PauseReason, TransferConfig, TransferContext, TransferProgress,
};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

/// How often the pump promotes work and samples progress. 500ms is fast enough
/// that the UI feels live and slow enough that it costs nothing.
const PUMP_INTERVAL: Duration = Duration::from_millis(500);

const EVENT_CAPACITY: usize = 4096;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub db_path: PathBuf,
}

/// Counts the UI shows in the sidebar and the tray tooltip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStats {
    pub total: usize,
    pub running: usize,
    pub queued: usize,
    pub scheduled: usize,
    pub paused: usize,
    pub completed: usize,
    pub failed: usize,
    pub idle: usize,
    pub total_speed_bps: u64,
    /// `None` when the scheduler is off entirely.
    pub window_open: Option<bool>,
    pub minutes_until_window: Option<u32>,
}

/// Outcome of resolving a download's on-disk name.
enum Claim {
    Named(String),
    /// The file already existed and the conflict policy said to leave it alone.
    SkippedExisting(PathBuf),
}

struct Running {
    control: Control,
    progress: Arc<TransferProgress>,
    tracker: Mutex<SpeedTracker>,
    started_at: std::time::Instant,
}

struct Inner {
    store: Store,
    settings: RwLock<Settings>,
    client: RwLock<reqwest::Client>,
    items: RwLock<HashMap<DownloadId, DownloadItem>>,
    running: RwLock<HashMap<DownloadId, Arc<Running>>>,
    limiter: RateLimiter,
    events: broadcast::Sender<EngineEvent>,
    shutdown: AtomicBool,
    /// Last known scheduler state, so window transitions are only announced
    /// once rather than twice a second.
    last_window_open: Mutex<Option<bool>>,
    /// Serialises filename resolution. Two downloads that resolve to the same
    /// name must not both claim it: the first to finish renames its part file
    /// away and the second fails with "file not found" halfway through.
    name_lock: Mutex<()>,
    /// Hands out the next queue position. Seeded past whatever is already in
    /// the database so a restart does not reuse positions.
    next_sequence: AtomicI64,
    /// Whether the queue had work last tick, so `QueueDrained` fires once on
    /// the busy-to-idle edge rather than on every tick of an empty queue.
    was_busy: AtomicBool,
    /// Downloads that finished during the *current* busy period, reset on every
    /// idle-to-busy edge.
    ///
    /// The drain report must describe this run, not the whole list. Counting
    /// `Completed` items in the store instead reports every download that ever
    /// finished, so a queue in which the single new download failed still
    /// reports "7 completed" and the shell happily sleeps the machine.
    completed_this_run: AtomicUsize,
    failed_this_run: AtomicUsize,
}

/// Handle to the download engine. Cheap to clone; all clones share one queue.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Result<Self> {
        let store = Store::open(&config.db_path)?;
        Self::with_store(store)
    }

    /// Builds an engine over an existing store. The integration tests use an
    /// in-memory store here, which is why this is public.
    pub fn with_store(store: Store) -> Result<Self> {
        let settings = store.load_settings()?;
        let client = transfer::build_client(
            &settings.user_agent,
            Duration::from_secs(settings.request_timeout_secs),
        )?;

        let loaded = store.load_all()?;
        let next_sequence = loaded.iter().map(|i| i.sequence).max().unwrap_or(0) + 1;
        let items: HashMap<DownloadId, DownloadItem> =
            loaded.into_iter().map(|i| (i.id.clone(), i)).collect();

        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let limiter = RateLimiter::new(settings.speed_limit_bps);

        let inner = Arc::new(Inner {
            store,
            settings: RwLock::new(settings),
            client: RwLock::new(client),
            items: RwLock::new(items),
            running: RwLock::new(HashMap::new()),
            limiter,
            events,
            shutdown: AtomicBool::new(false),
            last_window_open: Mutex::new(None),
            name_lock: Mutex::new(()),
            next_sequence: AtomicI64::new(next_sequence),
            was_busy: AtomicBool::new(false),
            completed_this_run: AtomicUsize::new(0),
            failed_this_run: AtomicUsize::new(0),
        });

        let engine = Engine { inner };
        engine.spawn_pump();
        Ok(engine)
    }

    // -- Observation -------------------------------------------------------

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.inner.events.subscribe()
    }

    /// Newest first, which is how the UI lists them.
    pub fn list(&self) -> Vec<DownloadItem> {
        let mut v: Vec<DownloadItem> = self.inner.items.read().values().cloned().collect();
        v.sort_by_key(|i| std::cmp::Reverse(i.sequence));
        v
    }

    pub fn get(&self, id: &str) -> Option<DownloadItem> {
        self.inner.items.read().get(id).cloned()
    }

    pub fn settings(&self) -> Settings {
        self.inner.settings.read().clone()
    }

    pub fn stats(&self) -> QueueStats {
        let items = self.inner.items.read();
        let mut s = QueueStats {
            total: items.len(),
            ..Default::default()
        };
        for i in items.values() {
            match i.status {
                DownloadStatus::Running | DownloadStatus::Probing => s.running += 1,
                DownloadStatus::Queued => s.queued += 1,
                DownloadStatus::Scheduled => s.scheduled += 1,
                DownloadStatus::Paused => s.paused += 1,
                DownloadStatus::Completed => s.completed += 1,
                DownloadStatus::Failed => s.failed += 1,
                DownloadStatus::Idle => s.idle += 1,
                DownloadStatus::Cancelled => {}
            }
            s.total_speed_bps += i.speed_bps;
        }
        drop(items);

        let settings = self.inner.settings.read();
        if settings.schedule.enabled {
            let now = LocalMoment::now();
            s.window_open = Some(settings.schedule.open_window(now).is_some());
            s.minutes_until_window = settings.schedule.minutes_until_next_open(now);
        }
        s
    }

    // -- Adding ------------------------------------------------------------

    /// Adds one download. The filename shown immediately is derived from the
    /// URL; it is corrected from `Content-Disposition` once the transfer probes.
    pub fn add(&self, spec: DownloadSpec) -> Result<DownloadId> {
        let mut ids = self.add_many(vec![spec])?;
        ids.pop()
            .ok_or_else(|| Error::Other("add produced no id".into()))
    }

    /// Adds a batch in one pass.
    ///
    /// This is the path the "paste 20 links" dialog, the `.txt` import and the
    /// browser extension all use, so it must not fail the whole batch because
    /// one URL is malformed: bad entries are skipped and the rest are added.
    pub fn add_many(&self, specs: Vec<DownloadSpec>) -> Result<Vec<DownloadId>> {
        let settings = self.inner.settings.read().clone();
        let mut ids = Vec::with_capacity(specs.len());

        for spec in specs {
            let url = spec.url.trim().to_string();
            let parsed = match url::Url::parse(&url) {
                Ok(u) if matches!(u.scheme(), "http" | "https") => u,
                _ => {
                    tracing::warn!(url, "skipping unusable url in batch");
                    continue;
                }
            };

            let user_named = spec
                .filename
                .as_deref()
                .and_then(naming::sanitize)
                .is_some();
            let filename = naming::derive(spec.filename.as_deref(), None, &parsed, None);
            let dest_dir = if spec.dest_dir.as_os_str().is_empty() {
                settings.dest_dir_for(&filename)
            } else {
                spec.dest_dir.clone()
            };

            let scheduled = matches!(spec.start_mode, StartMode::Schedule)
                || (settings.schedule_new_downloads && settings.schedule.enabled);

            let status = match spec.start_mode {
                StartMode::AddOnly => DownloadStatus::Idle,
                StartMode::Schedule => DownloadStatus::Scheduled,
                StartMode::Start if scheduled => DownloadStatus::Scheduled,
                StartMode::Start => DownloadStatus::Queued,
            };

            let item = DownloadItem {
                id: uuid::Uuid::new_v4().to_string(),
                url,
                final_url: None,
                filename,
                user_named,
                name_locked: false,
                dest_dir,
                headers: spec.headers,
                status,
                total_bytes: None,
                downloaded_bytes: 0,
                speed_bps: 0,
                eta_secs: None,
                connections: spec
                    .connections
                    .unwrap_or(settings.max_connections_per_download),
                supports_range: false,
                category: spec.category,
                source: spec.source,
                scheduled,
                error: None,
                checksum: spec.checksum,
                created_at: now_unix(),
                sequence: self.inner.next_sequence.fetch_add(1, Ordering::SeqCst),
                started_at: None,
                completed_at: None,
                elapsed_ms: 0,
            };

            self.inner.store.upsert(&item)?;
            ids.push(item.id.clone());
            self.inner
                .items
                .write()
                .insert(item.id.clone(), item.clone());
            self.emit(EngineEvent::Added {
                item: Box::new(item),
            });
        }

        Ok(ids)
    }

    /// Extracts every http(s) URL from a blob of text and adds them all.
    ///
    /// This is the "I have twenty links in my clipboard, or in a .txt file"
    /// path. Duplicates within the text are collapsed and the original order is
    /// preserved, so the queue matches what the user pasted.
    pub fn add_from_text(
        &self,
        text: &str,
        start_mode: StartMode,
        dest_dir: Option<PathBuf>,
        source: Option<String>,
    ) -> Result<Vec<DownloadId>> {
        let urls = crate::extract_urls(text);
        if urls.is_empty() {
            return Ok(Vec::new());
        }
        let dir = dest_dir.unwrap_or_default();
        let specs = urls
            .into_iter()
            .map(|url| DownloadSpec {
                url,
                headers: Default::default(),
                filename: None,
                dest_dir: dir.clone(),
                connections: None,
                category: None,
                start_mode,
                checksum: None,
                source: source.clone(),
            })
            .collect();
        self.add_many(specs)
    }

    /// Moves a download to the front of the queue.
    ///
    /// Sequence numbers are only ever compared, never assumed contiguous, so
    /// jumping the queue is a single assignment below the current minimum
    /// rather than a renumbering of every other row.
    pub fn move_to_top(&self, id: &str) -> Result<()> {
        let min = self
            .inner
            .items
            .read()
            .values()
            .map(|i| i.sequence)
            .min()
            .unwrap_or(0);
        self.set_sequence(id, min - 1)
    }

    /// Moves a download to the back of the queue.
    pub fn move_to_bottom(&self, id: &str) -> Result<()> {
        let next = self.inner.next_sequence.fetch_add(1, Ordering::SeqCst);
        self.set_sequence(id, next)
    }

    fn set_sequence(&self, id: &str, sequence: i64) -> Result<()> {
        {
            let mut items = self.inner.items.write();
            let item = items
                .get_mut(id)
                .ok_or_else(|| Error::NotFound(id.into()))?;
            item.sequence = sequence;
        }
        self.persist(id);
        self.emit_status(id);
        Ok(())
    }

    // -- Control -----------------------------------------------------------

    /// Moves a download into the queue. The pump starts it when a slot frees up.
    pub fn start(&self, id: &str) -> Result<()> {
        let scheduled = {
            let items = self.inner.items.read();
            let item = items.get(id).ok_or_else(|| Error::NotFound(id.into()))?;
            if item.status.is_active() || item.status == DownloadStatus::Queued {
                return Ok(());
            }
            item.scheduled
        };
        let next = if scheduled && self.inner.settings.read().schedule.enabled {
            DownloadStatus::Scheduled
        } else {
            DownloadStatus::Queued
        };
        self.set_status(id, next, None)
    }

    /// Starts a download right now, bypassing its scheduler gate.
    ///
    /// This is the "download this one anyway" action; it clears the item's
    /// `scheduled` flag rather than disabling the whole schedule.
    pub fn force_start(&self, id: &str) -> Result<()> {
        {
            let mut items = self.inner.items.write();
            let item = items
                .get_mut(id)
                .ok_or_else(|| Error::NotFound(id.into()))?;
            item.scheduled = false;
        }
        self.persist(id);
        self.set_status(id, DownloadStatus::Queued, None)
    }

    pub fn pause(&self, id: &str) -> Result<()> {
        if let Some(run) = self.inner.running.read().get(id) {
            // The transfer task notices, flushes its sidecar and reports
            // `Paused`, which is what actually writes the status.
            run.control.pause();
            return Ok(());
        }
        let status = self
            .inner
            .items
            .read()
            .get(id)
            .map(|i| i.status)
            .ok_or_else(|| Error::NotFound(id.into()))?;
        if matches!(
            status,
            DownloadStatus::Queued | DownloadStatus::Scheduled | DownloadStatus::Idle
        ) {
            self.set_status(id, DownloadStatus::Paused, None)?;
            // The pump can start a queued item in the gap between the lookup
            // above and that write. If a handle has appeared, signal it too --
            // otherwise the row reads `Paused` over a transfer that is still
            // running. Signalling one that is already stopping is harmless.
            if let Some(run) = self.inner.running.read().get(id) {
                run.control.pause();
            }
        }
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        if let Some(run) = self.inner.running.read().get(id) {
            run.control.cancel();
        }
        self.set_status(id, DownloadStatus::Cancelled, None)
    }

    /// Removes a download from the list, optionally deleting what it wrote.
    pub fn remove(&self, id: &str, delete_files: bool) -> Result<()> {
        if let Some(run) = self.inner.running.read().get(id) {
            run.control.cancel();
        }
        let item = self.inner.items.write().remove(id);
        self.inner.store.delete(id)?;

        if let Some(item) = item {
            if delete_files {
                // Best effort: a file locked by a virus scanner must not turn
                // "remove from list" into an error the user cannot clear.
                let _ = std::fs::remove_file(item.part_path());
                let _ = std::fs::remove_file(item.meta_path());
                if item.status == DownloadStatus::Completed {
                    let _ = std::fs::remove_file(item.target_path());
                }
            } else if item.status != DownloadStatus::Completed {
                // An unfinished part file with no list entry is orphaned junk;
                // the sidecar alone is worthless without it.
                let _ = std::fs::remove_file(item.meta_path());
                let _ = std::fs::remove_file(item.part_path());
            }
        }
        self.emit(EngineEvent::Removed { id: id.to_string() });
        Ok(())
    }

    // -- Bulk actions ------------------------------------------------------

    pub fn pause_all(&self) -> Result<()> {
        for id in self.ids_matching(|s| {
            s.is_active() || matches!(s, DownloadStatus::Queued | DownloadStatus::Scheduled)
        }) {
            self.pause(&id)?;
        }
        Ok(())
    }

    pub fn resume_all(&self) -> Result<()> {
        for id in self.ids_matching(|s| matches!(s, DownloadStatus::Paused | DownloadStatus::Idle))
        {
            self.start(&id)?;
        }
        Ok(())
    }

    /// Re-queues everything that failed. The transfer resumes from its sidecar
    /// where one survives, so a retry after a dropped connection does not
    /// restart from zero.
    pub fn retry_failed(&self) -> Result<usize> {
        let ids = self.ids_matching(|s| s == DownloadStatus::Failed);
        for id in &ids {
            if let Some(item) = self.inner.items.write().get_mut(id) {
                item.error = None;
            }
            self.start(id)?;
        }
        Ok(ids.len())
    }

    /// Clears finished rows from the list. Files on disk are untouched.
    pub fn clear_completed(&self) -> Result<usize> {
        self.clear_statuses(&[DownloadStatus::Completed])
    }

    /// Clears everything that will not run again: completed, failed, cancelled.
    pub fn clear_finished(&self) -> Result<usize> {
        self.clear_statuses(&[
            DownloadStatus::Completed,
            DownloadStatus::Failed,
            DownloadStatus::Cancelled,
        ])
    }

    fn clear_statuses(&self, statuses: &[DownloadStatus]) -> Result<usize> {
        let removed = self.inner.store.delete_by_status(statuses)?;
        let mut items = self.inner.items.write();
        for id in &removed {
            items.remove(id);
        }
        drop(items);
        for id in &removed {
            self.emit(EngineEvent::Removed { id: id.clone() });
        }
        Ok(removed.len())
    }

    /// Toggles the scheduler gate on one item.
    pub fn set_scheduled(&self, id: &str, scheduled: bool) -> Result<()> {
        {
            let mut items = self.inner.items.write();
            let item = items
                .get_mut(id)
                .ok_or_else(|| Error::NotFound(id.into()))?;
            item.scheduled = scheduled;
            // Move it to the matching waiting state so the change is visible
            // immediately rather than at the next pump tick.
            item.status = match (scheduled, item.status) {
                (true, DownloadStatus::Queued) => DownloadStatus::Scheduled,
                (false, DownloadStatus::Scheduled) => DownloadStatus::Queued,
                (_, other) => other,
            };
        }
        self.persist(id);
        self.emit_status(id);
        Ok(())
    }

    // -- Settings ----------------------------------------------------------

    pub fn update_settings(&self, mut settings: Settings) -> Result<Settings> {
        settings.normalise();

        let rebuild_client = {
            let current = self.inner.settings.read();
            current.user_agent != settings.user_agent
                || current.request_timeout_secs != settings.request_timeout_secs
        };
        if rebuild_client {
            let client = transfer::build_client(
                &settings.user_agent,
                Duration::from_secs(settings.request_timeout_secs),
            )?;
            *self.inner.client.write() = client;
        }

        self.inner.store.save_settings(&settings)?;
        // Applies live to in-flight transfers; no restart, no dropped download.
        let inside = settings.schedule.enabled
            && settings.schedule.open_window(LocalMoment::now()).is_some();
        self.inner
            .limiter
            .set_rate(settings.effective_speed_limit(inside));
        *self.inner.settings.write() = settings.clone();
        Ok(settings)
    }

    // -- Lifecycle ---------------------------------------------------------

    /// Pauses everything and stops the pump. Sidecars are flushed by the
    /// transfer tasks as they wind down, so a later launch resumes cleanly.
    pub async fn shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        let running: Vec<Arc<Running>> = self.inner.running.read().values().cloned().collect();
        for r in &running {
            // Parked, not user-paused: closing the app is not the user asking
            // for a scheduled download to stop waiting for its window.
            r.control.park();
        }
        // Give the workers a moment to flush their sidecars. Waiting forever
        // would hang the app on a wedged socket, so this is bounded.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !self.inner.running.read().is_empty() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    // -- Internals ---------------------------------------------------------

    fn ids_matching(&self, pred: impl Fn(DownloadStatus) -> bool) -> Vec<DownloadId> {
        let mut v: Vec<(i64, DownloadId)> = self
            .inner
            .items
            .read()
            .values()
            .filter(|i| pred(i.status))
            .map(|i| (i.sequence, i.id.clone()))
            .collect();
        v.sort();
        v.into_iter().map(|(_, id)| id).collect()
    }

    fn emit(&self, event: EngineEvent) {
        // A send error only means nobody is listening, which is normal for a
        // headless run.
        let _ = self.inner.events.send(event);
    }

    fn emit_status(&self, id: &str) {
        if let Some(item) = self.inner.items.read().get(id) {
            let _ = self.inner.events.send(EngineEvent::StatusChanged {
                id: id.to_string(),
                status: item.status,
                error: item.error.clone(),
            });
        }
    }

    fn persist(&self, id: &str) {
        let item = self.inner.items.read().get(id).cloned();
        if let Some(item) = item {
            if let Err(e) = self.inner.store.upsert(&item) {
                tracing::error!(error = %e, id, "failed to persist download");
            }
        }
    }

    fn set_status(&self, id: &str, status: DownloadStatus, error: Option<String>) -> Result<()> {
        {
            let mut items = self.inner.items.write();
            let item = items
                .get_mut(id)
                .ok_or_else(|| Error::NotFound(id.into()))?;
            item.status = status;
            item.error = error;
            if !status.is_active() {
                item.speed_bps = 0;
                item.eta_secs = None;
            }
            if status == DownloadStatus::Completed {
                item.completed_at = Some(now_unix());
            }
        }
        // Tallied here because this is the one place a download reaches a
        // terminal state, and `detect_drain` needs the result of *this* run.
        match status {
            DownloadStatus::Completed => {
                self.inner.completed_this_run.fetch_add(1, Ordering::SeqCst);
            }
            DownloadStatus::Failed => {
                self.inner.failed_this_run.fetch_add(1, Ordering::SeqCst);
            }
            _ => {}
        }
        self.persist(id);
        self.emit_status(id);
        Ok(())
    }

    fn spawn_pump(&self) {
        let engine = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(PUMP_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                if engine.inner.shutdown.load(Ordering::Relaxed) {
                    break;
                }
                engine.pump_once();
            }
        });
    }

    /// One pass of the state machine. Split out from the loop so tests can
    /// drive it deterministically instead of sleeping.
    pub fn pump_once(&self) {
        let settings = self.inner.settings.read().clone();
        let now = LocalMoment::now();
        let schedule_active = settings.schedule.enabled;
        let window_open = !schedule_active || settings.schedule.open_window(now).is_some();

        self.announce_window_changes(&settings, schedule_active, window_open, now);
        self.sample_progress();

        if schedule_active && !window_open && settings.pause_outside_window {
            self.pause_scheduled_transfers();
        }

        self.promote_waiting(schedule_active, window_open);
        self.fill_free_slots(&settings, window_open);
        self.detect_drain();
    }

    /// Fires `QueueDrained` on the busy-to-idle edge.
    ///
    /// Edge-triggered on purpose: a level-triggered version would fire twice a
    /// second forever on an empty queue, and the shell would shut the machine
    /// down the moment the app opened.
    ///
    /// `Paused` counts as busy. A paused download is outstanding work, not
    /// finished work, so pausing the last running item must not be reported as
    /// the queue draining — the shell turns a drain into sleep or shutdown, and
    /// "I paused it to come back later" is the exact moment not to do that. The
    /// cost of this is that a queue left with a paused item never drains, which
    /// is the direction worth failing in.
    fn detect_drain(&self) {
        let busy = {
            let items = self.inner.items.read();
            items.values().any(|i| {
                i.status.is_active()
                    || matches!(
                        i.status,
                        DownloadStatus::Queued | DownloadStatus::Scheduled | DownloadStatus::Paused
                    )
            })
        };
        let was_busy = self.inner.was_busy.swap(busy, Ordering::SeqCst);

        if !was_busy && busy {
            // A new run starts here; the previous run's tally is spent.
            self.inner.completed_this_run.store(0, Ordering::SeqCst);
            self.inner.failed_this_run.store(0, Ordering::SeqCst);
            return;
        }

        if was_busy && !busy {
            let completed = self.inner.completed_this_run.swap(0, Ordering::SeqCst);
            let failed = self.inner.failed_this_run.swap(0, Ordering::SeqCst);
            tracing::info!(completed, failed, "queue drained");
            self.emit(EngineEvent::QueueDrained { completed, failed });
        }
    }

    fn announce_window_changes(
        &self,
        settings: &Settings,
        schedule_active: bool,
        window_open: bool,
        now: LocalMoment,
    ) {
        let observed = if schedule_active {
            Some(window_open)
        } else {
            None
        };
        let mut last = self.inner.last_window_open.lock();
        if *last == observed {
            return;
        }
        *last = observed;
        drop(last);

        if let Some(open) = observed {
            let label = settings.schedule.open_window(now).map(|w| {
                w.label
                    .clone()
                    .unwrap_or_else(|| format!("{}-{}", w.format_start(), w.format_end()))
            });
            // The limit can differ inside a window, so re-apply it on every
            // transition rather than only when settings change.
            self.inner
                .limiter
                .set_rate(settings.effective_speed_limit(open));
            self.emit(EngineEvent::SchedulerWindow { open, label });
        }
    }

    /// Reads the live counters of every in-flight transfer and publishes them.
    fn sample_progress(&self) {
        let running: Vec<(DownloadId, Arc<Running>)> = self
            .inner
            .running
            .read()
            .iter()
            .map(|(k, v)| (k.clone(), Arc::clone(v)))
            .collect();

        for (id, run) in running {
            let downloaded = run.progress.downloaded.load(Ordering::Relaxed);
            let total = match run.progress.total.load(Ordering::Relaxed) {
                0 => None,
                v => Some(v),
            };
            // Peak, not live: the live count collapses to zero the moment the
            // last worker retires, which would make every finished row claim it
            // used a single connection.
            let connections = run.progress.peak_connections.load(Ordering::Relaxed) as u8;
            let (speed, eta) = {
                let mut tracker = run.tracker.lock();
                let speed = tracker.sample(downloaded);
                (speed, tracker.eta_secs(downloaded, total))
            };

            let mut items = self.inner.items.write();
            let Some(item) = items.get_mut(&id) else {
                continue;
            };
            item.downloaded_bytes = downloaded;
            item.total_bytes = total.or(item.total_bytes);
            item.speed_bps = speed;
            item.eta_secs = eta;
            item.connections = connections.max(1);
            item.elapsed_ms = run.started_at.elapsed().as_millis() as u64;
            drop(items);

            self.emit(EngineEvent::Progress {
                id,
                downloaded_bytes: downloaded,
                total_bytes: total,
                speed_bps: speed,
                eta_secs: eta,
                connections: connections.max(1),
            });
        }
    }

    /// Stops transfers that are only allowed to run inside a window, now that
    /// the window has closed. They come back as `Scheduled`, not `Paused`, so
    /// the next window picks them up without the user doing anything.
    fn pause_scheduled_transfers(&self) {
        let ids: Vec<DownloadId> = self
            .inner
            .items
            .read()
            .values()
            .filter(|i| i.scheduled && i.status.is_active())
            .map(|i| i.id.clone())
            .collect();

        for id in ids {
            if let Some(run) = self.inner.running.read().get(&id) {
                tracing::info!(id, "scheduler window closed; pausing");
                run.control.park();
            }
        }
    }

    /// Moves items between the two waiting states as the window opens and shuts.
    fn promote_waiting(&self, schedule_active: bool, window_open: bool) {
        let mut changed = Vec::new();
        {
            let mut items = self.inner.items.write();
            for item in items.values_mut() {
                let next = match item.status {
                    DownloadStatus::Scheduled if !schedule_active || window_open => {
                        Some(DownloadStatus::Queued)
                    }
                    DownloadStatus::Queued if schedule_active && !window_open && item.scheduled => {
                        Some(DownloadStatus::Scheduled)
                    }
                    _ => None,
                };
                if let Some(next) = next {
                    item.status = next;
                    changed.push(item.id.clone());
                }
            }
        }
        for id in changed {
            self.persist(&id);
            self.emit_status(&id);
        }
    }

    /// Starts queued downloads until the concurrency cap is reached.
    fn fill_free_slots(&self, settings: &Settings, window_open: bool) {
        if self.inner.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let cap = settings.max_concurrent_downloads.max(1) as usize;

        loop {
            let active = self
                .inner
                .items
                .read()
                .values()
                .filter(|i| i.status.is_active())
                .count();
            if active >= cap {
                return;
            }

            // Lowest sequence wins, so a batch downloads in the order it was
            // pasted. Ordering by `created_at` would be non-deterministic:
            // twenty links pasted at once all share the same second.
            let next = {
                let items = self.inner.items.read();
                let mut candidates: Vec<&DownloadItem> = items
                    .values()
                    .filter(|i| i.status == DownloadStatus::Queued)
                    .filter(|i| !i.scheduled || window_open)
                    .collect();
                candidates.sort_by_key(|i| i.sequence);
                candidates.first().map(|i| i.id.clone())
            };

            let Some(id) = next else { return };
            if let Err(e) = self.begin_transfer(&id, settings) {
                tracing::error!(error = %e, id, "failed to start transfer");
                let _ = self.set_status(&id, DownloadStatus::Failed, Some(e.to_string()));
            }
        }
    }

    fn begin_transfer(&self, id: &str, settings: &Settings) -> Result<()> {
        let item = self
            .inner
            .items
            .read()
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound(id.into()))?;

        let control = Control::new();
        let progress = Arc::new(TransferProgress::default());
        let run = Arc::new(Running {
            control: control.clone(),
            progress: Arc::clone(&progress),
            tracker: Mutex::new(SpeedTracker::new(item.downloaded_bytes)),
            started_at: std::time::Instant::now(),
        });
        self.inner
            .running
            .write()
            .insert(id.to_string(), Arc::clone(&run));

        // `fill_free_slots` picked this id under a read lock it has since
        // dropped, so a pause or cancel may have landed in between. Re-check
        // under the write lock that will flip the status, or a Pause All
        // arriving in that gap is overwritten and the download runs anyway.
        {
            let mut items = self.inner.items.write();
            let still_queued = items
                .get(id)
                .is_some_and(|i| i.status == DownloadStatus::Queued);
            if !still_queued {
                // Drop the handle again; leaving it behind would make `pause`
                // and `cancel` signal a transfer that never started.
                drop(items);
                self.inner.running.write().remove(id);
                return Ok(());
            }
            if let Some(i) = items.get_mut(id) {
                i.status = DownloadStatus::Probing;
                i.error = None;
                if i.started_at.is_none() {
                    i.started_at = Some(now_unix());
                }
            }
        }
        self.persist(id);
        self.emit_status(id);

        let engine = self.clone();
        let client = self.inner.client.read().clone();
        let limiter = self.inner.limiter.clone();
        let config = TransferConfig {
            connections: item.connections.max(1),
            max_retries: settings.max_retries,
            min_steal_bytes: transfer::DEFAULT_MIN_STEAL_BYTES,
            checksum: item.checksum.clone(),
            request_timeout: Duration::from_secs(settings.request_timeout_secs),
        };
        let conflict = settings.conflict_policy;
        let id_owned = id.to_string();

        tokio::spawn(async move {
            let ctx = TransferContext {
                client,
                headers: item.headers.clone(),
                control,
                limiter,
                progress,
            };
            let outcome = engine.drive_transfer(&ctx, &item, &config, conflict).await;
            engine.finish_transfer(&id_owned, outcome).await;
        });

        Ok(())
    }

    /// Probes, resolves the final filename, then runs the transfer.
    ///
    /// The probe happens here rather than inside the transfer so the engine can
    /// correct the displayed filename from `Content-Disposition` and apply the
    /// conflict policy before a single byte is written.
    async fn drive_transfer(
        &self,
        ctx: &TransferContext,
        item: &DownloadItem,
        config: &TransferConfig,
        conflict: ConflictPolicy,
    ) -> Result<PathBuf> {
        let remote = probe::probe(&ctx.client, &item.url, &ctx.headers).await?;

        let parsed = url::Url::parse(&remote.final_url)
            .or_else(|_| url::Url::parse(&item.url))
            .map_err(|e| Error::InvalidUrl(e.to_string()))?;

        tokio::fs::create_dir_all(&item.dest_dir)
            .await
            .map_err(|source| Error::Io {
                path: item.dest_dir.clone(),
                source,
            })?;

        let filename = match self.claim_filename(
            item,
            remote.suggested_filename.as_deref(),
            &parsed,
            remote.content_type.as_deref(),
            conflict,
        )? {
            Claim::Named(name) => name,
            Claim::SkippedExisting(path) => return Ok(path),
        };

        {
            let mut items = self.inner.items.write();
            if let Some(i) = items.get_mut(&item.id) {
                i.filename = filename.clone();
                i.name_locked = true;
                i.final_url = Some(remote.final_url.clone());
                i.total_bytes = remote.size;
                i.supports_range = remote.supports_range;
                i.status = DownloadStatus::Running;
            }
        }
        self.persist(&item.id);
        self.emit_status(&item.id);

        let final_path = item.dest_dir.join(&filename);
        let part_path = item.dest_dir.join(format!("{filename}.dpart"));
        let meta_path = item.dest_dir.join(format!("{filename}.dpmeta"));

        let outcome =
            transfer::run_transfer(ctx, &remote, &final_path, &part_path, &meta_path, config)
                .await?;
        Ok(outcome.path)
    }

    /// Whether a download other than `except` is already using this name.
    ///
    /// Every status counts. A finished one has no part file to collide with,
    /// and anything else -- paused, failed, queued -- may still resume onto it.
    fn name_is_claimed(&self, dir: &Path, name: &str, except: &str) -> bool {
        self.inner
            .items
            .read()
            .values()
            .any(|i| i.id != except && i.filename == name && i.dest_dir == dir)
    }

    /// Settles the on-disk name for a download and reserves it.
    ///
    /// Runs under `name_lock` and creates the part file before releasing it, so
    /// two downloads started in the same tick cannot both decide they own
    /// `setup.exe.dpart`; the first to finish would rename it away and the
    /// second would fail mid-transfer. Once claimed, the item records
    /// `name_locked` and every later attempt reuses the name verbatim -- without
    /// that, a resume would deduplicate itself into a fresh name and restart
    /// from zero every time.
    fn claim_filename(
        &self,
        item: &DownloadItem,
        content_disposition: Option<&str>,
        url: &url::Url,
        content_type: Option<&str>,
        conflict: ConflictPolicy,
    ) -> Result<Claim> {
        if item.name_locked {
            return Ok(Claim::Named(item.filename.clone()));
        }

        let _guard = self.inner.name_lock.lock();

        // A user-chosen name is authoritative: the server does not get to
        // rename a file the user explicitly asked to save as something else.
        let desired = if item.user_named {
            item.filename.clone()
        } else {
            naming::derive(None, content_disposition, url, content_type)
        };

        let target = item.dest_dir.join(&desired);
        let part = item.dest_dir.join(format!("{desired}.dpart"));

        // `adopted` travels with the name: the reservation below refuses to
        // touch an existing part file, which is right for every other case and
        // exactly wrong for this one -- the file being there is the whole point.
        let mut adopted = false;
        let filename = if target.exists() {
            match conflict {
                ConflictPolicy::Skip => {
                    tracing::info!(path = %target.display(), "file exists; skipping");
                    return Ok(Claim::SkippedExisting(target));
                }
                ConflictPolicy::Overwrite => {
                    let _ = std::fs::remove_file(&target);
                    desired
                }
                ConflictPolicy::Rename => naming::deduplicate(&item.dest_dir, &desired),
            }
        } else if part.exists() {
            // A part file usually means another transfer is mid-flight on this
            // name, and stepping aside is right. But it can also be an orphan:
            // the entry was removed from the list while its bytes stayed on
            // disk. Dodging that name starts a download from zero that is
            // already most of the way finished -- and the old bytes are then
            // stranded, because nothing will ever point at them again.
            //
            // So adopt an orphan, under two conditions. No other download may
            // claim the name, or we would be racing a live transfer; and the
            // sidecar must name the same URL, because resuming one file into
            // another file's bytes is the one failure this engine must never
            // produce. Same name and same size is not enough to be sure --
            // `check_still_valid` compares the response, not the address.
            if self.name_is_claimed(&item.dest_dir, &desired, &item.id)
                || !sidecar_covers(&item.dest_dir, &desired, &item.url)
            {
                naming::deduplicate(&item.dest_dir, &desired)
            } else {
                tracing::info!(
                    name = %desired,
                    "adopting an orphaned part file rather than starting over"
                );
                adopted = true;
                desired
            }
        } else {
            desired
        };

        // An adopted orphan needs no reservation: its part file is already on
        // disk, and its existence is what reserves the name. Creating it is not
        // merely unnecessary here, it is the one thing that must not happen --
        // `create_new` would report the file as an obstacle and the fallback
        // below would rename around the very bytes we set out to keep.
        if adopted {
            return Ok(Claim::Named(filename));
        }

        // Reserve it on disk before releasing the lock. `create_new` also
        // covers the one race the lock cannot: another process writing into
        // the same folder.
        let claim_path = item.dest_dir.join(format!("{filename}.dpart"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&claim_path)
        {
            Ok(_) => Ok(Claim::Named(filename)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let fallback = naming::deduplicate(&item.dest_dir, &filename);
                let path = item.dest_dir.join(format!("{fallback}.dpart"));
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|source| Error::Io { path, source })?;
                Ok(Claim::Named(fallback))
            }
            Err(source) => Err(Error::Io {
                path: claim_path,
                source,
            }),
        }
    }

    async fn finish_transfer(&self, id: &str, outcome: Result<PathBuf>) {
        // Snapshot the final byte count before dropping the handle, or a
        // completed download reports whatever the last 500ms sample happened
        // to catch.
        if let Some(run) = self.inner.running.read().get(id) {
            let downloaded = run.progress.downloaded.load(Ordering::Relaxed);
            let mut items = self.inner.items.write();
            if let Some(i) = items.get_mut(id) {
                i.downloaded_bytes = downloaded.max(i.downloaded_bytes);
                i.elapsed_ms = run.started_at.elapsed().as_millis() as u64;
            }
        }
        // Read off the handle before it goes, or the pause below cannot tell a
        // user pause from a parked one.
        let pause_reason = self
            .inner
            .running
            .read()
            .get(id)
            .map(|r| r.control.pause_reason());
        self.inner.running.write().remove(id);

        match outcome {
            Ok(path) => {
                {
                    let mut items = self.inner.items.write();
                    if let Some(i) = items.get_mut(id) {
                        if let Some(total) = i.total_bytes {
                            i.downloaded_bytes = total;
                        }
                        i.speed_bps = 0;
                        i.eta_secs = None;
                    }
                }
                let _ = self.set_status(id, DownloadStatus::Completed, None);
                // Read the item back *after* the status change so the event
                // carries the finished state rather than the running one.
                if let Some(item) = self.inner.items.read().get(id).cloned() {
                    self.emit(EngineEvent::Completed {
                        id: id.to_string(),
                        path,
                        item: Box::new(item),
                    });
                }
            }
            Err(Error::Paused) => {
                // A parked transfer goes back to whichever waiting state it
                // belongs in, so a window close does not look like a user
                // pause. A *user* pause must never land on `Scheduled`:
                // `promote_waiting` would hand it straight back to the queue on
                // the next tick and restart the download the user just stopped.
                let parked = pause_reason == Some(PauseReason::Parked);
                let scheduled = self
                    .inner
                    .items
                    .read()
                    .get(id)
                    .map(|i| i.scheduled)
                    .unwrap_or(false);
                let next = if parked && scheduled && self.inner.settings.read().schedule.enabled {
                    DownloadStatus::Scheduled
                } else {
                    DownloadStatus::Paused
                };
                let _ = self.set_status(id, next, None);
            }
            Err(Error::Cancelled) => {
                let _ = self.set_status(id, DownloadStatus::Cancelled, None);
            }
            Err(e) => {
                let message = e.to_string();
                tracing::warn!(id, error = %message, "download failed");
                let _ = self.set_status(id, DownloadStatus::Failed, Some(message.clone()));
                self.emit(EngineEvent::Failed {
                    id: id.to_string(),
                    error: message,
                });
            }
        }
    }
}

impl Engine {
    /// Moves an existing install off the old `Downloads\Downpour` default.
    ///
    /// Only when it is safe to do without surprising anyone: the setting must
    /// still be exactly the old default, and the folder must contain no actual
    /// files. If the user has downloads sitting in there, or picked that path
    /// themselves, it is left alone — silently changing where someone's files
    /// go is far worse than an extra folder level.
    ///
    /// The empty category folders the old default created are removed too, so
    /// the migration does not leave six abandoned directories behind.
    /// Takes the legacy path as an argument rather than reading it from the
    /// environment, so the behaviour that deletes directories can actually be
    /// tested against a temporary one.
    pub fn migrate_legacy_download_dir(&self, legacy: &std::path::Path) -> Result<bool> {
        const FLAG: &str = "legacy_dir_migrated";
        if self.inner.store.flag(FLAG)? {
            return Ok(false);
        }

        let settings = self.inner.settings.read().clone();
        if settings.download_dir != legacy {
            // Never the old default, or already moved. Record it so this check
            // does not run again.
            self.inner.store.set_flag(FLAG, true)?;
            return Ok(false);
        }

        if directory_holds_files(legacy) {
            tracing::info!(
                path = %legacy.display(),
                "leaving the old download folder alone; it still holds files"
            );
            self.inner.store.set_flag(FLAG, true)?;
            return Ok(false);
        }

        let parent = legacy
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(crate::settings::default_download_dir);
        let mut next = settings.clone();
        next.download_dir = parent;
        self.update_settings(next)?;

        // Tidy up the empty scaffolding the old layout created.
        for folder in settings.category_folders() {
            let _ = std::fs::remove_dir(&folder);
        }
        let _ = std::fs::remove_dir(legacy);

        // The category folders must be recreated under the new root.
        self.inner.store.set_flag("first_run_done", false)?;
        self.inner.store.set_flag(FLAG, true)?;
        tracing::info!("moved the download folder out of the old Downpour subfolder");
        Ok(true)
    }

    /// One-time setup performed on the very first launch.
    ///
    /// Creates the category folders under the download directory, the way IDM
    /// does, so a new user finds Video / Music / Pictures / Documents /
    /// Compressed / Programs already waiting rather than one flat pile.
    ///
    /// Three properties matter and each is deliberate:
    ///
    /// - **Once, not every launch.** Guarded by a flag in the database. A user
    ///   who deletes a folder they do not want should not find it recreated
    ///   every time the app starts.
    /// - **Reuse, never replace.** `create_dir_all` succeeds on an existing
    ///   directory, so a folder the user already had keeps its contents.
    /// - **Never fatal.** A read-only or redirected Downloads folder must not
    ///   stop the app from opening; downloads simply land in the root.
    ///
    /// Returns the folders that did not previously exist, so the shell can say
    /// what it created rather than doing it silently.
    pub fn run_first_run_setup(&self) -> Result<Vec<PathBuf>> {
        const FLAG: &str = "first_run_done";
        self.migrate_legacy_download_dir(&crate::settings::legacy_download_dir())?;
        if self.inner.store.flag(FLAG)? {
            return Ok(Vec::new());
        }

        let settings = self.inner.settings.read().clone();
        let mut created = Vec::new();

        if let Err(e) = std::fs::create_dir_all(&settings.download_dir) {
            tracing::warn!(
                path = %settings.download_dir.display(),
                error = %e,
                "could not create the download folder; downloads will fail until it exists"
            );
            // Do not set the flag: the next launch should try again, because
            // the folder may simply not have been mounted yet.
            return Ok(Vec::new());
        }

        for folder in settings.category_folders() {
            let existed = folder.is_dir();
            match std::fs::create_dir_all(&folder) {
                Ok(()) => {
                    if !existed {
                        created.push(folder);
                    }
                }
                Err(e) => tracing::warn!(
                    path = %folder.display(),
                    error = %e,
                    "could not create category folder"
                ),
            }
        }

        self.inner.store.set_flag(FLAG, true)?;
        tracing::info!(created = created.len(), "first-run folder setup complete");
        Ok(created)
    }
}

/// Whether a directory tree contains any actual file, ignoring empty folders.
///
/// Used to decide whether the old `Downloads\Downpour` layout can be cleaned up
/// silently. Anything unreadable counts as occupied: the safe assumption when
/// deciding whether to delete someone's folder is that it matters.
fn directory_holds_files(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                if directory_holds_files(&entry.path()) {
                    return true;
                }
            }
            Ok(_) => return true,
            Err(_) => return true,
        }
    }
    false
}


/// Whether the sidecar beside `name` describes a download of `url`.
///
/// The guard on adopting an orphaned part file. A sidecar that cannot be read,
/// or that names a different address, means the bytes on disk belong to some
/// other file -- and resuming into them would splice two downloads together.
/// The answer is then no, and the caller picks a fresh name instead.
fn sidecar_covers(dir: &Path, name: &str, url: &str) -> bool {
    let meta = dir.join(format!("{name}.dpmeta"));
    match crate::resume::Sidecar::load(&meta) {
        Ok(side) => side.url == url,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RemoteInfo;
    use crate::resume::{plan_segments, Sidecar};

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dp-adopt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_sidecar(dir: &Path, name: &str, url: &str) {
        let remote = RemoteInfo {
            final_url: url.into(),
            size: Some(1024),
            supports_range: true,
            etag: None,
            last_modified: None,
            content_type: None,
            suggested_filename: None,
        };
        Sidecar::new(url.into(), remote, plan_segments(1024, 2), 1024)
            .save(&dir.join(format!("{name}.dpmeta")))
            .unwrap();
    }

    #[test]
    fn an_orphan_is_only_adopted_when_its_sidecar_names_the_same_url() {
        let dir = scratch();
        let url = "https://example.com/a.bin";

        // Nothing on disk: there is no orphan to adopt.
        assert!(!sidecar_covers(&dir, "a.bin", url));

        // The same download, interrupted. Its bytes are worth keeping.
        write_sidecar(&dir, "a.bin", url);
        assert!(sidecar_covers(&dir, "a.bin", url));

        // A different file that happens to share a name. Resuming into these
        // bytes would splice two downloads together, so it must be refused --
        // the sizes match here, which is exactly why size is not the test.
        write_sidecar(&dir, "b.bin", "https://elsewhere.example/other.bin");
        assert!(!sidecar_covers(&dir, "b.bin", url));

        // A part file with no sidecar carries nothing resumable, so adopting
        // it would only overwrite bytes we cannot use.
        std::fs::write(dir.join("c.bin.dpart"), b"partial").unwrap();
        assert!(!sidecar_covers(&dir, "c.bin", url));

        // Corrupt sidecar: unreadable is not "probably fine".
        std::fs::write(dir.join("d.bin.dpmeta"), b"{ not json").unwrap();
        assert!(!sidecar_covers(&dir, "d.bin", url));

        std::fs::remove_dir_all(&dir).ok();
    }
}
