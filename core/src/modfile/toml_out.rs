//! `toml.dumps` (toml 0.10.2) for the one document the mod model writes:
//! `{"name": str, "properties": {str: str}, "files": [str]}`.

use anyhow::{anyhow, Result};

use super::compat::repr_str;

/// `toml.encoder._dump_str`, quirks included: it starts from Python's `repr()` and
/// rewrites `\xNN` escapes, dropping their backslash (and raising for a leading one).
pub fn dump_str(v: &str) -> Result<String> {
    let r = repr_str(v);
    let single = r.starts_with('\'');
    let mut v = r[1..r.len() - 1].to_string();
    if single {
        v = v.replace("\\'", "'").replace('"', "\\\"");
    }
    let mut parts: Vec<String> = v.split("\\x").map(String::from).collect();
    while parts.len() > 1 {
        if parts[0].is_empty() {
            parts.remove(0);
        }
        parts[0] = parts[0].replace("\\\\", "\\");
        let first: Vec<char> = parts[0].chars().collect();
        let Some(last) = first.last() else { return Err(anyhow!("string index out of range")) };
        let mut joinx = *last != '\\';
        let mut i = first.len() - 1;
        while i > 0 && first[i] == '\\' {
            joinx = !joinx;
            i -= 1;
        }
        let Some(next) = parts.get(1).cloned() else { return Err(anyhow!("list index out of range")) };
        let merged = format!("{}{}{}", parts[0], if joinx { "x" } else { "u00" }, next);
        parts.splice(0..2, [merged]);
    }
    Ok(format!("\"{}\"", parts[0]))
}

fn dump_key(k: &str) -> Result<String> {
    if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        Ok(k.to_string())
    } else {
        dump_str(k)
    }
}

/// The metadata document.
pub fn dumps_metadata(name: Option<&str>, properties: &[(String, String)], files: &[String]) -> Result<String> {
    let mut out = String::new();
    if let Some(name) = name {
        out.push_str(&format!("name = {}\n", dump_str(name)?));
    }
    let mut items = String::new();
    for f in files {
        items.push_str(&format!(" {},", dump_str(f)?));
    }
    out.push_str(&format!("files = [{}]\n", items));
    if !out.ends_with("\n\n") {
        out.push('\n');
    }
    out.push_str("[properties]\n");
    for (k, v) in properties {
        out.push_str(&format!("{} = {}\n", dump_key(k)?, dump_str(v)?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cases recorded from toml 0.10.2 by tools/parity/modfile.py.
    #[test]
    fn matches_recorded_toml_output() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/modfile/toml_cases.json");
        let cases: Vec<(String, String)> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(!cases.is_empty());
        for (input, expected) in cases {
            let props = vec![("title".to_string(), input.clone()), ("my key".to_string(), "v".to_string()), ("k.x".to_string(), input.clone())];
            let got = match dumps_metadata(Some(&input), &props, &[input.clone(), "b".to_string()]) {
                Ok(s) => s,
                Err(e) => format!("ERR {}", e),
            };
            let expected = expected.split_once(": ").filter(|_| expected.starts_with("ERR ")).map(|(_, m)| format!("ERR {}", m)).unwrap_or(expected);
            assert_eq!(got, expected, "input {input:?}");
        }
    }
}
