//! utils/trove/server_time.py. Instants are UTC microseconds since the epoch, which is
//! exactly what a Python aware `datetime` holds.

use chrono::{Datelike, NaiveDate};
use serde_json::{Map, Value};

use crate::py;

pub const SEC: i64 = 1_000_000;
pub const HOUR: i64 = 3600 * SEC;
pub const DAY: i64 = 24 * HOUR;
pub const WEEK: i64 = 7 * DAY;

/// Trove's server day starts at 11:00 UTC.
pub const TROVE_TIME: i64 = 11 * HOUR;
const DRAGON_DURATION: i64 = 3 * DAY;
const DRAGON_INTERVAL: i64 = 14 * DAY;
const FLUXION_INTERVAL: i64 = 7 * DAY;
pub const INVASION_INTERVAL: i64 = 27 * HOUR;
pub const INVASION_DURATION: i64 = 3 * HOUR;

/// `datetime(y, m, d, h, tzinfo=UTC)`.
pub fn utc(y: i32, m: u32, d: u32, h: u32) -> i64 {
    NaiveDate::from_ymd_opt(y, m, d).and_then(|d| d.and_hms_opt(h, 0, 0)).expect("valid date").and_utc().timestamp_micros()
}

pub fn first_week_buff() -> i64 {
    utc(2020, 3, 23, 0)
}
pub fn first_corruxion() -> i64 {
    utc(2024, 3, 8, 0)
}
pub fn first_fluxion() -> i64 {
    utc(2023, 7, 18, 0)
}
pub fn first_gardening() -> i64 {
    utc(2025, 5, 23, 0)
}
pub fn first_invasion() -> i64 {
    utc(2026, 3, 24, 9)
}

/// `datetime.now(UTC)`.
pub fn now_us() -> i64 {
    chrono::Utc::now().timestamp_micros()
}

/// `timedelta.total_seconds()` / `datetime.timestamp()`.
pub fn secs(us: i64) -> f64 {
    us as f64 / 1e6
}

/// `int(dt.timestamp())`.
pub fn ts(us: i64) -> i64 {
    secs(us) as i64
}

/// `dt.weekday()`, Monday = 0.
pub fn weekday(us: i64) -> u32 {
    chrono::DateTime::from_timestamp_micros(us).map(|d| d.weekday().num_days_from_monday()).unwrap_or(0)
}

/// `td.days` / `td.seconds` of a timedelta, formatted like home.py's `format_timedelta`.
pub fn format_timedelta(us: i64) -> String {
    let days = us.div_euclid(DAY);
    let seconds = us.rem_euclid(DAY) / SEC;
    let hours = seconds / 3600;
    let minutes = (seconds / 60) % 60;
    if days > 0 {
        format!("{}d {}h", days, hours)
    } else {
        format!("{}h {}m", hours, minutes)
    }
}

/// `load_json_data`: a file in web/assets/data, or `{}`.
pub fn load_json_data(name: &str) -> Value {
    let path = crate::ctx().web_path("assets").join("data").join(name);
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| Value::Object(Map::new()))
}

fn buffs_entry(buffs: Value, key: String) -> Value {
    buffs.get(&key).cloned().unwrap_or_else(|| Value::Object(Map::new()))
}

/// `ServerTime()` frozen at one instant: `now` is server time (UTC - 11h).
pub struct ServerTime {
    pub now: i64,
}

impl ServerTime {
    pub fn at(real_now: i64) -> Self {
        ServerTime { now: real_now - TROVE_TIME }
    }

    fn week_index(&self, target: i64) -> i64 {
        let weeks = py::floordiv(secs(target) - secs(first_week_buff()), 604800.0);
        py::rem(weeks, 4.0) as i64
    }

    pub fn current_daily_buffs(&self) -> Value {
        buffs_entry(load_json_data("daily_buffs.json"), weekday(self.now).to_string())
    }

    pub fn current_weekly_buffs(&self) -> Value {
        buffs_entry(load_json_data("weekly_buffs.json"), self.week_index(self.now).to_string())
    }

    /// (completed, next dragon, seconds into the current cycle).
    fn calculate_dragon(&self, first: i64) -> (i64, i64, i64) {
        let delta = secs(self.now - first) as i64;
        let interval = DRAGON_INTERVAL / SEC;
        let completed = delta.div_euclid(interval);
        (completed, first + (completed + 1) * DRAGON_INTERVAL, delta.rem_euclid(interval))
    }

    pub fn is_dragon(&self, first: i64) -> bool {
        (self.calculate_dragon(first).2 as f64) < secs(DRAGON_DURATION)
    }

    pub fn until_next_dragon(&self, first: i64) -> i64 {
        self.calculate_dragon(first).1 - self.now
    }

    pub fn until_end_dragon(&self, first: i64) -> i64 {
        let next = self.calculate_dragon(first).1;
        let end = if self.is_dragon(first) { next - DRAGON_INTERVAL + DRAGON_DURATION } else { next + DRAGON_DURATION };
        end - self.now
    }

    /// (phase, seconds into the phase, next phase start).
    fn calculate_fluxion(&self) -> (f64, f64, i64) {
        let delta = secs(self.now) - secs(first_fluxion());
        let (completed, current) = py::divmod(delta, secs(DRAGON_INTERVAL));
        let (phase, current) = py::divmod(current, secs(FLUXION_INTERVAL));
        let next = first_fluxion() + (completed * 2.0 + (phase + 1.0)) as i64 * FLUXION_INTERVAL;
        (phase, current, next)
    }

    pub fn is_fluxion(&self) -> bool {
        self.calculate_fluxion().1 < secs(DRAGON_DURATION)
    }

    pub fn is_fluxion_voting(&self) -> bool {
        self.is_fluxion() && self.calculate_fluxion().0 == 0.0
    }

    pub fn is_fluxion_selling(&self) -> bool {
        self.is_fluxion() && self.calculate_fluxion().0 == 1.0
    }

    pub fn until_next_fluxion(&self) -> i64 {
        self.calculate_fluxion().2 - self.now
    }

    pub fn until_end_fluxion(&self) -> i64 {
        let next = self.calculate_fluxion().2;
        let end = if self.is_fluxion() { next - FLUXION_INTERVAL + DRAGON_DURATION } else { next + DRAGON_DURATION };
        end - self.now
    }

    /// (completed cycles, seconds into the current one).
    pub fn invasion_cycle(&self) -> (i64, i64) {
        let delta = secs(self.now - first_invasion()) as i64;
        let interval = INVASION_INTERVAL / SEC;
        (delta.div_euclid(interval), delta.rem_euclid(interval))
    }

    pub fn is_invasion_week(&self, target: i64) -> bool {
        py::rem(secs(target - first_invasion()), (28 * 24 * 3600) as f64) < (6 * 24 * 3600) as f64
    }

    pub fn is_invasion(&self) -> bool {
        let (completed, current) = self.invasion_cycle();
        if !self.is_invasion_week(first_invasion() + completed * INVASION_INTERVAL) {
            return false;
        }
        (current as f64) < secs(INVASION_DURATION)
    }

    fn next_invasion(&self) -> i64 {
        let mut cycle = self.invasion_cycle().0 + 1;
        loop {
            let start = first_invasion() + cycle * INVASION_INTERVAL;
            if self.is_invasion_week(start) {
                return start;
            }
            cycle += 1;
        }
    }

    pub fn until_next_invasion(&self) -> i64 {
        self.next_invasion() - self.now
    }

    pub fn until_end_invasion(&self) -> i64 {
        let end = if self.is_invasion() {
            first_invasion() + self.invasion_cycle().0 * INVASION_INTERVAL + INVASION_DURATION
        } else {
            self.next_invasion() + INVASION_DURATION
        };
        end - self.now
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timedelta_formatting() {
        assert_eq!(format_timedelta(2 * DAY + 5 * HOUR + 59 * 60 * SEC), "2d 5h");
        assert_eq!(format_timedelta(5 * HOUR + 7 * 60 * SEC + 999_999), "5h 7m");
        assert_eq!(format_timedelta(-SEC), "23h 59m");
    }
}
