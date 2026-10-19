//! Parity with the Python implementation: every case in tools/parity/blueprint.py's output
//! is replayed through the routes and the answer compared byte for byte.
//!
//! `fixture_parity` runs the golden cases in core/tests/fixtures/blueprint. The real-install
//! run is `install_parity` (ignored): generate its cases with
//! `python tools/parity/blueprint.py install <dir>`, then run it with
//! `BTT_BLUEPRINT_PARITY=<dir> cargo test ... install_parity -- --ignored --nocapture`.

use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::Instant;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::*;

fn setup() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // Wiped each run, so the install tests always rebuild the rig index themselves.
        let tmp = std::env::temp_dir().join("btt-blueprint-parity");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Never the real app data: the rig index cache lands in here.
        std::env::set_var("APPDATA", &tmp);
        std::env::set_var("XDG_DATA_HOME", &tmp);
        std::env::set_var("SOURCE_DATE_EPOCH", "1700000000");
        crate::ctx::testing::init();
    });
}

fn fixtures() -> PathBuf {
    match std::env::var_os("BTT_BLUEPRINT_FIXTURES") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("blueprint"),
    }
}

fn blob(dir: &Path, spec: &Value) -> Vec<u8> {
    if let Some(head) = spec.get("head").and_then(Value::as_str) {
        let mut out = std::fs::read(dir.join(head)).unwrap();
        out.resize(out.len() + spec["count"].as_u64().unwrap() as usize, spec["fill"].as_u64().unwrap() as u8);
        out.extend(std::fs::read(dir.join(spec["tail"].as_str().unwrap())).unwrap());
        return out;
    }
    std::fs::read(dir.join(spec["file"].as_str().unwrap())).unwrap()
}

/// Zip timestamps are local time, so a fixture made in another time zone differs there.
fn without_zip_times(mut data: Vec<u8>) -> Vec<u8> {
    let Some(end) = data.windows(4).rposition(|w| w == b"PK\x05\x06") else { return data };
    let u16_at = |d: &[u8], at: usize| u16::from_le_bytes([d[at], d[at + 1]]) as usize;
    let u32_at = |d: &[u8], at: usize| u32::from_le_bytes(d[at..at + 4].try_into().unwrap()) as usize;
    let (count, mut at) = (u16_at(&data, end + 10), u32_at(&data, end + 16));
    for _ in 0..count {
        let local = u32_at(&data, at + 42);
        data[at + 12..at + 16].fill(0);
        data[local + 10..local + 14].fill(0);
        at += 46 + u16_at(&data, at + 28) + u16_at(&data, at + 30) + u16_at(&data, at + 32);
    }
    data
}

fn first_diff(a: &[u8], b: &[u8]) -> String {
    let at = a.iter().zip(b).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
    let show = |d: &[u8]| String::from_utf8_lossy(&d[at.saturating_sub(40)..(at + 60).min(d.len())]).into_owned();
    format!("lengths rust {} / python {}, first difference at {at}\n    rust:   {:?}\n    python: {:?}", a.len(), b.len(), show(a), show(b))
}

fn compare_body(got: &[u8], dir: &Path, spec: &Value, exact_zip_times: bool) -> Option<String> {
    if let Some(sha) = spec.get("sha256").and_then(Value::as_str) {
        let digest = hex::encode(Sha256::digest(got));
        return (digest != sha).then(|| format!("body sha256 differs (rust {} bytes, python {})", got.len(), spec["len"]));
    }
    let want = blob(dir, spec);
    let normalize = |d: Vec<u8>| if !exact_zip_times && d.starts_with(b"PK\x03\x04") { without_zip_times(d) } else { d };
    let (got, want) = (normalize(got.to_vec()), normalize(want));
    (got != want).then(|| first_diff(&got, &want))
}

struct Timing {
    name: String,
    python_ms: f64,
    rust_ms: f64,
}

fn run_open_project(dir: &Path, case: &Value) -> String {
    let files: Vec<(String, Vec<u8>)> =
        case["files"].as_array().unwrap().iter().map(|f| (f[0].as_str().unwrap().to_string(), std::fs::read(dir.join(f[1].as_str().unwrap())).unwrap())).collect();
    let pairs = |k: &str| -> Vec<(String, Value)> { case[k].as_array().unwrap().iter().map(|p| (p[0].as_str().unwrap().to_string(), p[1].clone())).collect() };
    let attach: Vec<(String, String)> = pairs("attach").into_iter().map(|(k, v)| (k, v.as_str().unwrap().to_string())).collect();
    let scales: util::FxMap<String, f64> = pairs("part_scales").into_iter().map(|(k, v)| (k, v.as_f64().unwrap())).collect();
    let scales = case["has_part_scales"].as_bool().unwrap().then_some(&scales);
    match model::open_project(&files, case["rig"].as_str(), &attach, case["project_name"].as_str().unwrap(), case["head_scale"].as_f64().unwrap(), scales, &[("source", "zip")]) {
        Ok(text) => text,
        Err(e) => format!("error: {e:?}"),
    }
}

/// Replays every case in `dir`; returns the failures and the timings.
fn replay(dir: &Path, exact_zip_times: bool) -> (Vec<String>, Vec<Timing>) {
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(dir.join("cases.json")).unwrap()).unwrap();
    let mut failures = Vec::new();
    let mut timings = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap().to_string();
        if case.get("function").and_then(Value::as_str) == Some("open_project") {
            if let Some(problem) = compare_body(run_open_project(dir, case).as_bytes(), dir, &case["response"], exact_zip_times) {
                failures.push(format!("{name}: {problem}"));
            }
            continue;
        }
        let req = Request {
            method: case["method"].as_str().unwrap().into(),
            path: case["path"].as_str().unwrap().into(),
            query: case["query"].as_str().unwrap().into(),
            headers: vec![("Content-Type".into(), case["content_type"].as_str().unwrap().into())],
            body: blob(dir, &case["request"]),
        };
        let started = Instant::now();
        let res = crate::routes::handle(&req);
        timings.push(Timing { name: name.clone(), python_ms: case["python_ms"].as_f64().unwrap_or(0.0), rust_ms: started.elapsed().as_secs_f64() * 1000.0 });
        let status = case["status"].as_u64().unwrap() as u16;
        if res.status != status {
            failures.push(format!("{name}: status rust {} / python {status}: {}", res.status, String::from_utf8_lossy(&res.body[..res.body.len().min(300)])));
            continue;
        }
        if case["loose"].as_bool().unwrap() {
            continue;
        }
        for (k, v) in case["headers"].as_object().unwrap() {
            let got = res.headers.iter().find(|(h, _)| h.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str());
            if got != v.as_str() {
                failures.push(format!("{name}: header {k} rust {got:?} / python {v}"));
            }
        }
        if let Some(problem) = compare_body(&res.body, dir, &case["response"], exact_zip_times) {
            failures.push(format!("{name}: {problem}"));
        }
    }
    (failures, timings)
}

#[test]
fn routes_are_registered() {
    assert_eq!(routes().len(), 14);
    assert_eq!(commands()[0].name, "save_blueprint_editor_file");
}

#[test]
fn fixture_parity() {
    setup();
    let (failures, timings) = replay(&fixtures(), false);
    assert!(timings.len() > 200, "the fixtures are missing; run tools/parity/blueprint.py fixtures");
    assert!(failures.is_empty(), "{} of the parity cases differ:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn save_dialog_cancelled() {
    setup();
    let out = crate::call("save_blueprint_editor_file", vec![serde_json::json!("a/b\\x.blueprint"), serde_json::json!("aGk=")]).unwrap().unwrap();
    assert_eq!(crate::json::dumps(&out), r#"{"success": true, "code": "OK", "data": {"cancelled": true}, "error": null, "meta": {}, "cancelled": true}"#);
    assert_eq!(suffix("x."), ".");
    assert_eq!(suffix(".rc"), "");
    assert_eq!(suffix("a.b.C"), ".C");
}

fn short_sha(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    hex::encode(h.finalize())[..24].to_string()
}

/// `guard(fn)` in the sweep: an editor error by its message, anything else is a 500.
fn guarded(r: Result<String>) -> String {
    match r {
        Ok(s) => s,
        Err(Error::Value(Kind::Editor, m)) => format!("editor: {m}"),
        Err(_) => "internal".into(),
    }
}

/// The engine run over thousands of real blueprints, compared by hash with
/// `python tools/parity/blueprint.py sweep <file> <n>`; set `BTT_BLUEPRINT_SWEEP=<file>`.
#[test]
#[ignore]
fn install_sweep() {
    setup();
    let file = PathBuf::from(std::env::var("BTT_BLUEPRINT_SWEEP").expect("BTT_BLUEPRINT_SWEEP=<file from the sweep mode>"));
    let sweep: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let game = game_path().expect("no Trove install");
    let index = game_data::index_of(&game, "blueprints").unwrap();
    let none = Py::List(Vec::new());
    let dump = |v: &Value| crate::json::dumps(v).into_bytes();
    let mut failures = Vec::new();
    let started = Instant::now();
    let rows = sweep["rows"].as_array().unwrap();
    for row in rows {
        let path = row["path"].as_str().unwrap();
        let raw = game_data::read_indexed(&index, &path["blueprints/".len()..]).unwrap();
        let mut got = serde_json::Map::new();
        got.insert("inspect".into(), guarded(editor::inspect(&raw, "m.blueprint").map(|p| short_sha(&[p.json.as_bytes()]))).into());
        if let Some(edits) = row["edits"].as_str() {
            let edits = py::loads(edits).unwrap();
            let ops = py::loads(r#"["rotate_y", "mirror_x", "rotate_z"]"#).unwrap();
            got.insert("save".into(), guarded(editor::composite(&raw, &none, &[], &none, 0).map(|(b, _)| short_sha(&[&b]))).into());
            got.insert(
                "edited".into(),
                guarded(editor::composite(&raw, &edits, &[], &none, 0).map(|(b, s)| short_sha(&[&b, &dump(&Value::Object(s))]))).into(),
            );
            got.insert("transform".into(), guarded(editor::transform(&raw, &none, &ops).map(|(b, s)| short_sha(&[&b, &dump(&s)]))).into());
            got.insert("check".into(), guarded(editor::check(&raw, &none, "hat", &[], &none, 0).map(|r| short_sha(&[&dump(&r)]))).into());
            let qb = editor::export_qb(&raw, &edits, &[], &none, 0, "m").map(|(zip, notes)| {
                let members = pyzlib::zip_members(&zip).unwrap();
                let files: Vec<(String, Vec<u8>)> = members.iter().map(|m| (m.filename.clone(), pyzlib::zip_read(&zip, m).unwrap())).collect();
                let back = guarded(qb::to_blueprint(&files).map(|(b, s)| short_sha(&[&b, &dump(&s)])));
                format!("{}/{back}", short_sha(&[&zip, &dump(&serde_json::json!(notes))]))
            });
            got.insert("qb".into(), guarded(qb).into());
        }
        for (k, v) in &got {
            if row.get(k) != Some(v) {
                failures.push(format!("{path} {k}: rust {v} / python {}", row.get(k).unwrap_or(&Value::Null)));
            }
        }
    }
    println!("{} blueprints: python {}s, rust {:.2}s", rows.len(), sweep["python_seconds"], started.elapsed().as_secs_f64());
    assert!(failures.is_empty(), "{} differences:\n{}", failures.len(), failures.iter().take(40).cloned().collect::<Vec<_>>().join("\n"));
}

/// The install's real mods unpacked and rebuilt, against
/// `python tools/parity/blueprint.py mods <file>`; set `BTT_BLUEPRINT_MODS=<file>`.
#[test]
#[ignore]
fn install_mods() {
    setup();
    let file = PathBuf::from(std::env::var("BTT_BLUEPRINT_MODS").expect("BTT_BLUEPRINT_MODS=<file from the mods mode>"));
    let rows: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let folder = game_path().expect("no Trove install").join("mods");
    let mut failures = Vec::new();
    for row in &rows {
        let name = row["name"].as_str().unwrap();
        let data = std::fs::read(folder.join(name)).unwrap();
        let mut got = serde_json::Map::new();
        got.insert("name".into(), name.into());
        match model::unpack(&data, name) {
            Ok((kind, props, files)) => {
                got.insert("kind".into(), kind.into());
                got.insert("props".into(), props.iter().map(|(k, v)| serde_json::json!([k, v])).collect());
                got.insert("files".into(), files.iter().map(|(p, d)| serde_json::json!([p, short_sha(&[d])])).collect());
                match model::repack(kind, &props, &files) {
                    Ok((out, ext)) => got.insert("repack".into(), serde_json::json!([ext, short_sha(&[&out])])),
                    Err(e) => got.insert("error".into(), format!("{e:?}").into()),
                };
            }
            Err(Error::Value(Kind::Editor, m)) => {
                got.insert("error".into(), m.into());
            }
            Err(e) => {
                got.insert("error".into(), format!("{e:?}").into());
            }
        }
        if Value::Object(got.clone()) != *row {
            failures.push(format!("{name}:\n  rust   {}\n  python {}", Value::Object(got), row));
        }
    }
    println!("{} mods compared", rows.len());
    assert!(failures.is_empty(), "{} differences:\n{}", failures.len(), failures.join("\n"));
}

#[test]
#[ignore]
fn install_parity() {
    setup();
    let dir = PathBuf::from(std::env::var("BTT_BLUEPRINT_PARITY").expect("BTT_BLUEPRINT_PARITY=<dir from tools/parity/blueprint.py install>"));
    let game = game_path().expect("no Trove install");
    let started = Instant::now();
    while game_data::rig_map(&game).is_none() {
        assert!(game_data::index_error().is_none(), "{:?}", game_data::index_error());
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let index_s = started.elapsed().as_secs_f64();
    let ours = std::fs::read(crate::paths::get_cache_root().join("blueprint_editor").join("rig_index.json")).unwrap();
    let theirs = std::fs::read(dir.join("rig_index.json")).unwrap();
    let mut failures = Vec::new();
    if ours != theirs {
        failures.push(format!("rig_index.json: {}", first_diff(&ours, &theirs)));
    }
    let (more, timings) = replay(&dir, true);
    failures.extend(more);
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
    println!("rig index: python {}s, rust {index_s:.2}s", meta["python_index_seconds"]);
    let mut heavy: Vec<&Timing> = timings.iter().filter(|t| t.python_ms > 50.0 || t.name.starts_with("model")).collect();
    heavy.sort_by(|a, b| b.python_ms.total_cmp(&a.python_ms));
    for t in heavy.iter().take(60) {
        println!("{:>9.1} ms python {:>8.1} ms rust  {}", t.python_ms, t.rust_ms, t.name);
    }
    let (py, rs): (f64, f64) = timings.iter().fold((0.0, 0.0), |a, t| (a.0 + t.python_ms, a.1 + t.rust_ms));
    println!("{} cases: python {py:.0} ms, rust {rs:.0} ms", timings.len());
    assert!(failures.is_empty(), "{} of the install cases differ:\n{}", failures.len(), failures.join("\n"));
}
