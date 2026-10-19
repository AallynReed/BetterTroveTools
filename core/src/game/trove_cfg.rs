//! utils/trove_cfg.py: read and patch the `[Mods]` section of the game's Trove.cfg.
//! Every write rewrites only the line it changes.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

const TRUTHY: [&str; 4] = ["true", "1", "yes", "on"];

fn disable_all_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)^(\s*DisableAllMods\s*=)(.*)$").unwrap())
}

fn disabled_mods_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)^(\s*DisabledMods\s*=)(.*)$").unwrap())
}

/// `%APPDATA%/Trove/Trove.cfg`.
pub fn get_trove_cfg_path() -> PathBuf {
    crate::paths::get_app_data_dir().join("Trove.cfg")
}

/// The `DisabledMods` key Trove writes for a mod.
pub fn mod_key(title: &str, author: &str, workshop: bool) -> String {
    format!("{}-{}-{}", if workshop { "Workshop" } else { "Trove" }, title, author)
}

fn read_lines(path: &Path) -> Option<Vec<String>> {
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).split('\n').map(String::from).collect())
}

fn write_lines(path: &Path, lines: &[String]) -> bool {
    std::fs::write(path, lines.join("\n")).is_ok()
}

fn mods_lines(lines: &[String]) -> Vec<usize> {
    let mut in_mods = false;
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let stripped = line.trim();
        if stripped.starts_with('[') {
            in_mods = stripped.eq_ignore_ascii_case("[mods]");
            continue;
        }
        if in_mods {
            out.push(i);
        }
    }
    out
}

fn split_entries(value: &str) -> Vec<String> {
    value.split('|').map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect()
}

/// Blanks `[Mods] DisableAllMods` when the game set it. True if the file changed.
pub fn ensure_mods_enabled(cfg_path: Option<&Path>) -> bool {
    let path = cfg_path.map(Path::to_path_buf).unwrap_or_else(get_trove_cfg_path);
    let Some(mut lines) = read_lines(&path) else { return false };
    let mut changed = false;
    for i in mods_lines(&lines) {
        let line = lines[i].clone();
        if let Some(caps) = disable_all_re().captures(&line) {
            if TRUTHY.contains(&caps[2].trim().to_lowercase().as_str()) {
                let eol = if line.ends_with('\r') { "\r" } else { "" };
                lines[i] = format!("{} {}", &caps[1], eol);
                changed = true;
            }
        }
    }
    if !changed || !write_lines(&path, &lines) {
        return false;
    }
    eprintln!("[trove_cfg] cleared DisableAllMods in {}", path.display());
    true
}

/// The keys in `[Mods] DisabledMods`.
pub fn read_disabled_mods(cfg_path: Option<&Path>) -> std::collections::HashSet<String> {
    let path = cfg_path.map(Path::to_path_buf).unwrap_or_else(get_trove_cfg_path);
    let lines = read_lines(&path).unwrap_or_default();
    for i in mods_lines(&lines) {
        if let Some(caps) = disabled_mods_re().captures(&lines[i]) {
            return split_entries(&caps[2]).into_iter().collect();
        }
    }
    Default::default()
}

/// Drops `enable` keys from `DisabledMods` and appends `disable` keys. Creates the line
/// (and `[Mods]`) when missing. True if the file changed.
pub fn set_mods_disabled(enable: &[String], disable: &[String], cfg_path: Option<&Path>) -> bool {
    let path = cfg_path.map(Path::to_path_buf).unwrap_or_else(get_trove_cfg_path);
    let mut disable_unique: Vec<String> = Vec::new();
    for k in disable {
        if !k.is_empty() && !disable_unique.contains(k) {
            disable_unique.push(k.clone());
        }
    }
    let mut lines = read_lines(&path).unwrap_or_else(|| vec![String::new()]);

    let mut target = None;
    let mut prefix = "DisabledMods =".to_string();
    let mut entries = Vec::new();
    for i in mods_lines(&lines) {
        if let Some(caps) = disabled_mods_re().captures(&lines[i]) {
            target = Some(i);
            prefix = caps[1].to_string();
            entries = split_entries(&caps[2]);
            break;
        }
    }

    let mut updated: Vec<String> = entries.iter().filter(|e| !enable.contains(e)).cloned().collect();
    for k in &disable_unique {
        if !updated.contains(k) {
            updated.push(k.clone());
        }
    }
    if updated == entries {
        return false;
    }

    let eol = if lines[0].ends_with('\r') { "\r" } else { "" };
    let new_line = format!("{} {}{}", prefix, updated.join("|"), eol);
    let header = lines.iter().position(|l| l.trim().eq_ignore_ascii_case("[mods]"));
    if let Some(t) = target {
        lines[t] = new_line;
    } else if let Some(h) = header {
        lines.insert(h + 1, new_line);
    } else {
        let last = lines.len() - 1;
        if !lines[last].trim().is_empty() {
            lines[last].push_str(eol);
            lines.push(String::new());
        }
        let last = lines.len() - 1;
        lines.splice(last.., [format!("[Mods]{}", eol), new_line, String::new()]);
    }
    write_lines(&path, &lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_disabled_mods() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("Trove.cfg");
        std::fs::write(&cfg, "[Video]\r\nX = 1\r\n[Mods]\r\nDisableAllMods = true\r\nDisabledMods = Trove-A-b|Trove-C-d\r\n").unwrap();
        assert!(ensure_mods_enabled(Some(&cfg)));
        assert!(set_mods_disabled(&["Trove-A-b".into()], &["Workshop-E-f".into()], Some(&cfg)));
        let text = std::fs::read_to_string(&cfg).unwrap();
        assert_eq!(text, "[Video]\r\nX = 1\r\n[Mods]\r\nDisableAllMods = \r\nDisabledMods = Trove-C-d|Workshop-E-f\r\n");
        let keys = read_disabled_mods(Some(&cfg));
        assert!(keys.contains("Trove-C-d") && keys.contains("Workshop-E-f"));
    }

    #[test]
    fn creates_section() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("Trove.cfg");
        std::fs::write(&cfg, "[Video]\nX = 1").unwrap();
        assert!(set_mods_disabled(&[], &["Trove-A-b".into()], Some(&cfg)));
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), "[Video]\nX = 1\n[Mods]\nDisabledMods = Trove-A-b\n");
    }
}
