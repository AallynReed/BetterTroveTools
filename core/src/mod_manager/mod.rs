//! backend/mod_manager: My Mods (mod_manager.py), the mods-folder watcher, the
//! Trovesaurus and Steam Workshop tabs, and the Mods Hub with its modpacks and profiles.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};

use crate::ctx::{try_ctx, ExternalRequest};
use crate::py::{self, get_any as get, or};
use crate::{Cmd, Resp};

mod blocklist;
mod hub;
mod manager;
mod modpacks;
mod profiles;
mod share;
mod steam_catalog;
mod trovesaurus;
mod watcher;

#[cfg(test)]
mod tests;

pub fn commands() -> Vec<Cmd> {
    let mut cmds = vec![
        Cmd::raw("set_mod_update_lock", manager::set_mod_update_lock),
        Cmd::raw("get_installed_mods", manager::get_installed_mods),
        Cmd::raw("toggle_mod", manager::toggle_mod),
        Cmd::raw("reenable_mod", manager::reenable_mod),
        Cmd::raw("set_mods_enabled", manager::set_mods_enabled),
        Cmd::raw("unsubscribe_workshop_mod", manager::unsubscribe_workshop_mod),
        Cmd::raw("delete_mod", |a| Ok(manager::delete_mod(a.get(0), a.get(1)))),
        Cmd::raw("undo_delete_mod", manager::undo_delete_mod),
        Cmd::raw("clear_mod_manager_cache", manager::clear_mod_manager_cache),
        Cmd::raw("fix_mod_names", manager::fix_mod_names),
        Cmd::raw("get_mod_urls", manager::get_mod_urls),
        Cmd::raw("check_mod_updates", manager::check_mod_updates),
        Cmd::raw("perform_mod_update", manager::perform_mod_update),
        Cmd::std("set_watched_install", watcher::set_watched_install),
        Cmd::raw("get_trovesaurus_mods", trovesaurus::get_trovesaurus_mods),
        Cmd::raw("install_trovesaurus_mod", trovesaurus::install_trovesaurus_mod),
        Cmd::raw("delete_trovesaurus_installed_mod", trovesaurus::delete_trovesaurus_installed_mod),
        Cmd::raw("open_url_in_browser", trovesaurus::open_url_in_browser),
        Cmd::raw("clear_trovesaurus_cache", trovesaurus::clear_trovesaurus_cache),
        Cmd::raw("get_steam_workshop_catalog", steam_catalog::get_steam_workshop_catalog),
        Cmd::raw("subscribe_workshop_item", steam_catalog::subscribe_workshop_item),
        Cmd::raw("create_mod_share_code", share::create_mod_share_code),
        Cmd::raw("read_mod_share_code", share::read_mod_share_code),
        Cmd::raw("install_shared_mod", share::install_shared_mod),
    ];
    if crate::MODS_HUB_ENABLED {
        cmds.extend([
            Cmd::raw("get_mods_hub_mods", hub::get_mods_hub_mods),
            Cmd::raw("install_mods_hub_mod", hub::install_mods_hub_mod),
            Cmd::raw("install_mods_hub_mod_sync", |a| Ok(hub::install_mods_hub_mod_sync(a.get(0), a.get(1), a.get(2)))),
            Cmd::raw("get_mods_hub_variants", hub::get_mods_hub_variants),
            Cmd::raw("get_mods_hub_install_states", |a| Ok(hub::get_mods_hub_install_states(a.get(0), py::truthy(a.get(1))))),
            Cmd::raw("delete_mods_hub_installed_mod", hub::delete_mods_hub_installed_mod),
            Cmd::raw("get_mods_hub_categories", hub::get_mods_hub_categories),
            Cmd::raw("clear_mods_hub_cache", hub::clear_mods_hub_cache),
            Cmd::raw("get_modpacks", modpacks::get_modpacks),
            Cmd::raw("get_modpack_variants", modpacks::get_modpack_variants),
            Cmd::raw("install_modpack", modpacks::install_modpack),
            Cmd::raw("import_tpack_file", modpacks::import_tpack_file),
            Cmd::raw("list_profiles", profiles::list_profiles),
            Cmd::raw("save_modpack_as_profile", profiles::save_modpack_as_profile),
            Cmd::raw("rename_profile", profiles::rename_profile),
            Cmd::raw("delete_profile", profiles::delete_profile),
            Cmd::raw("check_profile_updates", profiles::check_profile_updates),
            Cmd::raw("update_profile_file", profiles::update_profile_file),
            Cmd::raw("apply_profile", profiles::apply_profile),
        ]);
    }
    cmds
}

/// Points the mods-folder watcher at `game_path` (mod_watcher.watcher.set_target).
pub fn watcher_set_target(game_path: &str) {
    watcher::set_target(game_path);
}

/// Reconciles mod .cfg files for `game_path` (mod_watcher.probe_configs).
pub fn probe_configs(game_path: &str) {
    watcher::probe_configs(game_path);
}

/// main.py `probe_mods_on_launch`.
pub fn probe_mods_on_launch() {
    if let Some(install) = crate::app::active_game_install() {
        watcher::probe_configs(&install);
        watcher::set_target(&install);
    }
}

/// main.py `auto_update_mods_on_launch`.
pub fn auto_update_mods_on_launch() {
    if crate::settings::read_settings_dict().get("auto_update_mods") != Some(&Value::Bool(true)) {
        return;
    }
    let Some(install) = crate::app::active_game_install() else { return };
    if let Some(c) = try_ctx() {
        c.wait_for_page(Duration::from_secs(30));
    }
    let Ok((updated, failed)) = manager::auto_update_unlocked_mods(&install) else { return };
    if updated.is_empty() && failed.is_empty() {
        return;
    }
    js("receive_auto_mod_updates", json!({ "updated": updated, "failed": failed }));
}

/// main.py `remove_taken_down_mods_task` (runs forever, hourly).
pub fn remove_taken_down_mods_task() {
    if let Some(c) = try_ctx() {
        c.wait_for_page(Duration::from_secs(30));
    }
    loop {
        let mut installs: Vec<String> = Vec::new();
        let candidates = crate::app::active_game_install().into_iter().chain(
            crate::game::registry::get_trove_locations().into_iter().filter(|g| g.is_valid()).map(|g| py::display(&g.path)),
        );
        for install in candidates {
            if !installs.contains(&install) {
                installs.push(install);
            }
        }
        for install in &installs {
            let _ = std::panic::catch_unwind(|| hub::remove_taken_down_mods(install));
        }
        std::thread::sleep(Duration::from_secs(3600));
    }
}

// --- shared helpers ---------------------------------------------------------------------

/// Runs background tasks on the caller's thread (parity tests read their callbacks).
static INLINE_TASKS: AtomicBool = AtomicBool::new(false);

/// `gevent.spawn(task)`.
fn spawn(task: impl FnOnce() + Send + 'static) {
    if INLINE_TASKS.load(Ordering::SeqCst) {
        task();
    } else {
        std::thread::spawn(task);
    }
}

/// `eel.<name>(payload)()`.
fn js(name: &str, payload: Value) {
    if let Some(c) = try_ctx() {
        c.js(name, vec![payload]);
    }
}

/// `eel.add_external_request(label, url)()`.
fn ext(label: &str, url: &str) -> Option<ExternalRequest> {
    try_ctx().map(|c| c.external_request(label, url))
}

/// `eel.remove_external_request(id, ok)()`.
fn finish(req: Option<ExternalRequest>, ok: bool) {
    if let Some(r) = req {
        r.finish(ok);
    }
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// `try: ... except Exception as e: return resp(False, error=str(e), code=code)`.
fn guard(code: &str, body: impl FnOnce() -> Result<Value>) -> Value {
    body().unwrap_or_else(|e| Resp::fail(e.to_string(), code).into())
}

/// `str(value or "")`.
fn or_str(v: &Value) -> String {
    if py::truthy(v) {
        py::str_of(v)
    } else {
        String::new()
    }
}

/// The items of a list, nothing for anything else.
fn items(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// `_to_int`: `int(value)`, 0 when it can't be converted.
fn to_int(v: &Value) -> i64 {
    match v {
        Value::Null | Value::Array(_) | Value::Object(_) => 0,
        other => py::int_lenient(other).unwrap_or(0),
    }
}

/// `str(Path(value))`.
fn path_string(v: &Value) -> Result<String> {
    Ok(py::display(&py::path_arg(v)?))
}

/// `_get_cached_api`: `data` from `ModManagerCache/<file>` while it is younger than
/// `expiry`, else a fresh fetch, else the stale copy, else `fallback`.
fn cached_api(endpoint: &str, cache_filename: &str, expiry: f64, label: &str, headers: &[(&str, &str)], fallback: Value) -> Result<Value> {
    let cache_dir = crate::paths::get_cache_root();
    py::mkdir_all(&cache_dir)?;
    let cache_file = cache_dir.join(cache_filename);

    if cache_file.exists() {
        let text = py::read_text(&cache_file)?;
        if let Ok(wrapper) = serde_json::from_str::<Value>(&text) {
            if let Value::Object(w) = &wrapper {
                let ts = match w.get("timestamp") {
                    None => 0.0,
                    Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
                    Some(Value::Bool(b)) => *b as u8 as f64,
                    Some(other) => return Err(anyhow!("unsupported operand type(s) for -: 'float' and '{}'", py::type_name(other))),
                };
                if now() - ts < expiry {
                    return Ok(w.get("data").cloned().unwrap_or(Value::Null));
                }
            }
        }
    }

    let req = ext(label, endpoint);
    let mut request = crate::http::get(endpoint).timeout(Duration::from_secs(15));
    for (k, v) in headers {
        request = request.set(k, v);
    }
    match crate::http::send(request) {
        Ok(resp) => {
            let ok = resp.status() == 200;
            finish(req, ok);
            if ok {
                let stored = crate::http::read_json(resp).and_then(|data| {
                    let wrapper = json!({ "timestamp": now(), "data": data });
                    py::write_text(&cache_file, &crate::json::dumps(&wrapper))?;
                    Ok(wrapper["data"].clone())
                });
                match stored {
                    Ok(data) => return Ok(data),
                    Err(e) => eprintln!("Failed to fetch {}: {}", endpoint, e),
                }
            }
        }
        Err(e) => {
            finish(req, false);
            eprintln!("Failed to fetch {}: {}", endpoint, e);
        }
    }

    if cache_file.exists() {
        if let Ok(cached) = serde_json::from_str::<Value>(&py::read_text(&cache_file)?) {
            return Ok(match cached {
                Value::Object(mut m) if m.contains_key("data") => m.remove("data").unwrap_or(Value::Null),
                other => other,
            });
        }
    }
    Ok(fallback)
}

/// `{str(m.get("id")): m for m in items if isinstance(m, dict)}`.
fn by_id(items: &[Value]) -> Map<String, Value> {
    let mut out = Map::new();
    for m in items {
        if m.is_object() {
            out.insert(py::str_of(get(m, "id")), m.clone());
        }
    }
    out
}

/// `requests.get(url, headers={"User-Agent": ua}, timeout=(10, read))`: the status and
/// the whole body, the request logged done once the body is in (as requests read it).
fn download(url: &str, user_agent: &str, timeout_secs: u64, req: Option<ExternalRequest>) -> Result<(u16, Vec<u8>)> {
    let resp = crate::http::send(crate::http::get(url).set("User-Agent", user_agent).timeout(Duration::from_secs(timeout_secs)))?;
    let status = resp.status();
    let data = crate::http::read_bytes(resp, u64::MAX)?;
    finish(req, status == 200);
    Ok((status, data))
}
