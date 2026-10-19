//! `TroveModList`: every mod of one install, read from its `mods` folder (and Steam
//! Workshop folder), with name/file conflicts and Trovesaurus data.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};

use super::compat::{self, file_stem, py_str};
use super::model::TroveMod;
use super::trovesaurus;
use super::zipmod::is_zipfile;
use crate::game::registry::TroveGamePath;

const MODS_ALL_URL: &str = "https://trovesaurus.com/api/mods-all";
const HASHES_TO_MODS_URL: &str = "https://trovesaurus.com/api/mods-hashes-to-mods";

/// `TroveModList(path, **kwargs)`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ListOptions {
    /// Recompute conflicts from scratch.
    pub force: bool,
    /// Rename mods to `<title>.tmod`.
    pub fix_names: bool,
    /// Place or complete each mod's `ModCfgs` file.
    pub fix_configs: bool,
    /// Read only the headers; file bytes load on first use.
    pub partial: bool,
}

/// A blocklist predicate over a raw Trovesaurus catalog entry.
pub type Blocked<'a> = &'a dyn Fn(&Value) -> bool;

#[derive(Debug, Clone)]
pub struct TroveModList {
    pub trove_path: TroveGamePath,
    pub mods: Vec<TroveMod>,
    /// Mods whose `.cfg` could not be written (read-only or locked).
    pub read_only_configs: Vec<String>,
}

/// `path.with_suffix(suffix)`.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    path.with_file_name(format!("{}{}", file_stem(path), suffix))
}

/// The first `header_size` bytes of a `.tmod` (`f.read(8)`, then `f.read(header_size)`).
fn read_header_bytes(path: &Path) -> Result<Vec<u8>> {
    let read = || -> std::io::Result<Vec<u8>> {
        let mut f = std::fs::File::open(path)?;
        let mut first = Vec::with_capacity(8);
        (&mut f).take(8).read_to_end(&mut first)?;
        let mut size = [0u8; 8];
        size[..first.len()].copy_from_slice(&first);
        f.seek(SeekFrom::Start(0))?;
        let mut out = Vec::new();
        (&mut f).take(u64::from_le_bytes(size)).read_to_end(&mut out)?;
        Ok(out)
    };
    read().map_err(|e| compat::errno_error(e, path))
}

fn type_of(name: Option<&str>) -> &'static str {
    if name.is_some() {
        "str"
    } else {
        "NoneType"
    }
}

/// `list.sort(key=lambda m: m.name)`: a `None` title makes Python's sort raise. The
/// comparison it fails on is approximated (CPython's run detection, then insertion).
fn sort_by_name(mods: &mut [TroveMod]) -> Result<()> {
    if mods.iter().all(|m| m.name().is_some()) {
        mods.sort_by(|a, b| a.name().cmp(&b.name()));
        return Ok(());
    }
    let keys: Vec<Option<&str>> = mods.iter().map(|m| m.name()).collect();
    let lt = |a: Option<&str>, b: Option<&str>| -> Result<bool> {
        match (a, b) {
            (Some(a), Some(b)) => Ok(a < b),
            _ => Err(anyhow!("'<' not supported between instances of '{}' and '{}'", type_of(a), type_of(b))),
        }
    };
    let mut n = 1;
    while n < keys.len() {
        if lt(keys[n], keys[n - 1])? {
            break;
        }
        n += 1;
    }
    let mut sorted: Vec<Option<&str>> = keys[..n].to_vec();
    for &pivot in &keys[n..] {
        let (mut lo, mut hi) = (0, sorted.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if lt(pivot, sorted[mid])? {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        sorted.insert(lo, pivot);
    }
    Ok(())
}

impl TroveModList {
    pub fn new(trove_path: TroveGamePath, opts: ListOptions) -> Result<Self> {
        let mut list = TroveModList { trove_path, mods: Vec::new(), read_only_configs: Vec::new() };
        list.populate(opts)?;
        Ok(list)
    }

    /// `refresh()`: a full (not header-only) re-read with fresh conflicts.
    pub fn refresh(&mut self) -> Result<()> {
        self.populate(ListOptions { force: true, ..Default::default() })
    }

    pub fn name(&self) -> String {
        self.trove_path.name()
    }

    pub fn count(&self) -> usize {
        self.mods.len()
    }

    pub fn enabled(&self) -> Vec<&TroveMod> {
        self.mods.iter().filter(|m| m.enabled).collect()
    }

    pub fn disabled(&self) -> Vec<&TroveMod> {
        self.mods.iter().filter(|m| !m.enabled).collect()
    }

    pub fn mods_with_conflicts(&self) -> Vec<&TroveMod> {
        self.mods.iter().filter(|m| m.has_conflicts()).collect()
    }

    /// The mods `self.mods[i]` conflicts with (`mod.conflicts`), duplicates included.
    pub fn conflicts_of(&self, i: usize) -> Vec<&TroveMod> {
        self.mods[i].conflicts().into_iter().map(|j| &self.mods[j]).collect()
    }

    /// `all_hashes`: every non-Workshop mod's hash.
    pub fn all_hashes(&mut self) -> Result<Vec<String>> {
        self.mods.iter_mut().filter(|m| !m.is_workshop).map(|m| m.hash()).collect()
    }

    fn populate(&mut self, opts: ListOptions) -> Result<()> {
        self.mods.clear();
        self.ensure_correct_extensions()?;
        let game = self.trove_path.clone();
        for (files, enabled) in [(game.enabled_tmods(), true), (game.disabled_tmods(), false)] {
            for file in files {
                let data = if opts.partial { read_header_bytes(&file)? } else { compat::read_bytes(&file)? };
                let mut m = TroveMod::read_tmod(&file, data, opts.partial)?;
                m.enabled = enabled;
                m.is_workshop = game.is_workshop_file(&file);
                if m.has_wrong_name() && opts.fix_names && !m.is_workshop {
                    m.fix_name()?;
                }
                self.mods.push(m);
            }
        }
        for (files, enabled) in [(game.enabled_zips(), true), (game.disabled_zips(), false)] {
            for file in files {
                let mut m = TroveMod::read_zip(&file, compat::read_bytes(&file)?)?;
                m.enabled = enabled;
                m.is_workshop = game.is_workshop_file(&file);
                self.mods.push(m);
            }
        }
        sort_by_name(&mut self.mods)?;
        self.calculate_conflicts(opts.force);
        if opts.fix_configs {
            self.ensure_mod_configs()?;
        }
        Ok(())
    }

    /// Renames `.tmod`s that are zips to `.zip` and back. Steam owns Workshop files,
    /// so those are left alone.
    fn ensure_correct_extensions(&self) -> Result<()> {
        let game = &self.trove_path;
        let fix = |files: Vec<PathBuf>, want_zip: bool, target: &dyn Fn(&Path) -> PathBuf| -> Result<()> {
            for file in files {
                if is_zipfile(&file) == want_zip && !game.is_workshop_file(&file) {
                    compat::rename(&file, &target(&file))?;
                }
            }
            Ok(())
        };
        fix(game.enabled_tmods(), true, &|f| with_suffix(f, ".zip"))?;
        fix(game.disabled_tmods(), true, &|f| with_suffix(&with_suffix(f, ""), ".zip.disabled"))?;
        fix(game.enabled_zips(), false, &|f| with_suffix(f, ".tmod"))?;
        fix(game.disabled_zips(), false, &|f| with_suffix(&with_suffix(f, ""), ".tmod.disabled"))
    }

    fn calculate_conflicts(&mut self, force: bool) {
        let files: Vec<HashSet<String>> = self.mods.iter().map(|m| m.content_files().into_iter().collect()).collect();
        let names: Vec<Option<String>> = self.mods.iter().map(|m| m.name().map(String::from)).collect();
        for i in 0..self.mods.len() {
            if force {
                self.mods[i].name_conflicts.clear();
                self.mods[i].file_conflicts.clear();
            }
            for j in 0..self.mods.len() {
                if i == j {
                    continue;
                }
                if names[j] == names[i] {
                    self.mods[i].name_conflicts.push(j);
                }
                if self.mods[i].file_conflicts.contains(&j) {
                    continue;
                }
                if !files[i].is_disjoint(&files[j]) {
                    self.mods[i].file_conflicts.push(j);
                    if !self.mods[j].file_conflicts.contains(&i) {
                        self.mods[j].file_conflicts.push(i);
                    }
                }
            }
            let mut seen = HashSet::new();
            self.mods[i].file_conflicts.retain(|j| seen.insert(*j));
        }
    }

    fn ensure_mod_configs(&mut self) -> Result<()> {
        self.read_only_configs.clear();
        for m in &self.mods {
            if !(m.is_ui_mod() || m.config_path().is_some()) {
                continue;
            }
            if let Err(e) = m.ensure_config() {
                if !compat::is_os_error(&e) {
                    return Err(e);
                }
                let name = m.name().filter(|n| !n.is_empty()).unwrap_or("Unknown Mod");
                self.read_only_configs.push(name.to_string());
            }
        }
        Ok(())
    }

    /// `_get_cached_mods_all`: Trovesaurus' master list, cached for 15 minutes in
    /// `ModManagerCache/trovesaurus_mods_all.json`, with the stale copy as a fallback.
    pub fn get_cached_mods_all(&self, force: bool) -> Result<Value> {
        let cache_dir = crate::paths::get_cache_root();
        compat::mkdir_all(&cache_dir)?;
        let cache_file = cache_dir.join("trovesaurus_mods_all.json");
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);

        if cache_file.exists() && !force {
            let text = compat::read_text(&cache_file)?;
            if let Ok(Value::Object(wrapper)) = serde_json::from_str::<Value>(&text) {
                let ts = match wrapper.get("timestamp") {
                    None => 0.0,
                    Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
                    Some(Value::Bool(b)) => *b as u8 as f64,
                    Some(other) => return Err(anyhow!("unsupported operand type(s) for -: 'float' and '{}'", compat::type_name(other))),
                };
                if now() - ts < 900.0 {
                    return Ok(wrapper.get("data").cloned().unwrap_or_else(|| Value::Object(Map::new())));
                }
            }
        }

        let fetched = (|| -> Result<Option<Value>> {
            let req = crate::ctx::try_ctx().map(|c| c.external_request("Fetching Master Mod List", MODS_ALL_URL));
            let resp = crate::http::send(crate::http::get(MODS_ALL_URL).timeout(Duration::from_secs(15)))?;
            let ok = resp.status() == 200;
            if let Some(r) = req {
                r.finish(ok);
            }
            if !ok {
                return Ok(None);
            }
            let data = crate::http::read_json(resp)?;
            let wrapper = serde_json::json!({ "timestamp": now(), "data": data });
            compat::write_text(&cache_file, &crate::json::dumps(&wrapper))?;
            Ok(Some(data))
        })();
        match fetched {
            Ok(Some(data)) => return Ok(data),
            Ok(None) => {}
            Err(e) => eprintln!("Failed to fetch mods-all data: {}", e),
        }

        if cache_file.exists() {
            let text = compat::read_text(&cache_file)?;
            if let Ok(cached) = serde_json::from_str::<Value>(&text) {
                return Ok(match &cached {
                    Value::Object(m) if m.contains_key("data") => m["data"].clone(),
                    _ => cached,
                });
            }
        }
        Ok(Value::Object(Map::new()))
    }

    /// Matches every mod's hash against Trovesaurus and attaches the catalog entry.
    /// `skip_paths` are mods another source already resolved; `blocked` rejects entries
    /// that must never be offered as updates.
    pub fn update_trovesaurus_data(&mut self, force: bool, skip_paths: &HashSet<String>, blocked: Option<Blocked>) -> Result<()> {
        let skipped = |m: &TroveMod| m.is_workshop || skip_paths.contains(&compat::display(&m.mod_path));
        let mut all_hashes = Vec::new();
        for m in self.mods.iter_mut() {
            if !skipped(m) {
                all_hashes.push(m.hash()?);
            }
        }
        if all_hashes.is_empty() {
            return Ok(());
        }
        let mut mods_all = self.get_cached_mods_all(force)?;
        if !compat::truthy(&mods_all) {
            eprintln!("Could not retrieve master mod list.");
            return Ok(());
        }
        if let Value::Array(items) = &mods_all {
            let mut by_id = Map::new();
            for m in items {
                if let Value::Object(o) = m {
                    if let Some(id) = o.get("id") {
                        by_id.insert(py_str(id), m.clone());
                    }
                }
            }
            mods_all = Value::Object(by_id);
        }

        let mut hash_to_id: HashMap<String, Value> = HashMap::new();
        for batch in all_hashes.chunks(200) {
            let joined = batch.join(",");
            let result = (|| -> Result<()> {
                let req = crate::ctx::try_ctx().map(|c| c.external_request("Fetching Mod Hashes", HASHES_TO_MODS_URL));
                let resp = crate::http::send_form(crate::http::post(HASHES_TO_MODS_URL).timeout(Duration::from_secs(10)), &[("hashes", joined.as_str())])?;
                let ok = resp.status() == 200;
                if let Some(r) = req {
                    r.finish(ok);
                }
                if ok {
                    match crate::http::read_json(resp)? {
                        Value::Object(found) => hash_to_id.extend(found),
                        other => return Err(anyhow!("cannot convert dictionary update sequence element #0 to a sequence: {}", compat::type_name(&other))),
                    }
                }
                Ok(())
            })();
            if let Err(e) = result {
                eprintln!("Failed to fetch hash batch: {}", e);
            }
        }

        for m in self.mods.iter_mut() {
            if skipped(m) {
                continue;
            }
            let hash = m.hash()?;
            let Some(mod_id) = hash_to_id.get(&hash).filter(|v| !v.is_null()) else { continue };
            let Value::Object(catalog) = &mods_all else { return Err(anyhow!("'{}' object has no attribute 'get'", compat::type_name(&mods_all))) };
            let Some(raw) = catalog.get(&py_str(mod_id)) else { continue };
            if !compat::truthy(raw) || blocked.map(|b| b(raw)).unwrap_or(false) {
                continue;
            }
            match trovesaurus::Mod::from_value(raw) {
                Ok(mut parsed) => {
                    parsed.installed = true;
                    if let Some(file) = parsed.file_objs.iter().find(|f| f.hash == hash).cloned() {
                        parsed.installed_version = Some(file.version.clone());
                        parsed.installed_file = Some(file);
                    }
                    m.trovesaurus_data = Some(parsed);
                }
                Err(e) => eprintln!("Failed to validate Trovesaurus data for {}: {}", m.name().unwrap_or("None"), e),
            }
        }
        Ok(())
    }
}
