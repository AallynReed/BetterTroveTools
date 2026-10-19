//! models/trove/prefab_fish.py: the Fish Codex.

use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use anyhow::Result;
use indexmap::IndexMap;
use rayon::prelude::*;
use serde_json::{json, Map, Value};

use super::binfab_reader::{decode_identity, harvest_strings};
use super::prefab_ally::{load_language_map, read_files, resolve_localized_value, GameFiles, PrefabIndex};
use super::prefab_badge::{first_blueprint, identity_name_key, sort_by_order};
use crate::py;
use crate::game::archive::IndexedFile;

pub const FISH_PREFIX: &str = "item/fish/";
const CATALOGUE_PATH: &str = "fish/fish";
const WEIGHT_TABLE_PATH: &str = "meta/fishing/fishweightdata";
pub const RARITY_ORDER: [&str; 6] = ["common", "uncommon", "rare", "epic", "legendary", "relic"];

/// The description's leading rarity word, else the one in the filename.
pub fn rarity_from(filename: &str, desc: &str) -> String {
    let first = py::strip(desc).split(' ').next().unwrap_or("").to_lowercase();
    if RARITY_ORDER.contains(&first.as_str()) {
        return py::title(&first);
    }
    filename.to_lowercase().split('_').find(|t| RARITY_ORDER.contains(t)).map(py::title).unwrap_or_default()
}

pub fn source_from(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    let folder = if parts.len() > 3 { parts[2] } else { "" };
    match folder {
        "water" => "Water".into(),
        "lava" => "Lava".into(),
        "chocolate" => "Chocolate".into(),
        "plasma" => "Plasma".into(),
        "enchanted" => "Enchanted Water".into(),
        other => py::title(&other.replace('_', " ")),
    }
}

/// `fish/fish.binfab`: each fish's basic / silver / gold trophy placeables.
pub fn parse_fish_catalogue(index: &PrefabIndex) -> Result<IndexMap<String, Map<String, Value>>> {
    let mut out: IndexMap<String, Map<String, Value>> = IndexMap::new();
    let Some((_, content)) = index.read_prefab_content(CATALOGUE_PATH)? else { return Ok(out) };
    let mut current: Option<String> = None;
    for (_, field, text) in harvest_strings(&content, 2, 512) {
        if field == 0 && text.starts_with(FISH_PREFIX) {
            out.insert(text.clone(), Map::new());
            current = Some(text);
        } else if let Some(cur) = current.as_ref().filter(|c| !c.is_empty()) {
            if text.starts_with("placeable/deco/trophy") {
                let slot = match field {
                    1 => "basic",
                    2 => "silver",
                    3 => "gold",
                    _ => continue,
                };
                let row = out.get_mut(cur).unwrap();
                if !row.contains_key(slot) {
                    row.insert(slot.into(), json!(text));
                }
            }
        }
    }
    Ok(out)
}

/// `meta/fishing/fishweightdata`: `0x16 <f64 min> .. 0x26 <f64 max>` per rarity tier.
pub fn parse_fish_weight_tiers(index: &PrefabIndex) -> Result<Vec<(f64, f64)>> {
    let mut tiers = Vec::new();
    let Some((_, content)) = index.read_prefab_content(WEIGHT_TABLE_PATH)? else { return Ok(tiers) };
    let n = content.len();
    let f64_at = |p: usize| f64::from_le_bytes(content[p..p + 8].try_into().unwrap());
    let mut i = 0;
    while i + 9 < n {
        if content[i] == 0x16 {
            let wmin = f64_at(i + 1);
            let j = i + 9;
            let window = py::slice(&content, j, j + 4);
            if let Some(k) = window.iter().position(|&b| b == 0x26).map(|p| j + p) {
                if k + 9 <= n {
                    let wmax = f64_at(k + 1);
                    if (0.0..100000.0).contains(&wmin) && (0.0..100000.0).contains(&wmax) {
                        tiers.push((py::round_to(wmin, 3), py::round_to(wmax, 3)));
                    }
                    i = k + 9;
                    continue;
                }
            }
        }
        i += 1;
    }
    Ok(tiers)
}

pub fn build_fish_dataset(game_path: &Path, locale: &str) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let game = &GameFiles::open(game_path);
    let index = PrefabIndex::build(game)?;
    let language = load_language_map(game, locale)?;
    let catalogue = parse_fish_catalogue(&index)?;
    let weights = parse_fish_weight_tiers(&index)?;

    let mut lookups: Vec<&str> = index.keys().filter(|k| k.starts_with(FISH_PREFIX) && k.ends_with(".binfab")).collect();
    lookups.sort_unstable();
    let files: Vec<&IndexedFile> = lookups.iter().map(|k| index.get(k).unwrap()).collect();
    let rows: Vec<(String, Value)> = files
        .par_iter()
        .zip(read_files(&files)?)
        .map(|(&file, content)| {
            let identifier = file.full_path.strip_suffix(".binfab").unwrap_or(&file.full_path).to_string();
            let filename = identifier.rsplit('/').next().unwrap_or("").to_string();
            let identity = decode_identity(&content)?;
            let name_key = identity.as_ref().and_then(|i| i.name_key.clone()).unwrap_or_default();
            let desc_key = identity.as_ref().and_then(|i| i.desc_key.clone()).unwrap_or_default();
            let mut name = resolve_localized_value(&language, &name_key);
            if name.is_empty() {
                name = py::title(&filename.replace('_', " "));
            }
            let desc = resolve_localized_value(&language, &desc_key);
            let rarity = rarity_from(&filename, &desc);
            let weight = RARITY_ORDER.iter().position(|r| *r == rarity.to_lowercase()).and_then(|t| weights.get(t));
            let row = json!({
                "name": name,
                "desc": desc,
                "source": source_from(&identifier),
                "rarity": rarity,
                "blueprint": first_blueprint(&content),
                "tradable": identity.as_ref().and_then(|i| i.tradable),
                "filename": identifier,
                "weight_min": weight.map(|w| w.0),
                "weight_max": weight.map(|w| w.1),
                "trophies": catalogue.get(&identifier).cloned().unwrap_or_default(),
                "name_key": identity_name_key(&identity),
            });
            Ok((identifier, row))
        })
        .collect::<Result<_>>()?;
    let rows: Map<String, Value> = rows.into_iter().collect();

    let str_set = |field: &str| -> HashSet<String> { rows.values().filter_map(|r| r[field].as_str()).filter(|s| !s.is_empty()).map(str::to_string).collect() };
    let sources: Vec<String> = str_set("source").into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    let count = |f: &dyn Fn(&Value) -> bool| rows.values().filter(|r| f(r)).count();
    let truthy = |v: &Value| crate::args::truthy(v);
    let mut manifest = Map::new();
    manifest.insert("game_path".into(), json!(py::path_str_simple(game_path)));
    manifest.insert("fish_count".into(), json!(rows.len()));
    manifest.insert("sources".into(), json!(sources));
    manifest.insert("rarities".into(), json!(sort_by_order(str_set("rarity"), &RARITY_ORDER)));
    manifest.insert("decoded_names".into(), json!(count(&|r| truthy(&r["name"]))));
    manifest.insert("decoded_descriptions".into(), json!(count(&|r| truthy(&r["desc"]))));
    manifest.insert("with_blueprint".into(), json!(count(&|r| truthy(&r["blueprint"]))));
    manifest.insert("with_trophies".into(), json!(count(&|r| truthy(&r["trophies"]))));
    manifest.insert("with_weight".into(), json!(count(&|r| !r["weight_min"].is_null())));
    manifest.insert("weight_tiers".into(), Value::Array(weights.iter().map(|(a, b)| json!({"min": a, "max": b})).collect()));
    Ok((rows, manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fish_fields() {
        assert_eq!(rarity_from("fish_x_rare", "Uncommon fish"), "Uncommon");
        assert_eq!(rarity_from("fish_x_rare", "A fish"), "Rare");
        assert_eq!(source_from("item/fish/lava/x"), "Lava");
        assert_eq!(source_from("item/fish/deep_sea/x"), "Deep Sea");
        assert_eq!(source_from("item/fish/x"), "");
    }
}
