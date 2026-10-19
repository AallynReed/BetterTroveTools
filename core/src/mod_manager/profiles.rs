//! profiles.py: modpack `.tpack`s saved under `<app data>/Profiles` (an `index.json`
//! manifest plus `<id>.tpack`). Applying one disables the current loadout first; the
//! Mods Hub is the ground truth for updates to the mods inside.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Result};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::hub::{self, with_headers, USER_AGENT};
use super::modpacks::{decompile, decompile_meta, download_tpack, install_tpack_bytes, name_from_filename, rebuild, unique_path, Entries};
use super::{ext, finish, get, guard, or};
use crate::game::registry::{files_with_suffix, TroveGamePath};
use crate::http;
use crate::modfile::compat;
use crate::paths::get_app_data_dir;
use crate::{Args, Resp, KIWI_API_BASE};

fn profiles_dir() -> PathBuf {
    get_app_data_dir().join("Profiles")
}

fn manifest_path() -> PathBuf {
    profiles_dir().join("index.json")
}

fn profile_file(id: &Value) -> PathBuf {
    profiles_dir().join(format!("{}.tpack", compat::py_str(id)))
}

/// The manifest, rebuilt from the `.tpack`s on disk when missing or corrupt.
fn load_manifest() -> Value {
    if let Ok(m) = compat::read_json(&manifest_path()) {
        if get(&m, "profiles").is_array() {
            return m;
        }
    }
    let mut profiles = Vec::new();
    let mut known = Vec::new();
    let dir = profiles_dir();
    if dir.exists() {
        for tpack in files_with_suffix(&dir, ".tpack", false) {
            let id = compat::file_stem(&tpack);
            if known.contains(&id) {
                continue;
            }
            known.push(id.clone());
            profiles.push(json!({
                "id": id, "display_name": id, "handle": null, "slug": null, "variant": null,
                "mod_count": 0, "created_at": null, "updated_at": null,
            }));
        }
    }
    json!({ "profiles": profiles })
}

fn save_manifest(manifest: &Value) -> Result<()> {
    compat::mkdir_all(&profiles_dir())?;
    compat::write_text(&manifest_path(), &crate::json::dumps_indent(manifest, 2))
}

fn find_index(manifest: &Value, id: &Value) -> Option<usize> {
    super::items(get(manifest, "profiles")).iter().position(|e| get(e, "id") == id)
}

/// `/mods/lookup` for a batch: (results, reached the hub).
fn lookup(hashes: &[String]) -> (Map<String, Value>, bool) {
    if hashes.is_empty() {
        return (Map::new(), true);
    }
    let url = format!("{}/mods/lookup", KIWI_API_BASE);
    let req = ext("Checking Profile Mods", &url);
    match http::send_json(with_headers(http::post(&url)).timeout(Duration::from_secs(15)), &json!({ "hashes": hashes })) {
        Ok(resp) => {
            let ok = resp.status() == 200;
            finish(req, ok);
            if !ok {
                return (Map::new(), false);
            }
            match http::read_json(resp) {
                Ok(v) => (or(get(&v, "results"), &json!({})).as_object().cloned().unwrap_or_default(), true),
                Err(e) => {
                    eprintln!("Profile update lookup failed: {}", e);
                    (Map::new(), false)
                }
            }
        }
        Err(e) => {
            finish(req, false);
            eprintln!("Profile update lookup failed: {}", e);
            (Map::new(), false)
        }
    }
}

struct Update {
    name: String,
    filename: String,
    r: String,
    branch: Value,
    download_url: Value,
}

/// Which of a profile's mods have a newer Mods Hub release on their branch, and whether
/// the hub could be asked at all.
fn resolve_updates(entries: &Entries) -> (Vec<Update>, bool) {
    let mut hash_to_entry: IndexMap<String, String> = IndexMap::new();
    for (filename, content) in entries {
        hash_to_entry.entry(hex::encode(Sha256::digest(content))).or_insert_with(|| filename.clone());
    }
    let mut checked = true;
    let mut matches = Map::new();
    let all: Vec<String> = hash_to_entry.keys().cloned().collect();
    for batch in all.chunks(200) {
        let (results, ok) = lookup(batch);
        if !ok {
            checked = false;
        }
        matches.extend(results);
    }

    let mut updates = Vec::new();
    for (digest, filename) in &hash_to_entry {
        let Some(entry) = matches.get(digest).filter(|e| compat::truthy(e)) else { continue };
        let m = or(get(entry, "mod"), &json!({})).clone();
        let matched = or(get(entry, "release"), &json!({})).clone();
        let slug = get(&m, "slug");
        if !compat::truthy(slug) {
            continue;
        }
        let r = hub::mod_ref(get(&m, "handle"), slug);
        let detail = hub::fetch_mod_detail(&r, true).unwrap_or(json!({}));
        let releases = super::items(or(get(&detail, "releases"), &json!([]))).to_vec();
        if !hub::release_outdated(&matched, &releases) {
            continue;
        }
        let Some(latest) = hub::latest_release(&releases, get(&matched, "branch")) else { continue };
        if !compat::truthy(get(latest, "download_url")) {
            continue;
        }
        updates.push(Update {
            name: name_from_filename(filename),
            filename: filename.clone(),
            r,
            branch: get(&matched, "branch").clone(),
            download_url: get(latest, "download_url").clone(),
        });
    }
    (updates, checked)
}

fn download_release(url: &str, label: &str) -> Option<Vec<u8>> {
    let req = ext(&format!("Downloading {}", label), url);
    match super::download(url, USER_AGENT, 310, req) {
        Ok((200, data)) => Some(data),
        Ok(_) => None,
        Err(e) => {
            eprintln!("Profile mod download failed: {}", e);
            None
        }
    }
}

/// `sort(key=lambda p: p.get("created_at") or 0, reverse=True)`.
fn sort_newest_first(profiles: &mut Vec<Value>) -> Result<()> {
    let keys: Vec<Value> = profiles.iter().map(|p| or(get(p, "created_at"), &json!(0)).clone()).collect();
    let numeric = keys.iter().all(|k| k.is_number() || k.is_boolean());
    let textual = keys.iter().all(Value::is_string);
    if !numeric && !textual {
        let a = keys.iter().find(|k| k.is_string()).map(compat::type_name).unwrap_or("dict");
        let b = keys.iter().find(|k| !k.is_string()).map(compat::type_name).unwrap_or("int");
        return Err(anyhow!("'<' not supported between instances of '{}' and '{}'", a, b));
    }
    let mut paired: Vec<(Value, Value)> = keys.into_iter().zip(profiles.drain(..)).collect();
    paired.sort_by(|(a, _), (b, _)| {
        let ord = if numeric {
            let f = |v: &Value| v.as_f64().or_else(|| v.as_bool().map(|b| b as u8 as f64)).unwrap_or(0.0);
            f(a).partial_cmp(&f(b)).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            a.as_str().cmp(&b.as_str())
        };
        ord.reverse()
    });
    profiles.extend(paired.into_iter().map(|(_, p)| p));
    Ok(())
}

pub(super) fn list_profiles(_: &Args) -> Result<Value> {
    Ok(guard("PROFILES_LIST_FAILED", || {
        let mut profiles = super::items(get(&load_manifest(), "profiles")).to_vec();
        sort_newest_first(&mut profiles)?;
        Ok(Resp::ok(json!({ "profiles": profiles })).with("profiles", profiles).into())
    }))
}

/// Downloads a modpack's `.tpack` and saves it as a local profile.
pub(super) fn save_modpack_as_profile(a: &Args) -> Result<Value> {
    Ok(guard("PROFILE_SAVE_FAILED", || {
        let (handle, slug, variant) = (a.get(0), a.get(1), a.get(2));
        let data = match download_tpack(handle, slug, variant) {
            Ok(d) => d,
            Err(e) => return Ok(Resp::fail(e, "MODPACK_DOWNLOAD_FAILED").into()),
        };
        let entries = match decompile(&data) {
            Ok(e) => e,
            Err(e) => return Ok(Resp::fail(format!("Couldn't read the modpack file: {}", e), "TPACK_READ_FAILED").into()),
        };
        if entries.is_empty() {
            return Ok(Resp::fail("The modpack contained no mods.", "EMPTY_MODPACK").into());
        }
        let mut manifest = load_manifest();
        let id = json!(uuid::Uuid::new_v4().simple().to_string());
        let file = profile_file(&id);
        compat::mkdir_all(&profiles_dir())?;
        compat::write_bytes(&file, &data)?;

        let display_name = match a.get(3) {
            Value::String(s) => compat::strip(s).to_string(),
            v if !compat::truthy(v) => String::new(),
            other => return Err(anyhow!("'{}' object has no attribute 'strip'", compat::type_name(other))),
        };
        let name = if display_name.is_empty() { or(slug, &json!("Modpack")).clone() } else { json!(display_name) };
        let created_at = a.get(4).clone();
        let entry = json!({
            "id": id, "display_name": name, "handle": handle, "slug": slug, "variant": variant,
            "mod_count": entries.len(), "created_at": created_at, "updated_at": created_at,
        });
        if !manifest.get("profiles").is_some() {
            manifest["profiles"] = json!([]);
        }
        manifest["profiles"].as_array_mut().ok_or_else(|| anyhow!("'dict' object has no attribute 'append'"))?.push(entry.clone());
        save_manifest(&manifest)?;
        Ok(Resp::ok(json!({ "profile": entry })).with("profile", entry).into())
    }))
}

pub(super) fn rename_profile(a: &Args) -> Result<Value> {
    Ok(guard("PROFILE_RENAME_FAILED", || {
        let name = match a.get(1) {
            Value::String(s) => compat::strip(s).to_string(),
            v if !compat::truthy(v) => String::new(),
            other => return Err(anyhow!("'{}' object has no attribute 'strip'", compat::type_name(other))),
        };
        if name.is_empty() {
            return Ok(Resp::fail("A profile name is required.", "EMPTY_NAME").into());
        }
        let mut manifest = load_manifest();
        let Some(i) = find_index(&manifest, a.get(0)) else { return Ok(Resp::fail("Profile not found.", "PROFILE_NOT_FOUND").into()) };
        let entry = &mut manifest["profiles"][i];
        entry["display_name"] = json!(name);
        if !a.is_none(2) {
            entry["updated_at"] = a.get(2).clone();
        }
        let entry = entry.clone();
        save_manifest(&manifest)?;
        Ok(Resp::ok(json!({ "profile": entry })).with("profile", entry).into())
    }))
}

pub(super) fn delete_profile(a: &Args) -> Result<Value> {
    Ok(guard("PROFILE_DELETE_FAILED", || {
        let id = a.get(0);
        let mut manifest = load_manifest();
        let existed = find_index(&manifest, id).is_some();
        let kept: Vec<Value> = super::items(get(&manifest, "profiles")).iter().filter(|p| get(p, "id") != id).cloned().collect();
        manifest["profiles"] = json!(kept);
        save_manifest(&manifest)?;
        let file = profile_file(id);
        if let Err(e) = std::fs::remove_file(&file) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Failed to remove profile file {}: {}", compat::py_str(id), e);
            }
        }
        Ok(Resp::ok(json!({ "deleted": existed })).with("deleted", existed).into())
    }))
}

/// Whether any mod inside the saved profile has a newer Mods Hub release. `checked` is
/// false when the hub couldn't be reached.
pub(super) fn check_profile_updates(a: &Args) -> Result<Value> {
    Ok(guard("PROFILE_UPDATE_CHECK_FAILED", || {
        let path = profile_file(a.get(0));
        if !path.exists() {
            return Ok(Resp::fail("Profile file not found.", "PROFILE_FILE_NOT_FOUND").into());
        }
        let entries = decompile(&compat::read_bytes(&path)?)?;
        let (updates, checked) = resolve_updates(&entries);
        let public: Vec<Value> = updates.iter().map(|u| json!({ "name": u.name, "ref": u.r, "branch": u.branch })).collect();
        Ok(Resp::ok(json!({ "checked": checked, "updates": public })).with("checked", checked).with("updates", public).into())
    }))
}

/// Rebuilds the saved `.tpack` with each outdated mod's latest release. The file is only
/// overwritten once the rebuild round-trips.
pub(super) fn update_profile_file(a: &Args) -> Result<Value> {
    Ok(guard("PROFILE_UPDATE_FAILED", || {
        let path = profile_file(a.get(0));
        if !path.exists() {
            return Ok(Resp::fail("Profile file not found.", "PROFILE_FILE_NOT_FOUND").into());
        }
        let (version, props, entries) = decompile_meta(&compat::read_bytes(&path)?)?;
        let (updates, _) = resolve_updates(&entries);
        if updates.is_empty() {
            return Ok(Resp::ok(json!({ "updated": 0 })).with("updated", 0).into());
        }
        let by_filename: HashMap<&str, &Update> = updates.iter().map(|u| (u.filename.as_str(), u)).collect();
        let mut new_entries = Vec::with_capacity(entries.len());
        let mut updated = 0;
        for (filename, content) in &entries {
            if let Some(u) = by_filename.get(filename.as_str()) {
                if let Some(data) = download_release(&compat::py_str(&u.download_url), &u.name).filter(|d| !d.is_empty()) {
                    new_entries.push((filename.clone(), data));
                    updated += 1;
                    continue;
                }
            }
            new_entries.push((filename.clone(), content.clone()));
        }
        if updated == 0 {
            return Ok(Resp::fail("Couldn't download any updated mods.", "PROFILE_UPDATE_DOWNLOAD_FAILED").into());
        }
        let rebuilt = rebuild(version, &props, &new_entries)?;
        if decompile(&rebuilt)? != new_entries {
            return Ok(Resp::fail("Rebuilt modpack failed verification; the saved file was left unchanged.", "PROFILE_REBUILD_VERIFY_FAILED").into());
        }
        compat::write_bytes(&path, &rebuilt)?;

        let mut manifest = load_manifest();
        if let Some(i) = find_index(&manifest, a.get(0)) {
            let entry = &mut manifest["profiles"][i];
            entry["mod_count"] = json!(new_entries.len());
            if !a.is_none(1) {
                entry["updated_at"] = a.get(1).clone();
            }
            save_manifest(&manifest)?;
        }
        Ok(Resp::ok(json!({ "updated": updated })).with("updated", updated).into())
    }))
}

/// Moves every enabled mod at the top of `mods/` into `mods/disabled/`.
fn disable_current_loadout(game: &Value) -> Result<usize> {
    let mods_dir = TroveGamePath::new(compat::path_arg(game)?, None).mods_path();
    let disabled_dir = mods_dir.join("disabled");
    let mut moved = 0;
    for suffix in [".tmod", ".zip"] {
        for file in files_with_suffix(&mods_dir, suffix, false) {
            let res = compat::mkdir_all(&disabled_dir).and_then(|_| compat::shutil_move(&file, &unique_path(&disabled_dir.join(compat::file_name(&file)))));
            match res {
                Ok(_) => moved += 1,
                Err(e) => eprintln!("Failed to disable mod {}: {}", compat::file_name(&file), e),
            }
        }
    }
    Ok(moved)
}

/// Full switch: the current loadout off, the profile's mods on.
pub(super) fn apply_profile(a: &Args) -> Result<Value> {
    Ok(guard("PROFILE_APPLY_FAILED", || {
        let game = a.get(0);
        if !compat::truthy(game) {
            return Ok(Resp::fail("No game path provided.", "MISSING_GAME_PATH").into());
        }
        let path = profile_file(a.get(1));
        if !path.exists() {
            return Ok(Resp::fail("Profile file not found.", "PROFILE_FILE_NOT_FOUND").into());
        }
        let data = compat::read_bytes(&path)?;
        let disabled = disable_current_loadout(game)?;
        let mut payload = match install_tpack_bytes(game, &data)? {
            Ok(result) => result,
            Err(e) => return Ok(Resp::fail(e, "PROFILE_APPLY_FAILED").into()),
        };
        payload["disabled"] = json!(disabled);
        Ok(Resp::ok(payload).spread().into())
    }))
}
