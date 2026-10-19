//! models/trove/prefab_mount.py: the Mount Codex.

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Map, Value};

use super::binfab::{extract_strings, BinString, ParsedPrefab};
use super::prefab_ally::{
    clean_localized_text, extract_designer_from_blueprint, find_prefabs, infer_mastery_base, load_blueprint_path_map, load_language_map, load_multiplier_file_map,
    load_prefabs, parse_item_pet_signature, prefabs_index, require_prefabs_root, resolve_blueprint_catalog_path, resolve_localized_value, GameFiles, LanguageMap, MultiplierMap,
};
use super::py;

pub const MOUNT_PREFIX: &str = "collections/mount/";
pub const ITEM_MOUNT_PREFIX: &str = "item/mount/";

static NAME_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\$prefabs_[A-Za-z0-9_]+(?:_item)?_name)").unwrap());
static DESC_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\$prefabs_[A-Za-z0-9_]+(?:_description|_desc))").unwrap());

pub fn mount_key_from_prefab_path(prefab_path: &str) -> String {
    let normalized = prefab_path.replace('\\', "/");
    let rest = if normalized.to_lowercase().starts_with(MOUNT_PREFIX) { &normalized[MOUNT_PREFIX.len()..] } else { &normalized };
    py::stem(rest).to_string()
}

pub fn item_mount_key_from_prefab_path(prefab_path: &str) -> String {
    let key = mount_key_from_prefab_path(prefab_path);
    for suffix in ["_notrade", "_trade"] {
        if let Some(k) = key.strip_suffix(suffix) {
            return k.to_string();
        }
    }
    key
}

/// Mount stem to its `collection_mount.binfab` category.
pub fn load_collection_mount_category_map(game: &GameFiles) -> Result<HashMap<String, String>> {
    require_prefabs_root(game.path())?;
    let mut out = HashMap::new();
    let Some(content) = game.read_prefab("collections/collection_mount.binfab")? else { return Ok(out) };
    let strings: Vec<String> = extract_strings(&content).into_iter().map(|s| s.text).collect();
    let mut current = String::new();
    for (i, text) in strings.iter().enumerate() {
        if strings.get(i + 1).is_some_and(|n| n.starts_with("$CollectionName_")) {
            current = text.clone();
            continue;
        }
        let normalized = text.trim_start_matches('$');
        if normalized.starts_with(MOUNT_PREFIX) && !current.is_empty() {
            out.insert(py::stem(normalized).to_string(), current.clone());
        }
    }
    Ok(out)
}

pub fn load_mount_multipliers_map(game: &GameFiles) -> Result<MultiplierMap> {
    let mut rows = load_multiplier_file_map(game, "meta/multipliers.binfab", false)?;
    rows.retain(|k, _| k.starts_with(MOUNT_PREFIX));
    Ok(rows)
}

pub fn extract_mount_localization_keys(strings: &[BinString]) -> (String, String) {
    let mut name_key = String::new();
    let mut desc_key = String::new();
    for item in strings {
        if name_key.is_empty() {
            if let Some(c) = NAME_KEY_RE.captures(&item.text) {
                name_key = clean_localized_text(&c[1]);
            }
        }
        if desc_key.is_empty() {
            if let Some(c) = DESC_KEY_RE.captures(&item.text) {
                desc_key = clean_localized_text(&c[1]);
            }
        }
        if !name_key.is_empty() && !desc_key.is_empty() {
            break;
        }
    }
    (name_key, desc_key)
}

pub fn resolve_mount_name_value(strings: &[BinString], language: &LanguageMap, name_key: &str) -> String {
    let name = resolve_localized_value(language, name_key);
    if !name.is_empty() {
        return name;
    }
    for item in strings {
        let text = &item.text;
        if text.starts_with('$') || text.contains("Pets and MountsX") {
            continue;
        }
        if text.contains('(') && text.chars().count() < 80 {
            return py::strip(&text.replace('(', "")).to_string();
        }
    }
    String::new()
}

pub fn resolve_mount_description_value(strings: &[BinString], language: &LanguageMap, desc_key: &str) -> String {
    let desc = resolve_localized_value(language, desc_key);
    if !desc.is_empty() {
        return desc;
    }
    for item in strings {
        let text = &item.text;
        if text.starts_with('$') {
            continue;
        }
        if let Some(rest) = text.strip_prefix("Pets and MountsX") {
            if !text.contains('$') {
                return py::strip(rest.trim_end_matches('h')).to_string();
            }
        }
    }
    String::new()
}

pub fn choose_mount_blueprint(parsed: &ParsedPrefab) -> String {
    let mut candidates: Vec<String> = parsed
        .strings
        .iter()
        .filter(|e| {
            let l = e.text.to_lowercase();
            l.contains("_ui") && (l.ends_with(".blueprint") || l.contains("/mounts/") || l.starts_with("c_mt_"))
        })
        .map(|e| e.text.clone())
        .collect();
    if candidates.is_empty() {
        return parsed.blueprint.clone().unwrap_or_default();
    }
    candidates.sort_by_key(|v| (!v.to_lowercase().contains(".blueprint"), v.chars().count()));
    candidates.swap_remove(0)
}

fn movement_flags(parsed: &ParsedPrefab) -> Value {
    let (mut ground, mut wing, mut glide) = (Value::Null, Value::Null, Value::Null);
    for e in &parsed.strings {
        match e.text.to_lowercase().as_str() {
            "ground_movespeedf" => ground = json!(1.0),
            "wing_movespeedf" => wing = json!(1.0),
            "glide_movespeedf" => glide = json!(1.0),
            _ => {}
        }
    }
    json!({"ground": ground, "wing": wing, "glide": glide})
}

pub fn build_mounts_dataset(game_path: &Path, locale: &str) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let game = &GameFiles::open(game_path);
    let index = prefabs_index(game)?;
    let mount_matches = find_prefabs(&index, MOUNT_PREFIX, None, mount_key_from_prefab_path);
    let item_matches = find_prefabs(&index, ITEM_MOUNT_PREFIX, None, item_mount_key_from_prefab_path);
    let mounts = load_prefabs(&mount_matches, Some(true))?;
    let items = load_prefabs(&item_matches, None)?;
    let language = load_language_map(game, locale)?;
    let blueprints = load_blueprint_path_map(game)?;
    let categories = load_collection_mount_category_map(game)?;
    let multipliers = load_mount_multipliers_map(game)?;

    let mut variants: HashMap<&str, Vec<Value>> = HashMap::new();
    for item in &items {
        variants.entry(item.m.key.as_str()).or_default().push(json!({"path": item.m.prefab_path, "signature": parse_item_pet_signature(&item.content)}));
    }

    let mut merged: IndexMap<String, Value> = IndexMap::new();
    for item in &mounts {
        let key = &item.m.key;
        let parsed = item.parsed.as_ref().unwrap();
        let (name_key, desc_key) = extract_mount_localization_keys(&parsed.strings);
        let blueprint = resolve_blueprint_catalog_path(&choose_mount_blueprint(parsed), &blueprints);
        let identifier = format!("collections/mount/{}", key);
        let row = multipliers.get(&identifier);
        let (base_identifier, base) = infer_mastery_base(&identifier);
        let source = match row {
            Some(_) => "multiplier",
            None if base_identifier.starts_with(MOUNT_PREFIX) => "base",
            None => "unknown",
        };
        let designer = match extract_designer_from_blueprint(&blueprint) {
            d if d.is_empty() => "Trove Team".to_string(),
            d => d,
        };
        let record = json!({
            "name": resolve_mount_name_value(&parsed.strings, &language, &name_key),
            "desc": resolve_mount_description_value(&parsed.strings, &language, &desc_key),
            "category": categories.get(key).map(String::as_str).unwrap_or("Unknown"),
            "designer": designer,
            "filename": identifier,
            "blueprint": blueprint,
            "mastery": row.map_or(base, |r| r.predicted).to_string(),
            "mastery_base": base.to_string(),
            "mastery_source": source,
            "stats": parsed.extracted_stats.iter().map(|s| s.to_value()).collect::<Vec<_>>(),
            "tooltip": parsed.tooltip.replacen("<p>Ally</p>", "<p>Mount</p>", 1),
            "ability_paths": parsed.extracted_abilities,
            "movement_flags": movement_flags(parsed),
            "item_variants": variants.get(key.as_str()).cloned().unwrap_or_default(),
            "name_key": name_key,
            "desc_key": desc_key,
        });
        merged.insert(key.clone(), record);
    }
    merged.sort_unstable_keys();
    let merged: Map<String, Value> = merged.into_iter().collect();

    let count = |f: &dyn Fn(&Value) -> bool| merged.values().filter(|r| f(r)).count();
    let truthy = |v: &Value| crate::args::truthy(v);
    let mut manifest = Map::new();
    manifest.insert("game_path".into(), json!(py::path_str(game_path)));
    manifest.insert("mount_count".into(), json!(merged.len()));
    manifest.insert("collection_mount_prefabs".into(), json!(mount_matches.len()));
    manifest.insert("item_mount_prefabs".into(), json!(item_matches.len()));
    manifest.insert("decoded_names".into(), json!(count(&|r| truthy(&r["name"]))));
    manifest.insert("decoded_descriptions".into(), json!(count(&|r| truthy(&r["desc"]))));
    manifest.insert("decoded_mastery".into(), json!(count(&|r| r["mastery"] != "" && r["mastery"] != "0")));
    manifest.insert("base_mastery_fallbacks".into(), json!(count(&|r| r["mastery_source"] == "base")));
    manifest.insert("decoded_blueprints".into(), json!(count(&|r| truthy(&r["blueprint"]))));
    manifest.insert("decoded_categories".into(), json!(count(&|r| truthy(&r["category"]) && r["category"] != "Unknown")));
    manifest.insert("with_item_variants".into(), json!(count(&|r| truthy(&r["item_variants"]))));
    manifest.insert("with_stats".into(), json!(count(&|r| truthy(&r["stats"]))));
    Ok((merged, manifest))
}
