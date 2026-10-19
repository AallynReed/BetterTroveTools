//! Parity tests against golden output from tools/parity/gems.py. Set BTT_GEMS_FIXTURES to
//! a folder written by `gems.py --full OUT` to see full answers instead of hashes.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::py;

fn fixtures() -> PathBuf {
    std::env::var_os("BTT_GEMS_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("gems"))
}

fn load(name: &str) -> Value {
    let text = std::fs::read_to_string(fixtures().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    let mut p = Exact { s: text.as_bytes(), i: 0 };
    p.value()
}

/// A JSON reader with correctly rounded floats. serde_json's default float parser can be
/// a bit off (it needs its `float_roundtrip` feature), which would hide or fake 1-ULP diffs.
struct Exact<'a> {
    s: &'a [u8],
    i: usize,
}

impl Exact<'_> {
    fn ws(&mut self) {
        while self.s.get(self.i).is_some_and(u8::is_ascii_whitespace) {
            self.i += 1;
        }
    }

    fn value(&mut self) -> Value {
        self.ws();
        match self.s[self.i] {
            b'{' => {
                self.i += 1;
                let mut m = Map::new();
                loop {
                    self.ws();
                    if self.s[self.i] == b'}' {
                        self.i += 1;
                        return Value::Object(m);
                    }
                    let Value::String(k) = self.value() else { panic!("bad key") };
                    self.ws();
                    self.i += 1; // ':'
                    let v = self.value();
                    m.insert(k, v);
                    self.ws();
                    if self.s[self.i] == b',' {
                        self.i += 1;
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut a = Vec::new();
                loop {
                    self.ws();
                    if self.s[self.i] == b']' {
                        self.i += 1;
                        return Value::Array(a);
                    }
                    a.push(self.value());
                    self.ws();
                    if self.s[self.i] == b',' {
                        self.i += 1;
                    }
                }
            }
            b'"' => {
                let start = self.i;
                self.i += 1;
                while self.s[self.i] != b'"' {
                    self.i += if self.s[self.i] == b'\\' { 2 } else { 1 };
                }
                self.i += 1;
                serde_json::from_slice(&self.s[start..self.i]).unwrap()
            }
            _ => {
                let start = self.i;
                while self.s.get(self.i).is_some_and(|c| !b",]} \n\r\t".contains(c)) {
                    self.i += 1;
                }
                let tok = std::str::from_utf8(&self.s[start..self.i]).unwrap();
                match tok {
                    "null" => Value::Null,
                    "true" => json!(true),
                    "false" => json!(false),
                    t if t.contains(['.', 'e', 'E']) => py::float(t.parse().unwrap()),
                    t => serde_json::from_str(t).unwrap(),
                }
            }
        }
    }
}

/// The test context, with the data folder in a throwaway directory.
fn init() {
    static SANDBOX: OnceLock<tempfile::TempDir> = OnceLock::new();
    SANDBOX.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        for key in ["APPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"] {
            std::env::set_var(key, dir.path());
        }
        std::env::remove_var(crate::paths::DATA_DIR_ENV_VAR);
        dir
    });
    crate::ctx::testing::init();
}

fn run(cmd: &str, args: Vec<Value>) -> Value {
    match crate::call(cmd, args) {
        Some(Ok(v)) => v,
        Some(Err(e)) => json!({"raised": e}),
        None => panic!("no endpoint {cmd}"),
    }
}

fn sha(v: &Value) -> String {
    hex::encode(Sha256::digest(crate::json::dumps(v).as_bytes()))
}

/// The same canonical form gems.py stores.
fn canon(mut value: Value, canon: Option<&str>) -> Value {
    fn fix_chart(d: &mut Value) {
        if let Some(Value::Object(stats)) = d.get_mut("stats") {
            let mut entries: Vec<(String, Value)> = std::mem::take(stats).into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            stats.extend(entries);
        }
        if let Some(Value::Array(a)) = d.get_mut("abilities") {
            a.sort_by(|x, y| x.as_str().cmp(&y.as_str()));
        }
    }
    match canon {
        Some("chart") => {
            fix_chart(&mut value);
            if let Some(data) = value.get_mut("data") {
                fix_chart(data);
            }
        }
        Some("gem_id") => {
            if let Some(gem) = value.get_mut("gem").filter(|g| g.is_object()) {
                gem["id"] = json!(0);
            }
            if let Some(gem) = value.get_mut("data").and_then(|d| d.get_mut("gem")).filter(|g| g.is_object()) {
                gem["id"] = json!(0);
            }
        }
        _ => {}
    }
    value
}

fn resolve(v: &Value, gems: &[Value]) -> Value {
    match v {
        Value::Object(m) if m.len() == 1 && m.contains_key("$gem") => gems[m["$gem"].as_u64().unwrap() as usize].clone(),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), resolve(v, gems))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(|v| resolve(v, gems)).collect()),
        other => other.clone(),
    }
}

/// The first place two JSON values differ, for readable failures.
fn first_diff(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let (kx, ky): (Vec<_>, Vec<_>) = (x.keys().collect(), y.keys().collect());
            if kx != ky {
                return Some(format!("{path}: keys {kx:?} vs {ky:?}"));
            }
            x.iter().find_map(|(k, v)| first_diff(v, &y[k], &format!("{path}.{k}")))
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x.iter().zip(y).enumerate().find_map(|(i, (p, q))| first_diff(p, q, &format!("{path}[{i}]"))),
        _ if a == b => None,
        _ => Some(format!("{path}: {} vs {}", short(a), short(b))),
    }
}

fn short(v: &Value) -> String {
    let s = crate::json::dumps(v);
    if s.len() > 1500 { format!("{}...", &s[..1500]) } else { s }
}

/// Runs every case of a fixture file; returns the failures.
fn check_cases(cases: &[Value], gems: &[Value]) -> Vec<String> {
    let mut failures = Vec::new();
    for case in cases {
        let cmd = case["cmd"].as_str().unwrap();
        let args = resolve(&case["args"], gems).as_array().cloned().unwrap();
        let actual = canon(run(cmd, args), case.get("canon").and_then(Value::as_str));
        let label = format!("{cmd}({})", short(&case["args"]));
        if let Some(expect) = case.get("expect") {
            if &actual != expect {
                let diff = first_diff(expect, &actual, "$").unwrap_or_default();
                failures.push(format!("{label}\n  expected vs actual at {diff}"));
            }
        } else if let Some(hash) = case.get("sha256") {
            if sha(&actual) != hash.as_str().unwrap() {
                let first = case.get("first_builds").map(|b| format!("\n  expected first builds {}", short(b))).unwrap_or_default();
                failures.push(format!("{label}\n  hash mismatch{first}\n  actual {}", short(&actual)));
            }
        } else if let Some(options) = case.get("any_of") {
            let options = options.as_array().unwrap();
            if !options.contains(&actual) {
                let diffs: Vec<String> = options.iter().filter_map(|o| first_diff(o, &actual, "$")).collect();
                failures.push(format!("{label}\n  not one of the outcomes; diffs: {}", diffs.join(" | ")));
            }
        } else if let Some(hashes) = case.get("any_of_sha256") {
            if !hashes.as_array().unwrap().iter().any(|h| h.as_str() == Some(sha(&actual).as_str())) {
                failures.push(format!("{label}\n  matches no recorded outcome\n  actual {}", short(&actual)));
            }
        }
    }
    failures
}

fn assert_cases(file: &str) {
    init();
    let data = load(file);
    let (cases, gems) = match &data {
        Value::Array(cases) => (cases.clone(), Vec::new()),
        other => (other["cases"].as_array().cloned().unwrap(), other["gems"].as_array().cloned().unwrap_or_default()),
    };
    let failures = check_cases(&cases, &gems);
    assert!(failures.is_empty(), "{} of {} {file} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n\n"));
}

#[test]
fn round_matches_python() {
    let cases = load("round.json");
    for case in cases.as_array().unwrap() {
        let (x, n, expect) = (case[0].as_f64().unwrap(), case[1].as_i64().unwrap() as i32, case[2].as_f64().unwrap());
        assert_eq!(py::round_to(x, n).to_bits(), expect.to_bits(), "round({x}, {n})");
    }
}

#[test]
fn evaluator_matches_python() {
    assert_cases("evaluator.json");
}

#[test]
fn builds_and_star_chart_codes_match_python() {
    assert_cases("builds.json");
}

#[test]
fn simulator_matches_python() {
    assert_cases("simulator.json");
}

#[test]
fn star_chart_layout_matches_python() {
    init();
    let expect = load("star_chart_layout.json");
    let actual = run("get_calculated_star_chart", vec![]);
    assert_eq!(actual["origin"], expect["origin"]);
    let mut coords = Map::new();
    fn walk(node: &Value, out: &mut Map<String, Value>) {
        if let Some(path) = node.get("Path").and_then(Value::as_str) {
            out.insert(path.to_string(), node["Coords"].clone());
        }
        for child in node.get("Stars").and_then(Value::as_array).into_iter().flatten() {
            walk(child, out);
        }
    }
    for constell in actual["data"].as_object().unwrap().values() {
        walk(constell, &mut coords);
    }
    let expected = expect["coords"].as_object().unwrap();
    assert_eq!(coords.len(), expected.len());
    for (path, want) in expected {
        let got = &coords[path];
        for i in 0..2 {
            let (g, w) = (got[i].as_f64().unwrap(), want[i].as_f64().unwrap());
            // libm cos/sin may differ in the last bit across platforms; Windows matches exactly.
            let tolerance = if cfg!(windows) { 0.0 } else { 1e-9 };
            assert!((g - w).abs() <= tolerance, "{path}[{i}]: {g} vs {w}");
        }
    }
    if cfg!(windows) {
        assert_eq!(sha(&actual), expect["sha256"].as_str().unwrap());
    }
    // Served from the cache the second time, unchanged.
    assert_eq!(run("get_calculated_star_chart", vec![]), actual);
}

#[test]
fn storage_matches_python() {
    init();
    let _env = crate::ctx::testing::ENV_LOCK.lock();
    std::env::set_var("APPDATA", crate::ctx::testing::sandbox());
    let script = load("storage.json");
    let file = crate::storage::get_storage_file();
    let _ = std::fs::remove_file(&file);
    let mut failures = Vec::new();
    for step in script["steps"].as_array().unwrap() {
        let cmd = step["cmd"].as_str().unwrap();
        let actual = run(cmd, step["args"].as_array().cloned().unwrap());
        if actual != step["expect"] {
            failures.push(format!("{cmd}({}): expected {} got {}", step["args"], step["expect"], actual));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), script["file"].as_str().unwrap());
}

/// Must match `summarize` in tools/parity/gems.py.
fn summarize(gem: &Value, freq: &mut BTreeMap<String, f64>, bases: &mut Vec<f64>) {
    let mut bump = |k: String| *freq.entry(k).or_default() += 1.0;
    let repr = |v: &Value| py::repr(v);
    for key in ["tier", "type", "element", "restriction", "ability", "level"] {
        bump(format!("{key}={}", repr(&gem[key])));
    }
    for (i, stat) in gem["stats"].as_array().unwrap().iter().enumerate() {
        bump(format!("stat={}", stat["type"]));
        bump(format!("stat{i}.containers={}", stat["containers"].as_array().unwrap().len()));
        if stat["locked"] == true {
            bump(format!("locked={}", stat["type"]));
        }
        for c in stat["containers"].as_array().unwrap() {
            bases.push(c["base"].as_f64().unwrap());
        }
    }
}

#[test]
fn create_gem_distribution_matches_python() {
    init();
    for set in load("create_distribution.json").as_array().unwrap() {
        let runs = set["runs"].as_u64().unwrap() as usize;
        let mut freq = BTreeMap::new();
        let mut bases = Vec::new();
        for _ in 0..runs {
            let r = run("create_gem", vec![set["params"].clone()]);
            assert_eq!(r["success"], true, "{r}");
            summarize(&r["gem"], &mut freq, &mut bases);
        }
        let expected = set["freq"].as_object().unwrap();
        let mut keys: Vec<&String> = freq.keys().collect();
        keys.extend(expected.keys());
        keys.sort();
        keys.dedup();
        for k in keys {
            let got = freq.get(k).copied().unwrap_or(0.0) / runs as f64;
            let want = expected.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            // Five standard errors of the difference of two binomial proportions.
            let p = (got + want) / 2.0;
            let tolerance = 5.0 * (p * (1.0 - p) * 2.0 / runs as f64).sqrt() + 1e-9;
            assert!((got - want).abs() <= tolerance, "{} {k}: {got} vs python {want}", set["params"]);
        }
        let mean = bases.iter().sum::<f64>() / bases.len() as f64;
        assert!((mean - set["base_mean"].as_f64().unwrap()).abs() < 0.02, "{} base mean {mean}", set["params"]);
    }
}

#[test]
fn created_gems_hold_their_invariants() {
    init();
    for i in 0..3000 {
        let level = (i % 40) as i64;
        let r = run("create_gem", vec![json!({"level": level})]);
        let gem = &r["gem"];
        let (tier, kind, element) = (gem["tier"].as_i64().unwrap(), gem["type"].as_i64().unwrap(), gem["element"].as_i64().unwrap());
        let max = [23, 25, 30, 35][(tier - 1) as usize];
        assert_eq!(gem["level"].as_i64().unwrap(), level.min(max));
        let stats = gem["stats"].as_array().unwrap();
        let total: usize = stats.iter().map(|s| s["containers"].as_array().unwrap().len()).sum();
        assert_eq!(total as i64, 3 + level.min(15) / 5);
        let types: Vec<i64> = stats.iter().map(|s| s["type"].as_i64().unwrap()).collect();
        assert!(!(types.contains(&1) && types.contains(&2)), "{gem}");
        let locked: Vec<i64> = stats.iter().filter(|s| s["locked"] == true).map(|s| s["type"].as_i64().unwrap()).collect();
        assert_eq!(locked, if element == 4 { vec![7] } else { vec![] }, "{gem}");
        if kind == 1 {
            let r = gem["restriction"].as_i64().unwrap();
            assert!(!types.contains(&if r == 1 { 2 } else { 1 }), "{gem}");
            assert!(gem["ability"].is_null());
        } else {
            assert!(gem["restriction"].is_null());
            let a = gem["ability"].as_i64().unwrap();
            assert!(if element == 4 { (9..=12).contains(&a) } else { (1..=8).contains(&a) }, "{gem}");
        }
    }
}

#[test]
fn arity_errors_match_python() {
    init();
    let cases = [
        ("augment_gem", vec![json!({})], "augment_gem() missing 2 required positional arguments: 'stat_id' and 'augment_id'"),
        ("evaluate_gem", vec![], "evaluate_gem() missing 1 required positional argument: 'data'"),
        ("get_gem_lookups", vec![json!(1)], "get_gem_lookups() takes 0 positional arguments but 1 was given"),
        ("save_gem_builds_csv", vec![json!(1), json!(2), json!(3)], "save_gem_builds_csv() takes from 1 to 2 positional arguments but 3 were given"),
        ("evaluate_gem", vec![json!(1), json!(2)], "evaluate_gem() takes 1 positional argument but 2 were given"),
    ];
    for (cmd, args, msg) in cases {
        let r = run(cmd, args);
        assert_eq!(r["error"], msg);
        assert_eq!(r["code"], "UNHANDLED_EXCEPTION");
    }
}

#[test]
fn csv_export_cancel_and_empty() {
    init();
    let r = run("save_gem_builds_csv", vec![json!("a,b\n1,2\n")]);
    assert_eq!(r, json!({"success": false, "code": "ERROR", "data": {"canceled": true}, "error": null, "meta": {}, "canceled": true}));
    let r = run("save_gem_builds_csv", vec![json!("  ")]);
    assert_eq!(r["code"], "EMPTY_EXPORT");
}
