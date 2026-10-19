//! File access with the file manager's error wording, and the TFI/TFA naming rules.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::py::{errno_error_basic as io_err, json_error, mtime_ns, text_mode};

/// `TFIndex.archives`: `dir.glob("*.tfa")` in listing order, each with the number from its
/// `archive<N>` stem (Python died on any other name).
pub fn archives_of(tfi: &Path) -> Result<Vec<(PathBuf, u64)>> {
    let dir = tfi.parent().unwrap_or(Path::new("."));
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let matches = if cfg!(windows) { name.to_lowercase().ends_with(".tfa") } else { name.ends_with(".tfa") };
        if matches {
            let path = entry.path();
            let id = archive_id(&path)?;
            out.push((path, id));
        }
    }
    Ok(out)
}

/// `int(re.search(r"^archive(\d+)", path.stem).group(1))`.
pub fn archive_id(path: &Path) -> Result<u64> {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let digits: String = stem.strip_prefix("archive").map(|rest| rest.chars().take_while(char::is_ascii_digit).collect()).unwrap_or_default();
    if digits.is_empty() {
        return Err(anyhow!("'NoneType' object has no attribute 'group'"));
    }
    digits.parse().map_err(|e| anyhow!("{}", e))
}

/// `_stat_sig`: `"<mtime_ns>:<size>"`, or `""` when the stat fails.
pub fn stat_sig(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => format!("{}:{}", mtime_ns(&meta), meta.len()),
        Err(_) => String::new(),
    }
}

/// `BinaryReader(content).seek(offset); read_bytes(size)`.
pub fn binary_read(content: &[u8], offset: i64, size: i64) -> Result<&[u8]> {
    let len = content.len() as i64;
    if offset < 0 || offset > len {
        return Err(anyhow!("BinaryReader Error: cannot seek farther than buffer length."));
    }
    if size < 0 || offset + size > len {
        return Err(anyhow!("BinaryReader Error: cannot read farther than buffer length."));
    }
    Ok(&content[offset as usize..(offset + size) as usize])
}

pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| io_err(e, path))
}

pub fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).map_err(|e| io_err(e, path))
}

pub fn create_dirs(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|e| io_err(e, path))
}

/// `open(path, "w", encoding="utf-8").write(text)`.
pub fn write_text(path: &Path, text: &str) -> Result<()> {
    write_file(path, text_mode(text).as_bytes())
}

/// `json.load(open(path, encoding="utf-8"))`; any bad UTF-8 reads as an invalid start byte.
pub fn read_json(path: &Path) -> Result<Value> {
    let bytes = read_file(path)?;
    let text = String::from_utf8(bytes).map_err(|e| {
        let at = e.utf8_error().valid_up_to();
        anyhow!("'utf-8' codec can't decode byte 0x{:02x} in position {}: invalid start byte", e.as_bytes()[at], at)
    })?;
    serde_json::from_str(&text).map_err(|err| json_error(&text, &err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_errors() {
        assert_eq!(archive_id(Path::new("x/archive12.tfa")).unwrap(), 12);
        assert_eq!(archive_id(Path::new("x/Archive1.tfa")).unwrap_err().to_string(), "'NoneType' object has no attribute 'group'");
    }

    #[test]
    fn binary_reads() {
        let data = b"0123456789";
        assert_eq!(binary_read(data, 2, 3).unwrap(), b"234");
        assert!(binary_read(data, 11, 0).unwrap_err().to_string().contains("seek"));
        assert!(binary_read(data, 8, 5).unwrap_err().to_string().contains("read"));
    }
}
