//! End-to-end transfer tests against a controllable HTTP server.
//!
//! These are the tests that decide whether the engine is trustworthy. Each one
//! ends by comparing a SHA-256 of the file on disk against the bytes the server
//! actually holds, because length checks pass happily on corrupt files.

mod common;

use common::{payload, sha256, wait_for, Mode, TempDir};
use downpour_core::model::RemoteInfo;
use downpour_core::probe;
use downpour_core::throttle::RateLimiter;
use downpour_core::transfer::{
    self, Control, TransferConfig, TransferContext, TransferProgress,
};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

fn ctx(control: Control, limiter: RateLimiter, progress: Arc<TransferProgress>) -> TransferContext {
    TransferContext {
        client: transfer::build_client("downpour-test/0.1", Duration::from_secs(30)).unwrap(),
        headers: BTreeMap::new(),
        control,
        limiter,
        progress,
    }
}

struct Paths {
    dir: TempDir,
}

impl Paths {
    fn new() -> Self {
        Self { dir: TempDir::new() }
    }
    fn final_path(&self) -> std::path::PathBuf {
        self.dir.join("out.bin")
    }
    fn part_path(&self) -> std::path::PathBuf {
        self.dir.join("out.bin.dpart")
    }
    fn meta_path(&self) -> std::path::PathBuf {
        self.dir.join("out.bin.dpmeta")
    }
}

async fn probe_url(c: &reqwest::Client, url: &str) -> RemoteInfo {
    probe::probe(c, url, &BTreeMap::new()).await.unwrap()
}

fn file_sha(path: &Path) -> String {
    sha256(&std::fs::read(path).unwrap())
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn segmented_download_reassembles_to_the_correct_checksum() {
    // 16 MiB: large enough that `connections_for_size` grants four connections,
    // so this genuinely exercises the segmented path rather than the ramp floor.
    let data = payload(16 * 1024 * 1024);
    let expected = sha256(&data);
    let server = common::start(data.clone()).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    assert!(remote.supports_range, "honest server must advertise ranges");
    assert_eq!(remote.size, Some(data.len() as u64));

    let config = TransferConfig { connections: 8, ..Default::default() };
    let out = transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .unwrap();

    assert_eq!(out.total_bytes, data.len() as u64);
    assert_eq!(file_sha(&paths.final_path()), expected, "content must match byte for byte");
    assert!(
        server.state.ranged_count() >= 4,
        "expected several ranged requests, saw {}",
        server.state.ranged_count()
    );
}

#[tokio::test]
async fn every_connection_writes_at_its_own_offset() {
    // A 32 MiB file across 16 connections is where an offset bug shows up: a
    // worker that seeks wrong overwrites another worker's region and the hash
    // diverges while the length stays exactly right.
    let data = payload(32 * 1024 * 1024);
    let expected = sha256(&data);
    let server = common::start(data.clone()).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;

    let config = TransferConfig { connections: 16, ..Default::default() };
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .unwrap();

    assert_eq!(file_sha(&paths.final_path()), expected);
}

#[tokio::test]
async fn a_server_that_lies_about_range_support_still_produces_a_correct_file() {
    // The server advertises `Accept-Ranges: bytes` and then returns 200 with
    // the whole body. A downloader that trusts the advertisement writes the
    // entire file into every segment slot and corrupts the result.
    let data = payload(3 * 1024 * 1024);
    let expected = sha256(&data);
    let server = common::start_with(data.clone(), Mode::LiesAboutRanges, Some("\"v1\"")).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;

    assert!(
        !remote.supports_range,
        "the probe must not believe an advertisement contradicted by the response"
    );

    let config = TransferConfig { connections: 8, ..Default::default() };
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .unwrap();

    assert_eq!(file_sha(&paths.final_path()), expected, "fell back cleanly, no corruption");
}

#[tokio::test]
async fn a_server_without_range_support_downloads_in_one_stream() {
    let data = payload(1024 * 512);
    let expected = sha256(&data);
    let server = common::start_with(data.clone(), Mode::NoRanges, None).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    assert!(!remote.supports_range);
    assert_eq!(remote.size, Some(data.len() as u64), "size still known from Content-Length");

    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig::default(),
    )
    .await
    .unwrap();

    assert_eq!(file_sha(&paths.final_path()), expected);
}

#[tokio::test]
async fn a_response_without_a_content_length_still_downloads() {
    let data = payload(700_000);
    let expected = sha256(&data);
    let server = common::start_with(data.clone(), Mode::UnknownLength, None).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    assert_eq!(remote.size, None, "size is genuinely unknown");
    assert!(!remote.supports_range);

    let out = transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig::default(),
    )
    .await
    .unwrap();

    assert_eq!(out.total_bytes, data.len() as u64);
    assert_eq!(file_sha(&paths.final_path()), expected);
}

#[tokio::test]
async fn a_dropped_connection_is_retried_and_the_file_is_still_correct() {
    let data = payload(2 * 1024 * 1024);
    let expected = sha256(&data);
    let server = common::start(data.clone()).await;
    // Kill the first three responses partway through their body.
    server.state.drop_connection_after(64 * 1024, 3).await;

    let paths = Paths::new();
    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;

    let config = TransferConfig { connections: 4, max_retries: 20, ..Default::default() };
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .unwrap();

    assert_eq!(
        file_sha(&paths.final_path()),
        expected,
        "retry must resume from the cursor, not duplicate or skip bytes"
    );
}

#[tokio::test]
async fn pausing_writes_a_sidecar_and_resuming_finishes_the_file() {
    let data = payload(6 * 1024 * 1024);
    let expected = sha256(&data);
    let server = common::start(data.clone()).await;
    let paths = Paths::new();

    let control = Control::new();
    let progress: Arc<TransferProgress> = Default::default();
    // Throttle so there is a window in which to pause.
    let limiter = RateLimiter::new(3 * 1024 * 1024);
    let c = ctx(control.clone(), limiter, Arc::clone(&progress));
    let remote = probe_url(&c.client, &server.url("/file")).await;

    let config = TransferConfig { connections: 4, ..Default::default() };
    let (fp, pp, mp) = (paths.final_path(), paths.part_path(), paths.meta_path());
    let remote2 = remote.clone();
    let cfg2 = config.clone();

    let task = tokio::spawn(async move {
        transfer::run_transfer(&c, &remote2, &fp, &pp, &mp, &cfg2).await
    });

    // Wait until real progress exists, then pause.
    let moved = {
        let p = Arc::clone(&progress);
        wait_for(Duration::from_secs(15), move || {
            p.downloaded.load(Ordering::Relaxed) > 512 * 1024
        })
        .await
    };
    assert!(moved, "download never started");
    control.pause();

    let result = task.await.unwrap();
    assert!(
        matches!(result, Err(downpour_core::Error::Paused)),
        "expected Paused, got {result:?}"
    );

    assert!(paths.meta_path().exists(), "a pause must leave a resume sidecar");
    assert!(paths.part_path().exists(), "a pause must leave the part file");
    assert!(!paths.final_path().exists(), "nothing is renamed until it is complete");

    let partial = progress.downloaded.load(Ordering::Relaxed);
    assert!(partial > 0 && partial < data.len() as u64, "paused at {partial} bytes");

    // Resume with a fresh control and no throttle. The server's counters are
    // reset first so the assertion below measures only the resume.
    server.state.reset_counters();
    let progress2: Arc<TransferProgress> = Default::default();
    let c2 = ctx(Control::new(), RateLimiter::unlimited(), Arc::clone(&progress2));
    let remote_again = probe_url(&c2.client, &server.url("/file")).await;
    transfer::run_transfer(
        &c2,
        &remote_again,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .unwrap();

    assert_eq!(file_sha(&paths.final_path()), expected, "resume produced the wrong bytes");
    assert_eq!(
        progress2.downloaded.load(Ordering::Relaxed),
        data.len() as u64,
        "the progress counter is cumulative and must end at the full size"
    );
    // The real proof that the sidecar was used: the server sent less than the
    // whole file the second time round.
    let refetched = server.state.bytes_served();
    assert!(
        refetched < data.len(),
        "resume refetched {refetched} of {} bytes; the sidecar was ignored",
        data.len()
    );
    assert!(refetched > 0, "resume fetched nothing at all");
}

#[tokio::test]
async fn a_changed_etag_forces_a_clean_restart_instead_of_stitching() {
    // This is the corruption that is hardest to notice: both halves are valid
    // data, the length is exactly right, and the file is garbage.
    let original = payload(6 * 1024 * 1024);
    let server = common::start_with(original.clone(), Mode::Honest, Some("\"v1\"")).await;
    let paths = Paths::new();

    let control = Control::new();
    let progress: Arc<TransferProgress> = Default::default();
    let c = ctx(control.clone(), RateLimiter::new(3 * 1024 * 1024), Arc::clone(&progress));
    let remote = probe_url(&c.client, &server.url("/file")).await;
    let config = TransferConfig { connections: 4, ..Default::default() };

    let (fp, pp, mp) = (paths.final_path(), paths.part_path(), paths.meta_path());
    let remote2 = remote.clone();
    let cfg2 = config.clone();
    let task =
        tokio::spawn(async move { transfer::run_transfer(&c, &remote2, &fp, &pp, &mp, &cfg2).await });

    let moved = {
        let p = Arc::clone(&progress);
        wait_for(Duration::from_secs(15), move || {
            p.downloaded.load(Ordering::Relaxed) > 512 * 1024
        })
        .await
    };
    assert!(moved);
    control.pause();
    let _ = task.await.unwrap();
    assert!(paths.meta_path().exists());

    // The upstream file is replaced with entirely different content.
    let replacement = payload(6 * 1024 * 1024 + 7);
    let replacement_sha = sha256(&replacement);
    server.state.replace_data(replacement.clone(), Some("\"v2\"")).await;

    let c2 = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let fresh = probe_url(&c2.client, &server.url("/file")).await;
    transfer::run_transfer(
        &c2,
        &fresh,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .unwrap();

    assert_eq!(
        file_sha(&paths.final_path()),
        replacement_sha,
        "must be the new file in full, never a splice of both versions"
    );
}

#[tokio::test]
async fn a_checksum_mismatch_fails_before_the_rename() {
    let data = payload(256 * 1024);
    let server = common::start(data.clone()).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;

    let config = TransferConfig {
        checksum: Some(format!("sha256:{}", "0".repeat(64))),
        ..Default::default()
    };
    let err = transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .unwrap_err();

    assert!(matches!(err, downpour_core::Error::ChecksumMismatch { .. }), "got {err:?}");
    assert!(
        !paths.final_path().exists(),
        "a file that failed verification must never be renamed into place"
    );
}

#[tokio::test]
async fn a_matching_checksum_passes_verification() {
    let data = payload(256 * 1024);
    let server = common::start(data.clone()).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;

    let config = TransferConfig {
        checksum: Some(format!("sha256:{}", sha256(&data))),
        ..Default::default()
    };
    let out = transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .unwrap();

    assert_eq!(out.sha256.unwrap(), sha256(&data));
    assert!(paths.final_path().exists());
}

#[tokio::test]
async fn a_successful_download_leaves_no_part_or_sidecar_behind() {
    let data = payload(2 * 1024 * 1024);
    let server = common::start(data).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig::default(),
    )
    .await
    .unwrap();

    assert!(paths.final_path().exists());
    assert!(!paths.part_path().exists(), "the part file must be renamed, not copied");
    assert!(!paths.meta_path().exists(), "the sidecar must be cleaned up");
}

#[tokio::test]
async fn cancelling_stops_the_transfer_without_renaming() {
    let data = payload(8 * 1024 * 1024);
    let server = common::start(data).await;
    let paths = Paths::new();

    let control = Control::new();
    let progress: Arc<TransferProgress> = Default::default();
    let c = ctx(control.clone(), RateLimiter::new(2 * 1024 * 1024), Arc::clone(&progress));
    let remote = probe_url(&c.client, &server.url("/file")).await;

    let (fp, pp, mp) = (paths.final_path(), paths.part_path(), paths.meta_path());
    let remote2 = remote.clone();
    let task = tokio::spawn(async move {
        transfer::run_transfer(&c, &remote2, &fp, &pp, &mp, &TransferConfig::default()).await
    });

    let moved = {
        let p = Arc::clone(&progress);
        wait_for(Duration::from_secs(15), move || {
            p.downloaded.load(Ordering::Relaxed) > 256 * 1024
        })
        .await
    };
    assert!(moved);
    control.cancel();

    let result = task.await.unwrap();
    assert!(matches!(result, Err(downpour_core::Error::Cancelled)), "got {result:?}");
    assert!(!paths.final_path().exists());
}

#[tokio::test]
async fn a_server_error_is_reported_rather_than_producing_an_empty_file() {
    let server = common::start_with(payload(1000), Mode::ServerError, None).await;
    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let err = probe::probe(&c.client, &server.url("/file"), &BTreeMap::new())
        .await
        .unwrap_err();
    assert!(matches!(err, downpour_core::Error::BadStatus { status: 500, .. }), "got {err:?}");
}

#[tokio::test]
async fn a_speed_limit_actually_limits_throughput() {
    let data = payload(4 * 1024 * 1024);
    let server = common::start(data.clone()).await;
    let paths = Paths::new();

    // 2 MB/s against 4 MB should take roughly two seconds, minus the burst.
    let c = ctx(Control::new(), RateLimiter::new(2 * 1024 * 1024), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;

    let start = std::time::Instant::now();
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig { connections: 8, ..Default::default() },
    )
    .await
    .unwrap();
    let elapsed = start.elapsed();

    assert_eq!(file_sha(&paths.final_path()), sha256(&data));
    assert!(
        elapsed >= Duration::from_millis(900),
        "limit was ignored; finished in {elapsed:?}"
    );
}

#[tokio::test]
async fn a_tiny_file_downloads_correctly() {
    // One byte exercises every boundary in the segment planner at once.
    let data = vec![0x42u8];
    let server = common::start(data.clone()).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    assert_eq!(remote.size, Some(1));

    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig { connections: 16, ..Default::default() },
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(paths.final_path()).unwrap(), data);
}

#[tokio::test]
async fn an_empty_file_downloads_correctly() {
    let server = common::start(Vec::new()).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    assert_eq!(remote.size, Some(0));
    assert!(!remote.supports_range, "segmenting nothing is pointless");

    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig::default(),
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(paths.final_path()).unwrap().len(), 0);
}

#[tokio::test]
async fn a_corrupt_sidecar_causes_a_restart_rather_than_a_failure() {
    let data = payload(2 * 1024 * 1024);
    let expected = sha256(&data);
    let server = common::start(data).await;
    let paths = Paths::new();

    // A leftover sidecar with no part file, and unparseable anyway.
    std::fs::write(paths.meta_path(), b"{{{ truncated").unwrap();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig::default(),
    )
    .await
    .unwrap();

    assert_eq!(file_sha(&paths.final_path()), expected);
}
