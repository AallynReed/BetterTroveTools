//! utils/registry.py: detect Trove installs (Glyph registry keys, Steam libraries).

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use super::executable::find_trove_executable;

pub const STEAM_TROVE_ID: &str = "304050";

/// One install. Mirrors `TroveGamePath`.
#[derive(Debug, Clone)]
pub struct TroveGamePath {
    pub path: PathBuf,
    /// The Steam library root holding the install, when it is a Steam install.
    pub steam: Option<PathBuf>,
    pub clean_name: String,
    is_custom: bool,
}

impl PartialEq for TroveGamePath {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path
    }
}

/// `<library>/steamapps/common/Trove/Games/Trove/<Live>` → `<library>`.
pub fn steam_library_from_game_path(path: &Path) -> Option<PathBuf> {
    path.ancestors().skip(1).find(|p| p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case("steamapps")).unwrap_or(false)).and_then(|p| p.parent().map(Path::to_path_buf))
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

impl TroveGamePath {
    /// `TroveGamePath(path, steam)`: a detected install.
    pub fn new(path: impl Into<PathBuf>, steam: Option<PathBuf>) -> Self {
        let path = path.into();
        let steam = steam.or_else(|| steam_library_from_game_path(&path));
        let clean_name = file_name(&path);
        TroveGamePath { path, steam, clean_name, is_custom: false }
    }

    /// `TroveGamePath(path, name=...)`: a custom mods folder (never a Steam root).
    pub fn custom(path: impl Into<PathBuf>, name: &str) -> Self {
        let path = path.into();
        TroveGamePath { path, steam: None, clean_name: name.to_string(), is_custom: true }
    }

    /// `TroveGamePath(path, steam, name)` with all three given.
    pub fn with(path: impl Into<PathBuf>, steam: Option<PathBuf>, name: Option<&str>) -> Self {
        match name {
            Some(n) if !n.is_empty() => {
                let mut g = TroveGamePath::custom(path, n);
                g.steam = steam;
                g
            }
            _ => TroveGamePath::new(path, steam),
        }
    }

    pub fn name(&self) -> String {
        let platform = if self.is_steam() { "Steam" } else { "Glyph" };
        format!("({}) {}", platform, self.clean_name)
    }

    pub fn is_custom(&self) -> bool {
        self.is_custom
    }

    pub fn is_glyph(&self) -> bool {
        !self.is_custom && self.steam.is_none()
    }

    pub fn is_steam(&self) -> bool {
        !self.is_custom && self.steam.is_some()
    }

    pub fn icon(&self) -> &'static str {
        if self.is_glyph() {
            "icons/brands/glyph.png"
        } else if self.is_steam() {
            "icons/brands/steam.png"
        } else {
            "icons/brands/trove.png"
        }
    }

    pub fn executable(&self) -> PathBuf {
        find_trove_executable(&self.path).unwrap_or_else(|| self.path.join("Trove_x64.exe"))
    }

    pub fn is_valid(&self) -> bool {
        self.path.exists() && self.executable().exists()
    }

    /// The `mods` folder (created on demand), or the custom folder itself.
    pub fn mods_path(&self) -> PathBuf {
        if !self.is_custom {
            let mods = self.path.join("mods");
            let _ = std::fs::create_dir_all(&mods);
            return mods;
        }
        self.path.clone()
    }

    pub fn workshop_path(&self) -> Option<PathBuf> {
        if self.is_steam() {
            let p = self.steam.as_ref()?.join("steamapps").join("workshop").join("content").join(STEAM_TROVE_ID);
            if p.exists() {
                return Some(p);
            }
        }
        None
    }

    /// True when `path` sits under the Steam Workshop folder (Steam owns those files).
    pub fn is_workshop_file(&self, path: &Path) -> bool {
        let Some(root) = self.workshop_path() else { return false };
        match (dunce_canonical(path), dunce_canonical(&root)) {
            (Some(p), Some(r)) => p.starts_with(r),
            _ => false,
        }
    }

    fn collect(&self, suffix: &str) -> Vec<PathBuf> {
        let mut mods = files_with_suffix(&self.mods_path(), suffix, false);
        if let Some(ws) = self.workshop_path() {
            mods.extend(files_with_suffix(&ws, suffix, true));
        }
        mods
    }

    pub fn enabled_tmods(&self) -> Vec<PathBuf> {
        self.collect(".tmod")
    }

    pub fn disabled_tmods(&self) -> Vec<PathBuf> {
        self.collect(".tmod.disabled")
    }

    pub fn enabled_zips(&self) -> Vec<PathBuf> {
        self.collect(".zip")
    }

    pub fn disabled_zips(&self) -> Vec<PathBuf> {
        self.collect(".zip.disabled")
    }
}

/// `Path.resolve()` without the `\\?\` prefix Windows canonicalization adds.
pub fn dunce_canonical(path: &Path) -> Option<PathBuf> {
    let p = std::fs::canonicalize(path).ok()?;
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return Some(PathBuf::from(format!(r"\\{}", rest)));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return Some(PathBuf::from(rest));
    }
    Some(p)
}

/// `path.glob("*" + suffix)` (or `rglob` when `recursive`), files only. Case-insensitive
/// on Windows like Python's glob there.
pub fn files_with_suffix(dir: &Path, suffix: &str, recursive: bool) -> Vec<PathBuf> {
    let matches = |p: &Path| {
        let name = file_name(p);
        if cfg!(windows) {
            name.to_lowercase().ends_with(&suffix.to_lowercase())
        } else {
            name.ends_with(suffix)
        }
    };
    let mut out = Vec::new();
    if recursive {
        for entry in walkdir::WalkDir::new(dir).min_depth(1).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() && matches(entry.path()) {
                out.push(entry.path().to_path_buf());
            }
        }
    } else if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_file() && matches(&p) {
                out.push(p);
            }
        }
    }
    out
}

pub fn sanity_check(path: &Path) -> bool {
    find_trove_executable(path).is_some()
}

fn trove_from_steam_root(steam_root: &Path) -> Vec<TroveGamePath> {
    let mut found = Vec::new();
    let vdf_path = steam_root.join("steamapps").join("libraryfolders.vdf");
    let Ok(text) = std::fs::read_to_string(&vdf_path) else { return found };
    let data = super::vdf::parse(&text);
    let Some(libs) = data.get("libraryfolders").and_then(|v| v.as_object()) else { return found };
    for library in libs.values() {
        let Some(lib_path) = library.get("path").and_then(|v| v.as_str()) else { continue };
        if lib_path.is_empty() {
            continue;
        }
        let library_path = PathBuf::from(lib_path);
        let trove_root = library_path.join("steamapps").join("common").join("Trove").join("Games").join("Trove");
        let Ok(rd) = std::fs::read_dir(&trove_root) else { continue };
        let mut dirs: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for game_path in dirs {
            let game = TroveGamePath::new(game_path, Some(library_path.clone()));
            if game.is_valid() {
                found.push(game);
            }
        }
    }
    found
}

#[cfg(not(windows))]
fn scan() -> Vec<TroveGamePath> {
    let home = dirs::home_dir().unwrap_or_default();
    let roots = [
        home.join(".steam").join("steam"),
        home.join(".steam").join("root"),
        home.join(".local").join("share").join("Steam"),
        home.join(".var").join("app").join("com.valvesoftware.Steam").join(".local").join("share").join("Steam"),
        home.join("Library").join("Application Support").join("Steam"),
    ];
    let mut results: Vec<TroveGamePath> = Vec::new();
    let mut seen_roots = Vec::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        let resolved = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        if seen_roots.contains(&resolved) {
            continue;
        }
        seen_roots.push(resolved);
        for game in trove_from_steam_root(&root) {
            if results.iter().any(|g| g.path == game.path) {
                continue;
            }
            results.push(game);
        }
    }
    results
}

#[cfg(windows)]
fn scan() -> Vec<TroveGamePath> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    fn subkeys_starting(hive: &RegKey, path: &str, prefix: &str) -> Vec<RegKey> {
        let Ok(parent) = hive.open_subkey_with_flags(path, KEY_READ) else { return Vec::new() };
        parent
            .enum_keys()
            .filter_map(|k| k.ok())
            .filter(|k| k.starts_with(prefix))
            .filter_map(|k| parent.open_subkey_with_flags(&k, KEY_READ).ok())
            .collect()
    }

    let hives = [RegKey::predef(HKEY_LOCAL_MACHINE), RegKey::predef(HKEY_CURRENT_USER)];
    let mut results = Vec::new();
    for hive in &hives {
        for key in subkeys_starting(hive, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\", "Glyph Trove") {
            let Ok(location) = key.get_value::<String, _>("InstallLocation") else { continue };
            let game = TroveGamePath::new(PathBuf::from(location), None);
            if game.is_valid() {
                results.push(game);
            }
        }
    }
    for hive in &hives {
        for key in subkeys_starting(hive, r"SOFTWARE\WOW6432Node\Valve\", "Steam") {
            let steam_path = key.get_value::<String, _>("InstallPath").or_else(|_| key.get_value::<String, _>("SteamPath"));
            let Ok(steam_path) = steam_path else { continue };
            results.extend(trove_from_steam_root(Path::new(&steam_path)));
        }
    }
    results
}

static LOCATIONS: Mutex<Option<Vec<TroveGamePath>>> = Mutex::new(None);

/// Drops the cached scan; the next [`get_trove_locations`] rescans.
pub fn invalidate_trove_locations_cache() {
    *LOCATIONS.lock() = None;
}

/// Detected installs. The scan runs once per process.
pub fn get_trove_locations() -> Vec<TroveGamePath> {
    let mut cache = LOCATIONS.lock();
    if let Some(found) = &*cache {
        return found.clone();
    }
    let found = scan();
    *cache = Some(found.clone());
    found
}

/// Adds a `Run` key so the app starts with Windows.
#[cfg(windows)]
pub fn add_to_startup(exe_path: &str, app_name: &str, args: &str) -> std::io::Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    let key = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_WRITE)?;
    key.set_value(app_name, &format!("\"{}\" {}", exe_path, args))
}

#[cfg(windows)]
pub fn remove_from_startup(app_name: &str) -> std::io::Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    let key = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_WRITE)?;
    key.delete_value(app_name)
}
