//! Pulling files out of the archives: one file through a save dialog, or a whole selection
//! into a folder with each `.tfa` inflated once.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use anyhow::{anyhow, Result};
use rayon::prelude::*;
use serde_json::{json, Value};

use super::files;
use crate::py;
use super::{check_cancel, outcome, pool, progress, reset_cancel, save_file};
use crate::{Args, Dialog};

/// One `.tfa`, read and inflated, with Python's error text for a missing file.
pub fn read_archive(path: &Path) -> Result<Vec<u8>> {
    crate::game::archive::decompress(&files::read_file(path)?)
}

pub fn extract_file_to_disk(a: &Args) -> Result<Value> {
    let default_name = a.str(4);
    let dialog = Dialog::new("Save Game File As...").default_name(&default_name).filter("All Files", &["*"]);
    let Some(save_path) = save_file(dialog) else {
        return Ok(json!({ "success": false, "canceled": true }));
    };
    Ok(match extract_one(a, &save_path) {
        Ok(()) => json!({ "success": true, "saved_to": py::tk_path(&save_path) }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    })
}

fn extract_one(a: &Args, save_path: &Path) -> Result<()> {
    let tfi = py::path_arg_components(a.get(0))?;
    let tfa = tfi.parent().unwrap_or(Path::new("")).join(format!("archive{}.tfa", py::str_loose(a.get(1))));
    files::archive_id(&tfa)?;
    let content = read_archive(&tfa)?;
    let bytes = files::binary_read(&content, py::int_loose(a.get(2))?, py::int_loose(a.get(3))?)?;
    files::write_file(save_path, bytes)
}

pub fn mass_extract_files(dest: &Value, files: &Value) -> Value {
    reset_cancel("mass_extract");
    outcome(mass_extract(dest, files).map(|()| json!({ "success": true })))
}

fn field<'a>(f: &'a Value, key: &str) -> Result<&'a Value> {
    f.get(key).ok_or_else(|| anyhow!("'{}'", key))
}

/// `(offset, size, relative_path)` slices to write from one archive.
pub type Spec = (i64, i64, String);

/// Inflates `tfa` once and writes each slice under `dest`. Returns how many were written.
pub fn extract_archive(tfa: &Path, dest: &Path, specs: &[Spec]) -> Result<usize> {
    let content = read_archive(tfa)?;
    let mut made = HashSet::new();
    for (offset, size, rel) in specs {
        let out = dest.join(rel);
        if let Some(parent) = out.parent().filter(|p| !p.as_os_str().is_empty()) {
            if made.insert(parent.to_path_buf()) {
                files::create_dirs(parent)?;
            }
        }
        files::write_file(&out, py::slice_signed(&content, *offset, *offset + *size))?;
    }
    Ok(specs.len())
}

fn mass_extract(dest: &Value, files: &Value) -> Result<()> {
    let dest = py::path_arg_components(dest)?;
    let list = files.as_array().ok_or_else(|| anyhow!("object of type '{}' has no len()", py::type_name(files)))?;
    let total = list.len();
    let start = Instant::now();

    // Grouped by (tfi, archive) in first-seen order so each .tfa is inflated once.
    let mut groups: Vec<(Value, Vec<(String, Vec<&Value>)>)> = Vec::new();
    let mut by_tfi: HashMap<String, usize> = HashMap::new();
    for f in list {
        let tfi = field(f, "tfi")?;
        let archive = py::str_loose(field(f, "archive")?);
        let gi = *by_tfi.entry(tfi.to_string()).or_insert_with(|| {
            groups.push((tfi.clone(), Vec::new()));
            groups.len() - 1
        });
        let archives = &mut groups[gi].1;
        match archives.iter_mut().find(|(a, _)| *a == archive) {
            Some((_, members)) => members.push(f),
            None => archives.push((archive, vec![f])),
        }
    }
    let mut work: Vec<(PathBuf, Vec<Spec>)> = Vec::new();
    for (tfi, archives) in &groups {
        let parent = py::path_arg_components(tfi)?.parent().map(Path::to_path_buf).unwrap_or_default();
        for (archive, members) in archives {
            let mut specs = Vec::with_capacity(members.len());
            for f in members {
                let (offset, size) = (py::int_loose(field(f, "offset")?)?, py::int_loose(field(f, "size")?)?);
                let filepath = field(f, "filepath")?;
                let filepath = filepath.as_str().ok_or_else(|| py::no_attr(filepath, "replace"))?;
                specs.push((offset, size, filepath.replace('\\', "/")));
            }
            work.push((parent.join(format!("archive{}.tfa", archive)), specs));
        }
    }

    let processed = AtomicUsize::new(0);
    pool().install(|| {
        work.par_iter().with_max_len(1).try_for_each(|(tfa, specs)| -> Result<()> {
            check_cancel("mass_extract")?;
            let written = extract_archive(tfa, &dest, specs)?;
            let done = processed.fetch_add(written, Ordering::SeqCst) + written;
            let name = tfa.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            progress(done, total, &name, "Extracting...", start);
            Ok(())
        })
    })
}
