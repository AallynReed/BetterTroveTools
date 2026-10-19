//! The INI-like `.cfg` files UI mods read their settings from (`ModCfgs/<title>.cfg`).

use serde_json::{Map, Value};

use crate::py::{lstrip, splitlines, strip};

/// Sections in file order, each an ordered `key -> value` map.
pub type Sections = Map<String, Value>;

/// `_parse_cfg_sections`.
pub fn parse(text: &str) -> Sections {
    let mut sections = Sections::new();
    let mut current: Option<String> = None;
    for raw_line in splitlines(text) {
        let line = strip(raw_line);
        if line.is_empty() {
            continue;
        }
        if line.len() >= 2 && line.starts_with('[') && line.ends_with(']') {
            let name = strip(&line[1..line.len() - 1]).to_string();
            sections.entry(name.clone()).or_insert_with(|| Value::Object(Map::new()));
            current = Some(name);
            continue;
        }
        let Some(section) = &current else { continue };
        let Some((key, value)) = raw_line.split_once('=') else { continue };
        if let Some(Value::Object(map)) = sections.get_mut(section) {
            map.insert(strip(key).to_string(), Value::String(lstrip(value).to_string()));
        }
    }
    sections
}

/// `_serialize_cfg_sections`.
pub fn serialize(sections: &Sections) -> String {
    let mut out: Vec<String> = Vec::new();
    for (i, (name, values)) in sections.iter().enumerate() {
        if i > 0 {
            out.push(String::new());
        }
        out.push(format!("[{}]", name));
        if let Value::Object(map) = values {
            for (k, v) in map {
                out.push(format!("{} = {}", k, v.as_str().unwrap_or("")));
            }
        }
    }
    out.join("\n")
}

/// `ensure_config`'s merge: the user's file wins; missing sections and keys come from
/// the mod.
pub fn merge(current: Sections, desired: &Sections) -> Sections {
    let mut merged = current;
    for (name, values) in desired {
        match merged.get_mut(name) {
            None => {
                merged.insert(name.clone(), values.clone());
            }
            Some(Value::Object(have)) => {
                if let Value::Object(want) = values {
                    for (k, v) in want {
                        if !have.contains_key(k) {
                            have.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
            Some(_) => {}
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_merge_serialize() {
        let user = parse("[a.swf]\r\nx = 1  \nignored\n[b]\ny=2");
        let mine = parse("[a.swf]\nx = 9\nz =3\n[c]\n");
        let out = serialize(&merge(user, &mine));
        assert_eq!(out, "[a.swf]\nx = 1  \nz = 3\n\n[b]\ny = 2\n\n[c]");
    }
}
