//! models/trove/prefab_item.py: the Item Codex.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use rayon::prelude::*;
use serde_json::{json, Map, Value};

use super::binfab_reader::decode_identity;
use super::prefab_ally::{load_blueprint_path_map, load_language_map, read_files, GameFiles, PrefabIndex};
use super::prefab_recipe::{extract_prefab_metadata, PrefabMetadata};
use crate::py;
use crate::game::archive::IndexedFile;

pub const ITEM_PREFIX: &str = "item/";
const COLLECTION_PREFIX: &str = "collections/";

pub fn category_from_item_path(identifier: &str) -> String {
    let normalized = py::strip(&identifier.replace('\\', "/")).to_lowercase();
    for (prefix, label) in [("item/pet/", "Ally"), ("item/mount/", "Mount"), ("item/unlocker/", "Unlocker"), ("item/companion/", "Companion")] {
        if normalized.starts_with(prefix) {
            return label.into();
        }
    }
    let parts: Vec<&str> = normalized.split('/').collect();
    if normalized.starts_with("item/consumable/") {
        if parts.len() >= 3 && !parts[2].is_empty() {
            return py::title(&parts[2].replace('_', " "));
        }
        return "Consumable".into();
    }
    if parts.len() >= 2 && !parts[1].is_empty() {
        return py::title(&parts[1].replace('_', " "));
    }
    "Item".into()
}

pub fn tradability_from_item_path(identifier: &str) -> &'static str {
    let normalized = py::strip(&identifier.replace('\\', "/")).to_lowercase();
    let stem = py::stem_any_sep(&normalized);
    if stem.ends_with("_notrade") {
        "Untradable"
    } else if stem.ends_with("_trade") {
        "Tradable"
    } else {
        ""
    }
}

/// Identity field 14, else the old `E0 01 <flag>` marker, else the filename convention.
pub fn tradability_from_item_content(content: &[u8], identifier: &str) -> Result<&'static str> {
    if let Some(t) = decode_identity(content)?.and_then(|i| i.tradable) {
        return Ok(if t { "Tradable" } else { "Untradable" });
    }
    if let Some(pos) = py::find(content, b"\xE0\x01", 0) {
        if pos + 2 < content.len() {
            return Ok(if content[pos + 2] == 0x02 { "Tradable" } else { "Untradable" });
        }
    }
    Ok(tradability_from_item_path(identifier))
}

pub fn extract_unlocks(strings: &[String], identifier: &str) -> Vec<String> {
    let ident = py::strip(&identifier.replace('\\', "/")).to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for text in strings {
        let normalized = py::strip(&text.replace('\\', "/")).to_string();
        let lowered = normalized.to_lowercase();
        if lowered.starts_with(COLLECTION_PREFIX) && lowered != ident && !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
}

fn unlock_title(normalized: &str) -> String {
    py::title(&py::stem_any_sep(normalized).replace('_', " "))
}

/// `str(path).replace("\\", "/").strip().removesuffix(".binfab")`.
fn normalize_unlock(path: &str) -> String {
    let s = py::strip(&path.replace('\\', "/")).to_string();
    s.strip_suffix(".binfab").map(str::to_string).unwrap_or(s)
}

struct ItemScan {
    identifier: String,
    meta: PrefabMetadata,
    unlocks: Vec<String>,
    tradability: &'static str,
    lootbox: bool,
    decay: bool,
}

pub fn build_items_dataset(game_path: &Path, locale: &str) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let game = &GameFiles::open(game_path);
    let index = PrefabIndex::build(game)?;
    let language = load_language_map(game, locale)?;
    let blueprints = load_blueprint_path_map(game)?;

    let mut lookups: Vec<&str> = index.keys().filter(|k| k.starts_with(ITEM_PREFIX) && k.ends_with(".binfab")).collect();
    lookups.sort_unstable();
    let files: Vec<&IndexedFile> = lookups.iter().map(|k| index.get(k).unwrap()).collect();
    let scans: Vec<ItemScan> = files
        .par_iter()
        .zip(read_files(&files)?)
        .map(|(&file, content)| {
            let identifier = file.full_path.strip_suffix(".binfab").unwrap_or(&file.full_path).to_string();
            let meta = extract_prefab_metadata(&identifier, &content, &language, &blueprints)?;
            let unlocks = extract_unlocks(&meta.strings, &identifier);
            Ok(ItemScan {
                tradability: tradability_from_item_content(&content, &identifier)?,
                lootbox: py::contains(&content, b"LootTable"),
                decay: py::contains(&content, b"quantitydecay"),
                identifier,
                meta,
                unlocks,
            })
        })
        .collect::<Result<_>>()?;

    // Each unlock's display name, worked out once per distinct spelling.
    let mut spellings: Vec<String> = scans.iter().flat_map(|s| s.unlocks.iter().map(|u| normalize_unlock(u))).filter(|u| !u.is_empty()).collect();
    spellings.sort_unstable();
    spellings.dedup();
    let targets: Vec<Option<&IndexedFile>> = spellings.iter().map(|u| index.get(&format!("{}.binfab", u).to_lowercase())).collect();
    let mut contents = read_files(&targets.iter().flatten().copied().collect::<Vec<_>>())?.into_iter();
    let contents: Vec<_> = targets.iter().map(|t| t.and_then(|_| contents.next())).collect();
    let names: HashMap<&str, String> = spellings
        .par_iter()
        .zip(contents)
        .map(|(u, content)| {
            let name = match content {
                Some(c) => extract_prefab_metadata(u, &c, &language, &blueprints)?.name,
                None => unlock_title(u),
            };
            Ok((u.as_str(), name))
        })
        .collect::<Result<_>>()?;

    let mut cache: HashMap<String, String> = HashMap::new();
    let mut rows = Map::new();
    let mut total_unlocks = 0;
    for scan in scans {
        let mut unlocks = Vec::new();
        for raw in &scan.unlocks {
            let normalized = normalize_unlock(raw);
            if normalized.is_empty() {
                continue;
            }
            let cached = cache.entry(normalized.to_lowercase()).or_insert_with(|| names[normalized.as_str()].clone());
            let name = if cached.is_empty() { unlock_title(&normalized) } else { cached.clone() };
            unlocks.push(json!({"path": normalized, "name": name}));
        }
        total_unlocks += unlocks.len();
        let m = scan.meta;
        let name = if m.name.is_empty() { py::title(&py::stem_any_sep(&scan.identifier).replace('_', " ")) } else { m.name };
        rows.insert(
            scan.identifier.clone(),
            json!({
                "name": name,
                "desc": m.desc,
                "category": category_from_item_path(&scan.identifier),
                "tradability": scan.tradability,
                "designer": m.designer,
                "filename": scan.identifier,
                "blueprint": m.blueprint,
                "name_key": m.name_key,
                "desc_key": m.desc_key,
                "lootbox": scan.lootbox,
                "decay": scan.decay,
                "unlocks": unlocks,
            }),
        );
    }

    let count = |f: &dyn Fn(&Value) -> bool| rows.values().filter(|r| f(r)).count();
    let truthy = |v: &Value| crate::args::truthy(v);
    let mut manifest = Map::new();
    manifest.insert("game_path".into(), json!(py::path_str_simple(game_path)));
    manifest.insert("item_count".into(), json!(rows.len()));
    manifest.insert("decoded_names".into(), json!(count(&|r| truthy(&r["name"]))));
    manifest.insert("decoded_descriptions".into(), json!(count(&|r| truthy(&r["desc"]))));
    manifest.insert("decoded_blueprints".into(), json!(count(&|r| truthy(&r["blueprint"]))));
    manifest.insert("with_unlocks".into(), json!(count(&|r| truthy(&r["unlocks"]))));
    manifest.insert("lootboxes".into(), json!(count(&|r| truthy(&r["lootbox"]))));
    manifest.insert("decay_items".into(), json!(count(&|r| truthy(&r["decay"]))));
    manifest.insert("with_tradability".into(), json!(count(&|r| truthy(&r["tradability"]))));
    manifest.insert("total_unlocks".into(), json!(total_unlocks));
    Ok((rows, manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_paths() {
        assert_eq!(category_from_item_path("item/consumable/gem_box/x"), "Gem Box");
        assert_eq!(category_from_item_path("item/pet/x"), "Ally");
        assert_eq!(category_from_item_path("item/x"), "X");
        assert_eq!(tradability_from_item_path("item/a/b_notrade"), "Untradable");
    }
}
