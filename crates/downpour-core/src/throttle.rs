//! Bandwidth limiting, as a shared token bucket.
//!
//! The limiter is deliberately global rather than per-connection: a user who
//! sets "2 MB/s" means the app as a whole should not exceed 2 MB/s, not that
//! each of sixteen connections may take 2 MB/s. Workers acquire tokens before
//! consuming a chunk they have already received, which shapes the read rate and
//! lets TCP flow control do the actual throttling upstream.

use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Burst allowance, expressed as seconds of the configured rate. A little burst
/// keeps small chunk reads from being paced into stuttering.
const BURST_SECONDS: f64 = 0.5;

/// Never let the bucket hold less than this, or a single large chunk could
/// exceed the capacity and deadlock waiting for tokens that never accumulate.
const MIN_CAPACITY: f64 = 512.0 * 1024.0;

#[derive(Debug)]
struct Bucket {
    /// Bytes per second. Zero means unlimited.
    rate: u64,
    tokens: f64,
    capacity: f64,
    last_refill: Instant,
}

impl Bucket {
    fn refill(&mut self, now: Instant) {
        if self.rate == 0 {
            return;
        }
        let elapsed = now.saturating_duration_since(self.last_refill).as_secs_f64();
        if elapsed > 0.0 {
            self.tokens = (self.tokens + elapsed * self.rate as f64).min(self.capacity);
            self.last_refill = now;
        }
    }
}

/// A cloneable handle onto one shared bucket.
#[derive(Debug, Clone)]
pub struct RateLimiter {
    inner: Arc<Mutex<Bucket>>,
}

impl RateLimiter {
    /// `bytes_per_second == 0` disables limiting entirely, and `acquire`
    /// becomes a no-op with no locking cost worth worrying about.
    pub fn new(bytes_per_second: u64) -> Self {
        let capacity = ((bytes_per_second as f64) * BURST_SECONDS).max(MIN_CAPACITY);
        Self {
            inner: Arc::new(Mutex::new(Bucket {
                rate: bytes_per_second,
                tokens: capacity,
                capacity,
                last_refill: Instant::now(),
            })),
        }
    }

    pub fn unlimited() -> Self {
        Self::new(0)
    }

    pub fn is_limited(&self) -> bool {
        self.inner.lock().rate > 0
    }

    pub fn rate(&self) -> u64 {
        self.inner.lock().rate
    }

    /// Changes the limit live, without dropping in-flight downloads.
    pub fn set_rate(&self, bytes_per_second: u64) {
        let mut b = self.inner.lock();
        let now = Instant::now();
        b.refill(now);
        b.rate = bytes_per_second;
        b.capacity = ((bytes_per_second as f64) * BURST_SECONDS).max(MIN_CAPACITY);
        b.tokens = b.tokens.min(b.capacity);
        b.last_refill = now;
    }

    /// Computes how long the caller must wait for `n` tokens, consuming them if
    /// they are already available. Split out from `acquire` so the wait happens
    /// with the lock released, and so it is testable without sleeping.
    fn try_take(&self, n: u64) -> Option<Duration> {
        let mut b = self.inner.lock();
        if b.rate == 0 {
            return None;
        }
        let now = Instant::now();
        b.refill(now);

        // Clamp the request to the capacity: a chunk larger than the bucket can
        // ever hold must still eventually pass, or the transfer stalls forever.
        let want = (n as f64).min(b.capacity);
        if b.tokens >= want {
            b.tokens -= want;
            return None;
        }
        let deficit = want - b.tokens;
        Some(Duration::from_secs_f64(deficit / b.rate as f64))
    }

    /// Blocks until `n` bytes worth of allowance is available.
    pub async fn acquire(&self, n: u64) {
        loop {
            match self.try_take(n) {
                None => return,
                Some(wait) => {
                    // Cap a single sleep so a live rate change is picked up
                    // promptly rather than after a multi-second nap.
                    tokio::time::sleep(wait.min(Duration::from_millis(250))).await;
                }
            }
        }
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::unlimited()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlimited_never_waits() {
        let rl = RateLimiter::unlimited();
        assert!(!rl.is_limited());
        assert_eq!(rl.try_take(u64::MAX), None);
    }

    #[test]
    fn limited_consumes_from_the_burst_first() {
        let rl = RateLimiter::new(1_000_000);
        assert!(rl.is_limited());
        // Capacity is max(0.5s * rate, 512 KiB) = 512 KiB here.
        assert_eq!(rl.try_take(1024), None, "burst covers a small chunk");
    }

    #[test]
    fn limited_reports_a_wait_once_the_burst_is_spent() {
        let rl = RateLimiter::new(100_000);
        let capacity = MIN_CAPACITY as u64;
        assert_eq!(rl.try_take(capacity), None, "drains the bucket");
        let wait = rl.try_take(50_000).expect("must wait");
        assert!(wait > Duration::ZERO);
        assert!(wait < Duration::from_secs(2), "wait was {wait:?}");
    }

    #[test]
    fn a_chunk_larger_than_capacity_still_passes() {
        // Without the clamp this deadlocks: the bucket can never hold enough.
        let rl = RateLimiter::new(1000);
        let huge = 100 * 1024 * 1024;
        assert_eq!(rl.try_take(huge), None, "first call uses the full burst");
        let wait = rl.try_take(huge).expect("second call waits");
        // Waits for one capacity's worth, not for 100 MiB worth.
        assert!(wait <= Duration::from_secs_f64(MIN_CAPACITY / 1000.0 + 1.0), "{wait:?}");
    }

    #[test]
    fn set_rate_takes_effect_immediately() {
        let rl = RateLimiter::new(0);
        assert!(!rl.is_limited());
        rl.set_rate(500_000);
        assert!(rl.is_limited());
        assert_eq!(rl.rate(), 500_000);
        rl.set_rate(0);
        assert!(!rl.is_limited());
        assert_eq!(rl.try_take(u64::MAX), None);
    }

    #[tokio::test]
    async fn acquire_paces_throughput_to_roughly_the_configured_rate() {
        // 1 MiB/s, spend 1 MiB beyond the burst and expect it to take time.
        let rate = 1024 * 1024;
        let rl = RateLimiter::new(rate);
        // Drain the burst without timing it.
        rl.acquire(MIN_CAPACITY as u64).await;

        let start = Instant::now();
        let chunks = 16;
        let per = rate / chunks;
        for _ in 0..chunks {
            rl.acquire(per).await;
        }
        let elapsed = start.elapsed();
        // One full second of allowance was consumed. Allow generous slack for
        // scheduler jitter but assert it was genuinely paced, not instant.
        assert!(elapsed >= Duration::from_millis(600), "too fast: {elapsed:?}");
        assert!(elapsed < Duration::from_secs(4), "too slow: {elapsed:?}");
    }

    #[tokio::test]
    async fn refill_accumulates_over_time() {
        let rl = RateLimiter::new(1_000_000);
        rl.try_take(MIN_CAPACITY as u64);
        assert!(rl.try_take(200_000).is_some(), "bucket is empty");
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(rl.try_take(200_000), None, "refilled while we waited");
    }
}
