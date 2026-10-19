//! models/trove/prefab_badge.py: the Badge Codex.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use anyhow::Result;
use rayon::prelude::*;
use serde_json::{json, Map, Value};

use super::binfab_reader::{decode_identity, harvest_strings, parse_collection_table, Identity};
use super::prefab_ally::{infer_mastery_base, load_language_map, load_multipliers_map, read_files, resolve_localized_value, MultiplierMap, GameFiles, PrefabIndex};
use crate::py;
use crate::game::archive::IndexedFile;

pub const BADGE_PREFIX: &str = "collections/badge/";
const COLLECTION_TABLE_PATH: &str = "collections/collection_badge";
pub const TIER_ORDER: [&str; 7] = ["bronze", "silver", "gold", "platinum", "diamond", "obsidian", "trovium"];

/// `boxesopened_platinum` -> `("boxesopened", "Platinum")`.
pub fn split_group_tier(stem: &str) -> (String, String) {
    if let Some((group, tier)) = stem.rsplit_once('_') {
        if TIER_ORDER.contains(&tier) {
            return (group.to_string(), py::title(tier));
        }
    }
    (stem.to_string(), String::new())
}

pub fn load_badge_category_map(index: &PrefabIndex) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    if let Some((_, content)) = index.read_prefab_content(COLLECTION_TABLE_PATH)? {
        for group in parse_collection_table(&content) {
            for member in &group.members {
                out.entry(py::stem_any_sep(&member.replace('\\', "/")).to_string()).or_insert_with(|| group.id.clone());
            }
        }
    }
    Ok(out)
}

/// `(base, multiplier, mastery)`; a missing or zero multiplier counts as 1.
pub fn compute_badge_mastery(identifier: &str, multipliers: &MultiplierMap) -> (i64, i64, i64) {
    let (_, base) = infer_mastery_base(identifier);
    let mult = multipliers.get(identifier).map(|r| r.multiplier).filter(|&m| m != 0).unwrap_or(1);
    (base, mult, base * mult)
}

/// `identity.get("name_key", "")` where a missing identity reads as `{}`.
pub fn identity_name_key(identity: &Option<Identity>) -> Value {
    match identity {
        None => json!(""),
        Some(i) => json!(i.name_key),
    }
}

/// The first harvested string naming a `.blueprint`.
pub fn first_blueprint(content: &[u8]) -> String {
    harvest_strings(content, 2, 512).into_iter().map(|(_, _, s)| s).find(|s| s.ends_with(".blueprint")).unwrap_or_default()
}

/// Sorted by position in `order`, unknown last.
pub fn sort_by_order(values: HashSet<String>, order: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = values.into_iter().collect();
    v.sort();
    v.sort_by_key(|t| order.iter().position(|o| *o == t.to_lowercase()).unwrap_or(99));
    v
}

pub fn build_badges_dataset(game_path: &Path, locale: &str) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let game = &GameFiles::open(game_path);
    let index = PrefabIndex::build(game)?;
    let language = load_language_map(game, locale)?;
    let multipliers = load_multipliers_map(game)?;
    let categories = load_badge_category_map(&index)?;

    let mut lookups: Vec<&str> = index.keys().filter(|k| k.starts_with(BADGE_PREFIX) && k.ends_with(".binfab")).collect();
    lookups.sort_unstable();
    let files: Vec<&IndexedFile> = lookups.iter().map(|k| index.get(k).unwrap()).collect();
    let rows: Vec<(String, Value)> = files
        .par_iter()
        .zip(read_files(&files)?)
        .map(|(&file, content)| {
            let identifier = file.full_path.strip_suffix(".binfab").unwrap_or(&file.full_path).to_string();
            let stem = identifier.rsplit('/').next().unwrap_or("").to_string();
            let identity = decode_identity(&content)?;
            let name_key = identity.as_ref().and_then(|i| i.name_key.clone()).unwrap_or_default();
            let desc_key = identity.as_ref().and_then(|i| i.desc_key.clone()).unwrap_or_default();
            let mut name = resolve_localized_value(&language, &name_key);
            if name.is_empty() {
                name = py::title(&stem.replace('_', " "));
            }
            let (group, tier) = split_group_tier(&stem);
            let (base, mult, mastery) = compute_badge_mastery(&identifier, &multipliers);
            let row = json!({
                "name": name,
                "desc": resolve_localized_value(&language, &desc_key),
                "group": group,
                "tier": tier,
                "in_game_category": categories.get(&stem).cloned().unwrap_or_default(),
                "mastery": mastery,
                "base": base,
                "multiplier": mult,
                "blueprint": first_blueprint(&content),
                "filename": identifier,
                "name_key": identity_name_key(&identity),
            });
            Ok((identifier, row))
        })
        .collect::<Result<_>>()?;
    let rows: Map<String, Value> = rows.into_iter().collect();

    let str_set = |field: &str| -> HashSet<String> { rows.values().filter_map(|r| r[field].as_str()).filter(|s| !s.is_empty()).map(str::to_string).collect() };
    let categories_sorted: Vec<String> = str_set("in_game_category").into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    let groups: HashSet<&str> = rows.values().filter_map(|r| r["group"].as_str()).collect();
    let count = |f: &dyn Fn(&Value) -> bool| rows.values().filter(|r| f(r)).count();
    let mut manifest = Map::new();
    manifest.insert("game_path".into(), json!(py::path_str_simple(game_path)));
    manifest.insert("badge_count".into(), json!(rows.len()));
    manifest.insert("tiers".into(), json!(sort_by_order(str_set("tier"), &TIER_ORDER)));
    manifest.insert("in_game_categories".into(), json!(categories_sorted));
    manifest.insert("group_count".into(), json!(groups.len()));
    manifest.insert("decoded_names".into(), json!(count(&|r| r["name"] != "")));
    manifest.insert("decoded_descriptions".into(), json!(count(&|r| r["desc"] != "")));
    manifest.insert("with_mastery".into(), json!(count(&|r| r["mastery"].as_i64().unwrap_or(0) > 0)));
    manifest.insert("total_mastery".into(), json!(rows.values().map(|r| r["mastery"].as_i64().unwrap_or(0)).sum::<i64>()));
    Ok((rows, manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers() {
        assert_eq!(split_group_tier("boxesopened_platinum"), ("boxesopened".into(), "Platinum".into()));
        assert_eq!(split_group_tier("dragon_beard"), ("dragon_beard".into(), String::new()));
    }
}
