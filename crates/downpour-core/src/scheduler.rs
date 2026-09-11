//! Time-window scheduler.
//!
//! The interesting case is a window that crosses midnight, like 22:00-06:00.
//! For those, the day-of-week filter applies to the day the window *opened*,
//! not to the day the clock currently reads: a "weeknights 22:00-06:00" window
//! that opened on Friday night is still open at 02:00 on Saturday.
//!
//! All reasoning happens on a plain `(weekday, minute-of-day)` pair, which is
//! why this module is trivially testable without mocking a timezone.

use serde::{Deserialize, Serialize};

/// Minutes since local midnight, `0..=1439`.
pub type MinuteOfDay = u16;

pub const MINUTES_PER_DAY: u32 = 24 * 60;

/// Days of the week as a bitmask. Monday is bit 0, Sunday is bit 6, matching
/// ISO-8601 weekday numbering minus one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DaySet(pub u8);

impl DaySet {
    pub const ALL: DaySet = DaySet(0b0111_1111);
    pub const WEEKDAYS: DaySet = DaySet(0b0001_1111);
    pub const WEEKENDS: DaySet = DaySet(0b0110_0000);

    pub fn contains(self, weekday: Weekday) -> bool {
        self.0 & (1 << weekday as u8) != 0
    }
    pub fn is_empty(self) -> bool {
        self.0 & Self::ALL.0 == 0
    }
    pub fn with(self, weekday: Weekday) -> Self {
        DaySet(self.0 | (1 << weekday as u8))
    }
}

impl Default for DaySet {
    fn default() -> Self {
        Self::ALL
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Weekday {
    Monday = 0,
    Tuesday = 1,
    Wednesday = 2,
    Thursday = 3,
    Friday = 4,
    Saturday = 5,
    Sunday = 6,
}

impl Weekday {
    pub fn previous(self) -> Weekday {
        Self::from_index((self as u8 + 6) % 7)
    }
    pub fn next(self) -> Weekday {
        Self::from_index((self as u8 + 1) % 7)
    }
    pub fn from_index(i: u8) -> Weekday {
        match i % 7 {
            0 => Weekday::Monday,
            1 => Weekday::Tuesday,
            2 => Weekday::Wednesday,
            3 => Weekday::Thursday,
            4 => Weekday::Friday,
            5 => Weekday::Saturday,
            _ => Weekday::Sunday,
        }
    }
}

impl From<time::Weekday> for Weekday {
    fn from(w: time::Weekday) -> Self {
        Weekday::from_index(w.number_days_from_monday())
    }
}

/// A local wall-clock instant, reduced to just what the scheduler needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalMoment {
    pub weekday: Weekday,
    pub minute: MinuteOfDay,
}

impl LocalMoment {
    pub fn new(weekday: Weekday, hour: u8, minute: u8) -> Self {
        Self { weekday, minute: hour as u16 * 60 + minute as u16 }
    }

    /// Reads the machine clock. Falls back to UTC if the local offset cannot be
    /// determined, which only happens in exotic multi-threaded Unix setups.
    pub fn now() -> Self {
        let now = time::OffsetDateTime::now_local()
            .unwrap_or_else(|_| time::OffsetDateTime::now_utc());
        Self {
            weekday: now.weekday().into(),
            minute: now.hour() as u16 * 60 + now.minute() as u16,
        }
    }
}

/// A recurring window during which downloads are allowed to run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleWindow {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    /// Inclusive start, minutes since midnight.
    pub start: MinuteOfDay,
    /// Exclusive end, minutes since midnight. When `end <= start` the window
    /// wraps past midnight into the following day.
    pub end: MinuteOfDay,
    #[serde(default)]
    pub days: DaySet,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl ScheduleWindow {
    pub fn new(id: impl Into<String>, start: MinuteOfDay, end: MinuteOfDay) -> Self {
        Self {
            id: id.into(),
            label: None,
            start,
            end,
            days: DaySet::ALL,
            enabled: true,
        }
    }

    /// A window whose end is not strictly after its start runs through midnight.
    pub fn wraps_midnight(&self) -> bool {
        self.end <= self.start
    }

    /// Whether this window is open at `at`.
    ///
    /// For a wrapping window the day filter is checked against the day the
    /// window opened: before midnight that is today, after midnight it is
    /// yesterday.
    pub fn contains(&self, at: LocalMoment) -> bool {
        if !self.enabled || self.days.is_empty() {
            return false;
        }
        // A window with start == end is a full 24h window on its enabled days,
        // not an empty one; treating it as empty would silently disable a
        // schedule the user believes is always-on.
        if self.start == self.end {
            return self.days.contains(at.weekday);
        }
        if self.wraps_midnight() {
            if at.minute >= self.start {
                // Opened earlier today.
                self.days.contains(at.weekday)
            } else if at.minute < self.end {
                // Opened yesterday and has not closed yet.
                self.days.contains(at.weekday.previous())
            } else {
                false
            }
        } else {
            at.minute >= self.start && at.minute < self.end && self.days.contains(at.weekday)
        }
    }

    /// Minutes until this window next opens, or `0` if it is open now.
    /// `None` when the window is disabled or has no enabled days.
    pub fn minutes_until_open(&self, at: LocalMoment) -> Option<u32> {
        if !self.enabled || self.days.is_empty() {
            return None;
        }
        if self.contains(at) {
            return Some(0);
        }
        // Walk forward day by day, up to a full week, looking for the first
        // enabled day whose start time is still ahead of us.
        for day_offset in 0..8u32 {
            let day = Weekday::from_index((at.weekday as u8 + day_offset as u8) % 7);
            if !self.days.contains(day) {
                continue;
            }
            let absolute_start = day_offset * MINUTES_PER_DAY + self.start as u32;
            let now_absolute = at.minute as u32;
            if absolute_start > now_absolute {
                return Some(absolute_start - now_absolute);
            }
        }
        None
    }

    /// Minutes until this window closes, or `None` when it is not open.
    pub fn minutes_until_close(&self, at: LocalMoment) -> Option<u32> {
        if !self.contains(at) {
            return None;
        }
        if self.start == self.end {
            // Always-on: closes at the end of the last consecutive enabled day.
            return None;
        }
        let now = at.minute as u32;
        let end = self.end as u32;
        Some(if end > now { end - now } else { end + MINUTES_PER_DAY - now })
    }

    /// `"02:00"` style rendering, for labels and logs.
    pub fn format_start(&self) -> String {
        format_minute(self.start)
    }
    pub fn format_end(&self) -> String {
        format_minute(self.end)
    }
}

pub fn format_minute(m: MinuteOfDay) -> String {
    format!("{:02}:{:02}", m / 60, m % 60)
}

/// Parses `"22:00"` or `"9:30"` into minutes since midnight.
pub fn parse_time(s: &str) -> Option<MinuteOfDay> {
    let (h, m) = s.trim().split_once(':')?;
    let h: u16 = h.trim().parse().ok()?;
    let m: u16 = m.trim().parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

/// The full schedule: a set of windows plus a master switch.
///
/// When `enabled` is false the scheduler never gates anything, which is the
/// default so a new user is not surprised by downloads refusing to start.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Schedule {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub windows: Vec<ScheduleWindow>,
}

impl Schedule {
    /// Whether scheduled downloads may run right now, plus the label of the
    /// window that authorised it.
    pub fn open_window(&self, at: LocalMoment) -> Option<&ScheduleWindow> {
        if !self.enabled {
            return None;
        }
        self.windows.iter().find(|w| w.contains(at))
    }

    pub fn is_open(&self, at: LocalMoment) -> bool {
        // A disabled schedule gates nothing, so everything is permitted.
        !self.enabled || self.open_window(at).is_some()
    }

    /// Minutes until the soonest window opens. `None` if nothing will open.
    pub fn minutes_until_next_open(&self, at: LocalMoment) -> Option<u32> {
        if !self.enabled {
            return Some(0);
        }
        self.windows
            .iter()
            .filter_map(|w| w.minutes_until_open(at))
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(day: Weekday, h: u8, m: u8) -> LocalMoment {
        LocalMoment::new(day, h, m)
    }

    #[test]
    fn simple_window_contains_and_excludes() {
        let w = ScheduleWindow::new("night", 2 * 60, 7 * 60); // 02:00-07:00
        assert!(w.contains(at(Weekday::Monday, 2, 0)), "inclusive start");
        assert!(w.contains(at(Weekday::Monday, 4, 30)));
        assert!(w.contains(at(Weekday::Monday, 6, 59)));
        assert!(!w.contains(at(Weekday::Monday, 7, 0)), "exclusive end");
        assert!(!w.contains(at(Weekday::Monday, 1, 59)));
        assert!(!w.contains(at(Weekday::Monday, 23, 0)));
    }

    #[test]
    fn window_crossing_midnight_stays_open_after_midnight() {
        let w = ScheduleWindow::new("late", 22 * 60, 6 * 60); // 22:00-06:00
        assert!(w.wraps_midnight());
        assert!(w.contains(at(Weekday::Monday, 22, 0)));
        assert!(w.contains(at(Weekday::Monday, 23, 59)));
        assert!(w.contains(at(Weekday::Tuesday, 0, 0)), "just past midnight");
        assert!(w.contains(at(Weekday::Tuesday, 5, 59)));
        assert!(!w.contains(at(Weekday::Tuesday, 6, 0)), "exclusive end");
        assert!(!w.contains(at(Weekday::Tuesday, 12, 0)));
        assert!(!w.contains(at(Weekday::Monday, 21, 59)));
    }

    #[test]
    fn wrapping_window_day_filter_applies_to_the_opening_day() {
        // Friday-only 22:00-06:00 must still be open at 02:00 on Saturday,
        // and must NOT be open at 22:00 on Saturday.
        let mut w = ScheduleWindow::new("fri", 22 * 60, 6 * 60);
        w.days = DaySet(1 << Weekday::Friday as u8);

        assert!(w.contains(at(Weekday::Friday, 23, 0)), "opens Friday night");
        assert!(w.contains(at(Weekday::Saturday, 2, 0)), "still open Saturday morning");
        assert!(!w.contains(at(Weekday::Saturday, 23, 0)), "does not reopen Saturday");
        assert!(!w.contains(at(Weekday::Friday, 5, 0)), "Friday morning belongs to Thursday night");
    }

    #[test]
    fn non_wrapping_window_day_filter_is_same_day() {
        let mut w = ScheduleWindow::new("work", 9 * 60, 17 * 60);
        w.days = DaySet::WEEKDAYS;
        assert!(w.contains(at(Weekday::Wednesday, 12, 0)));
        assert!(!w.contains(at(Weekday::Saturday, 12, 0)));
    }

    #[test]
    fn equal_start_and_end_is_a_full_day_not_an_empty_one() {
        let w = ScheduleWindow::new("always", 0, 0);
        assert!(w.contains(at(Weekday::Monday, 0, 0)));
        assert!(w.contains(at(Weekday::Monday, 13, 37)));
        assert!(w.contains(at(Weekday::Sunday, 23, 59)));
    }

    #[test]
    fn disabled_window_never_contains() {
        let mut w = ScheduleWindow::new("off", 2 * 60, 7 * 60);
        w.enabled = false;
        assert!(!w.contains(at(Weekday::Monday, 3, 0)));
    }

    #[test]
    fn empty_dayset_never_contains() {
        let mut w = ScheduleWindow::new("nodays", 2 * 60, 7 * 60);
        w.days = DaySet(0);
        assert!(!w.contains(at(Weekday::Monday, 3, 0)));
    }

    #[test]
    fn minutes_until_open_same_day() {
        let w = ScheduleWindow::new("night", 2 * 60, 7 * 60);
        assert_eq!(w.minutes_until_open(at(Weekday::Monday, 0, 0)), Some(120));
        assert_eq!(w.minutes_until_open(at(Weekday::Monday, 3, 0)), Some(0), "open now");
    }

    #[test]
    fn minutes_until_open_rolls_to_tomorrow() {
        let w = ScheduleWindow::new("night", 2 * 60, 7 * 60);
        // 08:00 Monday: next open is 02:00 Tuesday, 18 hours away.
        assert_eq!(w.minutes_until_open(at(Weekday::Monday, 8, 0)), Some(18 * 60));
    }

    #[test]
    fn minutes_until_open_skips_disabled_days() {
        let mut w = ScheduleWindow::new("weekend", 2 * 60, 7 * 60);
        w.days = DaySet::WEEKENDS; // Saturday, Sunday
        // Thursday 08:00 -> Saturday 02:00 is 2 days minus 6 hours.
        assert_eq!(
            w.minutes_until_open(at(Weekday::Thursday, 8, 0)),
            Some(2 * MINUTES_PER_DAY - 6 * 60)
        );
    }

    #[test]
    fn minutes_until_close_handles_wrap() {
        let w = ScheduleWindow::new("late", 22 * 60, 6 * 60);
        assert_eq!(w.minutes_until_close(at(Weekday::Monday, 23, 0)), Some(7 * 60));
        assert_eq!(w.minutes_until_close(at(Weekday::Tuesday, 5, 0)), Some(60));
        assert_eq!(w.minutes_until_close(at(Weekday::Tuesday, 12, 0)), None, "not open");
    }

    #[test]
    fn disabled_schedule_permits_everything() {
        let s = Schedule { enabled: false, windows: vec![] };
        assert!(s.is_open(at(Weekday::Monday, 12, 0)));
        assert!(s.open_window(at(Weekday::Monday, 12, 0)).is_none());
    }

    #[test]
    fn enabled_schedule_with_no_windows_permits_nothing() {
        let s = Schedule { enabled: true, windows: vec![] };
        assert!(!s.is_open(at(Weekday::Monday, 12, 0)));
        assert_eq!(s.minutes_until_next_open(at(Weekday::Monday, 12, 0)), None);
    }

    #[test]
    fn schedule_picks_the_soonest_window() {
        let s = Schedule {
            enabled: true,
            windows: vec![
                ScheduleWindow::new("a", 20 * 60, 22 * 60),
                ScheduleWindow::new("b", 14 * 60, 15 * 60),
            ],
        };
        assert_eq!(s.minutes_until_next_open(at(Weekday::Monday, 12, 0)), Some(2 * 60));
    }

    #[test]
    fn parse_and_format_round_trip() {
        assert_eq!(parse_time("02:00"), Some(120));
        assert_eq!(parse_time("9:30"), Some(570));
        assert_eq!(parse_time("23:59"), Some(1439));
        assert_eq!(parse_time("24:00"), None);
        assert_eq!(parse_time("12:60"), None);
        assert_eq!(parse_time("nope"), None);
        assert_eq!(format_minute(120), "02:00");
        assert_eq!(format_minute(1439), "23:59");
    }

    #[test]
    fn weekday_neighbours_wrap() {
        assert_eq!(Weekday::Monday.previous(), Weekday::Sunday);
        assert_eq!(Weekday::Sunday.next(), Weekday::Monday);
    }
}
