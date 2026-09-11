//! The resume sidecar.
//!
//! Every in-flight download owns two files: `name.dpart` holds the bytes, and
//! `name.dpmeta` holds the per-segment cursors plus the validators that prove
//! the bytes still belong to the same remote file. Without the validators a
//! resume can silently stitch together halves of two different versions of a
//! file and hand you a corrupt result that is exactly the right length.

use crate::error::{Error, Result};
use crate::model::{RemoteInfo, Segment};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Bumped whenever the on-disk shape changes incompatibly. An older or newer
/// sidecar is discarded rather than misread.
pub const SIDECAR_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sidecar {
    pub version: u32,
    /// The URL the user asked for, kept so a resume can re-resolve redirects.
    pub url: String,
    pub remote: RemoteInfo,
    pub segments: Vec<Segment>,
    pub total_bytes: u64,
    /// Unix seconds, for stale-sidecar cleanup.
    pub updated_at: i64,
}

impl Sidecar {
    pub fn new(url: String, remote: RemoteInfo, segments: Vec<Segment>, total_bytes: u64) -> Self {
        Self {
            version: SIDECAR_VERSION,
            url,
            remote,
            segments,
            total_bytes,
            updated_at: now_unix(),
        }
    }

    pub fn downloaded_bytes(&self) -> u64 {
        self.segments.iter().map(|s| s.downloaded()).sum()
    }

    /// Whether every segment has been fully written.
    pub fn is_complete(&self) -> bool {
        self.segments.iter().all(|s| s.is_complete())
    }

    /// Reads and validates a sidecar. Any inconsistency returns
    /// `CorruptMetadata` so the caller restarts cleanly instead of trusting it.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read(path).map_err(|source| Error::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let sc: Sidecar = serde_json::from_slice(&raw)
            .map_err(|e| Error::CorruptMetadata(format!("{}: {e}", path.display())))?;

        if sc.version != SIDECAR_VERSION {
            return Err(Error::CorruptMetadata(format!(
                "sidecar version {}, expected {SIDECAR_VERSION}",
                sc.version
            )));
        }
        sc.validate()?;
        Ok(sc)
    }

    /// Structural checks that catch a truncated or hand-edited sidecar before
    /// it can misdirect a single byte.
    pub fn validate(&self) -> Result<()> {
        if self.segments.is_empty() {
            return Err(Error::CorruptMetadata("no segments".into()));
        }
        let mut sorted: Vec<&Segment> = self.segments.iter().collect();
        sorted.sort_by_key(|s| s.start);

        let mut expected_start = 0u64;
        for s in &sorted {
            if s.end < s.start {
                return Err(Error::CorruptMetadata(format!(
                    "segment {}..{} ends before it starts",
                    s.start, s.end
                )));
            }
            if s.cursor < s.start || s.cursor > s.end + 1 {
                return Err(Error::CorruptMetadata(format!(
                    "cursor {} outside segment {}..{}",
                    s.cursor, s.start, s.end
                )));
            }
            if s.start != expected_start {
                return Err(Error::CorruptMetadata(format!(
                    "segment gap or overlap at byte {expected_start} (next segment starts at {})",
                    s.start
                )));
            }
            expected_start = s.end + 1;
        }
        if expected_start != self.total_bytes {
            return Err(Error::CorruptMetadata(format!(
                "segments cover {expected_start} bytes but the file is {}",
                self.total_bytes
            )));
        }
        Ok(())
    }

    /// Writes atomically: a crash mid-save leaves either the old sidecar or the
    /// new one, never a half-written file that fails to parse and throws away
    /// a nearly finished download.
    pub fn save(&self, path: &Path) -> Result<()> {
        let tmp = tmp_path(path);
        let bytes = serde_json::to_vec_pretty(self)?;
        std::fs::write(&tmp, &bytes).map_err(|source| Error::Io {
            path: tmp.clone(),
            source,
        })?;
        std::fs::rename(&tmp, path).map_err(|source| Error::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(())
    }

    /// Confirms the remote file has not changed under us. On mismatch the
    /// caller must restart from zero: stitching is not recoverable.
    pub fn check_still_valid(&self, fresh: &RemoteInfo) -> Result<()> {
        fresh
            .matches(&self.remote)
            .map_err(|reason| Error::RemoteChanged { reason })
    }
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".tmp");
    PathBuf::from(s)
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Splits `total` bytes into `count` contiguous segments.
///
/// The remainder is spread one byte at a time across the leading segments
/// rather than dumped on the last one, so no single connection is left with a
/// materially larger share to finish alone.
pub fn plan_segments(total: u64, count: u8) -> Vec<Segment> {
    let count = count.max(1) as u64;
    if total == 0 {
        return vec![Segment::new(0, 0)];
    }
    let count = count.min(total);
    let base = total / count;
    let extra = total % count;

    let mut segments = Vec::with_capacity(count as usize);
    let mut start = 0u64;
    for i in 0..count {
        let len = base + if i < extra { 1 } else { 0 };
        segments.push(Segment::new(start, start + len - 1));
        start += len;
    }
    segments
}

/// Chooses a connection count for a file of this size.
///
/// Splitting a 200 KB file eight ways costs more in round trips than it saves,
/// and most servers rate-limit per connection anyway, so the count ramps with
/// size and stops at the user's configured maximum.
pub fn connections_for_size(total: u64, max: u8) -> u8 {
    const MIB: u64 = 1024 * 1024;
    let by_size = match total {
        0..=1_048_575 => 1, // < 1 MiB
        v if v < 8 * MIB => 2,
        v if v < 64 * MIB => 4,
        v if v < 512 * MIB => 8,
        _ => 16,
    };
    by_size.min(max.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> RemoteInfo {
        RemoteInfo {
            final_url: "https://example.com/f.bin".into(),
            size: Some(1000),
            supports_range: true,
            etag: Some("\"abc\"".into()),
            last_modified: None,
            content_type: None,
            suggested_filename: None,
        }
    }

    #[test]
    fn plan_segments_covers_every_byte_exactly_once() {
        for total in [1u64, 2, 3, 999, 1000, 1_048_576, 123_456_789] {
            for count in [1u8, 2, 3, 4, 7, 8, 16] {
                let segs = plan_segments(total, count);
                let mut expected = 0u64;
                for s in &segs {
                    assert_eq!(
                        s.start, expected,
                        "gap at {expected} (total={total}, n={count})"
                    );
                    assert!(s.end >= s.start);
                    expected = s.end + 1;
                }
                assert_eq!(expected, total, "coverage (total={total}, n={count})");
                let sum: u64 = segs.iter().map(|s| s.end - s.start + 1).sum();
                assert_eq!(sum, total);
            }
        }
    }

    #[test]
    fn plan_segments_never_exceeds_byte_count() {
        // Asking for 16 connections on a 3-byte file must not create empty
        // segments, which would make `end < start` and fail validation.
        let segs = plan_segments(3, 16);
        assert_eq!(segs.len(), 3);
    }

    #[test]
    fn plan_segments_spreads_the_remainder() {
        let segs = plan_segments(10, 4); // 3,3,2,2
        let lens: Vec<u64> = segs.iter().map(|s| s.end - s.start + 1).collect();
        assert_eq!(lens, vec![3, 3, 2, 2]);
    }

    #[test]
    fn plan_segments_handles_empty_file() {
        let segs = plan_segments(0, 8);
        assert_eq!(segs.len(), 1);
    }

    #[test]
    fn connections_scale_with_size_and_respect_the_cap() {
        assert_eq!(connections_for_size(500_000, 16), 1);
        assert_eq!(connections_for_size(4 * 1024 * 1024, 16), 2);
        assert_eq!(connections_for_size(32 * 1024 * 1024, 16), 4);
        assert_eq!(connections_for_size(1024 * 1024 * 1024, 16), 16);
        assert_eq!(
            connections_for_size(1024 * 1024 * 1024, 4),
            4,
            "user cap wins"
        );
        assert_eq!(connections_for_size(1024 * 1024 * 1024, 0), 1, "never zero");
    }

    #[test]
    fn sidecar_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("dp-sc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.dpmeta");

        let sc = Sidecar::new(
            "https://example.com/f.bin".into(),
            info(),
            plan_segments(1000, 4),
            1000,
        );
        sc.save(&path).unwrap();
        let loaded = Sidecar::load(&path).unwrap();
        assert_eq!(loaded.segments, sc.segments);
        assert_eq!(loaded.total_bytes, 1000);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_rejects_a_gap_between_segments() {
        let sc = Sidecar::new(
            "u".into(),
            info(),
            vec![Segment::new(0, 99), Segment::new(200, 999)],
            1000,
        );
        assert!(matches!(sc.validate(), Err(Error::CorruptMetadata(_))));
    }

    #[test]
    fn validate_rejects_overlapping_segments() {
        let sc = Sidecar::new(
            "u".into(),
            info(),
            vec![Segment::new(0, 499), Segment::new(400, 999)],
            1000,
        );
        assert!(matches!(sc.validate(), Err(Error::CorruptMetadata(_))));
    }

    #[test]
    fn validate_rejects_short_coverage() {
        let sc = Sidecar::new("u".into(), info(), vec![Segment::new(0, 499)], 1000);
        assert!(matches!(sc.validate(), Err(Error::CorruptMetadata(_))));
    }

    #[test]
    fn validate_rejects_out_of_range_cursor() {
        let mut sc = Sidecar::new("u".into(), info(), plan_segments(1000, 2), 1000);
        sc.segments[0].cursor = 9_999;
        assert!(matches!(sc.validate(), Err(Error::CorruptMetadata(_))));
    }

    #[test]
    fn validate_accepts_a_fully_complete_plan() {
        let mut sc = Sidecar::new("u".into(), info(), plan_segments(1000, 4), 1000);
        for s in &mut sc.segments {
            s.cursor = s.end + 1;
        }
        sc.validate().unwrap();
        assert!(sc.is_complete());
        assert_eq!(sc.downloaded_bytes(), 1000);
    }

    #[test]
    fn etag_change_is_refused() {
        let sc = Sidecar::new("u".into(), info(), plan_segments(1000, 2), 1000);
        let mut fresh = info();
        fresh.etag = Some("\"different\"".into());
        let err = sc.check_still_valid(&fresh).unwrap_err();
        assert!(matches!(err, Error::RemoteChanged { .. }), "got {err:?}");
    }

    #[test]
    fn identical_etag_is_accepted() {
        let sc = Sidecar::new("u".into(), info(), plan_segments(1000, 2), 1000);
        sc.check_still_valid(&info()).unwrap();
    }

    #[test]
    fn weak_etag_falls_through_to_last_modified() {
        let mut prior = info();
        prior.etag = Some("W/\"abc\"".into());
        prior.last_modified = Some("Wed, 21 Oct 2026 07:28:00 GMT".into());
        let sc = Sidecar::new("u".into(), prior, plan_segments(1000, 2), 1000);

        let mut fresh = info();
        fresh.etag = Some("W/\"xyz\"".into());
        fresh.last_modified = Some("Thu, 22 Oct 2026 07:28:00 GMT".into());
        assert!(
            sc.check_still_valid(&fresh).is_err(),
            "changed Last-Modified must be refused"
        );
    }

    #[test]
    fn size_change_is_refused_when_no_validators_exist() {
        let mut prior = info();
        prior.etag = None;
        let sc = Sidecar::new("u".into(), prior, plan_segments(1000, 2), 1000);
        let mut fresh = info();
        fresh.etag = None;
        fresh.size = Some(2000);
        assert!(sc.check_still_valid(&fresh).is_err());
    }

    #[test]
    fn missing_validators_on_both_sides_allow_resume() {
        // Refusing here would make resume useless against the bare servers that
        // need it most, so this is a deliberate accept.
        let bare = RemoteInfo {
            final_url: "u".into(),
            size: None,
            supports_range: true,
            ..Default::default()
        };
        let sc = Sidecar::new("u".into(), bare.clone(), plan_segments(1000, 2), 1000);
        sc.check_still_valid(&bare).unwrap();
    }

    #[test]
    fn corrupt_json_is_reported_not_panicked() {
        let dir = std::env::temp_dir().join(format!("dp-sc2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.dpmeta");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(matches!(
            Sidecar::load(&path),
            Err(Error::CorruptMetadata(_))
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrong_version_is_rejected() {
        let dir = std::env::temp_dir().join(format!("dp-sc3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.dpmeta");
        let mut sc = Sidecar::new("u".into(), info(), plan_segments(1000, 2), 1000);
        sc.version = 999;
        std::fs::write(&path, serde_json::to_vec(&sc).unwrap()).unwrap();
        assert!(matches!(
            Sidecar::load(&path),
            Err(Error::CorruptMetadata(_))
        ));
        std::fs::remove_dir_all(&dir).ok();
    }
}
