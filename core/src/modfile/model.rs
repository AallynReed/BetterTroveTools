//! `TroveModFile`, `PartialTroveModFile`, `TroveMod`, `TMod` and `ZMod`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Result};
use md5::{Digest, Md5};
use parking_lot::Mutex;
use serde_json::{Map, Value};

use super::compat::{self, file_name, file_stem, strip};
use super::format::{self, decompress_body, HeaderReader, OutFile, Reader};
use super::trovesaurus;
use super::{cfg, toml_out, zipmod};
use crate::game::hash::calculate_hash;

/// `NoFilesError`.
#[derive(Debug)]
pub struct NoFilesError;

impl std::fmt::Display for NoFilesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("No files to compile")
    }
}

impl std::error::Error for NoFilesError {}

/// `MissingPropertyError` / `PropertyMalformedError` from `TroveMod.metadata`.
#[derive(Debug)]
pub struct PropertyError(pub String);

impl std::fmt::Display for PropertyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PropertyError {}

/// The `FileExistsError()` `toggle` raises when the renamed file is already there.
/// Python's message was empty.
#[derive(Debug)]
pub struct FileExistsError;

impl std::fmt::Display for FileExistsError {
    fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Ok(())
    }
}

impl std::error::Error for FileExistsError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Property {
    pub name: String,
    pub value: String,
}

/// `_normalize_internal_path`: posix, and lowercased unless it is a `.cfg` (the game
/// reads configs by the mod title, so their case is kept).
pub fn normalize_internal_path(path: &str) -> Option<String> {
    let normalized = strip(&compat::as_posix(path)).to_string();
    let normalized = if normalized.to_lowercase().ends_with(".cfg") { normalized } else { normalized.to_lowercase() };
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// The decompressed body of a `.tmod` read header-only, loaded on first use and shared
/// by its files (`mod_file_cache`).
#[derive(Debug)]
pub(crate) struct PartialBody {
    path: Mutex<PathBuf>,
    data: Mutex<Option<Arc<Vec<u8>>>>,
}

impl PartialBody {
    fn new(path: &Path) -> Self {
        PartialBody { path: Mutex::new(path.to_path_buf()), data: Mutex::new(None) }
    }

    fn load(&self) -> Result<Arc<Vec<u8>>> {
        let mut guard = self.data.lock();
        if let Some(d) = &*guard {
            return Ok(d.clone());
        }
        let path = self.path.lock().clone();
        let raw = compat::read_bytes(&path)?;
        let body = Arc::new(decompress_body(&raw[format::header_slice(&raw).len()..]));
        *guard = Some(body.clone());
        Ok(body)
    }
}

#[derive(Debug, Clone)]
struct Lazy {
    body: Arc<PartialBody>,
    size: u64,
}

/// `TroveModFile` (and `PartialTroveModFile`, whose bytes are read from the archive on
/// first use).
#[derive(Debug, Clone)]
pub struct ModFile {
    /// Normalized by [`ModFile::new`]; callers that need the stored case set it directly.
    pub trove_path: String,
    pub index: u64,
    pub offset: u64,
    /// The checksum the header carried, for files read from a `.tmod`.
    pub old_checksum: Option<u32>,
    content: OnceLock<Vec<u8>>,
    checksum: OnceLock<u32>,
    lazy: Option<Lazy>,
}

impl ModFile {
    pub fn new(trove_path: &str, data: Vec<u8>) -> Self {
        let content = OnceLock::new();
        let _ = content.set(data);
        ModFile {
            trove_path: normalize_internal_path(trove_path).unwrap_or_default(),
            index: 0,
            offset: 0,
            old_checksum: None,
            content,
            checksum: OnceLock::new(),
            lazy: None,
        }
    }

    fn partial(trove_path: &str, body: Arc<PartialBody>, offset: u64, size: u64) -> Self {
        ModFile {
            trove_path: normalize_internal_path(trove_path).unwrap_or_default(),
            index: 0,
            offset,
            old_checksum: None,
            content: OnceLock::new(),
            checksum: OnceLock::new(),
            lazy: Some(Lazy { body, size }),
        }
    }

    /// The file's bytes. Header-only files read them from the archive here.
    pub fn data(&self) -> Result<&[u8]> {
        if let Some(d) = self.content.get() {
            return Ok(d);
        }
        let lazy = self.lazy.as_ref().expect("a file without content is always lazy");
        let body = lazy.body.load()?;
        let mut r = Reader::new(&body);
        r.seek(self.offset as usize)?;
        let bytes = r.read_bytes(lazy.size as usize)?.to_vec();
        Ok(self.content.get_or_init(|| bytes))
    }

    pub fn size(&self) -> u64 {
        match (&self.lazy, self.content.get()) {
            (Some(l), _) => l.size,
            (None, Some(d)) => d.len() as u64,
            (None, None) => 0,
        }
    }

    pub fn checksum(&self) -> Result<u32> {
        if let Some(c) = self.checksum.get() {
            return Ok(*c);
        }
        let c = calculate_hash(self.data()?);
        Ok(*self.checksum.get_or_init(|| c))
    }

    pub fn padded_data(&self) -> Result<Vec<u8>> {
        let data = self.data()?;
        let mut out = data.to_vec();
        out.resize(format::padded_len(data.len()), 0);
        Ok(out)
    }

    /// The file's entry in a `.tmod` header.
    pub fn header_format(&self) -> Result<Vec<u8>> {
        format::entry_header(&self.out_file()?)
    }

    fn out_file(&self) -> Result<OutFile<'_>> {
        Ok(OutFile { path: &self.trove_path, index: self.index, offset: self.offset, data: self.data()?, checksum: self.checksum()? })
    }

    fn repoint(&self, path: &Path) {
        if let Some(l) = &self.lazy {
            *l.body.path.lock() = path.to_path_buf();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModKind {
    /// `TMod`.
    Tmod,
    /// `ZMod`.
    Zip,
}

/// `TroveMod`: a `.tmod` or `.zip` mod. `name_conflicts`/`file_conflicts` index into the
/// owning [`super::TroveModList`].
#[derive(Debug, Clone)]
pub struct TroveMod {
    pub kind: ModKind,
    pub mod_path: PathBuf,
    pub version: u16,
    pub properties: Vec<Property>,
    pub files: Vec<ModFile>,
    pub enabled: bool,
    pub is_workshop: bool,
    pub name_conflicts: Vec<usize>,
    pub file_conflicts: Vec<usize>,
    pub trovesaurus_data: Option<trovesaurus::Mod>,
    /// `_tmod_content` / `_zip_content`.
    content: Option<Vec<u8>>,
    /// `_tmod_hash` / `_zip_hash`.
    hash: Option<String>,
}

fn md5_hex(data: &[u8]) -> String {
    hex::encode(Md5::digest(data))
}

/// The container `compile_tmod` writes, minus its `modLoader = BTT` stamp, with the
/// files' offsets reassigned like `reorder_files`. Paths are written as they are in
/// `trove_path` (modpacks' `_rebuild_tpack` keeps their case).
pub fn build_container(version: u16, properties: &[(&str, &str)], files: &mut [ModFile]) -> Result<Vec<u8>> {
    let mut offset = 0u64;
    for f in files.iter_mut() {
        f.index = 0;
        f.offset = offset;
        offset += format::padded_len(f.data()?.len()) as u64;
    }
    let out = files.iter().map(ModFile::out_file).collect::<Result<Vec<_>>>()?;
    format::write_container(version, properties, &out)
}

/// The placeholder preview every mod without one gets, encoded once.
pub fn no_preview_image() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let rel = Path::new("web").join("assets").join("images").join("no_preview.png");
            let mut roots = Vec::new();
            if let Some(c) = crate::ctx::try_ctx() {
                roots.push(c.resource_dir.clone());
            }
            roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
            if let Ok(cwd) = std::env::current_dir() {
                roots.push(cwd);
            }
            roots.iter().map(|r| r.join(&rel)).find(|p| p.is_file()).and_then(|p| std::fs::read(p).ok()).map(|b| compat::b64encode(&b)).unwrap_or_default()
        })
        .clone()
}

impl TroveMod {
    pub fn new(kind: ModKind) -> Self {
        TroveMod {
            kind,
            mod_path: PathBuf::new(),
            version: 1,
            properties: Vec::new(),
            files: Vec::new(),
            enabled: true,
            is_workshop: false,
            name_conflicts: Vec::new(),
            file_conflicts: Vec::new(),
            trovesaurus_data: None,
            content: None,
            hash: None,
        }
    }

    /// `TMod.read_bytes(path, data, partial)`. With `partial`, files are read from
    /// `path` on first use, and `data` only needs to hold the header.
    pub fn read_tmod(path: &Path, data: Vec<u8>, partial: bool) -> Result<TroveMod> {
        let mut m = TroveMod::new(ModKind::Tmod);
        m.mod_path = path.to_path_buf();
        {
            let mut h = HeaderReader::new(&data)?;
            m.version = h.version;
            m.properties = std::mem::take(&mut h.properties).into_iter().map(|(name, value)| Property { name, value }).collect();
            let body = (!partial).then(|| decompress_body(&data[(h.header_size.min(data.len() as u64)) as usize..]));
            let shared = Arc::new(PartialBody::new(path));
            while let Some(entry) = h.next_entry() {
                let e = entry?;
                let file = match &body {
                    Some(body) => {
                        let mut r = Reader::new(body);
                        r.seek(e.offset as usize)?;
                        let mut f = ModFile::new(&e.path, r.read_bytes(e.size as usize)?.to_vec());
                        f.old_checksum = Some(e.checksum);
                        f
                    }
                    None => ModFile::partial(&e.path, shared.clone(), e.offset as u64, e.size as u64),
                };
                m.files.push(ModFile { index: e.index as u64, ..file });
            }
        }
        m.content = Some(data);
        Ok(m)
    }

    /// `ZMod.read_bytes(path, data)`.
    pub fn read_zip(path: &Path, data: Vec<u8>) -> Result<TroveMod> {
        let mut m = TroveMod::new(ModKind::Zip);
        m.mod_path = path.to_path_buf();
        {
            let archive = zipmod::ZipArchive::new(&data)?;
            for name in archive.names() {
                if name.ends_with('/') {
                    continue;
                }
                let content = archive.read(&name)?;
                m.files.push(ModFile::new(&name, content));
            }
        }
        m.content = Some(data);
        m.set_name(&file_stem(path));
        Ok(m)
    }

    // --- properties ----------------------------------------------------------------

    pub fn get_property(&self, name: &str) -> Option<&Property> {
        self.properties.iter().find(|p| p.name == name)
    }

    pub fn get_property_value(&self, name: &str) -> Option<&str> {
        self.get_property(name).map(|p| p.value.as_str())
    }

    pub fn remove_property(&mut self, name: &str) {
        if let Some(i) = self.properties.iter().position(|p| p.name == name) {
            self.properties.remove(i);
        }
    }

    /// Replaces the first property of that name, moving it to the end.
    pub fn add_property(&mut self, name: &str, value: &str) {
        self.remove_property(name);
        self.properties.push(Property { name: name.to_string(), value: value.to_string() });
    }

    pub fn name(&self) -> Option<&str> {
        self.get_property_value("title")
    }

    pub fn set_name(&mut self, value: &str) {
        self.add_property("title", value);
    }

    pub fn author(&self) -> Option<&str> {
        self.get_property_value("author")
    }

    pub fn set_author(&mut self, value: &str) {
        self.add_property("author", value);
    }

    pub fn steam_id(&self) -> Option<&str> {
        self.get_property_value("SteamId")
    }

    pub fn set_steam_id(&mut self, value: &str) {
        self.add_property("SteamId", value);
    }

    /// Trimmed; empty when the property is missing.
    pub fn mod_version(&self) -> String {
        self.get_property_value("modVersion").map(|v| strip(v).to_string()).unwrap_or_default()
    }

    pub fn set_mod_version(&mut self, value: &str) {
        self.add_property("modVersion", strip(value));
    }

    pub fn game_version(&self) -> Option<&str> {
        self.get_property_value("gameVersion")
    }

    pub fn set_game_version(&mut self, value: &str) {
        self.add_property("gameVersion", value);
    }

    pub fn notes(&self) -> Option<&str> {
        self.get_property_value("notes")
    }

    pub fn set_notes(&mut self, value: &str) {
        self.add_property("notes", value);
    }

    pub fn preview_path(&self) -> Option<String> {
        self.get_property_value("previewPath").and_then(normalize_internal_path)
    }

    pub fn set_preview_path(&mut self, value: &str) {
        self.add_property("previewPath", &normalize_internal_path(value).unwrap_or_default());
    }

    pub fn config_path(&self) -> Option<String> {
        self.get_property_value("configPath").and_then(normalize_internal_path)
    }

    pub fn set_config_path(&mut self, value: &str) {
        self.add_property("configPath", &normalize_internal_path(value).unwrap_or_default());
    }

    pub fn tags(&self) -> Vec<String> {
        match self.get_property_value("tags") {
            Some(tags) if !tags.is_empty() => tags.split(',').map(strip).filter(|t| !t.is_empty()).map(String::from).collect(),
            _ => Vec::new(),
        }
    }

    pub fn subtype(&self) -> String {
        self.get_property_value("subtype").map(|v| strip(v).to_string()).unwrap_or_default()
    }

    pub fn set_subtype(&mut self, value: &str) {
        self.add_property("subtype", strip(value));
    }

    pub fn add_tag(&mut self, tag: &str) {
        let mut tags = self.tags();
        tags.push(tag.to_string());
        self.add_property("tags", &tags.join(","));
    }

    pub fn remove_tag(&mut self, tag: &str) -> Result<()> {
        let mut tags = self.tags();
        let i = tags.iter().position(|t| t == tag).ok_or_else(|| anyhow!("list.remove(x): x not in list"))?;
        tags.remove(i);
        self.add_property("tags", &tags.join(","));
        Ok(())
    }

    pub fn is_btt_mod(&self) -> bool {
        self.get_property_value("modLoader") == Some("BTT")
    }

    // --- files ---------------------------------------------------------------------

    /// Base64 of the embedded preview, else the placeholder.
    pub fn image(&self) -> Result<String> {
        let preview = self.preview_path();
        for f in &self.files {
            if Some(&f.trove_path) == preview.as_ref() {
                return Ok(compat::b64encode(f.data()?));
            }
        }
        Ok(no_preview_image())
    }

    /// The embedded config's bytes.
    pub fn config(&self) -> Result<Option<&[u8]>> {
        let config = self.config_path();
        for f in &self.files {
            if Some(&f.trove_path) == config.as_ref() {
                return f.data().map(Some);
            }
        }
        Ok(None)
    }

    /// The internal paths other than the preview and the config.
    pub fn content_files(&self) -> Vec<String> {
        let (preview, config) = (self.preview_path(), self.config_path());
        self.files.iter().filter(|f| Some(&f.trove_path) != preview.as_ref() && Some(&f.trove_path) != config.as_ref()).map(|f| f.trove_path.clone()).collect()
    }

    /// Only `.tmod`s with a `.swf` count.
    pub fn is_ui_mod(&self) -> bool {
        self.kind == ModKind::Tmod && self.files.iter().any(|f| f.trove_path.ends_with(".swf"))
    }

    pub fn reorder_files(&mut self) -> Result<()> {
        let mut offset = 0u64;
        for f in &mut self.files {
            f.index = 0;
            f.offset = offset;
            offset += format::padded_len(f.data()?.len()) as u64;
        }
        Ok(())
    }

    pub fn reset_cache(&mut self) {
        self.content = None;
        self.hash = None;
    }

    pub fn add_file(&mut self, file: ModFile) -> Result<()> {
        self.files.push(file);
        self.reset_cache();
        self.reorder_files()
    }

    pub fn remove_file(&mut self, index: usize) -> Result<ModFile> {
        let f = self.files.remove(index);
        self.reset_cache();
        self.reorder_files()?;
        Ok(f)
    }

    // --- naming --------------------------------------------------------------------

    pub fn cwd(&self) -> PathBuf {
        self.mod_path.parent().map(Path::to_path_buf).unwrap_or_default()
    }

    pub fn has_wrong_name(&self) -> bool {
        let name = file_name(&self.mod_path);
        let stem = name.split(".tmod").next().unwrap_or("");
        Some(stem) != self.name()
    }

    /// Flips `enabled` and renames `.x` <-> `.x.disabled`.
    pub fn toggle(&mut self) -> Result<()> {
        self.enabled = !self.enabled;
        let ext = if self.kind == ModKind::Tmod { ".tmod" } else { ".zip" };
        let name = file_name(&self.mod_path);
        let new_name = if self.enabled {
            format!("{}{}", name.split(&format!("{}.disabled", ext)).next().unwrap_or(""), ext)
        } else {
            format!("{}{}.disabled", name.split(ext).next().unwrap_or(""), ext)
        };
        let new_path = self.cwd().join(new_name);
        if new_path.exists() {
            return Err(FileExistsError.into());
        }
        compat::rename(&self.mod_path, &new_path)?;
        self.mod_path = new_path;
        Ok(())
    }

    /// Renames the file to `<title>.tmod` (Trove checks the name against the title).
    /// A failed rename is only logged, like Python's.
    pub fn fix_name(&mut self) -> Result<()> {
        let ext = if self.enabled { ".tmod" } else { ".tmod.disabled" };
        let Some(name) = self.name() else { return Err(anyhow!("unsupported operand type(s) for +: 'NoneType' and 'str'")) };
        let new_name = format!("{}{}", name, ext);
        if new_name.contains('/') || (cfg!(windows) && new_name.contains('\\')) {
            return Err(anyhow!("Invalid name {}", compat::repr_str(&new_name)));
        }
        let new_path = self.mod_path.with_file_name(&new_name);
        if compat::same_path(&new_path, &self.mod_path) || new_path.exists() {
            return Ok(());
        }
        match compat::rename(&self.mod_path, &new_path) {
            Ok(()) => {
                self.mod_path = new_path.clone();
                for f in &self.files {
                    f.repoint(&new_path);
                }
            }
            Err(e) => eprintln!("Failed to rename mod {} at {}: {}", name, compat::display(&self.mod_path), e),
        }
        Ok(())
    }

    // --- conflicts -----------------------------------------------------------------

    /// `name_conflicts + file_conflicts`.
    pub fn conflicts(&self) -> Vec<usize> {
        self.name_conflicts.iter().chain(&self.file_conflicts).copied().collect()
    }

    pub fn has_conflicts(&self) -> bool {
        !self.name_conflicts.is_empty() || !self.file_conflicts.is_empty()
    }

    // --- compiling -----------------------------------------------------------------

    /// The TOML document a `.zip` mod carries as `metadata.toml`.
    pub fn metadata(&self) -> Result<String> {
        for needed in ["author", "title"] {
            if self.get_property(needed).is_none() {
                return Err(PropertyError(format!("Property \"{}\" is missing", needed)).into());
            }
        }
        let mut props = Map::new();
        for p in &self.properties {
            if (p.name == "author" || p.name == "title") && p.value.is_empty() {
                return Err(PropertyError(format!("Property \"{}\" has no value", p.name)).into());
            }
            props.insert(p.name.clone(), Value::String(p.value.clone()));
        }
        let props: Vec<(String, String)> = props.into_iter().map(|(k, v)| (k, v.as_str().unwrap_or("").to_string())).collect();
        let files: Vec<String> = self.files.iter().map(|f| f.trove_path.clone()).collect();
        toml_out::dumps_metadata(self.name(), &props, &files)
    }

    /// `compile_zip_mod`. As in Python, a mod whose zip bytes were dropped (and every
    /// `.tmod`) can't be zipped: the property getter recursed forever.
    pub fn compile_zip_mod(&mut self) -> Result<Vec<u8>> {
        match (self.kind, &self.content) {
            (ModKind::Zip, Some(c)) if !c.is_empty() => return Ok(c.clone()),
            (ModKind::Zip, Some(_)) => {}
            _ => return Err(anyhow!("maximum recursion depth exceeded")),
        }
        if self.files.is_empty() {
            return Err(NoFilesError.into());
        }
        self.reorder_files()?;
        let metadata = self.metadata()?;
        let mut entries: Vec<(&str, &[u8])> = Vec::with_capacity(self.files.len() + 1);
        for f in &self.files {
            entries.push((&f.trove_path, f.data()?));
        }
        entries.push(("metadata.toml", metadata.as_bytes()));
        zipmod::write_zip(&entries)
    }

    /// `compile_tmod`: the bytes read from disk when there are any, else a fresh build
    /// (which also stamps `modLoader = BTT`).
    pub fn compile_tmod(&mut self) -> Result<Vec<u8>> {
        if let (ModKind::Tmod, Some(c)) = (self.kind, &self.content) {
            if !c.is_empty() {
                return Ok(c.clone());
            }
        }
        if self.files.is_empty() {
            return Err(NoFilesError.into());
        }
        self.reorder_files()?;
        self.add_property("modLoader", "BTT");
        let props: Vec<(&str, &str)> = self.properties.iter().map(|p| (p.name.as_str(), p.value.as_str())).collect();
        build_container(self.version, &props, &mut self.files)
    }

    /// `tmod_hash` for a `.tmod`, `zip_hash` for a `.zip`: md5 of the bytes the mod was
    /// read from (for a header-only read, just the header), else of a fresh build. This
    /// is what Trovesaurus is asked about. Cached until the files change.
    pub fn hash(&mut self) -> Result<String> {
        if let Some(h) = &self.hash {
            return Ok(h.clone());
        }
        let bytes = match self.kind {
            ModKind::Tmod => self.compile_tmod()?,
            ModKind::Zip => self.compile_zip_mod()?,
        };
        let h = md5_hex(&bytes);
        self.hash = Some(h.clone());
        Ok(h)
    }

    // --- Trovesaurus updates ---------------------------------------------------------

    fn latest_release(&self) -> Option<trovesaurus::TsFile> {
        self.trovesaurus_data.as_ref().and_then(|d| d.releases().first().map(|f| (*f).clone()))
    }

    /// A newer Trovesaurus file exists. Workshop mods never update here (Steam owns them).
    pub fn has_update(&mut self) -> Result<bool> {
        if self.is_workshop {
            return Ok(false);
        }
        match self.latest_release() {
            Some(latest) => Ok(self.hash()? != latest.hash),
            None => Ok(false),
        }
    }

    /// Downloads the latest Trovesaurus file over this one. False when there is none or
    /// the download failed.
    pub fn update(&mut self) -> Result<bool> {
        if !self.has_update()? {
            return Ok(false);
        }
        let Some(latest) = self.latest_release() else { return Ok(false) };
        let url = format!("https://trovesaurus.com/client/downloadfile.php?fileid={}", latest.file_id);
        let label = format!("Updating Mod: {}", self.name().unwrap_or("None"));
        let req = crate::ctx::try_ctx().map(|c| c.external_request(&label, &url));
        let outcome = (|| -> Result<bool> {
            let resp = crate::http::send(crate::http::get(&url).timeout(std::time::Duration::from_secs(60)))?;
            let ok = resp.status() == 200;
            if !ok {
                return Ok(false);
            }
            let data = crate::http::read_bytes(resp, u64::MAX)?;
            let mut stem = file_name(&self.mod_path);
            if let Some(s) = stem.strip_suffix(".disabled") {
                stem = s.to_string();
            }
            if let Some(s) = stem.strip_suffix(".tmod") {
                stem = s.to_string();
            } else if let Some(s) = stem.strip_suffix(".zip") {
                stem = s.to_string();
            }
            let base_ext = format!(".{}", latest.file_type.value());
            let final_ext = if self.enabled { base_ext } else { format!("{}.disabled", base_ext) };
            let new_path = self.cwd().join(format!("{}{}", stem, final_ext));
            if !compat::same_path(&self.mod_path, &new_path) && self.mod_path.exists() {
                compat::unlink(&self.mod_path)?;
            }
            compat::write_bytes(&new_path, &data)?;
            self.mod_path = new_path;
            Ok(true)
        })();
        match outcome {
            Ok(done) => {
                if let Some(r) = req {
                    r.finish(done);
                }
                Ok(done)
            }
            Err(e) => {
                eprintln!("Failed to update mod {}: {}", self.name().unwrap_or("None"), e);
                Ok(false)
            }
        }
    }

    // --- configs -------------------------------------------------------------------

    /// Places or completes `ModCfgs/<title>.cfg` from the embedded config and the mod's
    /// `.swf` sections, keeping whatever the user already set. Only `.tmod`s have one.
    pub fn ensure_config(&self) -> Result<()> {
        if self.kind != ModKind::Tmod {
            return Ok(());
        }
        if !cfg!(windows) && crate::paths::get_mod_cfgs_override().is_none() {
            return Ok(());
        }
        let dir = crate::paths::get_mod_cfgs_dir();
        compat::mkdir_all(&dir)?;
        let config_file = dir.join(format!("{}.cfg", self.name().unwrap_or("None")));
        let mut desired = match self.config()? {
            Some(bytes) => cfg::parse(&compat::decode_lossy_sig(bytes)),
            None => cfg::Sections::new(),
        };
        for f in &self.files {
            if f.trove_path.ends_with(".swf") {
                let swf = f.trove_path.rsplit('/').next().unwrap_or("").to_string();
                desired.entry(swf).or_insert_with(|| Value::Object(Map::new()));
            }
        }
        let current = if config_file.exists() { cfg::parse(&compat::read_text_lossy_sig(&config_file)?) } else { cfg::Sections::new() };
        let merged = cfg::merge(current, &desired);
        if merged.is_empty() {
            return Ok(());
        }
        compat::write_text(&config_file, &cfg::serialize(&merged))
    }
}
