//! home.py's delve endpoints: the weekly floor rotation from the Kiwi API.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::py;
use super::server_time::{now_us, secs, ts, utc, TROVE_TIME, WEEK};
use crate::args::truthy;
use crate::{ctx, http, Cmd, Resp, KIWI_API_BASE};

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("get_delve_status", |_| Ok(delve_status(now_us()))),
        Cmd::std("get_delve_rotation", |_| Ok(delve_rotation())),
    ]
}

const CACHE_TTL_SECONDS: f64 = 30.0 * 60.0;

fn rotation_base() -> i64 {
    utc(2025, 11, 3, 0)
}

fn rotation_url(week: &str) -> String {
    format!("{}/rotations/delves?week={}", KIWI_API_BASE, week)
}

/// Delve weeks roll over on server reset, not UTC midnight.
pub fn current_week_id(now: i64) -> i64 {
    let elapsed = now - TROVE_TIME - rotation_base();
    (py::floordiv(secs(elapsed), 604800.0) as i64 + 1).max(1)
}

/// (start, end) of a week, in UTC.
pub fn week_window(week_id: i64) -> (i64, i64) {
    let start = rotation_base() + (week_id - 1).max(0) * WEEK;
    (start + TROVE_TIME, start + WEEK + TROVE_TIME)
}

pub fn delve_status(now: i64) -> Value {
    let id = current_week_id(now);
    let (start, end) = week_window(id);
    let data = json!({ "currentWeekId": id, "start": ts(start), "end": ts(end) });
    Resp::ok(data).spread().into()
}

fn normalize_enemy(enemy: &Value) -> Value {
    let Some(e) = enemy.as_object() else {
        return json!({ "name": "Unknown", "bans": [], "count": 0 });
    };
    json!({
        "name": e.get("n").cloned().unwrap_or_else(|| json!("Unknown")),
        "bans": py::or(py::get(e, "b"), &json!([])).clone(),
        "count": e.get("c").cloned().unwrap_or_else(|| json!(0)),
    })
}

/// `depth.get(key, [])`, iterated.
fn list_field(d: &Map<String, Value>, key: &str) -> Result<Vec<Value>> {
    match d.get(key) {
        None => Ok(Vec::new()),
        Some(v) => Ok(py::iterate(v)?),
    }
}

pub fn normalize_depth(depth: &Value) -> Result<Value> {
    let d = py::as_dict(depth)?;
    let enemies: Vec<Value> = list_field(d, "enemies")?.iter().map(normalize_enemy).collect();
    let mut rooms = Vec::new();
    for (i, room) in list_field(d, "roomDetails")?.iter().enumerate() {
        let Some(room) = room.as_object() else { continue };
        let index = py::get(room, "e");
        let enemy = py::as_int(index)
            .filter(|&i| i >= 0 && (i as usize) < enemies.len())
            .map(|i| enemies[i as usize].clone())
            .unwrap_or(Value::Null);
        rooms.push(json!({ "room": i + 1, "enemyIndex": index, "enemy": enemy }));
    }
    let boss = py::dict_or_empty(py::get(d, "boss"))?;
    let field = |k: &str| py::get(d, k).clone();
    Ok(json!({
        "id": field("id"),
        "depth": field("depth"),
        "biome": field("biome"),
        "zone": field("zone"),
        "boss": {
            "name": boss.get("n").cloned().unwrap_or_else(|| json!("Unknown")),
            "bans": py::or(py::get(boss, "b"), &json!([])).clone(),
        },
        "objective": field("objective"),
        "objectiveText": field("objectiveText"),
        "killType": field("killType"),
        "killAmount": field("killAmount"),
        "killString": field("killString"),
        "isVaultFloor": truthy(py::get(d, "isVaultFloor")),
        "submittedBy": field("submittedBy"),
        "enemies": enemies,
        "rooms": rooms,
    }))
}

/// The object holding `depths`, bare or under `data`; else `{}`.
pub fn extract_payload(payload: &Value) -> Value {
    let has_depths = |v: &Value| v.get("depths").is_some_and(Value::is_array);
    if payload.is_object() && has_depths(payload) {
        return payload.clone();
    }
    match payload.get("data") {
        Some(nested) if nested.is_object() && has_depths(nested) => nested.clone(),
        _ => json!({}),
    }
}

/// One week as the page shows it, from the API payload.
pub fn week_data(week_id: i64, current_week_id: i64, payload: &Value) -> Result<Value> {
    let (start, end) = week_window(week_id);
    let depths = payload.get("depths").map(py::iterate).transpose()?.unwrap_or_default();
    let depths = depths.iter().map(normalize_depth).collect::<Result<Vec<_>>>()?;
    let count = depths.len();
    Ok(json!({
        "weekId": week_id,
        "isCurrent": week_id == current_week_id,
        "start": ts(start),
        "end": ts(end),
        "depths": depths,
        "depthCount": count,
        "hasData": count > 0,
    }))
}

struct Cached {
    fetched_at: f64,
    data: Value,
}

static CACHE: Mutex<Option<HashMap<i64, Cached>>> = Mutex::new(None);

fn cached(week_id: i64) -> Option<(f64, Value)> {
    CACHE.lock().as_ref()?.get(&week_id).map(|c| (c.fetched_at, c.data.clone()))
}

/// GET one week. `None` on a 404.
fn download_week(week_id: i64) -> Result<Option<Value>> {
    let req = http::get(&rotation_url(&week_id.to_string())).set("User-Agent", "BetterTroveTools/1.0").timeout(Duration::from_secs(15));
    let response = http::send(req)?;
    if response.status() == 404 {
        return Ok(None);
    }
    let response = super::raise_for_status(response)?;
    Ok(Some(extract_payload(&http::read_json(response)?)))
}

fn fetch_week(week_id: i64, current_week_id: i64) -> Result<Option<Value>> {
    if week_id < 1 || week_id > current_week_id {
        return Ok(None);
    }
    let prior = cached(week_id);
    let now_ts = secs(now_us());
    if let Some((fetched_at, data)) = &prior {
        if data["depthCount"].as_i64().unwrap_or(0) > 0 && now_ts - fetched_at < CACHE_TTL_SECONDS {
            return Ok(Some(data.clone()));
        }
    }
    let payload = match download_week(week_id) {
        Ok(None) => return Ok(None),
        Ok(Some(p)) => p,
        Err(e) => return prior.map(|(_, data)| Some(data)).ok_or(e),
    };
    let data = week_data(week_id, current_week_id, &payload)?;
    CACHE.lock().get_or_insert_with(HashMap::new).insert(week_id, Cached { fetched_at: now_ts, data: data.clone() });
    Ok(Some(data))
}

fn delve_rotation() -> Value {
    let req = ctx().external_request("Fetching Delve Index", &rotation_url("current"));
    let current_week_id = current_week_id(now_us());
    let mut weeks = Vec::new();
    for week_id in ((current_week_id - 7).max(1)..=current_week_id).rev() {
        match fetch_week(week_id, current_week_id) {
            Ok(Some(week)) => weeks.push(week),
            Ok(None) => {}
            Err(e) => {
                req.finish(false);
                return Resp::fail(e.to_string(), "DELVE_ROTATION_FAILED").into();
            }
        }
    }
    if weeks.is_empty() {
        req.finish(false);
        return Resp::fail("No delve data found", "DELVE_ROTATION_NOT_FOUND").into();
    }
    weeks.sort_by_key(|w| std::cmp::Reverse(w["weekId"].as_i64().unwrap_or(0)));
    let current = weeks.iter().find(|w| truthy(&w["isCurrent"])).unwrap_or(&weeks[0]).clone();
    let data = json!({ "currentWeekId": current_week_id, "current": current, "weeks": weeks });
    req.finish(true);
    Resp::ok(data).spread().into()
}
