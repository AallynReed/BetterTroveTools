//! home.py's rotation and schedule endpoints: pure time maths over the bundled data files.

use std::collections::HashMap;

use anyhow::Result;
use serde_json::{json, Map, Value};

use super::py;
use super::server_time::*;
use crate::{Cmd, Resp};

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("get_current_server_data", |_| Ok(current_server_data(now_us()))),
        Cmd::std("get_merchant_schedules", |_| Ok(merchant_schedules(now_us()))),
        Cmd::std("get_yearly_calendar_data", |_| Ok(yearly_calendar_data(now_us()))),
        Cmd::std("get_gardening_rotation", |_| Ok(gardening_rotation(now_us()))),
        Cmd::std("get_d15_rotation", |_| Ok(d15_rotation(now_us()))),
        Cmd::std("get_wild_mana_rotation", |_| Ok(wild_mana_rotation(now_us()))),
        Cmd::std("get_stampy_rotation", |_| Ok(stampy_rotation(now_us()))),
    ]
}

const BIOME1: [&str; 12] = [
    "Sundered Uplands", "Cerise Sandsea", "Deep Forest", "Alkali Flats",
    "Dead of Winter", "Sundered Uplands", "Firefly Party", "Desert of Secrets",
    "Weathered Wastelands", "Frozen Wastes", "Frigga's Fjord", "Abandoned Boneyard",
];
const BIOME2: [&str; 11] = [
    "Cursed Vale", "Hollow Dunes", "Bewitching Wood", "Primal Preserve",
    "Hollow Dunes", "Ancient Heights", "Viking Burial Grounds", "Spellbound Thicket",
    "Saurian Swamp", "Restless Range", "Uncanny Valley",
];
const BIOME3: [&str; 14] = [
    "Sugar Steppes", "Volcanic Fields", "The Lost Isles", "Luminopolis",
    "The Lost Isles", "Blazing Emberlands", "Cocoa Craters", "Data Spires",
    "The Lost Isles", "Cupcake Canyon", "Dragon's Teeth", "Luminopolis",
    "The Lost Isles", "Data Spires",
];

const MANA_BIOMES: [&str; 11] = [
    "Neon City", "Jurassic Jungle", "Dragonfire Peaks", "Forbidden Spires",
    "Sundered Uplands", "Medieval Highlands", "Permafrost", "Cursed Vale",
    "Desert Frontier", "Fae Forest", "Candoria",
];
const STAMPY_BIOMES: [&str; 13] = [
    "Desert Frontier", "The Lost Isles", "Geode Topside", "Neon City", "Dragonfire Peaks",
    "Permafrost", "Candoria", "Cursed Vale", "Forbidden Spires", "Fae Forest",
    "Medieval Highlands", "Jurassic Jungle", "Sundered Uplands",
];

/// Parent biome → icon, for biomes.json entries that don't cover a parent.
const FALLBACK_ICONS: [(&str, &str); 13] = [
    ("Neon City", "neon"), ("Jurassic Jungle", "dinosaur"), ("Dragonfire Peaks", "dragon"),
    ("Forbidden Spires", "spires"), ("Sundered Uplands", "giantland"), ("Medieval Highlands", "forest"),
    ("Permafrost", "tundra"), ("Cursed Vale", "undead"), ("Desert Frontier", "frontier"),
    ("Fae Forest", "fae"), ("Candoria", "candy"), ("Geode Topside", "dunes"), ("The Lost Isles", "pirate"),
];

/// home.py's `system_epoch` / `system_interval` (the d15 rotation).
const D15_INTERVAL: i64 = 3 * HOUR;
fn d15_epoch() -> i64 {
    utc(2024, 6, 18, 11)
}
fn mana_base() -> i64 {
    utc(2023, 11, 20, 11)
}
fn stampy_base() -> i64 {
    utc(2023, 9, 30, 11)
}

/// web/assets/data/biomes.json, with Python's message when it can't be read.
fn load_biomes() -> Result<Map<String, Value>, String> {
    let path = crate::ctx().web_path("assets").join("data").join("biomes.json");
    let text = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            format!("[Errno 2] No such file or directory: {}", py::repr_str(&path.to_string_lossy()))
        }
        _ => e.to_string(),
    })?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(value.as_object().cloned().unwrap_or_default())
}

/// Parent biome → icon of its first sub-biome.
struct Icons(HashMap<String, Value>);

impl Icons {
    fn new(subbiomes: &Map<String, Value>) -> Self {
        let mut map = HashMap::new();
        for val in subbiomes.values() {
            if let Some(Value::String(parent)) = val.get("biome") {
                if !parent.is_empty() && !map.contains_key(parent) {
                    map.insert(parent.clone(), val.get("icon").cloned().unwrap_or_else(|| json!("unknown")));
                }
            }
        }
        Icons(map)
    }

    fn get(&self, biome: &str) -> Value {
        if let Some(icon) = self.0.get(biome) {
            return icon.clone();
        }
        let fallback = FALLBACK_ICONS.iter().find(|(b, _)| *b == biome).map(|(_, i)| *i).unwrap_or("unknown");
        json!(fallback)
    }

    fn entry(&self, biome: &str) -> Value {
        json!({ "name": biome, "final_name": biome, "icon": self.get(biome) })
    }
}

/// `int(diff // period)` for two instants.
fn periods(from: i64, to: i64, period: i64) -> i64 {
    py::floordiv(secs(to - from), secs(period)) as i64
}

pub fn current_server_data(now: i64) -> Value {
    let st = ServerTime::at(now);
    let corruxion = first_corruxion();
    let corr_active = st.is_dragon(corruxion);
    let corr_time = if corr_active { st.until_end_dragon(corruxion) } else { st.until_next_dragon(corruxion) };

    let flux_active = st.is_fluxion();
    let flux_state = if st.is_fluxion_voting() {
        "Voting"
    } else if st.is_fluxion_selling() {
        "Selling"
    } else {
        "Away"
    };
    let flux_time = if flux_active { st.until_end_fluxion() } else { st.until_next_fluxion() };

    let inv_active = st.is_invasion();
    let inv_time = if inv_active { st.until_end_invasion() } else { st.until_next_invasion() };

    let merchants = json!({
        "corruxion": {
            "active": corr_active,
            "time_str": format_timedelta(corr_time),
            "action": if corr_active { "Leaves in" } else { "Arrives in" },
        },
        "fluxion": {
            "active": flux_active,
            "state": flux_state,
            "time_str": format_timedelta(flux_time),
            "action": if flux_active { "Ends in" } else { "Starts in" },
        },
        "invasion": {
            "active": inv_active,
            "time_str": format_timedelta(inv_time),
            "action": if inv_active { "Ends in" } else { "Starts in" },
        },
    });
    let data = json!({
        "daily": st.current_daily_buffs(),
        "weekly": st.current_weekly_buffs(),
        "merchants": merchants,
    });
    Resp::ok(data).spread().into()
}

/// The current chaos-chest week, used when the API has no item.
pub fn chaos_fallback_times(now: i64) -> Value {
    let base = first_fluxion() + TROVE_TIME;
    let start = base + periods(base, now, WEEK) * WEEK;
    json!({ "start": ts(start), "end": ts(start + WEEK) })
}

pub fn merchant_schedules(now: i64) -> Value {
    let st = ServerTime::at(now);
    let span = |s: i64, e: i64| json!({ "start": ts(s), "end": ts(e) });

    let dragon = {
        let base = first_corruxion() + TROVE_TIME;
        let mut s = base + periods(base, now, 14 * DAY) * 14 * DAY;
        if s + 3 * DAY < now {
            s += 14 * DAY;
        }
        (0..8).map(|i| span(s + i * 14 * DAY, s + i * 14 * DAY + 3 * DAY)).collect::<Vec<_>>()
    };

    let fluxion = {
        let base = first_fluxion() + TROVE_TIME;
        let mut intervals = periods(base, now, WEEK);
        let mut s = base + intervals * WEEK;
        if s + 3 * DAY < now {
            s += WEEK;
            intervals += 1;
        }
        (0..8)
            .map(|i| {
                let start = s + i * WEEK;
                let name = if (intervals + i).rem_euclid(2) == 0 { "Voting" } else { "Selling" };
                json!({ "start": ts(start), "end": ts(start + 3 * DAY), "name": name })
            })
            .collect::<Vec<_>>()
    };

    let mut invasion = Vec::new();
    let mut cycle = st.invasion_cycle().0;
    while invasion.len() < 8 {
        let start = first_invasion() + cycle * INVASION_INTERVAL;
        if st.is_invasion_week(start) {
            let end = start + INVASION_DURATION;
            if end > st.now {
                invasion.push(span(start + TROVE_TIME, end + TROVE_TIME));
            }
        }
        cycle += 1;
    }

    let data = json!({ "corruxion": dragon, "fluxion": fluxion, "invasion": invasion });
    Resp::ok(data).spread().into()
}

/// The weekly-buff rows of the calendar. Python stops at the first error and keeps
/// whatever rows it already added.
fn weekly_buff_events(now: i64, start_date: i64, end_date: i64, events: &mut Vec<Value>) -> Option<()> {
    let current_weekly = ServerTime::at(now).current_weekly_buffs();
    let path = crate::ctx().web_path("assets").join("data").join("weekly_buffs.json");
    let data: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let data = data.as_object()?;

    let mut keys: Vec<(i64, &String)> = data.keys().map(|k| py::int(&json!(k)).ok().map(|n| (n, k))).collect::<Option<_>>()?;
    keys.sort_by_key(|(n, _)| *n);
    let name_of = |v: &Value| v.get("name").cloned().unwrap_or(Value::Null);
    let wanted = name_of(&current_weekly);
    let current_index = keys.iter().find(|(_, k)| name_of(&data[k.as_str()]) == wanted).map(|(n, _)| *n).unwrap_or(0);

    let day_start = now.div_euclid(DAY) * DAY;
    let mut week_start = day_start + TROVE_TIME - weekday(now) as i64 * DAY;
    if now < week_start {
        week_start -= WEEK;
    }
    for offset in -55..55_i64 {
        let s = week_start + offset * WEEK;
        let e = s + WEEK;
        if e > start_date && s < end_date {
            if keys.is_empty() {
                return None;
            }
            let idx = (current_index + offset).rem_euclid(keys.len() as i64) as usize;
            let buff = data[keys[idx].1.as_str()].as_object()?;
            events.push(json!({
                "type": "weekly_buff",
                "start": ts(s),
                "end": ts(e),
                "name": buff.get("name").cloned().unwrap_or_else(|| json!("Weekly Buff")),
                "color": buff.get("color").cloned().unwrap_or_else(|| json!("fbc02d")),
            }));
        }
    }
    Some(())
}

pub fn yearly_calendar_data(now: i64) -> Value {
    let start_date = now - 365 * DAY;
    let end_date = now + 365 * DAY;
    let mut events = Vec::new();

    weekly_buff_events(now, start_date, end_date, &mut events);

    let icons = Icons::new(&load_biomes().unwrap_or_default());

    let base = stampy_base();
    let mut weeks = periods(base, start_date, WEEK);
    let mut s = base + weeks * WEEK;
    while s < end_date {
        let e = s + 48 * HOUR;
        if e > start_date {
            let b = STAMPY_BIOMES[weeks.rem_euclid(STAMPY_BIOMES.len() as i64) as usize];
            events.push(json!({"type": "stampy", "start": ts(s), "end": ts(e), "name": "Stampy", "icons": [icons.get(b)], "biome_names": [b]}));
        }
        s += WEEK;
        weeks += 1;
    }

    let base = mana_base();
    let mut weeks = periods(base, start_date, WEEK);
    let mut s = base + weeks * WEEK;
    let n = MANA_BIOMES.len() as i64;
    while s < end_date {
        let e = s + WEEK;
        if e > start_date {
            let b: Vec<&str> = (0..3).map(|k| MANA_BIOMES[(weeks - k).rem_euclid(n) as usize]).collect();
            let icons: Vec<Value> = b.iter().map(|b| icons.get(b)).collect();
            events.push(json!({"type": "mana", "start": ts(s), "end": ts(e), "name": "Wild Mana", "icons": icons, "biome_names": b}));
        }
        s += WEEK;
        weeks += 1;
    }

    let base = utc(2023, 12, 8, 11);
    let mut s = base + periods(base, start_date, 14 * DAY) * 14 * DAY;
    while s < end_date {
        let e = s + 3 * DAY;
        if e > start_date {
            events.push(json!({"type": "corruxion", "start": ts(s), "end": ts(e), "name": "Corruxion"}));
        }
        s += 14 * DAY;
    }

    let base = utc(2023, 12, 5, 11);
    let mut s = base + periods(base, start_date, 14 * DAY) * 14 * DAY;
    while s < end_date {
        let (s_vote, e_vote) = (s, s + 3 * DAY);
        let (s_sell, e_sell) = (s + WEEK, s + WEEK + 3 * DAY);
        if e_vote > start_date {
            events.push(json!({"type": "fluxion", "start": ts(s_vote), "end": ts(e_vote), "name": "Fluxion (Voting)", "color": "5ca8cc"}));
        }
        if e_sell > start_date && s_sell < end_date {
            events.push(json!({"type": "fluxion", "start": ts(s_sell), "end": ts(e_sell), "name": "Fluxion (Selling)", "color": "02679e"}));
        }
        s += 14 * DAY;
    }

    let base = first_gardening() + TROVE_TIME;
    for (cycle, kind, name, color) in [(2, "gardening_2", "2-day plants", "8bc34a"), (3, "gardening_3", "3-day plants", "4caf50")] {
        let period = cycle * DAY;
        let mut s = base + periods(base, start_date, period) * period;
        while s < end_date {
            let (h_start, h_end) = (s + period - DAY, s + period);
            if h_end > start_date && h_start < end_date {
                events.push(json!({"type": kind, "start": ts(h_start), "end": ts(h_end), "name": name, "color": color}));
            }
            s += period;
        }
    }

    let st = ServerTime::at(now);
    let (trove_start, trove_end) = (start_date - TROVE_TIME, end_date - TROVE_TIME);
    let mut s = first_invasion() + periods(first_invasion(), trove_start, INVASION_INTERVAL) * INVASION_INTERVAL;
    while s < trove_end {
        let e = s + INVASION_DURATION;
        if e > trove_start && st.is_invasion_week(s) {
            events.push(json!({"type": "invasion", "start": ts(s + TROVE_TIME), "end": ts(e + TROVE_TIME), "name": "Luxion's Fast Trials"}));
        }
        s += INVASION_INTERVAL;
    }

    Resp::ok(json!({ "events": events })).with("events", events).into()
}

pub fn gardening_rotation(now: i64) -> Value {
    let base = first_gardening() + TROVE_TIME;
    let now_ts = secs(now);
    let window = |cycle: i64, name: &str| {
        let period = cycle * DAY;
        let current = base + periods(base, now, period) * period;
        let (start, end) = (current + period - DAY, current + period);
        let info = json!({ "name": name, "active": secs(start) <= now_ts && now_ts < secs(end), "start": ts(start), "end": ts(end) });
        (current, info)
    };
    let (current_2, two_day) = window(2, "2-day plants");
    let (current_3, three_day) = window(3, "3-day plants");

    let mut future = Vec::new();
    for i in 0..8 {
        for (current, cycle, name) in [(current_2, 2, "2-day plants"), (current_3, 3, "3-day plants")] {
            let s = current + i * cycle * DAY;
            let (h_start, h_end) = (s + (cycle - 1) * DAY, s + cycle * DAY);
            if secs(h_start) > now_ts {
                future.push(json!({ "name": name, "start": ts(h_start), "end": ts(h_end) }));
            }
        }
    }
    future.sort_by_key(|e| e["start"].as_i64());
    future.truncate(10);

    let data = json!({ "two_day": two_day, "three_day": three_day, "future": future });
    Resp::ok(data).spread().into()
}

pub fn d15_rotation(now: i64) -> Value {
    let subbiomes = match load_biomes() {
        Ok(b) => b,
        Err(e) => return Resp::fail(e, "D15_ROTATION_BIOMES_FAILED").into(),
    };
    let elapsed = secs(now - d15_epoch());
    let interval = secs(D15_INTERVAL);
    let consumed = py::floordiv(elapsed, interval) as i64;
    let start = now - py::seconds_to_us(py::rem(elapsed, interval));

    let pick = |list: &[&str], offset: i64| {
        let name = list[offset.rem_euclid(list.len() as i64) as usize];
        subbiomes.get(name).cloned().unwrap_or_else(|| json!({ "name": name, "final_name": name, "icon": "unknown" }))
    };
    let rotations: Vec<Value> = (-8..56_i64)
        .map(|i| {
            let offset = consumed + i;
            let s = start + i * D15_INTERVAL;
            json!({
                "start": ts(s),
                "end": ts(s + D15_INTERVAL),
                "biomes": [pick(&BIOME1, offset), pick(&BIOME2, offset), pick(&BIOME3, offset)],
            })
        })
        .collect();

    let now_ts = secs(now);
    let current = rotations
        .iter()
        .find(|r| (r["start"].as_i64().unwrap_or(0) as f64) <= now_ts && now_ts < r["end"].as_i64().unwrap_or(0) as f64)
        .cloned()
        .unwrap_or(Value::Null);
    let data = json!({ "current": current, "rotations": rotations });
    Resp::ok(data).spread().into()
}

pub fn wild_mana_rotation(now: i64) -> Value {
    let subbiomes = match load_biomes() {
        Ok(b) => b,
        Err(e) => return Resp::fail(e, "WILD_MANA_BIOMES_FAILED").into(),
    };
    let icons = Icons::new(&subbiomes);
    let base = mana_base();
    let weeks = periods(base, now, WEEK);
    let n = MANA_BIOMES.len() as i64;

    let mut current = json!({});
    let mut future = Vec::new();
    for i in 0..8 {
        let w = weeks + i;
        let s = base + w * WEEK;
        let biomes: Vec<Value> = (0..3).map(|k| icons.entry(MANA_BIOMES[(w - k).rem_euclid(n) as usize])).collect();
        let rot = json!({ "start": ts(s), "end": ts(s + WEEK), "biomes": biomes });
        if i == 0 {
            current = rot;
        } else {
            future.push(rot);
        }
    }
    let data = json!({ "current": current, "future": future });
    Resp::ok(data).spread().into()
}

pub fn stampy_rotation(now: i64) -> Value {
    let subbiomes = match load_biomes() {
        Ok(b) => b,
        Err(e) => return Resp::fail(e, "STAMPY_BIOMES_FAILED").into(),
    };
    let icons = Icons::new(&subbiomes);
    let base = stampy_base();
    let offset = periods(base, now, WEEK);

    let mut events = Vec::new();
    for w in offset - 1..offset + 10 {
        let s = base + w * WEEK;
        let e = s + 48 * HOUR;
        if e > now {
            let b = STAMPY_BIOMES[w.rem_euclid(STAMPY_BIOMES.len() as i64) as usize];
            events.push(json!({ "start": ts(s), "end": ts(e), "biomes": [icons.entry(b)] }));
            if events.len() == 8 {
                break;
            }
        }
    }
    if events.is_empty() {
        return Resp::fail("No valid Stampy events found", "STAMPY_EVENTS_NOT_FOUND").into();
    }
    let current = events.remove(0);
    let data = json!({ "current": current, "future": events });
    Resp::ok(data).spread().into()
}
