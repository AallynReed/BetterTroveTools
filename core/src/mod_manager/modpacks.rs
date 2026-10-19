//! modpacks.py: the Modpacks tab. A `.tpack` is a `.tmod` container whose inner files
//! are whole `.tmod`s named `<title>.tmod` (case kept: Trove checks it against the
//! title). Installing one quarantines same-name local mods into `mods/disabled/`,
//! writes the pack's mods and takes them off Trove.cfg's DisabledMods.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};

use super::hub::{with_headers, USER_AGENT};
use super::{ext, finish, get, js, or, spawn, to_int};
use crate::ctx::Dialog;
use crate::game::trove_cfg::{mod_key, set_mods_disabled};
use crate::http;
use crate::modfile::compat;
use crate::modfile::{format, ListOptions, ModFile, TroveMod};
use crate::{Args, Resp, KIWI_API_BASE};

const ITEMS_PER_PAGE: i64 = 24;
const VALID_SORTS: [&str; 4] = ["recent", "downloads", "new", "title"];
const MODPACK_PAGE_BASE: &str = "https://trove.aallyn.net/modpacks";

pub(super) type Entries = Vec<(String, Vec<u8>)>;

pub(super) fn pack_ref(handle: &Value, slug: &Value) -> String {
    super::hub::mod_ref(handle, slug)
}

/// `_decompile_tpack_meta`: the container's version and properties, and its inner mods
/// with their case-preserved file names.
pub(super) fn decompile_meta(data: &[u8]) -> Result<(u16, Vec<(String, String)>, Entries)> {
    let m = TroveMod::read_tmod(Path::new("modpack.tpack"), data.to_vec(), false)?;
    let names = format::raw_file_names(data)?;
    let entries = if names.len() == m.files.len() {
        names.into_iter().zip(&m.files).map(|(n, f)| Ok((n, f.data()?.to_vec()))).collect::<Result<_>>()?
    } else {
        m.files.iter().map(|f| Ok((f.trove_path.clone(), f.data()?.to_vec()))).collect::<Result<_>>()?
    };
    Ok((m.version, m.properties.iter().map(|p| (p.name.clone(), p.value.clone())).collect(), entries))
}

pub(super) fn decompile(data: &[u8]) -> Result<Entries> {
    Ok(decompile_meta(data)?.2)
}

/// `_rebuild_tpack`: no `modLoader` stamp, inner names kept as given.
pub(super) fn rebuild(version: u16, props: &[(String, String)], entries: &Entries) -> Result<Vec<u8>> {
    let mut files: Vec<ModFile> = entries
        .iter()
        .map(|(name, content)| {
            let mut f = ModFile::new(name, content.clone());
            f.trove_path = name.clone();
            f
        })
        .collect();
    let props: Vec<(&str, &str)> = props.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    crate::modfile::build_container(version, &props, &mut files)
}

/// The internal title a `.tmod` filename encodes.
pub(super) fn name_from_filename(filename: &str) -> String {
    let name = compat::name_of(filename);
    let low = name.to_lowercase();
    for ext in [".tmod.disabled", ".zip.disabled", ".tmod", ".zip"] {
        if low.ends_with(ext) && name.is_char_boundary(name.len() - ext.len()) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name
}

/// Directory components dropped (no traversal), case and spaces kept.
pub(super) fn safe_pack_filename(filename: &str) -> String {
    let base = compat::strip(&compat::name_of(filename)).to_string();
    if base.is_empty() {
        "mod.tmod".into()
    } else {
        base
    }
}

pub(super) fn unique_path(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let name = compat::file_name(dest);
    let (stem, suffix) = (compat::stem_of(&name), compat::suffix_of(&name));
    (1..).map(|i| dest.with_file_name(format!("{}_{}{}", stem, i, suffix))).find(|c| !c.exists()).unwrap()
}

/// Moves each local mod named in `names_lower` into `mods/disabled/`. The names moved.
fn quarantine_conflicts(game: &Value, names_lower: &HashSet<String>) -> Vec<String> {
    let mut moved = Vec::new();
    let list = match super::manager::mod_list(game, ListOptions::default()) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Modpack conflict scan failed: {}", e);
            return moved;
        }
    };
    let disabled_dir = list.trove_path.mods_path().join("disabled");
    for m in &list.mods {
        let name = compat::strip(m.name().unwrap_or("")).to_string();
        if name.is_empty() || !names_lower.contains(&name.to_lowercase()) || m.is_workshop {
            continue;
        }
        let res = compat::mkdir_all(&disabled_dir).and_then(|_| compat::shutil_move(&m.mod_path, &unique_path(&disabled_dir.join(compat::file_name(&m.mod_path)))));
        match res {
            Ok(_) => moved.push(name),
            Err(e) => eprintln!("Failed to quarantine conflicting mod {}: {}", name, e),
        }
    }
    moved
}

/// Takes the installed mods off Trove.cfg's DisabledMods.
fn clear_trove_disabled(game: &Value, filenames: &[String]) -> Result<()> {
    let list = super::manager::mod_list(game, ListOptions::default())?;
    let enable: Vec<String> = list
        .mods
        .iter()
        .filter(|m| !m.is_workshop && filenames.contains(&compat::file_name(&m.mod_path)))
        .map(|m| mod_key(m.name().unwrap_or(""), m.author().unwrap_or(""), false))
        .collect();
    set_mods_disabled(&enable, &[], None);
    Ok(())
}

fn fetch_modpack_detail(handle: &Value, slug: &Value) -> Option<Value> {
    let r = pack_ref(handle, slug);
    let url = format!("{}/modpacks/{}", KIWI_API_BASE, r);
    let req = ext(&format!("Fetching Modpack {}", r), &url);
    match http::send(with_headers(http::get(&url)).timeout(Duration::from_secs(15))) {
        Ok(resp) => {
            let ok = resp.status() == 200;
            finish(req, ok);
            if ok {
                match http::read_json(resp) {
                    Ok(v) => return Some(if compat::truthy(&v) { v } else { json!({}) }),
                    Err(e) => eprintln!("Modpack detail fetch failed: {}", e),
                }
            }
        }
        Err(e) => {
            finish(req, false);
            eprintln!("Modpack detail fetch failed: {}", e);
        }
    }
    None
}

fn listing(a: &Args) -> Result<Value> {
    let page = match a.get(0) {
        v if compat::truthy(v) => compat::py_int(v)?,
        _ => 1,
    }
    .max(1);
    let sort = match a.get(2) {
        Value::String(s) if VALID_SORTS.contains(&s.as_str()) => s.clone(),
        _ => "recent".to_string(),
    };
    let mut params: Vec<(&str, String)> = vec![("limit", ITEMS_PER_PAGE.to_string()), ("offset", ((page - 1) * ITEMS_PER_PAGE).to_string()), ("sort", sort)];
    if compat::truthy(a.get(1)) {
        params.push(("q", compat::py_str(a.get(1))));
    }
    let base = format!("{}/modpacks", KIWI_API_BASE);
    let req = ext("Browsing Modpacks", &base);
    let url = format!("{}?{}", base, http::urlencode(&params));
    let resp = match http::send(with_headers(http::get(&url)).timeout(Duration::from_secs(15))) {
        Ok(resp) => {
            finish(req, resp.status() == 200);
            resp
        }
        Err(_) => {
            finish(req, false);
            return Ok(json!({ "success": false, "error": "Couldn't reach the Modpacks hub. It may be down or you might be offline." }));
        }
    };
    if resp.status() != 200 {
        return Ok(json!({ "success": false, "error": format!("The modpacks hub returned HTTP {}.", resp.status()) }));
    }
    let payload = http::read_json(resp)?;
    let payload = if compat::truthy(&payload) { payload } else { json!({}) };
    let items = compat::iterate(or(get(&payload, "items"), &json!([])))?;
    let total = match get(&payload, "total") {
        v if compat::truthy(v) => compat::py_int(v)?,
        _ => items.len() as i64,
    };
    let max_pages = ((total + ITEMS_PER_PAGE - 1).div_euclid(ITEMS_PER_PAGE)).max(1);

    let mut result = Vec::new();
    for m in &items {
        if !m.is_object() {
            continue;
        }
        let (slug, handle) = (get(m, "slug"), get(m, "handle"));
        let r = pack_ref(handle, slug);
        let previews = get(m, "preview_urls");
        let first_preview = if compat::truthy(previews) { super::items(previews).first().cloned().unwrap_or(Value::Null) } else { Value::Null };
        let preview = or(get(m, "banner_url"), or(&first_preview, &json!(""))).clone();
        let page_url = match get(m, "page_url") {
            v if compat::truthy(v) => v.clone(),
            _ => json!(format!("{}/{}", MODPACK_PAGE_BASE, r)),
        };
        result.push(json!({
            "slug": slug,
            "handle": handle,
            "ref": r,
            "name": or(get(m, "title"), &json!("Unnamed Modpack")),
            "author": or(get(m, "author"), &json!("Unknown")),
            "summary": or(get(m, "summary"), &json!("")),
            "downloads": to_int(get(m, "download_count")),
            "stars": to_int(get(m, "star_count")),
            "mod_count": to_int(get(m, "mod_count")),
            "variant_count": to_int(get(m, "variant_count")),
            "default_variant": get(m, "default_variant"),
            "image": preview,
            "page_url": page_url,
            "tags": or(get(m, "tags"), &json!([])),
        }));
    }
    Ok(json!({ "success": true, "modpacks": result, "page": page.min(max_pages), "max_pages": max_pages, "total": total }))
}

pub(super) fn get_modpacks(a: &Args) -> Result<Value> {
    let a = a.clone();
    spawn(move || {
        let mut payload = listing(&a).unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }));
        payload["request_token"] = a.get(3).clone();
        js("receive_modpacks", payload);
    });
    Ok(Value::Null)
}

/// A modpack's variants, for the picker.
pub(super) fn get_modpack_variants(a: &Args) -> Result<Value> {
    let (handle, slug) = (a.get(0), a.get(1));
    let Some(detail) = fetch_modpack_detail(handle, slug) else {
        return Ok(Resp::fail("Couldn't reach the Modpacks hub to load this pack's variants.", "MODPACK_VARIANTS_FAILED").into());
    };
    let mut variants = Vec::new();
    for v in super::items(or(get(&detail, "variants"), &json!([]))) {
        if !v.is_object() {
            continue;
        }
        let mods: Vec<Value> = super::items(or(get(v, "mods"), &json!([])))
            .iter()
            .filter(|mm| mm.is_object())
            .map(|mm| json!({ "title": get(mm, "title"), "available": compat::truthy(mm.get("available").unwrap_or(&json!(true))) }))
            .collect();
        variants.push(json!({
            "name": get(v, "name"),
            "label": or(get(v, "label"), or(get(v, "name"), &json!("Default"))),
            "mod_count": to_int(get(v, "mod_count")),
            "available_count": to_int(get(v, "available_count")),
            "mods": mods,
        }));
    }
    let title = match get(&detail, "title") {
        t if compat::truthy(t) => t.clone(),
        _ => json!(pack_ref(handle, slug)),
    };
    let default_variant = get(&detail, "default_variant").clone();
    Ok(Resp::ok(json!({ "title": title, "default_variant": default_variant, "variants": variants }))
        .with("title", title)
        .with("default_variant", default_variant)
        .with("variants", variants)
        .into())
}

/// `_install_tpack_bytes`: Ok(Err(message)) for the failures the page shows.
pub(super) fn install_tpack_bytes(game: &Value, data: &[u8]) -> Result<std::result::Result<Value, String>> {
    if !compat::truthy(game) {
        return Ok(Err("No game path provided.".into()));
    }
    let entries = match decompile(data) {
        Ok(e) => e,
        Err(e) => return Ok(Err(format!("Couldn't read the modpack file: {}", e))),
    };
    if entries.is_empty() {
        return Ok(Err("The modpack contained no mods.".into()));
    }
    let installing: HashSet<String> = entries.iter().map(|(name, _)| compat::strip(&name_from_filename(name)).to_lowercase()).collect();
    let quarantined = quarantine_conflicts(game, &installing);

    let mods_dir = compat::path_arg(game)?.join("mods");
    compat::mkdir_all(&mods_dir)?;
    let mut installed = Vec::new();
    for (filename, content) in &entries {
        let out_path = compat::join(&mods_dir, &safe_pack_filename(filename));
        compat::write_bytes(&out_path, content)?;
        installed.push(compat::file_name(&out_path));
    }
    clear_trove_disabled(game, &installed)?;
    Ok(Ok(json!({ "installed": installed.len(), "files": installed, "quarantined": quarantined })))
}

/// A modpack's raw `.tpack` from the hub.
pub(super) fn download_tpack(handle: &Value, slug: &Value, variant: &Value) -> std::result::Result<Vec<u8>, String> {
    let r = pack_ref(handle, slug);
    let mut url = format!("{}/modpacks/{}/download?format=tpack", KIWI_API_BASE, r);
    if compat::truthy(variant) {
        url.push_str(&format!("&variant={}", http::quote_safe(&compat::py_str(variant), "/")));
    }
    let req = ext(&format!("Downloading Modpack {}", r), &url);
    match super::download(&url, USER_AGENT, 610, req) {
        Ok((200, data)) => Ok(data),
        Ok((status, _)) => Err(format!("Download failed. Status: {}", status)),
        Err(_) => Err("Failed to download the modpack from the hub.".into()),
    }
}

pub(super) fn install_modpack(a: &Args) -> Result<Value> {
    Ok(super::guard("MODPACK_INSTALL_FAILED", || {
        let game = a.get(0);
        if !compat::truthy(game) {
            return Ok(Resp::fail("No game path provided.", "MISSING_GAME_PATH").into());
        }
        let data = match download_tpack(a.get(1), a.get(2), a.get(3)) {
            Ok(d) => d,
            Err(e) => return Ok(Resp::fail(e, "MODPACK_DOWNLOAD_FAILED").into()),
        };
        Ok(match install_tpack_bytes(game, &data)? {
            Ok(result) => Resp::ok(result).spread().into(),
            Err(e) => Resp::fail(e, "MODPACK_INSTALL_FAILED").into(),
        })
    }))
}

/// Picks a local `.tpack` and installs it like a downloaded modpack.
pub(super) fn import_tpack_file(a: &Args) -> Result<Value> {
    Ok(super::guard("TPACK_IMPORT_FAILED", || {
        let game = a.get(0);
        if !compat::truthy(game) {
            return Ok(Resp::fail("No game path provided.", "MISSING_GAME_PATH").into());
        }
        let initial = compat::path_arg(game)?.join("mods");
        let dialog = Dialog::new("Select a .tpack modpack file").initial_dir(initial).filter("Trove Modpacks", &["tpack"]).filter("All Files", &["*"]);
        let Some(file) = pick_file(dialog) else {
            return Ok(Resp::ok(json!({ "cancelled": true })).with("cancelled", true).into());
        };
        let data = compat::read_bytes(&file)?;
        let mut payload = match install_tpack_bytes(game, &data)? {
            Ok(result) => result,
            Err(e) => return Ok(Resp::fail(e, "TPACK_IMPORT_FAILED").into()),
        };
        payload["cancelled"] = json!(false);
        payload["source"] = json!(compat::file_name(&file));
        Ok(Resp::ok(payload).spread().into())
    }))
}

#[cfg(not(test))]
fn pick_file(dialog: Dialog) -> Option<PathBuf> {
    crate::ctx::try_ctx().and_then(|c| c.host().pick_file(dialog))
}

#[cfg(test)]
fn pick_file(_: Dialog) -> Option<PathBuf> {
    super::tests::PICK.lock().clone()
}
