use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use super::*;
use crate::modfile::compat;

/// Test-only answer for the file dialog.
pub(super) static PICK: Mutex<Option<PathBuf>> = Mutex::new(None);

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name)
}

fn raised(e: anyhow::Error) -> Value {
    json!({ "raised": e.to_string() })
}

fn strs(v: &Value) -> String {
    compat::py_str(v)
}

/// Runs one pure helper the way `tools/parity/mod_manager.py fixtures` ran Python's.
fn run_helper(f: &str, args: &[Value]) -> Value {
    let releases = |v: &Value| v.as_array().cloned().unwrap_or_default();
    match f {
        "html_to_text" => json!(manager::html_to_text(args[0].as_str().unwrap())),
        "lock_key" => json!(manager::lock_key(args[0].as_str().unwrap())),
        "mod_ref" => json!(hub::mod_ref(&args[0], &args[1])),
        "latest_release" => hub::latest_release(&releases(&args[0]), &args[1]).cloned().unwrap_or(Value::Null),
        "branch_variants" => json!(hub::branch_variants(&releases(&args[0]))),
        "release_outdated" => json!(hub::release_outdated(&args[0], &releases(&args[1]))),
        "changes_since" => hub::changes_since(&args[0], &releases(&args[1])),
        "release_extension" => json!(hub::release_extension(&args[0])),
        "safe_filename" => json!(hub::safe_filename(args[0].as_str().unwrap())),
        "name_from_filename" => json!(modpacks::name_from_filename(args[0].as_str().unwrap())),
        "safe_pack_filename" => json!(modpacks::safe_pack_filename(args[0].as_str().unwrap())),
        "install_name" => {
            let data = compat::b64decode(args[0].as_str().unwrap()).unwrap();
            let ext = match args[1].as_str().unwrap() {
                ".tmod" => ".tmod",
                _ => ".zip",
            };
            json!(hub::install_name(&data, ext, &args[2], &args[3]))
        }
        "latest_mod_file" => match trovesaurus::latest_mod_file(&args[0]) {
            Ok(v) => v.unwrap_or(Value::Null),
            Err(e) => raised(e),
        },
        "install_target" => {
            let existing = args[3].as_str();
            json!(compat::display(&trovesaurus::install_target(&compat::py_path(args[0].as_str().unwrap()), &strs(&args[1]), args[2].as_str().unwrap(), existing)))
        }
        "blocked" => json!(blocklist::Blocklist::from_data(&args[0]).blocked(&args[1])),
        other => panic!("no helper {other}"),
    }
}

#[cfg(windows)]
#[test]
fn helpers_match_python() {
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(fixture("mod_manager").join("helpers.json")).unwrap()).unwrap();
    assert!(cases.len() > 100);
    let mut failures = Vec::new();
    for c in &cases {
        let (f, args, want) = (c["fn"].as_str().unwrap(), c["args"].as_array().unwrap(), &c["result"]);
        if want.get("raised").is_some() {
            let got = run_helper(f, args);
            if got.get("raised").is_none() {
                failures.push(format!("{f}({args:?}): python raised {want}, rust gave {got}"));
            }
            continue;
        }
        let got = run_helper(f, args);
        if &got != want {
            failures.push(format!("{f}({}):\n  python {want}\n  rust   {got}", serde_json::to_string(args).unwrap().chars().take(300).collect::<String>()));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

#[test]
fn tpack_round_trips_with_names_kept() {
    let simple = std::fs::read(fixture("modfile").join("simple.tmod")).unwrap();
    let unicode = std::fs::read(fixture("modfile").join("unicode.tmod")).unwrap();
    let entries = vec![("Simple Mod.tmod".to_string(), simple), ("Caf\u{e9}.tmod".to_string(), unicode)];
    let props = vec![("title".to_string(), "Pack".to_string()), ("author".to_string(), "me".to_string())];
    let built = modpacks::rebuild(2, &props, &entries).unwrap();
    let (version, read_props, read) = modpacks::decompile_meta(&built).unwrap();
    assert_eq!((version, read_props, read), (2, props, entries));
    // Same bytes as the Python build (fixture written by tools/parity/modfile.py).
    let want: Value = serde_json::from_str(&std::fs::read_to_string(fixture("modfile").join("built.json")).unwrap()).unwrap();
    assert_eq!(hex::encode(<md5::Md5 as md5::Digest>::digest(&built)), want["tpack"]["md5"].as_str().unwrap());
}

#[test]
fn unique_path_numbers_before_the_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("Mod.tmod");
    assert_eq!(modpacks::unique_path(&target), target);
    std::fs::write(&target, b"").unwrap();
    std::fs::write(dir.path().join("Mod_1.tmod"), b"").unwrap();
    assert_eq!(modpacks::unique_path(&target), dir.path().join("Mod_2.tmod"));
}

// --- the live parity harness --------------------------------------------------------------

/// `{{step:dotted.path}}` and `<VAR>` substitution, as tools/parity/mod_manager.py does it.
fn resolve(value: &Value, env: &Map<String, Value>, results: &Map<String, Value>) -> Value {
    match value {
        Value::String(s) => {
            let mut s = s.clone();
            for (k, v) in env {
                s = s.replace(&format!("<{}>", k), v.as_str().unwrap());
            }
            let re = regex::Regex::new(r"\{\{(\w+):([^}]+)\}\}").unwrap();
            let lookup = |sid: &str, path: &str| -> Value {
                let mut cur = results.get(sid).cloned().unwrap_or(Value::Null);
                for part in path.split('.') {
                    cur = match &cur {
                        Value::Object(m) if part == "$key0" => m.keys().next().map(|k| json!(k)).unwrap_or(Value::Null),
                        Value::Object(m) => m.get(part).cloned().unwrap_or(Value::Null),
                        _ => return Value::Null,
                    };
                }
                cur
            };
            if let Some(c) = re.captures(&s).filter(|c| c[0].len() == s.len()) {
                return lookup(&c[1], &c[2]);
            }
            json!(re.replace_all(&s, |c: &regex::Captures| compat::py_str(&lookup(&c[1], &c[2]))).into_owned())
        }
        Value::Array(items) => Value::Array(items.iter().map(|v| resolve(v, env, results)).collect()),
        other => other.clone(),
    }
}

fn file_op(op: &str, step: &Value, path: &Path) -> Value {
    let text = |p: &Path| String::from_utf8_lossy(&std::fs::read(p).unwrap()).into_owned();
    match op {
        "read" if path.exists() => json!(text(path)),
        "readdir" if path.exists() => {
            let mut names: Vec<PathBuf> = std::fs::read_dir(path).unwrap().map(|e| e.unwrap().path()).collect();
            names.sort_by_key(|p| compat::file_name(p));
            Value::Object(names.iter().map(|p| (compat::file_name(p), json!(text(p)))).collect())
        }
        "listdir" if path.exists() => {
            let mut names: Vec<String> = std::fs::read_dir(path).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            json!(names)
        }
        "write" => {
            std::fs::write(path, step["text"].as_str().unwrap()).unwrap();
            Value::Null
        }
        _ => json!({ "missing": true }),
    }
}

#[test]
#[ignore]
fn parity_harness() {
    let (Ok(script), Ok(out)) = (std::env::var("BTT_PARITY_SCRIPT"), std::env::var("BTT_PARITY_OUT")) else { return };
    let host = crate::ctx::testing::init();
    INLINE_TASKS.store(true, Ordering::SeqCst);
    let script: Value = serde_json::from_str(&std::fs::read_to_string(script).unwrap()).unwrap();
    let env = script["env"].as_object().unwrap().clone();
    let mut results = Map::new();
    let mut out_steps = Vec::new();
    for step in script["steps"].as_array().unwrap() {
        let seen = host.calls.lock().len();
        let started = std::time::Instant::now();
        let op = step["op"].as_str().unwrap();
        let game = || resolve(&step["game"], &env, &results).as_str().unwrap().to_string();
        let result = match op {
            "call" => {
                let args = resolve(&step["args"], &env, &results).as_array().cloned().unwrap_or_default();
                match crate::call(step["name"].as_str().unwrap(), args) {
                    Some(Ok(v)) => v,
                    Some(Err(e)) => json!({ "raised": e }),
                    None => json!({ "missing": true }),
                }
            }
            "pick" => {
                *PICK.lock() = resolve(&step["path"], &env, &results).as_str().map(PathBuf::from);
                Value::Null
            }
            "tick" => json!(watcher::tick_now()),
            "probe" => json!(watcher::probe_configs(&game())),
            "auto_update" => match manager::auto_update_unlocked_mods(&game()) {
                Ok((u, f)) => json!([u, f]),
                Err(e) => raised(e),
            },
            "takedown" => {
                hub::remove_taken_down_mods(&game());
                Value::Null
            }
            other => {
                let path = PathBuf::from(resolve(&step["path"], &env, &results).as_str().unwrap());
                file_op(other, step, &path)
            }
        };
        let seconds = started.elapsed().as_secs_f64();
        let js: Vec<Value> = host.calls.lock()[seen..].iter().map(|(name, args)| json!([name, args])).collect();
        results.insert(step["id"].as_str().unwrap().to_string(), result.clone());
        out_steps.push(json!({ "result": result, "js": js, "seconds": seconds }));
    }
    std::fs::write(out, serde_json::to_string(&out_steps).unwrap()).unwrap();
}
