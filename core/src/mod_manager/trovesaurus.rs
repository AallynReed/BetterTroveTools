//! trovesaurus.py: the Trovesaurus tab (browse, install, delete).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use super::manager::{self, mods_signature, Signature};
use super::{blocklist, by_id, cached_api, ext, finish, get, js, or, spawn};
use crate::http;
use crate::py::{self, display};
use crate::modfile::ListOptions;
use crate::{Args, Resp};

const HASHES_TO_MODS: &str = "https://trovesaurus.com/api/mods-hashes-to-mods";
const PING: &str = "https://trovesaurus.com/api/ping";
const MODS_ALL: &str = "https://trovesaurus.com/api/mods-all";
const MODS_HOT: &str = "https://trovesaurus.com/api/mods-hot";
const NO_ANSWER: &str = "Trovesaurus didn't respond, it may be down or you might not have an internet connection.";
const SERVER_ISSUES: &str = "Trovesaurus is currently experiencing server issues.";

/// game path -> (signature, {mod id: {is_installed, needs_update}}).
static LOCAL_HASH_CACHE: Mutex<Option<HashMap<String, (Signature, Map<String, Value>)>>> = Mutex::new(None);

fn hash_cache_pop(game: &str) {
    if let Some(c) = LOCAL_HASH_CACHE.lock().as_mut() {
        c.remove(game);
    }
}

/// `{content hash (lowercase) -> path}` for every installed non-Workshop mod.
fn local_hash_to_path(game: &Value) -> Result<IndexMap<String, String>> {
    let mut list = manager::mod_list(game, ListOptions::default())?;
    let mut out = IndexMap::new();
    for m in list.mods.iter_mut() {
        let h = m.hash()?;
        if !h.is_empty() && !m.is_workshop {
            out.insert(h.to_lowercase(), display(&m.mod_path));
        }
    }
    Ok(out)
}

/// `{hash: mod id}` from Trovesaurus. `None` when a batch failed, so callers can tell
/// "none of these are Trovesaurus mods" from "Trovesaurus didn't answer".
fn resolve_hashes(hashes: &[&String], label: &str) -> Option<Map<String, Value>> {
    let mut resolved = Map::new();
    for batch in hashes.chunks(200) {
        let joined = batch.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",");
        let req = ext(label, HASHES_TO_MODS);
        let result = http::send_form(http::post(HASHES_TO_MODS).timeout(Duration::from_secs(10)), &[("hashes", joined.as_str())]).and_then(|resp| {
            let ok = resp.status() == 200;
            finish(req, ok);
            if !ok {
                return Ok(false);
            }
            match http::read_json(resp)? {
                Value::Object(m) => resolved.extend(m),
                other => return Err(anyhow!("cannot convert dictionary update sequence element #0 to a sequence: {}", py::type_name(&other))),
            }
            Ok(true)
        });
        match result {
            Ok(true) => {}
            Ok(false) => return None,
            Err(e) => {
                eprintln!("Failed hash batch: {}", e);
                return None;
            }
        }
    }
    Some(resolved)
}

/// Which local file (if any) is an install of Trovesaurus mod `mod_id`.
fn installed_path_for_mod(hash_to_path: &IndexMap<String, String>, mod_id: &Value) -> Option<String> {
    let target = py::str_of(mod_id);
    let keys: Vec<&String> = hash_to_path.keys().collect();
    for (local_hash, resolved_id) in resolve_hashes(&keys, "Resolving Installed Mod").unwrap_or_default() {
        if py::str_of(&resolved_id) == target {
            if let Some(path) = hash_to_path.get(&local_hash.to_lowercase()) {
                return Some(path.clone());
            }
        }
    }
    None
}

/// The newest downloadable file. Config (`extra`) uploads are skipped.
pub(super) fn latest_mod_file(mod_data: &Value) -> Result<Option<Value>> {
    let mut files = Vec::new();
    for f in super::items(or(get(mod_data, "downloads"), &Value::Null)) {
        let extra = or(f.get("extra").unwrap_or(&json!(0)), &json!(0)).clone();
        if py::int_lenient(&extra)? == 0 {
            let id = py::int_lenient(f.get("fileid").unwrap_or(&json!(0)))?;
            files.push((id, f.clone()));
        }
    }
    files.sort_by_key(|(id, _)| -id);
    Ok(files.into_iter().next().map(|(_, f)| f))
}

/// Where a download goes: over the installed copy (keeping its name and state, swapping
/// the extension when the format changed), else named after the mod.
pub(super) fn install_target(game: &Path, mod_name: &str, ext: &str, existing: Option<&str>) -> PathBuf {
    let mods_dir = game.join("mods");
    if let Some(existing) = existing {
        let mut name = py::name_of(existing);
        let disabled = name.ends_with(".disabled");
        if disabled {
            name.truncate(name.len() - ".disabled".len());
        }
        let stem = match name.rfind('.') {
            Some(i) => name[..i].to_string(),
            None => name,
        };
        return mods_dir.join(format!("{}{}{}", stem, ext, if disabled { ".disabled" } else { "" }));
    }
    let safe: String = mod_name.chars().filter(|c| c.is_alphabetic() || c.is_numeric() || " _-".contains(*c)).collect();
    let safe = py::strip(&safe);
    mods_dir.join(format!("{}{}", if safe.is_empty() { "mod" } else { safe }, ext))
}

/// `{mod id -> {is_installed, needs_update}}` for everything installed locally, cached
/// against the mods folder's signature. `force` re-checks anyway.
fn compute_installed_states(game: &Value, mods_all: &[Value], force: bool) -> Result<Map<String, Value>> {
    if !py::truthy(game) {
        return Ok(Map::new());
    }
    let key = py::str_of(game);
    let signature = mods_signature(&super::path_string(game)?);
    if !force {
        if let Some((sig, states)) = LOCAL_HASH_CACHE.lock().as_ref().and_then(|c| c.get(&key)) {
            if *sig == signature {
                return Ok(states.clone());
            }
        }
    }

    let mut states = Map::new();
    let outcome = (|| -> Result<bool> {
        let hash_to_path = local_hash_to_path(game)?;
        let mut mods_by_id = Map::new();
        for m in mods_all {
            if let Value::Object(o) = m {
                if let Some(id) = o.get("id") {
                    mods_by_id.insert(py::str_of(id), m.clone());
                }
            }
        }
        let keys: Vec<&String> = hash_to_path.keys().collect();
        // No answer: report nothing rather than caching "nothing is installed".
        let Some(resolved) = resolve_hashes(&keys, "Fetching Mod Hashes") else { return Ok(false) };
        for (local_hash, mod_id) in resolved {
            let id = py::str_of(&mod_id);
            let Some(mod_data) = mods_by_id.get(&id).filter(|d| py::truthy(d)) else { continue };
            let latest = latest_mod_file(mod_data)?.unwrap_or_else(|| json!({}));
            let latest_hash = latest.get("hash").cloned().unwrap_or(json!(""));
            let needs_update = py::truthy(&latest_hash) && py::str_of(&latest_hash).to_lowercase() != local_hash.to_lowercase();
            let state = states.entry(id).or_insert_with(|| json!({ "is_installed": true, "needs_update": needs_update }));
            // Any copy on the current release makes the mod up to date.
            if !needs_update {
                state["needs_update"] = json!(false);
            }
        }
        Ok(true)
    })();
    match outcome {
        Ok(true) => {
            LOCAL_HASH_CACHE.lock().get_or_insert_with(HashMap::new).insert(key, (signature, states.clone()));
        }
        Ok(false) => return Ok(Map::new()),
        Err(e) => eprintln!("Failed to load local mods for hash check: {}", e),
    }
    Ok(states)
}

fn get_cached(endpoint: &str, file: &str) -> Result<Value> {
    let label = format!("Fetching {} from Trovesaurus", py::title(&file.split('.').next().unwrap_or("").replace('_', " ")));
    cached_api(endpoint, file, 900.0, &label, &[("User-Agent", "TroveManager/1.0")], json!([]))
}

/// HEAD the ping endpoint. `Err(message)` when Trovesaurus is down or unreachable.
fn ping() -> std::result::Result<(), &'static str> {
    let req = ext("Pinging Trovesaurus", PING);
    match http::send(http::request("HEAD", PING).timeout(Duration::from_secs(5))) {
        Ok(resp) => {
            let status = resp.status();
            finish(req, status < 500);
            if status >= 500 {
                return Err(SERVER_ISSUES);
            }
            Ok(())
        }
        Err(_) => {
            finish(req, false);
            Err(NO_ANSWER)
        }
    }
}

fn sort_key(m: &Value, field: &str) -> Result<i64> {
    Ok(py::int_lenient(or(get(m, field), &json!(0)))?)
}

fn sorted_by(mods: &mut Vec<Value>, field: &str, descending: bool) -> Result<()> {
    let keys = mods.iter().map(|m| sort_key(m, field)).collect::<Result<Vec<_>>>()?;
    let mut paired: Vec<(i64, Value)> = keys.into_iter().map(|k| if descending { -k } else { k }).zip(mods.drain(..)).collect();
    paired.sort_by_key(|(k, _)| *k);
    mods.extend(paired.into_iter().map(|(_, m)| m));
    Ok(())
}

fn listing(a: &Args) -> Result<Value> {
    let page = a.i64_or(0, 1);
    let query = a.str_or(1, "");
    let category = a.str_or(2, "");
    let sort = match a.get(3) {
        Value::Null if a.len() <= 3 => "hot".to_string(),
        Value::String(s) => s.clone(),
        _ => "\0unsorted".to_string(),
    };
    let game = a.get(4).clone();
    let force = py::truthy(a.get(6));

    if let Err(message) = ping() {
        return Ok(json!({ "success": false, "error": message }));
    }
    let mut mods_all = get_cached(MODS_ALL, "mods_all.json")?;
    let mods_hot = get_cached(MODS_HOT, "mods_hot.json")?;
    if !py::truthy(&mods_all) {
        return Ok(json!({ "success": false, "error": NO_ANSWER }));
    }
    if let Value::Object(m) = &mods_all {
        mods_all = Value::Array(m.values().cloned().collect());
    }
    let mods_all: Vec<Value> = py::iterate(&mods_all)?;

    let blocked = blocklist::load();
    let mut filtered = Vec::new();
    for m in &mods_all {
        if !m.is_object() || blocked.blocked(m) {
            continue;
        }
        if !query.is_empty() {
            let q = query.to_lowercase();
            let name = or_s(get(m, "name")).to_lowercase();
            let id = or_s(get(m, "id"));
            let author_data = or(get(m, "author"), &Value::Null);
            let author = if author_data.is_object() { or_s(get(author_data, "Username")).to_lowercase() } else { String::new() };
            if !name.contains(&q) && !author.contains(&q) && q != id {
                continue;
            }
        }
        if !category.is_empty() {
            let c = category.to_lowercase();
            let t = or_s(get(m, "type")).to_lowercase();
            let st = or_s(get(m, "subtype")).to_lowercase();
            if !t.contains(&c) && !st.contains(&c) {
                continue;
            }
        }
        filtered.push(m.clone());
    }

    match sort.as_str() {
        "" | "hot" => {
            let mut ranks: HashMap<String, i64> = HashMap::new();
            for (idx, m) in py::iterate(&mods_hot)?.iter().enumerate() {
                if m.is_object() {
                    ranks.insert(py::str_of(get(m, "modid")), idx as i64);
                }
            }
            let likes = filtered.iter().map(|m| sort_key(m, "likes")).collect::<Result<Vec<_>>>()?;
            let mut keyed: Vec<((u8, i64, i64), Value)> = filtered
                .drain(..)
                .zip(likes)
                .map(|(m, l)| {
                    let id = py::str_of(get(&m, "id"));
                    let rank = ranks.get(&id).copied();
                    ((if rank.is_some() { 0 } else { 1 }, rank.unwrap_or(999), -l), m)
                })
                .collect();
            keyed.sort_by_key(|(k, _)| *k);
            filtered = keyed.into_iter().map(|(_, m)| m).collect();
        }
        "date_desc" => sorted_by(&mut filtered, "date", true)?,
        "date_asc" => sorted_by(&mut filtered, "date", false)?,
        "downloads_desc" => sorted_by(&mut filtered, "totaldownloads", true)?,
        "likes_desc" => sorted_by(&mut filtered, "likes", true)?,
        _ => {}
    }

    let states = compute_installed_states(&game, &mods_all, force)?;

    let per_page = 24i64;
    let max_pages = (((filtered.len() as i64) + per_page - 1) / per_page).max(1);
    let safe_page = page.min(max_pages).max(1);
    let start = ((safe_page - 1) * per_page) as usize;

    let mut result = Vec::new();
    for m in filtered.iter().skip(start).take(per_page as usize) {
        let author_data = m.get("author").cloned().unwrap_or_else(|| json!({}));
        let (author_name, author_id) = match &author_data {
            Value::Object(o) => (o.get("Username").cloned().unwrap_or(json!("Unknown")), o.get("ID").cloned().unwrap_or(json!(0))),
            _ => (json!("Unknown"), json!(0)),
        };
        let state = states.get(&py::str_of(get(m, "id")));
        let flag = |k: &str| state.map(|s| s[k].clone()).unwrap_or(json!(false));
        result.push(json!({
            "id": get(m, "id"),
            "name": m.get("name").cloned().unwrap_or(json!("Unnamed Mod")),
            "author": author_name,
            "author_id": author_id,
            "downloads": m.get("totaldownloads").cloned().unwrap_or(json!(0)),
            "likes": m.get("likes").cloned().unwrap_or(json!(0)),
            "image": m.get("image").cloned().unwrap_or(json!("")),
            "is_installed": flag("is_installed"),
            "needs_update": flag("needs_update"),
        }));
    }
    Ok(json!({ "success": true, "mods": result, "page": safe_page, "max_pages": max_pages }))
}

fn or_s(v: &Value) -> String {
    super::or_str(v)
}

pub(super) fn get_trovesaurus_mods(a: &Args) -> Result<Value> {
    let a = a.clone();
    spawn(move || {
        let token = a.get(5).clone();
        let mut payload = listing(&a).unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }));
        payload["request_token"] = token;
        js("receive_trovesaurus_mods", payload);
    });
    Ok(Value::Null)
}

fn install(game: &Value, mod_id: &Value) -> Result<std::result::Result<(), String>> {
    if !py::truthy(game) {
        return Ok(Err("No game path provided.".into()));
    }
    if let Err(message) = ping() {
        return Ok(Err(message.into()));
    }
    let mut mods_all = get_cached(MODS_ALL, "mods_all.json")?;
    if let Value::Array(entries) = &mods_all {
        mods_all = Value::Object(by_id(entries));
    } else if !py::truthy(&mods_all) {
        return Ok(Err(NO_ANSWER.into()));
    }
    let mod_data = py::dict_get(&mods_all, &py::str_of(mod_id))?.cloned().unwrap_or(Value::Null);
    if !py::truthy(&mod_data) {
        return Ok(Err("Mod no longer exists.".into()));
    }
    if blocklist::load().blocked(&mod_data) {
        return Ok(Err("This mod isn't available.".into()));
    }
    let Some(latest) = latest_mod_file(&mod_data)? else { return Ok(Err("This mod has no files uploaded.".into())) };
    let file_id = py::str_of(get(&latest, "fileid"));
    let ext_name = format!(".{}", py::str_of(latest.get("format").unwrap_or(&json!("tmod"))));

    // The file on disk is often not named after the Trovesaurus title, so the installed
    // copy is found by content hash and its exact path is taken over.
    let existing = match local_hash_to_path(game) {
        Ok(map) => installed_path_for_mod(&map, mod_id),
        Err(e) => {
            eprintln!("Couldn't resolve the installed copy of mod {}: {}", py::str_of(mod_id), e);
            None
        }
    };

    let url = format!("https://trovesaurus.com/client/downloadfile.php?fileid={}", file_id);
    let req = ext(&format!("Downloading Mod {}", py::str_of(mod_id)), &url);
    let game_path = py::path_arg(game)?;
    let outcome = (|| -> Result<std::result::Result<(), String>> {
        let (status, data) = super::download(&url, "TroveLocalModManager/1.0", 310, req)?;
        if status != 200 {
            return Ok(Err(format!("Download failed. Status: {}", status)));
        }
        let name = py::str_of(mod_data.get("name").unwrap_or(&json!("mod")));
        let out_path = install_target(&game_path, &name, &ext_name, existing.as_deref());
        if let Some(parent) = out_path.parent() {
            py::mkdir_all(parent)?;
        }
        py::write_bytes(&out_path, &data)?;
        if let Some(previous) = &existing {
            let previous = py::py_path(previous);
            if previous.exists() && !py::same_path(&previous, &out_path) {
                if let Err(e) = py::unlink(&previous) {
                    eprintln!("Couldn't remove the previous copy of mod {}: {}", py::str_of(mod_id), e);
                }
            }
        }
        hash_cache_pop(&py::str_of(game));
        Ok(Ok(()))
    })();
    Ok(outcome.unwrap_or_else(|_| Err("Failed to connect to Trovesaurus to download the mod file.".into())))
}

pub(super) fn install_trovesaurus_mod(a: &Args) -> Result<Value> {
    let (game, mod_id) = (a.get(0).clone(), a.get(1).clone());
    spawn(move || {
        let payload = match install(&game, &mod_id) {
            Ok(Ok(())) => json!({ "success": true, "mod_id": mod_id }),
            Ok(Err(error)) => json!({ "success": false, "error": error, "mod_id": mod_id }),
            Err(e) => json!({ "success": false, "error": e.to_string(), "mod_id": mod_id }),
        };
        js("receive_install_result", payload);
    });
    Ok(Value::Null)
}

pub(super) fn delete_trovesaurus_installed_mod(a: &Args) -> Result<Value> {
    Ok(super::guard("DELETE_TROVESAURUS_MOD_FAILED", || {
        if !py::truthy(a.get(0)) {
            return Ok(Resp::fail("No game path provided.", "MISSING_GAME_PATH").into());
        }
        let hash_to_path = local_hash_to_path(a.get(0))?;
        if hash_to_path.is_empty() {
            return Ok(Resp::fail("No installed mods were found.", "NO_INSTALLED_MODS").into());
        }
        let Some(matched) = installed_path_for_mod(&hash_to_path, a.get(1)) else {
            return Ok(Resp::fail("Could not find an installed file for this mod.", "INSTALLED_FILE_NOT_FOUND").into());
        };
        Ok(manager::delete_mod(a.get(0), &json!(matched)))
    }))
}

pub(super) fn open_url_in_browser(a: &Args) -> Result<Value> {
    let _ = open::that(a.str(0));
    Ok(Value::Null)
}

pub(super) fn clear_trovesaurus_cache(_: &Args) -> Result<Value> {
    Ok(super::guard("CACHE_CLEAR_FAILED", || {
        let dir = crate::paths::get_cache_root();
        let mut removed = Vec::new();
        // trovesaurus_mods_all.json is the Mod Manager's copy of the same master list.
        for name in ["mods_all.json", "mods_hot.json", "trovesaurus_mods_all.json"] {
            let path = dir.join(name);
            if path.exists() {
                py::unlink(&path)?;
                removed.push(name);
            }
        }
        *LOCAL_HASH_CACHE.lock() = None;
        Ok(Resp::ok(json!({ "removed": removed })).with("removed", json!(removed)).into())
    }))
}
