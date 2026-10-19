//! Update tracking: a baseline of md5s for every index, archive and file
//! (`extraction_data.json` in the tracking folder), and a scan that diffs the install
//! against it, extracts what was added or changed, and writes a changelog.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use rayon::prelude::*;
use serde_json::{json, Map, Value};

use super::extract::{extract_archive, read_archive, Spec};
use super::py::{self, archives_of, as_posix, io_err, no_attr, path_arg, rel_posix, rglob_index, stat_sig, utc_iso_z};
use super::{check_cancel, outcome, pool, progress, reset_cancel, Cancelled};
use crate::game::archive::{md5_hex, parse_index};
use crate::game::executable::find_trove_executable;
use crate::paths::display;

const DATA_FILE: &str = "extraction_data.json";

pub fn get_tracking_status(dir: &Value) -> Result<Value> {
    let data_path = path_arg(dir)?.join(DATA_FILE);
    if !data_path.exists() {
        return Ok(json!({ "exists": false }));
    }
    let status = py::read_json(&data_path).and_then(|data| {
        let obj = data.as_object().ok_or_else(|| no_attr(&data, "get"))?;
        let get = |key: &str| obj.get(key).cloned().unwrap_or_else(|| json!("Unknown"));
        Ok(json!({ "exists": true, "last_scan": get("last_scan_date"), "game_path": get("game_path") }))
    });
    Ok(status.unwrap_or_else(|e| json!({ "exists": false, "error": e.to_string() })))
}

fn file_key(rel_tfi: &str, name: &str) -> String {
    format!("{}::{}", rel_tfi, name.replace('\\', "/"))
}

// --- Baseline -------------------------------------------------------------------------

pub fn build_baseline_cache(game: &Value, tracking: &Value) -> Value {
    reset_cancel("build_baseline");
    outcome(build_baseline(game, tracking).map(|()| json!({ "success": true })))
}

/// `(file key, offset, size)` of one index entry.
type Slice = (String, u32, u32);

fn build_baseline(game_arg: &Value, tracking_arg: &Value) -> Result<()> {
    let game = path_arg(game_arg)?;
    let tracking = path_arg(tracking_arg)?;
    let last_scan = utc_iso_z();
    let mut archives = Map::new();
    let mut stats = Map::new();

    // Pass 1: parse every index and list every archive with the slices it holds.
    let mut work: Vec<(String, PathBuf, Vec<Slice>)> = Vec::new();
    for tfi in rglob_index(&game) {
        check_cancel("build_baseline")?;
        let rel_tfi = rel_posix(&game, &tfi);
        let tfas = archives_of(&tfi)?;
        stats.insert(rel_tfi.clone(), json!(stat_sig(&tfi)));
        let raw = py::read_file(&tfi)?;
        let entries = parse_index(&raw)?;
        archives.insert(rel_tfi.clone(), json!(md5_hex(&raw)));
        let mut by_archive: HashMap<u64, Vec<Slice>> = HashMap::new();
        for e in entries {
            by_archive.entry(e.archive_index as u64).or_default().push((file_key(&rel_tfi, &e.name), e.offset, e.size));
        }
        for (path, id) in tfas {
            let rel_tfa = rel_posix(&game, &path);
            stats.insert(rel_tfa.clone(), json!(stat_sig(&path)));
            work.push((rel_tfa, path, by_archive.get(&id).cloned().unwrap_or_default()));
        }
    }

    // Pass 2: inflate and hash archives across cores.
    let total = work.len();
    let start = Instant::now();
    let done = AtomicUsize::new(0);
    let hashed: Vec<(String, Vec<String>)> = pool().install(|| {
        work.par_iter()
            .with_max_len(1)
            .map(|(rel_tfa, path, slices)| -> Result<_> {
                check_cancel("build_baseline")?;
                let content = read_archive(path)?;
                let hashes = slices.iter().map(|(_, offset, size)| md5_hex(py::py_slice(&content, *offset as i64, *size as i64))).collect();
                let archive_hash = md5_hex(&content);
                drop(content);
                let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                progress(n, total, rel_tfa, "Building Baseline Cache...", start);
                Ok((archive_hash, hashes))
            })
            .collect::<Result<Vec<_>>>()
    })?;

    let mut files = Map::new();
    for ((rel_tfa, _, slices), (archive_hash, hashes)) in work.iter().zip(hashed) {
        archives.insert(rel_tfa.clone(), json!(archive_hash));
        for ((key, _, _), hash) in slices.iter().zip(hashes) {
            files.insert(key.clone(), json!(hash));
        }
    }
    let cache = json!({
        "last_scan_date": last_scan,
        "game_path": game_arg,
        "archives": archives,
        "files": files,
        "stats": stats,
    });
    py::write_text(&tracking.join(DATA_FILE), &crate::json::dumps_indent(&cache, 4))
}

// --- Scan -----------------------------------------------------------------------------

pub fn scan_and_extract_updates(game: &Value, tracking: &Value, run_catalog: bool, full_rescan: bool) -> Value {
    reset_cancel("scan_updates");
    outcome(scan(game, tracking, run_catalog, full_rescan).map(|details| json!({ "success": true, "details": details })))
}

/// One index and its archives, with whether every stat matched the baseline.
struct Plan {
    tfi: PathBuf,
    rel_tfi: String,
    /// The index's folder relative to the install.
    tfi_dir: PathBuf,
    archives: Vec<(PathBuf, u64, String)>,
    unchanged: bool,
}

/// A file found while hashing a changed index.
struct Found {
    key: String,
    hash: String,
    /// Install-relative path, e.g. `ui/store/x.png`.
    path: String,
    tfa: PathBuf,
    offset: u32,
    size: u32,
}

struct Hashed {
    tfi_hash: String,
    archive_hashes: Vec<String>,
    /// `None` when the index and its archives hash the same as the baseline.
    files: Option<Vec<Found>>,
}

/// `old_cache[key]` as a dict (KeyError / AttributeError otherwise).
fn old_map<'a>(old: &'a Map<String, Value>, key: &str) -> Result<&'a Map<String, Value>> {
    let value = old.get(key).ok_or_else(|| anyhow!("'{}'", key))?;
    value.as_object().ok_or_else(|| no_attr(value, "get"))
}

/// Hashes an index and its archives; on any difference, every file it lists.
fn hash_plan(plan: &Plan, old_archives: &Map<String, Value>) -> Result<Hashed> {
    check_cancel("scan_updates")?;
    let raw = py::read_file(&plan.tfi)?;
    let tfi_hash = md5_hex(&raw);
    let mut contents: Vec<Vec<u8>> = Vec::new();
    let mut by_id: HashMap<u64, usize> = HashMap::new();
    let mut archive_hashes = Vec::new();
    let mut changed = false;
    for (path, id, rel_tfa) in &plan.archives {
        let content = read_archive(path)?;
        let hash = md5_hex(&content);
        if old_archives.get(rel_tfa) != Some(&json!(hash)) {
            changed = true;
        }
        by_id.insert(*id, contents.len());
        contents.push(content);
        archive_hashes.push(hash);
    }
    if !changed && old_archives.get(&plan.rel_tfi) == Some(&json!(tfi_hash)) {
        return Ok(Hashed { tfi_hash, archive_hashes, files: None });
    }
    let mut files = Vec::new();
    for e in parse_index(&raw)? {
        check_cancel("scan_updates")?;
        let Some(&slot) = by_id.get(&(e.archive_index as u64)) else { continue };
        let clean = e.name.replace('\\', "/");
        let hash = md5_hex(py::binary_read(&contents[slot], e.offset as i64, e.size as i64)?);
        files.push(Found {
            key: format!("{}::{}", plan.rel_tfi, clean),
            hash,
            path: as_posix(&plan.tfi_dir.join(&clean)),
            tfa: plan.archives[slot].0.clone(),
            offset: e.offset,
            size: e.size,
        });
    }
    Ok(Hashed { tfi_hash, archive_hashes, files: Some(files) })
}

fn scan(game_arg: &Value, tracking_arg: &Value, run_catalog: bool, full_rescan: bool) -> Result<Value> {
    let game = path_arg(game_arg)?;
    let tracking = path_arg(tracking_arg)?;
    let data_path = tracking.join(DATA_FILE);
    let old_value = py::read_json(&data_path)?;
    let old = old_value.as_object().ok_or_else(|| no_attr(&old_value, "get"))?;
    let empty = Map::new();
    let old_stats = || -> Result<&Map<String, Value>> {
        match old.get("stats") {
            None => Ok(&empty),
            Some(v) => v.as_object().ok_or_else(|| no_attr(v, "get")),
        }
    };

    let last_scan = utc_iso_z();
    let date_str = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let update_folder = tracking.join(&date_str);
    let mut stats = Map::new();
    let indexes = rglob_index(&game);
    let total = indexes.len();
    let start = Instant::now();
    let seen = AtomicUsize::new(0);

    // Stat every index and archive; a full match carries the baseline forward unread.
    let mut plans = Vec::with_capacity(total);
    for tfi in indexes {
        check_cancel("scan_updates")?;
        let rel_tfi = rel_posix(&game, &tfi);
        let tfi_dir = tfi.parent().and_then(|p| p.strip_prefix(&game).ok()).map(Path::to_path_buf).unwrap_or_default();
        let mut archives = Vec::new();
        for (path, id) in archives_of(&tfi)? {
            let rel_tfa = rel_posix(&game, &path);
            archives.push((path, id, rel_tfa));
        }
        let sig = stat_sig(&tfi);
        stats.insert(rel_tfi.clone(), json!(sig));
        let mut unchanged = !full_rescan && !old_stats()?.is_empty() && old_stats()?.get(&rel_tfi) == Some(&json!(sig));
        for (path, _, rel_tfa) in &archives {
            let sig = stat_sig(path);
            if old_stats()?.get(rel_tfa) != Some(&json!(sig)) {
                unchanged = false;
            }
            stats.insert(rel_tfa.clone(), json!(sig));
        }
        if unchanged {
            let n = seen.fetch_add(1, Ordering::SeqCst) + 1;
            progress(n, total, &rel_tfi, "Scanning for Updates...", start);
        }
        plans.push(Plan { tfi, rel_tfi, tfi_dir, archives, unchanged });
    }

    // Hash whatever changed on disk, several indexes at a time.
    let strict_archives = if plans.iter().any(|p| !p.unchanged) { Some(old_map(old, "archives")?) } else { None };
    let hashed: Vec<Option<Hashed>> = pool().install(|| {
        plans
            .par_iter()
            .with_max_len(1)
            .map(|plan| -> Result<Option<Hashed>> {
                if plan.unchanged {
                    return Ok(None);
                }
                let hashed = hash_plan(plan, strict_archives.expect("set when any plan needs hashing"))?;
                let n = seen.fetch_add(1, Ordering::SeqCst) + 1;
                progress(n, total, &plan.rel_tfi, "Scanning for Updates...", start);
                Ok(Some(hashed))
            })
            .collect::<Result<Vec<_>>>()
    })?;

    // Merge in index order so the cache, the lists and the changelog match a serial scan.
    let lenient_archives = old.get("archives").and_then(Value::as_object).unwrap_or(&empty);
    let mut grouped: Option<HashMap<&str, Vec<(&String, &Value)>>> = None;
    let mut archives = Map::new();
    let mut files = Map::new();
    let (mut added, mut changed, mut removed): (Vec<Found>, Vec<Found>, Vec<String>) = (Vec::new(), Vec::new(), Vec::new());
    for (plan, result) in plans.iter().zip(hashed) {
        let old_files = old_map(old, "files")?;
        let groups = grouped.get_or_insert_with(|| {
            let mut g: HashMap<&str, Vec<(&String, &Value)>> = HashMap::new();
            for (k, v) in old_files {
                if let Some((tfi, _)) = k.split_once("::") {
                    g.entry(tfi).or_default().push((k, v));
                }
            }
            g
        });
        let previous = groups.get(plan.rel_tfi.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        let carry = |files: &mut Map<String, Value>| {
            for (k, v) in previous {
                files.insert((*k).clone(), (*v).clone());
            }
        };
        let Some(h) = result else {
            if let Some(v) = lenient_archives.get(&plan.rel_tfi) {
                archives.insert(plan.rel_tfi.clone(), v.clone());
            }
            for (_, _, rel_tfa) in &plan.archives {
                if let Some(v) = lenient_archives.get(rel_tfa) {
                    archives.insert(rel_tfa.clone(), v.clone());
                }
            }
            carry(&mut files);
            continue;
        };
        archives.insert(plan.rel_tfi.clone(), json!(h.tfi_hash));
        for ((_, _, rel_tfa), hash) in plan.archives.iter().zip(&h.archive_hashes) {
            archives.insert(rel_tfa.clone(), json!(hash));
        }
        let Some(found) = h.files else {
            carry(&mut files);
            continue;
        };
        let mut current = HashSet::new();
        for f in found {
            current.insert(f.key.clone());
            files.insert(f.key.clone(), json!(f.hash));
            match old_files.get(&f.key).filter(|v| !v.is_null()) {
                None => added.push(f),
                Some(old_hash) if *old_hash != json!(f.hash) => changed.push(f),
                Some(_) => {}
            }
        }
        for (k, _) in previous {
            if !current.contains(*k) {
                removed.push((*k).clone());
            }
        }
    }

    let any_change = !added.is_empty() || !changed.is_empty() || !removed.is_empty();
    if any_change {
        py::create_dirs(&update_folder)?;
        extract_found(&update_folder, &added, &changed)?;
        if run_catalog && (!added.is_empty() || !changed.is_empty()) {
            catalog(&game, &update_folder, &added, &changed)?;
        }
        let secs = start.elapsed().as_secs();
        let elapsed = if secs >= 60 { format!("{}m {}s", secs / 60, secs % 60) } else { format!("{}s", secs) };
        let mut log = format!(
            "Trove Update Scan - {}\nGame Path: {}\nTime Elapsed: {}\n{}\n\n",
            date_str,
            py::py_str(game_arg),
            elapsed,
            "=".repeat(40)
        );
        log.push_str(&format!("ADDED FILES ({}):\n", added.len()));
        for f in &added {
            log.push_str(&format!(" + {}\n", f.path));
        }
        log.push_str(&format!("\nCHANGED FILES ({}):\n", changed.len()));
        for f in &changed {
            log.push_str(&format!(" ~ {}\n", f.path));
        }
        log.push_str(&format!("\nREMOVED FILES ({}):\n", removed.len()));
        for name in &removed {
            log.push_str(&format!(" - {}\n", name.rsplit("::").next().unwrap_or(name)));
        }
        py::write_text(&update_folder.join("changelog.txt"), &log)?;
        copy2(&data_path, &update_folder.join("extraction_data_backup.json"))?;
    }

    let cache = json!({
        "last_scan_date": last_scan,
        "game_path": game_arg,
        "archives": archives,
        "files": files,
        "stats": stats,
    });
    py::write_text(&data_path, &crate::json::dumps_indent(&cache, 4))?;
    Ok(json!({
        "added": added.len(),
        "changed": changed.len(),
        "removed": removed.len(),
        "folder": if any_change { json!(display(&update_folder)) } else { Value::Null },
    }))
}

/// Writes added files under `added/` and changed ones under `changed/`, each archive
/// inflated once. When two land on the same path the later one wins, as it did serially.
fn extract_found(folder: &Path, added: &[Found], changed: &[Found]) -> Result<()> {
    let out = |sub: &str, f: &Found| py::py_path(&display(&folder.join(sub).join(&f.path)));
    let targets: Vec<(PathBuf, &Found)> =
        added.iter().map(|f| (out("added", f), f)).chain(changed.iter().map(|f| (out("changed", f), f))).collect();
    let last: HashMap<&PathBuf, usize> = targets.iter().enumerate().map(|(i, (out, _))| (out, i)).collect();
    let mut groups: Vec<(PathBuf, Vec<Spec>)> = Vec::new();
    let mut slot: HashMap<&Path, usize> = HashMap::new();
    for (i, (out, f)) in targets.iter().enumerate() {
        if last[out] != i {
            continue;
        }
        let g = *slot.entry(f.tfa.as_path()).or_insert_with(|| {
            groups.push((f.tfa.clone(), Vec::new()));
            groups.len() - 1
        });
        groups[g].1.push((f.offset as i64, f.size as i64, display(out)));
    }
    pool().install(|| {
        groups.par_iter().with_max_len(1).try_for_each(|(tfa, specs)| {
            check_cancel("scan_updates")?;
            extract_archive(tfa, folder, specs).map(|_| ())
        })
    })
}

/// `shutil.copy2`: contents plus access and modification times.
fn copy2(src: &Path, dst: &Path) -> Result<()> {
    std::fs::copy(src, dst).map_err(|e| io_err(e, src))?;
    let meta = std::fs::metadata(src).map_err(|e| io_err(e, src))?;
    if let (Ok(accessed), Ok(modified)) = (meta.accessed(), meta.modified()) {
        let file = std::fs::File::options().write(true).open(dst).map_err(|e| io_err(e, dst))?;
        file.set_times(std::fs::FileTimes::new().set_accessed(accessed).set_modified(modified)).map_err(|e| io_err(e, dst))?;
    }
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
        let target = dst.join(entry.path().strip_prefix(src).unwrap_or(entry.path()));
        if entry.file_type().is_dir() {
            py::create_dirs(&target)?;
        } else {
            copy2(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// The blueprint names `-tool catalog -filter` takes for the changed `.blueprint` files.
fn blueprint_filters(added: &[Found], changed: &[Found]) -> Vec<String> {
    let suffix = regex::Regex::new(r"(?:\[.*\])?\.blueprint").expect("valid regex");
    let prefix = regex::Regex::new(r"^.*_").expect("valid regex");
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for f in added.iter().chain(changed) {
        if !f.path.ends_with(".blueprint") {
            continue;
        }
        let name = Path::new(&f.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let bp = suffix.replace_all(&name, "").into_owned();
        let bp = if bp.split('_').count() >= 5 { prefix.find(&bp).map(|m| m.as_str().to_string()).unwrap_or(bp) } else { bp };
        if seen.insert(bp.clone()) {
            out.push(bp);
        }
    }
    out
}

/// Renders previews of the changed blueprints with the game's own catalog tool, a few
/// hidden processes at a time, then moves the game's `catalog` folder into the update.
fn catalog(game: &Path, update_folder: &Path, added: &[Found], changed: &[Found]) -> Result<()> {
    crate::ctx().js(
        "update_progress_ui",
        vec![json!(1), json!(1), json!("Generating Blueprint Previews..."), json!("Cataloging..."), json!(""), json!("")],
    );
    let filters = blueprint_filters(added, changed);
    if filters.is_empty() {
        return Ok(());
    }
    let exe = find_trove_executable(game).unwrap_or_else(|| game.join("Trove_x64.exe"));
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let limit = cpus.saturating_sub(1).max(1);
    let mut active: Vec<proc::Proc> = Vec::new();
    if let Err(e) = run_catalog_tool(&exe, game, &filters, limit, &mut active) {
        if e.is::<Cancelled>() {
            for p in &active {
                p.terminate();
            }
        }
        return Err(e);
    }

    let catalog_dir = game.join("catalog");
    if catalog_dir.exists() {
        let dest = update_folder.join("catalog");
        if dest.exists() {
            return Err(anyhow!("Destination path '{}' already exists", display(&dest)));
        }
        if std::fs::rename(&catalog_dir, &dest).is_err() {
            copy_tree(&catalog_dir, &dest)?;
            std::fs::remove_dir_all(&catalog_dir).map_err(|e| io_err(e, &catalog_dir))?;
        }
        // Python globbed the update folder itself, not the moved catalog folder.
        for entry in std::fs::read_dir(update_folder).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let matches = if cfg!(windows) { name.to_lowercase().ends_with(".blueprint.png") } else { name.ends_with(".blueprint.png") };
            let renamed = name.replace(".blueprint.png", ".png");
            if matches && renamed != name {
                let target = entry.path().with_file_name(renamed);
                std::fs::rename(entry.path(), &target).map_err(|e| io_err(e, &entry.path()))?;
            }
        }
    }
    Ok(())
}

fn run_catalog_tool(exe: &Path, game: &Path, filters: &[String], limit: usize, active: &mut Vec<proc::Proc>) -> Result<()> {
    for bp in filters {
        check_cancel("scan_updates")?;
        let command = format!("\"{}\" -tool catalog -filter \"{}\" -dimension \"256\"", display(exe), bp);
        active.push(proc::Proc::spawn(&command, game).map_err(|e| proc::spawn_error(e, &command))?);
        if active.len() >= limit {
            wait_all(active)?;
            active.clear();
        }
    }
    wait_all(active)
}

fn wait_all(procs: &[proc::Proc]) -> Result<()> {
    loop {
        check_cancel("scan_updates")?;
        if !procs.iter().any(proc::Proc::running) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// `subprocess.Popen(command_line, cwd=..., startupinfo=<SW_HIDE>)` on Windows.
#[cfg(windows)]
mod proc {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null;

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_count_chars: u32,
        y_count_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        cb_reserved2: u16,
        reserved2: *mut u8,
        std_input: *mut c_void,
        std_output: *mut c_void,
        std_error: *mut c_void,
    }

    #[repr(C)]
    struct ProcessInformation {
        process: *mut c_void,
        thread: *mut c_void,
        process_id: u32,
        thread_id: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateProcessW(
            application_name: *const u16,
            command_line: *mut u16,
            process_attributes: *const c_void,
            thread_attributes: *const c_void,
            inherit_handles: i32,
            creation_flags: u32,
            environment: *const c_void,
            current_directory: *const u16,
            startup_info: *const StartupInfoW,
            process_information: *mut ProcessInformation,
        ) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn TerminateProcess(handle: *mut c_void, exit_code: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    const STARTF_USESHOWWINDOW: u32 = 0x1;
    const SW_HIDE: u16 = 0;
    const WAIT_OBJECT_0: u32 = 0;

    pub struct Proc(*mut c_void);

    // The process handle is only waited on and terminated.
    unsafe impl Send for Proc {}

    impl Proc {
        pub fn spawn(command_line: &str, cwd: &Path) -> std::io::Result<Proc> {
            let mut command: Vec<u16> = command_line.encode_utf16().chain(std::iter::once(0)).collect();
            let dir: Vec<u16> = cwd.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
            let mut si: StartupInfoW = unsafe { std::mem::zeroed() };
            si.cb = std::mem::size_of::<StartupInfoW>() as u32;
            si.flags = STARTF_USESHOWWINDOW;
            si.show_window = SW_HIDE;
            let mut pi: ProcessInformation = unsafe { std::mem::zeroed() };
            let ok = unsafe { CreateProcessW(null(), command.as_mut_ptr(), null(), null(), 0, 0, null(), dir.as_ptr(), &si, &mut pi) };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            unsafe { CloseHandle(pi.thread) };
            Ok(Proc(pi.process))
        }

        pub fn running(&self) -> bool {
            unsafe { WaitForSingleObject(self.0, 0) != WAIT_OBJECT_0 }
        }

        pub fn terminate(&self) {
            unsafe { TerminateProcess(self.0, 1) };
        }
    }

    impl Drop for Proc {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// `[WinError 2] The system cannot find the file specified`.
    pub fn spawn_error(err: std::io::Error, _command: &str) -> anyhow::Error {
        let Some(code) = err.raw_os_error() else { return anyhow::anyhow!(err) };
        let text = err.to_string();
        let text = text.rsplit_once(" (os error").map(|(t, _)| t).unwrap_or(&text).trim_end_matches(['.', ' ']);
        anyhow::anyhow!("[WinError {}] {}", code, text)
    }
}

/// Without a shell, Popen took the whole string as the program; so does this.
#[cfg(not(windows))]
mod proc {
    use std::path::Path;

    pub struct Proc(parking_lot::Mutex<std::process::Child>);

    impl Proc {
        pub fn spawn(command_line: &str, cwd: &Path) -> std::io::Result<Proc> {
            Ok(Proc(parking_lot::Mutex::new(std::process::Command::new(command_line).current_dir(cwd).spawn()?)))
        }

        pub fn running(&self) -> bool {
            matches!(self.0.lock().try_wait(), Ok(None))
        }

        pub fn terminate(&self) {
            let _ = self.0.lock().kill();
        }
    }

    pub fn spawn_error(err: std::io::Error, command: &str) -> anyhow::Error {
        super::io_err(err, Path::new(command))
    }
}
