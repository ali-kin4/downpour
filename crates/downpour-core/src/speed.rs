//! Speed and ETA estimation.
//!
//! A raw "bytes since last tick" figure jitters wildly and makes the UI look
//! broken, so the reported speed is an exponential moving average. The
//! smoothing factor is derived from the elapsed time rather than fixed per
//! tick, which keeps the average honest when a tick is late.

use std::time::Instant;

/// Time constant of the average. Larger is smoother but slower to react; ~3s
/// tracks a genuine slowdown quickly while ignoring per-chunk noise.
const TAU: f64 = 3.0;

#[derive(Debug, Clone)]
pub struct SpeedTracker {
    last_bytes: u64,
    last_at: Instant,
    ema: f64,
    /// Total bytes and time while actually running, for the average speed.
    session_bytes: u64,
    session_secs: f64,
    started: bool,
}

impl SpeedTracker {
    pub fn new(initial_bytes: u64) -> Self {
        Self {
            last_bytes: initial_bytes,
            last_at: Instant::now(),
            ema: 0.0,
            session_bytes: 0,
            session_secs: 0.0,
            started: false,
        }
    }

    /// Feeds a fresh cumulative byte count and returns the smoothed rate.
    pub fn sample(&mut self, total_bytes: u64) -> u64 {
        self.sample_at(total_bytes, Instant::now())
    }

    /// Injectable-clock variant, so the behaviour is testable without sleeping.
    pub fn sample_at(&mut self, total_bytes: u64, now: Instant) -> u64 {
        let dt = now.saturating_duration_since(self.last_at).as_secs_f64();
        if dt <= 0.0 {
            return self.ema.max(0.0) as u64;
        }
        // A counter that went backwards means the download restarted; treat it
        // as a fresh start rather than reporting a negative rate.
        let delta = total_bytes.saturating_sub(self.last_bytes);
        if total_bytes < self.last_bytes {
            self.last_bytes = total_bytes;
            self.last_at = now;
            self.ema = 0.0;
            return 0;
        }

        let instant_rate = delta as f64 / dt;
        let alpha = 1.0 - (-dt / TAU).exp();
        if !self.started {
            // Seed with the first real observation instead of ramping up from
            // zero, which would understate the speed for the first few seconds.
            self.ema = instant_rate;
            self.started = true;
        } else {
            self.ema += alpha * (instant_rate - self.ema);
        }

        self.session_bytes += delta;
        self.session_secs += dt;
        self.last_bytes = total_bytes;
        self.last_at = now;
        self.ema.max(0.0) as u64
    }

    pub fn speed_bps(&self) -> u64 {
        self.ema.max(0.0) as u64
    }

    /// Mean rate over the whole session, which is the number worth reporting
    /// when a download finishes.
    pub fn average_bps(&self) -> u64 {
        if self.session_secs <= 0.0 {
            return 0;
        }
        (self.session_bytes as f64 / self.session_secs) as u64
    }

    /// Seconds remaining. `None` when the size is unknown or nothing is moving,
    /// so the UI shows a dash rather than a nonsense number.
    pub fn eta_secs(&self, downloaded: u64, total: Option<u64>) -> Option<u64> {
        let total = total?;
        let speed = self.speed_bps();
        if speed == 0 || downloaded >= total {
            return None;
        }
        Some((total - downloaded) / speed.max(1))
    }

    /// Marks a stall: called when a download pauses, so the reported speed
    /// drops to zero instead of freezing at its last value.
    pub fn reset(&mut self) {
        self.ema = 0.0;
        self.started = false;
        self.last_at = Instant::now();
    }
}

/// `1.4 MB/s` style rendering. Uses decimal units, matching how bandwidth is
/// universally quoted, and how every browser reports download speed.
pub fn format_speed(bps: u64) -> String {
    format!("{}/s", format_bytes(bps))
}

pub fn format_bytes(n: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if n < 1000 {
        return format!("{n} B");
    }
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if value >= 100.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else if value >= 10.0 {
        format!("{value:.1} {}", UNITS[unit])
    } else {
        format!("{value:.2} {}", UNITS[unit])
    }
}

/// `1h 04m` / `3m 20s` / `45s`.
pub fn format_duration(secs: u64) -> String {
    if secs >= 3600 {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn first_sample_seeds_rather_than_ramps() {
        let t0 = Instant::now();
        let mut s = SpeedTracker::new(0);
        s.last_at = t0;
        // 1 MB in 1 second must read as ~1 MB/s immediately, not as a fraction.
        let rate = s.sample_at(1_000_000, t0 + Duration::from_secs(1));
        assert!(rate > 900_000 && rate < 1_100_000, "got {rate}");
    }

    #[test]
    fn steady_rate_converges() {
        let t0 = Instant::now();
        let mut s = SpeedTracker::new(0);
        s.last_at = t0;
        let mut total = 0u64;
        let mut rate = 0;
        for i in 1..=20 {
            total += 500_000;
            rate = s.sample_at(total, t0 + Duration::from_millis(500 * i));
        }
        assert!(rate > 950_000 && rate < 1_050_000, "converged to {rate}");
    }

    #[test]
    fn a_stall_drags_the_average_down() {
        let t0 = Instant::now();
        let mut s = SpeedTracker::new(0);
        s.last_at = t0;
        s.sample_at(10_000_000, t0 + Duration::from_secs(1));
        // Ten seconds with no new bytes.
        let rate = s.sample_at(10_000_000, t0 + Duration::from_secs(11));
        assert!(rate < 500_000, "stalled rate was {rate}");
    }

    #[test]
    fn a_backwards_counter_resets_instead_of_underflowing() {
        let t0 = Instant::now();
        let mut s = SpeedTracker::new(5_000_000);
        s.last_at = t0;
        let rate = s.sample_at(0, t0 + Duration::from_secs(1));
        assert_eq!(rate, 0);
    }

    #[test]
    fn zero_elapsed_time_is_ignored() {
        let t0 = Instant::now();
        let mut s = SpeedTracker::new(0);
        s.last_at = t0;
        assert_eq!(s.sample_at(1_000_000, t0), 0, "no division by zero");
    }

    #[test]
    fn eta_needs_a_total_and_a_speed() {
        let t0 = Instant::now();
        let mut s = SpeedTracker::new(0);
        s.last_at = t0;
        s.sample_at(1_000_000, t0 + Duration::from_secs(1)); // ~1 MB/s

        assert_eq!(s.eta_secs(1_000_000, None), None, "unknown size");
        let eta = s.eta_secs(1_000_000, Some(11_000_000)).unwrap();
        assert!((9..=11).contains(&eta), "eta was {eta}");
        assert_eq!(
            s.eta_secs(11_000_000, Some(11_000_000)),
            None,
            "already done"
        );
    }

    #[test]
    fn eta_is_none_when_stopped() {
        let s = SpeedTracker::new(0);
        assert_eq!(s.eta_secs(0, Some(1000)), None);
    }

    #[test]
    fn average_reflects_the_whole_session() {
        let t0 = Instant::now();
        let mut s = SpeedTracker::new(0);
        s.last_at = t0;
        s.sample_at(2_000_000, t0 + Duration::from_secs(1));
        s.sample_at(2_000_000, t0 + Duration::from_secs(3)); // stalled 2s
                                                             // 2 MB over 3 seconds.
        let avg = s.average_bps();
        assert!(avg > 600_000 && avg < 700_000, "avg was {avg}");
    }

    #[test]
    fn reset_zeroes_the_reported_speed() {
        let t0 = Instant::now();
        let mut s = SpeedTracker::new(0);
        s.last_at = t0;
        s.sample_at(5_000_000, t0 + Duration::from_secs(1));
        assert!(s.speed_bps() > 0);
        s.reset();
        assert_eq!(s.speed_bps(), 0);
    }

    #[test]
    fn byte_formatting_picks_sensible_precision() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(999), "999 B");
        assert_eq!(format_bytes(1000), "1.00 KB");
        assert_eq!(format_bytes(1_500_000), "1.50 MB");
        assert_eq!(format_bytes(15_000_000), "15.0 MB");
        assert_eq!(format_bytes(150_000_000), "150 MB");
        assert_eq!(format_bytes(2_000_000_000), "2.00 GB");
    }

    #[test]
    fn speed_formatting_appends_per_second() {
        assert_eq!(format_speed(1_500_000), "1.50 MB/s");
    }

    #[test]
    fn duration_formatting() {
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(200), "3m 20s");
        assert_eq!(format_duration(3840), "1h 04m");
    }
}
