//! utils/path.py: where the app keeps its data.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

/// Environment variable that relocates the data directory (not on Windows).
pub const DATA_DIR_ENV_VAR: &str = "BTT_DATA_DIR";

/// Windows keeps %APPDATA%/Trove: the game reads ModCfgs from there.
pub fn supports_data_dir_override() -> bool {
    !cfg!(windows)
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Pointer file holding the user's chosen data directory.
pub fn get_data_dir_override_file() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config"));
    base.join("BetterTroveTools").join("data_dir")
}

/// `os.path.expandvars` + `expanduser` on a trimmed string; `None` when empty.
pub fn clean(value: &str) -> Option<PathBuf> {
    let text = expand_vars(value.trim());
    if text.is_empty() {
        return None;
    }
    Some(expand_user(&text))
}

/// `$VAR`, `${VAR}`, and on Windows `%VAR%`. Unknown variables are left as written.
pub fn expand_vars(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '$' {
            if i + 1 < chars.len() && chars[i + 1] == '{' {
                if let Some(end) = chars[i + 2..].iter().position(|&ch| ch == '}') {
                    let name: String = chars[i + 2..i + 2 + end].iter().collect();
                    match std::env::var(&name) {
                        Ok(v) => out.push_str(&v),
                        Err(_) => out.extend(&chars[i..i + 3 + end]),
                    }
                    i += 3 + end;
                    continue;
                }
            } else {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                    end += 1;
                }
                if end > start {
                    let name: String = chars[start..end].iter().collect();
                    match std::env::var(&name) {
                        Ok(v) => out.push_str(&v),
                        Err(_) => out.extend(&chars[i..end]),
                    }
                    i = end;
                    continue;
                }
            }
        } else if c == '%' && cfg!(windows) {
            if let Some(end) = chars[i + 1..].iter().position(|&ch| ch == '%') {
                let name: String = chars[i + 1..i + 1 + end].iter().collect();
                if !name.is_empty() {
                    if let Ok(v) = std::env::var(&name) {
                        out.push_str(&v);
                        i += 2 + end;
                        continue;
                    }
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// A leading `~` becomes the home directory.
pub fn expand_user(s: &str) -> PathBuf {
    if s == "~" {
        return home();
    }
    if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        return home().join(rest);
    }
    PathBuf::from(s)
}

enum Cached {
    Unset,
    Value(Option<PathBuf>),
}

static OVERRIDE_CACHE: Mutex<Cached> = Mutex::new(Cached::Unset);

/// Drops the cached pointer-file read.
pub fn refresh_data_dir_override() {
    *OVERRIDE_CACHE.lock() = Cached::Unset;
}

/// The user's replacement for the default data directory: `BTT_DATA_DIR`, then the
/// pointer file. Always `None` on Windows.
pub fn get_data_dir_override() -> Option<PathBuf> {
    if !supports_data_dir_override() {
        return None;
    }
    if let Some(env) = std::env::var(DATA_DIR_ENV_VAR).ok().and_then(|v| clean(&v)) {
        return Some(env);
    }
    let mut cache = OVERRIDE_CACHE.lock();
    if let Cached::Value(v) = &*cache {
        return v.clone();
    }
    let value = std::fs::read_to_string(get_data_dir_override_file()).ok().and_then(|t| clean(&t));
    *cache = Cached::Value(value.clone());
    value
}

/// Writes (or for an empty path deletes) the pointer file. Applies on next launch.
pub fn set_data_dir_override(path: &str) -> std::io::Result<Option<PathBuf>> {
    let target = clean(path);
    let file = get_data_dir_override_file();
    match &target {
        None => {
            if file.exists() {
                std::fs::remove_file(&file)?;
            }
        }
        Some(t) => {
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&file, t.to_string_lossy().as_bytes())?;
        }
    }
    refresh_data_dir_override();
    Ok(target)
}

/// Windows: %APPDATA%/Trove. Elsewhere: $XDG_DATA_HOME/BetterTroveTools.
pub fn get_default_app_data_dir() -> PathBuf {
    if cfg!(windows) {
        let base = std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Roaming"));
        return base.join("Trove");
    }
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local").join("share"));
    base.join("BetterTroveTools")
}

pub fn get_app_data_dir() -> PathBuf {
    get_data_dir_override().unwrap_or_else(get_default_app_data_dir)
}

/// %APPDATA%/Trove/ModManagerCache. Callers create it when needed.
pub fn get_cache_root() -> PathBuf {
    get_app_data_dir().join("ModManagerCache")
}

/// Where Trove reads per-mod `.cfg` files.
pub fn get_default_mod_cfgs_dir() -> PathBuf {
    get_app_data_dir().join("ModCfgs")
}

/// `mod_cfgs_path` from settings.json, read directly (settings.json is not inside it).
pub fn get_mod_cfgs_override() -> Option<PathBuf> {
    let text = std::fs::read_to_string(get_cache_root().join("settings.json")).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&text).ok()?;
    let raw = settings.get("mod_cfgs_path")?;
    clean(&crate::args::to_str(raw))
}

pub fn get_mod_cfgs_dir() -> PathBuf {
    get_mod_cfgs_override().unwrap_or_else(get_default_mod_cfgs_dir)
}

/// `str(path)` the way Python prints it (native separators).
pub fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_vars() {
        std::env::set_var("BTT_TEST_VAR", "abc");
        assert_eq!(expand_vars("$BTT_TEST_VAR/x"), "abc/x");
        assert_eq!(expand_vars("${BTT_TEST_VAR}y"), "abcy");
        assert_eq!(expand_vars("$NOPE_NOT_SET_9/x"), "$NOPE_NOT_SET_9/x");
        assert_eq!(expand_vars("a$"), "a$");
    }
}
