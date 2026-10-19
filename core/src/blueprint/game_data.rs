//! utils/kiwi_blueprint/game_data.py: what KiwiAPI's editor reads from its server, read
//! from the local install: the creature rig map (scanned once from the prefab archives
//! and cached on disk until their indexes change), blueprint parts, and the brdf atlas.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use rayon::prelude::*;
use regex::Regex;
use serde_json::{json, Value};

use crate::game::archive::{archive_path, load_index, read_archive_content, GameIndex, IndexEntry};
use crate::codexes::prefab_ally::{load_language_map, GameFiles, LanguageMap};
use crate::paths::get_cache_root;

use super::assembly;
use super::binfab;
use super::pyobj::{self, Py};
use crate::py;
use super::pyzlib;

const INDEX_VERSION: i128 = 1;

fn slice<'a>(content: &'a [u8], e: &IndexEntry) -> &'a [u8] {
    let start = (e.offset as usize).min(content.len());
    let end = (e.offset as usize + e.size as usize).min(content.len());
    &content[start..end.max(start)]
}

pub fn index_of(game: &Path, top: &str) -> Option<Arc<GameIndex>> {
    let root = game.join(top);
    if !root.is_dir() {
        return None;
    }
    load_index(&root).ok()
}

/// One file of an already loaded subtree index.
pub fn read_indexed(index: &GameIndex, rest: &str) -> Option<Vec<u8>> {
    let f = index.find(rest)?;
    let content = read_archive_content(&archive_path(&f.tfi_path, &f.entry)).ok()?;
    Some(slice(&content, &f.entry).to_vec())
}

/// `read_game_file(game, "top/rest/of/path")`.
pub fn read_game_file(game: &Path, path: &str) -> Option<Vec<u8>> {
    let normalized = path.replace('\\', "/");
    let (top, rest) = normalized.split_once('/').unwrap_or((&normalized, ""));
    if rest.is_empty() {
        return None;
    }
    read_indexed(&*index_of(game, top)?, rest)
}

/// `blueprint_paths`: `{filename.lower(): [every blueprint path with that name]}`.
pub fn blueprint_paths(index: Option<&GameIndex>) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for f in index.into_iter().flat_map(|i| &i.files) {
        let full = format!("blueprints/{}", f.full_path);
        if full.to_lowercase().ends_with(".blueprint") {
            out.entry(full.rsplit('/').next().unwrap_or("").to_lowercase()).or_default().push(full);
        }
    }
    out
}

fn folders(p: &str) -> Vec<String> {
    let low = p.replace('\\', "/").to_lowercase();
    let mut segs: Vec<String> = low.split('/').map(str::to_string).collect();
    segs.pop();
    segs.retain(|s| !s.is_empty());
    segs
}

/// `nearest_path`: the candidate sharing the most folders with the creature's prefab.
pub fn nearest_path(candidates: &[String], hint: &str) -> Option<String> {
    if candidates.len() == 1 || hint.is_empty() {
        return candidates.iter().min().cloned();
    }
    let want: std::collections::HashSet<String> = folders(hint).into_iter().collect();
    let score = |p: &String| {
        let segs: std::collections::HashSet<String> = folders(p).into_iter().collect();
        -(want.intersection(&segs).count() as i64)
    };
    candidates.iter().min_by(|a, b| (score(a), *a).cmp(&(score(b), *b))).cloned()
}

// --- the rig map ------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Row {
    prefab: String,
    blueprint: String,
    skeleton: String,
    ap: String,
    mesh_scale: f64,
    head_scale: f64,
}

#[derive(Default)]
pub struct RigMap {
    by_blueprint: HashMap<String, (String, String)>,
    /// prefab -> (skeleton, [(basename, socket)]).
    pub creatures: HashMap<String, (String, Vec<(String, String)>)>,
    owner: HashMap<String, String>,
    by_path: HashMap<String, String>,
    by_stem: HashMap<String, Vec<String>>,
    head_scale: HashMap<String, f64>,
    mesh_scale: HashMap<(String, String), f64>,
    names: HashMap<String, String>,
}

pub struct Scales {
    pub head: f64,
    pub parts: HashMap<String, f64>,
}

impl Default for Scales {
    fn default() -> Self {
        Scales { head: 1.0, parts: HashMap::new() }
    }
}

pub fn prefab_stem(prefab: &str) -> String {
    let normalized = prefab.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or("");
    if name.to_lowercase().ends_with(".binfab") {
        name[..name.len() - ".binfab".len()].to_string()
    } else {
        name.to_string()
    }
}

fn build_map(mut rows: Vec<Row>, names: HashMap<String, String>) -> RigMap {
    let mut rig = RigMap { names, ..Default::default() };
    rows.sort_by(|a, b| (&a.prefab, &a.blueprint).cmp(&(&b.prefab, &b.blueprint)));
    for r in rows {
        rig.by_blueprint.entry(r.blueprint.clone()).or_insert_with(|| (r.skeleton.clone(), r.ap.clone()));
        rig.owner.entry(r.blueprint.clone()).or_insert_with(|| r.prefab.clone());
        if !rig.creatures.contains_key(&r.prefab) {
            rig.creatures.insert(r.prefab.clone(), (r.skeleton.clone(), Vec::new()));
            rig.by_path.insert(r.prefab.to_lowercase(), r.prefab.clone());
            rig.by_stem.entry(prefab_stem(&r.prefab).to_lowercase()).or_default().push(r.prefab.clone());
            rig.head_scale.insert(r.prefab.clone(), r.head_scale);
        }
        let parts = &mut rig.creatures.get_mut(&r.prefab).unwrap().1;
        match parts.iter_mut().find(|(b, _)| *b == r.blueprint) {
            Some(slot) => slot.1 = r.ap.clone(),
            None => parts.push((r.blueprint.clone(), r.ap.clone())),
        }
        if r.mesh_scale != 1.0 {
            rig.mesh_scale.insert((r.prefab, r.blueprint), r.mesh_scale);
        }
    }
    rig
}

/// `sorted(rglob("index.tfi"))`: pathlib orders Windows paths by lowercased parts.
fn sorted_indexes(root: &Path) -> Vec<PathBuf> {
    let mut found = crate::game::archive::find_index_files(root);
    if cfg!(windows) {
        found.sort_by_cached_key(|p| py::path_str_flat(p).to_lowercase().split('\\').map(str::to_string).collect::<Vec<_>>());
    } else {
        found.sort_by_cached_key(|p| py::path_str_flat(p).split('/').map(str::to_string).collect::<Vec<_>>());
    }
    found
}

fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as i128).unwrap_or(0)
}

/// `_signature`: `[INDEX_VERSION, str(game), [[str(tfi), mtime_ns, size], ...]]`.
fn signature(game: &Path) -> Result<Py, String> {
    let mut sig = Vec::new();
    for tfi in sorted_indexes(&game.join("prefabs")) {
        let st = std::fs::metadata(&tfi).map_err(|e| e.to_string())?;
        sig.push(Py::List(vec![Py::Str(py::path_str_flat(&tfi)), Py::Int(mtime_ns(&st)), Py::Int(st.len() as i128)]));
    }
    Ok(Py::List(vec![Py::Int(INDEX_VERSION), Py::Str(py::path_str_flat(game)), Py::List(sig)]))
}

fn cache_file() -> Result<PathBuf, String> {
    let root = get_cache_root().join("blueprint_editor");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.join("rig_index.json"))
}

fn rows_from(saved: &Py) -> Result<(Vec<Row>, HashMap<String, String>), String> {
    let (Some(Py::List(rows)), Some(Py::Dict(names))) = (saved.get("rows"), saved.get("names")) else {
        return Err("the cached rig index isn't readable".into());
    };
    let float = |p: &Py| match p {
        Py::Float(f) => Some(*f),
        Py::Int(i) => Some(*i as f64),
        Py::Bool(b) => Some(*b as u8 as f64),
        Py::Str(s) => py::strip(s).parse().ok(),
        _ => None,
    };
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let Py::List(f) = r else { return Err("cannot unpack non-iterable row".into()) };
        if f.len() != 6 {
            return Err(format!("expected 6 values to unpack, got {}", f.len()));
        }
        let (Some(mesh_scale), Some(head_scale)) = (float(&f[4]), float(&f[5])) else {
            return Err("float() argument must be a string or a real number".into());
        };
        out.push(Row { prefab: f[0].str(), blueprint: f[1].str(), skeleton: f[2].str(), ap: f[3].str(), mesh_scale, head_scale });
    }
    Ok((out, names.iter().map(|(k, v)| (k.clone(), v.str())).collect()))
}

fn cache_json(sig: &Py, rows: &[Row], names: &[(String, String)]) -> String {
    let rows: Vec<Value> = rows.iter().map(|r| json!([r.prefab, r.blueprint, r.skeleton, r.ap, r.mesh_scale, r.head_scale])).collect();
    let names: serde_json::Map<String, Value> = names.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    let payload = json!({"signature": sig.to_value(), "rows": rows, "names": names});
    crate::json::dumps_with(&payload, crate::json::DumpOpts { compact: true, ..Default::default() })
}

/// `(rows, display names)`.
type Bindings = (Vec<Row>, Vec<(String, String)>);

/// `_scan`: every creature binding in the install, and each creature's display name.
fn scan(game: &Path) -> Result<Bindings, String> {
    let Some(index) = index_of(game, "prefabs") else { return Ok((Vec::new(), Vec::new())) };
    let mut archives: Vec<(PathBuf, Vec<usize>)> = Vec::new();
    let mut at: HashMap<PathBuf, usize> = HashMap::new();
    for (i, f) in index.files.iter().enumerate() {
        if f.full_path.to_lowercase().ends_with(".binfab") {
            let archive = archive_path(&f.tfi_path, &f.entry);
            let slot = *at.entry(archive.clone()).or_insert_with(|| {
                archives.push((archive, Vec::new()));
                archives.len() - 1
            });
            archives[slot].1.push(i);
        }
    }
    type Found = (String, binfab::RigRefs, Option<String>);
    let per_archive: Vec<Result<Vec<Found>, String>> = archives
        .par_iter()
        .map(|(archive, files)| {
            let content = read_archive_content(archive).map_err(|e| e.to_string())?;
            let mut found = Vec::new();
            for &i in files {
                let f = &index.files[i];
                let data = slice(&content, &f.entry);
                if !binfab::mentions_skeleton(data) {
                    continue;
                }
                let Some(refs) = binfab::extract_rig_refs(data) else { continue };
                let key = binfab::identity_name_key(data)?;
                found.push((format!("prefabs/{}", f.full_path), refs, key));
            }
            Ok(found)
        })
        .collect();
    let mut rows = Vec::new();
    let mut names = Vec::new();
    let mut language: Option<Arc<LanguageMap>> = None;
    for found in per_archive {
        for (full, refs, key) in found? {
            for (bp, ap) in &refs.parts {
                let mesh = refs.scales.iter().find(|(b, _)| b == bp).map(|s| s.1).unwrap_or(1.0);
                rows.push(Row { prefab: full.clone(), blueprint: bp.clone(), skeleton: refs.skeleton.clone(), ap: ap.clone(), mesh_scale: mesh, head_scale: refs.head_scale });
            }
            let Some(key) = key.filter(|k| k.starts_with('$')) else { continue };
            let lang = match &language {
                Some(l) => l,
                None => language.insert(load_language_map(&GameFiles::open(game), "en").map_err(|e| e.to_string())?),
            };
            if let Some(name) = lang.get(&key).or_else(|| lang.get(key.trim_start_matches('$'))).filter(|n| !n.is_empty()) {
                match names.iter_mut().find(|(k, _): &&mut (String, String)| *k == full) {
                    Some(slot) => slot.1 = name.clone(),
                    None => names.push((full.clone(), name.clone())),
                }
            }
        }
    }
    Ok((rows, names))
}

#[derive(Default)]
struct State {
    sig: Option<Py>,
    map: Option<Arc<RigMap>>,
    building: bool,
    error: Option<String>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    f(STATE.lock().get_or_insert_with(State::default))
}

fn load_or_build(game: &Path) -> Result<(Py, RigMap), String> {
    let sig = signature(game)?;
    let cache = cache_file()?;
    let mut loaded = None;
    if cache.exists() {
        if let Some(saved) = std::fs::read_to_string(&cache).ok().and_then(|t| pyobj::loads(&t).ok()) {
            if !matches!(saved, Py::Dict(_)) {
                return Err(format!("'{}' object has no attribute 'get'", py_type(&saved)));
            }
            if saved.get("signature").is_some_and(|s| s.py_eq(&sig)) {
                // Missing keys (or null rows) mean a rescan; malformed rows are an error.
                if let (Some(rows), Some(_)) = (saved.get("rows"), saved.get("names")) {
                    if *rows != Py::None {
                        loaded = Some(rows_from(&saved)?);
                    }
                }
            }
        }
    }
    let (rows, names) = match loaded {
        Some(v) => v,
        None => {
            let (rows, names) = scan(game)?;
            std::fs::write(&cache, cache_json(&sig, &rows, &names)).map_err(|e| e.to_string())?;
            (rows, names.into_iter().collect())
        }
    };
    Ok((sig, build_map(rows, names)))
}

fn py_type(p: &Py) -> &'static str {
    match p {
        Py::None => "NoneType",
        Py::Bool(_) => "bool",
        Py::Int(_) => "int",
        Py::Float(_) => "float",
        Py::Str(_) => "str",
        Py::List(_) => "list",
        Py::Dict(_) => "dict",
    }
}

/// `rig_map(game)`: the map, or `None` while it is still being built in the background.
pub fn rig_map(game: &Path) -> Option<Arc<RigMap>> {
    let key = py::path_str_flat(game);
    let start = with_state(|s| {
        if let (Some(map), Some(Py::List(sig))) = (&s.map, &s.sig) {
            if matches!(sig.get(1), Some(Py::Str(g)) if *g == key) {
                return Err(map.clone());
            }
        }
        if s.building {
            return Ok(false);
        }
        s.building = true;
        s.error = None;
        Ok(true)
    });
    match start {
        Err(map) => Some(map),
        Ok(false) => None,
        Ok(true) => {
            let game = game.to_path_buf();
            std::thread::Builder::new()
                .name("blueprint-rig-index".into())
                .spawn(move || {
                    let outcome = load_or_build(&game);
                    with_state(|s| {
                        match outcome {
                            Ok((sig, map)) => {
                                s.sig = Some(sig);
                                s.map = Some(Arc::new(map));
                                s.error = None;
                            }
                            Err(e) => s.error = Some(e),
                        }
                        s.building = false;
                    });
                })
                .ok();
            None
        }
    }
}

/// `index_status()["error"]`.
pub fn index_error() -> Option<String> {
    with_state(|s| s.error.clone())
}

fn known(basename: &str, rig: &RigMap) -> Option<String> {
    static STYLE: OnceLock<Regex> = OnceLock::new();
    static TIER: OnceLock<Regex> = OnceLock::new();
    let style = STYLE.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap());
    let tier = TIER.get_or_init(|| Regex::new(r"_lvl\d+").unwrap());
    if rig.by_blueprint.contains_key(basename) {
        return Some(basename.to_string());
    }
    let mut seen = vec![basename.to_string()];
    let unstyled = style.replace_all(basename, "").into_owned();
    for cand in [unstyled.clone(), tier.replace_all(basename, "").into_owned(), tier.replace_all(&unstyled, "").into_owned()] {
        let cand = py::strip(&cand).trim_matches('_').to_string();
        if !cand.is_empty() && !seen.contains(&cand) {
            if rig.by_blueprint.contains_key(&cand) {
                return Some(cand);
            }
            seen.push(cand);
        }
    }
    None
}

/// `Counter(...).most_common(1)[0][0]`: ties go to the first one counted.
fn most_common<T: PartialEq + Clone>(items: impl Iterator<Item = T>) -> Option<T> {
    let mut counts: Vec<(T, usize)> = Vec::new();
    for item in items {
        match counts.iter_mut().find(|(k, _)| *k == item) {
            Some(slot) => slot.1 += 1,
            None => counts.push((item, 1)),
        }
    }
    let best = counts.iter().map(|c| c.1).max()?;
    counts.into_iter().find(|c| c.1 == best).map(|c| c.0)
}

/// `resolve`: which creature a mod's parts belong to, `(skeleton, [(basename, socket)])`.
pub fn resolve(rig: &RigMap, basenames: &[String]) -> (Option<String>, Vec<(String, String)>) {
    let mut hits: Vec<(String, (String, String))> = Vec::new();
    for b in basenames {
        if let Some(key) = known(b, rig) {
            let hit = rig.by_blueprint[&key].clone();
            match hits.iter_mut().find(|(k, _)| k == b) {
                Some(slot) => slot.1 = hit,
                None => hits.push((b.clone(), hit)),
            }
        }
    }
    let Some(skeleton) = most_common(hits.iter().map(|(_, (s, _))| s.clone())) else { return (None, Vec::new()) };
    let attach = hits.into_iter().filter(|(_, (s, _))| *s == skeleton).map(|(b, (_, ap))| (b, ap)).collect();
    (Some(skeleton), attach)
}

fn scales(rig: &RigMap, skeleton: Option<&str>, attach: &[(String, String)], owners: &[(String, (String, String))]) -> Scales {
    let head = most_common(owners.iter().map(|(_, (prefab, _))| rig.head_scale.get(prefab).copied().unwrap_or(1.0).to_bits())).map(f64::from_bits).unwrap_or(1.0);
    let mut parts = HashMap::new();
    for (b, (prefab, key)) in owners {
        if let Some((_, ap)) = attach.iter().find(|(k, _)| k == b) {
            let hs = rig.head_scale.get(prefab).copied().unwrap_or(1.0);
            let ms = rig.mesh_scale.get(&(prefab.clone(), key.clone())).copied().unwrap_or(1.0);
            parts.insert(b.clone(), assembly::scale_for(ap, skeleton, hs, ms));
        }
    }
    Scales { head, parts }
}

/// `scales_for(rig, attach, skeleton)`.
pub fn scales_for(rig: &RigMap, attach: &[(String, String)], skeleton: Option<&str>) -> Scales {
    let owners: Vec<(String, (String, String))> = attach.iter().filter_map(|(b, _)| known(b, rig).map(|key| (b.clone(), (rig.owner[&key].clone(), key)))).collect();
    scales(rig, skeleton, attach, &owners)
}

/// `creature_scales(rig, prefab)`.
pub fn creature_scales(rig: &RigMap, prefab: &str) -> Scales {
    let Some((skeleton, parts)) = rig.creatures.get(prefab) else { return Scales::default() };
    let owners: Vec<(String, (String, String))> = parts.iter().map(|(b, _)| (b.clone(), (prefab.to_string(), b.clone()))).collect();
    scales(rig, Some(skeleton), parts, &owners)
}

/// `prefab_path(rig, name)`: `(canonical, candidates)`.
pub fn prefab_path(rig: &RigMap, name: &str) -> (Option<String>, Vec<String>) {
    let replaced = name.replace('\\', "/");
    let mut want = py::strip(&replaced).trim_start_matches('/').to_lowercase();
    if want.is_empty() {
        return (None, Vec::new());
    }
    if !want.ends_with(".binfab") {
        want.push_str(".binfab");
    }
    if let Some(found) = rig.by_path.get(&want).or_else(|| rig.by_path.get(&format!("prefabs/{want}"))) {
        return (Some(found.clone()), Vec::new());
    }
    if want.contains('/') {
        return (None, Vec::new());
    }
    let mut candidates = rig.by_stem.get(&want[..want.len() - ".binfab".len()]).cloned().unwrap_or_default();
    if candidates.len() == 1 {
        return (candidates.pop(), Vec::new());
    }
    candidates.sort();
    (None, candidates)
}

// --- search ------------------------------------------------------------------------

const TYPE_RULES: [(&str, &str); 12] = [
    ("magrider", "magrider"),
    ("/boat", "boat"),
    ("wing", "wings"),
    ("dragon", "dragon"),
    ("/mount", "mount"),
    ("/skin", "skin"),
    ("costume", "skin"),
    ("/style", "style"),
    ("/pet", "ally"),
    ("companion", "ally"),
    ("_npc", "ally"),
    ("/npc", "npc"),
];

fn creature_type(prefab: &str) -> &'static str {
    let low = prefab.to_lowercase();
    TYPE_RULES.iter().find(|(needle, _)| low.contains(needle)).map(|r| r.1).unwrap_or("other")
}

/// `search(rig, q, kind, limit)`: `(items, total)`.
pub fn search(rig: &RigMap, q: &str, kind: &str, limit: usize) -> (Vec<Value>, usize) {
    let q = q.to_lowercase();
    let words: Vec<&str> = py::split_ws(&q).collect();
    let mut hits: Vec<(bool, String, &String, Value)> = Vec::new();
    for (prefab, (skeleton, parts)) in &rig.creatures {
        let t = creature_type(prefab);
        if !kind.is_empty() && t != kind {
            continue;
        }
        let name = rig.names.get(prefab).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| py::title_cased_only(py::strip(&prefab_stem(prefab).replace('_', " "))));
        let hay = format!("{name} {}", prefab_stem(prefab)).to_lowercase();
        if !words.is_empty() && !words.iter().all(|w| hay.contains(w)) {
            continue;
        }
        let lname = name.to_lowercase();
        let starts = !words.is_empty() && lname.starts_with(words[0]);
        let item = json!({"path": prefab, "name": name, "codex_type": t, "parts": parts.len(), "animated": !assembly::animations_for(skeleton).is_empty()});
        hits.push((!starts, lname, prefab, item));
    }
    hits.sort_by(|a, b| (a.0, &a.1, a.2).cmp(&(b.0, &b.1, b.2)));
    let total = hits.len();
    (hits.into_iter().take(limit).map(|h| h.3).collect(), total)
}

// --- the specular atlas ------------------------------------------------------------

fn png(width: u32, height: u32, raw: &[u8]) -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, tag: &[u8], body: &[u8]) {
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(tag);
        out.extend_from_slice(body);
        let crc = pyzlib::crc32(&out[start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &pyzlib::compress(raw, 9));
    chunk(&mut out, b"IEND", &[]);
    out
}

/// `dds_to_png`: the top mip of an uncompressed 32-bit DDS as an RGB PNG.
fn dds_to_png(dds: &[u8]) -> Result<Vec<u8>, String> {
    if dds.len() < 128 || &dds[..4] != b"DDS " {
        return Err("not a DDS file".into());
    }
    let u32_at = |at: usize| u32::from_le_bytes(dds[at..at + 4].try_into().unwrap());
    let (height, width) = (u32_at(12), u32_at(16));
    let (pf_flags, fourcc, bits) = (u32_at(80), &dds[84..88], u32_at(88));
    let masks = [u32_at(92), u32_at(96), u32_at(100)];
    if fourcc != b"\0\0\0\0" && fourcc != b"DX10" && pf_flags & 0x4 != 0 {
        return Err(format!("compressed DDS ({}) isn't supported", py::repr_bytes(fourcc)));
    }
    let start = if fourcc == b"DX10" { 148 } else { 128 };
    if bits != 0 && bits != 32 {
        return Err(format!("{bits}-bit DDS isn't supported"));
    }
    let shifts: Vec<u32> = masks.iter().zip([16, 8, 0]).map(|(&m, s)| if m != 0 { m.trailing_zeros() } else { s }).collect();
    let (w, h) = (width as usize, height as usize);
    if w.checked_mul(h).and_then(|n| n.checked_mul(4)).and_then(|n| n.checked_add(start)).is_none_or(|end| end > dds.len()) {
        return Err("unpack_from requires a buffer of at least the image".into());
    }
    let mut raw = Vec::with_capacity(h * (1 + w * 3));
    for y in 0..h {
        raw.push(0);
        let base = start + y * w * 4;
        for x in 0..w {
            let px = u32_at(base + x * 4);
            raw.extend_from_slice(&[(px >> shifts[0]) as u8, (px >> shifts[1]) as u8, (px >> shifts[2]) as u8]);
        }
    }
    Ok(png(width, height, &raw))
}

type PngCache = HashMap<String, Option<Arc<Vec<u8>>>>;

static BRDF: Mutex<Option<PngCache>> = Mutex::new(None);

/// `brdf_png(game)`: cached per install; a DDS that can't be converted is an error.
pub fn brdf_png(game: &Path) -> Result<Option<Arc<Vec<u8>>>, String> {
    let key = py::path_str_flat(game);
    if let Some(hit) = BRDF.lock().as_ref().and_then(|m| m.get(&key).cloned()) {
        return Ok(hit);
    }
    let png = match read_game_file(game, "textures/brdfmap.dds") {
        Some(raw) if !raw.is_empty() => Some(Arc::new(dds_to_png(&raw)?)),
        _ => None,
    };
    BRDF.lock().get_or_insert_with(HashMap::new).insert(key, png.clone());
    Ok(png)
}

#[cfg(test)]
mod tests {
    use crate::codexes::prefab_ally::{clean_localized_text, extract_localization_map};

    #[test]
    fn localized_text() {
        assert_eq!(clean_localized_text("`Dragon\\nKing`"), "Dragon\nKing");
        assert_eq!(clean_localized_text(" `x` "), "`x`");
        let m = extract_localization_map(b"..$prefabs_dragon_name\x18\x06Dragon..");
        assert_eq!(m.get("$prefabs_dragon_name").map(String::as_str), Some("Dragon"));
    }
}
