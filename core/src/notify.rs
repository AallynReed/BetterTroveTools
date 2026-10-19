//! backend/desktop_notifications.py: native notifications, with persisted show-once keys.

use anyhow::Result;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::paths::get_cache_root;
use crate::{Args, Cmd, Resp};

const STATE_FILENAME: &str = "desktop_notifications.json";

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("desktop_notifications_available", |_| {
            let available = available();
            Ok(Resp::ok(json!({ "available": available })).with("available", available).into())
        }),
        Cmd::std("notify_desktop", notify_desktop),
        Cmd::std("reset_desktop_notification", |a| {
            let key = a.opt_str(0).filter(|k| !k.is_empty());
            reset(key.as_deref());
            Ok(Resp::ok(json!({ "reset": key.unwrap_or_else(|| "all".into()) })).into())
        }),
    ]
}

static SHOWN: Mutex<Option<Map<String, Value>>> = Mutex::new(None);

fn load(shown: &mut Option<Map<String, Value>>) -> &mut Map<String, Value> {
    shown.get_or_insert_with(|| {
        std::fs::read_to_string(get_cache_root().join(STATE_FILENAME))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("shown").and_then(Value::as_object).cloned())
            .unwrap_or_default()
    })
}

fn save(shown: &Map<String, Value>) {
    let dir = get_cache_root();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(STATE_FILENAME), crate::json::dumps_indent(&json!({ "shown": shown }), 2));
}

/// Whether notifications can be delivered here.
pub fn available() -> bool {
    crate::ctx::try_ctx().map(|c| c.host().notifications_available()).unwrap_or(false)
}

/// Shows a notification now. True if it was delivered.
pub fn notify(title: &str, message: &str) -> bool {
    match crate::ctx::try_ctx() {
        Some(c) => c.host().notify(title, message),
        None => false,
    }
}

pub fn has_shown(key: &str) -> bool {
    load(&mut SHOWN.lock()).contains_key(key)
}

/// Shows it only if `key` was never shown before; the key is recorded only on delivery.
pub fn notify_once(key: &str, title: &str, message: &str) -> bool {
    if key.is_empty() {
        return notify(title, message);
    }
    if has_shown(key) {
        return false;
    }
    let delivered = notify(title, message);
    if delivered {
        let mut guard = SHOWN.lock();
        let shown = load(&mut guard);
        shown.insert(key.to_string(), json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false)));
        save(shown);
    }
    delivered
}

/// Forgets one key, or all of them.
pub fn reset(key: Option<&str>) {
    let mut guard = SHOWN.lock();
    let shown = load(&mut guard);
    match key {
        None => shown.clear(),
        Some(k) => {
            shown.remove(k);
        }
    }
    save(shown);
}

/// Reminders turned on/off: keep the tray icon present while they are on.
pub fn set_active(active: bool) {
    if let Some(c) = crate::ctx::try_ctx() {
        c.host().set_reminders_active(active);
    }
}

fn notify_desktop(args: &Args) -> Result<Value> {
    let title = args.str(0);
    let message = args.str(1);
    let key = args.str(2);
    let shown = if args.bool_or(3, false) { notify_once(&key, &title, &message) } else { notify(&title, &message) };
    Ok(Resp::ok(json!({ "shown": shown })).with("shown", shown).into())
}
