//! backend/event_notifications.py: desktop notifications for the live events the user
//! opted into. A live-feed subscriber; each occurrence is announced once, and the
//! per-event signatures persist so a reconnect snapshot stays silent across restarts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::py;
use crate::args::truthy;
use crate::{Args, Resp};

const STATE_FILENAME: &str = "event_notifications_state.json";

/// Shows (title, body).
type Deliver = Box<dyn Fn(&str, &str) + Send + Sync>;

/// What a handler makes of one event: (toggle key, dedupe signature, title, body).
pub type Notice = (String, String, String, String);

fn biomes_text(d: &Map<String, Value>) -> Option<(String, String)> {
    let current = py::dict_or_empty(py::get(d, "current")).ok()?;
    let biomes = py::get(current, "biomes");
    let mut names = Vec::new();
    for b in if truthy(biomes) { py::iterate(biomes).ok()? } else { Vec::new() } {
        let b = py::as_dict(&b).ok()?;
        let name = py::or(py::get(b, "final_name"), py::get(b, "name"));
        if truthy(name) {
            names.push(name.as_str()?.to_string());
        }
    }
    Some((names.join(", "), py::str_of_ascii(py::get(current, "starts_at"))))
}

fn notice(key: impl Into<String>, sig: String, title: &str, body: String) -> Option<Notice> {
    Some((key.into(), sig, title.to_string(), body))
}

/// Maps an event payload to its notice. `None` ignores it (as does any payload Python's
/// handler would have raised on).
pub fn handle(event_type: &str, d: &Map<String, Value>) -> Option<Notice> {
    let s = |k: &str| py::str_of_ascii(py::get(d, k));
    match event_type {
        "challenge" => {
            let raw = py::get(d, "name");
            let name = if truthy(raw) { raw.as_str()?.trim().to_string() } else { String::new() };
            let ctype = py::get(d, "type");
            if name.is_empty() || !truthy(ctype) {
                return None;
            }
            let ctype = ctype.as_str()?;
            let label = match ctype {
                "rampage" => "Rampage".to_string(),
                "racing" => "Racing".to_string(),
                "target" => "Target".to_string(),
                "collection" => "Collection".to_string(),
                "dungeon" => "Dungeon".to_string(),
                other => py::title(other),
            };
            notice(format!("challenge_{}", ctype), format!("{}:{}", s("starts_at"), name), &format!("{} Challenge", label), format!("{} is live now.", name))
        }
        "chaos" => {
            let item = py::dict_or_empty(py::get(d, "item")).ok()?;
            let name = py::get(item, "name");
            if !truthy(name) {
                return None;
            }
            let name = py::str_of_ascii(name);
            notice("chaos", format!("{}:{}", s("starts_at"), name), "Chaos Chest", format!("This week's item: {}", name))
        }
        "corruxion" => {
            if !truthy(py::get(d, "active")) {
                return None;
            }
            notice("corruxion", format!("corruxion:{}", s("starts_at")), "Merchant Corruxion", "Corruxion has arrived — spend your Dragon Coins.".into())
        }
        "fluxion" => {
            if !truthy(py::get(d, "active")) {
                return None;
            }
            let state = py::str_of_ascii(py::or(py::get(d, "state"), &json!("")));
            let body = format!("Fluxion is here ({}).", state).replace(" ().", ".");
            notice("fluxion", format!("fluxion:{}:{}", s("starts_at"), state), "Merchant Fluxion", body)
        }
        "longshade" | "wild_mana" | "stampy" => {
            let (text, starts_at) = biomes_text(d)?;
            let (title, empty) = match event_type {
                "longshade" => ("Shadow's Eve (d15) Rotation", "New biome rotation"),
                "wild_mana" => ("Wild Mana Rotation", "New biome rotation"),
                _ => ("Stampy the Dragon", "Stampy has moved on."),
            };
            let body = if text.is_empty() { empty.to_string() } else { text };
            notice(event_type, format!("{}:{}", event_type, starts_at), title, body)
        }
        "daily_bonuses" => {
            let buff = py::dict_or_empty(py::get(d, "current")).ok()?;
            let name = py::get(buff, "name");
            let normal = py::get(buff, "normal_buffs");
            let benefit = match normal {
                v if !truthy(v) => Value::Null,
                Value::Array(items) => items[0].clone(),
                Value::String(text) => json!(text.chars().next().map(String::from)),
                _ => return None,
            };
            let mut parts = Vec::new();
            for p in [name, &benefit] {
                if truthy(p) {
                    parts.push(p.as_str()?.to_string());
                }
            }
            let body = if parts.is_empty() { "A new day in Trove has begun.".to_string() } else { parts.join(" — ") };
            let sig = format!("daily:{}", py::str_of_ascii(py::or(name, py::get(buff, "weekday"))));
            notice("daily_bonuses", sig, "Daily Reset", body)
        }
        "activity" => notice(
            "activity",
            format!("activity:{}", s("window_start")),
            "Player Activity",
            "A fresh daily player-activity snapshot is available.".into(),
        ),
        "server_status" => {
            let overall = py::str_of_ascii(py::or(py::get(d, "overall"), &json!("unknown")));
            notice("server_status", format!("status:{}", overall), "Trove Servers", format!("Server status is now: {}.", overall))
        }
        "trove_news" => {
            let item = py::dict_or_empty(py::get(d, "item")).ok()?;
            let title = py::get(item, "title");
            if !truthy(title) {
                return None;
            }
            notice("trove_news", format!("news:{}", py::str_of_ascii(py::get(item, "url"))), "Trove News", py::str_of_ascii(title))
        }
        "giveaways" => {
            let newest = py::dict_or_empty(py::get(d, "newest")).ok()?;
            let title = py::get(newest, "title");
            if !truthy(title) {
                return None;
            }
            notice("giveaways", format!("giveaway:{}", py::str_of_ascii(py::get(newest, "id"))), "New Giveaway", py::str_of_ascii(title))
        }
        "game_update" => {
            let ver = py::dict_or_empty(py::get(d, "version")).ok()?;
            let tag = py::or(py::get(ver, "version_tag"), py::get(ver, "ordinal"));
            if !truthy(tag) {
                return None;
            }
            let sig = format!("update:{}:{}", py::str_of_ascii(py::get(ver, "branch")), py::str_of_ascii(py::get(ver, "ordinal")));
            notice("game_update", sig, "Game Update", format!("Trove updated to {}.", py::str_of_ascii(tag)))
        }
        _ => None,
    }
}

#[derive(Default)]
struct State {
    /// Master switch on and at least one event ticked.
    enabled: bool,
    events: HashMap<String, bool>,
    /// Toggle key → signature of the last occurrence announced.
    last_sig: Map<String, Value>,
}

pub struct EventNotifier {
    state: Mutex<State>,
    state_path: PathBuf,
    deliver: Deliver,
}

impl EventNotifier {
    pub fn new(state_path: PathBuf, deliver: impl Fn(&str, &str) + Send + Sync + 'static) -> Self {
        let last_sig = load_state(&state_path);
        EventNotifier { state: Mutex::new(State { last_sig, ..Default::default() }), state_path, deliver: Box::new(deliver) }
    }

    /// Reconciles to `settings.notifications` (`{enabled, events: {key: bool}}`). Newly
    /// ticked events announce what is live now by replaying the feed's last payloads.
    pub fn apply(&self, notifications: &Value, snapshot: impl FnOnce() -> Map<String, Value>) {
        let empty = Map::new();
        let notifications = notifications.as_object().unwrap_or(&empty);
        let events = notifications.get("events").and_then(Value::as_object).unwrap_or(&empty);
        let master = notifications.get("enabled") == Some(&Value::Bool(true));
        let stream_on = master && events.values().any(truthy);
        {
            let mut state = self.state.lock();
            state.enabled = stream_on;
            state.events = events.iter().map(|(k, v)| (k.clone(), truthy(v))).collect();
        }
        // The tray icon follows the master switch so a test balloon works right away.
        crate::notify::set_active(master);
        if stream_on {
            for (event_type, data) in snapshot() {
                self.on_event(&event_type, &data);
            }
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.state.lock().enabled
    }

    pub fn on_event(&self, event_type: &str, data: &Value) {
        if event_type == "_status" || !self.is_enabled() {
            return;
        }
        let Some((key, sig, title, body)) = data.as_object().and_then(|d| handle(event_type, d)) else { return };
        let snapshot = {
            let mut state = self.state.lock();
            if !state.events.get(&key).copied().unwrap_or(false) {
                return;
            }
            if state.last_sig.get(&key).and_then(Value::as_str) == Some(sig.as_str()) {
                return;
            }
            state.last_sig.insert(key, Value::String(sig));
            state.last_sig.clone()
        };
        save_state(&self.state_path, snapshot);
        (self.deliver)(&title, &body);
    }
}

fn load_state(path: &PathBuf) -> Map<String, Value> {
    let parsed = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    match parsed.as_ref().and_then(|v| v.get("last_sig")).and_then(Value::as_object) {
        Some(sigs) => sigs.iter().map(|(k, v)| (k.clone(), Value::String(py::str_of_ascii(v)))).collect(),
        None => Map::new(),
    }
}

fn save_state(path: &PathBuf, sigs: Map<String, Value>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, crate::json::dumps_indent(&json!({ "last_sig": sigs }), 2));
}

/// The app-wide notifier, delivering through the shared desktop notifier.
pub fn notifier() -> &'static EventNotifier {
    static NOTIFIER: OnceLock<EventNotifier> = OnceLock::new();
    NOTIFIER.get_or_init(|| {
        EventNotifier::new(crate::paths::get_cache_root().join(STATE_FILENAME), |title, body| {
            crate::notify::notify(title, body);
        })
    })
}

pub fn apply_event_notifications(a: &Args) -> Result<Value> {
    let arg = a.get(0);
    let notifications = if truthy(arg) { arg.clone() } else { json!({}) };
    let n = notifier();
    n.apply(&notifications, || super::live_feed::feed().snapshot());
    let enabled = n.is_enabled();
    Ok(Resp::ok(json!({ "enabled": enabled })).with("enabled", enabled).into())
}
