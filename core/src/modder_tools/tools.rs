//! backend/modder_tools/modder_tools.py: building, editing and extracting `.tmod`s, mod
//! projects, and placing override files in the game folder.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, Result};
use regex::Regex;
use serde_json::{json, Map, Value};

use super::now_utc;
use crate::args::Args;
use crate::ctx::{ctx, Dialog};
use crate::game::DIRECTORIES;
use crate::py::{self, display, file_name, file_suffix, path_arg, str_of, strip, strip_value, truthy, Rglob};
use crate::modfile::format::Reader;
use crate::modfile::{normalize_internal_path, ModFile, ModKind, TroveMod};

// --- cancellation -------------------------------------------------------------------

const OPERATIONS: [&str; 8] = [
    "extract_tmod",
    "detect_overrides",
    "auto_structure_workspace",
    "build_tmod",
    "auto_structure_project",
    "place_overrides",
    "remove_overrides",
    "compile_project",
];

static CANCEL_FLAGS: [AtomicBool; 8] = [const { AtomicBool::new(false) }; 8];

fn flag(op: &str) -> Option<&'static AtomicBool> {
    OPERATIONS.iter().position(|o| *o == op).map(|i| &CANCEL_FLAGS[i])
}

fn reset_cancel_flag(op: &str) {
    if let Some(f) = flag(op) {
        f.store(false, Ordering::SeqCst);
    }
}

fn is_cancelled(op: &str) -> bool {
    flag(op).map(|f| f.load(Ordering::SeqCst)).unwrap_or(false)
}

/// `OperationCancelled`.
#[derive(Debug)]
struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Operation cancelled by user.")
    }
}

impl std::error::Error for Cancelled {}

fn raise_if_cancelled(op: &str) -> Result<()> {
    if is_cancelled(op) {
        return Err(Cancelled.into());
    }
    Ok(())
}

fn failed(error: impl std::fmt::Display) -> Value {
    json!({"success": false, "error": error.to_string()})
}

/// The `try: ... except Exception as e: return {"success": False, "error": str(e)}`
/// every endpoint wraps itself in, with `OperationCancelled` reported as such.
fn guarded(body: impl FnOnce() -> Result<Value>) -> Value {
    match body() {
        Ok(v) => v,
        Err(e) if e.is::<Cancelled>() => json!({"success": false, "cancelled": true, "error": e.to_string()}),
        Err(e) => {
            eprintln!("{:#}", e);
            failed(e)
        }
    }
}

pub fn cancel_modder_tools_operation(a: &Args) -> Result<Value> {
    let op = if truthy(a.get(0)) { str_of(a.get(0)) } else { String::new() };
    match flag(&op) {
        None => Ok(json!({"success": false, "error": "Unknown operation."})),
        Some(f) => {
            f.store(true, Ordering::SeqCst);
            Ok(json!({"success": true}))
        }
    }
}

// --- small helpers ------------------------------------------------------------------

const KNOWN_MOD_SUBTYPES: [&str; 18] = [
    "Bard",
    "Boomeranger",
    "Candy Barbarian",
    "Chloromancer",
    "Dino Tamer",
    "Dracolyte",
    "Fae Trickster",
    "Gunslinger",
    "Ice Sage",
    "Knight",
    "Lunar Lancer",
    "Neon Ninja",
    "Pirate Captain",
    "Revenant",
    "Shadow Hunter",
    "Solarion",
    "Tomb Raiser",
    "Vanguardian",
];

const IGNORED_EXTENSIONS: [&str; 14] = [".tfi", ".tfa", ".exe", ".dll", ".tmod", ".zip", ".cfg", ".txt", ".log", ".ini", ".toml", ".json", ".xml", ".dat"];

const PREVIEW_EXTENSIONS: [&str; 3] = [".png", ".jpg", ".jpeg"];

fn valid_dir(name: &str) -> bool {
    DIRECTORIES.contains(&name.to_lowercase().as_str())
}

fn ignored_extension(path: &Path) -> bool {
    IGNORED_EXTENSIONS.contains(&file_suffix(path).to_lowercase().as_str())
}

/// `_decode_data_url`.
fn decode_data_url(v: &Value) -> Result<Option<Vec<u8>>> {
    if !truthy(v) {
        return Ok(None);
    }
    let s = match v {
        Value::String(s) => s,
        Value::Array(items) if !items.contains(&json!(",")) => return Ok(None),
        Value::Object(m) if !m.contains_key(",") => return Ok(None),
        Value::Array(_) | Value::Object(_) => return Err(anyhow!("'{}' object has no attribute 'split'", py::type_name(v))),
        other => return Err(anyhow!("argument of type '{}' is not a container or iterable", py::type_name(other))),
    };
    let Some((_, data)) = s.split_once(',') else { return Ok(None) };
    if !data.is_ascii() {
        return Err(anyhow!("string argument should contain only ASCII characters"));
    }
    Ok(Some(py::a2b_base64(data.as_bytes())?))
}

fn encode_data_url(data: &[u8], mime: &str) -> String {
    format!("data:{};base64,{}", mime, py::b64encode(data))
}

fn illegal_title_chars() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"[<>:"/\\|?*]"#).unwrap())
}

fn clean_title(title: &str) -> String {
    let stripped: String = title.chars().filter(|c| !"\\/*?:\"<>|".contains(*c)).collect();
    strip(&stripped).to_string()
}

/// `_config_internal_path(title)`: `ui/<title>.cfg`.
fn config_internal_path(title: &str) -> String {
    format!("ui/{}.cfg", clean_title(title))
}

/// `_preview_internal_path(title, source_name)`: `ui/<title>.<png|jpg|jpeg>`.
fn preview_internal_path(title: &str, source_name: &Value) -> String {
    let source = if truthy(source_name) { str_of(source_name) } else { String::new() };
    let ext = py::suffix_of(&source).to_lowercase();
    let ext = if PREVIEW_EXTENSIONS.contains(&ext.as_str()) { ext } else { ".png".into() };
    format!("ui/{}{}", clean_title(title), ext)
}

/// `_normalize_internal_path` on a page value (`Path(x)` raised for non-strings).
fn normalize_value(v: &Value) -> Result<Option<String>> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) => Ok(normalize_internal_path(s)),
        other => path_arg(other).map(|_| None).map_err(Into::into),
    }
}

/// `_validate_special_paths`: the error message, if any.
fn validate_special_paths(file_paths: &[Value], preview_path: Option<&str>, include_config: bool, title: &str) -> Result<Option<&'static str>> {
    let mut seen: Vec<String> = Vec::new();
    for p in file_paths {
        let Some(normalized) = normalize_value(p)? else { continue };
        if seen.contains(&normalized) {
            return Ok(Some("You cannot add the same file path more than once."));
        }
        seen.push(normalized);
    }
    if let Some(preview) = preview_path.and_then(normalize_internal_path) {
        if seen.contains(&preview) {
            return Ok(Some("Preview image path cannot also be included in the files list."));
        }
    }
    let mod_cfg = normalize_internal_path(&config_internal_path(title)).unwrap_or_default();
    let mut cfg_paths: Vec<String> = seen.iter().filter(|p| p.to_lowercase().ends_with(".cfg")).cloned().collect();
    if include_config {
        cfg_paths.push(mod_cfg.clone());
        if seen.iter().any(|s| s.to_lowercase() == mod_cfg.to_lowercase()) {
            return Ok(Some("The config file can only be added through the config file option."));
        }
    }
    match cfg_paths.as_slice() {
        [] => Ok(None),
        [one] if one.to_lowercase() == mod_cfg.to_lowercase() => Ok(None),
        [_] => Ok(Some("The config file can only be added through the config file option.")),
        _ => Ok(Some("Only one config file can be included in a mod.")),
    }
}

/// `_split_type_and_subtype`.
fn split_type_and_subtype(tags: &Value, explicit_subtype: &str) -> Result<(Vec<String>, String)> {
    let mut clean = Vec::new();
    let mut found = strip(explicit_subtype).to_string();
    let items = if truthy(tags) { py::iterate(tags)? } else { Vec::new() };
    for tag in items {
        let t = if truthy(&tag) { strip(&str_of(&tag)).to_string() } else { String::new() };
        if t.is_empty() {
            continue;
        }
        if found.is_empty() && KNOWN_MOD_SUBTYPES.contains(&t.as_str()) {
            found = t;
            continue;
        }
        clean.push(t);
    }
    Ok((clean, found))
}

/// `_combine_tags_with_subtype`.
fn combine_tags_with_subtype(tags: &Value, subtype: &str) -> Result<Vec<String>> {
    let (mut clean, _) = split_type_and_subtype(tags, "")?;
    let subtype = strip(subtype);
    if !subtype.is_empty() {
        clean.push(subtype.to_string());
    }
    Ok(clean)
}

/// `payload.get(key, default).strip()`.
fn get_stripped(obj: &Value, key: &str, default: &str) -> Result<String> {
    match py::dict_get(obj, key)? {
        None => Ok(strip(default).to_string()),
        Some(v) => Ok(strip_value(v)?),
    }
}

fn get_or<'a>(obj: &'a Value, key: &str, default: &'a Value) -> Result<&'a Value> {
    Ok(py::dict_get(obj, key)?.unwrap_or(default))
}

/// A title with a trailing `.tmod` dropped.
fn strip_tmod_suffix(title: String) -> String {
    if title.to_lowercase().ends_with(".tmod") {
        let cut: String = title.chars().take(title.chars().count() - 5).collect();
        strip(&cut).to_string()
    } else {
        title
    }
}

fn compile_date() -> String {
    now_utc().timestamp().to_string()
}

/// `path.unlink(missing_ok=True)`.
fn unlink_missing_ok(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(py::os_error(e, path, None)),
        _ => Ok(()),
    }
}

/// Every `index.tfi` under the game's archive folders mapped from lowercase file name
/// to the full posix path of its first occurrence.
fn game_file_map(game_path: &Path, op: &str, log_failures: bool) -> Result<std::collections::HashMap<String, String>> {
    let mut map = std::collections::HashMap::new();
    for d in DIRECTORIES {
        raise_if_cancelled(op)?;
        let dir = game_path.join(d);
        if !dir.exists() {
            continue;
        }
        for tfi in py::rglob_named(&dir, "index.tfi") {
            raise_if_cancelled(op)?;
            let rel_dir = tfi.parent().and_then(|p| py::relative_parts(p, game_path)).unwrap_or_default().join(if cfg!(windows) { "\\" } else { "/" });
            let parsed = (|| -> Result<()> {
                let data = py::read_bytes(&tfi)?;
                let mut r = Reader::new(&data);
                while r.pos < data.len() {
                    let n = r.read_leb_unbounded()? as usize;
                    let internal = r.read_str(n)?;
                    for _ in 0..4 {
                        r.read_leb_unbounded()?;
                    }
                    let full = py::as_posix(&py::join_str(&rel_dir, &internal));
                    map.entry(py::name_of(&full).to_lowercase()).or_insert(full);
                }
                Ok(())
            })();
            if let (Err(e), true) = (parsed, log_failures) {
                eprintln!("Failed to parse {}: {}", display(&tfi), e);
            }
        }
    }
    Ok(map)
}

fn has_dunder_part(file: &Path, root: &Path) -> bool {
    py::relative_parts(file, root).unwrap_or_default().iter().any(|p| p.starts_with("__"))
}

fn rel_posix(file: &Path, root: &Path) -> String {
    py::relative_parts(file, root).unwrap_or_default().join("/")
}

// --- dialogs ------------------------------------------------------------------------

fn initial_dir(a: &Args, i: usize) -> Option<String> {
    truthy(a.get(i)).then(|| str_of(a.get(i)))
}

fn dialog(title: &str, dir: Option<String>) -> Dialog {
    let d = Dialog::new(title);
    match dir {
        Some(dir) => d.initial_dir(dir),
        None => d,
    }
}

pub fn ask_mod_source_directory(_: &Args) -> Result<Value> {
    Ok(json!(ctx().host().pick_folder(Dialog::new("Select Mod Source Folder")).map(|p| py::tk_path(&p)).unwrap_or_default()))
}

pub fn ask_tmod_file(_: &Args) -> Result<Value> {
    let d = Dialog::new("Select TMod File").filter("Trove Mods", &["tmod"]);
    Ok(json!(ctx().host().pick_file(d).map(|p| py::tk_path(&p)).unwrap_or_default()))
}

pub fn ask_extract_destination(_: &Args) -> Result<Value> {
    Ok(json!(ctx().host().pick_folder(Dialog::new("Select Extraction Destination")).map(|p| py::tk_path(&p)).unwrap_or_default()))
}

fn picked_file(path: Option<PathBuf>, mime: impl Fn(&Path) -> String) -> Result<Value> {
    let Some(path) = path else { return Ok(json!({"success": true, "file": null})) };
    let path = py::py_path(&display(&path));
    let data = py::read_bytes(&path)?;
    Ok(json!({
        "success": true,
        "file": {"name": file_name(&path), "path": display(&path), "data": format!("{}{}", mime(&path), py::b64encode(&data))},
    }))
}

pub fn ask_import_file(a: &Args) -> Result<Value> {
    let d = dialog("Select File", initial_dir(a, 0)).filter("All Files", &["*"]);
    import_file_result(ctx().host().pick_file(d))
}

pub(super) fn import_file_result(picked: Option<PathBuf>) -> Result<Value> {
    picked_file(picked, |_| "data:application/octet-stream;base64,".into())
}

pub fn ask_preview_file(a: &Args) -> Result<Value> {
    let d = dialog("Select Preview Image", initial_dir(a, 0)).filter("Images", &["png", "jpg", "jpeg"]).filter("PNG", &["png"]).filter("JPEG", &["jpg", "jpeg"]);
    preview_file_result(ctx().host().pick_file(d))
}

pub(super) fn preview_file_result(picked: Option<PathBuf>) -> Result<Value> {
    picked_file(picked, |p| format!("data:image/{};base64,", if file_suffix(p).to_lowercase() == ".png" { "png" } else { "jpeg" }))
}

pub fn ask_config_file(a: &Args) -> Result<Value> {
    let d = dialog("Select Config File", initial_dir(a, 0)).filter("Config Files", &["cfg"]);
    config_file_result(ctx().host().pick_file(d))
}

pub(super) fn config_file_result(picked: Option<PathBuf>) -> Result<Value> {
    picked_file(picked, |_| "data:text/plain;base64,".into())
}

pub fn ask_add_files(a: &Args) -> Result<Value> {
    let picked = ctx().host().pick_files(dialog("Select Files to Add", initial_dir(a, 0)));
    Ok(classify_added_files(a.get(0), &picked))
}

/// The body of `ask_add_files` after the dialog: which picks map to a game path.
pub(super) fn classify_added_files(game_path_arg: &Value, picked: &[PathBuf]) -> Value {
    let (mut files, mut rejected, mut rejected_cfg) = (Vec::new(), Vec::new(), Vec::new());
    if picked.is_empty() {
        return json!({"success": true, "files": files, "rejected": rejected, "rejected_cfg": rejected_cfg});
    }
    let game_path = match game_path_arg {
        Value::String(s) if !s.is_empty() => Some(py::resolve(&py::py_path(s))),
        _ => None,
    };
    for p in picked {
        let file_path = py::resolve(&py::py_path(&display(p)));
        let mut internal: Vec<String> = Vec::new();
        let mut is_relative = false;
        if let Some(game) = &game_path {
            if let Some(parts) = py::relative_parts(&file_path, game) {
                is_relative = true;
                internal = parts;
            } else {
                let (file_str, game_str) = (display(&file_path), display(game));
                if file_str.to_lowercase().starts_with(&game_str.to_lowercase()) {
                    is_relative = true;
                    let rest: String = file_str.chars().skip(game_str.chars().count()).collect();
                    internal = py::path_parts(rest.trim_matches(|c| c == '\\' || c == '/'));
                }
            }
            internal.retain(|p| p.to_lowercase() != "override");
        }
        let name = file_name(&file_path);
        if !is_relative || internal.is_empty() || !valid_dir(&internal[0]) {
            rejected.push(name);
        } else if file_suffix(&file_path).to_lowercase() == ".cfg" {
            rejected_cfg.push(name);
        } else {
            files.push(json!({"path": display(&file_path), "internal_path": internal.join("/")}));
        }
    }
    json!({"success": true, "files": files, "rejected": rejected, "rejected_cfg": rejected_cfg})
}

// --- .tmod files --------------------------------------------------------------------

/// `_safe_extract_target`: where an archive path may be written under `dest_root`, or
/// `None` when it would escape it (absolute, a drive, `..`).
fn safe_extract_target(dest_root: &Path, internal_path: &str) -> Option<PathBuf> {
    let raw = internal_path.replace('\\', "/");
    let mut parts = Vec::new();
    for part in py::posix_parts(&raw) {
        if part.is_empty() || part == "/" || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') || part == "//" {
            return None;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return None;
    }
    let candidate = parts.iter().fold(dest_root.to_path_buf(), |acc, p| acc.join(p));
    if !py::is_within(&py::resolve(&candidate), &py::resolve(dest_root)) {
        return None;
    }
    Some(candidate)
}

pub fn extract_tmod(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("extract_tmod");
        let tmod_path = path_arg(a.get(0))?;
        let dest_path = path_arg(a.get(1))?;
        if !tmod_path.is_file() {
            return Ok(failed("TMod file does not exist."));
        }
        py::mkdir_all(&dest_path)?;
        let m = TroveMod::read_tmod(&tmod_path, py::read_bytes(&tmod_path)?, false)?;
        let mut count = 0;
        let mut skipped = Vec::new();
        for f in &m.files {
            raise_if_cancelled("extract_tmod")?;
            let Some(out) = safe_extract_target(&dest_path, &f.trove_path) else {
                skipped.push(f.trove_path.clone());
                continue;
            };
            if let Some(parent) = out.parent() {
                py::mkdir_all(parent)?;
            }
            py::write_bytes(&out, f.data()?)?;
            count += 1;
        }
        let mut result = json!({"success": true, "count": count});
        if !skipped.is_empty() {
            result["skipped"] = json!(skipped);
        }
        Ok(result)
    }))
}

fn stripped_arg_path(v: &Value) -> PathBuf {
    let s = if truthy(v) { str_of(v) } else { String::new() };
    py::py_path(strip(&s))
}

pub fn load_tmod_for_edit(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let tmod_path = stripped_arg_path(a.get(0));
        if !tmod_path.is_file() {
            return Ok(failed("TMod file does not exist."));
        }
        let m = TroveMod::read_tmod(&tmod_path, py::read_bytes(&tmod_path)?, false)?;
        let (preview_path, config_path) = (m.preview_path(), m.config_path());
        let (mut preview, mut preview_name, mut config, mut config_name) = (Value::Null, String::new(), Value::Null, String::new());
        let mut regular = Vec::new();
        for f in &m.files {
            let normalized = normalize_internal_path(&f.trove_path);
            if normalized.is_some() && normalized == preview_path {
                preview = json!(encode_data_url(f.data()?, "image/png"));
                preview_name = py::name_of(&f.trove_path);
                continue;
            }
            if normalized.is_some() && normalized == config_path {
                config = json!(encode_data_url(f.data()?, "text/plain"));
                config_name = py::name_of(&f.trove_path);
                continue;
            }
            regular.push(json!({
                "internal_path": f.trove_path,
                "name": py::name_of(&f.trove_path),
                "source": "archive",
                "path": "",
                "data": encode_data_url(f.data()?, "application/octet-stream"),
            }));
        }
        let tags = json!(m.tags());
        let (tags, subtype) = split_type_and_subtype(&tags, &m.subtype())?;
        let title = m.name().filter(|n| !n.is_empty()).map(String::from).unwrap_or_else(|| py::file_stem(&tmod_path));
        Ok(json!({
            "success": true,
            "data": {
                "tmodPath": display(&tmod_path),
                "fileName": file_name(&tmod_path),
                "title": title,
                "author": m.author().unwrap_or(""),
                "version": m.get_property_value("modVersion").filter(|v| !v.is_empty()).unwrap_or("1.0"),
                "notes": m.notes().unwrap_or(""),
                "tags": tags,
                "subtype": subtype,
                "previewBase64": preview,
                "previewName": preview_name,
                "configBase64": config,
                "configName": config_name,
                "files": regular,
            },
        }))
    }))
}

pub fn detect_override_files(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("detect_overrides");
        let source_dir = path_arg(a.get(0))?;
        if !source_dir.is_dir() {
            return Ok(failed("Invalid source directory."));
        }
        let mut files = Vec::new();
        let mut stack: Vec<(PathBuf, Vec<String>, bool)> = vec![(source_dir, Vec::new(), false)];
        while let Some((dir, internal, in_override)) = stack.pop() {
            raise_if_cancelled("detect_overrides")?;
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_override = name.to_lowercase() == "override";
                let mut child = internal.clone();
                if !is_override {
                    child.push(name.clone());
                }
                if child.first().map(|c| !valid_dir(c)).unwrap_or(false) {
                    continue;
                }
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_dir() {
                    stack.push((dir.join(&name), child, in_override || is_override));
                } else if (in_override || is_override) && !child.is_empty() {
                    files.push(json!({"path": display(&dir.join(&name)), "internal_path": child.join("/")}));
                }
            }
        }
        Ok(json!({"success": true, "files": files}))
    }))
}

pub fn auto_structure_workspace(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("auto_structure_workspace");
        let game_path = path_arg(a.get(1))?;
        let workspace = path_arg(a.get(0))?;
        if !game_path.exists() || !workspace.exists() {
            return Ok(failed("Invalid game path or workspace directory."));
        }
        let file_map = game_file_map(&game_path, "auto_structure_workspace", true)?;
        let mut moved = 0;
        for d in DIRECTORIES {
            raise_if_cancelled("auto_structure_workspace")?;
            let target_dir = workspace.join(d);
            if !target_dir.exists() {
                continue;
            }
            for file in Rglob::new(&target_dir) {
                raise_if_cancelled("auto_structure_workspace")?;
                if !file.is_file() || ignored_extension(&file) {
                    continue;
                }
                if py::path_parts(&display(&file)).iter().any(|p| p.to_lowercase() == "override") {
                    continue;
                }
                let Some(expected) = file_map.get(&file_name(&file).to_lowercase()) else { continue };
                let mut parts: Vec<&str> = expected.split('/').collect();
                parts.insert(parts.len() - 1, "override");
                let new_path = py::join(&workspace, &parts.join("/"));
                if !py::same_path(&py::resolve(&file), &py::resolve(&new_path)) {
                    if let Some(parent) = new_path.parent() {
                        py::mkdir_all(parent)?;
                    }
                    py::shutil_move(&file, &new_path)?;
                    moved += 1;
                }
            }
        }
        Ok(json!({"success": true, "count": moved}))
    }))
}

pub fn get_missing_files(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let mut missing = Vec::new();
        for p in py::iterate(a.get(0))? {
            if !path_arg(&p)?.is_file() {
                missing.push(p);
            }
        }
        Ok(json!({"success": true, "missing": missing}))
    }))
}

/// The title checks `build_tmod` and `save_tmod_in_place` share.
fn read_title(payload: &Value, illegal: &str) -> Result<std::result::Result<String, Value>> {
    let title = strip_tmod_suffix(get_stripped(payload, "title", "")?);
    if title.is_empty() {
        return Ok(Err(failed("Mod title is required.")));
    }
    if illegal_title_chars().is_match(&title) {
        return Ok(Err(failed(illegal)));
    }
    Ok(Ok(title))
}

const ILLEGAL_TITLE: &str = "Mod title contains illegal characters (< > : \" / \\ | ? *).";

/// Builds the `.tmod` both editors save: properties, preview, config.
fn new_mod(title: &str, author: &str, version: &str, notes: &str, tags: &Value, subtype: &str) -> Result<TroveMod> {
    let mut m = TroveMod::new(ModKind::Tmod);
    m.set_name(title);
    m.set_author(author);
    m.add_property("modVersion", version);
    m.set_notes(notes);
    for tag in combine_tags_with_subtype(tags, subtype)? {
        m.add_tag(&tag);
    }
    m.add_property("compileDate", &compile_date());
    Ok(m)
}

fn add_preview_and_config(m: &mut TroveMod, preview: Option<(&str, Option<Vec<u8>>)>, config: Option<(&str, Vec<u8>)>) -> Result<()> {
    if let Some((path, Some(bytes))) = preview {
        m.add_file(ModFile::new(path, bytes))?;
        m.set_preview_path(path);
    }
    if let Some((path, bytes)) = config {
        m.add_file(ModFile::new(path, bytes))?;
        m.set_config_path(path);
    }
    Ok(())
}

fn file_internal_path(f: &Value) -> Result<Value> {
    let name = py::dict_get(f, "name")?.cloned().unwrap_or(json!("unknown_file"));
    Ok(py::dict_get(f, "internal_path")?.cloned().unwrap_or(name))
}

pub fn build_tmod(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("build_tmod");
        let payload = a.get(0);
        let game_path_value = py::dict_get(payload, "gamePath")?.cloned().unwrap_or(Value::Null);
        if !truthy(&game_path_value) {
            return Ok(failed("No game installation selected."));
        }
        let game_path = path_arg(&game_path_value)?;
        if !game_path.exists() {
            return Ok(failed("Selected game installation path does not exist."));
        }
        let title = match read_title(payload, ILLEGAL_TITLE)? {
            Ok(t) => t,
            Err(resp) => return Ok(resp),
        };
        let author = get_stripped(payload, "author", "")?;
        let version = get_stripped(payload, "version", "")?;
        let notes = get_stripped(payload, "notes", "")?;
        if py::char_len(&notes) > 220 {
            return Ok(failed("Mod notes cannot exceed 220 characters."));
        }
        let empty_list = json!([]);
        let tags = get_or(payload, "tags", &empty_list)?.clone();
        let subtype = get_stripped(payload, "subtype", "")?;
        let files = get_or(payload, "files", &empty_list)?.clone();
        for (value, msg) in [
            (json!(author), "Mod author is required."),
            (json!(version), "Mod version is required."),
            (json!(notes), "Mod notes are required."),
            (tags.clone(), "At least one tag is required."),
            (files.clone(), "At least one file is required."),
        ] {
            if !truthy(&value) {
                return Ok(failed(msg));
            }
        }

        let config_data = decode_data_url(get_or(payload, "configBase64", &Value::Null)?)?;
        let config_path = config_data.as_ref().map(|_| config_internal_path(&title));
        let preview_name_default = json!("preview.png");
        let preview_name = get_or(payload, "previewName", &preview_name_default)?;
        let preview_b64 = get_or(payload, "previewBase64", &Value::Null)?;
        let preview_path = truthy(preview_b64).then(|| preview_internal_path(&title, preview_name));
        let file_list = py::iterate(&files)?;
        let internal_paths = file_list.iter().map(file_internal_path).collect::<Result<Vec<_>>>()?;
        if let Some(err) = validate_special_paths(&internal_paths, preview_path.as_deref(), config_data.is_some(), &title)? {
            return Ok(failed(err));
        }

        let out_dir = game_path.join("mods");
        let save_path = out_dir.join(format!("{}.tmod", title));
        let overwrite = truthy(get_or(payload, "overwrite", &Value::Bool(false))?);
        if save_path.exists() && !overwrite {
            return Ok(json!({
                "success": false,
                "code": "FILE_EXISTS",
                "error": format!("A mod file named '{}.tmod' already exists in the mods folder.", title),
                "path": display(&save_path),
            }));
        }

        let mut m = new_mod(&title, &author, &version, &notes, &tags, &subtype)?;
        let preview_bytes = decode_data_url(preview_b64)?;
        add_preview_and_config(&mut m, preview_path.as_deref().map(|p| (p, preview_bytes)), config_path.as_deref().zip(config_data))?;

        for (f, internal) in file_list.iter().zip(&internal_paths) {
            raise_if_cancelled("build_tmod")?;
            let abs_path = py::dict_get(f, "abs_path")?.cloned().unwrap_or(Value::Null);
            let internal = path_arg(internal)?;
            let internal = display(&internal);
            if truthy(&abs_path) && path_arg(&abs_path)?.exists() {
                let bytes = py::read_bytes(&path_arg(&abs_path)?)?;
                m.add_file(ModFile::new(&internal, bytes))?;
            } else if let Some(bytes) = decode_data_url(get_or(f, "data", &Value::Null)?)? {
                m.add_file(ModFile::new(&internal, bytes))?;
            }
        }

        py::mkdir_all(&out_dir)?;
        if save_path.exists() && overwrite {
            unlink_missing_ok(&save_path)?;
        }
        m.mod_path = save_path.clone();
        let bytes = m.compile_tmod()?;
        py::write_bytes(&save_path, &bytes)?;
        Ok(json!({"success": true, "path": display(&save_path)}))
    }))
}

pub fn save_tmod_in_place(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("build_tmod");
        let payload = a.get(0);
        let tmod_path_str = strip(&str_of(get_or(payload, "tmodPath", &json!(""))?)).to_string();
        if tmod_path_str.is_empty() {
            return Ok(failed("No TMod file was selected."));
        }
        let source_path = py::py_path(&tmod_path_str);
        if !source_path.is_file() {
            return Ok(failed("Selected TMod file does not exist."));
        }
        let title = match read_title(payload, ILLEGAL_TITLE)? {
            Ok(t) => t,
            Err(resp) => return Ok(resp),
        };
        let save_path = source_path.with_file_name(format!("{}.tmod", title));
        let author = get_stripped(payload, "author", "")?;
        let version = get_stripped(payload, "version", "")?;
        let notes = get_stripped(payload, "notes", "")?;
        let empty_list = json!([]);
        let tags = get_or(payload, "tags", &empty_list)?.clone();
        let subtype = get_stripped(payload, "subtype", "")?;
        let files = get_or(payload, "files", &empty_list)?.clone();
        if author.is_empty() {
            return Ok(failed("Mod author is required."));
        }
        if version.is_empty() {
            return Ok(failed("Mod version is required."));
        }
        if notes.is_empty() {
            return Ok(failed("Mod notes are required."));
        }
        if py::char_len(&notes) > 220 {
            return Ok(failed("Mod notes cannot exceed 220 characters."));
        }
        if !truthy(&tags) {
            return Ok(failed("At least one tag is required."));
        }
        if !truthy(&files) {
            return Ok(failed("At least one file is required."));
        }

        let overwrite = truthy(get_or(payload, "overwrite", &Value::Bool(false))?);
        if save_path.exists() && !overwrite {
            return Ok(json!({
                "success": false,
                "code": "FILE_EXISTS",
                "error": format!("A mod file named '{}' already exists.", file_name(&save_path)),
                "path": display(&save_path),
            }));
        }

        let preview_name_default = json!("preview.png");
        let preview_name = get_or(payload, "previewName", &preview_name_default)?;
        let preview_b64 = get_or(payload, "previewBase64", &Value::Null)?;
        let preview_path = truthy(preview_b64).then(|| preview_internal_path(&title, preview_name));
        let config_data = decode_data_url(get_or(payload, "configBase64", &Value::Null)?)?;
        let config_path = config_data.as_ref().map(|_| config_internal_path(&title));
        let file_list = py::iterate(&files)?;
        let internal_paths = file_list.iter().map(file_internal_path).collect::<Result<Vec<_>>>()?;
        if let Some(err) = validate_special_paths(&internal_paths, preview_path.as_deref(), config_data.is_some(), &title)? {
            return Ok(failed(err));
        }

        let mut m = new_mod(&title, &author, &version, &notes, &tags, &subtype)?;
        m.mod_path = save_path.clone();
        let preview_bytes = decode_data_url(preview_b64)?;
        add_preview_and_config(&mut m, preview_path.as_deref().map(|p| (p, preview_bytes)), config_path.as_deref().zip(config_data))?;

        for (f, internal) in file_list.iter().zip(&internal_paths) {
            raise_if_cancelled("build_tmod")?;
            let internal = path_arg(internal)?;
            let abs_path = strip(&str_of(get_or(f, "path", &json!(""))?)).to_string();
            let bytes = if !abs_path.is_empty() && py::py_path(&abs_path).exists() {
                Some(py::read_bytes(&py::py_path(&abs_path))?)
            } else {
                decode_data_url(get_or(f, "data", &Value::Null)?)?
            };
            let Some(bytes) = bytes else {
                return Ok(failed(format!("Missing file data for {}.", py::as_posix(&display(&internal)))));
            };
            m.add_file(ModFile::new(&display(&internal), bytes))?;
        }

        if save_path.exists() && overwrite {
            unlink_missing_ok(&save_path)?;
        }
        let bytes = m.compile_tmod()?;
        py::write_bytes(&save_path, &bytes)?;
        Ok(json!({"success": true, "path": display(&save_path), "fileName": file_name(&save_path)}))
    }))
}

// --- projects -----------------------------------------------------------------------

fn write_json_indent(path: &Path, data: &Value, indent: usize) -> Result<()> {
    py::write_text(path, &crate::json::dumps_indent(data, indent))
}

/// `sorted(values)` over JSON strings or numbers; mixing them raises like Python.
fn py_sorted(values: Vec<Value>) -> Result<Vec<Value>> {
    if values.iter().all(Value::is_string) {
        let mut v = values;
        v.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        return Ok(v);
    }
    if values.iter().all(Value::is_number) {
        let mut v = values;
        v.sort_by(|a, b| a.as_f64().partial_cmp(&b.as_f64()).unwrap_or(std::cmp::Ordering::Equal));
        return Ok(v);
    }
    let first = values.iter().map(py::type_name).collect::<Vec<_>>();
    let other = first.iter().find(|t| **t != first[0]).copied().unwrap_or(first[0]);
    Err(anyhow!("'<' not supported between instances of '{}' and '{}'", other, first[0]))
}

fn project_dir(a: &Args, i: usize) -> Result<PathBuf> {
    Ok(path_arg(a.get(i))?)
}

fn version_dir(project: &Path, version: &Value) -> PathBuf {
    py::join(project, &format!("v{}", str_of(version)))
}

pub fn load_mod_project(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let project_path = project_dir(a, 0)?;
        if !project_path.is_dir() {
            return Ok(failed("Invalid project directory."));
        }
        let project_file = project_path.join("project.json");
        let mut versions: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&project_path).map_err(|e| py::os_error(e, &project_path, None))?.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_dir() && name.starts_with('v') {
                versions.push(name.trim_start_matches('v').to_string());
            }
        }
        if versions.is_empty() {
            versions.push("1.0".into());
            let v = project_path.join("v1.0");
            if !v.is_dir() {
                std::fs::create_dir(&v).map_err(|e| py::os_error(e, &v, None))?;
            }
        }
        if project_file.exists() {
            let mut data = py::read_json(&project_file)?;
            let Value::Object(map) = &mut data else { return Err(anyhow!("'{}' object has no attribute 'setdefault'", py::type_name(&data))) };
            map.entry("configBase64").or_insert(Value::Null);
            map.entry("configName").or_insert(json!(""));
            map.entry("subtype").or_insert(json!(""));
            let mut all: Vec<Value> = versions.iter().map(|v| json!(v)).collect();
            match map.get("versions") {
                None => {}
                Some(Value::Array(saved)) => all.extend(saved.iter().cloned()),
                Some(other) => return Err(anyhow!("can only concatenate list (not \"{}\") to list", py::type_name(other))),
            }
            let mut unique: Vec<Value> = Vec::new();
            for v in all {
                if !unique.contains(&v) {
                    unique.push(v);
                }
            }
            map.insert("versions".into(), Value::Array(py_sorted(unique)?));
            return Ok(json!({"success": true, "data": data}));
        }
        let default_data = json!({
            "title": file_name(&project_path),
            "author": "",
            "notes": "",
            "tags": [],
            "subtype": "",
            "versions": versions,
            "active_version": versions[0],
            "configBase64": null,
            "configName": "",
        });
        write_json_indent(&project_file, &default_data, 4)?;
        Ok(json!({"success": true, "data": default_data}))
    }))
}

fn py_len(v: &Value) -> Result<usize> {
    match v {
        Value::String(s) => Ok(py::char_len(s)),
        Value::Array(a) => Ok(a.len()),
        Value::Object(m) => Ok(m.len()),
        other => Err(anyhow!("object of type '{}' has no len()", py::type_name(other))),
    }
}

pub fn save_mod_project(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let payload = a.get(1);
        if py_len(get_or(payload, "notes", &json!(""))?)? > 220 {
            return Ok(failed("Mod notes cannot exceed 220 characters."));
        }
        let project_path = project_dir(a, 0)?;
        let project_file = project_path.join("project.json");
        let data = if project_file.exists() {
            let mut data = py::read_json(&project_file)?;
            let (Value::Object(map), Value::Object(update)) = (&mut data, payload) else {
                return Err(anyhow!("'{}' object has no attribute 'update'", py::type_name(&data)));
            };
            for (k, v) in update {
                map.insert(k.clone(), v.clone());
            }
            data
        } else {
            payload.clone()
        };
        write_json_indent(&project_file, &data, 4)?;
        Ok(json!({"success": true}))
    }))
}

pub fn create_project_version(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let project_path = project_dir(a, 0)?;
        let new_version = a.get(1);
        let version_folder = version_dir(&project_path, new_version);
        if version_folder.exists() {
            return Ok(failed("Version folder already exists."));
        }
        py::mkdir_all(&version_folder)?;
        let project_file = project_path.join("project.json");
        if project_file.exists() {
            let mut data = py::read_json(&project_file)?;
            let Value::Object(map) = &mut data else { return Err(anyhow!("'{}' object has no attribute 'get'", py::type_name(&data))) };
            let versions = map.get("versions").cloned().unwrap_or(json!([]));
            let present = match &versions {
                Value::String(s) => match new_version {
                    Value::String(v) => s.contains(v.as_str()),
                    other => return Err(anyhow!("'in <string>' requires string as left operand, not {}", py::type_name(other))),
                },
                other => py::iterate(other)?.contains(new_version),
            };
            if !present {
                let mut list = match &versions {
                    Value::Array(list) => list.clone(),
                    other => return Err(anyhow!("'{}' object has no attribute 'append'", py::type_name(other))),
                };
                list.push(new_version.clone());
                map.insert("versions".into(), Value::Array(py_sorted(list)?));
                map.insert("active_version".into(), new_version.clone());
                write_json_indent(&project_file, &data, 4)?;
            }
        }
        Ok(json!({"success": true}))
    }))
}

pub fn get_project_files(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let target_dir = version_dir(&project_dir(a, 0)?, a.get(1));
        if !target_dir.exists() {
            return Ok(json!({"success": true, "files": []}));
        }
        let mut files = Vec::new();
        for file in Rglob::new(&target_dir) {
            if !file.is_file() || has_dunder_part(&file, &target_dir) {
                continue;
            }
            files.push((rel_posix(&file, &target_dir), file));
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let files: Vec<Value> = files.into_iter().map(|(rel, f)| json!({"name": file_name(&f), "rel_path": rel, "abs_path": display(&f)})).collect();
        Ok(json!({"success": true, "files": files}))
    }))
}

pub fn auto_structure_project_version(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("auto_structure_project");
        let game_path = path_arg(a.get(2))?;
        let target_dir = version_dir(&project_dir(a, 0)?, a.get(1));
        if !game_path.exists() || !target_dir.exists() {
            return Ok(failed("Invalid game path or version directory."));
        }
        let file_map = game_file_map(&game_path, "auto_structure_project", false)?;
        let mut moved = 0;
        let all: Vec<PathBuf> = Rglob::new(&target_dir).collect();
        for file in all {
            raise_if_cancelled("auto_structure_project")?;
            if !file.is_file() || ignored_extension(&file) || has_dunder_part(&file, &target_dir) {
                continue;
            }
            let Some(expected) = file_map.get(&file_name(&file).to_lowercase()) else { continue };
            let new_path = py::join(&target_dir, expected);
            if !py::same_path(&py::resolve(&file), &py::resolve(&new_path)) {
                if let Some(parent) = new_path.parent() {
                    py::mkdir_all(parent)?;
                }
                py::shutil_move(&file, &new_path)?;
                moved += 1;
            }
        }
        Ok(json!({"success": true, "count": moved}))
    }))
}

pub fn place_project_overrides(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("place_overrides");
        let game_path = path_arg(a.get(2))?;
        let target_dir = version_dir(&project_dir(a, 0)?, a.get(1));
        if !game_path.exists() || !target_dir.exists() {
            return Ok(failed("Invalid game path or version directory."));
        }
        let mut placed = Vec::new();
        for file in Rglob::new(&target_dir) {
            raise_if_cancelled("place_overrides")?;
            if !file.is_file() || has_dunder_part(&file, &target_dir) {
                continue;
            }
            let mut parts = py::relative_parts(&file, &target_dir).unwrap_or_default();
            parts.insert(parts.len().saturating_sub(1), "override".into());
            let dest = parts.iter().fold(game_path.clone(), |acc, p| py::join(&acc, p));
            if let Some(parent) = dest.parent() {
                py::mkdir_all(parent)?;
            }
            py::copy2(&file, &dest)?;
            placed.push(display(&dest));
        }
        let count = placed.len();
        Ok(json!({"success": true, "placed_files": placed, "count": count}))
    }))
}

fn trash_root() -> Result<PathBuf> {
    let root = crate::paths::get_app_data_dir().join("ModderToolsTrash");
    py::mkdir_all(&root)?;
    Ok(root)
}

fn undo_manifest_path() -> Result<PathBuf> {
    Ok(trash_root()?.join("undo_remove_overrides.json"))
}

fn read_undo_manifest() -> Result<Map<String, Value>> {
    let path = undo_manifest_path()?;
    if !path.exists() {
        return Ok(Map::new());
    }
    Ok(match py::read_json(&path) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    })
}

fn write_undo_manifest(data: &Map<String, Value>) -> Result<()> {
    write_json_indent(&undo_manifest_path()?, &Value::Object(data.clone()), 2)
}

pub fn remove_project_overrides(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("remove_overrides");
        let mut removed = 0;
        let mut moved = Vec::new();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let backup_dir = trash_root()?.join(&token);
        py::mkdir_all(&backup_dir)?;
        for file_value in py::iterate(a.get(0))? {
            if is_cancelled("remove_overrides") {
                break;
            }
            let file = path_arg(&file_value)?;
            if file.is_file() {
                let backup = backup_dir.join(format!("{}_{}", removed, file_name(&file)));
                py::shutil_move(&file, &backup)?;
                moved.push(json!({"original": display(&file), "backup": display(&backup)}));
                removed += 1;
                if let Some(parent) = file.parent() {
                    if std::fs::read_dir(parent).map(|mut rd| rd.next().is_none()).unwrap_or(false) {
                        let _ = std::fs::remove_dir(parent);
                    }
                }
            }
        }
        let mut manifest = read_undo_manifest()?;
        if !moved.is_empty() {
            manifest.insert(token.clone(), json!({"created_at": py::isoformat_utc(now_utc()), "files": moved}));
            write_undo_manifest(&manifest)?;
        }
        let undo_token = if moved.is_empty() { Value::Null } else { json!(token) };
        if is_cancelled("remove_overrides") {
            return Ok(json!({"success": false, "cancelled": true, "error": "Operation cancelled by user.", "count": removed, "undo_token": undo_token}));
        }
        Ok(json!({"success": true, "count": removed, "undo_token": undo_token}))
    }))
}

pub fn undo_remove_project_overrides(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let token = if truthy(a.get(0)) { strip(&str_of(a.get(0))).to_string() } else { String::new() };
        if token.is_empty() {
            return Ok(failed("Missing undo token."));
        }
        let mut manifest = read_undo_manifest()?;
        let entry = manifest.get(&token).cloned().unwrap_or(Value::Null);
        if !truthy(&entry) {
            return Ok(failed("Undo token not found or expired."));
        }
        let (mut restored, mut conflicts) = (0, Vec::new());
        for item in py::iterate(get_or(&entry, "files", &json!([]))?)? {
            let original = path_arg(get_or(&item, "original", &json!(""))?)?;
            let backup = path_arg(get_or(&item, "backup", &json!(""))?)?;
            if !backup.is_file() {
                continue;
            }
            if original.exists() {
                conflicts.push(display(&original));
                continue;
            }
            if let Some(parent) = original.parent() {
                py::mkdir_all(parent)?;
            }
            py::shutil_move(&backup, &original)?;
            restored += 1;
        }
        let token_dir = trash_root()?.join(&token);
        if token_dir.exists() {
            let _ = std::fs::remove_dir_all(&token_dir);
        }
        manifest.remove(&token);
        write_undo_manifest(&manifest)?;
        Ok(json!({"success": true, "restored": restored, "conflicts": conflicts}))
    }))
}

pub fn compile_project(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        reset_cancel_flag("compile_project");
        let project_path = project_dir(a, 0)?;
        let game_path = path_arg(a.get(2))?;
        let version = a.get(1);
        let target_dir = version_dir(&project_path, version);
        let project_file = project_path.join("project.json");
        if !game_path.exists() || !target_dir.exists() || !project_file.exists() {
            return Ok(failed("Invalid paths or missing project.json. Please save the project first."));
        }
        let meta = py::read_json(&project_file)?;
        if py::char_len(&get_stripped(&meta, "notes", "")?) > 220 {
            return Ok(failed("Mod notes cannot exceed 220 characters. Please edit the notes and try again."));
        }
        let title = strip_tmod_suffix(get_stripped(&meta, "title", "Untitled Project")?);
        let author = get_stripped(&meta, "author", "Unknown")?;
        let notes = get_stripped(&meta, "notes", "")?;
        let empty_list = json!([]);
        let tags = get_or(&meta, "tags", &empty_list)?.clone();
        let subtype = get_stripped(&meta, "subtype", "")?;
        if title.is_empty() {
            return Ok(failed("Project title cannot be empty."));
        }
        if illegal_title_chars().is_match(&title) {
            return Ok(failed("Project title contains illegal characters."));
        }
        let mut m = new_mod(&title, &author, &strip_value(version)?, &notes, &tags, &subtype)?;

        let preview_b64 = get_or(&meta, "previewBase64", &Value::Null)?;
        let preview_name_default = json!("preview.png");
        let preview_name = get_or(&meta, "previewName", &preview_name_default)?;
        let preview_path = truthy(preview_b64).then(|| preview_internal_path(&title, preview_name));
        let config_data = decode_data_url(get_or(&meta, "configBase64", &Value::Null)?)?;
        let config_path = config_data.as_ref().map(|_| config_internal_path(&title));
        let listed: Vec<Value> = Rglob::new(&target_dir).filter(|f| f.is_file()).map(|f| json!(rel_posix(&f, &target_dir))).collect();
        if let Some(err) = validate_special_paths(&listed, preview_path.as_deref(), config_data.is_some(), &title)? {
            return Ok(failed(err));
        }
        let preview_bytes = decode_data_url(preview_b64)?;
        add_preview_and_config(&mut m, preview_path.as_deref().map(|p| (p, preview_bytes)), config_path.as_deref().zip(config_data))?;

        let mut count = 0;
        for file in Rglob::new(&target_dir) {
            raise_if_cancelled("compile_project")?;
            if !file.is_file() || ignored_extension(&file) || has_dunder_part(&file, &target_dir) {
                continue;
            }
            let bytes = py::read_bytes(&file)?;
            m.add_file(ModFile::new(&rel_posix(&file, &target_dir), bytes))?;
            count += 1;
        }
        if count == 0 {
            return Ok(failed(format!("No valid game files found in the v{} folder.", str_of(version))));
        }
        let out_dir = game_path.join("mods");
        py::mkdir_all(&out_dir)?;
        let save_path = out_dir.join(format!("{}.tmod", title));
        if save_path.exists() {
            unlink_missing_ok(&save_path)?;
        }
        m.mod_path = save_path.clone();
        let bytes = m.compile_tmod()?;
        py::write_bytes(&save_path, &bytes)?;
        Ok(json!({"success": true, "path": display(&save_path)}))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_paths_match_python_rules() {
        let paths = |v: &[&str]| v.iter().map(|s| json!(s)).collect::<Vec<_>>();
        assert_eq!(validate_special_paths(&paths(&["ui/a.swf", "UI/A.swf"]), None, false, "T").unwrap(), Some("You cannot add the same file path more than once."));
        assert_eq!(validate_special_paths(&paths(&["ui/t.png"]), Some("ui/T.png"), false, "T").unwrap(), Some("Preview image path cannot also be included in the files list."));
        assert_eq!(validate_special_paths(&paths(&["ui/T.cfg"]), None, false, "T").unwrap(), None);
        assert_eq!(validate_special_paths(&paths(&["ui/other.cfg"]), None, false, "T").unwrap(), Some("The config file can only be added through the config file option."));
        assert_eq!(validate_special_paths(&paths(&["ui/t.cfg"]), None, true, "T").unwrap(), Some("The config file can only be added through the config file option."));
        assert_eq!(validate_special_paths(&paths(&["a.cfg", "b.cfg"]), None, false, "T").unwrap(), Some("Only one config file can be included in a mod."));
    }

    #[test]
    fn extract_targets_stay_inside() {
        let root = std::env::temp_dir();
        assert!(safe_extract_target(&root, "ui/a.swf").is_some());
        for bad in ["../x", "/abs/../../x", "C:/x", "//srv/x", "", ".", "a/../../b"] {
            assert!(safe_extract_target(&root, bad).is_none(), "{bad}");
        }
        assert_eq!(safe_extract_target(&root, "/ui/a.swf"), Some(root.join("ui").join("a.swf")));
    }

    #[test]
    fn tags_and_subtypes() {
        let (tags, sub) = split_type_and_subtype(&json!(["UI", " Knight ", "Bard", "", null]), "").unwrap();
        assert_eq!((tags, sub.as_str()), (vec!["UI".to_string(), "Bard".to_string()], "Knight"));
        assert_eq!(combine_tags_with_subtype(&json!(["Knight", "UI"]), "Bard").unwrap(), vec!["UI", "Bard"]);
        assert_eq!(preview_internal_path("My Mod", &json!("pic.PNG.JPG")), "ui/My Mod.jpg");
        assert_eq!(preview_internal_path("My Mod", &json!("pic.gif")), "ui/My Mod.png");
        assert_eq!(config_internal_path(" a?b "), "ui/ab.cfg");
    }
}
