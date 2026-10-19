//! models/trove/prefab_style.py: the Style Codex (the `equipment/` appearance prefabs).

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::Result;
use rayon::prelude::*;
use serde_json::{json, Map, Value};

use super::binfab_reader::decode_identity;
use super::prefab_ally::{load_geode_multipliers_map, load_language_map, load_multipliers_map, read_files, resolve_localized_value, MultiplierMap, GameFiles, PrefabIndex};
use super::prefab_badge::{first_blueprint, identity_name_key};
use crate::py;
use crate::game::archive::IndexedFile;

pub const STYLE_PREFIX: &str = "equipment/";
const EQUIPMENT_APPEARANCE_BASE: i64 = 1;
const FAMILY_TOKENS: [(&str, &str); 16] = [
    ("banner", "Banner"),
    ("helm", "Hat"),
    ("hat", "Hat"),
    ("face", "Face"),
    ("hair", "Hair"),
    ("mask", "Face"),
    ("weapon", "Weapon"),
    ("sword", "Weapon"),
    ("staff", "Weapon"),
    ("bow", "Weapon"),
    ("gun", "Weapon"),
    ("pistol", "Weapon"),
    ("spear", "Weapon"),
    ("fist", "Weapon"),
    ("axe", "Weapon"),
    ("lance", "Weapon"),
];

/// The prefab stem: the style's stable equipment id.
pub fn equipment_id(rel: &str) -> String {
    let s = rel.replace('\\', "/");
    let last = s.rsplit('/').next().unwrap_or("");
    last.strip_suffix(".binfab").unwrap_or(last).to_string()
}

pub fn style_family(rel: &str) -> &'static str {
    let stem = equipment_id(rel).to_lowercase();
    FAMILY_TOKENS.iter().find(|(t, _)| stem.contains(t)).map_or("", |(_, l)| l)
}

fn multiplier_for(rel: &str, rows: &MultiplierMap) -> Option<i64> {
    let eid = equipment_id(rel);
    rows.get(&eid).or_else(|| rows.get(&format!("equipment_{}", eid))).map(|r| r.predicted)
}

pub fn build_styles_dataset(game_path: &Path, locale: &str) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let game = &GameFiles::open(game_path);
    let index = PrefabIndex::build(game)?;
    let language = load_language_map(game, locale)?;
    let multipliers = load_multipliers_map(game)?;
    let geode = load_geode_multipliers_map(game)?;

    let mut lookups: Vec<&str> = index.keys().filter(|k| k.starts_with(STYLE_PREFIX) && k.ends_with(".binfab")).collect();
    lookups.sort_unstable();
    let files: Vec<&IndexedFile> = lookups.iter().map(|k| index.get(k).unwrap()).collect();
    let rows: Vec<(String, Value)> = files
        .par_iter()
        .zip(read_files(&files)?)
        .map(|(&file, content)| {
            let identifier = file.full_path.strip_suffix(".binfab").unwrap_or(&file.full_path).to_string();
            let eid = equipment_id(&identifier);
            let identity = decode_identity(&content)?;
            let name_key = identity.as_ref().and_then(|i| i.name_key.clone()).unwrap_or_default();
            let desc_key = identity.as_ref().and_then(|i| i.desc_key.clone()).unwrap_or_default();
            let mut name = resolve_localized_value(&language, &name_key);
            if name.is_empty() {
                name = py::title(&eid.replace('_', " "));
            }
            let family = style_family(&identifier);
            let category = if family.is_empty() { identity.as_ref().and_then(|i| i.category.clone()).unwrap_or_default() } else { family.to_string() };
            let row = json!({
                "name": name,
                "desc": resolve_localized_value(&language, &desc_key),
                "category": category,
                "family": family,
                "equipment_ref": eid,
                "mastery": multiplier_for(&identifier, &multipliers).unwrap_or(EQUIPMENT_APPEARANCE_BASE),
                "mastery_geode": multiplier_for(&identifier, &geode),
                "blueprint": first_blueprint(&content),
                "filename": identifier,
                "name_key": identity_name_key(&identity),
            });
            Ok((identifier, row))
        })
        .collect::<Result<_>>()?;
    let rows: Map<String, Value> = rows.into_iter().collect();

    let families: BTreeSet<&str> = rows.values().filter_map(|r| r["family"].as_str()).filter(|s| !s.is_empty()).collect();
    let mut manifest = Map::new();
    manifest.insert("game_path".into(), json!(py::path_str_simple(game_path)));
    manifest.insert("style_count".into(), json!(rows.len()));
    manifest.insert("families".into(), json!(families));
    manifest.insert("decoded_names".into(), json!(rows.values().filter(|r| r["name"] != "").count()));
    manifest.insert("decoded_descriptions".into(), json!(rows.values().filter(|r| r["desc"] != "").count()));
    manifest.insert("with_geode".into(), json!(rows.values().filter(|r| r["mastery_geode"].as_i64().unwrap_or(0) != 0).count()));
    manifest.insert("total_mastery".into(), json!(rows.values().map(|r| r["mastery"].as_i64().unwrap_or(0)).sum::<i64>()));
    Ok((rows, manifest))
}
