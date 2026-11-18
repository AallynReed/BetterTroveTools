//! Build TMod's file sources: a picked folder kept in game layout by auto-fix (and a
//! watcher), or a virtual list of dropped files. The game is only a layout reference.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::Result;
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::tools::{failed, game_index_paths, guarded, safe_extract_target};
use crate::args::Args;
use crate::ctx::{ctx, try_ctx, Dialog};
use crate::py::{self, display, file_name, file_suffix, path_arg, str_of, truthy};

/// Where each game file lives, for placing files by name.
#[derive(Default)]
pub(super) struct GameIndex {
    by_name: HashMap<String, String>,
    all: HashSet<String>,
}

impl GameIndex {
    pub(super) fn from_paths(paths: impl IntoIterator<Item = String>) -> Self {
        let mut idx = GameIndex::default();
        for full in paths {
            idx.all.insert(full.to_lowercase());
            idx.by_name.entry(py::name_of(&full).to_lowercase()).or_insert(full);
        }
        idx
    }
}

static INDEX_CACHE: Mutex<Option<(PathBuf, Arc<GameIndex>)>> = Mutex::new(None);

fn game_index(game: &Value) -> Result<Option<Arc<GameIndex>>> {
    if !truthy(game) {
        return Ok(None);
    }
    let path = path_arg(game)?;
    if !path.is_dir() {
        return Ok(None);
    }
    let mut cache = INDEX_CACHE.lock();
    if let Some((p, idx)) = cache.as_ref() {
        if py::same_path(p, &path) {
            return Ok(Some(idx.clone()));
        }
    }
    let idx = Arc::new(GameIndex::from_paths(game_index_paths(&path, "", false)?));
    *cache = Some((path, idx.clone()));
    Ok(Some(idx))
}

fn own_path(parts: &[String]) -> String {
    parts.iter().filter(|p| p.to_lowercase() != "override").cloned().collect::<Vec<_>>().join("/")
}

/// The internal path for a file at `parts` (relative to its source root, file name last)
/// and whether it is a game file. A game path stays put, a file named like a game file
/// goes where the game keeps it, anything else keeps its own path.
pub(super) fn resolve_internal(parts: &[String], index: Option<&GameIndex>) -> Option<(String, bool)> {
    let name = parts.last()?;
    let own = own_path(parts);
    if let Some(idx) = index {
        if idx.all.contains(&own.to_lowercase()) {
            return Some((own, true));
        }
        if let Some(p) = idx.by_name.get(&name.to_lowercase()) {
            return Some((p.clone(), true));
        }
    }
    Some((own, false))
}

fn list_files(root: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).map(|e| e.into_path()).collect()
}

/// Every file type the live game's archives hold.
const GAME_EXTENSIONS: [&str; 38] = [
    ".bat", ".binfab", ".blueprint", ".bnk", ".common", ".dds", ".effect", ".fbx", ".fragment", ".gr2", ".gsf", ".han", ".hbo",
    ".hcf", ".het", ".hlv", ".hma", ".hml", ".hmm", ".jpg", ".material", ".old", ".orig", ".pkan", ".pkat", ".pkcf", ".pkfx",
    ".pkma", ".pkml", ".pkmm", ".png", ".psd", ".qmo", ".swf", ".ttf", ".txt", ".vertex", ".xml",
];

/// Dotfiles and `.cfg`s (the config option adds those) never; anything else when
/// `game_types_only` is off.
fn skipped_file(path: &Path, game_types_only: bool) -> bool {
    let ext = file_suffix(path).to_lowercase();
    file_name(path).starts_with('.') || ext == ".cfg" || (game_types_only && !GAME_EXTENSIONS.contains(&ext.as_str()))
}

/// Why `dir` cannot be a source folder: auto-fix moves files, so never inside a game.
fn source_dir_problem(dir: &Path, game: &Value) -> Option<&'static str> {
    if !dir.is_dir() {
        return Some("The source folder does not exist.");
    }
    if truthy(game) {
        if let Ok(g) = path_arg(game) {
            let (g, d) = (py::resolve(&g), py::resolve(dir));
            if py::is_within(&d, &g) || py::is_within(&g, &d) {
                return Some("The source folder cannot be inside or contain a game installation.");
            }
        }
    }
    let is_game = |a: &Path| ["Trove.exe", "Trove_x64.exe"].iter().any(|n| a.join(n).is_file());
    let below = walkdir::WalkDir::new(dir).max_depth(3).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_dir());
    if dir.ancestors().any(is_game) || below.into_iter().any(|e| is_game(e.path())) {
        return Some("The source folder cannot be inside or contain a game installation.");
    }
    None
}

fn remove_empty_parents(from: &Path, root: &Path) {
    let mut cur = from.to_path_buf();
    while py::is_within(&cur, root) && !py::same_path(&cur, root) {
        if std::fs::remove_dir(&cur).is_err() {
            break;
        }
        if !cur.pop() {
            break;
        }
    }
}

/// Lists the folder's mod files and, with `fix`, moves each one not in `keep` (files
/// already placed, possibly by hand) to its game location.
pub(super) fn scan_dir(root: &Path, index: Option<&GameIndex>, fix: bool, keep: &HashSet<String>, game_types_only: bool) -> Result<Value> {
    let (mut files, mut clashes, mut moved) = (Vec::new(), Vec::new(), 0);
    for file in list_files(root) {
        if skipped_file(&file, game_types_only) {
            continue;
        }
        let parts = py::relative_parts(&file, root).unwrap_or_default();
        let own = own_path(&parts);
        let in_game = |p: &str| index.is_some_and(|i| i.all.contains(&p.to_lowercase()));
        if !fix || keep.contains(&display(&file).to_lowercase()) {
            files.push(json!({"path": display(&file), "internal_path": own, "matched": in_game(&own)}));
            continue;
        }
        let Some((internal, matched)) = resolve_internal(&parts, index) else { continue };
        let mut path = file.clone();
        if own.to_lowercase() != internal.to_lowercase() {
            let target = py::join(root, &internal);
            if target.exists() && !py::same_path(&py::resolve(&target), &py::resolve(&file)) {
                clashes.push(json!(parts.join("/")));
                files.push(json!({"path": display(&file), "internal_path": own, "matched": in_game(&own)}));
                continue;
            }
            move_within(&file, &target, root)?;
            path = target;
            moved += 1;
        }
        files.push(json!({"path": display(&path), "internal_path": internal, "matched": matched}));
    }
    files.sort_by(|a, b| str_of(&a["internal_path"]).to_lowercase().cmp(&str_of(&b["internal_path"]).to_lowercase()));
    Ok(json!({"success": true, "files": files, "moved": moved, "clashes": clashes}))
}

fn move_within(file: &Path, target: &Path, root: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        py::mkdir_all(parent)?;
    }
    py::shutil_move(file, target)?;
    if let Some(parent) = file.parent() {
        remove_empty_parents(parent, root);
    }
    Ok(())
}

pub fn ask_build_source_directory(a: &Args) -> Result<Value> {
    let mut d = Dialog::new("Select Mod Source Folder");
    if truthy(a.get(0)) {
        d = d.initial_dir(str_of(a.get(0)));
    }
    Ok(json!(ctx().host().pick_folder(d).map(|p| py::tk_path(&p)).unwrap_or_default()))
}

pub fn ask_build_files(a: &Args) -> Result<Value> {
    let mut d = Dialog::new("Select Files to Add");
    if truthy(a.get(0)) {
        d = d.initial_dir(str_of(a.get(0)));
    }
    Ok(json!(ctx().host().pick_files(d).iter().map(|p| py::tk_path(p)).collect::<Vec<_>>()))
}

/// `(dir, gamePath, fix, keep, gameTypesOnly)`: files listed in `keep` stay where they are.
pub fn scan_build_source(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let dir = path_arg(a.get(0))?;
        if let Some(problem) = source_dir_problem(&dir, a.get(1)) {
            return Ok(failed(problem));
        }
        let index = game_index(a.get(1))?;
        let keep: HashSet<String> = if truthy(a.get(3)) { py::iterate(a.get(3))?.iter().map(|v| str_of(v).to_lowercase()).collect() } else { HashSet::new() };
        scan_dir(&dir, index.as_deref(), a.bool_or(2, true), &keep, a.bool_or(4, true))
    }))
}

/// `(dir, file, internalPath)`: moves a source-folder file to a new internal path.
pub fn move_build_file(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let dir = path_arg(a.get(0))?;
        let file = path_arg(a.get(1))?;
        if !file.is_file() || !py::is_within(&py::resolve(&file), &py::resolve(&dir)) {
            return Ok(failed("That file is not in the source folder."));
        }
        let Some(target) = safe_extract_target(&dir, &str_of(a.get(2))) else {
            return Ok(failed("That path is not valid."));
        };
        if py::same_path(&py::resolve(&target), &py::resolve(&file)) {
            return Ok(json!({"success": true, "path": display(&file)}));
        }
        if target.exists() {
            return Ok(failed("A file already exists at that path."));
        }
        move_within(&file, &target, &dir)?;
        Ok(json!({"success": true, "path": display(&target)}))
    }))
}

/// `(paths, gamePath, gameTypesOnly)`: dropped files and folders, placed without moving anything.
pub fn resolve_build_files(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let index = game_index(a.get(1))?;
        let mut files = Vec::new();
        for p in py::iterate(a.get(0))? {
            let p = path_arg(&p)?;
            let picked: Vec<(PathBuf, Vec<String>)> = if p.is_dir() {
                list_files(&p).into_iter().map(|f| (f.clone(), py::relative_parts(&f, &p).unwrap_or_default())).collect()
            } else {
                vec![(p.clone(), vec![file_name(&p)])]
            };
            for (file, parts) in picked {
                if !file.is_file() || skipped_file(&file, a.bool_or(2, true)) {
                    continue;
                }
                if let Some((internal, matched)) = resolve_internal(&parts, index.as_deref()) {
                    files.push(json!({"path": display(&file), "internal_path": internal, "matched": matched}));
                }
            }
        }
        Ok(json!({"success": true, "files": files}))
    }))
}

/// `(paths, dir)`: copies dropped files (and folders, keeping their layout) into the
/// source folder, never over an existing file.
pub fn copy_into_build_source(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let dir = path_arg(a.get(1))?;
        if !dir.is_dir() {
            return Ok(failed("The source folder does not exist."));
        }
        let (mut copied, mut skipped) = (0, Vec::new());
        for p in py::iterate(a.get(0))? {
            let src = path_arg(&p)?;
            let base = src.parent().map(Path::to_path_buf).unwrap_or_default();
            let picked: Vec<PathBuf> = if src.is_dir() {
                if py::is_within(&py::resolve(&dir), &py::resolve(&src)) || py::is_within(&py::resolve(&src), &py::resolve(&dir)) {
                    skipped.push(json!(display(&src)));
                    continue;
                }
                walkdir::WalkDir::new(&src).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).map(|e| e.into_path()).collect()
            } else {
                vec![src]
            };
            for file in picked {
                let rel = py::relative_parts(&file, &base).unwrap_or_else(|| vec![file_name(&file)]);
                let target = rel.iter().fold(dir.clone(), |acc, part| acc.join(part));
                if !file.is_file() || target.exists() {
                    skipped.push(json!(display(&file)));
                    continue;
                }
                if let Some(parent) = target.parent() {
                    py::mkdir_all(parent)?;
                }
                py::copy2(&file, &target)?;
                copied += 1;
            }
        }
        Ok(json!({"success": true, "copied": copied, "skipped": skipped}))
    }))
}

/// `(title, initialDir)`: where to save a build when no game is selected.
pub fn ask_tmod_save_path(a: &Args) -> Result<Value> {
    let title = if truthy(a.get(0)) { str_of(a.get(0)) } else { "mod".into() };
    let mut d = Dialog::new("Save TMod").default_name(&format!("{}.tmod", title)).filter("Trove Mods", &["tmod"]);
    if truthy(a.get(1)) {
        d = d.initial_dir(str_of(a.get(1)));
    }
    Ok(json!(ctx().host().save_file(d).map(|p| py::tk_path(&p)).unwrap_or_default()))
}

// --- watcher ------------------------------------------------------------------------

static WATCH_GEN: AtomicU64 = AtomicU64::new(0);
const POLL: Duration = Duration::from_millis(1000);

fn snapshot(root: &Path) -> Vec<(PathBuf, u64, Option<SystemTime>)> {
    let mut out: Vec<_> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .take(50_000)
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((e.into_path(), if meta.is_file() { meta.len() } else { u64::MAX }, meta.modified().ok()))
        })
        .collect();
    out.sort();
    out
}

/// `(dir)`: watches the source folder and calls the page's
/// `receive_build_source_changed(dir)` once a change has settled. Null stops it.
pub fn watch_build_source(a: &Args) -> Result<Value> {
    let generation = WATCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if !truthy(a.get(0)) {
        return Ok(json!({"success": true, "watching": false}));
    }
    let dir = path_arg(a.get(0))?;
    if !dir.is_dir() {
        return Ok(failed("The source folder does not exist."));
    }
    let label = display(&dir);
    std::thread::Builder::new().name("build-source-watch".into()).spawn(move || {
        let mut last = snapshot(&dir);
        let mut dirty = false;
        while WATCH_GEN.load(Ordering::SeqCst) == generation {
            std::thread::sleep(POLL);
            if WATCH_GEN.load(Ordering::SeqCst) != generation {
                break;
            }
            let now = snapshot(&dir);
            if now != last {
                last = now;
                dirty = true;
            } else if dirty {
                dirty = false;
                if let Some(c) = try_ctx() {
                    c.js("receive_build_source_changed", vec![json!(label)]);
                }
            }
        }
    })?;
    Ok(json!({"success": true, "watching": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(s: &str) -> Vec<String> {
        s.split('/').map(String::from).collect()
    }

    fn index() -> GameIndex {
        GameIndex::from_paths(["ui/hud.swf", "ui/menus/icon.png", "blueprints/stone.blueprint", "textures/icon.png"].map(String::from))
    }


    fn resolved(p: &str, idx: Option<&GameIndex>) -> (String, bool) {
        resolve_internal(&parts(p), idx).unwrap()
    }

    #[test]
    fn resolves_against_the_game() {
        let idx = Some(index());
        let idx = idx.as_ref();
        assert_eq!(resolved("ui/hud.swf", idx), ("ui/hud.swf".into(), true));
        assert_eq!(resolved("hud.swf", idx), ("ui/hud.swf".into(), true));
        assert_eq!(resolved("ui/override/hud.swf", idx), ("ui/hud.swf".into(), true));
        assert_eq!(resolved("misc/hud.swf", idx), ("ui/hud.swf".into(), true));
        assert_eq!(resolved("textures/icon.png", idx), ("textures/icon.png".into(), true));
        assert_eq!(resolved("icon.png", idx), ("ui/menus/icon.png".into(), true));
        assert_eq!(resolved("ui/custom.swf", idx), ("ui/custom.swf".into(), false));
        assert_eq!(resolved("loose.swf", idx), ("loose.swf".into(), false));
    }

    #[test]
    fn resolves_without_a_game() {
        assert_eq!(resolved("ui/override/hud.swf", None), ("ui/hud.swf".into(), false));
        assert_eq!(resolved("hud.swf", None), ("hud.swf".into(), false));
    }

    fn write(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, rel).unwrap();
    }

    #[test]
    fn scan_fixes_layout_and_keeps_unknown_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for rel in ["hud.swf", "stuff/stone.blueprint", "ui/override/custom.swf", "loose.swf", "textures/icon.png", "icon.png", "cache.pyc", "settings.cfg"] {
            write(root, rel);
        }
        let out = scan_dir(root, Some(&index()), true, &HashSet::new(), true).unwrap();
        assert_eq!(out["moved"], 3, "{out}");
        assert!(root.join("ui/hud.swf").is_file());
        assert!(root.join("blueprints/stone.blueprint").is_file());
        assert!(!root.join("stuff").exists());
        assert!(root.join("ui/menus/icon.png").is_file());
        assert!(root.join("loose.swf").is_file());
        let got: Vec<(String, bool)> = out["files"].as_array().unwrap().iter().map(|f| (str_of(&f["internal_path"]), f["matched"] == true)).collect();
        let want = [("blueprints/stone.blueprint", true), ("loose.swf", false), ("textures/icon.png", true), ("ui/custom.swf", false), ("ui/hud.swf", true), ("ui/menus/icon.png", true)];
        assert_eq!(got, want.map(|(p, m)| (p.to_string(), m)));
        assert_eq!(scan_dir(root, Some(&index()), true, &HashSet::new(), true).unwrap()["moved"], 0);
    }

    #[test]
    fn kept_files_stay_put() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "mine/hud.swf");
        let keep = HashSet::from([display(&root.join("mine").join("hud.swf")).to_lowercase()]);
        let out = scan_dir(root, Some(&index()), true, &keep, true).unwrap();
        assert_eq!(out["moved"], 0);
        assert_eq!(out["files"][0]["internal_path"], "mine/hud.swf");
        assert_eq!(out["files"][0]["matched"], false);
    }

    #[test]
    fn scan_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("ui")).unwrap();
        std::fs::write(root.join("ui/hud.swf"), "a").unwrap();
        std::fs::create_dir_all(root.join("misc")).unwrap();
        std::fs::write(root.join("misc/hud.swf"), "b").unwrap();
        let out = scan_dir(root, Some(&index()), true, &HashSet::new(), true).unwrap();
        assert_eq!(out["clashes"], json!(["misc/hud.swf"]));
        assert_eq!(std::fs::read_to_string(root.join("ui/hud.swf")).unwrap(), "a");
    }

    #[test]
    fn file_type_filter() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for rel in ["ui/a.swf", "x/cache.pyc", "ui/mod.cfg", ".hidden.png"] {
            write(root, rel);
        }
        let names = |only: bool| -> Vec<String> {
            let out = scan_dir(root, None, false, &HashSet::new(), only).unwrap();
            out["files"].as_array().unwrap().iter().map(|f| str_of(&f["internal_path"])).collect()
        };
        assert_eq!(names(true), ["ui/a.swf"]);
        assert_eq!(names(false), ["ui/a.swf", "x/cache.pyc"]);
    }
}
