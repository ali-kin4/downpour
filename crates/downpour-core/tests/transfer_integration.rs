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
use downpour_core::transfer::{self, Control, TransferConfig, TransferContext, TransferProgress};
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
        Self {
            dir: TempDir::new(),
        }
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

    let config = TransferConfig {
        connections: 8,
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

    assert_eq!(out.total_bytes, data.len() as u64);
    assert_eq!(
        file_sha(&paths.final_path()),
        expected,
        "content must match byte for byte"
    );
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

    let config = TransferConfig {
        connections: 16,
        ..Default::default()
    };
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

    let config = TransferConfig {
        connections: 8,
        ..Default::default()
    };
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
        "fell back cleanly, no corruption"
    );
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
    assert_eq!(
        remote.size,
        Some(data.len() as u64),
        "size still known from Content-Length"
    );

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

    let config = TransferConfig {
        connections: 4,
        max_retries: 20,
        ..Default::default()
    };
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

    let config = TransferConfig {
        connections: 4,
        ..Default::default()
    };
    let (fp, pp, mp) = (paths.final_path(), paths.part_path(), paths.meta_path());
    let remote2 = remote.clone();
    let cfg2 = config.clone();

    let task =
        tokio::spawn(
            async move { transfer::run_transfer(&c, &remote2, &fp, &pp, &mp, &cfg2).await },
        );

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

    assert!(
        paths.meta_path().exists(),
        "a pause must leave a resume sidecar"
    );
    assert!(
        paths.part_path().exists(),
        "a pause must leave the part file"
    );
    assert!(
        !paths.final_path().exists(),
        "nothing is renamed until it is complete"
    );

    let partial = progress.downloaded.load(Ordering::Relaxed);
    assert!(
        partial > 0 && partial < data.len() as u64,
        "paused at {partial} bytes"
    );

    // Resume with a fresh control and no throttle. The server's counters are
    // reset first so the assertion below measures only the resume.
    server.state.reset_counters();
    let progress2: Arc<TransferProgress> = Default::default();
    let c2 = ctx(
        Control::new(),
        RateLimiter::unlimited(),
        Arc::clone(&progress2),
    );
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

    assert_eq!(
        file_sha(&paths.final_path()),
        expected,
        "resume produced the wrong bytes"
    );
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
    let c = ctx(
        control.clone(),
        RateLimiter::new(3 * 1024 * 1024),
        Arc::clone(&progress),
    );
    let remote = probe_url(&c.client, &server.url("/file")).await;
    let config = TransferConfig {
        connections: 4,
        ..Default::default()
    };

    let (fp, pp, mp) = (paths.final_path(), paths.part_path(), paths.meta_path());
    let remote2 = remote.clone();
    let cfg2 = config.clone();
    let task =
        tokio::spawn(
            async move { transfer::run_transfer(&c, &remote2, &fp, &pp, &mp, &cfg2).await },
        );

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
    server
        .state
        .replace_data(replacement.clone(), Some("\"v2\""))
        .await;

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

    assert!(
        matches!(err, downpour_core::Error::ChecksumMismatch { .. }),
        "got {err:?}"
    );
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
    assert!(
        !paths.part_path().exists(),
        "the part file must be renamed, not copied"
    );
    assert!(
        !paths.meta_path().exists(),
        "the sidecar must be cleaned up"
    );
}

#[tokio::test]
async fn cancelling_stops_the_transfer_without_renaming() {
    let data = payload(8 * 1024 * 1024);
    let server = common::start(data).await;
    let paths = Paths::new();

    let control = Control::new();
    let progress: Arc<TransferProgress> = Default::default();
    let c = ctx(
        control.clone(),
        RateLimiter::new(2 * 1024 * 1024),
        Arc::clone(&progress),
    );
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
    assert!(
        matches!(result, Err(downpour_core::Error::Cancelled)),
        "got {result:?}"
    );
    assert!(!paths.final_path().exists());
}

#[tokio::test]
async fn a_server_error_is_reported_rather_than_producing_an_empty_file() {
    let server = common::start_with(payload(1000), Mode::ServerError, None).await;
    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let err = probe::probe(&c.client, &server.url("/file"), &BTreeMap::new())
        .await
        .unwrap_err();
    assert!(
        matches!(err, downpour_core::Error::BadStatus { status: 500, .. }),
        "got {err:?}"
    );
}

#[tokio::test]
async fn a_speed_limit_actually_limits_throughput() {
    let data = payload(4 * 1024 * 1024);
    let server = common::start(data.clone()).await;
    let paths = Paths::new();

    // 2 MB/s against 4 MB should take roughly two seconds, minus the burst.
    let c = ctx(
        Control::new(),
        RateLimiter::new(2 * 1024 * 1024),
        Default::default(),
    );
    let remote = probe_url(&c.client, &server.url("/file")).await;

    let start = std::time::Instant::now();
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig {
            connections: 8,
            ..Default::default()
        },
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
        &TransferConfig {
            connections: 16,
            ..Default::default()
        },
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

// ---------------------------------------------------------------------------
// Resource identity: a resume, or a retry, must never splice two versions
// ---------------------------------------------------------------------------

/// Starts a throttled download, pauses it partway, and returns the config it
/// ran with. Leaves a part file and a sidecar behind, as a real pause does.
async fn download_then_pause(server: &common::TestServer, paths: &Paths) -> TransferConfig {
    let control = Control::new();
    let progress: Arc<TransferProgress> = Default::default();
    let c = ctx(
        control.clone(),
        RateLimiter::new(3 * 1024 * 1024),
        Arc::clone(&progress),
    );
    let remote = probe_url(&c.client, &server.url("/file")).await;
    let config = TransferConfig {
        connections: 4,
        ..Default::default()
    };
    let (fp, pp, mp) = (paths.final_path(), paths.part_path(), paths.meta_path());
    let cfg = config.clone();
    let task =
        tokio::spawn(async move { transfer::run_transfer(&c, &remote, &fp, &pp, &mp, &cfg).await });
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
        "{result:?}"
    );
    assert!(paths.meta_path().exists(), "a pause must leave a sidecar");
    config
}

/// Different bytes, identical length: the replacement a size check cannot see.
fn same_length_replacement(original: &[u8]) -> Vec<u8> {
    original.iter().map(|b| b ^ 0x5A).collect()
}

async fn resume(server: &common::TestServer, paths: &Paths, config: &TransferConfig) {
    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let fresh = probe_url(&c.client, &server.url("/file")).await;
    transfer::run_transfer(
        &c,
        &fresh,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        config,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_validator_that_disappears_is_not_taken_as_proof_nothing_changed() {
    // The file had an ETag when the download started, has none now, and is
    // the same length. Nothing on the wire proves it is the same file, so the
    // bytes already on disk must not be kept.
    let original = payload(6 * 1024 * 1024);
    let server = common::start(original.clone()).await;
    server
        .state
        .replace_all(original.clone(), Some("\"v1\""), None)
        .await;
    let paths = Paths::new();
    let config = download_then_pause(&server, &paths).await;

    let replacement = same_length_replacement(&original);
    server
        .state
        .replace_all(replacement.clone(), None, None)
        .await;
    resume(&server, &paths, &config).await;

    assert_eq!(
        file_sha(&paths.final_path()),
        sha256(&replacement),
        "the old bytes were kept although the server could no longer vouch for them"
    );
}

#[tokio::test]
async fn a_server_with_no_validators_restarts_rather_than_resumes() {
    // With neither an ETag nor a Last-Modified there is no way to tell this
    // file from a same-sized replacement, so a resume would be a guess.
    let original = payload(6 * 1024 * 1024);
    let server = common::start_with(original.clone(), Mode::Honest, None).await;
    server.state.replace_all(original.clone(), None, None).await;
    let paths = Paths::new();
    let config = download_then_pause(&server, &paths).await;

    let replacement = same_length_replacement(&original);
    server
        .state
        .replace_all(replacement.clone(), None, None)
        .await;
    resume(&server, &paths, &config).await;

    assert_eq!(
        file_sha(&paths.final_path()),
        sha256(&replacement),
        "bytes from two versions of the file were stitched together"
    );
}

#[tokio::test]
async fn a_matching_last_modified_alone_still_allows_a_resume() {
    // The other half of the policy: a server that sends only Last-Modified can
    // still prove identity, and must not lose its resume to the stricter rule.
    let data = payload(6 * 1024 * 1024);
    let server = common::start_with(data.clone(), Mode::Honest, None).await;
    let paths = Paths::new();
    let config = download_then_pause(&server, &paths).await;

    server.state.reset_counters();
    resume(&server, &paths, &config).await;

    assert_eq!(file_sha(&paths.final_path()), sha256(&data));
    assert!(
        server.state.bytes_served() < data.len(),
        "the resume refetched the whole file"
    );
    assert!(
        server.state.if_range_count() > 0,
        "resumed ranges must be conditional on the Last-Modified they continue"
    );
}

/// Every first-round segment request is cut short, and the file changes before
/// the retries go out. Request 1 is the probe; 2 to 5 are the four segments.
async fn change_during_transfer(server: &common::TestServer, replacement: &[u8]) {
    server.state.drop_connection_after(64 * 1024, 4).await;
    server
        .state
        .change_at_request(
            6,
            common::Change {
                data: replacement.to_vec(),
                etag: Some("\"v2\"".into()),
                last_modified: Some("Thu, 22 Oct 2026 07:28:00 GMT".into()),
            },
        )
        .await;
}

async fn run_once(server: &common::TestServer, paths: &Paths) -> downpour_core::Result<()> {
    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    let config = TransferConfig {
        connections: 4,
        ..Default::default()
    };
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &config,
    )
    .await
    .map(|_| ())
}

#[tokio::test]
async fn a_file_that_changes_mid_transfer_is_reported_not_spliced() {
    // The retries after the dropped connections would fetch the new version's
    // bytes into the old version's file. If-Range makes the server say so.
    let original = payload(6 * 1024 * 1024);
    let server = common::start(original.clone()).await;
    let replacement = same_length_replacement(&original);
    change_during_transfer(&server, &replacement).await;
    let paths = Paths::new();

    let result = run_once(&server, &paths).await;

    assert!(
        matches!(result, Err(downpour_core::Error::RemoteChanged { .. })),
        "expected RemoteChanged, got {result:?}"
    );
    assert!(
        !paths.final_path().exists(),
        "a spliced file was put in place as finished"
    );
    assert!(
        !paths.meta_path().exists(),
        "the sidecar still vouches for bytes from a version that no longer exists"
    );
}

#[tokio::test]
async fn a_server_that_ignores_if_range_is_caught_by_the_response_validators() {
    // The server serves a 206 of the new version regardless. Its own ETag on
    // that response is the remaining evidence, and it must be read.
    let original = payload(6 * 1024 * 1024);
    let server = common::start(original.clone()).await;
    server.state.honour_if_range(false);
    let replacement = same_length_replacement(&original);
    change_during_transfer(&server, &replacement).await;
    let paths = Paths::new();

    let result = run_once(&server, &paths).await;

    assert!(
        matches!(result, Err(downpour_core::Error::RemoteChanged { .. })),
        "expected RemoteChanged, got {result:?}"
    );
    assert!(!paths.final_path().exists());
}

// ---------------------------------------------------------------------------
// Credentials stay with the origin they were captured for
// ---------------------------------------------------------------------------

/// The headers a browser hand-off carries for a signed-in session.
fn session_headers() -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    h.insert("Cookie".to_string(), "session=secret".to_string());
    h.insert("Authorization".to_string(), "Bearer secret".to_string());
    h.insert("Referer".to_string(), "https://example.com/".to_string());
    h
}

async fn download_with_session(entry: &str, paths: &Paths) {
    let mut c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    c.headers = session_headers();
    let remote = probe::probe(&c.client, entry, &c.headers).await.unwrap();
    transfer::run_transfer(
        &c,
        &remote,
        &paths.final_path(),
        &paths.part_path(),
        &paths.meta_path(),
        &TransferConfig {
            connections: 4,
            ..Default::default()
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn session_credentials_are_not_sent_to_the_host_a_link_redirects_to() {
    // A site's download link that hands off to a CDN on another host. The
    // cookies were captured for the site; the CDN must never see them, on the
    // probe or on any of the segment requests that follow it.
    let data = payload(4 * 1024 * 1024);
    let cdn = common::start(data.clone()).await;
    let site = common::start(Vec::new()).await;
    site.state.redirect_to(&cdn.url("/file")).await;
    let paths = Paths::new();

    download_with_session(&site.url("/redirect"), &paths).await;

    assert_eq!(file_sha(&paths.final_path()), sha256(&data));
    assert!(
        cdn.state.ranged_count() > 1,
        "expected a segmented download"
    );
    assert_eq!(
        cdn.state.credentialed_count(),
        0,
        "the site's Cookie/Authorization reached the host it redirected to"
    );
}

#[tokio::test]
async fn a_single_stream_download_also_keeps_credentials_at_home() {
    let data = payload(256 * 1024);
    let cdn = common::start_with(data.clone(), Mode::NoRanges, None).await;
    let site = common::start(Vec::new()).await;
    site.state.redirect_to(&cdn.url("/file")).await;
    let paths = Paths::new();

    download_with_session(&site.url("/redirect"), &paths).await;

    assert_eq!(file_sha(&paths.final_path()), sha256(&data));
    assert_eq!(cdn.state.credentialed_count(), 0);
}

#[tokio::test]
async fn a_redirect_within_the_same_origin_keeps_the_session() {
    // The other side of the rule: a signed-in download that redirects within
    // its own site needs its cookies on every request, or it comes back as a
    // login page.
    let data = payload(4 * 1024 * 1024);
    let site = common::start(data.clone()).await;
    site.state.redirect_to(&site.url("/file")).await;
    let paths = Paths::new();

    download_with_session(&site.url("/redirect"), &paths).await;

    assert_eq!(file_sha(&paths.final_path()), sha256(&data));
    assert_eq!(
        site.state.credentialed_count(),
        site.state.request_count(),
        "a same-origin request went out without the session"
    );
}

// ---------------------------------------------------------------------------
// Waiting to retry is still listening for the user
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_pause_lands_promptly_while_the_server_asks_us_to_wait() {
    // A 429 with Retry-After: 30 parks every worker for thirty seconds. The
    // user pressing pause in that time must not have to wait them out.
    let data = payload(4 * 1024 * 1024);
    let server = common::start(data).await;
    let paths = Paths::new();

    let control = Control::new();
    let c = ctx(
        control.clone(),
        RateLimiter::unlimited(),
        Default::default(),
    );
    let remote = probe_url(&c.client, &server.url("/file")).await;
    server.state.rate_limit(usize::MAX, 30);

    let (fp, pp, mp) = (paths.final_path(), paths.part_path(), paths.meta_path());
    let task = tokio::spawn(async move {
        let config = TransferConfig {
            connections: 2,
            ..Default::default()
        };
        transfer::run_transfer(&c, &remote, &fp, &pp, &mp, &config).await
    });

    let waiting = {
        let s = std::sync::Arc::clone(&server.state);
        wait_for(Duration::from_secs(10), move || s.rate_limited_count() >= 2).await
    };
    assert!(waiting, "the workers never reached their Retry-After wait");

    let asked = std::time::Instant::now();
    control.pause();
    // Thirty seconds is what the bug costs; five leaves a loaded CI runner
    // all the room it needs without coming near it.
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("pause waited out the server's Retry-After")
        .unwrap();
    assert!(
        matches!(result, Err(downpour_core::Error::Paused)),
        "expected Paused, got {result:?}"
    );
    assert!(asked.elapsed() < Duration::from_secs(5));
}

// ---------------------------------------------------------------------------
// A 416 to the probe is not proof of an empty file
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_server_that_rejects_ranges_with_416_still_downloads_the_file() {
    // `Content-Range: bytes */N` says the file is N bytes long; it is only the
    // range the server refused. Taking every 416 to mean "empty" recorded a
    // size of zero, and the download then failed its own length check.
    let data = payload(300 * 1024);
    let server = common::start_with(data.clone(), Mode::RejectsRanges, Some("\"v1\"")).await;
    let paths = Paths::new();

    let c = ctx(Control::new(), RateLimiter::unlimited(), Default::default());
    let remote = probe_url(&c.client, &server.url("/file")).await;
    assert_eq!(remote.size, Some(data.len() as u64), "{remote:?}");
    assert!(!remote.supports_range);

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
    assert_eq!(file_sha(&paths.final_path()), sha256(&data));
}
