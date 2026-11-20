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

    let (token, placed) = (String::new(), json!([]));
    for (i, case) in cases["calls"].as_array().unwrap().iter().enumerate() {
        // Other modules' tests point APPDATA at their own sandboxes too.
        std::env::set_var("APPDATA", sandbox.join("appdata"));
        let name = case["name"].as_str().unwrap();
        let args: Vec<Value> = case["args"].as_array().unwrap().iter().map(|a| substitute(a, &root, &token, &placed)).collect();
        let response = match case.get("picked") {
            Some(picked) => dialog_response(name, &args, &substitute(picked, &root, &token, &placed)),
            None => crate::call(name, args).expect("registered").unwrap(),
        };
        assert_eq!(normalize(&response, &root, &token), case["response"], "call #{i} {name}");
    }
    assert_eq!(snapshot(&sandbox, &token), cases["tree"], "files left behind");
    FIXED_NOW.store(i64::MIN, std::sync::atomic::Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&sandbox);
}

#[test]
fn blocked_words_stop_a_build_anywhere_they_appear() {
    crate::ctx::testing::init();
    let sandbox = std::env::temp_dir().join(format!("btt-blocklist-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(sandbox.join("game")).unwrap();
    std::fs::write(sandbox.join("game").join("Trove.exe"), b"").unwrap();
    let base = json!({
        "gamePath": sandbox.join("game").to_string_lossy(),
        "title": "Clean Mod", "author": "me", "version": "1.0", "notes": "notes",
        "tags": ["UI"], "subtype": "",
        "files": [{"internal_path": "ui/a.swf", "data": "data:application/octet-stream;base64,aW5saW5l"}],
    });
    let build = |patch: &dyn Fn(&mut Value)| {
        let mut payload = base.clone();
        patch(&mut payload);
        crate::call("build_tmod", vec![payload]).unwrap().unwrap()
    };

    let cases: [(&str, &dyn Fn(&mut Value)); 5] = [
        ("title", &|p| p["title"] = json!("My QuWaste Mod")),
        ("author", &|p| p["author"] = json!("QUWASTE")),
        ("notes", &|p| p["notes"] = json!("has quwaste in it")),
        ("tag", &|p| p["tags"] = json!(["UI", "Quwaste"])),
        ("file path", &|p| p["files"][0]["internal_path"] = json!("ui/quwaste.swf")),
    ];
    for (field, patch) in cases {
        let r = build(patch);
        assert_eq!(r["success"], false, "{field}: {r}");
        assert_eq!(r["error"], crate::modfile::blocklist::BLOCKED_MESSAGE, "{field}");
    }
    assert!(!sandbox.join("game").join("mods").join("My QuWaste Mod.tmod").exists());

    let ok = build(&|_| {});
    assert_eq!(ok["success"], true, "{ok}");
    let _ = std::fs::remove_dir_all(&sandbox);
}

#[test]
fn test_builds_conflicts_and_removal() {
    crate::ctx::testing::init();
    let sandbox = std::env::temp_dir().join(format!("btt-conflicts-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&sandbox);
    let game = sandbox.join("game");
    std::fs::create_dir_all(&game).unwrap();
    std::fs::write(game.join("Trove.exe"), b"").unwrap();
    let g = json!(game.to_string_lossy());
    let build = |title: &str, path: &str| {
        let payload = json!({
            "gamePath": g, "title": title, "author": "me", "version": "1.0", "notes": "n", "tags": ["UI"], "subtype": "",
            "files": [{"internal_path": path, "data": "data:application/octet-stream;base64,aW5saW5l"}],
        });
        let r = crate::call("build_tmod", vec![payload]).unwrap().unwrap();
        assert_eq!(r["success"], true, "{r}");
        r["path"].as_str().unwrap().to_string()
    };
    let other = build("Other HUD", "ui/hud.swf");
    let mine = build("My HUD", "ui/hud.swf");
    build("Unrelated", "ui/map.swf");

    let r = crate::call("find_mod_conflicts", vec![g.clone(), json!([r"UI\hud.swf", "ui/x.swf"]), json!("My HUD")]).unwrap().unwrap();
    let conflicts = r["data"]["conflicts"].as_array().or(r["conflicts"].as_array()).unwrap().clone();
    assert_eq!(conflicts.len(), 1, "{r}");
    assert_eq!(conflicts[0]["name"], "Other HUD");
    assert_eq!(conflicts[0]["paths"], json!([r"UI\hud.swf"]));

    let refused = crate::call("remove_built_tmod", vec![json!(other), json!(sandbox.to_string_lossy())]).unwrap().unwrap();
    assert_eq!(refused["success"], false, "{refused}");
    let removed = crate::call("remove_built_tmod", vec![json!(mine.clone()), g]).unwrap().unwrap();
    assert_eq!(removed["success"], true, "{removed}");
    assert!(!PathBuf::from(mine).exists());
    let _ = std::fs::remove_dir_all(&sandbox);
}

#[test]
fn edit_files_extract_from_data_and_disk() {
    crate::ctx::testing::init();
    let sandbox = std::env::temp_dir().join(format!("btt-edit-extract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).unwrap();
    let src = sandbox.join("disk.png");
    std::fs::write(&src, b"disk").unwrap();
    let dest = sandbox.join("out");
    let files = json!([
        {"internal_path": "ui/a.swf", "data": "data:application/octet-stream;base64,aW5saW5l"},
        {"internal_path": "textures/b.png", "path": src.to_string_lossy()},
        {"internal_path": "../escape.txt", "data": "data:application/octet-stream;base64,aW5saW5l"},
    ]);
    let r = crate::call("extract_edit_files", vec![json!(dest.to_string_lossy()), files]).unwrap().unwrap();
    assert_eq!(r["count"], 2, "{r}");
    assert_eq!(std::fs::read(dest.join("ui").join("a.swf")).unwrap(), b"inline");
    assert_eq!(std::fs::read(dest.join("textures").join("b.png")).unwrap(), b"disk");
    assert!(!sandbox.join("escape.txt").exists());
    let _ = std::fs::remove_dir_all(&sandbox);
}
