//! models/trove/prefab_ally.py: the shared game-data readers (language strings,
//! blueprint paths, mastery multipliers, collection tables) and the Ally Codex.
//!
//! The index/archive half of the Python module lives in [`crate::game::archive`].

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use anyhow::{bail, Result};
use indexmap::IndexMap;
use rayon::prelude::*;
use regex::Regex;
use serde_json::{json, Map, Value};

use super::binfab::{self, parse_binfab_content, ParsedPrefab};
use super::binfab_reader::{self, parse_collection_table};
use crate::py;
use crate::game::archive::{self, GameIndex, IndexedFile};

pub const PREFAB_PREFIX: &str = "collections/pet/";
pub const ITEM_PET_PREFIX: &str = "item/pet/";
pub const MULTIPLIER_FILE: &str = "meta/multipliers.binfab";
pub const GEODE_MULTIPLIER_FILE: &str = "meta/geode_multipliers.binfab";

static DESIGNER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]+)\]").unwrap());
static PET_NAME_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\$prefabs_[A-Za-z0-9_]+(?:_item)?_name)").unwrap());
static PET_DESCRIPTION_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\$prefabs_[A-Za-z0-9_]+(?:_description|_desc))").unwrap());
static STAT_LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([+-]?\d+(?:\.\d+)?)(%?)\s+(.+)$").unwrap());

// --- Reading files out of the archives -------------------------------------------------

/// One indexed file's bytes, sharing its inflated archive.
#[derive(Clone)]
pub struct Blob {
    buf: Arc<Vec<u8>>,
    start: usize,
    end: usize,
}

impl std::ops::Deref for Blob {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.buf[self.start..self.end]
    }
}

pub use crate::game::archive::{decompress as inflate, read_archive_content};

fn blob(buf: Arc<Vec<u8>>, file: &IndexedFile) -> Blob {
    let start = (file.entry.offset as usize).min(buf.len());
    let end = (file.entry.offset as usize + file.entry.size as usize).min(buf.len());
    Blob { buf, start, end }
}

/// `archive_content[offset:offset + size]` of one indexed file.
pub fn read_file(file: &IndexedFile) -> Result<Blob> {
    Ok(blob(read_archive_content(&archive::archive_path(&file.tfi_path, &file.entry))?, file))
}

/// Reads many files, checking and inflating each archive they touch once (in parallel).
pub fn read_files(files: &[&IndexedFile]) -> Result<Vec<Blob>> {
    let mut keys: Vec<(&Path, u32)> = files.iter().map(|f| (f.tfi_path.as_path(), f.entry.archive_index)).collect();
    keys.sort_unstable();
    keys.dedup();
    let archives: HashMap<(&Path, u32), Arc<Vec<u8>>> = keys
        .into_par_iter()
        .map(|(tfi, n)| Ok(((tfi, n), read_archive_content(&tfi.with_file_name(format!("archive{}.tfa", n)))?)))
        .collect::<Result<_>>()?;
    Ok(files.iter().map(|f| blob(archives[&(f.tfi_path.as_path(), f.entry.archive_index)].clone(), f)).collect())
}

/// Something derived from one parsed index, rebuilt only when the index is reloaded.
struct Derived<T>(parking_lot::Mutex<Option<(Arc<GameIndex>, Arc<T>)>>);

impl<T> Derived<T> {
    const fn new() -> Self {
        Derived(parking_lot::Mutex::new(None))
    }

    fn get(&self, index: &Arc<GameIndex>, build: impl FnOnce() -> Result<T>) -> Result<Arc<T>> {
        if let Some((i, v)) = &*self.0.lock() {
            if Arc::ptr_eq(i, index) {
                return Ok(v.clone());
            }
        }
        let value = Arc::new(build()?);
        *self.0.lock() = Some((index.clone(), value.clone()));
        Ok(value)
    }
}

/// `game_path / "prefabs"`, which must exist.
pub fn require_prefabs_root(game_path: &Path) -> Result<PathBuf> {
    let root = game_path.join("prefabs");
    if !root.exists() {
        bail!("Prefabs directory was not found: {}", py::path_str_simple(&root));
    }
    Ok(root)
}

/// One install as a build sees it: each archive index is loaded (and checked against the
/// files on disk) once per `GameFiles`, not on every lookup as Python did.
pub struct GameFiles {
    path: PathBuf,
    indexes: parking_lot::Mutex<HashMap<PathBuf, Arc<GameIndex>>>,
}

impl GameFiles {
    pub fn open(path: &Path) -> Self {
        GameFiles { path: path.to_path_buf(), indexes: parking_lot::Mutex::new(HashMap::new()) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The parsed index of `<game>/<parts...>` (empty when the folder is missing).
    pub fn index(&self, parts: &[&str]) -> Result<Arc<GameIndex>> {
        let root = parts.iter().fold(self.path.clone(), |p, part| p.join(part));
        if let Some(hit) = self.indexes.lock().get(&root) {
            return Ok(hit.clone());
        }
        let index = archive::load_index(&root)?;
        self.indexes.lock().insert(root, index.clone());
        Ok(index)
    }

    /// One file under `<game>/prefabs` by its path there (exact, then case-insensitive).
    pub fn read_prefab(&self, path: &str) -> Result<Option<Blob>> {
        self.index(&["prefabs"])?.find(path).map(read_file).transpose()
    }
}

/// `build_prefab_entry_map`: every prefab by lowercased path. A later duplicate replaces
/// an earlier one but keeps its place, like the Python dict.
pub struct PrefabIndex {
    pub index: Arc<GameIndex>,
    by_key: IndexMap<String, usize>,
}

static PREFAB_INDEXES: Derived<PrefabIndex> = Derived::new();

impl PrefabIndex {
    pub fn build(game: &GameFiles) -> Result<Arc<Self>> {
        require_prefabs_root(game.path())?;
        let index = game.index(&["prefabs"])?;
        PREFAB_INDEXES.get(&index, || {
            let mut by_key = IndexMap::with_capacity(index.files.len());
            for (i, f) in index.files.iter().enumerate() {
                by_key.insert(f.full_path.to_lowercase(), i);
            }
            Ok(PrefabIndex { index: index.clone(), by_key })
        })
    }

    pub fn get(&self, lower_key: &str) -> Option<&IndexedFile> {
        self.by_key.get(lower_key).map(|&i| &self.index.files[i])
    }

    /// The file [`PrefabIndex::read_prefab_content`] would read.
    pub fn lookup_prefab(&self, prefab_path: &str) -> Option<&IndexedFile> {
        let normalized = py::strip(&prefab_path.replace('\\', "/")).to_string();
        let normalized = normalized.strip_suffix(".binfab").unwrap_or(&normalized);
        if normalized.is_empty() {
            return None;
        }
        self.get(&format!("{}.binfab", normalized).to_lowercase())
    }

    /// `(lowercased path, file)` in the map's order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &IndexedFile)> {
        self.by_key.iter().map(|(k, &i)| (k.as_str(), &self.index.files[i]))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.by_key.keys().map(String::as_str)
    }

    /// `read_prefab_content`: `(prefab_path, bytes)` for a path with or without `.binfab`.
    pub fn read_prefab_content(&self, prefab_path: &str) -> Result<Option<(String, Blob)>> {
        match self.lookup_prefab(prefab_path) {
            Some(f) => Ok(Some((f.full_path.clone(), read_file(f)?))),
            None => Ok(None),
        }
    }
}

// --- Keys and identifiers ------------------------------------------------------------

pub fn ally_key_from_prefab_path(prefab_path: &str) -> String {
    let normalized = prefab_path.replace('\\', "/");
    let rest = if normalized.to_lowercase().starts_with(PREFAB_PREFIX) { &normalized[PREFAB_PREFIX.len()..] } else { &normalized };
    let key = py::stem_any_sep(rest);
    if key == "tentacle_bopplepod" {
        return "tentacle_bobblepod".into();
    }
    key.to_string()
}

pub fn item_ally_key_from_prefab_path(prefab_path: &str) -> String {
    let key = ally_key_from_prefab_path(prefab_path);
    for suffix in ["_notrade", "_trade"] {
        if let Some(k) = key.strip_suffix(suffix) {
            return k.to_string();
        }
    }
    key
}

pub fn ally_family_key(ally_key: &str) -> String {
    let parts: Vec<&str> = ally_key.split('_').collect();
    if parts.len() >= 2 {
        return parts[..2].join("_");
    }
    ally_key.to_string()
}

pub fn encode_varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let current = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            out.push(current | 0x80);
        } else {
            out.push(current);
            return out;
        }
    }
}

/// The collection a mastery identifier belongs to and its base mastery.
pub fn infer_mastery_base(identifier: &str) -> (String, i64) {
    let normalized = identifier.replace('\\', "/");
    const RULES: [(&str, i64); 11] = [
        ("collections/mount", 50),
        ("collections/boat", 50),
        ("collections/badge", 20),
        ("collections/tome", 20),
        ("collections/pet", 10),
        ("item/companion", 10),
        ("collections/sail", 10),
        ("item/fish", 5),
        ("item/unlocker", 5),
        ("recipe_", 2),
        ("equipment_", 0),
    ];
    for (prefix, base) in RULES {
        if normalized.contains(prefix) {
            return (normalized, base);
        }
    }
    if !normalized.contains('/') {
        return (format!("collections/skin/{}", normalized), 35);
    }
    (normalized, 0)
}

// --- Mastery multipliers -------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultiplierRow {
    pub identifier: String,
    pub multiplier: i64,
    pub base: i64,
    pub predicted: i64,
}

pub type MultiplierMap = IndexMap<String, MultiplierRow>;

/// `read_leb128(BinaryReader(content), pos)`, masked to 32 bits.
fn read_leb128(content: &[u8], mut pos: usize) -> Result<u64> {
    let mut result: u128 = 0;
    let mut shift = 0u32;
    loop {
        if pos > content.len() {
            bail!("BinaryReader Error: cannot seek farther than buffer length.");
        }
        let Some(&byte) = content.get(pos) else { bail!("BinaryReader Error: cannot read farther than buffer length.") };
        result |= ((byte & 0x7F) as u128) << shift;
        pos += 1;
        if byte & 0x80 == 0 {
            return Ok((result & 0xFFFF_FFFF) as u64);
        }
        shift += 7;
        if shift >= 64 {
            bail!("Too many bytes when decoding varint.");
        }
    }
}

fn skip_varint(content: &[u8], mut position: usize) -> usize {
    while position < content.len() && content[position] & 0x80 != 0 {
        position += 1;
    }
    position + 1
}

/// The `(multiplier group, element)` rows of a `meta/*multipliers.binfab`.
pub fn parse_multiplier_content(content: &[u8], geode_mode: bool) -> Result<MultiplierMap> {
    let mut rows = MultiplierMap::new();
    let mut position = 9;
    for multiplier in [0i64, 2, 3, 5] {
        let Some(marker_pos) = py::find(content, b"\xBE\x01\xAE", position) else { break };
        position = marker_pos + 3;
        let element_count = read_leb128(content, position)?;
        position = skip_varint(content, position);
        for index in 1..=element_count {
            let mut pattern = encode_varint(4 + 16 * (index - 1));
            pattern.push(0);
            let Some(next) = py::find(content, &pattern, position) else { break };
            position = next + pattern.len() + 2;
            let string_length = read_leb128(content, position)? as usize;
            position = skip_varint(content, position);
            let raw = py::ascii_ignore(py::slice(content, position, position + string_length));
            position += string_length;
            let (identifier, base) = infer_mastery_base(&raw);
            let mut predicted = base * multiplier;
            if geode_mode && identifier.starts_with("collections/pet/") && multiplier == 0 {
                predicted = base;
            }
            rows.insert(identifier.clone(), MultiplierRow { identifier, multiplier, base, predicted });
        }
    }
    Ok(rows)
}

pub fn load_multiplier_file_map(game: &GameFiles, target_file: &str, geode_mode: bool) -> Result<MultiplierMap> {
    match game.read_prefab(target_file)? {
        Some(content) => parse_multiplier_content(&content, geode_mode),
        None => Ok(MultiplierMap::new()),
    }
}

pub fn load_multipliers_map(game: &GameFiles) -> Result<MultiplierMap> {
    load_multiplier_file_map(game, MULTIPLIER_FILE, false)
}

pub fn load_geode_multipliers_map(game: &GameFiles) -> Result<MultiplierMap> {
    load_multiplier_file_map(game, GEODE_MULTIPLIER_FILE, true)
}

/// Pet stem to its collection category (`collection_pet.binfab`).
pub fn load_collection_pet_category_map(game: &GameFiles) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    if let Some(content) = game.read_prefab("collections/collection_pet.binfab")? {
        for group in parse_collection_table(&content) {
            for member in &group.members {
                out.insert(py::stem_any_sep(&member.replace('\\', "/")).to_string(), group.id.clone());
            }
        }
    }
    Ok(out)
}

// --- Blueprints ----------------------------------------------------------------------

pub fn extract_designer_from_blueprint(blueprint: &str) -> String {
    DESIGNER_RE.captures(py::stem_any_sep(blueprint)).map(|c| c[1].to_string()).unwrap_or_default()
}

/// `re.sub(r"\[[^\]]+\]", "", text)`.
pub fn strip_brackets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('[') {
        let after = &rest[i + 1..];
        match after.find(']') {
            Some(j) if j > 0 => {
                out.push_str(&rest[..i]);
                rest = &after[j + 1..];
            }
            Some(_) => {
                out.push_str(&rest[..=i]);
                rest = after;
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

/// `re.sub(r"^[^A-Za-z0-9_/]+", "", text)`.
fn strip_leading_junk(text: &str) -> &str {
    text.trim_start_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '/'))
}

pub fn normalize_blueprint_catalog_id(blueprint: &str) -> String {
    let text = py::strip(&blueprint.replace('\\', "/")).to_string();
    if text.is_empty() {
        return String::new();
    }
    let text = strip_brackets(strip_leading_junk(text.strip_suffix(".blueprint").unwrap_or(&text)));
    let text = if text.contains('/') { text.rsplit('/').next().unwrap_or("") } else { &text };
    text.trim_start_matches('$').to_string()
}

pub fn normalize_blueprint_lookup_key(value: &str) -> String {
    let text = py::strip(&value.replace('\\', "/")).to_lowercase();
    let text = text.strip_suffix(".blueprint").unwrap_or(&text);
    // Lowercased, so only lowercase letters survive `^[^a-z0-9_/]+`.
    let text = text.trim_start_matches(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '/'));
    strip_brackets(text).rsplit('/').next().unwrap_or("").to_string()
}

/// `load_blueprint_path_map`: exact lookups plus `(lookup key, path)` for prefix matches.
#[derive(Default)]
pub struct BlueprintMap {
    pub exact: HashMap<String, String>,
    pub entries: Vec<(String, String)>,
    /// `entries` indexes sorted by key, for prefix ranges.
    sorted: Vec<usize>,
    lens: Vec<usize>,
}

impl BlueprintMap {
    pub fn new(exact: HashMap<String, String>, entries: Vec<(String, String)>) -> Self {
        let mut sorted: Vec<usize> = (0..entries.len()).collect();
        sorted.sort_by(|&a, &b| entries[a].0.cmp(&entries[b].0));
        let lens = entries.iter().map(|(_, p)| p.chars().count()).collect();
        BlueprintMap { exact, entries, sorted, lens }
    }

    /// The first shortest path whose key starts with `prefix`.
    fn shortest_with_prefix(&self, prefix: &str) -> Option<&str> {
        let lo = self.sorted.partition_point(|&i| self.entries[i].0.as_str() < prefix);
        let hi = lo + self.sorted[lo..].partition_point(|&i| self.entries[i].0.starts_with(prefix));
        self.sorted[lo..hi].iter().filter(|&&i| self.lens[i] > 0).min_by_key(|&&i| (self.lens[i], i)).map(|&i| self.entries[i].1.as_str())
    }
}

static BLUEPRINT_MAPS: Derived<BlueprintMap> = Derived::new();

/// Every `.blueprint` under `game_path / "blueprints"`, cached until its index changes.
pub fn load_blueprint_path_map(game: &GameFiles) -> Result<Arc<BlueprintMap>> {
    if !game.path().join("blueprints").exists() {
        return Ok(Arc::new(BlueprintMap::default()));
    }
    let index = game.index(&["blueprints"])?;
    BLUEPRINT_MAPS.get(&index, || {
        let rows: Vec<Option<[String; 5]>> = index
            .files
            .par_iter()
            .map(|f| {
                let normalized = f.full_path.replace('\\', "/");
                let lowered = normalized.to_lowercase();
                if !lowered.ends_with(".blueprint") {
                    return None;
                }
                let no_ext = normalized.strip_suffix(".blueprint").unwrap_or(&normalized).to_string();
                let basename = py::name_any_sep(&no_ext).to_lowercase();
                let unbracketed = strip_brackets(&basename);
                let key = normalize_blueprint_lookup_key(&basename);
                Some([lowered, basename, unbracketed, no_ext, key])
            })
            .collect();
        let mut exact = HashMap::with_capacity(rows.len() * 2);
        let mut entries = Vec::with_capacity(rows.len());
        for [lowered, basename, unbracketed, no_ext, key] in rows.into_iter().flatten() {
            exact.entry(lowered).or_insert_with(|| no_ext.clone());
            exact.entry(basename).or_insert_with(|| no_ext.clone());
            exact.entry(unbracketed).or_insert_with(|| no_ext.clone());
            entries.push((key, no_ext));
        }
        Ok(BlueprintMap::new(exact, entries))
    })
}

pub fn resolve_blueprint_catalog_path(blueprint: &str, map: &BlueprintMap) -> String {
    let normalized = py::strip(&blueprint.replace('\\', "/")).to_string();
    if normalized.is_empty() {
        return String::new();
    }
    let trimmed = normalized.strip_suffix(".blueprint").unwrap_or(&normalized).trim_start_matches('$');
    let normalized = strip_leading_junk(trimmed).to_string();
    let basename = py::name_any_sep(&normalized).to_lowercase();
    let keys = [format!("{}.blueprint", normalized.to_lowercase()), basename.clone(), strip_brackets(&basename)];
    for key in &keys {
        if let Some(hit) = map.exact.get(key) {
            return hit.clone();
        }
    }
    if let Some(best) = map.shortest_with_prefix(&normalize_blueprint_lookup_key(&normalized)) {
        return best.to_string();
    }
    normalize_blueprint_catalog_id(&normalized)
}

// --- Localization ----------------------------------------------------------------------

/// `clean_localized_text`: strips a one-letter `x$` prefix, backticks and escaped newlines.
pub fn clean_localized_text(text: &str) -> String {
    let mut text: String = {
        let mut chars = text.chars();
        match (chars.next(), chars.next(), chars.next()) {
            (Some(a), Some('$'), Some(c)) if a.is_ascii_alphabetic() && py::is_word(c) => format!("${}", &text[2..]),
            _ => text.to_string(),
        }
    };
    if text.starts_with("$$") {
        text = format!("${}", text.trim_start_matches('$'));
    }
    let text = text.replace("\\n", "\n");
    let mut text = py::strip(text.trim_matches('`')).to_string();
    if !text.starts_with('$') && text.starts_with("\\\"") {
        text.remove(0);
    }
    text
}

/// `(value, next)`, or `None` past the end or after 10 bytes.
pub fn read_varint(data: &[u8], offset: usize) -> Option<(u128, usize)> {
    let mut value: u128 = 0;
    let mut shift = 0u32;
    let mut cursor = offset;
    while cursor < data.len() && shift <= 63 {
        let byte = data[cursor];
        value |= ((byte & 0x7F) as u128) << shift;
        cursor += 1;
        if byte & 0x80 == 0 {
            return Some((value, cursor));
        }
        shift += 7;
    }
    None
}

pub type LanguageMap = IndexMap<String, String>;

fn is_key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// Every `$key 0x18 <uleb len> <utf-8 value>` record of a language file.
pub fn extract_localization_map(content: &[u8]) -> LanguageMap {
    let mut mapping = LanguageMap::new();
    let n = content.len();
    let mut cursor = 0;
    while let Some(off) = content.get(cursor..).and_then(|c| c.iter().position(|&b| b == b'$')) {
        let start = cursor + off;
        let mut end = start + 1;
        while end < n && is_key_byte(content[end]) {
            end += 1;
        }
        if end >= n || content[end] != 0x18 {
            cursor = start + 1;
            continue;
        }
        let Some((length, value_start)) = read_varint(content, end + 1) else {
            cursor = start + 1;
            continue;
        };
        if value_start as u128 + length > n as u128 {
            cursor = start + 1;
            continue;
        }
        let value_end = value_start + length as usize;
        let key = clean_localized_text(&py::ascii_ignore(&content[start..end]));
        let value = clean_localized_text(&py::utf8_ignore(&content[value_start..value_end]));
        if key.starts_with('$') && !value.is_empty() && !value.starts_with('$') {
            mapping.insert(key, value);
        }
        cursor = value_end;
    }
    mapping
}

/// The last language map built, with the index and inflated archives it came from.
type LanguageCache = (Arc<GameIndex>, Vec<Arc<Vec<u8>>>, Arc<LanguageMap>);
static LANGUAGES: parking_lot::Mutex<Option<LanguageCache>> = parking_lot::Mutex::new(None);

/// Every string of `languages/<locale>`, later files overriding earlier ones. Reused
/// while neither the index nor an archive under it has changed.
pub fn load_language_map(game: &GameFiles, locale: &str) -> Result<Arc<LanguageMap>> {
    if !game.path().join("languages").join(locale).exists() {
        return Ok(Arc::new(LanguageMap::new()));
    }
    let index = game.index(&["languages", locale])?;
    let files: Vec<&IndexedFile> = index.files.iter().collect();
    let blobs = read_files(&files)?;
    let mut archives: Vec<Arc<Vec<u8>>> = Vec::new();
    for b in &blobs {
        if !archives.iter().any(|a| Arc::ptr_eq(a, &b.buf)) {
            archives.push(b.buf.clone());
        }
    }
    if let Some((i, a, map)) = &*LANGUAGES.lock() {
        if Arc::ptr_eq(i, &index) && a.len() == archives.len() && a.iter().zip(&archives).all(|(x, y)| Arc::ptr_eq(x, y)) {
            return Ok(map.clone());
        }
    }
    let parts: Vec<LanguageMap> = blobs.par_iter().map(|b| extract_localization_map(b)).collect();
    let mut mapping = LanguageMap::with_capacity(parts.iter().map(|p| p.len()).sum());
    for part in parts {
        mapping.extend(part);
    }
    let mapping = Arc::new(mapping);
    *LANGUAGES.lock() = Some((index, archives, mapping.clone()));
    Ok(mapping)
}

pub fn resolve_localized_value(language: &LanguageMap, key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let k = clean_localized_text(key);
    let get = |k: &str| language.get(k).cloned().unwrap_or_default();
    let value = get(&k);
    if !value.is_empty() {
        return value;
    }
    if let Some(base) = k.strip_suffix('0') {
        return get(base);
    }
    if let Some(base) = k.strip_suffix("_description") {
        return get(&format!("{}_desc", base));
    }
    if let Some(base) = k.strip_suffix("_desc") {
        return get(&format!("{}_description", base));
    }
    String::new()
}

/// [`resolve_localized_value`], else the best title string under the ally's own key.
pub fn resolve_pet_name_value(language: &LanguageMap, lowered_keys: &[String], ally_key: &str, key: &str) -> String {
    let direct = resolve_localized_value(language, key);
    if !direct.is_empty() {
        return direct;
    }
    let needle = ally_key.to_lowercase();
    if needle.is_empty() {
        return String::new();
    }
    let mut best: Option<(u8, usize, &str)> = None;
    for (lowered, value) in lowered_keys.iter().zip(language.values()) {
        if !lowered.contains(&needle) || value.is_empty() || value.to_lowercase().contains("vendor") {
            continue;
        }
        let score = if lowered.ends_with("_item_name") {
            0
        } else if lowered.ends_with("_name") {
            1
        } else if lowered.ends_with("_sign_title") {
            2
        } else if lowered.ends_with("_title") {
            3
        } else {
            100
        };
        let cand = (score, value.chars().count(), value.as_str());
        if best.is_none_or(|b| cand < b) {
            best = Some(cand);
        }
    }
    best.map(|b| b.2.to_string()).unwrap_or_default()
}

/// The language map's keys lowercased, in its order (for [`resolve_pet_name_value`]).
pub fn lowered_keys(language: &LanguageMap) -> Vec<String> {
    language.keys().map(|k| k.to_lowercase()).collect()
}

pub fn extract_pet_localization_keys(strings: &[binfab::BinString]) -> (String, String) {
    let mut name_key = String::new();
    let mut desc_key = String::new();
    for item in strings {
        if name_key.is_empty() {
            if let Some(c) = PET_NAME_KEY_RE.captures(&item.text) {
                name_key = c[1].to_string();
            }
        }
        if desc_key.is_empty() {
            if let Some(c) = PET_DESCRIPTION_KEY_RE.captures(&item.text) {
                desc_key = c[1].to_string();
            }
        }
        if !name_key.is_empty() && !desc_key.is_empty() {
            break;
        }
    }
    (name_key, desc_key)
}

/// An ability prefab's resolved name and description.
#[derive(Debug, Clone, Default)]
pub struct AbilityInfo {
    pub path: String,
    pub prefab_path: String,
    pub name_key: Option<String>,
    pub description_key: Option<String>,
    pub name: String,
    pub description: String,
}

pub fn resolve_ability_prefabs(game: &GameFiles, language: &LanguageMap, ability_paths: &[String]) -> Result<HashMap<String, AbilityInfo>> {
    let index = game.index(&["prefabs"])?;
    let wanted: Vec<(String, &String)> = ability_paths.iter().filter(|a| !a.is_empty()).map(|a| (format!("{}.binfab", a), a)).collect();
    let found: Vec<(&String, &String, &IndexedFile)> = wanted.iter().filter_map(|(full, a)| index.find(full).map(|f| (full, *a, f))).collect();
    let blobs = read_files(&found.iter().map(|(_, _, f)| *f).collect::<Vec<_>>())?;
    let mut resolved = HashMap::new();
    for ((full_path, matched, _), content) in found.into_iter().zip(blobs) {
        let strings: Vec<String> = binfab::extract_strings(&content).iter().map(|s| clean_localized_text(&s.text)).collect();
        let name_key = strings.iter().find(|t| t.ends_with("_name") && t.starts_with('$')).cloned();
        let description_key = strings.iter().find(|t| t.contains("_description") && t.starts_with('$')).cloned();
        let lookup = |k: &str| language.get(k).cloned().unwrap_or_default();
        let mut description = lookup(description_key.as_deref().unwrap_or(""));
        if description.is_empty() {
            if let Some(base) = description_key.as_deref().and_then(|k| k.strip_suffix('0')) {
                description = lookup(base);
            }
        }
        resolved.insert(
            matched.clone(),
            AbilityInfo {
                path: matched.clone(),
                prefab_path: full_path.strip_suffix(".binfab").unwrap_or(full_path).to_string(),
                name: lookup(name_key.as_deref().unwrap_or("")),
                name_key,
                description_key,
                description,
            },
        );
    }
    Ok(resolved)
}

/// `stat_objects_from_lines`: "30% Damage" into value, percent flag and name.
pub fn stat_objects_from_lines(lines: &[String]) -> Vec<Value> {
    let mut out = Vec::new();
    for line in lines {
        let text = py::strip(line);
        if text.is_empty() {
            continue;
        }
        match STAT_LINE_RE.captures(text) {
            Some(c) => {
                let value: f64 = c[1].parse().unwrap_or(0.0);
                out.push(json!({
                    "text": text,
                    "name": py::strip(&c[3]),
                    "value": value,
                    "display_value": format!("{}{}", &c[1], &c[2]),
                    "is_percent": &c[2] == "%",
                }));
            }
            None => out.push(json!({"text": text, "name": text, "value": null, "display_value": "", "is_percent": false})),
        }
    }
    out
}

/// The `47 20 <mode> 1E 62 <lookup> 18 <len>` header of a pet/mount item prefab.
pub fn parse_item_pet_signature(content: &[u8]) -> Value {
    let n = content.len();
    let read = |mut pos: usize| -> (u128, usize) {
        let (mut value, mut shift) = (0u128, 0u32);
        while pos < n {
            let byte = content[pos];
            if shift < 128 {
                value |= ((byte & 0x7F) as u128) << shift;
            }
            pos += 1;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        (value, pos)
    };
    for pos in 0..n.saturating_sub(8).min(96) {
        if content[pos] != 0x47 || content[pos + 1] != 0x20 || content[pos + 3] != 0x1E || content[pos + 4] != 0x62 {
            continue;
        }
        let (lookup_id, read_pos) = read(pos + 5);
        if read_pos >= n || content[read_pos] != 0x18 {
            continue;
        }
        let (string_len, _) = read(read_pos + 1);
        return json!({
            "mode": content[pos + 2],
            "lookup_id": binfab_reader::int_value(lookup_id as i128),
            "string_len": binfab_reader::int_value(string_len as i128),
            "content_size": n,
        });
    }
    json!({})
}

const PR_SPECIAL_30: &[u8] = b"\x2E\x00\x08\x30\x00\x40\x01\x1E\xE2\x05";

/// Power Rank: the `<0x30 varint tier> <0x40 0x01>` component, by tier.
pub fn decode_known_power_rank(content: &[u8]) -> &'static str {
    if py::contains(content, PR_SPECIAL_30) {
        return "30";
    }
    let n = content.len();
    let mut i = 0;
    while i + 2 < n {
        if content[i] != 0x30 {
            i += 1;
            continue;
        }
        let Ok((value, j)) = binfab_reader::read_uleb(content, i + 1) else {
            i += 1;
            continue;
        };
        if j + 1 < n && content[j] == 0x40 && content[j + 1] == 0x01 {
            return match value {
                0 => "0",
                600 | 620 => "50",
                800 => "5",
                802 => "20",
                804 => "75",
                _ => "",
            };
        }
        i = j;
    }
    ""
}

// --- Ally Codex ----------------------------------------------------------------------

/// A pet/mount/memento prefab picked out of the index.
pub struct PrefabMatch<'a> {
    pub file: &'a IndexedFile,
    pub prefab_path: &'a str,
    /// The ally/mount key, or the memento identifier.
    pub key: String,
}

impl PrefabMatch<'_> {
    pub fn internal_name(&self) -> String {
        self.file.entry.name.replace('\\', "/")
    }
}

/// Index files under `prefix` ending in `.binfab`, keyed by `key_of`.
pub fn find_prefabs<'a>(index: &'a GameIndex, prefix: &str, exclude_suffix: Option<&str>, key_of: fn(&str) -> String) -> Vec<PrefabMatch<'a>> {
    index
        .files
        .iter()
        .filter(|f| {
            let lowered = f.full_path.to_lowercase();
            lowered.starts_with(prefix) && lowered.ends_with(".binfab") && exclude_suffix.is_none_or(|s| !lowered.ends_with(s))
        })
        .map(|f| PrefabMatch { file: f, prefab_path: &f.full_path, key: key_of(&f.full_path) })
        .collect()
}

/// The Python loaders' order: grouped by `(index, archive)` in first-seen order.
pub fn grouped_order(matches: &[PrefabMatch]) -> Vec<usize> {
    let mut groups: IndexMap<(&Path, u32), Vec<usize>> = IndexMap::new();
    for (i, m) in matches.iter().enumerate() {
        groups.entry((m.file.tfi_path.as_path(), m.file.entry.archive_index)).or_default().push(i);
    }
    groups.into_values().flatten().collect()
}

/// A loaded prefab: its match, bytes, and (when parsed) the stat parse.
pub struct LoadedPrefab<'a> {
    pub m: &'a PrefabMatch<'a>,
    pub content: Blob,
    pub parsed: Option<ParsedPrefab>,
}

/// Reads `matches` in the loaders' order; `parse` says whether (and how) to stat-parse.
pub fn load_prefabs<'a>(matches: &'a [PrefabMatch<'a>], parse: Option<bool>) -> Result<Vec<LoadedPrefab<'a>>> {
    let order = grouped_order(matches);
    let files: Vec<&IndexedFile> = order.iter().map(|&i| matches[i].file).collect();
    let blobs = read_files(&files)?;
    Ok(order
        .par_iter()
        .zip(blobs)
        .map(|(&i, content)| {
            let m = &matches[i];
            let parsed = parse.map(|fallbacks| parse_binfab_content(&content, m.prefab_path, fallbacks));
            LoadedPrefab { m, content, parsed }
        })
        .collect())
}

/// The prefabs index, which must exist (the `find_*_prefabs` scans run over it).
pub fn prefabs_index(game: &GameFiles) -> Result<Arc<GameIndex>> {
    require_prefabs_root(game.path())?;
    game.index(&["prefabs"])
}

fn best_prefab_record<'a>(items: &[&'a LoadedPrefab]) -> &'a ParsedPrefab {
    let key = |p: &ParsedPrefab| (p.stat_lines.len(), p.extracted_abilities.len(), p.blueprint.is_some() as u8);
    let mut best = items[0].parsed.as_ref().unwrap();
    for item in &items[1..] {
        let p = item.parsed.as_ref().unwrap();
        if key(p) > key(best) {
            best = p;
        }
    }
    best
}

pub fn build_allies_dataset(game_path: &Path, extract_dir: &Path, locale: &str) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let game = &GameFiles::open(game_path);
    let index = prefabs_index(game)?;
    let matches = find_prefabs(&index, PREFAB_PREFIX, Some("_npc.binfab"), ally_key_from_prefab_path);
    let loaded = load_prefabs(&matches, Some(false))?;
    let ability_paths: Vec<String> = {
        let set: std::collections::BTreeSet<&String> = loaded.iter().flat_map(|p| &p.parsed.as_ref().unwrap().extracted_abilities).collect();
        set.into_iter().cloned().collect()
    };
    let language = load_language_map(game, locale)?;
    let blueprints = load_blueprint_path_map(game)?;
    let abilities = resolve_ability_prefabs(game, &language, &ability_paths)?;
    let multipliers = load_multipliers_map(game)?;
    let geode = load_geode_multipliers_map(game)?;
    let categories = load_collection_pet_category_map(game)?;

    let mut by_ally: IndexMap<&str, Vec<&LoadedPrefab>> = IndexMap::new();
    for item in &loaded {
        by_ally.entry(item.m.key.as_str()).or_default().push(item);
    }
    let mut keys: Vec<&str> = by_ally.keys().copied().collect();
    keys.sort_unstable();
    let lowered = lowered_keys(&language);

    let records: Vec<(bool, Option<Value>)> = keys
        .par_iter()
        .map(|&ally_key| {
            let items = &by_ally[ally_key];
            let parsed = best_prefab_record(items);
            let mut blueprint = String::new();
            let mut designer = "Trove Team".to_string();
            if let Some(raw) = &parsed.blueprint {
                blueprint = resolve_blueprint_catalog_path(raw, &blueprints);
                let d = extract_designer_from_blueprint(raw);
                if !d.is_empty() {
                    designer = d;
                }
            }
            let category = categories.get(ally_key).cloned().unwrap_or_default();
            let filename = items[0].m.prefab_path.strip_suffix(".binfab").unwrap_or(items[0].m.prefab_path).to_string();
            let (name_key, desc_key) = extract_pet_localization_keys(&parsed.strings);
            let name = resolve_pet_name_value(&language, &lowered, ally_key, &name_key);
            let desc = resolve_localized_value(&language, &desc_key);
            let ranks: HashSet<&str> = items.iter().map(|i| decode_known_power_rank(&i.content)).filter(|v| !v.is_empty()).collect();
            let powerrank = if ranks.len() == 1 { ranks.into_iter().next().unwrap() } else { "" };
            let mastery = multipliers.get(&filename).map(|r| r.predicted.to_string()).unwrap_or_else(|| "0".into());
            let mastery_geode = geode.get(&filename).map(|r| r.predicted.to_string()).unwrap_or_else(|| "0".into());
            let mut ability_names = Vec::new();
            let mut ability_descs = Vec::new();
            for path in &parsed.extracted_abilities {
                if let Some(info) = abilities.get(path) {
                    if !info.name.is_empty() {
                        ability_names.push(info.name.clone());
                    }
                    if !info.description.is_empty() {
                        ability_descs.push(info.description.clone());
                    }
                }
            }
            let decoded = !parsed.stat_lines.is_empty();
            if category.is_empty() {
                return (decoded, None);
            }
            let record = json!({
                "category": category,
                "name": name,
                "desc": desc,
                "designer": designer,
                "filename": filename,
                "blueprint": blueprint,
                "mastery": mastery,
                "mastery_geode": mastery_geode,
                "powerrank": powerrank,
                "stats": stat_objects_from_lines(&parsed.stat_lines),
                "ability_paths": parsed.extracted_abilities,
                "ability_names": ability_names,
                "abilities": ability_descs,
            });
            (decoded, Some(record))
        })
        .collect();

    let mut merged = Map::new();
    let mut decoded_count = 0;
    for (key, (decoded, record)) in keys.iter().zip(records) {
        decoded_count += decoded as usize;
        if let Some(r) = record {
            merged.insert(key.to_string(), r);
        }
    }
    let count = |f: &dyn Fn(&Value) -> bool| merged.values().filter(|r| f(r)).count();
    let filename = |r: &Value| r["filename"].as_str().unwrap_or("").to_string();
    let mut manifest = Map::new();
    manifest.insert("game_path".into(), json!(py::path_str_simple(game_path)));
    manifest.insert("match_count".into(), json!(matches.len()));
    manifest.insert("extracted_count".into(), json!(loaded.len()));
    manifest.insert("matched_allies".into(), json!(merged.len()));
    manifest.insert("decoded_tooltips".into(), json!(decoded_count));
    manifest.insert("extract_dir".into(), json!(py::path_str_simple(extract_dir)));
    manifest.insert("ability_paths".into(), json!(ability_paths.len()));
    manifest.insert("resolved_abilities".into(), json!(abilities.values().filter(|a| !a.description.is_empty() || !a.name.is_empty()).count()));
    manifest.insert("decoded_mastery".into(), json!(count(&|r| multipliers.contains_key(&filename(r)))));
    manifest.insert("decoded_geode_mastery".into(), json!(count(&|r| geode.contains_key(&filename(r)))));
    manifest.insert("decoded_names".into(), json!(count(&|r| r["name"] != "")));
    manifest.insert("decoded_descriptions".into(), json!(count(&|r| r["desc"] != "")));
    manifest.insert("decoded_powerrank".into(), json!(count(&|r| r["powerrank"] != "")));
    Ok((merged, manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localized_text_cleanup() {
        assert_eq!(clean_localized_text("x$prefabs_a"), "$prefabs_a");
        assert_eq!(clean_localized_text("$$$a"), "$a");
        assert_eq!(clean_localized_text("`hello\\nworld`"), "hello\nworld");
        assert_eq!(clean_localized_text("`hello` "), "hello`");
        assert_eq!(clean_localized_text("\\\"quoted"), "\"quoted");
        assert_eq!(clean_localized_text("x$ a"), "x$ a");
    }

    #[test]
    fn inflates_unterminated_streams() {
        use std::io::Write;
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&data).unwrap();
        enc.flush().unwrap();
        let synced = enc.get_ref().clone();
        assert_eq!(inflate(&synced).unwrap(), data);
        assert_eq!(inflate(&enc.finish().unwrap()).unwrap(), data);
    }

    #[test]
    fn mastery_bases() {
        assert_eq!(infer_mastery_base("collections/pet/x"), ("collections/pet/x".into(), 10));
        assert_eq!(infer_mastery_base("recipe_x"), ("recipe_x".into(), 2));
        assert_eq!(infer_mastery_base("hat_x"), ("collections/skin/hat_x".into(), 35));
        assert_eq!(encode_varint(300), vec![0xAC, 0x02]);
    }

    #[test]
    fn blueprint_resolution() {
        let entries = vec![("pet_cat".to_string(), "pets/pet_cat_long".to_string()), ("pet_cat".to_string(), "pets/pet_cat".to_string())];
        let map = BlueprintMap::new(HashMap::new(), entries);
        assert_eq!(resolve_blueprint_catalog_path("$pet_cat.blueprint", &map), "pets/pet_cat");
        assert_eq!(resolve_blueprint_catalog_path("nothing[Bob].blueprint", &map), "nothing");
        assert_eq!(extract_designer_from_blueprint("a/c_c_pet[Bob].blueprint"), "Bob");
    }
}
