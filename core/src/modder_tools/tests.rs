//! Replays tools/parity/modder_tools.py's recorded calls and diffs the responses and the
//! files they leave behind.

use std::path::{Path, PathBuf};

use md5::{Digest, Md5};
use serde_json::{json, Map, Value};

use super::{tools, FIXED_NOW};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/modder_tools")
}

fn copy_tree(from: &Path, to: &Path) {
    for e in walkdir::WalkDir::new(from).into_iter().filter_map(|e| e.ok()) {
        let target = to.join(e.path().strip_prefix(from).unwrap());
        if e.file_type().is_dir() {
            std::fs::create_dir_all(&target).unwrap();
        } else {
            std::fs::copy(e.path(), &target).unwrap();
        }
    }
}

fn substitute(v: &Value, root: &str, token: &str, placed: &Value) -> Value {
    match v {
        Value::String(s) if s == "$placed_files" => placed.clone(),
        Value::String(s) => json!(s.replace("{ROOT}", root).replace("{TOKEN}", token)),
        Value::Array(a) => Value::Array(a.iter().map(|x| substitute(x, root, token, placed)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), substitute(x, root, token, placed))).collect()),
        other => other.clone(),
    }
}

fn normalize(v: &Value, root: &str, token: &str) -> Value {
    match v {
        Value::String(s) => {
            let mut s = s.replace(root, "{ROOT}").replace(&root.replace('\\', "/"), "{ROOT}");
            if !token.is_empty() {
                s = s.replace(token, "{TOKEN}");
            }
            json!(s)
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| normalize(x, root, token)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), normalize(x, root, token))).collect()),
        other => other.clone(),
    }
}

fn snapshot(root: &Path, token: &str) -> Value {
    let uuid_dir = regex::Regex::new("ModderToolsTrash/[0-9a-f]{32}").unwrap();
    let mut entries: Vec<(String, String)> = Vec::new();
    for e in walkdir::WalkDir::new(root).min_depth(1).into_iter().filter_map(|e| e.ok()) {
        let mut rel = e.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if !token.is_empty() {
            rel = rel.replace(token, "{TOKEN}");
        }
        rel = uuid_dir.replace(&rel, "ModderToolsTrash/{UUID}").into_owned();
        // Only the modder tools' own part of the data folder (other tests may write there).
        if rel.starts_with("appdata/Trove/") && !rel.starts_with("appdata/Trove/ModderToolsTrash") {
            continue;
        }
        let v = if e.file_type().is_file() { hex::encode(Md5::digest(std::fs::read(e.path()).unwrap())) } else { "dir".into() };
        entries.push((rel, v));
    }
    entries.sort();
    Value::Object(entries.into_iter().map(|(k, v)| (k, json!(v))).collect::<Map<_, _>>())
}

fn dialog_response(name: &str, args: &[Value], picked: &Value) -> Value {
    let one = picked.as_str().filter(|s| !s.is_empty()).map(PathBuf::from);
    let result = match name {
        "ask_add_files" => Ok(tools::classify_added_files(&args[0], &picked.as_array().unwrap().iter().map(|p| PathBuf::from(p.as_str().unwrap())).collect::<Vec<_>>())),
        "ask_preview_file" => tools::preview_file_result(one),
        "ask_import_file" => tools::import_file_result(one),
        "ask_config_file" => tools::config_file_result(one),
        _ => unreachable!("{name}"),
    };
    match result {
        Ok(v) => crate::response::normalize(v),
        Err(e) => crate::Resp::fail(e.to_string(), "UNHANDLED_EXCEPTION").into(),
    }
}

/// `BTT_PARITY_MODDER_REAL=<mods>;<out of "modder_tools.py real">;<scratch dir>`.
#[test]
#[ignore]
fn real_mods_extract_like_python() {
    let paths: Vec<PathBuf> = std::env::var("BTT_PARITY_MODDER_REAL").expect("set BTT_PARITY_MODDER_REAL").split(';').map(PathBuf::from).collect();
    let (mods, out, scratch) = (&paths[0], &paths[1], &paths[2]);
    let _ = std::fs::remove_dir_all(scratch);
    let report: Value = serde_json::from_str(&std::fs::read_to_string(out.join("report.json")).unwrap()).unwrap();
    let root = crate::py::path_str(&mods.to_string_lossy());
    let digest = |v: &Value| {
        let opts = crate::json::DumpOpts { sort_keys: true, ..Default::default() };
        hex::encode(Md5::digest(crate::json::dumps_with(&normalize(v, &root, ""), opts).as_bytes()))
    };
    for (name, want) in report.as_object().unwrap() {
        let src = json!(mods.join(name).to_string_lossy());
        let dest = scratch.join(name);
        let extract = crate::call("extract_tmod", vec![src.clone(), json!(dest.to_string_lossy())]).unwrap().unwrap();
        assert_eq!(extract, want["extract"], "{name} extract");
        assert_eq!(snapshot(&dest, ""), want["tree"], "{name} files");
        assert_eq!(digest(&crate::call("load_tmod_for_edit", vec![src.clone()]).unwrap().unwrap()), want["edit"], "{name} edit");
        assert_eq!(digest(&crate::call("steam_workshop_read_tmod", vec![src]).unwrap().unwrap()), want["steam"], "{name} steam");
    }
    let _ = std::fs::remove_dir_all(scratch);
}

#[test]
#[cfg_attr(not(windows), ignore = "fixtures recorded on Windows paths")]
fn endpoints_match_python() {
    crate::ctx::testing::init();
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(fixtures().join("cases.json")).unwrap()).unwrap();
    let sandbox = std::env::temp_dir().join(format!("btt-modder-rs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&sandbox);
    copy_tree(&fixtures().join("seed"), &sandbox);
    let _env = crate::ctx::testing::ENV_LOCK.lock();
    std::env::set_var("APPDATA", sandbox.join("appdata"));
    let fixed = chrono::DateTime::parse_from_rfc3339(cases["fixed_now"].as_str().unwrap()).unwrap();
    FIXED_NOW.store(fixed.timestamp_micros(), std::sync::atomic::Ordering::SeqCst);
    // The runner's temp dir can be an 8.3 short path; responses carry the long form.
    let root = crate::game::registry::dunce_canonical(&sandbox).unwrap_or(sandbox.clone()).to_string_lossy().into_owned();

    let (mut token, mut placed) = (String::new(), json!([]));
    for (i, case) in cases["calls"].as_array().unwrap().iter().enumerate() {
        // Other modules' tests point APPDATA at their own sandboxes too.
        std::env::set_var("APPDATA", sandbox.join("appdata"));
        let name = case["name"].as_str().unwrap();
        let args: Vec<Value> = case["args"].as_array().unwrap().iter().map(|a| substitute(a, &root, &token, &placed)).collect();
        let response = match case.get("picked") {
            Some(picked) => dialog_response(name, &args, &substitute(picked, &root, &token, &placed)),
            None => crate::call(name, args).expect("registered").unwrap(),
        };
        if name == "remove_project_overrides" {
            if let Some(t) = response["undo_token"].as_str() {
                token = t.to_string();
            }
        }
        if name == "place_project_overrides" {
            placed = response["placed_files"].clone();
        }
        assert_eq!(normalize(&response, &root, &token), case["response"], "call #{i} {name}");
    }
    assert_eq!(snapshot(&sandbox, &token), cases["tree"], "files left behind");
    FIXED_NOW.store(i64::MIN, std::sync::atomic::Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&sandbox);
}
