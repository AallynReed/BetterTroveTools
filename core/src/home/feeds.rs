//! home.py's Kiwi feeds. Most are fetched off the calling thread and pushed back through
//! a `receive_*` page callback; `cancel_home_fetches` drops whatever is still in flight.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::py;
use super::rotations::chaos_fallback_times;
use super::server_time::now_us;
use crate::args::truthy;
use crate::ctx::ExternalRequest;
use crate::{ctx, http, Cmd, Resp, KIWI_API_BASE};

/// How a feed's JSON becomes the payload the page receives.
#[derive(Debug, Clone, Copy)]
pub enum Shape {
    Items,
    Twitch,
    Events,
    Giveaways,
    Activity,
}

pub struct Feed {
    pub endpoint: &'static str,
    pub label: &'static str,
    pub path: &'static str,
    pub receive: &'static str,
    pub error_code: &'static str,
    pub timeout: u64,
    pub shape: Shape,
}

const fn feed(endpoint: &'static str, label: &'static str, path: &'static str, receive: &'static str, error_code: &'static str, timeout: u64, shape: Shape) -> Feed {
    Feed { endpoint, label, path, receive, error_code, timeout, shape }
}

const TWITCH: Feed = feed("get_twitch_streams", "Fetching Twitch Streams", "/feeds/twitch", "receive_twitch_streams", "TWITCH_FETCH_FAILED", 10, Shape::Twitch);
const YOUTUBE: Feed = feed("get_youtube_videos", "Fetching YouTube Videos", "/feeds/youtube", "receive_youtube_videos", "YOUTUBE_FETCH_FAILED", 10, Shape::Items);
const BILIBILI: Feed = feed("get_bilibili_videos", "Fetching BiliBili Videos", "/feeds/bilibili", "receive_bilibili_videos", "BILIBILI_FETCH_FAILED", 10, Shape::Items);
const EVENTS: Feed = feed("get_trovesaurus_events", "Fetching Trovesaurus Events", "/feeds/events", "receive_events_data", "EVENTS_FETCH_FAILED", 3, Shape::Events);
const NEWS: Feed = feed("get_trove_news", "Fetching Trove News", "/feeds/news", "receive_trove_news", "NEWS_FETCH_FAILED", 8, Shape::Items);
const GIVEAWAYS: Feed = feed("get_giveaways", "Fetching Giveaways", "/giveaways/ongoing", "receive_giveaways", "GIVEAWAYS_FETCH_FAILED", 8, Shape::Giveaways);
const UPCOMING: Feed = feed("get_upcoming_giveaways", "Fetching Upcoming Giveaways", "/giveaways/upcoming", "receive_upcoming_giveaways", "UPCOMING_GIVEAWAYS_FETCH_FAILED", 8, Shape::Giveaways);
// ?days=7 matches the home modal's "last 7 days".
const ENDED: Feed = feed("get_ended_giveaways", "Fetching Recent Giveaways", "/giveaways/ended?days=7", "receive_ended_giveaways", "ENDED_GIVEAWAYS_FETCH_FAILED", 8, Shape::Giveaways);
const ACTIVITY: Feed = feed("get_player_activity", "Fetching Player Activity", "/activity/current", "receive_player_activity", "ACTIVITY_FETCH_FAILED", 6, Shape::Activity);

#[cfg(test)]
pub const FEEDS: [&Feed; 9] = [&TWITCH, &YOUTUBE, &BILIBILI, &EVENTS, &NEWS, &GIVEAWAYS, &UPCOMING, &ENDED, &ACTIVITY];

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("cancel_home_fetches", cancel_home_fetches),
        Cmd::std(TWITCH.endpoint, |_| start(&TWITCH)),
        Cmd::std(YOUTUBE.endpoint, |_| start(&YOUTUBE)),
        Cmd::std(BILIBILI.endpoint, |_| start(&BILIBILI)),
        Cmd::std(EVENTS.endpoint, |_| start(&EVENTS)),
        Cmd::std(NEWS.endpoint, |_| start(&NEWS)),
        Cmd::std(GIVEAWAYS.endpoint, |_| start(&GIVEAWAYS)),
        Cmd::std(UPCOMING.endpoint, |_| start(&UPCOMING)),
        Cmd::std(ENDED.endpoint, |_| start(&ENDED)),
        Cmd::std(ACTIVITY.endpoint, |_| start(&ACTIVITY)),
        Cmd::std("get_chaos_chest_data", |_| Ok(chaos_chest_data())),
    ]
}

/// Bumped by `cancel_home_fetches`; a fetch started under an older value is dropped.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static NEXT_TASK: AtomicU64 = AtomicU64::new(0);
/// The network-panel entry of every fetch still running.
static IN_FLIGHT: Mutex<Vec<(u64, ExternalRequest)>> = Mutex::new(Vec::new());

fn is_active(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

fn cancel_home_fetches(_: &crate::Args) -> Result<Value> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let cancelled = std::mem::take(&mut *IN_FLIGHT.lock());
    for (_, req) in cancelled {
        req.finish(false);
    }
    Ok(Resp::ok(json!({ "cancelled": true })).into())
}

/// GET a Kiwi URL with home.py's headers. Non-2xx statuses are errors.
fn kiwi_get(url: &str, timeout: u64) -> Result<http::Response> {
    let req = http::get(url).set("User-Agent", "BetterTroveTools/1.0").timeout(Duration::from_secs(timeout));
    super::raise_for_status(http::send(req)?)
}

/// The page's payload for a feed, from the API's JSON.
pub fn shape_payload(shape: Shape, payload: Value) -> Result<Value> {
    match shape {
        Shape::Items => Ok(kiwi_items(payload)),
        Shape::Twitch => map_twitch(kiwi_items(payload)),
        Shape::Events => map_events(kiwi_items(payload)),
        Shape::Giveaways => Ok(giveaway_list(payload)),
        Shape::Activity => Ok(trim_activity(&payload)),
    }
}

/// What `receive_*` gets for a fetch outcome.
pub fn receive_payload(feed: &Feed, outcome: Result<Value>) -> Value {
    match outcome {
        Ok(data) => Resp::ok(data).into(),
        Err(e) => Resp::fail(e.to_string(), feed.error_code).into(),
    }
}

/// Fetches on its own thread and pushes the result to the page. Player activity marks
/// its network-panel entry successful before parsing the body; the other feeds after.
fn start(feed: &'static Feed) -> Result<Value> {
    let url = format!("{}{}", KIWI_API_BASE, feed.path);
    let generation = GENERATION.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        if !is_active(generation) {
            return;
        }
        let task = NEXT_TASK.fetch_add(1, Ordering::Relaxed);
        let entry = ctx().external_request(feed.label, &url);
        IN_FLIGHT.lock().push((task, entry));
        let fetched = kiwi_get(&url, feed.timeout).and_then(|r| match feed.shape {
            Shape::Activity => Ok(Fetched::Raw(r)),
            shape => Ok(Fetched::Ready(shape_payload(shape, http::read_json(r)?)?)),
        });
        let req = {
            let mut in_flight = IN_FLIGHT.lock();
            let pos = in_flight.iter().position(|(id, _)| *id == task);
            pos.map(|p| in_flight.remove(p).1)
        };
        // Cancelled while running: the entry was already closed.
        let Some(req) = req else { return };
        let push = |outcome: Result<Value>| {
            if is_active(generation) {
                ctx().js(feed.receive, vec![receive_payload(feed, outcome)]);
            }
        };
        match fetched {
            Err(e) => {
                req.finish(false);
                push(Err(e));
            }
            Ok(_) if !is_active(generation) => req.finish(false),
            Ok(fetched) => {
                req.finish(true);
                push(match fetched {
                    Fetched::Ready(data) => Ok(data),
                    Fetched::Raw(r) => http::read_json(r).and_then(|p| shape_payload(feed.shape, p)),
                });
            }
        }
    });
    Ok(Value::Null)
}

enum Fetched {
    Ready(Value),
    Raw(http::Response),
}

/// `_kiwi_items`: the `items` of a wrapper object, or the bare payload.
pub fn kiwi_items(payload: Value) -> Value {
    match payload {
        Value::Object(mut map) => map.remove("items").unwrap_or_else(|| json!([])),
        other if truthy(&other) => other,
        _ => json!([]),
    }
}

/// `_kiwi_giveaway_list`: a bare array, or the `items` of a wrapper object.
pub fn giveaway_list(payload: Value) -> Value {
    match payload {
        Value::Array(_) => payload,
        Value::Object(mut map) => map.remove("items").unwrap_or_else(|| json!([])),
        _ => json!([]),
    }
}

/// `(items or [])`, iterated.
fn items_of(items: &Value) -> Result<Vec<Value>> {
    if truthy(items) {
        py::iterate(items)
    } else {
        Ok(Vec::new())
    }
}

pub fn map_twitch(items: Value) -> Result<Value> {
    let mut out = Vec::new();
    for item in items_of(&items)? {
        let v = py::as_dict(&item)?;
        let f = |k: &str| py::get(v, k).clone();
        out.push(json!({
            "user_login": f("login"),
            "user_name": f("channel"),
            "viewer_count": f("viewers"),
            "thumbnail_url": f("thumbnail"),
            "title": f("title"),
            "url": f("url"),
            "game_name": f("game"),
            "started_at": f("started_at"),
        }));
    }
    Ok(Value::Array(out))
}

pub fn map_events(items: Value) -> Result<Value> {
    let mut events = Vec::new();
    for item in items_of(&items)? {
        let Value::Object(mut x) = item else {
            return Err(anyhow!("'{}' object is not a mapping", py::type_name(&item)));
        };
        let id = py::get(&x, "event_id").clone();
        let start = py::get(&x, "starts_at").clone();
        let end = py::get(&x, "ends_at").clone();
        x.insert("id".into(), id);
        x.insert("startdate".into(), start);
        x.insert("enddate".into(), end);
        events.push(x);
    }
    let mut keyed = events
        .into_iter()
        .map(|e| Ok((py::int(py::or(py::get(&e, "startdate"), &json!(0)))?, e)))
        .collect::<Result<Vec<_>>>()?;
    keyed.sort_by_key(|(k, _)| *k);
    Ok(Value::Array(keyed.into_iter().map(|(_, e)| Value::Object(e)).collect()))
}

/// The home tile's three rollups and freshness; the heavy per-board list is dropped.
pub fn trim_activity(raw: &Value) -> Value {
    let get = |k: &str| raw.as_object().and_then(|p| p.get(k)).cloned().unwrap_or(Value::Null);
    json!({
        "estimate": get("estimate"),
        "estimate_24h": get("estimate_24h"),
        "estimate_7d": get("estimate_7d"),
        "duration_hours": get("duration_hours"),
        "span_24h_hours": get("span_24h_hours"),
        "span_7d_hours": get("span_7d_hours"),
        "window_end": get("window_end"),
        "computed_at": get("computed_at"),
        "methodology": get("methodology"),
    })
}

/// The chaos-chest item from an API payload, when it names one with a time window.
pub fn chaos_item(payload: &Value) -> Result<Option<Value>> {
    let Some(item) = payload.as_object().and_then(|p| p.get("item")).and_then(Value::as_object) else {
        return Ok(None);
    };
    let blueprint = match py::get(item, "blueprint") {
        Value::String(s) => json!(s.to_lowercase()),
        other => other.clone(),
    };
    let identifier = match py::get(item, "identifier") {
        Value::String(s) => json!(s.replace('\\', "/")),
        other => other.clone(),
    };
    let window = |k: &str| -> Result<Value> {
        match payload.get(k) {
            None | Some(Value::Null) => Ok(Value::Null),
            Some(v) => Ok(json!(py::int(v)?)),
        }
    };
    let normalized = json!({
        "name": py::get(item, "name"),
        "start": window("starts_at")?,
        "end": window("ends_at")?,
        "identifier": identifier,
        "blueprint": blueprint,
        "image_url": py::get(item, "image_url"),
    });
    let complete = ["name", "start", "end"].iter().all(|k| !normalized[*k].is_null());
    Ok(complete.then_some(normalized))
}

/// The endpoint's answer. Any failure still answers, with only the fallback week.
pub fn chaos_envelope(item: Option<Value>, fallback: Value) -> Value {
    Resp::ok(item.unwrap_or(Value::Null)).with("fallback_times", fallback).into()
}

fn chaos_chest_data() -> Value {
    let fallback = chaos_fallback_times(now_us());
    let url = format!("{}/rotations/chaos-chest", KIWI_API_BASE);
    let req = ctx().external_request("Fetching Chaos Chest Data", &url);
    let sent = http::get(&url).set("User-Agent", "BetterTroveTools/1.0").timeout(Duration::from_secs(3));
    let response = match http::send(sent) {
        Ok(r) => r,
        Err(_) => {
            req.finish(false);
            return chaos_envelope(None, fallback);
        }
    };
    let ok = response.status() == 200;
    req.finish(ok);
    let item = if ok { http::read_json(response).and_then(|p| chaos_item(&p)).ok().flatten() } else { None };
    chaos_envelope(item, fallback)
}
