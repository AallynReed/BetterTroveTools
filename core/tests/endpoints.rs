//! Every function the Python backend exposed over eel must exist in btt-core under the same name.

use std::collections::BTreeSet;
use std::path::Path;

fn python_endpoints(root: &Path) -> BTreeSet<String> {
    let decorated = regex::Regex::new(r"@eel\.expose\s*\n(?:\s*@[\w.]+\s*\n)*\s*def\s+(\w+)").unwrap();
    let mut names = BTreeSet::new();
    let mut files = vec![root.join("main.py")];
    for dir in ["backend", "utils", "models"] {
        for entry in walkdir::WalkDir::new(root.join(dir)).into_iter().filter_map(|e| e.ok()) {
            if entry.path().extension().map(|e| e == "py").unwrap_or(false) {
                files.push(entry.into_path());
            }
        }
    }
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let text = text.replace("\r\n", "\n");
        for cap in decorated.captures_iter(&text) {
            names.insert(cap[1].to_string());
        }
    }
    // codex_cache.py registers get_<key>_data / clear_<key>_cache for each codex module.
    let key_re = regex::Regex::new(r#"(?m)^\w+\s*=\s*Codex\(\s*["'](\w+)["']"#).unwrap();
    for entry in walkdir::WalkDir::new(root.join("backend/codexes")).into_iter().filter_map(|e| e.ok()) {
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        for cap in key_re.captures_iter(&text) {
            names.insert(format!("get_{}_data", &cap[1]));
            names.insert(format!("clear_{}_cache", &cap[1]));
        }
    }
    names
}

#[test]
fn every_python_endpoint_is_ported() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let python = python_endpoints(root);
    assert!(python.len() > 150, "found only {} Python endpoints; the scan is broken", python.len());
    let rust: BTreeSet<String> = btt_core::command_names().into_iter().map(String::from).collect();
    let missing: Vec<_> = python.difference(&rust).cloned().collect();
    assert!(missing.is_empty(), "{} of {} endpoints not ported:\n{}", missing.len(), python.len(), missing.join("\n"));
}
