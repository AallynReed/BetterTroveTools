//! backend/modder_tools/modder_tools.py: building, editing and extracting `.tmod`s.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, Result};
use regex::Regex;
use serde_json::{json, Value};

use super::now_utc;
use crate::args::Args;
use crate::ctx::{ctx, Dialog};
use crate::game::DIRECTORIES;
use crate::py::{self, display, file_name, file_suffix, path_arg, str_of, strip, strip_value, truthy, Rglob};
use crate::modfile::format::Reader;
use crate::modfile::{blocklist, normalize_internal_path, ModFile, ModKind, TroveMod};

// --- cancellation -------------------------------------------------------------------

const OPERATIONS: [&str; 4] = ["extract_tmod", "detect_overrides", "auto_structure_workspace", "build_tmod"];

static CANCEL_FLAGS: [AtomicBool; 4] = [const { AtomicBool::new(false) }; 4];

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

pub(super) fn failed(error: impl std::fmt::Display) -> Value {
    json!({"success": false, "error": error.to_string()})
}

/// The `try: ... except Exception as e: return {"success": False, "error": str(e)}`
/// every endpoint wraps itself in, with `OperationCancelled` reported as such.
pub(super) fn guarded(body: impl FnOnce() -> Result<Value>) -> Value {
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

pub(super) fn valid_dir(name: &str) -> bool {
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
    for full in game_index_paths(game_path, op, log_failures)? {
        map.entry(py::name_of(&full).to_lowercase()).or_insert(full);
    }
    Ok(map)
}

/// The full posix path of every file the game's `index.tfi`s list, in scan order.
pub(super) fn game_index_paths(game_path: &Path, op: &str, log_failures: bool) -> Result<Vec<String>> {
    let mut out = Vec::new();
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
                    out.push(py::as_posix(&py::join_str(&rel_dir, &internal)));
                }
                Ok(())
            })();
            if let (Err(e), true) = (parsed, log_failures) {
                eprintln!("Failed to parse {}: {}", display(&tfi), e);
            }
        }
    }
    Ok(out)
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
pub(super) fn safe_extract_target(dest_root: &Path, internal_path: &str) -> Option<PathBuf> {
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

/// `(dest, files)`: writes Edit TMod's in-memory files (`{internal_path, data | path}`)
/// under `dest`, so replaced and imported files come out as they will be built.
pub fn extract_edit_files(a: &Args) -> Result<Value> {
    Ok(guarded(|| {
        let dest = path_arg(a.get(0))?;
        py::mkdir_all(&dest)?;
        let (mut count, mut skipped) = (0, Vec::new());
        for f in py::iterate(a.get(1))? {
            let internal = str_of(get_or(&f, "internal_path", &Value::Null)?);
            let bytes = match decode_data_url(get_or(&f, "data", &Value::Null)?)? {
                Some(b) => Some(b),
                None => {
                    let src = stripped_arg_path(get_or(&f, "path", &Value::Null)?);
                    src.is_file().then(|| py::read_bytes(&src)).transpose()?
                }
            };
            let (Some(out), Some(bytes)) = (safe_extract_target(&dest, &internal), bytes) else {
                skipped.push(json!(internal));
                continue;
            };
            if let Some(parent) = out.parent() {
                py::mkdir_all(parent)?;
            }
            py::write_bytes(&out, &bytes)?;
            count += 1;
        }
        Ok(json!({"success": true, "count": count, "skipped": skipped}))
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
        let output_value = py::dict_get(payload, "outputPath")?.cloned().unwrap_or(Value::Null);
        let output_path = if truthy(&output_value) { Some(path_arg(&output_value)?) } else { None };
        let game_path = match &output_path {
            Some(_) => None,
            None => {
                let game_path_value = py::dict_get(payload, "gamePath")?.cloned().unwrap_or(Value::Null);
                if !truthy(&game_path_value) {
                    return Ok(failed("No game installation selected."));
                }
                let game_path = path_arg(&game_path_value)?;
                if !game_path.exists() {
                    return Ok(failed("Selected game installation path does not exist."));
                }
                Some(game_path)
            }
        };
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

        let (out_dir, save_path) = match (&output_path, &game_path) {
            (Some(p), _) => (p.parent().map(Path::to_path_buf).unwrap_or_default(), p.clone()),
            (None, Some(g)) => (g.join("mods"), g.join("mods").join(format!("{}.tmod", title))),
            (None, None) => unreachable!(),
        };
        let overwrite = truthy(get_or(payload, "overwrite", &Value::Bool(false))?);
        if save_path.exists() && !overwrite {
            return Ok(json!({
                "success": false,
                "code": "FILE_EXISTS",
                "error": match output_path {
                    Some(_) => format!("A mod file named '{}' already exists in that folder.", file_name(&save_path)),
                    None => format!("A mod file named '{}.tmod' already exists in the mods folder.", title),
                },
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

        m.mod_path = save_path.clone();
        if blocklist::mod_is_blocked(&m) {
            return Ok(failed(blocklist::BLOCKED_MESSAGE));
        }
        py::mkdir_all(&out_dir)?;
        if save_path.exists() && overwrite {
            unlink_missing_ok(&save_path)?;
        }
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

        if blocklist::mod_is_blocked(&m) {
            return Ok(failed(blocklist::BLOCKED_MESSAGE));
        }
        if save_path.exists() && overwrite {
            unlink_missing_ok(&save_path)?;
        }
        let bytes = m.compile_tmod()?;
        py::write_bytes(&save_path, &bytes)?;
        Ok(json!({"success": true, "path": display(&save_path), "fileName": file_name(&save_path)}))
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
