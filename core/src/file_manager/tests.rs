use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::py::rglob_index;
use super::*;
use crate::game::hash::write_uleb;

/// Test-only answer for every folder/save dialog.
pub(super) static PICK: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The cancel flags are process-wide; tests that touch them take turns.
static SERIAL: Mutex<()> = Mutex::new(());

/// Writes `<dir>/index.tfi` + `<dir>/archive0.tfa` holding `files`.
fn write_pack(dir: &Path, files: &[(&str, &[u8])]) {
    std::fs::create_dir_all(dir).unwrap();
    let (mut index, mut blob) = (Vec::new(), Vec::new());
    for (name, data) in files {
        index.extend(write_uleb(name.len() as u64));
        index.extend(name.as_bytes());
        for v in [0, blob.len() as u64, data.len() as u64, 7] {
            index.extend(write_uleb(v));
        }
        blob.extend_from_slice(data);
    }
    std::fs::write(dir.join("index.tfi"), index).unwrap();
    std::fs::write(dir.join("archive0.tfa"), trove_zlib(&blob)).unwrap();
}

/// Compressed the way Trove ships archives: ends at a sync flush, no final block.
fn trove_zlib(data: &[u8]) -> Vec<u8> {
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(data).unwrap();
    z.flush().unwrap();
    z.get_ref().clone()
}

#[test]
fn tree_matches_python_layout() {
    let _serial = SERIAL.lock();
    let game = tempfile::tempdir().unwrap();
    write_pack(&game.path().join("ui"), &[("b.png", b"bb"), ("sub\\a.png", b"a"), ("a.png", b"aaa")]);
    write_pack(&game.path().join("ui").join("sub"), &[("z.png", b"z")]);
    let indexes = rglob_index(game.path());
    let text = tree::build_tree(game.path(), &indexes).unwrap();
    let tree: Value = serde_json::from_str(&text).unwrap();
    let ui = &tree["children"]["ui"];
    assert_eq!(tree["dir_count_total"], 2);
    assert_eq!(tree["file_count_total"], 4);
    let names: Vec<&str> = ui["files"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["a.png", "b.png"]);
    assert_eq!(ui["children"]["sub"]["file_count_direct"], 2);
    assert!(text.starts_with("{\"type\": \"folder\", \"children\": {\"ui\": {\"type\": \"folder\", \"children\": {\"sub\": {"));
}

#[test]
fn baseline_then_scan_finds_changes() {
    let _serial = SERIAL.lock();
    crate::ctx::testing::init();
    let game = tempfile::tempdir().unwrap();
    let track = tempfile::tempdir().unwrap();
    write_pack(&game.path().join("ui"), &[("keep.png", b"same"), ("edit.png", b"old"), ("gone.png", b"x")]);
    let (g, t) = (json!(game.path().to_string_lossy()), json!(track.path().to_string_lossy()));
    assert_eq!(tracking::build_baseline_cache(&g, &t), json!({ "success": true }));

    let quiet = tracking::scan_and_extract_updates(&g, &t, false, false);
    assert_eq!(quiet["details"], json!({ "added": 0, "changed": 0, "removed": 0, "folder": null }));

    write_pack(&game.path().join("ui"), &[("keep.png", b"same"), ("edit.png", b"new!"), ("new\\file.png", b"hi")]);
    let result = tracking::scan_and_extract_updates(&g, &t, false, false);
    let details = &result["details"];
    assert_eq!((details["added"].clone(), details["changed"].clone(), details["removed"].clone()), (json!(1), json!(1), json!(1)));
    let folder = PathBuf::from(details["folder"].as_str().unwrap());
    assert_eq!(std::fs::read(folder.join("added").join("ui").join("new").join("file.png")).unwrap(), b"hi");
    assert_eq!(std::fs::read(folder.join("changed").join("ui").join("edit.png")).unwrap(), b"new!");
    let log = std::fs::read_to_string(folder.join("changelog.txt")).unwrap().replace("\r\n", "\n");
    assert!(log.contains("ADDED FILES (1):\n + ui/new/file.png\n\nCHANGED FILES (1):\n ~ ui/edit.png\n\nREMOVED FILES (1):\n - gone.png\n"));
    assert!(folder.join("extraction_data_backup.json").exists());
}

#[test]
fn mass_extract_writes_slices() {
    let _serial = SERIAL.lock();
    crate::ctx::testing::init();
    let game = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    write_pack(&game.path().join("ui"), &[("a.png", b"AAA"), ("b.png", b"BB")]);
    let tfi = game.path().join("ui").join("index.tfi").to_string_lossy().into_owned();
    let files = json!([
        { "tfi": tfi, "archive": 0, "offset": 3, "size": 2, "filepath": "ui\\b.png" },
        { "tfi": tfi, "archive": 0, "offset": 0, "size": 3, "filepath": "ui/a.png" },
    ]);
    assert_eq!(extract::mass_extract_files(&json!(dest.path().to_string_lossy()), &files), json!({ "success": true }));
    assert_eq!(std::fs::read(dest.path().join("ui").join("b.png")).unwrap(), b"BB");
    let missing = json!([{ "tfi": tfi, "archive": 3, "offset": 0, "size": 1, "filepath": "x" }]);
    let err = extract::mass_extract_files(&json!(dest.path().to_string_lossy()), &missing);
    assert!(err["error"].as_str().unwrap().starts_with("[Errno 2] No such file or directory: '"), "{err}");
}

#[test]
fn cancel_flags() {
    let _serial = SERIAL.lock();
    assert_eq!(cancel(&Args::new(vec![json!("nope")])), json!({ "success": false, "error": "Unknown operation." }));
    assert_eq!(cancel(&Args::new(vec![json!("mass_extract")])), json!({ "success": true }));
    assert!(check_cancel("mass_extract").unwrap_err().is::<Cancelled>());
    reset_cancel("mass_extract");
    assert!(check_cancel("mass_extract").is_ok());
}

/// Runs scripted calls for tools/parity/file_manager.py and writes what happened.
/// Needs BTT_PARITY_SCRIPT, BTT_PARITY_OUT and BTT_PARITY_APPDATA (a throwaway folder).
#[test]
#[ignore]
fn parity_harness() {
    let (Ok(script), Ok(out), Ok(appdata)) = (std::env::var("BTT_PARITY_SCRIPT"), std::env::var("BTT_PARITY_OUT"), std::env::var("BTT_PARITY_APPDATA")) else {
        return;
    };
    std::env::set_var("APPDATA", &appdata);
    let host = crate::ctx::testing::init();
    let steps: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(script).unwrap()).unwrap();
    let mut results = Vec::new();
    for step in steps {
        let seen = host.calls.lock().len();
        let started = std::time::Instant::now();
        let result = match step["op"].as_str().unwrap() {
            "call" => {
                let args = step["args"].as_array().cloned().unwrap_or_default();
                match crate::call(step["name"].as_str().unwrap(), args) {
                    Some(Ok(v)) => v,
                    Some(Err(e)) => json!({ "raised": e }),
                    None => json!({ "missing": true }),
                }
            }
            "pick" => {
                *PICK.lock() = step["path"].as_str().map(PathBuf::from);
                Value::Null
            }
            other => panic!("unknown op {other}"),
        };
        let seconds = started.elapsed().as_secs_f64();
        let js: Vec<Value> = host.calls.lock()[seen..].iter().map(|(name, args)| json!([name, args])).collect();
        results.push(json!({ "result": result, "js": js, "seconds": seconds }));
    }
    std::fs::write(out, serde_json::to_string(&results).unwrap()).unwrap();
}
