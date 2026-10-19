//! backend/codexes/codex_cache.py: one JSON cache per codex, served stale while it
//! refreshes in the background, with at most one build per codex at a time.

use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use serde_json::{json, Map, Value};

use crate::py;
use crate::game::archive;
use crate::json::{dumps_indent, dumps_with, DumpOpts};
use crate::paths::get_cache_root;
use crate::{Args, Resp};

pub const CACHE_EXPIRY_SECONDS: i64 = 60 * 60 * 12;

/// Matched against build errors so the page gets the codex's own wording.
const NO_INSTALL_ERROR: &str = "No valid Glyph Trove installation was detected.";

pub type Dataset = (Map<String, Value>, Map<String, Value>);

pub struct BuildArgs<'a> {
    pub game_path: &'a Path,
    pub locale: &'a str,
    pub extract_dir: Option<PathBuf>,
}

/// `threading.Lock`, holdable across threads.
struct BuildLock {
    busy: Mutex<bool>,
    freed: Condvar,
}

struct Held(&'static BuildLock);

impl Drop for Held {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.0.freed.notify_all();
    }
}

impl BuildLock {
    const fn new() -> Self {
        BuildLock { busy: Mutex::new(false), freed: Condvar::new() }
    }

    fn acquire(&'static self) -> Held {
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        while *busy {
            busy = self.freed.wait(busy).unwrap_or_else(|e| e.into_inner());
        }
        *busy = true;
        Held(self)
    }

    fn try_acquire(&'static self) -> Option<Held> {
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        if *busy {
            return None;
        }
        *busy = true;
        Some(Held(self))
    }
}

/// One game-file codex: its cache files, freshness rules and endpoints.
pub struct Codex {
    pub key: &'static str,
    pub label: &'static str,
    pub dataset: fn(&BuildArgs) -> Result<Dataset>,
    /// Set by codexes that had a breaking cache-shape change; a mismatch rebuilds.
    pub schema_version: Option<i64>,
    /// Scratch directory under the cache root (allies).
    pub extract_subdir: Option<&'static str>,
    lock: BuildLock,
}

impl Codex {
    pub const fn new(key: &'static str, label: &'static str, dataset: fn(&BuildArgs) -> Result<Dataset>, schema_version: Option<i64>, extract_subdir: Option<&'static str>) -> Self {
        Codex { key, label, dataset, schema_version, extract_subdir, lock: BuildLock::new() }
    }

    /// The first writable of the user cache and the temp dir.
    pub fn root(&self) -> Result<PathBuf> {
        let candidates = [get_cache_root().join("codexes_cache"), std::env::temp_dir().join("BetterTroveToolsCache").join("codexes_cache")];
        for root in candidates {
            if std::fs::create_dir_all(&root).is_err() {
                continue;
            }
            let probe = root.join(format!(".{}_cache_probe", self.key));
            if std::fs::write(&probe, "ok").is_err() {
                continue;
            }
            let _ = std::fs::remove_file(&probe);
            return Ok(root);
        }
        bail!("No writable cache directory is available for {} data.", self.key)
    }

    pub fn cache_file(&self) -> Result<PathBuf> {
        Ok(self.root()?.join(format!("{}_game_cache.json", self.key)))
    }

    pub fn manifest_file(&self) -> Result<PathBuf> {
        Ok(self.root()?.join(format!("{}_game_cache_manifest.json", self.key)))
    }

    /// `(cache holds data, manifest)`. Unreadable files read as missing / `{}`.
    fn read(&self) -> Result<(bool, Value)> {
        let manifest_file = self.manifest_file()?;
        let manifest = std::fs::read(&manifest_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}));
        let has_data = std::fs::read(self.cache_file()?).ok().is_some_and(|b| {
            serde_json::from_slice::<serde::de::IgnoredAny>(&b).is_ok() && !b.trim_ascii_start().starts_with(b"null")
        });
        Ok((has_data, manifest))
    }

    fn write(&self, (data, manifest): Dataset) -> Result<Value> {
        let (data, manifest) = (Value::Object(data), Value::Object(manifest));
        std::fs::write(self.cache_file()?, dump_data(&data))?;
        std::fs::write(self.manifest_file()?, dump_manifest(&manifest))?;
        Ok(manifest)
    }

    fn compatible(&self, manifest: &Value, game_path: &Path) -> Result<bool> {
        let m = py::as_dict(manifest)?;
        if let Some(version) = self.schema_version {
            let raw = m.get("cache_schema_version").cloned().unwrap_or(json!(0));
            let found = if crate::args::truthy(&raw) { py::int_strip_underscores(&raw)? } else { 0 };
            if found != version {
                return Ok(false);
            }
        }
        let recorded = m.get("game_path").map(py::str_loose_pyfloat).unwrap_or_default();
        let recorded = py::strip(&recorded);
        Ok(recorded.is_empty() || py::same_path_simple(recorded, &py::path_str_simple(game_path)))
    }

    fn fresh(&self, manifest: &Value, game_path: &Path) -> Result<bool> {
        if !self.compatible(manifest, game_path)? {
            return Ok(false);
        }
        Ok(age(manifest).is_some_and(|a| a < CACHE_EXPIRY_SECONDS))
    }

    fn build_dataset(&self, game_path: &Path) -> Result<Dataset> {
        let extract_dir = match self.extract_subdir {
            Some(sub) => Some(self.root()?.join(sub)),
            None => None,
        };
        let (data, manifest) = (self.dataset)(&BuildArgs { game_path, locale: "en", extract_dir })?;
        let generated_at = now() as i64;
        let mut full = manifest;
        full.insert("generated_at".into(), json!(generated_at));
        full.insert("expires_at".into(), json!(generated_at + CACHE_EXPIRY_SECONDS));
        full.insert("cache_file".into(), json!(py::path_str_simple(&self.cache_file()?)));
        full.insert("cache_expiry_seconds".into(), json!(CACHE_EXPIRY_SECONDS));
        if let Some(v) = self.schema_version {
            full.insert("cache_schema_version".into(), json!(v));
        }
        Ok((data, full))
    }

    fn refresh_in_background(&'static self, game_path: PathBuf) {
        let Some(held) = self.lock.try_acquire() else { return };
        let _ = std::thread::Builder::new().name(format!("codex-refresh-{}", self.key)).spawn(move || {
            let _held = held;
            if let Ok(built) = self.build_dataset(&game_path) {
                let _ = self.write(built);
            }
        });
    }

    /// `(manifest, source)`: `game-cache` (fresh), `game-cache-stale` (served while a
    /// background refresh runs) or `game-live` (built now).
    pub fn build(&'static self, force_refresh: bool, game_path: Option<&str>) -> Result<(Value, &'static str)> {
        let game_path = resolve_install(game_path)?;
        let (has_data, manifest) = self.read()?;
        if !force_refresh && has_data {
            if self.fresh(&manifest, &game_path)? {
                return Ok((manifest, "game-cache"));
            }
            // Stale only by age is served; a wrong install or schema rebuilds now.
            if self.compatible(&manifest, &game_path)? {
                self.refresh_in_background(game_path);
                return Ok((manifest, "game-cache-stale"));
            }
        }
        let _held = self.lock.acquire();
        let (has_data, manifest) = self.read()?;
        if !force_refresh && has_data && self.fresh(&manifest, &game_path)? {
            return Ok((manifest, "game-cache"));
        }
        let manifest = self.write(self.build_dataset(&game_path)?)?;
        Ok((manifest, "game-live"))
    }

    /// Blocks until no build or background refresh is running.
    pub fn wait_idle(&'static self) {
        drop(self.lock.acquire());
    }

    /// `get_<key>_data(force_refresh=False, game_path_str="")`.
    pub fn get_data(&'static self, a: &Args) -> Result<Value> {
        let built = self.build(a.bool_or(0, false), a.opt_str(1).as_deref());
        let (manifest, source) = match built {
            Ok(ok) => ok,
            Err(err) => {
                let mut message = err.to_string();
                if message.contains(NO_INSTALL_ERROR) {
                    message = format!("{} could not be loaded because no valid Glyph Trove installation was found.", self.label);
                }
                return Ok(Resp::fail(message, &format!("GET_{}_DATA_FAILED", self.key.to_uppercase())).into());
            }
        };
        // The payload itself is fetched from /api/cache/<file>: it runs to tens of MB.
        let cache_file = self.cache_file()?;
        let cache_url = if cache_file.exists() { format!("/api/cache/{}", cache_file.file_name().unwrap_or_default().to_string_lossy()) } else { String::new() };
        let mut cache = manifest.as_object().cloned().unwrap_or_default();
        cache.insert("cache_url".into(), json!(cache_url));
        Ok(Resp::ok(json!({})).with("source", source).with("cache_file", cache_url).meta(json!({ "cache": cache })).into())
    }

    /// `clear_<key>_cache()`: deletes both files, or blanks one Windows keeps locked.
    pub fn clear_cache(&'static self) -> Result<Value> {
        let manifest_file = self.manifest_file()?;
        let mut cleared = Vec::new();
        for path in [self.cache_file()?, manifest_file.clone()] {
            if !path.exists() {
                continue;
            }
            if std::fs::remove_file(&path).is_err() {
                let blank = if path == manifest_file { json!({"generated_at": 0, "expires_at": 0}) } else { json!({}) };
                std::fs::write(&path, text_file(dumps_indent(&blank, 2)))?;
            }
            cleared.push(py::path_str_simple(&path));
        }
        Ok(Resp::ok(json!({ "cleared": cleared })).into())
    }
}

/// `resolve_game_install` with the path printed the way pathlib prints it.
pub fn resolve_install(game_path: Option<&str>) -> Result<PathBuf> {
    let normalized = game_path.map(|raw| {
        let raw = py::strip(raw);
        if raw.is_empty() {
            String::new()
        } else {
            py::normalize_simple(raw)
        }
    });
    let found = archive::resolve_game_install(normalized.as_deref())?;
    Ok(PathBuf::from(py::path_str_simple(&found)))
}

/// The cache file: `json.dumps(data, separators=(",", ":"), ensure_ascii=False)`.
pub fn dump_data(data: &Value) -> String {
    dumps_with(data, DumpOpts { indent: None, ensure_ascii: false, compact: true, sort_keys: false })
}

/// The manifest file: `json.dumps(manifest, indent=2)` written in text mode.
pub fn dump_manifest(manifest: &Value) -> String {
    text_file(dumps_indent(manifest, 2))
}

/// Python's text-mode write: `\n` becomes `\r\n` on Windows.
fn text_file(s: String) -> String {
    if cfg!(windows) {
        s.replace('\n', "\r\n")
    } else {
        s
    }
}

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}


/// Whole seconds since `generated_at`, never negative; `None` when it isn't a number.
fn age(manifest: &Value) -> Option<i64> {
    let generated = match manifest.get("generated_at")? {
        Value::Number(n) => n.as_f64()?,
        Value::Bool(b) => *b as i64 as f64,
        _ => return None,
    };
    Some(((now() - generated).trunc() as i64).max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_freshness_rules() {
        assert_eq!(age(&json!({"generated_at": "x"})), None);
        assert!(age(&json!({"generated_at": now() - 10.5})).unwrap() >= 10);
        assert_eq!(py::int_strip_underscores(&json!("  2 ")).unwrap(), 2);
        assert_eq!(py::int_strip_underscores(&json!(1.9)).unwrap(), 1);
        assert_eq!(py::as_dict(&json!([])).unwrap_err().to_string(), "'list' object has no attribute 'get'");
        assert_eq!(py::str_loose_pyfloat(&json!(null)), "None");
    }
}
