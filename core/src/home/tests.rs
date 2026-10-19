//! Parity with the Python build. The golden files come from tools/parity/home.py.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::event_notifications::{handle, EventNotifier};
use super::feeds::{chaos_envelope, chaos_item, receive_payload, shape_payload, FEEDS};
use super::live_feed::LiveFeed;
use super::{delve, image_proxy, rotations};
use crate::json::dumps;
use crate::response::normalize;
use crate::KIWI_API_BASE;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/home").join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e))).unwrap()
}

fn short_hash(v: &Value) -> String {
    hex::encode(Sha256::digest(dumps(v).as_bytes()))[..12].to_string()
}

fn clip(s: String) -> String {
    s.chars().take(1500).collect()
}

/// Key order and number formatting count, so compare as Python would print them.
fn same(a: &Value, b: &Value) -> bool {
    dumps(a) == dumps(b)
}

fn rotation(name: &str, now: i64) -> Value {
    match name {
        "get_current_server_data" => normalize(rotations::current_server_data(now)),
        "get_merchant_schedules" => normalize(rotations::merchant_schedules(now)),
        "get_yearly_calendar_data" => normalize(rotations::yearly_calendar_data(now)),
        "get_gardening_rotation" => normalize(rotations::gardening_rotation(now)),
        "get_d15_rotation" => normalize(rotations::d15_rotation(now)),
        "get_wild_mana_rotation" => normalize(rotations::wild_mana_rotation(now)),
        "get_stampy_rotation" => normalize(rotations::stampy_rotation(now)),
        "get_delve_status" => normalize(delve::delve_status(now)),
        "chaos_fallback" => rotations::chaos_fallback_times(now),
        other => panic!("unknown rotation {}", other),
    }
}

fn check_rotations(golden: &Value) {
    crate::ctx::testing::init();
    let names: Vec<&str> = golden["endpoints"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    let mut failures = Vec::new();
    let cases = golden["cases"].as_array().unwrap();
    for case in cases {
        let now = case[0].as_i64().unwrap();
        for (name, want) in names.iter().zip(case[1].as_str().unwrap().split(',')) {
            let got = rotation(name, now);
            if short_hash(&got) != want {
                failures.push(format!("{} at {}: {}", name, now, clip(dumps(&got))));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} rotation outputs differ; first:\n{}", failures.len(), cases.len() * names.len(), failures[..failures.len().min(3)].join("\n"));
}

#[test]
fn rotations_match_python() {
    check_rotations(&fixture("rotations.json"));
}

/// `python tools/parity/home.py --sweep N OUT`, then BTT_HOME_SWEEP=OUT.
#[test]
#[ignore]
fn rotation_sweep_matches_python() {
    let path = std::env::var("BTT_HOME_SWEEP").expect("set BTT_HOME_SWEEP");
    check_rotations(&serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap());
}

/// `case` holds Python's `out`, or the `error` it raised.
fn check_outcome(what: &str, input: &Value, got: anyhow::Result<Value>, case: &Value) {
    match (got, case.get("error")) {
        (Ok(v), None) => assert!(same(&v, &case["out"]), "{}: {}\n  want {}\n  got  {}", what, input, case["out"], v),
        (Err(e), Some(want)) => assert_eq!(json!(e.to_string()), *want, "{}: {}", what, input),
        (got, _) => panic!("{}: {} gave {:?}, Python {}", what, input, got.map_err(|e| e.to_string()), case),
    }
}

#[test]
fn delve_payloads_match_python() {
    let golden = fixture("transforms.json");
    for case in golden["delve_depth"].as_array().unwrap() {
        check_outcome("normalize_depth", &case["in"], delve::normalize_depth(&case["in"]), case);
    }
    for case in golden["delve_payload"].as_array().unwrap() {
        assert!(same(&delve::extract_payload(&case["in"]), &case["out"]), "extract_payload {}", case["in"]);
    }
    for case in golden["delve_week"].as_array().unwrap() {
        let (week, current) = (case["week_id"].as_i64().unwrap(), case["current"].as_i64().unwrap());
        let got = delve::week_data(week, current, &delve::extract_payload(&case["payload"]));
        check_outcome("week_data", &case["payload"], got, case);
    }
}

#[test]
fn feeds_match_python() {
    let golden = fixture("transforms.json");
    let payloads = golden["feed_payloads"].as_array().unwrap();
    let python = golden["feeds"].as_object().unwrap();
    assert_eq!(python.len(), FEEDS.len());
    for feed in FEEDS {
        let py = &python[feed.endpoint];
        let url = format!("{}{}", KIWI_API_BASE, feed.path);
        assert_eq!(py["label"], feed.label, "{}", feed.endpoint);
        assert_eq!(py["url"], url, "{}", feed.endpoint);
        assert_eq!(py["request_url"], url, "{}", feed.endpoint);
        assert_eq!(py["headers"], json!({ "User-Agent": "BetterTroveTools/1.0" }), "{}", feed.endpoint);
        assert_eq!(py["timeout"], feed.timeout, "{}", feed.endpoint);
        assert_eq!(py["receive"], feed.receive, "{}", feed.endpoint);
        assert!(same(&py["returns"], &normalize(Value::Null)), "{}", feed.endpoint);
        for (payload, want) in payloads.iter().zip(py["received"].as_array().unwrap()) {
            let got = receive_payload(feed, shape_payload(feed.shape, payload.clone()));
            assert!(same(&got, want), "{} with {}\n  want {}\n  got  {}", feed.endpoint, payload, want, got);
        }
    }
}

#[test]
fn chaos_chest_matches_python() {
    for case in fixture("transforms.json")["chaos"].as_array().unwrap() {
        let item = if case["status"] == 200 { chaos_item(&case["payload"]).ok().flatten() } else { None };
        let got = normalize(chaos_envelope(item, rotations::chaos_fallback_times(case["now_us"].as_i64().unwrap())));
        assert!(same(&got, &case["out"]), "{}\n  want {}\n  got  {}", case["payload"], case["out"], got);
    }
}

#[test]
fn notification_handlers_match_python() {
    for case in fixture("event_notifications.json")["handlers"].as_array().unwrap() {
        let got = case["data"].as_object().and_then(|d| handle(case["type"].as_str().unwrap(), d));
        let got = got.map(|(k, s, t, b)| json!([k, s, t, b])).unwrap_or(Value::Null);
        assert_eq!(got, case["out"], "{} {}", case["type"], case["data"]);
    }
}

#[test]
fn notification_scenarios_match_python() {
    for scenario in fixture("event_notifications.json")["scenarios"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("event_notifications_state.json");
        match &scenario["initial"] {
            Value::Null => {}
            Value::String(raw) => std::fs::write(&path, raw).unwrap(),
            other => std::fs::write(&path, dumps(other)).unwrap(),
        }
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sink = sent.clone();
        let n = EventNotifier::new(path.clone(), move |t, b| sink.lock().push(json!([t, b])));
        let mut last = Map::new();
        let mut enabled = Vec::new();
        for step in scenario["steps"].as_array().unwrap() {
            if step[0] == "apply" {
                n.apply(&step[1], || last.clone());
                enabled.push(json!(n.is_enabled()));
            } else {
                let event_type = step[1].as_str().unwrap();
                last.insert(event_type.to_string(), step[2].clone());
                n.on_event(event_type, &step[2]);
            }
        }
        assert_eq!(Value::Array(sent.lock().clone()), scenario["sent"], "{}", scenario["steps"]);
        assert_eq!(Value::Array(enabled), scenario["enabled"], "{}", scenario["steps"]);
        let state = std::fs::read_to_string(&path).ok().map(Value::String).unwrap_or(Value::Null);
        assert_eq!(state, scenario["state"], "{}", scenario["steps"]);
    }
}

#[test]
fn image_proxy_matches_python() {
    let golden = fixture("image_proxy.json");
    for case in golden["urls"].as_array().unwrap() {
        let got = image_proxy::resolve_image_url(case["url"].as_str());
        assert_eq!(json!(got), case["out"], "{}", case["url"]);
    }
    for case in golden["queries"].as_array().unwrap() {
        assert_eq!(json!(image_proxy::query_url(case["query"].as_str().unwrap())), case["url"], "{}", case["query"]);
    }
    assert_eq!(image_proxy::fetch_image(Some("https://evil.example/a.jpg")), (403, b"Forbidden".to_vec(), "text/plain"));
    let req = crate::routes::Request { method: "GET".into(), path: "/proxy/bilibili_image".into(), query: "url=https%3A%2F%2Fevil.example%2Fa.jpg".into(), ..Default::default() };
    let resp = crate::routes::handle(&req);
    assert_eq!((resp.status, resp.body), (403, b"Forbidden".to_vec()));
}

fn recording_feed() -> (LiveFeed, Arc<Mutex<Vec<Value>>>) {
    let feed = LiveFeed::default();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    feed.subscribe(move |t, d| sink.lock().push(json!([t, d])));
    (feed, seen)
}

#[test]
fn sse_parsing_matches_python() {
    for case in fixture("sse.json").as_array().unwrap() {
        let (feed, seen) = recording_feed();
        feed.set_connected(true);
        feed.consume(case["body"].as_str().unwrap().as_bytes()).unwrap();
        assert!(same(&Value::Array(seen.lock().clone()), &case["events"]), "events for {}", case["body"]);
        assert!(same(&Value::Object(feed.snapshot()), &case["snapshot"]));
    }
}

#[test]
fn sse_failing_subscriber_does_not_starve_the_others() {
    let feed = LiveFeed::default();
    feed.subscribe(|_, _| panic!("boom"));
    let (late, seen) = (feed, Arc::new(Mutex::new(Vec::new())));
    let sink = seen.clone();
    late.subscribe(move |t, _| sink.lock().push(t.to_string()));
    late.dispatch("chaos", "{\"data\": {\"item\": {}}}");
    assert_eq!(*seen.lock(), vec!["chaos".to_string()]);
}

#[test]
fn endpoints_answer_like_python() {
    crate::ctx::testing::init();
    assert!(same(&crate::call("cancel_home_fetches", vec![]).unwrap().unwrap(), &json!({"success": true, "code": "OK", "data": {"cancelled": true}, "error": null, "meta": {}})));
    let status = crate::call("get_live_feed_status", vec![]).unwrap().unwrap();
    assert_eq!(status["data"]["connected"], false);
    assert_eq!(status["connected"], status["data"]["connected"]);
    assert!(status["events"].is_object());
    // Master switch off: nothing is replayed, so nothing is written.
    for arg in [json!({"enabled": false, "events": {"chaos": true}}), Value::Null] {
        let applied = crate::call("apply_event_notifications", vec![arg]).unwrap().unwrap();
        assert!(same(&applied, &json!({"success": true, "code": "OK", "data": {"enabled": false}, "error": null, "meta": {}, "enabled": false})));
    }
}

// --- live ------------------------------------------------------------------------------

/// The first JSON path where two values differ.
fn first_diff(path: &str, a: &Value, b: &Value) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            if x.keys().ne(y.keys()) {
                return Some(format!("{}: keys {:?} vs {:?}", path, x.keys().collect::<Vec<_>>(), y.keys().collect::<Vec<_>>()));
            }
            x.iter().find_map(|(k, v)| first_diff(&format!("{}.{}", path, k), v, &y[k]))
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{}: {} vs {} items", path, x.len(), y.len()));
            }
            x.iter().zip(y).enumerate().find_map(|(i, (v, w))| first_diff(&format!("{}[{}]", path, i), v, w))
        }
        _ if same(a, b) => None,
        _ => Some(format!("{}: {} vs {}", path, clip(dumps(a)), clip(dumps(b)))),
    }
}

fn wait_for_call(host: &crate::ctx::testing::TestHost, name: &str, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        {
            let mut calls = host.calls.lock();
            if let Some(pos) = calls.iter().position(|(n, _)| n == name) {
                return calls.remove(pos).1[0].clone();
            }
        }
        assert!(Instant::now() < deadline, "no {} within {:?}", name, timeout);
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Values the server computes per request (countdowns, probe latency) tick between runs.
const VOLATILE: [&str; 4] = ["seconds_remaining", "seconds_until", "latency_ms", "checked_at"];

fn stable(mut v: Value) -> Value {
    match &mut v {
        Value::Object(map) => {
            map.retain(|k, _| !VOLATILE.contains(&k.as_str()));
            for child in map.values_mut() {
                *child = stable(child.take());
            }
        }
        Value::Array(items) => {
            for child in items.iter_mut() {
                *child = stable(child.take());
            }
        }
        _ => {}
    }
    v
}

/// `python tools/parity/home.py --live OUT`, then right away BTT_HOME_LIVE=OUT.
#[test]
#[ignore]
fn live_matches_python() {
    let path = std::env::var("BTT_HOME_LIVE").expect("set BTT_HOME_LIVE");
    let py: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let host = crate::ctx::testing::init();
    let mut diffs = Vec::new();
    let mut check = |what: &str, want: &Value, got: &Value| {
        let verdict = first_diff(what, &stable(want.clone()), &stable(got.clone()));
        println!("{}: {}", what, verdict.as_deref().unwrap_or("same"));
        diffs.extend(verdict);
    };

    for feed in FEEDS {
        crate::call(feed.endpoint, vec![]).unwrap().unwrap();
        let got = wait_for_call(&host, feed.receive, Duration::from_secs(30));
        check(feed.endpoint, &py["feeds"][feed.endpoint], &got);
    }
    check("get_chaos_chest_data", &py["chaos"], &crate::call("get_chaos_chest_data", vec![]).unwrap().unwrap());
    check("get_delve_rotation", &py["delve"], &crate::call("get_delve_rotation", vec![]).unwrap().unwrap());

    for probe in py["proxy"].as_array().unwrap() {
        let (status, body, content_type) = image_proxy::fetch_image(probe["url"].as_str());
        let got = json!({ "url": probe["url"], "status": status, "sha256": hex::encode(Sha256::digest(&body)), "content_type": content_type });
        check("proxy", probe, &got);
    }

    let missing = crate::http::send(crate::http::get(&format!("{}/feeds/does-not-exist", KIWI_API_BASE)).timeout(Duration::from_secs(10))).unwrap();
    let error = super::raise_for_status(missing).err().map(|e| json!(e.to_string())).unwrap_or(Value::Null);
    check("raise_for_status", &py["http_error"], &error);

    // The route serves the image with main.py's headers.
    let thumb = py["proxy"][0]["url"].as_str().unwrap();
    let query = format!("url={}", crate::http::quote(thumb));
    let resp = crate::routes::handle(&crate::routes::Request { method: "GET".into(), path: "/proxy/bilibili_image".into(), query, ..Default::default() });
    let headers: Map<String, Value> = resp.headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    let got = json!({ "status": resp.status, "sha256": hex::encode(Sha256::digest(&resp.body)), "headers": headers });
    let want = json!({ "status": 200, "sha256": py["proxy"][0]["sha256"], "headers": {
        "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    }});
    check("proxy route", &want, &got);

    // Cancelling drops the push and closes the network-panel entry as failed.
    host.calls.lock().clear();
    crate::call("get_youtube_videos", vec![]).unwrap().unwrap();
    std::thread::sleep(Duration::from_millis(20));
    crate::call("cancel_home_fetches", vec![]).unwrap().unwrap();
    std::thread::sleep(Duration::from_secs(10));
    let after: Vec<Value> = host.calls.lock().iter().map(|(n, a)| json!([n, a.get(1)])).collect();
    let pushed = after.iter().any(|c| c[0] == "receive_youtube_videos");
    let closed_ok = after.iter().any(|c| c[0] == "remove_external_request" && c[1] == true);
    check("cancel", &json!({ "pushed": false, "closed_ok": false }), &json!({ "pushed": pushed, "closed_ok": closed_ok }));

    let feed = Arc::new(LiveFeed::default());
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let sink = statuses.clone();
    feed.subscribe(move |t, d| {
        if t == "_status" {
            sink.lock().push(d.clone());
        }
    });
    let runner = feed.clone();
    std::thread::spawn(move || runner.connect_once());
    std::thread::sleep(Duration::from_secs(8));
    let got = json!({ "connected": feed.is_connected(), "snapshot": feed.snapshot(), "statuses": statuses.lock().clone() });
    check("sse", &py["sse"], &got);

    assert!(diffs.is_empty(), "{} live differences", diffs.len());
}
