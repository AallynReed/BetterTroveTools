//! utils/kiwi_blueprint/workshop.py: taking a `.zip` or `.tmod` apart, and zipping files.

use super::pyzlib::{self, ZipError};
use super::tmod;
use super::util::{Error, Kind, Result};

const MAX_FILES: usize = 4000;
const MAX_UNPACKED_BYTES: u64 = 192 * 1024 * 1024;
const JUNK_NAMES: [&str; 4] = [".ds_store", "thumbs.db", "desktop.ini", ".gitkeep"];
const JUNK_DIRS: [&str; 3] = ["__macosx/", ".git/", ".svn/"];

pub type Files = Vec<(String, Vec<u8>)>;

fn err(msg: impl Into<String>) -> Error {
    Error::value(Kind::Workshop, msg)
}

pub fn norm_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized.split('/').filter(|p| !p.is_empty() && *p != "." && *p != "..").collect::<Vec<_>>().join("/")
}

fn is_junk(path: &str) -> bool {
    let low = path.to_lowercase();
    JUNK_NAMES.contains(&low.rsplit('/').next().unwrap_or("")) || JUNK_DIRS.iter().any(|d| low == d[..d.len() - 1] || low.starts_with(d))
}

fn zip_failure(e: ZipError) -> Error {
    match e {
        ZipError::Caught(m) => err(format!("That .zip couldn't be opened: {m}")),
        ZipError::Uncaught(m) => Error::internal(m),
    }
}

/// `read_zip`.
fn read_zip(data: &[u8]) -> Result<Files> {
    let members = pyzlib::zip_members(data).map_err(zip_failure)?;
    let infos: Vec<_> = members.iter().filter(|m| !m.is_dir() && !is_junk(&norm_path(&m.filename))).collect();
    if infos.len() > MAX_FILES {
        return Err(err(format!("That .zip holds more than {MAX_FILES} files - too many for one mod.")));
    }
    if infos.iter().map(|m| m.file_size).sum::<u64>() > MAX_UNPACKED_BYTES {
        return Err(err(format!("That .zip unpacks to more than {} MB.", MAX_UNPACKED_BYTES / (1024 * 1024))));
    }
    let mut out = Vec::new();
    for m in infos {
        let path = norm_path(&m.filename);
        if !path.is_empty() {
            out.push((path, pyzlib::zip_read(data, m).map_err(zip_failure)?));
        }
    }
    if out.is_empty() {
        return Err(err("That .zip has no files in it."));
    }
    Ok(out)
}

/// `read_mod`.
fn read_mod(data: &[u8]) -> Result<(Vec<(String, String)>, Files)> {
    let parsed = tmod::read_tmod(data).map_err(|e| match e {
        Error::Value(Kind::Tmod, m) => err(format!("That isn't a readable .tmod file: {m}")),
        other => other,
    })?;
    let files = parsed.files.into_iter().map(|(p, b)| (norm_path(&p), b)).filter(|(p, _)| !p.is_empty()).collect();
    Ok((parsed.properties, files))
}

/// `(kind, header properties, files)`.
pub type Archive = (&'static str, Vec<(String, String)>, Files);

/// `read_archive`: a `.zip` or a `.tmod` taken apart.
pub fn read_archive(data: &[u8], filename: &str) -> Result<Archive> {
    if data.is_empty() {
        return Err(err("That file is empty."));
    }
    if data.starts_with(b"PK") || filename.to_lowercase().ends_with(".zip") {
        return Ok(("zip", Vec::new(), read_zip(data)?));
    }
    let (props, files) = read_mod(data)?;
    if files.is_empty() {
        return Err(err("That .tmod has no files packed in it."));
    }
    Ok(("tmod", props, files))
}

pub fn to_zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    pyzlib::to_zip(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_junk() {
        assert_eq!(norm_path("\\a/./b/../c//d"), "a/b/c/d");
        assert!(is_junk("__MACOSX/x"));
        assert!(is_junk("a/Thumbs.db"));
        assert!(!is_junk("blueprints/a.blueprint"));
    }
}
