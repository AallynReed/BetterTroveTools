//! `load_entire_game_tree`: every file in every `index.tfi` under the install, as one
//! nested folder tree in `temp_tree.json`, rebuilt only when an index changes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use rayon::prelude::*;
use serde_json::{json, Value};

use super::py::{self, path_arg, rel_posix, rglob_index};
use super::{check_cancel, outcome, reset_cancel};
use crate::game::archive::{md5_hex, parse_index, IndexEntry};
use crate::paths::{display, get_cache_root};

const CACHED_FILE: &str = "/api/cache/temp_tree.json";

pub fn load_entire_game_tree(game: &Value, force_refresh: bool) -> Value {
    reset_cancel("load_tree");
    outcome(load(game, force_refresh))
}

fn load(game: &Value, force_refresh: bool) -> Result<Value> {
    let cache_dir = get_cache_root();
    py::create_dirs(&cache_dir)?;
    let cache_file = cache_dir.join("temp_tree.json");
    let manifest_file = cache_dir.join("temp_tree_manifest.json");

    let game_path = path_arg(game)?;
    if !game_path.exists() {
        return Err(anyhow!("Game path does not exist."));
    }
    let indexes = rglob_index(&game_path);
    let signature = index_signature(&game_path, &indexes);
    let game_str = display(&game_path);

    if !force_refresh && cache_file.exists() && manifest_file.exists() {
        let manifest = std::fs::read_to_string(&manifest_file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({}));
        let manifest = manifest.as_object().ok_or_else(|| py::no_attr(&manifest, "get"))?;
        if manifest.get("game_path") == Some(&json!(game_str)) && manifest.get("signature") == Some(&json!(signature)) {
            return Ok(json!({ "success": true, "cached_file": CACHED_FILE, "from_cache": true }));
        }
    }

    let tree = build_tree(&game_path, &indexes)?;
    py::write_file(&cache_file, tree.as_bytes())?;
    let manifest = crate::json::dumps(&json!({ "game_path": game_str, "signature": signature }));
    py::write_file(&manifest_file, manifest.as_bytes())?;
    Ok(json!({ "success": true, "cached_file": CACHED_FILE, "from_cache": false }))
}

/// `_index_signature`: md5 over every index's relative path, mtime and size, sorted.
fn index_signature(game: &Path, indexes: &[PathBuf]) -> String {
    let mut parts: Vec<String> = indexes
        .iter()
        .filter_map(|tfi| {
            let meta = std::fs::metadata(tfi).ok()?;
            Some(format!("{}|{}|{}", rel_posix(game, tfi), py::mtime_ns(&meta), meta.len()))
        })
        .collect();
    parts.sort();
    md5_hex(parts.join("\n").as_bytes())
}

#[derive(Default)]
struct Folder {
    children: BTreeMap<String, Folder>,
    files: Vec<FileNode>,
}

struct FileNode {
    name: String,
    entry: IndexEntry,
    /// Index into the escaped `tfi_parent` strings.
    tfi: usize,
}

pub(super) fn build_tree(game: &Path, indexes: &[PathBuf]) -> Result<String> {
    check_cancel("load_tree")?;
    let parsed: Vec<Vec<IndexEntry>> = indexes
        .par_iter()
        .map(|tfi| {
            check_cancel("load_tree")?;
            parse_index(&py::read_file(tfi)?)
        })
        .collect::<Result<_>>()?;

    let mut root = Folder::default();
    let mut parents = Vec::with_capacity(indexes.len());
    for (tfi, entries) in indexes.iter().zip(parsed) {
        check_cancel("load_tree")?;
        let base: Vec<String> = tfi
            .parent()
            .and_then(|p| p.strip_prefix(game).ok())
            .map(|rel| rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        parents.push(json_str(&display(tfi)));
        for entry in entries {
            let internal = entry.name.replace('\\', "/");
            let parts: Vec<&str> = base.iter().map(String::as_str).chain(internal.split('/')).collect();
            let (name, dirs) = parts.split_last().expect("split yields at least one part");
            let mut node = &mut root;
            for dir in dirs {
                node = node.children.entry((*dir).to_string()).or_default();
            }
            node.files.push(FileNode { name: (*name).to_string(), entry, tfi: parents.len() - 1 });
        }
    }

    let mut out = String::with_capacity(64 * 1024 * 1024);
    write_folder(&mut out, &mut root, &parents);
    Ok(out)
}

/// `json.dumps` of one string.
fn json_str(s: &str) -> String {
    crate::json::dumps(&Value::String(s.to_string()))
}

/// Writes a folder node exactly as `json.dump(tree)` did, sorting as `process_node` did.
/// Returns `(dir_count_total, file_count_total)`.
fn write_folder(out: &mut String, folder: &mut Folder, parents: &[String]) -> (usize, usize) {
    folder.files.sort_by(|a, b| a.name.cmp(&b.name));
    let (dirs_direct, files_direct) = (folder.children.len(), folder.files.len());
    let (mut dirs_total, mut files_total) = (dirs_direct, files_direct);

    out.push_str("{\"type\": \"folder\", \"children\": {");
    for (i, (name, child)) in folder.children.iter_mut().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&json_str(name));
        out.push_str(": ");
        let (d, f) = write_folder(out, child, parents);
        dirs_total += d;
        files_total += f;
    }
    out.push_str("}, \"files\": [");
    for (i, file) in folder.files.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        let e = &file.entry;
        out.push_str(&format!(
            "{{\"name\": {}, \"type\": \"file\", \"size\": {}, \"archive_index\": {}, \"offset\": {}, \"hash\": {}, \"tfi_parent\": {}}}",
            json_str(&file.name),
            e.size,
            e.archive_index,
            e.offset,
            e.hash,
            parents[file.tfi]
        ));
    }
    out.push_str(&format!(
        "], \"dir_count_direct\": {}, \"file_count_direct\": {}, \"dir_count_total\": {}, \"file_count_total\": {}}}",
        dirs_direct, files_direct, dirs_total, files_total
    ));
    (dirs_total, files_total)
}
