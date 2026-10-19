//! models/trove/prefab_memento.py: the Memento Codex, including the Delve biome
//! matching that ties a biome memento to its `$DelveTier_*` name.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;
use serde_json::{json, Map, Value};

use super::binfab::{extract_strings, BinString};
use super::prefab_ally::{
    clean_localized_text, extract_designer_from_blueprint, find_prefabs, infer_mastery_base, load_blueprint_path_map, load_language_map, load_multiplier_file_map,
    load_prefabs, prefabs_index, require_prefabs_root, resolve_blueprint_catalog_path, resolve_localized_value, BlueprintMap, GameFiles, LanguageMap, MultiplierMap,
};
use crate::py;

pub const ITEM_UNLOCKER_PREFIX: &str = "item/unlocker/";
const DELVE_TIER_PREFIX: &str = "$DelveTier_";
const BLUEPRINT_PREFIXES: [&str; 3] = ["memento_biome_", "memento_mob_", "memento_boss_"];
const KEY_PREFIXES: [&str; 5] = [
    "$prefabs_item_unlocker_delve_path_",
    "$prefabs_item_unlocker_delve_boss_",
    "$prefabs_item_unlocker_delve_decor_",
    "$prefabs_npc_delve_path_",
    "$prefabs_npc_delve_boss_",
];

static NAME_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\$prefabs_[A-Za-z0-9_]+_name)").unwrap());
static DESC_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\$prefabs_[A-Za-z0-9_]+(?:_description|_desc))").unwrap());
static MEMENTO_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*Memento:\s*").unwrap());
static CAMEL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static NON_ALNUM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9]+").unwrap());

fn normalize_token(value: &str) -> String {
    value.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

fn extract_key_suffix(value: &str) -> String {
    let text = clean_localized_text(value);
    let text = py::strip(&text);
    let text = text.strip_suffix("_name").unwrap_or(text);
    let text = text.strip_suffix("_description").unwrap_or(text);
    let text = text.strip_suffix("_desc").unwrap_or(text);
    for prefix in KEY_PREFIXES {
        if let Some(rest) = text.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    text.trim_start_matches('$').to_string()
}

fn extract_identifier_suffix(identifier: &str) -> String {
    let normalized = py::strip(&identifier.replace('\\', "/")).to_string();
    for sub in ["delve/path/", "delve/boss/", "delve/decor/"] {
        if let Some(rest) = normalized.strip_prefix(&format!("{}{}", ITEM_UNLOCKER_PREFIX, sub)) {
            return rest.to_string();
        }
    }
    py::name_any_sep(&normalized).to_string()
}

fn extract_blueprint_suffix(raw_blueprint: &str) -> String {
    let s = raw_blueprint.replace('\\', "/");
    let stem = py::name_any_sep(s.strip_suffix(".blueprint").unwrap_or(&s));
    for prefix in BLUEPRINT_PREFIXES {
        if let Some(rest) = stem.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    stem.to_string()
}

fn split_words(value: &str) -> Vec<String> {
    let text = value.replace('\\', "/");
    let text = CAMEL_RE.replace_all(&text, "$1 $2");
    let text = NON_ALNUM_RE.replace_all(&text, " ");
    py::split_ws(&text)
        .map(normalize_token)
        .filter(|n| !n.is_empty() && !n.bytes().all(|b| b.is_ascii_digit()) && n.chars().count() >= 3)
        .collect()
}

#[derive(Default, Clone)]
struct Features {
    words: HashSet<String>,
    joined: HashSet<String>,
}

fn build_match_features(values: &[String]) -> Features {
    let mut f = Features::default();
    for v in values {
        let n = normalize_token(v);
        if !n.is_empty() {
            f.joined.insert(n);
        }
        f.words.extend(split_words(v));
    }
    f
}

fn strip_memento_prefix(name: &str) -> String {
    py::strip(&MEMENTO_PREFIX_RE.replace(name, "")).to_string()
}

fn build_source_values(identifier: &str, raw_blueprint: &str, name_key: &str, name: &str) -> Vec<String> {
    [extract_identifier_suffix(identifier), extract_blueprint_suffix(raw_blueprint), extract_key_suffix(name_key), strip_memento_prefix(name)]
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect()
}

/// One `$DelveTier_*` biome, with tokens learnt from the mementos matched to it.
struct TierProfile {
    biome_name: String,
    key: Features,
    name: Features,
    extra: Features,
}

impl TierProfile {
    fn other_words(&self) -> HashSet<&String> {
        self.name.words.union(&self.extra.words).collect()
    }
    fn other_joined(&self) -> HashSet<&String> {
        self.name.joined.union(&self.extra.joined).collect()
    }
}

fn build_tier_profiles(language: &LanguageMap) -> Vec<TierProfile> {
    language
        .iter()
        .filter(|(k, v)| !v.is_empty() && k.starts_with(DELVE_TIER_PREFIX))
        .map(|(k, v)| TierProfile {
            biome_name: v.clone(),
            key: build_match_features(&[k[DELVE_TIER_PREFIX.len()..].to_string()]),
            name: build_match_features(std::slice::from_ref(v)),
            extra: Features::default(),
        })
        .collect()
}

fn token_weights<'a>(sets: impl Iterator<Item = HashSet<&'a String>>) -> HashMap<&'a String, usize> {
    let mut counts: HashMap<&String, usize> = HashMap::new();
    for set in sets {
        for t in set {
            *counts.entry(t).or_default() += 1;
        }
    }
    counts.into_iter().map(|(t, c)| (t, (t.chars().count() * t.chars().count() / c).max(1))).collect()
}

fn match_tier_profile(profiles: &[TierProfile], values: &[String]) -> Option<usize> {
    let f = build_match_features(values);
    let kw = token_weights(profiles.iter().map(|p| p.key.words.iter().collect()));
    let kj = token_weights(profiles.iter().map(|p| p.key.joined.iter().collect()));
    let ow = token_weights(profiles.iter().map(|p| p.other_words()));
    let oj = token_weights(profiles.iter().map(|p| p.other_joined()));
    let weigh = |w: &HashMap<&String, usize>, shared: Vec<&String>| shared.iter().map(|t| w.get(t).copied().unwrap_or(1)).sum::<usize>();
    let mut best: Option<usize> = None;
    let mut best_score = (0usize, 0usize, 0usize, 0usize);
    for (i, p) in profiles.iter().enumerate() {
        let shared_kw: Vec<&String> = p.key.words.iter().filter(|t| f.words.contains(*t)).collect();
        let shared_kj: Vec<&String> = p.key.joined.iter().filter(|t| f.joined.contains(*t)).collect();
        let shared_ow: Vec<&String> = p.other_words().into_iter().filter(|t| f.words.contains(*t)).collect();
        let shared_oj: Vec<&String> = p.other_joined().into_iter().filter(|t| f.joined.contains(*t)).collect();
        let (n_kw, n_kj, n_ow) = (shared_kw.len(), shared_kj.len(), shared_ow.len());
        let mut prefix_bonus = 0;
        for sw in f.words.iter().filter(|w| w.chars().count() >= 4) {
            for pw in p.key.words.iter().filter(|w| w.chars().count() >= 4) {
                if sw.starts_with(pw.as_str()) || pw.starts_with(sw.as_str()) {
                    prefix_bonus += sw.chars().count().min(pw.chars().count());
                }
            }
        }
        let score = weigh(&kj, shared_kj) * 20 + weigh(&kw, shared_kw) * 10 + weigh(&oj, shared_oj) * 2 + weigh(&ow, shared_ow) + prefix_bonus;
        let tuple = (score, n_kw, n_kj, n_ow);
        if tuple > best_score {
            best_score = tuple;
            best = Some(i);
        }
    }
    best.filter(|_| best_score.0 > 0)
}

fn match_tier_by_biome_name(profiles: &[TierProfile], name: &str) -> Option<usize> {
    let wanted = normalize_token(&strip_memento_prefix(name));
    if wanted.is_empty() {
        return None;
    }
    profiles.iter().position(|p| normalize_token(&p.biome_name) == wanted)
}

fn enrich_tier_profile(profile: &mut TierProfile, values: &[String]) {
    let f = build_match_features(values);
    profile.extra.words.extend(f.words);
    profile.extra.joined.extend(f.joined);
}

fn build_memento_source(category: &str, name: &str, biome_name: &str) -> (&'static str, String) {
    match category {
        "DelveBiome" => ("Biome", if biome_name.is_empty() { strip_memento_prefix(name) } else { biome_name.to_string() }),
        "DelveBoss" => ("Boss", strip_memento_prefix(name)),
        "DelveCreature" => ("Creature", strip_memento_prefix(name)),
        _ => ("", String::new()),
    }
}

fn infer_memento_biome_name(identifier: &str, raw_blueprint: &str, name_key: &str, name: &str, category: &str, profiles: &[TierProfile]) -> String {
    if category == "DelveBiome" {
        if let Some(i) = match_tier_by_biome_name(profiles, name) {
            return profiles[i].biome_name.clone();
        }
    }
    let values = build_source_values(identifier, raw_blueprint, name_key, name);
    match_tier_profile(profiles, &values).map(|i| profiles[i].biome_name.clone()).unwrap_or_default()
}

/// `collection_memento.binfab`: unlocker identifier to its category.
pub fn load_collection_memento_category_map(game: &GameFiles) -> Result<HashMap<String, String>> {
    require_prefabs_root(game.path())?;
    let mut out = HashMap::new();
    let Some(content) = game.read_prefab("collections/collection_memento.binfab")? else { return Ok(out) };
    let strings: Vec<String> = extract_strings(&content).into_iter().map(|s| s.text).collect();
    let mut current = String::new();
    for (i, text) in strings.iter().enumerate() {
        if strings.get(i + 1).is_some_and(|n| n.starts_with("$CollectionName_")) {
            current = text.clone();
            continue;
        }
        let normalized = text.trim_start_matches('$');
        if normalized.starts_with(ITEM_UNLOCKER_PREFIX) && !current.is_empty() {
            out.insert(normalized.to_string(), current.clone());
        }
    }
    Ok(out)
}

pub fn load_memento_multipliers_map(game: &GameFiles) -> Result<MultiplierMap> {
    let mut rows = load_multiplier_file_map(game, "meta/multipliers.binfab", false)?;
    rows.retain(|k, _| k.starts_with(ITEM_UNLOCKER_PREFIX));
    Ok(rows)
}

pub fn extract_memento_localization_keys(strings: &[BinString]) -> (String, String) {
    let mut name_key = String::new();
    let mut desc_key = String::new();
    for item in strings {
        let cleaned = clean_localized_text(&item.text);
        let text = cleaned.trim_matches(|c| "#!@".contains(c));
        if name_key.is_empty() {
            if let Some(c) = NAME_KEY_RE.captures(text) {
                name_key = clean_localized_text(&c[1]);
            }
        }
        if desc_key.is_empty() {
            if let Some(c) = DESC_KEY_RE.captures(text) {
                desc_key = clean_localized_text(&c[1]);
            }
        }
        if !name_key.is_empty() && !desc_key.is_empty() {
            break;
        }
    }
    (name_key, desc_key)
}

pub fn choose_memento_blueprint(strings: &[BinString]) -> String {
    let mut candidates: Vec<String> = Vec::new();
    for entry in strings {
        let cleaned = clean_localized_text(&entry.text);
        let text = cleaned.trim_matches(|c| "#!@".contains(c)).trim_start_matches('$');
        let lowered = text.to_lowercase();
        if lowered.contains(".blueprint") {
            candidates.push(text.to_string());
        } else if lowered.contains("/mementos/") {
            candidates.push(if lowered.ends_with(".blueprint") { text.to_string() } else { format!("{}.blueprint", text) });
        }
    }
    candidates.sort_by_key(|v| (!v.to_lowercase().contains(".blueprint"), v.chars().count()));
    candidates.into_iter().next().unwrap_or_default()
}

struct Ctx<'a> {
    lookup: HashMap<String, &'a [BinString]>,
    blueprints: &'a BlueprintMap,
    language: &'a LanguageMap,
    multipliers: &'a MultiplierMap,
}

impl<'a> Ctx<'a> {
    fn strings(&self, identifier: &str) -> &'a [BinString] {
        self.lookup.get(identifier).or_else(|| self.lookup.get(&identifier.to_lowercase())).copied().unwrap_or(&[])
    }

    fn record(&self, identifier: &str, category: &str, profiles: &[TierProfile]) -> Map<String, Value> {
        let strings = self.strings(identifier);
        let (name_key, desc_key) = extract_memento_localization_keys(strings);
        let name = resolve_localized_value(self.language, &name_key);
        let desc = resolve_localized_value(self.language, &desc_key);
        let raw_blueprint = choose_memento_blueprint(strings);
        let mut blueprint = resolve_blueprint_catalog_path(&raw_blueprint, self.blueprints);
        if blueprint.is_empty() {
            blueprint = raw_blueprint.strip_suffix(".blueprint").unwrap_or(&raw_blueprint).to_string();
        }
        let biome_name = if category == "DelveBiome" { infer_memento_biome_name(identifier, &raw_blueprint, &name_key, &name, category, profiles) } else { String::new() };
        let (source_label, source_name) = build_memento_source(category, &name, &biome_name);
        let (_, base) = infer_mastery_base(identifier);
        let row = self.multipliers.get(identifier);
        let mastery = row.map_or(base, |r| r.predicted);
        let designer = match extract_designer_from_blueprint(&blueprint) {
            d if d.is_empty() => "Trove Team".to_string(),
            d => d,
        };
        let v = json!({
            "name": name,
            "desc": desc,
            "category": category,
            "designer": designer,
            "filename": identifier,
            "blueprint": blueprint,
            "biome_name": biome_name,
            "context_name": source_name,
            "source_label": source_label,
            "source_name": source_name,
            "mastery": mastery.to_string(),
            "mastery_base": base.to_string(),
            "mastery_source": if row.is_some() { "multiplier" } else { "base" },
            "name_key": name_key,
            "desc_key": desc_key,
            "stats": [],
            "ability_paths": [],
        });
        match v {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }
}

pub fn build_mementos_dataset(game_path: &Path, locale: &str) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let game = &GameFiles::open(game_path);
    let language = load_language_map(game, locale)?;
    let blueprints = load_blueprint_path_map(game)?;
    let categories = load_collection_memento_category_map(game)?;
    let multipliers = load_memento_multipliers_map(game)?;
    let index = prefabs_index(game)?;
    let identifier_of = |p: &str| p.strip_suffix(".binfab").unwrap_or(p).replace('\\', "/");
    let matches = find_prefabs(&index, ITEM_UNLOCKER_PREFIX, None, identifier_of);
    let loaded = load_prefabs(&matches, None)?;
    let strings: Vec<Vec<BinString>> = {
        use rayon::prelude::*;
        loaded.par_iter().map(|l| extract_strings(&l.content)).collect()
    };
    let mut lookup: HashMap<String, &[BinString]> = HashMap::new();
    for (l, s) in loaded.iter().zip(&strings) {
        lookup.insert(l.m.key.clone(), s);
    }
    for (l, s) in loaded.iter().zip(&strings) {
        lookup.insert(l.m.key.to_lowercase(), s);
    }
    let ctx = Ctx { lookup, blueprints: &blueprints, language: &language, multipliers: &multipliers };
    let mut profiles = build_tier_profiles(&language);

    let mut identifiers: Vec<(&String, &String)> = categories.iter().filter(|(_, c)| !matches!(c.as_str(), "InProgress" | "ReadyForGame" | "Hidden")).collect();
    identifiers.sort_unstable();

    let mut merged = Map::new();
    for &(identifier, category) in identifiers.iter().filter(|(_, c)| c.as_str() == "DelveBiome") {
        let raw_blueprint = choose_memento_blueprint(ctx.strings(identifier));
        let record = ctx.record(identifier, category, &profiles);
        let biome = record["biome_name"].as_str().unwrap_or("").to_string();
        if !biome.is_empty() {
            if let Some(i) = match_tier_by_biome_name(&profiles, &biome) {
                let values = build_source_values(identifier, &raw_blueprint, record["name_key"].as_str().unwrap_or(""), record["name"].as_str().unwrap_or(""));
                enrich_tier_profile(&mut profiles[i], &values);
            }
        }
        merged.insert(identifier.clone(), Value::Object(record));
    }
    for &(identifier, category) in identifiers.iter().filter(|(_, c)| c.as_str() != "DelveBiome") {
        merged.insert(identifier.clone(), Value::Object(ctx.record(identifier, category, &profiles)));
    }

    let count = |f: &dyn Fn(&Value) -> bool| merged.values().filter(|r| f(r)).count();
    let mut manifest = Map::new();
    manifest.insert("game_path".into(), json!(py::path_str_simple(game_path)));
    manifest.insert("memento_count".into(), json!(merged.len()));
    manifest.insert("collection_categories".into(), json!(categories.len()));
    manifest.insert("item_unlocker_prefabs".into(), json!(matches.len()));
    manifest.insert("decoded_names".into(), json!(count(&|r| r["name"] != "")));
    manifest.insert("decoded_descriptions".into(), json!(count(&|r| r["desc"] != "")));
    manifest.insert("decoded_blueprints".into(), json!(count(&|r| r["blueprint"] != "")));
    manifest.insert("decoded_mastery".into(), json!(count(&|r| r["mastery"] != "" && r["mastery"] != "0")));
    manifest.insert("decoded_categories".into(), json!(count(&|r| r["category"] != "" && r["category"] != "Unknown")));
    Ok((merged, manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_splitting() {
        assert_eq!(split_words("FrozenBay_deep2x 12 ab"), vec!["frozen", "bay", "deep2x"]);
        assert_eq!(extract_key_suffix("$prefabs_npc_delve_boss_kraken_name"), "kraken");
        assert_eq!(extract_identifier_suffix("item/unlocker/delve/path/memento_x"), "memento_x");
        assert_eq!(extract_blueprint_suffix("mementos/memento_biome_frost.blueprint"), "frost");
    }
}
