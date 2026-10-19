//! Trove's `index.tfi` + `archiveN.tfa` pairs (utils/archive_parser.py and the reading
//! half of models/trove/prefab_ally.py).
//!
//! An `index.tfi` is a run of entries: uleb name length, name, then uleb archive index,
//! offset, size and hash. Each `archiveN.tfa` is one zlib stream; an entry's bytes are
//! `decompressed[offset..offset + size]`.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::{Context, Result};
use md5::{Digest, Md5};
use parking_lot::Mutex;
use rayon::prelude::*;

use super::hash::read_uleb;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub name: String,
    pub archive_index: u32,
    pub offset: u32,
    pub size: u32,
    pub hash: u32,
}

/// Parses an `index.tfi` buffer.
pub fn parse_index(data: &[u8]) -> Result<Vec<IndexEntry>> {
    let mut entries = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        let (len, p) = read_uleb(data, pos)?;
        let end = (p + len as usize).min(data.len());
        let raw = &data[p..end];
        let raw = raw.split(|&b| b == 0).next().unwrap_or(raw);
        let name = String::from_utf8_lossy(raw).into_owned();
        pos = end;
        let (archive_index, p) = read_uleb(data, pos)?;
        let (offset, p) = read_uleb(data, p)?;
        let (size, p) = read_uleb(data, p)?;
        let (hash, p) = read_uleb(data, p)?;
        pos = p;
        entries.push(IndexEntry { name, archive_index, offset, size, hash });
    }
    Ok(entries)
}

pub fn read_index_file(path: &Path) -> Result<Vec<IndexEntry>> {
    let data = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    parse_index(&data)
}

/// The `.tfa` an entry lives in, next to its `index.tfi`.
pub fn archive_path(tfi_path: &Path, entry: &IndexEntry) -> PathBuf {
    tfi_path.with_file_name(format!("archive{}.tfa", entry.archive_index))
}

/// Inflates a whole `.tfa`. Trove ends archives on a sync flush with no final block, so
/// like Python's `decompressobj().decompress()` this returns everything up to the end of
/// input instead of requiring a stream end.
pub fn decompress(raw: &[u8]) -> Result<Vec<u8>> {
    use flate2::{Decompress, FlushDecompress, Status};
    let mut d = Decompress::new(true);
    let mut out: Vec<u8> = Vec::with_capacity(raw.len().saturating_mul(2).max(4096));
    loop {
        if out.len() == out.capacity() {
            out.reserve(out.capacity());
        }
        let (in_before, out_before) = (d.total_in(), out.len());
        let rest = &raw[(d.total_in() as usize).min(raw.len())..];
        let status = d
            .decompress_vec(rest, &mut out, FlushDecompress::None)
            .map_err(|e| anyhow::anyhow!("Error -3 while decompressing data: {}", e))?;
        if status == Status::StreamEnd {
            break;
        }
        let drained = d.total_in() as usize >= raw.len() && out.len() < out.capacity();
        if drained || (d.total_in() == in_before && out.len() == out_before) {
            break;
        }
    }
    Ok(out)
}

pub fn decompress_file(path: &Path) -> Result<Vec<u8>> {
    let raw = std::fs::read(path).map_err(|e| anyhow::anyhow!("{}: '{}'", e, path.display()))?;
    decompress(&raw)
}

pub fn md5_hex(data: &[u8]) -> String {
    hex::encode(Md5::digest(data))
}

fn slice<'a>(content: &'a [u8], offset: usize, size: usize) -> &'a [u8] {
    let start = offset.min(content.len());
    let end = (offset + size).min(content.len());
    &content[start..end]
}

/// Inflate one `.tfa`, then md5 the whole archive and each `(key, offset, size)` slice.
pub fn hash_archive_blocking<K: Clone>(tfa: &Path, entries: &[(K, usize, usize)]) -> Result<(String, Vec<(K, String)>)> {
    let content = decompress_file(tfa)?;
    let archive_hash = md5_hex(&content);
    let hashes = entries.iter().map(|(k, off, size)| (k.clone(), md5_hex(slice(&content, *off, *size)))).collect();
    Ok((archive_hash, hashes))
}

/// Inflate one `.tfa` and write each `(offset, size, relative_path)` under `dest_root`.
/// Returns the number of files written.
pub fn extract_archive_files_blocking(tfa: &Path, dest_root: &Path, specs: &[(usize, usize, String)]) -> Result<usize> {
    let content = decompress_file(tfa)?;
    let mut written = 0;
    for (offset, size, rel) in specs {
        let out = dest_root.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&out, slice(&content, *offset, *size))?;
        written += 1;
    }
    Ok(written)
}

/// Every `index.tfi` under the game's archive folders (models/trove/directory.py).
pub fn find_all_indexes(game_root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(game_root) else { return out };
    let mut dirs: Vec<PathBuf> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir() && p.file_name().map(|n| super::DIRECTORIES.contains(&n.to_string_lossy().as_ref())).unwrap_or(false))
        .collect();
    dirs.sort();
    for dir in dirs {
        out.extend(find_index_files(&dir));
    }
    out
}

/// `root.rglob("index.tfi")`, sorted.
pub fn find_index_files(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.file_name().to_string_lossy().eq_ignore_ascii_case("index.tfi"))
        .map(|e| e.into_path())
        .collect();
    out.sort();
    out
}

fn mtime_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0)
}

// --- Decompressed archive cache ------------------------------------------------------

/// Bytes kept inflated at once. Python cached every archive it touched forever; this
/// evicts the oldest instead, which only costs a re-inflate.
const ARCHIVE_CACHE_BUDGET: usize = 768 * 1024 * 1024;

struct ArchiveCache {
    map: HashMap<(PathBuf, u128), Arc<Vec<u8>>>,
    order: VecDeque<(PathBuf, u128)>,
    bytes: usize,
}

static ARCHIVES: Mutex<Option<ArchiveCache>> = Mutex::new(None);

/// A whole inflated `.tfa`, cached by (path, mtime) so a patched archive is never served stale.
pub fn read_archive_content(path: &Path) -> Result<Arc<Vec<u8>>> {
    let mtime = std::fs::metadata(path).map(|m| mtime_ns(&m)).unwrap_or(0);
    let key = (path.to_path_buf(), mtime);
    if let Some(hit) = ARCHIVES.lock().as_ref().and_then(|c| c.map.get(&key).cloned()) {
        return Ok(hit);
    }
    let content = Arc::new(decompress_file(path)?);
    let mut guard = ARCHIVES.lock();
    let cache = guard.get_or_insert_with(|| ArchiveCache { map: HashMap::new(), order: VecDeque::new(), bytes: 0 });
    if !cache.map.contains_key(&key) {
        cache.bytes += content.len();
        cache.map.insert(key.clone(), content.clone());
        cache.order.push_back(key);
        while cache.bytes > ARCHIVE_CACHE_BUDGET && cache.order.len() > 1 {
            if let Some(old) = cache.order.pop_front() {
                if let Some(v) = cache.map.remove(&old) {
                    cache.bytes -= v.len();
                }
            }
        }
    }
    Ok(content)
}

/// The bytes of one entry.
pub fn read_entry(tfi_path: &Path, entry: &IndexEntry) -> Result<Vec<u8>> {
    let content = read_archive_content(&archive_path(tfi_path, entry))?;
    Ok(slice(&content, entry.offset as usize, entry.size as usize).to_vec())
}

// --- Parsed index cache -------------------------------------------------------------

/// One file in a game subtree: the index it is listed in, its full path relative to the
/// subtree root (forward slashes), and its entry.
#[derive(Debug, Clone)]
pub struct IndexedFile {
    pub tfi_path: PathBuf,
    pub full_path: String,
    pub entry: IndexEntry,
}

/// Every file under one subtree (e.g. `<game>/prefabs`), with O(1) lookup by path.
pub struct GameIndex {
    pub files: Vec<IndexedFile>,
    by_path: HashMap<String, usize>,
}

impl GameIndex {
    /// Exact path first, then case-insensitive (prefab_ally.find_index_entry).
    pub fn find(&self, target: &str) -> Option<&IndexedFile> {
        let key = target.replace('\\', "/");
        self.by_path.get(&key).or_else(|| self.by_path.get(&key.to_lowercase())).map(|&i| &self.files[i])
    }

    /// Reads the bytes of the file at `target`, if it exists.
    pub fn read(&self, target: &str) -> Result<Option<Vec<u8>>> {
        match self.find(target) {
            Some(f) => Ok(Some(read_entry(&f.tfi_path, &f.entry)?)),
            None => Ok(None),
        }
    }
}

type Signature = Vec<(PathBuf, u128, u64)>;

static INDEXES: Mutex<Option<HashMap<PathBuf, (Signature, Arc<GameIndex>)>>> = Mutex::new(None);

/// The parsed index of every `index.tfi` under `root`, reused until one changes
/// (prefab_ally._load_index).
pub fn load_index(root: &Path) -> Result<Arc<GameIndex>> {
    let mut found: Signature = Vec::new();
    for tfi in find_index_files(root) {
        if let Ok(meta) = std::fs::metadata(&tfi) {
            found.push((tfi, mtime_ns(&meta), meta.len()));
        }
    }
    found.sort_by(|a, b| a.0.to_string_lossy().cmp(&b.0.to_string_lossy()));

    if let Some((sig, idx)) = INDEXES.lock().as_ref().and_then(|m| m.get(root)) {
        if *sig == found {
            return Ok(idx.clone());
        }
    }

    let parsed: Vec<(PathBuf, String, Vec<IndexEntry>)> = found
        .par_iter()
        .map(|(tfi, _, _)| {
            let prefix = tfi
                .parent()
                .and_then(|p| p.strip_prefix(root).ok())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let entries = read_index_file(tfi).unwrap_or_default();
            (tfi.clone(), prefix, entries)
        })
        .collect();

    let mut files = Vec::new();
    let mut by_path = HashMap::new();
    for (tfi, prefix, entries) in parsed {
        for entry in entries {
            let full = if prefix.is_empty() || prefix == "." { entry.name.clone() } else { format!("{}/{}", prefix, entry.name) };
            let full = full.replace('\\', "/");
            let i = files.len();
            by_path.entry(full.clone()).or_insert(i);
            by_path.entry(full.to_lowercase()).or_insert(i);
            files.push(IndexedFile { tfi_path: tfi.clone(), full_path: full, entry });
        }
    }
    let index = Arc::new(GameIndex { files, by_path });
    INDEXES.lock().get_or_insert_with(HashMap::new).insert(root.to_path_buf(), (found, index.clone()));
    Ok(index)
}

// --- Install resolution (prefab_ally.resolve_game_install) -----------------------------

pub const NO_INSTALL_MESSAGE: &str = "No Trove installation was detected. Add one in Settings > Directories.";

/// The first valid Glyph install, else any valid install.
pub fn detect_first_glyph_install() -> Result<PathBuf> {
    let locations = super::registry::get_trove_locations();
    if let Some(g) = locations.iter().find(|g| g.is_glyph() && g.is_valid()) {
        return Ok(g.path.clone());
    }
    if let Some(g) = locations.iter().find(|g| g.is_valid()) {
        return Ok(g.path.clone());
    }
    anyhow::bail!(NO_INSTALL_MESSAGE)
}

/// The selected install when given (it must hold a Trove exe), else the first detected.
pub fn resolve_game_install(game_path: Option<&str>) -> Result<PathBuf> {
    if let Some(raw) = game_path {
        let raw = raw.trim();
        if !raw.is_empty() {
            let candidate = PathBuf::from(raw);
            if super::executable::find_trove_executable(&candidate).is_some() {
                return Ok(candidate);
            }
            anyhow::bail!("Selected Trove installation is invalid: {}", candidate.display());
        }
    }
    detect_first_glyph_install()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::hash::write_uleb;

    #[test]
    fn inflates_sync_flushed_streams() {
        use flate2::{Compress, Compression, FlushCompress};
        let data: Vec<u8> = (0..100_000u32).flat_map(|i| (i % 251).to_le_bytes()).collect();
        let mut c = Compress::new(Compression::default(), true);
        let mut packed = Vec::with_capacity(data.len());
        c.compress_vec(&data, &mut packed, FlushCompress::Sync).unwrap();
        assert_eq!(decompress(&packed).unwrap(), data);
    }

    #[test]
    #[ignore = "reads the local Trove install"]
    fn inflates_every_real_archive() {
        let root = Path::new(r"C:\Program Files (x86)\Glyph\Games\Trove\Live");
        let mut count = 0;
        for tfi in find_all_indexes(root) {
            for entry in std::fs::read_dir(tfi.parent().unwrap()).unwrap().filter_map(|e| e.ok()) {
                if entry.path().extension().map(|e| e == "tfa").unwrap_or(false) {
                    decompress_file(&entry.path()).unwrap_or_else(|e| panic!("{}: {}", entry.path().display(), e));
                    count += 1;
                }
            }
        }
        assert!(count > 1000, "only {} archives", count);
    }

    #[test]
    fn parses_index_entries() {
        let mut buf = Vec::new();
        for (name, a, o, s, h) in [("a/b.binfab", 0u64, 0u64, 10u64, 99u64), ("c.png", 1, 300, 5, 0xFFFF_FFFF)] {
            buf.extend(write_uleb(name.len() as u64));
            buf.extend(name.as_bytes());
            for v in [a, o, s, h] {
                buf.extend(write_uleb(v));
            }
        }
        let entries = parse_index(&buf).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1], IndexEntry { name: "c.png".into(), archive_index: 1, offset: 300, size: 5, hash: 0xFFFF_FFFF });
    }
}
