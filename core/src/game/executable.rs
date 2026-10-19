//! utils/executable.py: find and validate the Trove executable in an install folder.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use parking_lot::Mutex;

fn read_u16(f: &mut File, at: u64) -> std::io::Result<u16> {
    f.seek(SeekFrom::Start(at))?;
    let mut b = [0u8; 2];
    f.read_exact(&mut b)?;
    Ok(u16::from_le_bytes(b))
}

/// Header-only PE check: a GUI executable. Returns `Some(is_64bit)` when valid.
fn validate_pe_header(path: &Path) -> Option<bool> {
    let mut f = File::open(path).ok()?;
    let mut mz = [0u8; 2];
    f.read_exact(&mut mz).ok()?;
    if &mz != b"MZ" {
        return None;
    }
    f.seek(SeekFrom::Start(0x3C)).ok()?;
    let mut off = [0u8; 4];
    f.read_exact(&mut off).ok()?;
    let pe = u32::from_le_bytes(off) as u64;
    f.seek(SeekFrom::Start(pe)).ok()?;
    let mut sig = [0u8; 4];
    f.read_exact(&mut sig).ok()?;
    if &sig != b"PE\0\0" {
        return None;
    }
    let machine = read_u16(&mut f, pe + 4).ok()?;
    let characteristics = read_u16(&mut f, pe + 22).ok()?;
    if characteristics & 0x0002 == 0 {
        return None;
    }
    let subsystem = read_u16(&mut f, pe + 24 + 68).ok()?;
    if subsystem != 2 {
        return None;
    }
    Some(machine == 0x8664)
}

fn utf16le(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Full check for a renamed exe: valid PE header and a Trove identifier in the body.
pub fn analyze_trove_exe(path: &Path) -> Option<bool> {
    let is_64 = validate_pe_header(path)?;
    let content = std::fs::read(path).ok()?;
    let ids = [utf16le("Trove.exe"), utf16le("Trove_x64.exe"), b"Trove.exe".to_vec(), b"Trove_x64.exe".to_vec()];
    if !ids.iter().any(|id| contains(&content, id)) {
        return None;
    }
    Some(is_64)
}

fn ensure_devtool(dir: &Path, exe: &Path) {
    let devtool = dir.join("devtool.bat");
    if devtool.is_file() {
        let name = exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let expected = format!("\"%~dp0{}\" -tool %*", name);
        if let Ok(text) = std::fs::read_to_string(&devtool) {
            if text.trim() != expected {
                let _ = std::fs::write(&devtool, expected);
            }
        }
    }
}

fn resolve(dir: &Path) -> Option<PathBuf> {
    for name in ["Trove_x64.exe", "Trove.exe"] {
        let candidate = dir.join(name);
        if candidate.is_file() && validate_pe_header(&candidate).is_some() {
            return Some(candidate);
        }
    }
    let mut candidates = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort();
    for path in entries {
        let is_exe = path.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false);
        if !is_exe {
            continue;
        }
        if let Some(is_64) = analyze_trove_exe(&path) {
            candidates.push((path, is_64));
        }
    }
    candidates.iter().find(|(_, is64)| *is64).or(candidates.first()).map(|(p, _)| p.clone())
}

fn mtime(dir: &Path) -> u128 {
    std::fs::metadata(dir)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

static CACHE: Mutex<Option<HashMap<(PathBuf, u128), Option<PathBuf>>>> = Mutex::new(None);

/// The Trove exe in `dir`, preferring the 64-bit build. Cached by (dir, dir mtime).
pub fn find_trove_executable(dir: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let key = (dir.to_path_buf(), mtime(dir));
    if let Some(hit) = CACHE.lock().get_or_insert_with(HashMap::new).get(&key) {
        return hit.clone();
    }
    let exe = resolve(dir);
    if let Some(exe) = &exe {
        ensure_devtool(dir, exe);
    }
    let final_key = (dir.to_path_buf(), mtime(dir));
    let mut cache = CACHE.lock();
    let map = cache.get_or_insert_with(HashMap::new);
    map.insert(final_key, exe.clone());
    map.insert(key, exe.clone());
    exe
}
