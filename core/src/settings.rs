//! backend/settings.py: settings.json and the movable folders.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::args::to_str;
use crate::game::executable::find_trove_executable;
use crate::game::registry::{get_trove_locations, invalidate_trove_locations_cache, TroveGamePath};
use crate::paths::*;
use crate::{Args, Cmd, Resp};

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("get_settings", |a| get_settings(a.bool_or(0, true))),
        Cmd::std("save_settings", |a| save_settings(a.get(0).clone())),
        Cmd::std("get_folder_settings", |_| Ok(Resp::ok(folders_payload()).into())),
        Cmd::std("set_data_dir", set_data_dir),
        Cmd::std("set_mod_cfgs_path", set_mod_cfgs_path),
    ]
}

const FONTS: [&str; 7] = ["system", "product-sans", "noto-sans", "inter", "roboto", "segoe-ui", "arial"];

/// Keys passed through as-is. A key missing here is silently dropped on save.
pub const ALLOWED_KEYS: [&str; 14] = [
    "accent_color",
    "show_community_content",
    "show_official_news",
    "show_player_activity",
    "auto_fix_names",
    "auto_update_mods",
    "show_mod_preview_on_info_side",
    "hide_beta_features",
    "enable_legacy_projects",
    "close_to_tray",
    "beta_builds",
    "last_game_path",
    "locale",
    "mod_cfgs_path",
];

fn is_envelope(v: &Map<String, Value>) -> bool {
    ["success", "code", "data", "error", "meta"].iter().all(|k| v.contains_key(*k))
}

/// `_normalize_settings_payload`.
pub fn normalize(payload: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(mut p) = payload.as_object() else {
        out.insert("custom_directories".into(), json!([]));
        out.insert("ui_preferences".into(), json!({}));
        out.insert("app_font".into(), json!("system"));
        out.insert("ui_scale".into(), json!(1));
        return out;
    };
    if is_envelope(p) {
        if let Some(inner) = p.get("data").and_then(Value::as_object) {
            p = inner;
        }
    }
    out.insert(
        "custom_directories".into(),
        p.get("custom_directories").filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([])),
    );
    out.insert("ui_preferences".into(), p.get("ui_preferences").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({})));
    let font = p.get("app_font").and_then(Value::as_str).filter(|f| FONTS.contains(f)).unwrap_or("system");
    out.insert("app_font".into(), json!(font));
    let scale = match p.get("ui_scale") {
        None => 1.0,
        Some(v) => crate::args::to_f64(v).unwrap_or(1.0),
    };
    out.insert("ui_scale".into(), json!(scale.clamp(0.7, 1.5)));
    for key in ALLOWED_KEYS {
        if let Some(v) = p.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(n) = p.get("notifications").filter(|v| v.is_object()) {
        out.insert("notifications".into(), n.clone());
    }
    out
}

/// Detected installs plus the user's custom directories.
pub fn all_games(settings: &Map<String, Value>) -> Vec<TroveGamePath> {
    let mut games = get_trove_locations();
    for item in settings.get("custom_directories").and_then(Value::as_array).into_iter().flatten() {
        let (path, name) = match item {
            Value::Object(o) if o.contains_key("path") => {
                let p = PathBuf::from(to_str(&o["path"]));
                let default = file_name(&p);
                let name = o.get("name").map(to_str).unwrap_or(default);
                (p, name)
            }
            Value::String(s) => {
                let p = PathBuf::from(s);
                let n = file_name(&p);
                (p, n)
            }
            _ => continue,
        };
        if !games.iter().any(|g| g.path == path) {
            games.push(TroveGamePath::custom(path, &format!("(Custom) {}", name)));
        }
    }
    games
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn get_settings_file() -> PathBuf {
    let dir = get_cache_root();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("settings.json")
}

fn games_payload(games: &[TroveGamePath]) -> Value {
    Value::Array(games.iter().map(|g| json!({ "name": g.name(), "path": display(&g.path) })).collect())
}

fn get_settings(include_games: bool) -> Result<Value> {
    let file = get_settings_file();
    if file.exists() {
        let parsed = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        if let Some(raw) = parsed {
            let mut data = normalize(&raw);
            let mut migrated = Vec::new();
            let mut changed = false;
            for item in data["custom_directories"].as_array().cloned().unwrap_or_default() {
                let item = match item {
                    Value::String(s) => {
                        changed = true;
                        json!({ "name": file_name(Path::new(&s)), "path": s })
                    }
                    other => other,
                };
                let target = item.get("path").map(to_str).unwrap_or_default();
                if find_trove_executable(Path::new(&target)).is_some() {
                    migrated.push(item);
                } else {
                    changed = true;
                }
            }
            data.insert("custom_directories".into(), Value::Array(migrated));
            if changed {
                return save_settings(Value::Object(data));
            }
            if include_games {
                data.insert("game_installs".into(), games_payload(&all_games(&data)));
            }
            let data = Value::Object(data);
            return Ok(Resp::ok(data).spread().into());
        }
    }
    let mut data = Map::new();
    data.insert("custom_directories".into(), json!([]));
    data.insert("ui_preferences".into(), json!({}));
    if include_games {
        data.insert("game_installs".into(), games_payload(&all_games(&data)));
    }
    Ok(Resp::ok(Value::Object(data)).spread().into())
}

fn custom_dirs_key(payload: &Map<String, Value>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for item in payload.get("custom_directories").and_then(Value::as_array).into_iter().flatten() {
        match item {
            Value::Object(o) => out.push((o.get("name").map(to_str).unwrap_or_default(), o.get("path").map(to_str).unwrap_or_default())),
            Value::String(s) => out.push((String::new(), s.clone())),
            _ => {}
        }
    }
    out
}

/// The normalized settings on disk, or `{}`.
pub fn read_settings_from_disk() -> Map<String, Value> {
    let file = get_settings_file();
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map(|v| normalize(&v)).unwrap_or_default()
}

/// The raw settings file (main.py `_read_settings_dict`): `{}` on any problem.
pub fn read_settings_dict() -> Map<String, Value> {
    std::fs::read_to_string(get_cache_root().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn save_settings(settings: Value) -> Result<Value> {
    let mut normalized = normalize(&settings);
    let prior = read_settings_from_disk();
    if custom_dirs_key(&prior) != custom_dirs_key(&normalized) {
        invalidate_trove_locations_cache();
    }
    let games = all_games(&normalized);
    std::fs::write(get_settings_file(), crate::json::dumps(&Value::Object(normalized.clone())))?;

    if let Some(last) = normalized.get("last_game_path").and_then(Value::as_str) {
        let last = last.trim();
        if !last.is_empty() {
            on_game_selected(last);
        }
    }
    normalized.insert("game_installs".into(), games_payload(&games));
    Ok(Resp::ok(Value::Object(normalized)).spread().into())
}

/// Moves the mods-folder watch to the newly selected install.
fn on_game_selected(_path: &str) {
    #[cfg(feature = "mod_manager")]
    crate::mod_manager::watcher_set_target(_path);
}

fn validate_folder(raw: &str) -> std::result::Result<PathBuf, Value> {
    let target = expand_user(&expand_vars(raw));
    if !target.is_absolute() {
        return Err(Resp::fail("Enter an absolute path.", "INVALID_PATH").into());
    }
    if target.exists() && !target.is_dir() {
        return Err(Resp::fail("That path is a file, not a folder.", "INVALID_PATH").into());
    }
    let probe = target.join(".btt-write-test");
    let res = std::fs::create_dir_all(&target).and_then(|_| std::fs::write(&probe, "")).and_then(|_| std::fs::remove_file(&probe));
    if let Err(e) = res {
        return Err(Resp::fail(format!("That folder isn't writable: {}", e), "NOT_WRITABLE").into());
    }
    Ok(target)
}

fn folders_payload() -> Value {
    let data_override = get_data_dir_override();
    let cfgs_override = get_mod_cfgs_override();
    json!({
        "data_dir": {
            "supported": supports_data_dir_override(),
            "current": display(&get_app_data_dir()),
            "default": display(&get_default_app_data_dir()),
            "override": data_override.map(|p| display(&p)).unwrap_or_default(),
            "from_env": std::env::var(DATA_DIR_ENV_VAR).map(|v| !v.trim().is_empty()).unwrap_or(false),
            "env_var": DATA_DIR_ENV_VAR,
            "config_file": display(&get_data_dir_override_file()),
        },
        "mod_cfgs": {
            "supported": true,
            "current": display(&get_mod_cfgs_dir()),
            "default": display(&get_default_mod_cfgs_dir()),
            "override": cfgs_override.map(|p| display(&p)).unwrap_or_default(),
        },
    })
}

fn set_data_dir(args: &Args) -> Result<Value> {
    if !supports_data_dir_override() {
        return Ok(Resp::fail("The data folder can only be changed on Linux and macOS.", "UNSUPPORTED_PLATFORM").into());
    }
    let raw = args.trimmed(0);
    if !raw.is_empty() {
        if let Err(e) = validate_folder(&raw) {
            return Ok(e);
        }
    }
    set_data_dir_override(&raw)?;
    let mut payload = folders_payload();
    payload["restart_required"] = json!(true);
    Ok(Resp::ok(payload).into())
}

fn set_mod_cfgs_path(args: &Args) -> Result<Value> {
    let mut raw = args.trimmed(0);
    if !raw.is_empty() {
        match validate_folder(&raw) {
            Ok(t) => raw = display(&t),
            Err(e) => return Ok(e),
        }
    }
    let mut stored = read_settings_from_disk();
    stored.insert("mod_cfgs_path".into(), json!(raw));
    save_settings(Value::Object(stored.clone()))?;
    if let Some(last) = stored.get("last_game_path").and_then(Value::as_str) {
        let last = last.trim();
        if !last.is_empty() {
            #[cfg(feature = "mod_manager")]
            crate::mod_manager::probe_configs(last);
        }
    }
    Ok(Resp::ok(folders_payload()).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_filters_and_clamps() {
        let n = normalize(&json!({"ui_scale": "9", "app_font": "comic", "locale": "de_DE", "junk": 1, "notifications": {"enabled": true}}));
        assert_eq!(Value::Object(n), json!({
            "custom_directories": [], "ui_preferences": {}, "app_font": "system", "ui_scale": 1.5,
            "locale": "de_DE", "notifications": {"enabled": true}
        }));
    }
}
