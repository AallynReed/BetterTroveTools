//! backend/modder_tools/file_manager.py: browse the game's archives, extract files, and
//! track game updates against a baseline of hashes.
//!
//! `load_entire_game_tree` writes `temp_tree.json` to the cache root; the page fetches it
//! through the shared `/api/cache/<filename>` route.

mod extract;
mod files;
#[cfg(test)]
mod tests;
mod tracking;
mod tree;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};

use crate::args::truthy;
use crate::game::executable::find_trove_executable;
use crate::game::registry::{get_trove_locations, invalidate_trove_locations_cache};
use crate::paths::display;
use crate::{Args, Cmd, Dialog, Resp};
use crate::py;

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("cancel_file_manager_operation", |a| Ok(cancel(a))),
        Cmd::std("get_detected_game_paths", |a| Ok(detected_game_paths(a.bool_or(0, false)))),
        Cmd::std("load_entire_game_tree", |a| Ok(tree::load_entire_game_tree(a.get(0), a.bool_or(1, false)))),
        Cmd::std("browse_for_game_dir", |_| Ok(browse_for_game_dir())),
        Cmd::std("browse_for_folder", |a| Ok(browse_for_folder(a))),
        Cmd::std("open_path_in_explorer", |a| Ok(open_path_in_explorer(a))),
        Cmd::std("extract_file_to_disk", extract::extract_file_to_disk),
        Cmd::std("ask_extraction_directory", |_| {
            Ok(Value::String(pick_folder(Dialog::new("Select Extraction Destination")).map(|p| py::tk_path(&p)).unwrap_or_default()))
        }),
        Cmd::std("mass_extract_files", |a| Ok(extract::mass_extract_files(a.get(0), a.get(1)))),
        Cmd::std("select_tracking_directory", |_| {
            Ok(match pick_folder(Dialog::new("Select Update Tracking Folder")) {
                Some(p) => json!({ "success": true, "path": py::tk_path(&p) }),
                None => json!({ "success": false }),
            })
        }),
        Cmd::std("get_tracking_status", |a| tracking::get_tracking_status(a.get(0))),
        Cmd::std("build_baseline_cache", |a| Ok(tracking::build_baseline_cache(a.get(0), a.get(1)))),
        Cmd::std("scan_and_extract_updates", |a| {
            Ok(tracking::scan_and_extract_updates(a.get(0), a.get(1), a.bool_or(2, false), a.bool_or(3, false)))
        }),
        Cmd::std("get_tracking_directories", |_| get_tracking_directories()),
        Cmd::std("save_tracking_directory", |a| save_tracking_directory(a.get(0), a.get(1))),
        Cmd::std("set_last_tracking_directory", |a| set_last_tracking_directory(a.get(0))),
    ]
}

// --- Cancellation ---------------------------------------------------------------------

const OPERATIONS: [&str; 4] = ["load_tree", "mass_extract", "build_baseline", "scan_updates"];
static CANCEL_FLAGS: [AtomicBool; 4] = [AtomicBool::new(false), AtomicBool::new(false), AtomicBool::new(false), AtomicBool::new(false)];

fn flag(operation: &str) -> Option<&'static AtomicBool> {
    OPERATIONS.iter().position(|o| *o == operation).map(|i| &CANCEL_FLAGS[i])
}

fn reset_cancel(operation: &str) {
    if let Some(f) = flag(operation) {
        f.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug)]
struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Operation cancelled by user.")
    }
}

impl std::error::Error for Cancelled {}

/// `_raise_if_cancelled`.
fn check_cancel(operation: &str) -> Result<()> {
    match flag(operation) {
        Some(f) if f.load(Ordering::SeqCst) => Err(Cancelled.into()),
        _ => Ok(()),
    }
}

fn cancel(a: &Args) -> Value {
    let operation = if truthy(a.get(0)) { py::str_loose(a.get(0)) } else { String::new() };
    match flag(&operation) {
        Some(f) => {
            f.store(true, Ordering::SeqCst);
            json!({ "success": true })
        }
        None => json!({ "success": false, "error": "Unknown operation." }),
    }
}

/// The long operations' `except OperationCancelled` / `except Exception` tails.
fn outcome(result: Result<Value>) -> Value {
    match result {
        Ok(v) => v,
        Err(e) if e.is::<Cancelled>() => json!({ "success": false, "cancelled": true, "error": e.to_string() }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

// --- Progress -------------------------------------------------------------------------

/// `eel.update_progress_ui(done, total, label, phase, eta, elapsed)`.
fn progress(done: usize, total: usize, label: &str, phase: &str, start: Instant) {
    let elapsed = start.elapsed().as_secs_f64();
    let eta = if elapsed > 0.5 && done > 0 { json!(((total as f64 - done as f64) / (done as f64 / elapsed)) as i64) } else { json!("") };
    crate::ctx().js("update_progress_ui", vec![json!(done), json!(total), json!(label), json!(phase), eta, json!(elapsed as i64)]);
}

/// Python's `max(2, min(os.cpu_count(), 6))` worker pool: bounds how many inflated
/// archives are held at once. Callers use `with_max_len(1)` so one huge archive can't
/// hold a whole batch of small ones behind it.
fn pool() -> rayon::ThreadPool {
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    rayon::ThreadPoolBuilder::new().num_threads(cpus.clamp(2, 6)).build().expect("thread pool")
}

// --- Dialogs --------------------------------------------------------------------------

#[cfg(not(test))]
fn pick_folder(dialog: Dialog) -> Option<PathBuf> {
    crate::ctx().host().pick_folder(dialog)
}

#[cfg(not(test))]
fn save_file(dialog: Dialog) -> Option<PathBuf> {
    crate::ctx().host().save_file(dialog)
}

#[cfg(test)]
fn pick_folder(_: Dialog) -> Option<PathBuf> {
    tests::PICK.lock().clone()
}

#[cfg(test)]
fn save_file(_: Dialog) -> Option<PathBuf> {
    tests::PICK.lock().clone()
}

fn browse_for_game_dir() -> Value {
    let Some(picked) = pick_folder(Dialog::new("Select Trove Installation Folder")) else {
        return json!({ "success": false, "canceled": true });
    };
    let path = py::path_from_components(&display(&picked));
    if find_trove_executable(&path).is_some() {
        json!({ "success": true, "path": display(&path) })
    } else {
        json!({ "success": false, "error": "No trove*.exe was found in the selected directory." })
    }
}

/// A plain folder picker (no Trove check) for settings that just need a directory.
fn browse_for_folder(a: &Args) -> Value {
    let title = if a.is_empty() || !truthy(a.get(0)) { "Select Folder".to_string() } else { py::str_loose(a.get(0)) };
    match pick_folder(Dialog::new(&title)) {
        Some(p) => json!({ "success": true, "path": display(&py::path_from_components(&display(&p))) }),
        None => json!({ "success": false, "canceled": true }),
    }
}

fn open_path_in_explorer(a: &Args) -> Value {
    let raw = if truthy(a.get(0)) { py::str_loose(a.get(0)).trim().to_string() } else { String::new() };
    if raw.is_empty() {
        return json!({ "success": false, "error": "No path was provided." });
    }
    let target = py::path_from_components(&display(&crate::paths::expand_user(&display(&py::path_from_components(&raw)))));
    if !target.exists() {
        return json!({ "success": false, "error": "The selected path does not exist." });
    }
    match crate::game::open_in_file_manager(&target, a.bool_or(1, false)) {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

// --- Detected installs ----------------------------------------------------------------

fn detected_game_paths(force_refresh: bool) -> Value {
    if force_refresh {
        invalidate_trove_locations_cache();
    }
    let mut paths: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |name: String, path: &str, is_steam: bool, is_glyph: bool| {
        let normalized = path.trim();
        if normalized.is_empty() || !seen.insert(normalized.to_lowercase()) {
            return;
        }
        paths.push(json!({ "name": name, "path": normalized, "is_steam": is_steam, "is_glyph": is_glyph }));
    };

    for game in get_trove_locations() {
        add(game.name(), &display(&py::path_from_components(&display(&game.path))), game.is_steam(), game.is_glyph());
    }
    // Through the endpoint's envelope, so its migration of stale custom folders runs as it did.
    let settings = crate::settings::get_settings(true).map(crate::response::normalize).unwrap_or_default();
    for item in settings.get("custom_directories").and_then(Value::as_array).into_iter().flatten() {
        let (name, path) = match item {
            Value::Object(o) => {
                let path = o.get("path").filter(|p| truthy(p)).map(py::str_loose).unwrap_or_default();
                (o.get("name").map(py::str_loose).unwrap_or_else(|| "Unknown".into()), path)
            }
            other => {
                let raw = py::str_loose(other);
                (py::path_from_components(&raw).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), raw)
            }
        };
        add(format!("(Custom) {}", name), &path, false, false);
    }
    if let Some(last) = settings.get("last_game_path").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        let saved = py::path_from_components(last);
        if find_trove_executable(&saved).is_some() {
            add("(Saved) Last Used".into(), &display(&saved), false, false);
        }
    }
    Resp::ok(json!({ "paths": paths })).with("paths", paths).into()
}

// --- Tracking folders (storage.json) --------------------------------------------------

fn storage_object(data: &mut Value) -> Result<&mut Map<String, Value>> {
    if !data.is_object() {
        return Err(py::no_attr(data, "get"));
    }
    Ok(data.as_object_mut().expect("checked"))
}

fn tracking_list(data: &Map<String, Value>) -> Vec<Value> {
    data.get("tracking_directories").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn entry_path(d: &Value) -> Result<&Value> {
    d.get("path").ok_or_else(|| anyhow!("'path'"))
}

fn get_tracking_directories() -> Result<Value> {
    let mut data = crate::storage::read_storage();
    let store = storage_object(&mut data)?;
    let dirs = tracking_list(store);
    let mut valid = Vec::new();
    for d in &dirs {
        if py::path_arg_components(entry_path(d)?)?.exists() {
            valid.push(d.clone());
        }
    }
    let changed = valid.len() != dirs.len();
    if changed {
        store.insert("tracking_directories".into(), Value::Array(valid.clone()));
    }
    let last_used = store.get("last_tracking_directory").cloned().unwrap_or_else(|| json!(""));
    if changed {
        crate::storage::write_storage(&data)?;
    }
    Ok(json!({ "success": true, "directories": valid, "last_used": last_used }))
}

fn save_tracking_directory(name: &Value, path: &Value) -> Result<Value> {
    let mut data = crate::storage::read_storage();
    let store = storage_object(&mut data)?;
    let mut dirs = tracking_list(store);
    let now = py::utcnow_iso_z();
    let mut found = false;
    for d in dirs.iter_mut() {
        if entry_path(d)? == path {
            d["name"] = name.clone();
            d["last_used"] = json!(now);
            found = true;
            break;
        }
    }
    if !found {
        dirs.push(json!({ "name": name, "path": path, "last_used": now }));
    }
    store.insert("tracking_directories".into(), Value::Array(dirs));
    store.insert("last_tracking_directory".into(), path.clone());
    crate::storage::write_storage(&data)?;
    Ok(json!({ "success": true }))
}

fn set_last_tracking_directory(path: &Value) -> Result<Value> {
    let mut data = crate::storage::read_storage();
    let store = storage_object(&mut data)?;
    let mut dirs = tracking_list(store);
    let now = py::utcnow_iso_z();
    for d in dirs.iter_mut() {
        if entry_path(d)? == path {
            d["last_used"] = json!(now);
            break;
        }
    }
    store.insert("tracking_directories".into(), Value::Array(dirs));
    store.insert("last_tracking_directory".into(), path.clone());
    crate::storage::write_storage(&data)?;
    Ok(json!({ "success": true }))
}
