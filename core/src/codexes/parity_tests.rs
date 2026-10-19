//! Parity with the Python codexes: golden outputs on the mini install under
//! core/tests/fixtures/codexes (tools/parity/codexes.py fixtures), plus `#[ignore]`d
//! runs against a real install.
//!
//! Full install, one codex per process for cold timings:
//!     BTT_PARITY_OUT=<dir> BTT_PARITY_PY=<python build dir> BTT_PARITY_KEYS=allies \
//!         cargo test ... -- --ignored full_install_parity

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Map, Value};

use super::binfab::parse_binfab_content;
use super::binfab_decoder::analyze_binfab;
use super::binfab_reader::{decode_identity, harvest_strings, parse_collection_table, parse_flat, parse_message};
use super::cache::{dump_data, dump_manifest};
use super::prefab_ally::{decode_known_power_rank, extract_localization_map, parse_item_pet_signature, read_file};
use super::prefab_recipe::{decode_quantified_recipe_paths, recipe_mastery_from_prefab};
use super::{build_dataset, codexes};
use crate::game::archive;

const KEYS: [&str; 8] = ["allies", "badges", "fish", "items", "mementos", "mounts", "recipes", "styles"];
const EXTRACT_DIR: &str = r"C:\parity\allies_runtime_cache";
const DEFAULT_GAME: &str = r"C:\Program Files (x86)\Glyph\Games\Trove\Live";

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("codexes")
}

fn lf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// Up to `limit` paths where two JSON trees differ.
fn diff(a: &Value, b: &Value, path: &str, out: &mut Vec<String>, limit: usize) {
    if out.len() >= limit {
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            if x.keys().ne(y.keys()) {
                out.push(format!("{}: keys {:?} != {:?}", path, x.keys().take(8).collect::<Vec<_>>(), y.keys().take(8).collect::<Vec<_>>()));
            }
            for (k, v) in x {
                if let Some(w) = y.get(k) {
                    diff(v, w, &format!("{}.{}", path, k), out, limit);
                }
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                out.push(format!("{}: len {} != {}", path, x.len(), y.len()));
            }
            for (i, (v, w)) in x.iter().zip(y).enumerate() {
                diff(v, w, &format!("{}[{}]", path, i), out, limit);
            }
        }
        _ if a != b => out.push(format!("{}: {} != {}", path, crate::json::dumps(a), crate::json::dumps(b))),
        _ => {}
    }
}

/// Compares serialized output with the golden text; reports where they differ.
fn check(label: &str, got: &str, want: &str, failures: &mut Vec<String>) {
    if got == want {
        return;
    }
    let mut out = Vec::new();
    match (serde_json::from_str::<Value>(got), serde_json::from_str::<Value>(want)) {
        (Ok(g), Ok(w)) => diff(&g, &w, "$", &mut out, 12),
        _ => out.push("unparseable".into()),
    }
    if out.is_empty() {
        let at = got.bytes().zip(want.bytes()).position(|(a, b)| a != b).unwrap_or(got.len().min(want.len()));
        let around = |s: &str| s.get(at.saturating_sub(60)..(at + 60).min(s.len())).unwrap_or("").to_string();
        out.push(format!("same values, different text at {}: {:?} vs {:?}", at, around(got), around(want)));
    }
    failures.push(format!("{}:\n    {}", label, out.join("\n    ")));
}

#[test]
fn golden_codexes_on_mini_install() {
    let game = fixtures().join("game");
    let golden = fixtures().join("golden");
    let mut failures = Vec::new();
    for key in KEYS {
        let (data, mut manifest) = build_dataset(key, &game, Some(Path::new(EXTRACT_DIR))).unwrap();
        manifest.insert("game_path".into(), json!("<GAME>"));
        let want_data = std::fs::read_to_string(golden.join(format!("{}.data.json", key))).unwrap();
        let want_manifest = std::fs::read_to_string(golden.join(format!("{}.manifest.json", key))).unwrap();
        check(&format!("{} data", key), &dump_data(&Value::Object(data)), &want_data, &mut failures);
        check(&format!("{} manifest", key), &lf(&dump_manifest(&Value::Object(manifest))), &lf(&want_manifest), &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn decoders_of(content: &[u8], path: &str) -> Value {
    let (fields, end) = parse_flat(content, None).unwrap();
    json!({
        "parse_binfab": parse_binfab_content(content, path, false).to_value(),
        "parse_binfab_collection": parse_binfab_content(content, path, true).to_value(),
        "harvest": harvest_strings(content, 2, 512).into_iter().map(|(o, f, s)| json!([o, f, s])).collect::<Vec<_>>(),
        "flat": {"fields": fields.iter().map(|f| f.to_value()).collect::<Vec<_>>(), "end": end},
        "message": parse_message(content, None, None).unwrap().iter().map(|f| f.to_value()).collect::<Vec<_>>(),
        "identity": decode_identity(content).unwrap().map(|i| i.to_value()),
        "collection": parse_collection_table(content).iter().map(|g| g.to_value()).collect::<Vec<_>>(),
        "tokens": analyze_binfab(content, path),
        "power_rank": decode_known_power_rank(content),
        "signature": parse_item_pet_signature(content),
        "quantified": decode_quantified_recipe_paths(content).iter().map(|q| q.to_value()).collect::<Vec<_>>(),
        "recipe_mastery": recipe_mastery_from_prefab(content).map(|m| m as u64),
    })
}

#[test]
fn golden_decoders_on_fixture_prefabs() {
    let game = fixtures().join("game");
    // Compared as text: serde_json's default float parsing is not exact.
    let raw = std::fs::read_to_string(fixtures().join("golden").join("decoders.json")).unwrap();
    let golden: Map<String, Value> = serde_json::from_str(&raw).unwrap();
    let prefabs = archive::load_index(&game.join("prefabs")).unwrap();
    let language = archive::load_index(&game.join("languages").join("en")).unwrap();
    let mut got = Map::new();
    for path in golden.keys() {
        let value = if let Some(rest) = path.strip_prefix("languages/") {
            let content = read_file(language.find(rest).unwrap()).unwrap();
            let map: Map<String, Value> = extract_localization_map(&content).into_iter().map(|(k, v)| (k, json!(v))).collect();
            json!({ "localization": map })
        } else {
            decoders_of(&read_file(prefabs.find(path).unwrap()).unwrap(), path)
        };
        got.insert(path.clone(), value);
    }
    assert!(golden.len() >= 8, "decoder goldens missing");
    let mut failures = Vec::new();
    check("decoders", &dump_data(&Value::Object(got)), &raw, &mut failures);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

#[test]
#[ignore = "needs a real Trove install"]
fn full_install_parity() {
    let game = env_path("BTT_PARITY_GAME").unwrap_or_else(|| DEFAULT_GAME.into());
    let out = env_path("BTT_PARITY_OUT").expect("set BTT_PARITY_OUT");
    let python = env_path("BTT_PARITY_PY");
    let keys: Vec<String> = std::env::var("BTT_PARITY_KEYS").map(|k| k.split(',').map(str::to_string).collect()).unwrap_or_else(|_| KEYS.map(String::from).to_vec());
    std::fs::create_dir_all(&out).unwrap();
    let mut failures = Vec::new();
    for key in &keys {
        let start = Instant::now();
        let (data, manifest) = build_dataset(key, &game, Some(Path::new(EXTRACT_DIR))).unwrap_or_else(|e| panic!("{}: {:#}", key, e));
        let elapsed = start.elapsed().as_secs_f64();
        let rows = data.len();
        let (data, manifest) = (dump_data(&Value::Object(data)), dump_manifest(&Value::Object(manifest)));
        std::fs::write(out.join(format!("{}.data.json", key)), &data).unwrap();
        std::fs::write(out.join(format!("{}.manifest.json", key)), &manifest).unwrap();
        std::fs::write(out.join(format!("{}.time", key)), format!("{:.3}", elapsed)).unwrap();
        println!("{}: {} rows in {:.2}s", key, rows, elapsed);
        if let Some(py) = &python {
            let want = |ext: &str| std::fs::read_to_string(py.join(format!("{}.{}", key, ext))).unwrap();
            check(&format!("{} data", key), &data, &want("data.json"), &mut failures);
            check(&format!("{} manifest", key), &manifest, &want("manifest.json"), &mut failures);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn mask(value: &Value, appdata: &[String]) -> Value {
    match value {
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| {
                    let timed = matches!(k.as_str(), "generated_at" | "expires_at") && v.as_f64().is_some_and(|t| t != 0.0);
                    (k.clone(), if timed { json!("<time>") } else { mask(v, appdata) })
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(|v| mask(v, appdata)).collect()),
        Value::String(s) => Value::String(appdata.iter().fold(s.clone(), |s, form| s.replace(form.as_str(), "<APPDATA>"))),
        other => other.clone(),
    }
}

/// The live -> cache -> stale -> clear sequence of tools/parity/codexes.py `endpoints`.
/// Run with APPDATA pointing at an empty temp dir.
#[test]
#[ignore = "needs a real Trove install and a scratch APPDATA"]
fn endpoint_flow_parity() {
    let out = env_path("BTT_PARITY_OUT").expect("set BTT_PARITY_OUT");
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let mut forms = vec![appdata.clone(), super::py::normalize_path(&appdata)];
    forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
    let mut results = Map::new();
    let mut timings = Map::new();
    for c in codexes() {
        let mut steps = Vec::new();
        steps.push(json!(["clear_empty", c.clear_cache().unwrap()]));
        let start = Instant::now();
        steps.push(json!(["live", c.get_data(&crate::Args::new(vec![json!(false), json!("")])).unwrap()]));
        timings.insert(c.key.into(), json!((start.elapsed().as_secs_f64() * 1000.0).round() / 1000.0));
        steps.push(json!(["cached", c.get_data(&crate::Args::new(vec![json!(false), json!("")])).unwrap()]));
        let manifest_file = c.manifest_file().unwrap();
        let mut manifest: Value = serde_json::from_str(&std::fs::read_to_string(&manifest_file).unwrap()).unwrap();
        manifest["generated_at"] = json!(manifest["generated_at"].as_i64().unwrap() - 13 * 3600);
        std::fs::write(&manifest_file, dump_manifest(&manifest)).unwrap();
        steps.push(json!(["stale", c.get_data(&crate::Args::new(vec![json!(false), json!("")])).unwrap()]));
        c.wait_idle();
        steps.push(json!(["bad_path", c.get_data(&crate::Args::new(vec![json!(true), json!(r"C:\definitely\not\trove")])).unwrap()]));
        steps.push(json!(["cleared", c.clear_cache().unwrap()]));
        results.insert(c.key.into(), Value::Array(steps));
    }
    let results = mask(&Value::Object(results), &forms);
    std::fs::write(out.join("rs_endpoints.json"), crate::json::dumps_indent(&json!({"timings": timings, "results": results}), 2)).unwrap();
    println!("{}", crate::json::dumps_indent(&Value::Object(timings), 2));
    if let Some(py) = env_path("BTT_PARITY_PY_ENDPOINTS") {
        let want: Value = serde_json::from_str(&std::fs::read_to_string(py).unwrap()).unwrap();
        let mut failures = Vec::new();
        check("endpoints", &dump_data(&results), &dump_data(&want["results"]), &mut failures);
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
