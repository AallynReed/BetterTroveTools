//! mod_manager.py: the My Mods tab.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Result};
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Map, Value};

use super::{blocklist, ext, finish, get, guard, hub, path_string};
use crate::game::registry::TroveGamePath;
use crate::game::trove_cfg::{ensure_mods_enabled, mod_key, read_disabled_mods, set_mods_disabled};
use crate::modder_tools::steam_workshop::{self, SteamError};
use crate::py::{self, display, file_name, PyOsError};
use crate::modfile::{FileExistsError, ListOptions, TroveMod, TroveModList};
use crate::paths::{get_app_data_dir, get_cache_root};
use crate::{Args, Resp};

pub(super) fn cache_root() -> Result<PathBuf> {
    let root = get_cache_root();
    py::mkdir_all(&root)?;
    Ok(root)
}

pub(super) fn trove_game(game: &Value) -> Result<TroveGamePath> {
    Ok(TroveGamePath::new(py::path_arg(game)?, None))
}

/// `TroveModList(path=TroveGamePath(Path(game)), partial=True, ...)`.
pub(super) fn mod_list(game: &Value, opts: ListOptions) -> Result<TroveModList> {
    TroveModList::new(trove_game(game)?, ListOptions { partial: true, ..opts })
}

pub(super) type Signature = Vec<(String, u64, u128)>;

fn mtime_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0)
}

/// `mods_signature`: path, size and mtime of every file in the mods folder (and the
/// Workshop folder). The folder's own mtime is not used: an in-place update leaves it
/// untouched on Windows.
pub(super) fn mods_signature(game: &str) -> Signature {
    let tp = TroveGamePath::new(py::py_path(game), None);
    let mut sources = vec![(tp.mods_path(), false)];
    if let Some(ws) = tp.workshop_path() {
        sources.push((ws, true));
    }
    let mut entries = Vec::new();
    for (dir, recursive) in sources {
        let paths: Vec<PathBuf> = if recursive {
            py::Rglob::new(&dir).collect()
        } else {
            match std::fs::read_dir(&dir) {
                Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
                Err(_) => continue,
            }
        };
        for p in paths {
            if let Ok(meta) = std::fs::metadata(&p) {
                if meta.is_file() {
                    entries.push((display(&p), meta.len(), mtime_ns(&meta)));
                }
            }
        }
    }
    entries.sort();
    entries
}

// --- trash -------------------------------------------------------------------------------

fn trash_manifest_path() -> Result<PathBuf> {
    let dir = cache_root()?.join("trash");
    py::mkdir_all(&dir)?;
    Ok(dir.join("deletions.json"))
}

fn read_trash_manifest() -> Result<Map<String, Value>> {
    let path = trash_manifest_path()?;
    Ok(py::read_json(&path).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default())
}

fn write_trash_manifest(manifest: &Map<String, Value>) -> Result<()> {
    py::write_text(&trash_manifest_path()?, &crate::json::dumps_indent(&Value::Object(manifest.clone()), 2))
}

// --- update locks --------------------------------------------------------------------------
// A locked mod is pinned: nothing offers or installs an update for it. Kept in app data,
// so "Clear Cache" never drops the user's pins.

fn locks_path() -> PathBuf {
    get_app_data_dir().join("mod_locks.json")
}

/// The file name minus `.disabled`, lowercased: toggling renames in place.
pub(super) fn lock_key(mod_path: &str) -> String {
    let mut name = py::name_of(mod_path);
    if name.to_lowercase().ends_with(".disabled") && name.len() >= 9 && name.is_char_boundary(name.len() - 9) {
        name.truncate(name.len() - 9);
    }
    name.to_lowercase()
}

fn lock_key_arg(v: &Value) -> Result<String> {
    Ok(lock_key(&path_string(v)?))
}

fn install_key(game: &Value) -> Result<String> {
    Ok(path_string(game)?.to_lowercase())
}

fn read_locks() -> Map<String, Value> {
    py::read_json(&locks_path()).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn write_locks(data: &Map<String, Value>) -> Result<()> {
    let path = locks_path();
    if let Some(parent) = path.parent() {
        py::mkdir_all(parent)?;
    }
    py::write_text(&path, &crate::json::dumps_indent(&Value::Object(data.clone()), 2))
}

pub(super) fn locked_keys(game: &Value) -> Result<HashSet<String>> {
    let install = install_key(game)?;
    Ok(match read_locks().get(&install) {
        Some(Value::Array(keys)) => keys.iter().map(|k| py::str_of(k).to_lowercase()).collect(),
        _ => HashSet::new(),
    })
}

pub(super) fn set_mod_update_lock(a: &Args) -> Result<Value> {
    Ok(guard("LOCK_FAILED", || {
        let mut data = read_locks();
        let install = install_key(a.get(0))?;
        let mut keys = locked_keys(a.get(0))?;
        let locked = py::truthy(a.get(2));
        let key = lock_key_arg(a.get(1))?;
        if locked {
            keys.insert(key);
        } else {
            keys.remove(&key);
        }
        if keys.is_empty() {
            data.shift_remove(&install);
        } else {
            let mut sorted: Vec<String> = keys.into_iter().collect();
            sorted.sort();
            data.insert(install, json!(sorted));
        }
        write_locks(&data)?;
        Ok(Resp::ok(json!({ "locked": locked })).with("locked", locked).into())
    }))
}

// --- Trove.cfg DisabledMods ------------------------------------------------------------------
// The game keeps its own off-list: mods switched off in game, and the losers when it
// resolves a conflict. A listed mod with an enabled file is "disabled by Trove".

fn trove_key(m: &TroveMod) -> String {
    mod_key(m.name().unwrap_or(""), m.author().unwrap_or(""), m.is_workshop)
}

fn disabled_by_trove(m: &TroveMod, trove_disabled: &HashSet<String>) -> bool {
    m.enabled && trove_disabled.contains(&trove_key(m))
}

pub(super) fn is_on(m: &TroveMod, trove_disabled: &HashSet<String>) -> bool {
    m.enabled && !trove_disabled.contains(&trove_key(m))
}

/// Enabling clears both the `.disabled` suffix and the DisabledMods entry. Disabling
/// renames local mods but lists Workshop ones, since Steam owns those files.
fn set_mod_enabled(m: &mut TroveMod, enabled: bool, trove_disabled: &HashSet<String>) -> Result<()> {
    let key = trove_key(m);
    if enabled {
        if !m.enabled {
            m.toggle()?;
        }
        if trove_disabled.contains(&key) {
            set_mods_disabled(&[key], &[], None);
        }
    } else if m.is_workshop {
        set_mods_disabled(&[], &[key], None);
    } else if m.enabled {
        m.toggle()?;
    }
    Ok(())
}

fn toggle_result(m: &TroveMod) -> Value {
    let trove_disabled = read_disabled_mods(None);
    let state = json!({
        "new_path": display(&m.mod_path),
        "status": if is_on(m, &trove_disabled) { "enabled" } else { "disabled" },
        "disabled_by_trove": disabled_by_trove(m, &trove_disabled),
    });
    Resp::ok(state).spread().into()
}

pub(super) fn get_installed_mods(a: &Args) -> Result<Value> {
    Ok(guard("INSTALLED_MODS_FAILED", || {
        ensure_mods_enabled(None);
        let opts = ListOptions { fix_names: py::truthy(a.get(1)), fix_configs: py::truthy(a.get(2)), ..Default::default() };
        let list = mod_list(a.get(0), opts)?;
        let locked = locked_keys(a.get(0))?;
        let trove_disabled = read_disabled_mods(None);

        let mut result_mods = Vec::with_capacity(list.mods.len());
        for (i, m) in list.mods.iter().enumerate() {
            let path = display(&m.mod_path);
            let conflicts: Vec<Value> = list.conflicts_of(i).into_iter().map(|c| json!({ "name": c.name(), "enabled": is_on(c, &trove_disabled) })).collect();
            result_mods.push(json!({
                "name": m.name().filter(|n| !n.is_empty()).unwrap_or("Unknown Mod"),
                "author": m.author().filter(|n| !n.is_empty()).unwrap_or("Unknown Author"),
                "version": m.mod_version(),
                "status": if is_on(m, &trove_disabled) { "enabled" } else { "disabled" },
                "disabled_by_trove": disabled_by_trove(m, &trove_disabled),
                "path": path,
                "workshop": m.is_workshop,
                "locked": locked.contains(&lock_key(&path)),
                "image": m.image().unwrap_or_else(|_| crate::modfile::no_preview_image()),
                "has_conflicts": m.has_conflicts(),
                "conflicts_with": conflicts,
            }));
        }
        let cache_file = cache_root()?.join("installed_mods.json");
        py::write_bytes(&cache_file, crate::json::dumps(&json!({ "mods": result_mods })).as_bytes())?;

        let cached = "/api/cache/installed_mods.json";
        let unreadable: Vec<Value> = list.unreadable.iter().map(|(p, e)| json!({ "file": file_name(p), "error": e })).collect();
        Ok(Resp::ok(json!({ "cached_file": cached, "read_only_configs": list.read_only_configs, "unreadable": unreadable }))
            .with("cached_file", cached)
            .with("read_only_configs", list.read_only_configs.clone())
            .with("unreadable", unreadable)
            .into())
    }))
}

fn is_file_exists(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.is::<FileExistsError>()
            || c.downcast_ref::<PyOsError>().map(|p| p.kind == std::io::ErrorKind::AlreadyExists).unwrap_or(false)
            || c.downcast_ref::<std::io::Error>().map(|io| io.kind() == std::io::ErrorKind::AlreadyExists).unwrap_or(false)
    })
}

fn toggle_guard(body: impl FnOnce() -> Result<Value>) -> Value {
    body().unwrap_or_else(|e| {
        if is_file_exists(&e) {
            Resp::fail("A file with the toggled name already exists.", "TOGGLE_COLLISION").into()
        } else {
            Resp::fail(e.to_string(), "TOGGLE_FAILED").into()
        }
    })
}

fn not_found() -> Value {
    Resp::fail("Could not locate the mod in the parsed list.", "MOD_NOT_FOUND").into()
}

fn find_mod(list: &TroveModList, mod_path: &Value) -> Option<usize> {
    let wanted = mod_path.as_str()?;
    list.mods.iter().position(|m| display(&m.mod_path) == wanted)
}

pub(super) fn toggle_mod(a: &Args) -> Result<Value> {
    Ok(toggle_guard(|| {
        let mut list = mod_list(a.get(0), ListOptions::default())?;
        let Some(i) = find_mod(&list, a.get(1)) else { return Ok(not_found()) };
        let trove_disabled = read_disabled_mods(None);
        let on = is_on(&list.mods[i], &trove_disabled);
        set_mod_enabled(&mut list.mods[i], !on, &trove_disabled)?;
        Ok(toggle_result(&list.mods[i]))
    }))
}

/// Turns a mod back on and switches off every enabled mod it conflicts with: Trove
/// keeps only one of a conflicting set at launch.
pub(super) fn reenable_mod(a: &Args) -> Result<Value> {
    Ok(toggle_guard(|| {
        let mut list = mod_list(a.get(0), ListOptions::default())?;
        let Some(i) = find_mod(&list, a.get(1)) else { return Ok(not_found()) };
        let trove_disabled = read_disabled_mods(None);
        let mut others: Vec<usize> = Vec::new();
        for j in list.mods[i].conflicts() {
            if !others.contains(&j) {
                others.push(j);
            }
        }
        for j in others {
            if is_on(&list.mods[j], &trove_disabled) {
                set_mod_enabled(&mut list.mods[j], false, &trove_disabled)?;
            }
        }
        set_mod_enabled(&mut list.mods[i], true, &trove_disabled)?;
        Ok(toggle_result(&list.mods[i]))
    }))
}

/// Unsubscribes from a Steam Workshop mod and removes its item folder.
pub(super) fn unsubscribe_workshop_mod(a: &Args) -> Result<Value> {
    Ok(guard("UNSUBSCRIBE_FAILED", || {
        let tp = trove_game(a.get(0))?;
        let workshop = tp.workshop_path();
        let mod_path = py::resolve(&py::path_arg(a.get(1))?);
        let Some(workshop) = workshop.filter(|_| tp.is_workshop_file(&mod_path)) else {
            return Ok(Resp::fail("Not a Steam Workshop mod.", "NOT_WORKSHOP").into());
        };
        let root = py::resolve(&workshop);
        let first = py::relative_parts(&mod_path, &root).and_then(|p| p.into_iter().next()).ok_or_else(|| anyhow!("tuple index out of range"))?;
        let item = root.join(&first);
        if !item.is_dir() || !py::isdigit(&first) {
            return Ok(Resp::fail("Not a Steam Workshop item folder.", "NOT_WORKSHOP").into());
        }
        match steam_workshop::unsubscribe_item(&first) {
            Err(e) if e.is::<SteamError>() => return Ok(Resp::fail(e.to_string(), "STEAM_UNAVAILABLE").into()),
            Err(e) => return Err(e),
            Ok(false) => return Ok(Resp::fail("Steam did not unsubscribe this account from the item.", "UNSUBSCRIBE_REFUSED").into()),
            Ok(true) => {}
        }
        let _ = std::fs::remove_dir_all(&item);
        Ok(Resp::ok(json!({ "item_id": first })).into())
    }))
}

pub(super) fn delete_mod(game: &Value, mod_path: &Value) -> Value {
    guard("DELETE_FAILED", || {
        let tp = trove_game(game)?;
        let mods_dir = py::resolve(&tp.path.join("mods"));
        let mod_path = py::resolve(&py::path_arg(mod_path)?);

        if tp.is_workshop_file(&mod_path) {
            return Ok(Resp::fail("Steam Workshop mods are removed by unsubscribing in Steam.", "WORKSHOP_MOD").into());
        }
        if !display(&mod_path).to_lowercase().starts_with(&display(&mods_dir).to_lowercase()) {
            return Ok(Resp::fail("Refusing to delete file outside mods directory.", "INVALID_PATH").into());
        }
        if !mod_path.exists() {
            return Ok(Resp::fail("Mod file does not exist.", "MISSING_FILE").into());
        }
        if !mod_path.is_file() {
            return Ok(Resp::fail("Target path is not a file.", "NOT_A_FILE").into());
        }

        let trash_dir = cache_root()?.join("trash");
        py::mkdir_all(&trash_dir)?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let trash_path = trash_dir.join(format!("{}_{}_{}", super::now() as i64, token, file_name(&mod_path)));
        py::shutil_move(&mod_path, &trash_path)?;

        let (original, trashed) = (display(&mod_path), display(&trash_path));
        let mut manifest = read_trash_manifest()?;
        manifest.insert(token.clone(), json!({ "original_path": original, "trash_path": trashed }));
        write_trash_manifest(&manifest)?;

        Ok(Resp::ok(json!({ "undo_token": token, "original_path": original, "trash_path": trashed })).spread().into())
    })
}

pub(super) fn undo_delete_mod(a: &Args) -> Result<Value> {
    Ok(guard("UNDO_FAILED", || {
        let token = py::str_of(a.get(0));
        let mut manifest = read_trash_manifest()?;
        let info = manifest.get(&token).cloned().unwrap_or(Value::Null);
        if !py::truthy(&info) {
            return Ok(Resp::fail("Undo token not found or expired.", "UNDO_TOKEN_NOT_FOUND").into());
        }
        let field = |k: &str| -> Result<PathBuf> { Ok(py::path_arg(info.get(k).ok_or_else(|| anyhow!("{}", py::repr_str(k)))?)?) };
        let original = field("original_path")?;
        let trash = field("trash_path")?;

        if !trash.exists() {
            manifest.shift_remove(&token);
            write_trash_manifest(&manifest)?;
            return Ok(Resp::fail("Deleted file can no longer be restored.", "UNDO_SOURCE_MISSING").into());
        }
        if let Some(parent) = original.parent() {
            py::mkdir_all(parent)?;
        }
        if original.exists() {
            return Ok(Resp::fail("Cannot restore because a file already exists at the original path.", "UNDO_CONFLICT").into());
        }
        py::shutil_move(&trash, &original)?;
        manifest.shift_remove(&token);
        write_trash_manifest(&manifest)?;
        let restored = display(&original);
        Ok(Resp::ok(json!({ "restored_path": restored })).with("restored_path", restored).into())
    }))
}

pub(super) fn clear_mod_manager_cache(_: &Args) -> Result<Value> {
    Ok(guard("CACHE_CLEAR_FAILED", || {
        let dir = cache_root()?;
        let mut removed = Vec::new();
        for name in ["installed_mods.json", "trovesaurus_mods_all.json"] {
            let path = dir.join(name);
            if path.exists() {
                py::unlink(&path)?;
                removed.push(name);
            }
        }
        Ok(Resp::ok(json!({ "removed": removed })).with("removed", json!(removed)).into())
    }))
}

pub(super) fn fix_mod_names(a: &Args) -> Result<Value> {
    Ok(guard("FIX_NAMES_FAILED", || {
        let mut list = mod_list(a.get(0), ListOptions::default())?;
        let mut fixed = 0;
        for m in list.mods.iter_mut() {
            if m.has_wrong_name() && !m.is_workshop {
                m.fix_name()?;
                fixed += 1;
            }
        }
        Ok(Resp::ok(json!({ "fixed_count": fixed })).with("fixed_count", fixed).into())
    }))
}

/// Installed paths the Mods Hub already owns (empty with the hub off).
fn hub_claimed(game: &Value) -> HashSet<String> {
    if !crate::MODS_HUB_ENABLED {
        return HashSet::new();
    }
    hub::hub_claimed_paths(game, false)
}

const HASHES_TO_MODS: &str = "https://trovesaurus.com/api/mods-hashes-to-mods";

pub(super) fn get_mod_urls(a: &Args) -> Result<Value> {
    Ok(guard("MOD_URLS_FAILED", || {
        let mut list = mod_list(a.get(0), ListOptions::default())?;
        // Hub mods are resolved by the hub, so they stay out of the batch.
        let claimed = hub_claimed(a.get(0));
        let mut hash_to_path: IndexMap<String, String> = IndexMap::new();
        for m in list.mods.iter_mut() {
            let h = m.hash()?;
            let path = display(&m.mod_path);
            if !h.is_empty() && !m.is_workshop && !claimed.contains(&path) {
                hash_to_path.insert(h.to_lowercase(), path);
            }
        }
        if hash_to_path.is_empty() {
            return Ok(Resp::ok(json!({ "urls": {} })).with("urls", json!({})).into());
        }

        let mut found: IndexMap<String, (String, Value)> = IndexMap::new();
        let hashes: Vec<&String> = hash_to_path.keys().collect();
        for batch in hashes.chunks(200) {
            let joined = batch.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",");
            let req = ext("Fetching Mod Hashes", HASHES_TO_MODS);
            let outcome = crate::http::send_form(crate::http::post(HASHES_TO_MODS).timeout(Duration::from_secs(10)), &[("hashes", joined.as_str())]);
            let result = outcome.and_then(|resp| {
                let ok = resp.status() == 200;
                finish(req, ok);
                if !ok {
                    return Ok(());
                }
                let Value::Object(results) = crate::http::read_json(resp)? else { return Err(anyhow!("'list' object has no attribute 'items'")) };
                for (h, mod_id) in results {
                    if let Some(path) = hash_to_path.get(&h.to_lowercase()) {
                        found.insert(path.clone(), (h, mod_id));
                    }
                }
                Ok(())
            });
            if let Err(e) = result {
                eprintln!("Failed hash batch: {}", e);
            }
        }

        let mut urls = Map::new();
        if !found.is_empty() {
            let blocked = blocklist::load();
            let mut mods_all = list.get_cached_mods_all(false)?;
            if let Value::Array(entries) = &mods_all {
                mods_all = Value::Object(super::by_id(entries));
            }
            for (path, (h, mod_id)) in found {
                let entry = match &mods_all {
                    v if !py::truthy(v) => None,
                    Value::Object(m) => m.get(&py::str_of(&mod_id)).filter(|e| py::truthy(e)).cloned(),
                    other => return Err(anyhow!("'{}' object has no attribute 'get'", py::type_name(other))),
                };
                let entry = entry.unwrap_or_else(|| json!({ "id": mod_id, "downloads": [{ "hash": h }] }));
                if !blocked.blocked(&entry) {
                    urls.insert(path, json!(format!("https://trovesaurus.com/mod={}", py::str_of(&mod_id))));
                }
            }
        }
        let urls = Value::Object(urls);
        Ok(Resp::ok(json!({ "urls": urls })).with("urls", urls).into())
    }))
}

fn html_res() -> &'static [Regex; 3] {
    static RES: OnceLock<[Regex; 3]> = OnceLock::new();
    RES.get_or_init(|| {
        [
            Regex::new(r"(?i)<br\s*/?>|</(?:p|div|li|h\d)>").unwrap(),
            Regex::new(r"(?i)<li[^>]*>").unwrap(),
            Regex::new(r"<[^>]+>").unwrap(),
        ]
    })
}

/// `_html_to_text`: Trovesaurus change notes are HTML; the UI shows plain text.
pub(super) fn html_to_text(value: &str) -> String {
    let [breaks, items, tags] = html_res();
    let text = breaks.replace_all(value, "\n");
    let text = items.replace_all(&text, "\u{2022} ");
    let text = tags.replace_all(&text, "");
    let text = unescape(&text);
    py::splitlines(&text)
        .into_iter()
        .map(|line| line.split(py::is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The names `html.unescape` also accepts without a semicolon.
const LEGACY_ENTITIES: &str = "AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc \
    Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig \
    agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute \
    icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn \
    pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml";

/// `&#128;`..`&#159;` read as Windows-1252, as browsers do.
const CP1252: [u32; 32] = [
    0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019,
    0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

fn named_entity(name: &str) -> Option<String> {
    let entity = format!("&{};", name.trim_end_matches(';'));
    let decoded = html_escape::decode_html_entities(&entity);
    (decoded != entity).then(|| decoded.into_owned())
}

fn charref(s: &str) -> String {
    if let Some(num) = s.strip_prefix('#') {
        let (digits, radix) = match num.strip_prefix(['x', 'X']) {
            Some(hex) => (hex, 16),
            None => (num, 10),
        };
        let n = u32::from_str_radix(digits.trim_end_matches(';'), radix).unwrap_or(u32::MAX);
        let invalid = matches!(n, 0x1..=0x8 | 0xb | 0xe..=0x1f | 0x7f..=0x9f | 0xfdd0..=0xfdef) || (n & 0xfffe == 0xfffe && n <= 0x10ffff);
        return match n {
            0 => "\u{fffd}".into(),
            0xd => "\r".into(),
            0x80..=0x9f => char::from_u32(CP1252[(n - 0x80) as usize]).map(String::from).unwrap_or_default(),
            0xd800..=0xdfff | 0x110000.. => "\u{fffd}".into(),
            _ if invalid => String::new(),
            _ => char::from_u32(n).map(String::from).unwrap_or_default(),
        };
    }
    let legacy = |name: &str| LEGACY_ENTITIES.split_whitespace().any(|l| l == name);
    if s.ends_with(';') || legacy(s) {
        if let Some(decoded) = named_entity(s) {
            return decoded;
        }
    }
    let bounds: Vec<usize> = s.char_indices().map(|(i, _)| i).skip(2).collect();
    for &x in bounds.iter().rev() {
        if legacy(&s[..x]) {
            return format!("{}{}", named_entity(&s[..x]).unwrap_or_default(), &s[x..]);
        }
    }
    format!("&{}", s)
}

/// `html.unescape`.
fn unescape(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    if !s.contains('&') {
        return s.to_string();
    }
    let re = RE.get_or_init(|| Regex::new(r"&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\x0c <&#;]{1,32};?)").unwrap());
    re.replace_all(s, |c: &regex::Captures| charref(&c[1])).into_owned()
}

/// The Trovesaurus files newer than the installed one, newest first, shaped like the
/// Mods Hub's `changes`.
fn trovesaurus_changes(m: &TroveMod) -> Value {
    let Some(data) = &m.trovesaurus_data else { return json!({ "entries": [], "total": 0 }) };
    let files = data.releases();
    let newer: Vec<_> = match &data.installed_file {
        Some(installed) => files.into_iter().filter(|f| f.file_id > installed.file_id).collect(),
        None => files.into_iter().take(1).collect(),
    };
    let entries: Vec<Value> = newer
        .iter()
        .take(10)
        .map(|f| json!({ "version": f.version, "title": "", "date": f.created_iso(), "notes": html_to_text(&f.changes) }))
        .collect();
    json!({ "entries": entries, "total": newer.len() })
}

/// `force` skips the 15-minute master-list cache.
pub(super) fn check_mod_updates(a: &Args) -> Result<Value> {
    Ok(guard("CHECK_UPDATES_FAILED", || {
        let mut list = mod_list(a.get(0), ListOptions::default())?;
        let claimed = hub_claimed(a.get(0));
        let blocked = blocklist::load();
        list.update_trovesaurus_data(py::truthy(a.get(1)), &claimed, Some(&|v: &Value| blocked.blocked(v)))?;
        let (mut updates, mut changes) = (Map::new(), Map::new());
        for m in list.mods.iter_mut() {
            if m.has_update()? {
                let path = display(&m.mod_path);
                updates.insert(path.clone(), json!(true));
                changes.insert(path, trovesaurus_changes(m));
            }
        }
        let (updates, changes) = (Value::Object(updates), Value::Object(changes));
        Ok(Resp::ok(json!({ "updates": updates, "changes": changes })).with("updates", updates).with("changes", changes).into())
    }))
}

pub(super) fn perform_mod_update(a: &Args) -> Result<Value> {
    Ok(guard("UPDATE_FAILED", || {
        // The lock is enforced here too: a stale card must not push an update through.
        if locked_keys(a.get(0))?.contains(&lock_key_arg(a.get(1))?) {
            return Ok(Resp::fail("Updates are locked for this mod.", "MOD_LOCKED").into());
        }
        let tp = trove_game(a.get(0))?;
        if tp.is_workshop_file(&py::path_arg(a.get(1))?) {
            return Ok(Resp::fail("Steam Workshop mods are updated by Steam, not here.", "WORKSHOP_MOD").into());
        }
        let mut list = mod_list(a.get(0), ListOptions::default())?;
        let blocked = blocklist::load();
        list.update_trovesaurus_data(false, &HashSet::new(), Some(&|v: &Value| blocked.blocked(v)))?;
        let Some(i) = find_mod(&list, a.get(1)) else { return Ok(Resp::fail("Mod not found in the list.", "MOD_NOT_FOUND").into()) };
        let success = list.mods[i].update()?;
        Ok(Resp::new(success).data(json!({ "updated": success })).with("updated", success).code(if success { "OK" } else { "UPDATE_REJECTED" }).into())
    }))
}

fn stem_of(path: &str) -> String {
    py::stem_of(path)
}

/// Updates every mod with a pending update except the locked ones (the launch-time
/// auto-update). Mods Hub mods update on their own variant and skip the Trovesaurus pass.
pub(super) fn auto_update_unlocked_mods(game: &str) -> Result<(Vec<String>, Vec<String>)> {
    let game_v = json!(game);
    let locked = locked_keys(&game_v)?;
    let (mut updated, mut failed) = (Vec::new(), Vec::new());
    let mut hub_paths = HashSet::new();

    if crate::MODS_HUB_ENABLED {
        let states = hub::get_mods_hub_install_states(&game_v, true);
        let states = get(get(&states, "data"), "states").as_object().cloned().unwrap_or_default();
        for (path, state) in states {
            hub_paths.insert(path.clone());
            if !py::truthy(get(&state, "has_update")) || locked.contains(&lock_key(&path)) {
                continue;
            }
            let name = match get(&state, "name") {
                v if py::truthy(v) => py::str_of(v),
                _ => stem_of(&path),
            };
            let result = hub::install_mods_hub_mod_sync(&game_v, get(&state, "ref"), get(&state, "branch"));
            let ok = py::truthy(get(&result, "success"));
            if ok { &mut updated } else { &mut failed }.push(name);
        }
    }

    let mut list = mod_list(&game_v, ListOptions::default())?;
    let blocked = blocklist::load();
    list.update_trovesaurus_data(true, &hub_paths, Some(&|v: &Value| blocked.blocked(v)))?;
    for m in list.mods.iter_mut() {
        let path = display(&m.mod_path);
        if hub_paths.contains(&path) || !m.has_update()? || locked.contains(&lock_key(&path)) {
            continue;
        }
        let name = m.name().filter(|n| !n.is_empty()).map(String::from).unwrap_or_else(|| stem_of(&path));
        let ok = m.update().unwrap_or(false);
        if ok { &mut updated } else { &mut failed }.push(name);
    }
    Ok((updated, failed))
}
