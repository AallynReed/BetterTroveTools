//! mods_hub.py: the Mods Hub tab, mods delivered through the Kiwi API. Listing is
//! server-paginated, installed/update state is resolved by sha256 (`/mods/lookup`),
//! and installs download a release's `download_url` into the mods folder.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::manager::{self, lock_key, locked_keys, mods_signature, Signature};
use super::{blocklist, ext, finish, get, js, now, or, or_str, spawn, to_int};
use crate::game::registry::TroveGamePath;
use crate::http;
use crate::py::{self, display};
use crate::modfile::TroveMod;
use crate::{Args, Resp, KIWI_API_BASE};

pub(super) const USER_AGENT: &str = "BetterTroveTools/1.0";
const ITEMS_PER_PAGE: i64 = 24;
const VALID_SORTS: [&str; 6] = ["popular", "downloads", "stars", "recent", "new", "title"];
const MOD_PAGE_BASE: &str = "https://trove.aallyn.net/mods";
const DETAIL_TTL: f64 = 300.0;

#[derive(Clone)]
struct InstallState {
    signature: Signature,
    states: Map<String, Value>,
    paths: IndexMap<String, Option<String>>,
}

static INSTALL_CACHE: Mutex<Option<HashMap<String, InstallState>>> = Mutex::new(None);
static DETAIL_CACHE: Mutex<Option<HashMap<String, (f64, Value)>>> = Mutex::new(None);

fn install_cache_pop(game: &str) {
    if let Some(c) = INSTALL_CACHE.lock().as_mut() {
        c.remove(game);
    }
}

pub(super) fn with_headers(req: http::Request) -> http::Request {
    req.set("User-Agent", USER_AGENT).set("Accept", "application/json")
}

/// `published_at`: ISO-8601 UTC strings, so string order is chronological.
fn pub_at(release: &Value) -> String {
    or_str(get(release, "published_at"))
}

/// `<handle>/<slug>`: slugs are unique per owner, not globally.
pub(super) fn mod_ref(handle: &Value, slug: &Value) -> String {
    let clean = |v: &Value| py::strip(&or_str(v)).trim_matches('/').to_string();
    let (handle, slug) = (clean(handle), clean(slug));
    if handle.is_empty() {
        slug
    } else {
        format!("{}/{}", handle, slug)
    }
}

/// The newest release, scoped to `branch` when one is given and has releases.
pub(super) fn latest_release<'a>(releases: &'a [Value], branch: &Value) -> Option<&'a Value> {
    let mut candidates: Vec<&Value> = if py::truthy(branch) { releases.iter().filter(|r| r.is_object() && get(r, "branch") == branch).collect() } else { Vec::new() };
    if candidates.is_empty() {
        candidates = releases.iter().filter(|r| r.is_object()).collect();
    }
    candidates.sort_by_key(|r| std::cmp::Reverse(pub_at(r)));
    candidates.into_iter().next()
}

/// One entry per branch: the latest release of each, newest first.
pub(super) fn branch_variants(releases: &[Value]) -> Vec<Value> {
    let mut by_branch: IndexMap<String, &Value> = IndexMap::new();
    for r in releases.iter().filter(|r| r.is_object()) {
        let branch = match get(r, "branch") {
            v if py::truthy(v) => py::str_of(v),
            _ => "main".to_string(),
        };
        match by_branch.get(&branch) {
            Some(current) if pub_at(r) <= pub_at(current) => {}
            _ => {
                by_branch.insert(branch, r);
            }
        }
    }
    let mut out: Vec<&Value> = by_branch.into_values().collect();
    out.sort_by_key(|r| std::cmp::Reverse(pub_at(r)));
    out.into_iter().cloned().collect()
}

/// A newer release exists on the branch the user installed.
pub(super) fn release_outdated(matched: &Value, releases: &[Value]) -> bool {
    if !py::truthy(matched) || releases.is_empty() {
        return false;
    }
    let Some(latest) = latest_release(releases, get(matched, "branch")) else { return false };
    let matched_hash = or_str(get(matched, "sha256")).to_lowercase();
    let latest_hash = or_str(get(latest, "sha256")).to_lowercase();
    !matched_hash.is_empty() && !latest_hash.is_empty() && matched_hash != latest_hash
}

fn lstrip_v(s: &str) -> &str {
    s.trim_start_matches(['v', 'V'])
}

/// What an update brings in: the releases on the installed branch newer than the
/// installed one, newest first. `total` counts past the cap.
pub(super) fn changes_since(matched: &Value, releases: &[Value]) -> Value {
    let installed = pub_at(matched);
    let branch = get(matched, "branch");
    let releases: Vec<&Value> = releases.iter().filter(|r| r.is_object()).collect();
    let same_branch: Vec<&Value> = if py::truthy(branch) { releases.iter().copied().filter(|r| get(r, "branch") == branch).collect() } else { Vec::new() };
    let pool = if same_branch.is_empty() { releases } else { same_branch };
    let mut newer: Vec<&Value> = pool.into_iter().filter(|r| pub_at(r) > installed).collect();
    newer.sort_by_key(|r| std::cmp::Reverse(pub_at(r)));
    let entries: Vec<Value> = newer
        .iter()
        .take(10)
        .map(|r| {
            let tag = or_str(get(r, "tag"));
            let title = or_str(get(r, "title"));
            let shown_title = if !tag.is_empty() && lstrip_v(&title) != lstrip_v(&tag) { title.clone() } else { String::new() };
            json!({
                "version": if tag.is_empty() { title } else { tag },
                "title": shown_title,
                "date": pub_at(r),
                "notes": py::strip(&or_str(get(r, "changelog"))),
            })
        })
        .collect();
    json!({ "entries": entries, "total": newer.len() })
}

pub(super) fn release_extension(release: &Value) -> &'static str {
    let filename = or_str(get(release, "filename")).to_lowercase();
    if filename.ends_with(".zip") || filename.ends_with(".zip.disabled") {
        return ".zip";
    }
    if filename.ends_with(".tmod") {
        return ".tmod";
    }
    let fmt = or_str(get(release, "format")).to_lowercase();
    if fmt.trim_start_matches('.') == "zip" {
        ".zip"
    } else {
        ".tmod"
    }
}

pub(super) fn safe_filename(name: &str) -> String {
    let kept: String = name.chars().filter(|&c| py::is_printable(c) && !"<>:\"/\\|?*".contains(c)).collect();
    let safe = py::strip(&kept).trim_end_matches('.');
    if safe.is_empty() {
        "mod".into()
    } else {
        safe.to_string()
    }
}

/// Trove checks a .tmod's filename against its header title, so that title wins.
pub(super) fn install_name(data: &[u8], ext: &str, release: &Value, detail: &Value) -> String {
    if ext == ".tmod" {
        if let Ok(m) = TroveMod::read_tmod(Path::new("download.tmod"), data.to_vec(), true) {
            if let Some(title) = m.name().filter(|t| !py::strip(t).is_empty()) {
                return safe_filename(title);
            }
        }
    }
    let filename = py::name_of(&or_str(get(release, "filename")));
    let low = filename.to_lowercase();
    for known in [".tmod", ".zip"] {
        if low.ends_with(known) && filename.is_char_boundary(filename.len() - known.len()) {
            return safe_filename(&filename[..filename.len() - known.len()]);
        }
    }
    let t = get(detail, "title");
    safe_filename(&if py::truthy(t) { py::str_of(t) } else { "mod".into() })
}

/// POSTs a batch of sha256s to `/mods/lookup`: `results` ({hash: {mod, release}}) and
/// `taken_down`. `None` when the hub didn't answer.
fn lookup_hashes(hashes: &[String], releases: &str, label: &str) -> Option<Value> {
    if hashes.is_empty() {
        return Some(json!({}));
    }
    let url = format!("{}/mods/lookup", KIWI_API_BASE);
    let req = ext(label, &url);
    let body = json!({ "hashes": hashes, "include_releases": true, "releases": releases });
    match http::send_json(with_headers(http::post(&url)).timeout(Duration::from_secs(15)), &body) {
        Ok(resp) => {
            let ok = resp.status() == 200;
            finish(req, ok);
            if ok {
                match http::read_json(resp) {
                    Ok(v) => return Some(if py::truthy(&v) { v } else { json!({}) }),
                    Err(e) => eprintln!("Mods Hub lookup failed: {}", e),
                }
            }
        }
        Err(e) => {
            finish(req, false);
            eprintln!("Mods Hub lookup failed: {}", e);
        }
    }
    None
}

fn unsubscribe(ids: &[String]) {
    crate::modder_tools::steam_workshop::unsubscribe_items(ids);
}

/// Deletes installed copies of mods a moderator took down, for good and silently. A
/// Workshop copy is unsubscribed from and goes with its item folder.
fn remove_taken_down(game: &str, files: &[PathBuf]) -> bool {
    let game_path = py::py_path(game);
    let mods_dir = py::resolve(&game_path.join("mods"));
    let workshop = TroveGamePath::new(game_path, None).workshop_path().map(|w| py::resolve(&w));
    let (mut local, mut items) = (Vec::new(), Vec::<PathBuf>::new());
    for f in files {
        let path = py::resolve(f);
        if under(&path, &mods_dir) {
            local.push(path);
        } else if let Some(ws) = workshop.as_ref().filter(|ws| under(&path, ws)) {
            if let Some(first) = py::relative_parts(&path, ws).and_then(|p| p.into_iter().next()) {
                let item = ws.join(first);
                if !items.iter().any(|i| py::same_path(i, &item)) {
                    items.push(item);
                }
            }
        }
    }
    items.sort_by_key(|p| display(p).to_lowercase());
    let ids: Vec<String> = items.iter().map(|i| py::file_name(i)).filter(|n| py::isdigit(n)).collect();
    if !ids.is_empty() {
        let mut sorted = ids;
        sorted.sort();
        unsubscribe(&sorted);
    }
    let mut removed = false;
    for path in local.iter().chain(items.iter()) {
        let gone = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        if gone.is_ok() {
            removed = true;
        }
    }
    if removed {
        if let Some(c) = crate::ctx::try_ctx() {
            c.js("receive_mods_changed", vec![json!(game)]);
        }
    }
    removed
}

/// `parent in path.parents`.
fn under(path: &Path, parent: &Path) -> bool {
    py::is_within(path, parent) && !py::same_path(path, parent)
}

struct RefInfo {
    rank: (bool, String),
    hash: String,
    path: Option<String>,
    matched: Value,
    releases: Option<Vec<Value>>,
    name: Value,
    page_url: Value,
    handle: Value,
    slug: Value,
    is_beta: bool,
    outdated: bool,
}

fn releases_of(v: &Value) -> Vec<Value> {
    super::items(v).to_vec()
}

/// Which installed mods come from the hub (and whether each is outdated), keyed by
/// `<handle>/<slug>`. Cached against the mods folder's signature; `force` re-checks.
fn compute_install_states(game: &Value, force: bool) -> Result<(Map<String, Value>, IndexMap<String, Option<String>>)> {
    if !py::truthy(game) {
        return Ok((Map::new(), IndexMap::new()));
    }
    let key = py::str_of(game);
    let game_str = super::path_string(game)?;
    let mut signature = mods_signature(&game_str);
    if !force {
        if let Some(c) = INSTALL_CACHE.lock().as_ref().and_then(|c| c.get(&key)) {
            if c.signature == signature {
                return Ok((c.states.clone(), c.paths.clone()));
            }
        }
    }

    // Enabled files first: of several copies, the one the game loads is what counts.
    let tp = TroveGamePath::new(py::py_path(&game_str), None);
    let mut files: Vec<(bool, PathBuf, bool)> = Vec::new();
    for (enabled, group) in [(true, [tp.enabled_tmods(), tp.enabled_zips()].concat()), (false, [tp.disabled_tmods(), tp.disabled_zips()].concat())] {
        for f in group {
            let workshop = tp.is_workshop_file(&f);
            files.push((enabled, f, workshop));
        }
    }

    let mut hash_to_path: IndexMap<String, String> = IndexMap::new();
    let mut hash_enabled: HashMap<String, bool> = HashMap::new();
    let mut copies: IndexMap<String, Vec<PathBuf>> = IndexMap::new();
    for (enabled, f, workshop) in files {
        let Ok(bytes) = std::fs::read(&f) else { continue };
        let digest = hex::encode(Sha256::digest(&bytes));
        copies.entry(digest.clone()).or_default().push(f.clone());
        // Workshop mods aren't hub mods; they are looked up only so a takedown reaches them.
        if workshop || hash_to_path.contains_key(&digest) {
            continue;
        }
        hash_to_path.insert(digest.clone(), display(&f));
        hash_enabled.insert(digest, enabled);
    }

    let mut ref_match: IndexMap<String, RefInfo> = IndexMap::new();
    let mut taken_down: Vec<String> = Vec::new();
    if !copies.is_empty() {
        let all: Vec<String> = copies.keys().cloned().collect();
        for batch in all.chunks(200) {
            // No answer: report nothing rather than caching "no hub mods installed".
            let Some(payload) = lookup_hashes(batch, "latest", "Identifying Installed Mods") else {
                return Ok((Map::new(), IndexMap::new()));
            };
            for h in py::iterate(or(get(&payload, "taken_down"), &json!([]))).unwrap_or_default() {
                if let Value::String(h) = h {
                    if !taken_down.contains(&h) {
                        taken_down.push(h);
                    }
                }
            }
            let Some(results) = or(get(&payload, "results"), &json!({})).as_object().cloned() else { continue };
            for (h, entry) in results {
                if !hash_to_path.contains_key(&h) {
                    continue;
                }
                let m = or(get(&entry, "mod"), &json!({})).clone();
                let matched = or(get(&entry, "release"), &json!({})).clone();
                let slug = get(&m, "slug").clone();
                if !py::truthy(&slug) {
                    continue;
                }
                let handle = get(&m, "handle").clone();
                let r = mod_ref(&handle, &slug);
                // Several copies of one mod: the enabled one wins, then the newest release.
                let rank = (*hash_enabled.get(&h).unwrap_or(&true), pub_at(&matched));
                if ref_match.get(&r).map(|existing| rank <= existing.rank).unwrap_or(false) {
                    continue;
                }
                let page_url = match get(&m, "page_url") {
                    v if py::truthy(v) => v.clone(),
                    _ => json!(format!("{}/{}", MOD_PAGE_BASE, r)),
                };
                let releases = match get(&m, "releases") {
                    Value::Null => None,
                    v => Some(releases_of(v)),
                };
                ref_match.insert(
                    r,
                    RefInfo {
                        rank,
                        path: hash_to_path.get(&h).cloned(),
                        hash: h,
                        matched,
                        releases,
                        name: get(&m, "title").clone(),
                        page_url,
                        handle,
                        slug,
                        is_beta: py::truthy(get(&m, "is_beta")),
                        outdated: false,
                    },
                );
            }
        }
    }

    let doomed: Vec<PathBuf> = taken_down.iter().flat_map(|h| copies.get(h).cloned().unwrap_or_default()).collect();
    if remove_taken_down(&game_str, &doomed) {
        signature = mods_signature(&game_str);
    }

    for (r, info) in ref_match.iter_mut() {
        if info.releases.is_none() {
            // Older hub: no releases[] in the lookup, so pay the round trip.
            let detail = fetch_mod_detail(r, !force).unwrap_or(json!({}));
            info.releases = Some(releases_of(or(get(&detail, "releases"), &json!([]))));
        }
        info.outdated = release_outdated(&info.matched, info.releases.as_deref().unwrap_or(&[]));
    }

    // Changelogs need every release since the installed one: one more lookup, full
    // history, outdated mods only.
    let mut history: HashMap<String, Vec<Value>> = HashMap::new();
    let outdated: Vec<String> = ref_match.values().filter(|i| i.outdated).map(|i| i.hash.clone()).collect();
    if !outdated.is_empty() {
        let payload = lookup_hashes(&outdated, "all", "Fetching Mod Changelogs").unwrap_or(json!({}));
        if let Some(results) = or(get(&payload, "results"), &json!({})).as_object() {
            for entry in results.values() {
                let m = get(entry, "mod");
                if py::truthy(get(m, "slug")) && py::truthy(get(m, "releases")) {
                    history.insert(mod_ref(get(m, "handle"), get(m, "slug")), releases_of(get(m, "releases")));
                }
            }
        }
    }

    let (mut states, mut paths) = (Map::new(), IndexMap::new());
    for (r, info) in &ref_match {
        let changes = if info.outdated {
            let releases = history.get(r).filter(|h| !h.is_empty()).map(Vec::as_slice).unwrap_or(info.releases.as_deref().unwrap_or(&[]));
            changes_since(&info.matched, releases)
        } else {
            Value::Null
        };
        states.insert(
            r.clone(),
            json!({
                "is_installed": true,
                "needs_update": info.outdated,
                "changes": changes,
                "branch": get(&info.matched, "branch"),
                "name": info.name,
                "page_url": info.page_url,
                "handle": info.handle,
                "slug": info.slug,
                "is_beta": info.is_beta,
            }),
        );
        paths.insert(r.clone(), info.path.clone());
    }
    INSTALL_CACHE.lock().get_or_insert_with(HashMap::new).insert(key, InstallState { signature, states: states.clone(), paths: paths.clone() });
    Ok((states, paths))
}

/// A mod's full detail (with releases[]) by its `<handle>/<slug>` ref.
pub(super) fn fetch_mod_detail(r: &str, use_cache: bool) -> Option<Value> {
    if use_cache {
        if let Some((at, detail)) = DETAIL_CACHE.lock().as_ref().and_then(|c| c.get(r)) {
            if now() - at < DETAIL_TTL {
                return Some(detail.clone());
            }
        }
    }
    let url = format!("{}/mods/{}", KIWI_API_BASE, r);
    let req = ext(&format!("Fetching Mod {}", r), &url);
    match http::send(with_headers(http::get(&url)).timeout(Duration::from_secs(15))) {
        Ok(resp) => {
            let ok = resp.status() == 200;
            finish(req, ok);
            if ok {
                match http::read_json(resp) {
                    Ok(v) => {
                        let detail = if py::truthy(&v) { v } else { json!({}) };
                        DETAIL_CACHE.lock().get_or_insert_with(HashMap::new).insert(r.to_string(), (now(), detail.clone()));
                        return Some(detail);
                    }
                    Err(e) => eprintln!("Mods Hub detail fetch failed: {}", e),
                }
            }
        }
        Err(e) => {
            finish(req, false);
            eprintln!("Mods Hub detail fetch failed: {}", e);
        }
    }
    None
}

fn listing(a: &Args) -> Result<Value> {
    let page = match a.get(0) {
        v if py::truthy(v) => py::int_lenient(v)?,
        _ => 1,
    }
    .max(1);
    let sort = match a.get(3) {
        Value::String(s) if VALID_SORTS.contains(&s.as_str()) => s.clone(),
        _ => "popular".to_string(),
    };
    let mut params: Vec<(&str, String)> = vec![("limit", ITEMS_PER_PAGE.to_string()), ("offset", ((page - 1) * ITEMS_PER_PAGE).to_string()), ("sort", sort)];
    if py::truthy(a.get(1)) {
        params.push(("q", py::str_of(a.get(1))));
    }
    if py::truthy(a.get(2)) {
        params.push(("tag", py::str_of(a.get(2))));
    }
    let base = format!("{}/mods", KIWI_API_BASE);
    let req = ext("Browsing the Mods Hub", &base);
    let url = format!("{}?{}", base, http::urlencode(&params));
    let resp = match http::send(with_headers(http::get(&url)).timeout(Duration::from_secs(15))) {
        Ok(resp) => {
            finish(req, resp.status() == 200);
            resp
        }
        Err(_) => {
            finish(req, false);
            return Ok(json!({ "success": false, "error": "Couldn't reach the Mods Hub. It may be down or you might be offline." }));
        }
    };
    if resp.status() != 200 {
        return Ok(json!({ "success": false, "error": format!("The mod hub returned HTTP {}.", resp.status()) }));
    }
    let payload = http::read_json(resp)?;
    let payload = if py::truthy(&payload) { payload } else { json!({}) };
    let items = or(get(&payload, "items"), &json!([])).clone();
    let items = py::iterate(&items)?;
    let total = match get(&payload, "total") {
        v if py::truthy(v) => py::int_lenient(v)?,
        _ => items.len() as i64,
    };
    let max_pages = ((total + ITEMS_PER_PAGE - 1).div_euclid(ITEMS_PER_PAGE)).max(1);

    let (states, _) = compute_install_states(a.get(4), py::truthy(a.get(6)))?;

    let mut result = Vec::new();
    for m in &items {
        if !m.is_object() {
            continue;
        }
        let (slug, handle) = (get(m, "slug"), get(m, "handle"));
        let r = mod_ref(handle, slug);
        let state = states.get(&r).cloned().unwrap_or(json!({}));
        let previews = get(m, "preview_urls");
        let first_preview = if py::truthy(previews) { super::items(previews).first().cloned().unwrap_or(Value::Null) } else { Value::Null };
        let preview = or(get(m, "banner_url"), or(&first_preview, &json!(""))).clone();
        let page_url = match get(m, "page_url") {
            v if py::truthy(v) => v.clone(),
            _ => json!(format!("{}/{}", MOD_PAGE_BASE, r)),
        };
        result.push(json!({
            "slug": slug,
            "handle": handle,
            "ref": r,
            "name": or(get(m, "title"), &json!("Unnamed Mod")),
            "author": or(get(m, "author"), &json!("Unknown")),
            "summary": or(get(m, "summary"), &json!("")),
            "downloads": or(get(m, "download_count"), &json!(0)),
            "stars": or(get(m, "star_count"), &json!(0)),
            "image": preview,
            "page_url": page_url,
            "tags": or(get(m, "categories"), or(get(m, "tags"), &json!([]))),
            "is_beta": py::truthy(get(m, "is_beta")),
            "is_installed": py::truthy(get(&state, "is_installed")),
            "needs_update": py::truthy(get(&state, "needs_update")),
            "installed_branch": get(&state, "branch"),
        }));
    }
    Ok(json!({ "success": true, "mods": result, "page": page.min(max_pages), "max_pages": max_pages, "total": total }))
}

pub(super) fn get_mods_hub_mods(a: &Args) -> Result<Value> {
    let a = a.clone();
    spawn(move || {
        let mut payload = listing(&a).unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }));
        payload["request_token"] = a.get(5).clone();
        js("receive_mods_hub_mods", payload);
    });
    Ok(Value::Null)
}

/// Downloads a release into the mods folder: (success, error, installed branch).
fn do_install(game: &Value, r: &Value, branch: &Value) -> Result<(bool, Option<String>, Value)> {
    let fail = |msg: &str| Ok((false, Some(msg.to_string()), Value::Null));
    if !py::truthy(game) {
        return fail("No game path provided.");
    }
    let ref_str = py::str_of(r);
    // The installed file decides the suffix to keep, the stale copy to clear, and
    // whether the user's update lock applies.
    let (states, paths) = compute_install_states(game, false)?;
    let old_path = paths.get(&ref_str).cloned().flatten().filter(|p| !p.is_empty());
    let installed_branch = get(states.get(&ref_str).unwrap_or(&Value::Null), "branch").clone();

    // Switching to another variant is a deliberate choice and stays allowed.
    if let Some(old) = &old_path {
        if (branch.is_null() || *branch == installed_branch) && locked_keys(game)?.contains(&lock_key(old)) {
            return fail("Updates are locked for this mod.");
        }
    }

    // Never cached: a forced refresh sees a new release through /lookup first.
    let Some(detail) = fetch_mod_detail(&ref_str, false) else { return fail("Couldn't reach the mod hub to fetch this mod.") };
    let releases = releases_of(or(get(&detail, "releases"), &json!([])));
    let Some(release) = latest_release(&releases, branch).filter(|r| py::truthy(get(r, "download_url"))).cloned() else {
        return fail("This mod has no downloadable releases yet.");
    };

    let url = py::str_of(get(&release, "download_url"));
    let label = format!("Downloading Mod {}", py::str_of(or(get(&detail, "title"), r)));
    let req = ext(&label, &url);
    let Ok((status, data)) = super::download(&url, USER_AGENT, 310, req) else { return fail("Failed to download the mod file from the hub.") };
    if status != 200 {
        return Ok((false, Some(format!("Download failed. Status: {}", status)), Value::Null));
    }
    let ext_name = release_extension(&release);
    let safe_name = install_name(&data, ext_name, &release, &detail);
    let mods_dir = py::path_arg(game)?.join("mods");
    py::mkdir_all(&mods_dir)?;
    // Updating a mod the user switched off leaves it switched off.
    let suffix = if old_path.as_deref().unwrap_or("").to_lowercase().ends_with(".disabled") { ".disabled" } else { "" };
    let out_path = mods_dir.join(format!("{}{}{}", safe_name, ext_name, suffix));
    py::write_bytes(&out_path, &data)?;

    if let Some(old) = &old_path {
        let old = py::py_path(old);
        if old.exists() && !py::same_path(&py::resolve(&old), &py::resolve(&out_path)) {
            let _ = std::fs::remove_file(&old);
        }
    }
    install_cache_pop(&py::str_of(game));
    Ok((true, None, get(&release, "branch").clone()))
}

/// Install (or update) a mod, replying through `receive_mods_hub_install_result`.
pub(super) fn install_mods_hub_mod(a: &Args) -> Result<Value> {
    let (game, r, branch) = (a.get(0).clone(), a.get(1).clone(), a.get(2).clone());
    spawn(move || {
        let payload = match do_install(&game, &r, &branch) {
            Ok((true, _, b)) => json!({ "success": true, "ref": r, "branch": b }),
            Ok((false, error, _)) => json!({ "success": false, "error": error, "ref": r }),
            Err(e) => json!({ "success": false, "error": e.to_string(), "ref": r }),
        };
        js("receive_mods_hub_install_result", payload);
    });
    Ok(Value::Null)
}

/// The same install, answered directly (the Mod Manager tab).
pub(super) fn install_mods_hub_mod_sync(game: &Value, r: &Value, branch: &Value) -> Value {
    match do_install(game, r, branch) {
        Ok((ok, error, b)) => {
            let mut resp = Resp::new(ok).data(json!({ "branch": b })).with("branch", b).code(if ok { "OK" } else { "INSTALL_FAILED" });
            if let Some(e) = error {
                resp = resp.error(e);
            }
            resp.into()
        }
        Err(e) => Resp::fail(e.to_string(), "INSTALL_FAILED").into(),
    }
}

/// A mod's variants: one per branch, the latest release of each.
pub(super) fn get_mods_hub_variants(a: &Args) -> Result<Value> {
    let r = a.get(0);
    let Some(detail) = fetch_mod_detail(&py::str_of(r), false) else {
        return Ok(Resp::fail("Couldn't reach the Mods Hub to load this mod's variants.", "MODS_HUB_VARIANTS_FAILED").into());
    };
    let mut variants = Vec::new();
    for v in branch_variants(&releases_of(or(get(&detail, "releases"), &json!([])))) {
        let branch = or(get(&v, "branch"), &json!("main")).clone();
        let format = match get(&v, "format") {
            Value::String(s) => s.trim_start_matches('.').to_string(),
            other if !py::truthy(other) => String::new(),
            other => anyhow::bail!("'{}' object has no attribute 'lstrip'", py::type_name(other)),
        };
        variants.push(json!({
            "branch": branch,
            "tag": get(&v, "tag"),
            "title": or(get(&v, "title"), or(get(&v, "tag"), &branch)),
            "format": format,
            "size": to_int(get(&v, "size")),
            "published_at": get(&v, "published_at"),
            "changelog": or(get(&v, "changelog"), &json!("")),
            "download_count": to_int(get(&v, "download_count")),
        }));
    }
    let title = or(get(&detail, "title"), r).clone();
    Ok(Resp::ok(json!({ "ref": r, "title": title, "variants": variants })).with("ref", r.clone()).with("title", title).with("variants", variants).into())
}

/// Identifies an install's mods against the hub (which deletes any taken down), then
/// removes the Steam Workshop items the blocklist names, by id or by author.
pub(super) fn remove_taken_down_mods(game: &str) {
    let _ = compute_install_states(&json!(game), true);
    let Some(workshop) = TroveGamePath::new(py::py_path(game), None).workshop_path() else { return };
    let Ok(rd) = std::fs::read_dir(&workshop) else { return };
    let installed: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir() && py::isdigit(&py::file_name(p))).collect();
    if installed.is_empty() {
        return;
    }
    let (items, authors) = blocklist::workshop();
    let names: Vec<String> = installed.iter().map(|p| py::file_name(p)).collect();
    let creators = if authors.is_empty() { HashMap::new() } else { blocklist::workshop_creators(&names) };
    let listed: Vec<PathBuf> = installed.into_iter().filter(|p| {
        let name = py::file_name(p);
        items.contains(&name) || creators.get(&name).map(|c| authors.contains(c)).unwrap_or(false)
    }).collect();
    if !listed.is_empty() {
        remove_taken_down(game, &listed);
    }
}

/// Paths of installed mods the hub resolved as its own; the Trovesaurus pass skips them.
pub(super) fn hub_claimed_paths(game: &Value, force: bool) -> HashSet<String> {
    if !py::truthy(game) {
        return HashSet::new();
    }
    match compute_install_states(game, force) {
        Ok((_, paths)) => paths.into_values().flatten().filter(|p| !p.is_empty()).collect(),
        Err(_) => HashSet::new(),
    }
}

/// For My Mods: which installed mods come from the hub, keyed by file path.
pub(super) fn get_mods_hub_install_states(game: &Value, force: bool) -> Value {
    super::guard("MODS_HUB_STATES_FAILED", || {
        let (states, paths) = compute_install_states(game, force)?;
        let mut by_path = Map::new();
        for (r, st) in &states {
            let Some(Some(path)) = paths.get(r) else { continue };
            if path.is_empty() {
                continue;
            }
            by_path.insert(
                path.clone(),
                json!({
                    "ref": r,
                    "slug": get(st, "slug"),
                    "handle": get(st, "handle"),
                    "branch": get(st, "branch"),
                    "name": get(st, "name"),
                    "page_url": get(st, "page_url"),
                    "is_beta": py::truthy(get(st, "is_beta")),
                    "has_update": py::truthy(get(st, "needs_update")),
                    "changes": get(st, "changes"),
                }),
            );
        }
        let by_path = Value::Object(by_path);
        Ok(Resp::ok(json!({ "states": by_path })).with("states", by_path).into())
    })
}

pub(super) fn delete_mods_hub_installed_mod(a: &Args) -> Result<Value> {
    Ok(super::guard("DELETE_MODS_HUB_MOD_FAILED", || {
        let game = a.get(0);
        if !py::truthy(game) {
            return Ok(Resp::fail("No game path provided.", "MISSING_GAME_PATH").into());
        }
        let r = py::str_of(a.get(1));
        let (_, paths) = compute_install_states(game, false)?;
        let mut path = paths.get(&r).cloned().flatten().filter(|p| !p.is_empty());
        if path.is_none() {
            // The cache may predate a manual change: rescan once before giving up.
            install_cache_pop(&py::str_of(game));
            let (_, paths) = compute_install_states(game, false)?;
            path = paths.get(&r).cloned().flatten().filter(|p| !p.is_empty());
        }
        let Some(path) = path else {
            return Ok(Resp::fail("Could not find an installed file for this mod.", "INSTALLED_FILE_NOT_FOUND").into());
        };
        let result = manager::delete_mod(game, &json!(path));
        install_cache_pop(&py::str_of(game));
        Ok(result)
    }))
}

pub(super) fn get_mods_hub_categories(_: &Args) -> Result<Value> {
    let url = format!("{}/mods/categories", KIWI_API_BASE);
    let data = super::cached_api(&url, "mods_hub_categories.json", 3600.0, "Fetching Mods Hub Categories", &[("User-Agent", USER_AGENT), ("Accept", "application/json")], Value::Null)?;
    let categories = if data.is_object() { or(get(&data, "categories"), &json!([])).clone() } else { json!([]) };
    Ok(Resp::ok(json!({ "categories": categories })).with("categories", categories).into())
}

pub(super) fn clear_mods_hub_cache(_: &Args) -> Result<Value> {
    Ok(super::guard("CACHE_CLEAR_FAILED", || {
        let file = crate::paths::get_cache_root().join("mods_hub_categories.json");
        let mut removed = Vec::new();
        if file.exists() {
            py::unlink(&file)?;
            removed.push("mods_hub_categories.json");
        }
        *INSTALL_CACHE.lock() = None;
        *DETAIL_CACHE.lock() = None;
        Ok(Resp::ok(json!({ "removed": removed })).with("removed", json!(removed)).into())
    }))
}
