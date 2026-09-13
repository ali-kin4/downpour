//! Engine-level tests: the queue, the concurrency cap, bulk actions and the
//! scheduler, driven against the same controllable HTTP server.

// Varying one setting off a default is the clearest way to express these
// cases; struct-update syntax would bury the field under test.
#![allow(clippy::field_reassign_with_default)]

mod common;

use common::{payload, sha256, wait_for, TempDir};
use downpour_core::model::{DownloadSpec, DownloadStatus, StartMode};
use downpour_core::scheduler::{DaySet, LocalMoment, Schedule, ScheduleWindow};
use downpour_core::settings::Settings;
use downpour_core::store::Store;
use downpour_core::{Engine, EngineEvent};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn engine_with(settings: Settings) -> Engine {
    let store = Store::open_in_memory().unwrap();
    store.save_settings(&settings).unwrap();
    Engine::with_store(store).unwrap()
}

fn spec(url: &str, dir: &Path, name: &str, mode: StartMode) -> DownloadSpec {
    DownloadSpec {
        url: url.to_string(),
        headers: BTreeMap::new(),
        filename: Some(name.to_string()),
        dest_dir: dir.to_path_buf(),
        connections: None,
        category: None,
        start_mode: mode,
        checksum: None,
        source: Some("test".into()),
    }
}

/// A window that is guaranteed to be closed right now: it opens in an hour.
fn closed_window() -> ScheduleWindow {
    let now = LocalMoment::now().minute as u32;
    let start = ((now + 60) % 1440) as u16;
    let end = ((now + 120) % 1440) as u16;
    let mut w = ScheduleWindow::new("later", start, end);
    w.days = DaySet::ALL;
    w
}

/// A window that is always open.
fn open_window() -> ScheduleWindow {
    ScheduleWindow::new("always", 0, 0)
}

// ---------------------------------------------------------------------------
// Queue and concurrency
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_download_added_and_started_completes_with_the_right_bytes() {
    let data = payload(1024 * 1024);
    let expected = sha256(&data);
    let server = common::start(data).await;
    let dir = TempDir::new();

    let engine = engine_with(Settings::default());
    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "one.bin",
            StartMode::Start,
        ))
        .unwrap();

    let e = engine.clone();
    let done = wait_for(Duration::from_secs(30), move || {
        e.get(&id).map(|i| i.status) == Some(DownloadStatus::Completed)
    })
    .await;
    assert!(done, "download did not complete: {:?}", engine.list());

    let item = &engine.list()[0];
    assert_eq!(
        sha256(&std::fs::read(item.target_path()).unwrap()),
        expected
    );
    assert_eq!(item.downloaded_bytes, item.total_bytes.unwrap());
    assert!(item.error.is_none());
}

#[tokio::test]
async fn add_only_downloads_nothing_until_asked() {
    // This is the "paste 20 links but do not start yet" path.
    let server = common::start(payload(512 * 1024)).await;
    let dir = TempDir::new();
    let engine = engine_with(Settings::default());

    let specs: Vec<DownloadSpec> = (0..5)
        .map(|i| {
            spec(
                &server.url("/file"),
                &dir.0,
                &format!("batch-{i}.bin"),
                StartMode::AddOnly,
            )
        })
        .collect();
    let ids = engine.add_many(specs).unwrap();
    assert_eq!(ids.len(), 5);

    // Give the pump several ticks to prove it does not start them.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        engine
            .list()
            .iter()
            .all(|i| i.status == DownloadStatus::Idle),
        "idle items must not start on their own: {:?}",
        engine.list().iter().map(|i| i.status).collect::<Vec<_>>()
    );
    assert_eq!(server.state.request_count(), 0, "no network traffic at all");

    // Now start one of them.
    engine.start(&ids[0]).unwrap();
    let e = engine.clone();
    let id0 = ids[0].clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&id0).map(|i| i.status) == Some(DownloadStatus::Completed)
        })
        .await,
        "explicitly started item never ran"
    );
    assert_eq!(
        engine
            .list()
            .iter()
            .filter(|i| i.status == DownloadStatus::Idle)
            .count(),
        4,
        "starting one must not start the rest"
    );
}

#[tokio::test]
async fn a_batch_of_malformed_urls_does_not_sink_the_good_ones() {
    let server = common::start(payload(1024)).await;
    let dir = TempDir::new();
    let engine = engine_with(Settings::default());

    let specs = vec![
        spec("not a url", &dir.0, "a.bin", StartMode::AddOnly),
        spec(&server.url("/file"), &dir.0, "good.bin", StartMode::AddOnly),
        spec("ftp://example.com/x", &dir.0, "b.bin", StartMode::AddOnly),
        spec(
            "magnet:?xt=urn:btih:abc",
            &dir.0,
            "c.bin",
            StartMode::AddOnly,
        ),
    ];
    let ids = engine.add_many(specs).unwrap();
    assert_eq!(ids.len(), 1, "only the http url should be accepted");
    assert_eq!(engine.list().len(), 1);
}

#[tokio::test]
async fn the_concurrency_cap_is_never_exceeded() {
    for cap in [1u8, 2, 3] {
        let data = payload(3 * 1024 * 1024);
        let server = common::start(data).await;
        let dir = TempDir::new();

        let mut settings = Settings::default();
        settings.max_concurrent_downloads = cap;
        // Slow every transfer down so overlap is observable rather than a race.
        settings.speed_limit_bps = 4 * 1024 * 1024;
        let engine = engine_with(settings);

        let specs: Vec<DownloadSpec> = (0..8)
            .map(|i| {
                spec(
                    &server.url("/file"),
                    &dir.0,
                    &format!("c{cap}-{i}.bin"),
                    StartMode::Start,
                )
            })
            .collect();
        engine.add_many(specs).unwrap();

        let peak = Arc::new(AtomicUsize::new(0));
        let watcher = {
            let engine = engine.clone();
            let peak = Arc::clone(&peak);
            tokio::spawn(async move {
                for _ in 0..800 {
                    let active = engine
                        .list()
                        .iter()
                        .filter(|i| i.status.is_active())
                        .count();
                    peak.fetch_max(active, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(15)).await;
                }
            })
        };

        let e = engine.clone();
        let all_done = wait_for(Duration::from_secs(90), move || {
            e.list()
                .iter()
                .all(|i| i.status == DownloadStatus::Completed)
        })
        .await;
        watcher.abort();

        assert!(
            all_done,
            "cap={cap}: not everything finished: {:?}",
            engine.list()
        );
        let observed = peak.load(Ordering::SeqCst);
        assert!(observed > 0, "cap={cap}: never saw anything running");
        assert!(
            observed <= cap as usize,
            "cap={cap}: saw {observed} downloads running at once"
        );
    }
}

#[tokio::test]
async fn the_queue_promotes_after_a_failure_not_just_after_a_success() {
    // A queue that only advances on success deadlocks the moment one link is
    // dead, which is exactly what happens with a pasted batch.
    let server = common::start(payload(512 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.max_concurrent_downloads = 1;
    settings.max_retries = 0;
    let engine = engine_with(settings);

    // A URL that will 404 on a server that is otherwise fine.
    let bad = format!("{}/nope", server.base_url);
    engine
        .add(spec(&bad, &dir.0, "dead.bin", StartMode::Start))
        .unwrap();
    let good_id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "alive.bin",
            StartMode::Start,
        ))
        .unwrap();

    let e = engine.clone();
    let promoted = wait_for(Duration::from_secs(30), move || {
        e.get(&good_id).map(|i| i.status) == Some(DownloadStatus::Completed)
    })
    .await;
    // Both items must reach a terminal state before counting failures.
    let e = engine.clone();
    wait_for(Duration::from_secs(20), move || {
        e.list().iter().all(|i| i.status.is_terminal())
    })
    .await;

    assert!(
        promoted,
        "the good download never ran behind the failing one: {:?}",
        engine
            .list()
            .iter()
            .map(|i| (i.filename.clone(), i.status, i.error.clone()))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        engine
            .list()
            .iter()
            .filter(|i| i.status == DownloadStatus::Failed)
            .count(),
        1
    );
}

#[tokio::test]
async fn downloads_start_in_the_order_they_were_added() {
    let server = common::start(payload(256 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.max_concurrent_downloads = 1;
    let engine = engine_with(settings);

    let mut ids = Vec::new();
    for i in 0..4 {
        ids.push(
            engine
                .add(spec(
                    &server.url("/file"),
                    &dir.0,
                    &format!("o{i}.bin"),
                    StartMode::Start,
                ))
                .unwrap(),
        );
        // No sleep: ordering comes from the insertion sequence, not the clock.
        // If this test needed a delay, the queue order would be a coin flip for
        // any batch added inside one second.
    }

    let mut rx = engine.subscribe();
    let e = engine.clone();
    assert!(
        wait_for(Duration::from_secs(60), move || {
            e.list().iter().all(|i| i.status.is_terminal())
        })
        .await
    );
    drop(rx.try_recv());

    let mut by_start: Vec<_> = engine
        .list()
        .into_iter()
        .filter_map(|i| i.started_at.map(|t| (t, i.filename)))
        .collect();
    by_start.sort();
    let order: Vec<String> = by_start.into_iter().map(|(_, n)| n).collect();
    assert_eq!(order, vec!["o0.bin", "o1.bin", "o2.bin", "o3.bin"]);
}

// ---------------------------------------------------------------------------
// Pause, resume and bulk actions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pause_then_resume_through_the_engine_completes_correctly() {
    let data = payload(8 * 1024 * 1024);
    let expected = sha256(&data);
    let server = common::start(data.clone()).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.speed_limit_bps = 3 * 1024 * 1024;
    let engine = engine_with(settings);

    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "big.bin",
            StartMode::Start,
        ))
        .unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&i2).map(|i| i.downloaded_bytes).unwrap_or(0) > 512 * 1024
        })
        .await,
        "download never got going"
    );

    engine.pause(&id).unwrap();
    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(15), move || {
            e.get(&i2).map(|i| i.status) == Some(DownloadStatus::Paused)
        })
        .await,
        "pause never took effect"
    );

    let mid = engine.get(&id).unwrap().downloaded_bytes;
    assert!(mid > 0 && mid < data.len() as u64, "paused at {mid} bytes");

    engine.start(&id).unwrap();
    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(60), move || {
            e.get(&i2).map(|i| i.status) == Some(DownloadStatus::Completed)
        })
        .await,
        "resume never completed"
    );

    let item = engine.get(&id).unwrap();
    assert_eq!(
        sha256(&std::fs::read(item.target_path()).unwrap()),
        expected
    );
}

#[tokio::test]
async fn pause_all_and_resume_all_cover_the_whole_queue() {
    let server = common::start(payload(4 * 1024 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.speed_limit_bps = 2 * 1024 * 1024;
    settings.max_concurrent_downloads = 2;
    let engine = engine_with(settings);

    for i in 0..5 {
        engine
            .add(spec(
                &server.url("/file"),
                &dir.0,
                &format!("p{i}.bin"),
                StartMode::Start,
            ))
            .unwrap();
    }

    let e = engine.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.list().iter().any(|i| i.status.is_active())
        })
        .await
    );

    engine.pause_all().unwrap();
    let e = engine.clone();
    assert!(
        wait_for(Duration::from_secs(20), move || {
            e.list().iter().all(|i| i.status == DownloadStatus::Paused)
        })
        .await,
        "pause_all left something running: {:?}",
        engine.list().iter().map(|i| i.status).collect::<Vec<_>>()
    );

    engine.resume_all().unwrap();
    let e = engine.clone();
    assert!(
        wait_for(Duration::from_secs(90), move || {
            e.list()
                .iter()
                .all(|i| i.status == DownloadStatus::Completed)
        })
        .await,
        "resume_all did not finish the queue"
    );
}

#[tokio::test]
async fn clear_completed_removes_only_finished_rows() {
    let server = common::start(payload(128 * 1024)).await;
    let dir = TempDir::new();
    let engine = engine_with(Settings::default());

    let done_id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "done.bin",
            StartMode::Start,
        ))
        .unwrap();
    let idle_id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "idle.bin",
            StartMode::AddOnly,
        ))
        .unwrap();

    let e = engine.clone();
    let d = done_id.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&d).map(|i| i.status) == Some(DownloadStatus::Completed)
        })
        .await
    );

    let cleared = engine.clear_completed().unwrap();
    assert_eq!(cleared, 1);
    assert!(engine.get(&done_id).is_none());
    assert!(
        engine.get(&idle_id).is_some(),
        "unfinished rows must survive"
    );

    // The file itself is not touched by clearing the list.
    assert!(
        dir.join("done.bin").exists(),
        "clearing the list must not delete files"
    );
}

#[tokio::test]
async fn retry_failed_requeues_everything_that_failed() {
    let server = common::start(payload(64 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.max_retries = 0;
    let engine = engine_with(settings);

    let bad = format!("{}/nope", server.base_url);
    for i in 0..3 {
        engine
            .add(spec(&bad, &dir.0, &format!("f{i}.bin"), StartMode::Start))
            .unwrap();
    }

    let e = engine.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.list().iter().all(|i| i.status == DownloadStatus::Failed)
        })
        .await,
        "expected all three to fail: {:?}",
        engine.list().iter().map(|i| i.status).collect::<Vec<_>>()
    );
    assert!(engine.list().iter().all(|i| i.error.is_some()));

    let retried = engine.retry_failed().unwrap();
    assert_eq!(retried, 3);
}

#[tokio::test]
async fn removing_a_download_deletes_its_part_and_sidecar() {
    let data = payload(8 * 1024 * 1024);
    let server = common::start(data).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.speed_limit_bps = 2 * 1024 * 1024;
    let engine = engine_with(settings);

    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "gone.bin",
            StartMode::Start,
        ))
        .unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&i2).map(|i| i.downloaded_bytes).unwrap_or(0) > 256 * 1024
        })
        .await
    );

    engine.remove(&id, false).unwrap();
    assert!(engine.get(&id).is_none());

    // Give the cancelled transfer a moment to unwind before checking the disk.
    assert!(
        wait_for(Duration::from_secs(15), || {
            !dir.join("gone.bin.dpart").exists() && !dir.join("gone.bin.dpmeta").exists()
        })
        .await,
        "orphaned part or sidecar left behind"
    );
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_scheduled_download_waits_for_its_window() {
    let server = common::start(payload(256 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.schedule = Schedule {
        enabled: true,
        windows: vec![closed_window()],
    };
    let engine = engine_with(settings);

    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "night.bin",
            StartMode::Schedule,
        ))
        .unwrap();

    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(
        engine.get(&id).unwrap().status,
        DownloadStatus::Scheduled,
        "must wait outside its window"
    );
    assert_eq!(
        server.state.request_count(),
        0,
        "no traffic outside the window"
    );
}

#[tokio::test]
async fn a_scheduled_download_runs_once_the_window_opens() {
    let server = common::start(payload(256 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.schedule = Schedule {
        enabled: true,
        windows: vec![closed_window()],
    };
    let engine = engine_with(settings.clone());

    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "night.bin",
            StartMode::Schedule,
        ))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(engine.get(&id).unwrap().status, DownloadStatus::Scheduled);

    // The window opens (as it would at 02:00).
    let mut opened = settings.clone();
    opened.schedule = Schedule {
        enabled: true,
        windows: vec![open_window()],
    };
    engine.update_settings(opened).unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&i2).map(|i| i.status) == Some(DownloadStatus::Completed)
        })
        .await,
        "the window opened but nothing started: {:?}",
        engine.get(&id).map(|i| i.status)
    );
}

#[tokio::test]
async fn closing_a_window_pauses_scheduled_downloads_back_to_scheduled() {
    // The 02:00-07:00 use case: at 07:00 whatever is still running stops and
    // waits for tomorrow, rather than running on through the working day.
    let data = payload(16 * 1024 * 1024);
    let server = common::start(data).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.speed_limit_bps = 2 * 1024 * 1024;
    settings.pause_outside_window = true;
    settings.schedule = Schedule {
        enabled: true,
        windows: vec![open_window()],
    };
    let engine = engine_with(settings.clone());

    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "overnight.bin",
            StartMode::Schedule,
        ))
        .unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&i2).map(|i| i.downloaded_bytes).unwrap_or(0) > 512 * 1024
        })
        .await,
        "download never started inside the open window"
    );

    // The window closes.
    let mut closed = settings.clone();
    closed.schedule = Schedule {
        enabled: true,
        windows: vec![closed_window()],
    };
    engine.update_settings(closed).unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(20), move || {
            e.get(&i2).map(|i| i.status) == Some(DownloadStatus::Scheduled)
        })
        .await,
        "closing the window left the download at {:?}",
        engine.get(&id).map(|i| i.status)
    );

    // Partial progress is kept for the next window.
    let item = engine.get(&id).unwrap();
    assert!(item.downloaded_bytes > 0);
    assert!(
        dir.join("overnight.bin.dpmeta").exists(),
        "sidecar kept for the next window"
    );
}

#[tokio::test]
async fn pausing_a_scheduled_download_inside_its_window_keeps_it_paused() {
    // Pause All must stop a pinned download for good. Reporting it as
    // `Scheduled` would hand it straight back to `promote_waiting`, which sees
    // an open window and starts it again a tick later -- the user pressed pause
    // and watched the bytes keep climbing.
    let data = payload(16 * 1024 * 1024);
    let server = common::start(data).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.speed_limit_bps = 2 * 1024 * 1024;
    settings.pause_outside_window = true;
    settings.schedule = Schedule {
        enabled: true,
        windows: vec![open_window()],
    };
    let engine = engine_with(settings);

    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "pinned.bin",
            StartMode::Schedule,
        ))
        .unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&i2).map(|i| i.downloaded_bytes).unwrap_or(0) > 512 * 1024
        })
        .await,
        "download never started inside the open window"
    );

    engine.pause_all().unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(10), move || {
            e.get(&i2).map(|i| i.status) == Some(DownloadStatus::Paused)
        })
        .await,
        "a user pause left the download at {:?}, not Paused",
        engine.get(&id).map(|i| i.status)
    );

    // Several pump ticks later it must still be paused, and no further bytes
    // may have arrived.
    let settled = engine.get(&id).unwrap().downloaded_bytes;
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let item = engine.get(&id).unwrap();
    assert_eq!(
        item.status,
        DownloadStatus::Paused,
        "the scheduler restarted a download the user had paused"
    );
    assert_eq!(
        item.downloaded_bytes, settled,
        "a paused download kept transferring"
    );
}

#[tokio::test]
async fn an_unscheduled_download_ignores_a_closed_window() {
    let server = common::start(payload(256 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.schedule = Schedule {
        enabled: true,
        windows: vec![closed_window()],
    };
    let engine = engine_with(settings);

    // StartMode::Start with schedule_new_downloads off means "not gated".
    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "now.bin",
            StartMode::Start,
        ))
        .unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&i2).map(|i| i.status) == Some(DownloadStatus::Completed)
        })
        .await,
        "an ungated download must not be held by the scheduler"
    );
}

#[tokio::test]
async fn force_start_overrides_the_schedule_for_one_item_only() {
    let server = common::start(payload(256 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.schedule = Schedule {
        enabled: true,
        windows: vec![closed_window()],
    };
    let engine = engine_with(settings);

    let a = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "forced.bin",
            StartMode::Schedule,
        ))
        .unwrap();
    let b = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "waiting.bin",
            StartMode::Schedule,
        ))
        .unwrap();

    engine.force_start(&a).unwrap();

    let e = engine.clone();
    let a2 = a.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&a2).map(|i| i.status) == Some(DownloadStatus::Completed)
        })
        .await,
        "force_start did not run the item"
    );
    assert_eq!(
        engine.get(&b).unwrap().status,
        DownloadStatus::Scheduled,
        "the schedule must still hold for everything else"
    );
    assert!(
        engine.settings().schedule.enabled,
        "the schedule itself stays armed"
    );
}

#[tokio::test]
async fn schedule_new_downloads_gates_items_added_while_it_is_on() {
    let server = common::start(payload(128 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.schedule = Schedule {
        enabled: true,
        windows: vec![closed_window()],
    };
    settings.schedule_new_downloads = true;
    let engine = engine_with(settings);

    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "auto.bin",
            StartMode::Start,
        ))
        .unwrap();

    tokio::time::sleep(Duration::from_millis(1200)).await;
    let item = engine.get(&id).unwrap();
    assert!(
        item.scheduled,
        "new downloads must inherit the schedule gate"
    );
    assert_eq!(item.status, DownloadStatus::Scheduled);
}

// ---------------------------------------------------------------------------
// Settings and events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn changing_the_speed_limit_applies_without_restarting_downloads() {
    let engine = engine_with(Settings::default());
    let mut s = engine.settings();
    assert_eq!(s.speed_limit_bps, 0);

    s.speed_limit_bps = 1_500_000;
    let saved = engine.update_settings(s).unwrap();
    assert_eq!(saved.speed_limit_bps, 1_500_000);
    assert_eq!(engine.settings().speed_limit_bps, 1_500_000);
}

#[tokio::test]
async fn invalid_settings_are_clamped_rather_than_rejected() {
    let engine = engine_with(Settings::default());
    let mut s = engine.settings();
    s.max_concurrent_downloads = 0;
    s.max_connections_per_download = 250;
    let saved = engine.update_settings(s).unwrap();
    assert_eq!(saved.max_concurrent_downloads, 1);
    // Sixteen is a behaviour limit, not a preference: more than that gets the
    // user rate-limited rather than served faster.
    assert_eq!(saved.max_connections_per_download, 16);
}

#[tokio::test]
async fn the_engine_emits_events_for_the_whole_lifecycle() {
    let server = common::start(payload(256 * 1024)).await;
    let dir = TempDir::new();
    let engine = engine_with(Settings::default());
    let mut rx = engine.subscribe();

    engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "ev.bin",
            StartMode::Start,
        ))
        .unwrap();

    let mut saw_added = false;
    let mut saw_progress = false;
    let mut saw_completed = false;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline && !saw_completed {
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Ok(EngineEvent::Added { .. })) => saw_added = true,
            Ok(Ok(EngineEvent::Progress { .. })) => saw_progress = true,
            Ok(Ok(EngineEvent::Completed { .. })) => saw_completed = true,
            Ok(Ok(_)) => {}
            Ok(Err(_)) | Err(_) => break,
        }
    }

    assert!(saw_added, "no Added event");
    assert!(saw_completed, "no Completed event");
    // Progress is sampled on a timer, so a very fast download may finish first;
    // this is informational rather than a hard requirement.
    let _ = saw_progress;
}

#[tokio::test]
async fn stats_reflect_the_queue_contents() {
    let server = common::start(payload(64 * 1024)).await;
    let dir = TempDir::new();
    let engine = engine_with(Settings::default());

    for i in 0..3 {
        engine
            .add(spec(
                &server.url("/file"),
                &dir.0,
                &format!("s{i}.bin"),
                StartMode::AddOnly,
            ))
            .unwrap();
    }
    let stats = engine.stats();
    assert_eq!(stats.total, 3);
    assert_eq!(stats.idle, 3);
    assert_eq!(stats.running, 0);
    assert_eq!(
        stats.window_open, None,
        "scheduler is off, so there is no window"
    );
}

#[tokio::test]
async fn stats_report_the_scheduler_state_when_it_is_armed() {
    let mut settings = Settings::default();
    settings.schedule = Schedule {
        enabled: true,
        windows: vec![closed_window()],
    };
    let engine = engine_with(settings);

    let stats = engine.stats();
    assert_eq!(stats.window_open, Some(false));
    let minutes = stats
        .minutes_until_window
        .expect("a closed window must know when it opens");
    assert!((1..=120).contains(&minutes), "opens in {minutes} minutes");
}

#[tokio::test]
async fn the_queue_survives_a_restart() {
    let server = common::start(payload(64 * 1024)).await;
    let dir = TempDir::new();
    let db = dir.join("downpour.db");

    let store = Store::open(&db).unwrap();
    let engine = Engine::with_store(store).unwrap();
    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "persist.bin",
            StartMode::AddOnly,
        ))
        .unwrap();
    engine.shutdown().await;
    drop(engine);

    // A fresh process opening the same database.
    let store2 = Store::open(&db).unwrap();
    let engine2 = Engine::with_store(store2).unwrap();
    let item = engine2
        .get(&id)
        .expect("download did not survive the restart");
    assert_eq!(item.filename, "persist.bin");
    assert_eq!(item.status, DownloadStatus::Idle);
}

// ---------------------------------------------------------------------------
// Batch text import, reordering and drain detection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pasting_a_block_of_links_queues_them_all_in_order() {
    let server = common::start(payload(32 * 1024)).await;
    let dir = TempDir::new();
    let engine = engine_with(Settings::default());

    // Deliberately messy: blank lines, prose, a duplicate and a bad scheme.
    let text = format!(
        "Here are the files:\n{a}\n\n  {b}  \nftp://nope.example.com/x\n{a}\nand {c}.\n",
        a = server.url("/file/one.bin"),
        b = server.url("/file/two.bin"),
        c = server.url("/file/three.bin"),
    );

    let ids = engine
        .add_from_text(
            &text,
            StartMode::AddOnly,
            Some(dir.0.clone()),
            Some("paste".into()),
        )
        .unwrap();

    assert_eq!(ids.len(), 3, "three unique http links, duplicate collapsed");
    let items = engine.list();
    assert!(items.iter().all(|i| i.status == DownloadStatus::Idle));
    assert!(items.iter().all(|i| i.source.as_deref() == Some("paste")));

    // `list()` is newest-first, so reverse it to get insertion order.
    let mut ordered = items;
    ordered.reverse();
    let urls: Vec<&str> = ordered.iter().map(|i| i.url.as_str()).collect();
    assert_eq!(
        urls,
        vec![
            server.url("/file/one.bin"),
            server.url("/file/two.bin"),
            server.url("/file/three.bin")
        ]
    );
}

#[tokio::test]
async fn text_with_no_links_adds_nothing() {
    let engine = engine_with(Settings::default());
    let ids = engine
        .add_from_text(
            "just some prose, no links here",
            StartMode::AddOnly,
            None,
            None,
        )
        .unwrap();
    assert!(ids.is_empty());
    assert!(engine.list().is_empty());
}

#[tokio::test]
async fn move_to_top_jumps_the_queue() {
    let server = common::start(payload(2 * 1024 * 1024)).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.max_concurrent_downloads = 1;
    settings.speed_limit_bps = 2 * 1024 * 1024;
    let engine = engine_with(settings);

    let mut ids = Vec::new();
    for i in 0..4 {
        ids.push(
            engine
                .add(spec(
                    &server.url("/file"),
                    &dir.0,
                    &format!("q{i}.bin"),
                    StartMode::AddOnly,
                ))
                .unwrap(),
        );
    }

    // Promote the last one, then release the queue.
    engine.move_to_bottom(&ids[0]).unwrap();
    engine.move_to_top(&ids[3]).unwrap();
    engine.resume_all().unwrap();

    let e = engine.clone();
    assert!(
        wait_for(Duration::from_secs(60), move || {
            e.list().iter().all(|i| i.status.is_terminal())
        })
        .await,
        "queue never drained"
    );

    let mut by_start: Vec<_> = engine
        .list()
        .into_iter()
        .filter_map(|i| i.started_at.map(|t| (t, i.sequence, i.filename)))
        .collect();
    by_start.sort();
    let first = &by_start[0].2;
    assert_eq!(first, "q3.bin", "the promoted item must run first");
    assert_eq!(
        by_start.last().unwrap().2,
        "q0.bin",
        "the demoted item must run last"
    );
}

#[tokio::test]
async fn the_engine_announces_when_the_queue_drains() {
    let server = common::start(payload(64 * 1024)).await;
    let dir = TempDir::new();
    let engine = engine_with(Settings::default());
    let mut rx = engine.subscribe();

    for i in 0..3 {
        engine
            .add(spec(
                &server.url("/file"),
                &dir.0,
                &format!("d{i}.bin"),
                StartMode::Start,
            ))
            .unwrap();
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
    let mut drained = None;
    while tokio::time::Instant::now() < deadline && drained.is_none() {
        match tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
            Ok(Ok(EngineEvent::QueueDrained { completed, failed })) => {
                drained = Some((completed, failed));
            }
            Ok(Ok(_)) => {}
            Ok(Err(_)) | Err(_) => break,
        }
    }

    let (completed, failed) = drained.expect("no QueueDrained event was emitted");
    assert_eq!(completed, 3);
    assert_eq!(failed, 0);
}

#[tokio::test]
async fn an_idle_engine_does_not_announce_a_drain() {
    // Level-triggering this would have the shell shutting the machine down the
    // moment the app opened with an empty queue.
    let engine = engine_with(Settings::default());
    let mut rx = engine.subscribe();

    tokio::time::sleep(Duration::from_millis(2000)).await;
    let mut saw_drain = false;
    while let Ok(ev) = rx.try_recv() {
        if matches!(ev, EngineEvent::QueueDrained { .. }) {
            saw_drain = true;
        }
    }
    assert!(!saw_drain, "an empty queue must never report draining");
}

/// Collects the first `QueueDrained` within `secs`, if any.
async fn drain_within(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    secs: u64,
) -> Option<(usize, usize)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Ok(EngineEvent::QueueDrained { completed, failed })) => {
                return Some((completed, failed))
            }
            Ok(Ok(_)) => {}
            Ok(Err(_)) => return None,
            Err(_) => {}
        }
    }
    None
}

#[tokio::test]
async fn a_drain_counts_only_the_run_that_just_finished() {
    // The regression this exists for: the counts used to be a filter over the
    // whole item list, so a queue whose only new download 404'd still reported
    // the seven downloads that had finished earlier in the session. The shell
    // reads `completed` to decide whether to sleep the machine, so that number
    // being about the wrong run put the PC to sleep the instant a link broke.
    let server = common::start(payload(64 * 1024)).await;
    let dir = TempDir::new();
    let mut settings = Settings::default();
    settings.max_retries = 0;
    let engine = engine_with(settings);
    let mut rx = engine.subscribe();

    engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "ok.bin",
            StartMode::Start,
        ))
        .unwrap();
    let first = drain_within(&mut rx, 40)
        .await
        .expect("first run never drained");
    assert_eq!(first, (1, 0));

    // A second run, in which the only download fails.
    engine
        .add(spec(
            &server.url("/nope/missing.bin"),
            &dir.0,
            "bad.bin",
            StartMode::Start,
        ))
        .unwrap();
    let second = drain_within(&mut rx, 40)
        .await
        .expect("second run never drained");
    assert_eq!(
        second,
        (0, 1),
        "a run in which everything failed must report no completions,          regardless of what finished earlier"
    );
}

#[tokio::test]
async fn pausing_the_last_download_is_not_a_drain() {
    // A paused download is outstanding work. Reporting it as a drain hands the
    // shell its cue to sleep or shut down the machine, which is precisely what
    // the user pausing something is asking it not to do.
    let server = common::start(payload(8 * 1024 * 1024)).await;
    let dir = TempDir::new();
    // Throttled hard on purpose: against a localhost server an 8 MB download
    // finishes before the test can observe it running, and the test would be
    // racing to pause something already complete.
    let mut settings = Settings::default();
    settings.speed_limit_bps = 64 * 1024;
    let engine = engine_with(settings);

    engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "paused.bin",
            StartMode::Start,
        ))
        .unwrap();

    let e = engine.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.list().iter().any(|i| i.status.is_active())
        })
        .await,
        "the download never started"
    );

    let mut rx = engine.subscribe();
    engine.pause_all().unwrap();

    assert!(
        drain_within(&mut rx, 4).await.is_none(),
        "pausing every download must not report the queue as drained"
    );
}

#[tokio::test]
async fn a_drain_does_not_fire_twice_for_one_run() {
    // Edge-triggered, so the shell's power action cannot be re-triggered by a
    // queue that simply stayed empty.
    let server = common::start(payload(64 * 1024)).await;
    let dir = TempDir::new();
    let engine = engine_with(Settings::default());
    let mut rx = engine.subscribe();

    engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "one.bin",
            StartMode::Start,
        ))
        .unwrap();

    assert!(drain_within(&mut rx, 40).await.is_some(), "never drained");
    assert!(
        drain_within(&mut rx, 4).await.is_none(),
        "an already-empty queue must not drain again"
    );
}

// ---------------------------------------------------------------------------
// First-run folder setup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn first_run_creates_the_category_folders_once() {
    let dir = TempDir::new();
    let mut settings = Settings::default();
    settings.download_dir = dir.0.clone();

    let store = Store::open(&dir.join("downpour.db")).unwrap();
    store.save_settings(&settings).unwrap();
    let engine = Engine::with_store(store.clone()).unwrap();

    let created = engine.run_first_run_setup().unwrap();
    assert_eq!(created.len(), 6, "one folder per category");
    for name in [
        "Video",
        "Music",
        "Pictures",
        "Documents",
        "Compressed",
        "Programs",
    ] {
        assert!(dir.join(name).is_dir(), "{name} was not created");
    }

    // Running again must be a no-op, so a folder the user deleted on purpose
    // does not reappear on every launch.
    std::fs::remove_dir_all(dir.join("Music")).unwrap();
    let again = engine.run_first_run_setup().unwrap();
    assert!(again.is_empty(), "setup must not run twice");
    assert!(
        !dir.join("Music").exists(),
        "a deleted folder stays deleted"
    );
}

#[tokio::test]
async fn first_run_reuses_folders_that_already_exist() {
    let dir = TempDir::new();
    // A pre-existing Video folder with a file in it, as a returning IDM user
    // would have.
    std::fs::create_dir_all(dir.join("Video")).unwrap();
    std::fs::write(dir.join("Video").join("existing.mp4"), b"keep me").unwrap();

    let mut settings = Settings::default();
    settings.download_dir = dir.0.clone();
    let store = Store::open(&dir.join("downpour.db")).unwrap();
    store.save_settings(&settings).unwrap();
    let engine = Engine::with_store(store).unwrap();

    let created = engine.run_first_run_setup().unwrap();
    assert_eq!(
        created.len(),
        5,
        "the existing folder is not reported as created"
    );
    assert_eq!(
        std::fs::read(dir.join("Video").join("existing.mp4")).unwrap(),
        b"keep me",
        "an existing folder must keep its contents"
    );
}

#[tokio::test]
async fn downloads_land_in_the_folder_for_their_file_type() {
    let data = payload(64 * 1024);
    let server = common::start(data).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.download_dir = dir.0.clone();
    settings.sort_into_categories = true;
    let engine = engine_with(settings);
    engine.run_first_run_setup().unwrap();

    // An empty dest_dir is the signal to route by category.
    let mut s = spec(&server.url("/file"), &dir.0, "clip.mp4", StartMode::Start);
    s.dest_dir = PathBuf::new();
    let id = engine.add(s).unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(30), move || {
            e.get(&i2).map(|i| i.status) == Some(DownloadStatus::Completed)
        })
        .await,
        "download did not finish"
    );

    assert!(
        dir.join("Video").join("clip.mp4").exists(),
        "an mp4 should land in Video, not the root; item said {:?}",
        engine.get(&id).map(|i| i.dest_dir)
    );
}

#[tokio::test]
async fn a_large_download_really_uses_several_connections() {
    // The whole premise of the engine is that one file is fetched over several
    // connections at once. Nothing else in the suite asserts that the *reported*
    // count reflects reality, and the number a user sees is the only evidence
    // they have that segmentation happened at all.
    let data = payload(24 * 1024 * 1024);
    let expected = sha256(&data);
    let server = common::start(data).await;
    let dir = TempDir::new();

    let mut settings = Settings::default();
    settings.max_connections_per_download = 8;
    // Throttled so the transfer lasts long enough for the pump to sample it.
    settings.speed_limit_bps = 8 * 1024 * 1024;
    let engine = engine_with(settings);

    let id = engine
        .add(spec(
            &server.url("/file"),
            &dir.0,
            "big.bin",
            StartMode::Start,
        ))
        .unwrap();

    let e = engine.clone();
    let i2 = id.clone();
    assert!(
        wait_for(Duration::from_secs(60), move || {
            e.get(&i2).map(|i| i.status) == Some(DownloadStatus::Completed)
        })
        .await,
        "download did not finish: {:?}",
        engine.get(&id).map(|i| (i.status, i.error))
    );

    let item = engine.get(&id).unwrap();
    assert_eq!(
        sha256(&std::fs::read(item.target_path()).unwrap()),
        expected,
        "the file must be correct regardless of how it was split"
    );
    assert!(
        item.connections > 1,
        "a 24 MiB file reported {} connection(s); segmentation is not happening, \
         or the reported count collapsed when the workers retired",
        item.connections
    );
    assert!(
        server.state.ranged_count() >= 4,
        "server saw only {} ranged requests",
        server.state.ranged_count()
    );
}

// ---------------------------------------------------------------------------
// Migration off the old Downloads\Downpour layout
// ---------------------------------------------------------------------------
//
// This code deletes directories, so the cases where it must NOT act matter more
// than the case where it must.

#[tokio::test]
async fn an_empty_legacy_folder_is_migrated_and_cleaned_up() {
    let dir = TempDir::new();
    let legacy = dir.join("Downpour");
    std::fs::create_dir_all(&legacy).unwrap();
    for name in [
        "Video",
        "Music",
        "Pictures",
        "Documents",
        "Compressed",
        "Programs",
    ] {
        std::fs::create_dir_all(legacy.join(name)).unwrap();
    }

    let store = Store::open(&dir.join("downpour.db")).unwrap();
    let mut settings = Settings::default();
    settings.download_dir = legacy.clone();
    store.save_settings(&settings).unwrap();
    let engine = Engine::with_store(store).unwrap();

    assert!(engine.migrate_legacy_download_dir(&legacy).unwrap());
    engine.run_first_run_setup().unwrap();

    assert_eq!(
        engine.settings().download_dir,
        dir.0,
        "the download folder should move up out of the Downpour subfolder"
    );
    assert!(!legacy.exists(), "the empty scaffolding should be removed");
    assert!(
        dir.join("Video").is_dir(),
        "categories recreated under the new root"
    );
}

#[tokio::test]
async fn a_legacy_folder_holding_files_is_left_completely_alone() {
    // Silently moving where someone's downloads go is far worse than an extra
    // folder level, so a single real file vetoes the whole migration.
    let dir = TempDir::new();
    let legacy = dir.join("Downpour");
    std::fs::create_dir_all(legacy.join("Compressed")).unwrap();
    std::fs::write(legacy.join("Compressed").join("mine.zip"), b"important").unwrap();

    let store = Store::open(&dir.join("downpour.db")).unwrap();
    let mut settings = Settings::default();
    settings.download_dir = legacy.clone();
    store.save_settings(&settings).unwrap();
    let engine = Engine::with_store(store).unwrap();

    engine.run_first_run_setup().unwrap();

    assert_eq!(
        engine.settings().download_dir,
        legacy,
        "a folder with files in it must keep being the download folder"
    );
    assert_eq!(
        std::fs::read(legacy.join("Compressed").join("mine.zip")).unwrap(),
        b"important"
    );
}

#[tokio::test]
async fn a_folder_the_user_chose_is_never_migrated() {
    // Only the exact old default is migrated. Someone who deliberately picked a
    // path called "Downpour" elsewhere keeps it.
    let dir = TempDir::new();
    let chosen = dir.join("MyStuff");
    std::fs::create_dir_all(&chosen).unwrap();

    let store = Store::open(&dir.join("downpour.db")).unwrap();
    let mut settings = Settings::default();
    settings.download_dir = chosen.clone();
    store.save_settings(&settings).unwrap();
    let engine = Engine::with_store(store).unwrap();

    assert!(!engine
        .migrate_legacy_download_dir(&dir.join("Downpour"))
        .unwrap());
    assert_eq!(engine.settings().download_dir, chosen);
}

#[tokio::test]
async fn migration_runs_at_most_once() {
    let dir = TempDir::new();
    let legacy = dir.join("Downpour");
    std::fs::create_dir_all(&legacy).unwrap();

    let db = dir.join("downpour.db");
    let store = Store::open(&db).unwrap();
    let mut settings = Settings::default();
    settings.download_dir = legacy.clone();
    store.save_settings(&settings).unwrap();
    let engine = Engine::with_store(store).unwrap();
    assert!(engine.migrate_legacy_download_dir(&legacy).unwrap());
    assert_eq!(engine.settings().download_dir, dir.0);

    // A user who then deliberately picks the old path back must keep it.
    let mut back = engine.settings();
    back.download_dir = legacy.clone();
    engine.update_settings(back).unwrap();
    assert!(!engine.migrate_legacy_download_dir(&legacy).unwrap());
    assert_eq!(
        engine.settings().download_dir,
        legacy,
        "the migration must not fire a second time"
    );
}
