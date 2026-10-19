//! models/trove/prefab_recipe.py: prefab metadata (names, blueprints, unlocks) and the
//! Recipe Codex.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use indexmap::IndexMap;
use rayon::prelude::*;
use regex::Regex;
use serde_json::{json, Map, Value};

use super::binfab::{extract_strings, zig_zag_decode};
use super::binfab_reader::{decode_identity, harvest_strings, int_value};
use super::prefab_ally::{
    clean_localized_text, extract_designer_from_blueprint, load_blueprint_path_map, load_language_map, load_multipliers_map, read_files, read_varint,
    resolve_blueprint_catalog_path, resolve_localized_value, Blob, BlueprintMap, GameFiles, LanguageMap, MultiplierMap, PrefabIndex,
};
use crate::py;
use crate::game::archive::IndexedFile;

pub const RECIPE_PREFIX: &str = "recipes/";
pub const RECIPE_CATALOGUE_PATH: &str = "collections/collection_recipe";
const PATH_PREFIXES: [&str; 5] = ["item/", "placeable/", "block/", "collections/", "effects/"];

static NAME_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\$prefabs_[A-Za-z0-9_]+(?:_item)?_name)").unwrap());
static DESC_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\$prefabs_[A-Za-z0-9_]+(?:_item_)?(?:description|desc))").unwrap());
static RECIPE_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"recipe_[a-z0-9_]+").unwrap());
static PROVIDER_PATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(interact|profession)").unwrap());

pub fn looks_like_path(text: &str) -> bool {
    let lowered = py::strip(text).to_lowercase();
    !lowered.is_empty() && PATH_PREFIXES.iter().any(|p| lowered.starts_with(p))
}

pub fn normalize_recipe_string(text: &str) -> String {
    let cleaned = clean_localized_text(py::strip(text));
    py::strip(cleaned.trim_end_matches('(').trim_matches('"').trim_matches('\'')).to_string()
}

pub fn pretty_name_from_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut stem = py::stem_any_sep(&normalized);
    for suffix in ["_notrade", "_trade"] {
        if let Some(s) = stem.strip_suffix(suffix) {
            stem = s;
            break;
        }
    }
    py::title(py::strip(&stem.replace('_', " ")))
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuantifiedPath {
    pub path: String,
    pub amount_raw: u128,
    pub amount: i128,
    pub offset: usize,
    pub end: usize,
}

impl QuantifiedPath {
    pub fn to_value(&self) -> Value {
        json!({
            "path": self.path,
            "amount_raw": int_value(self.amount_raw as i128),
            "amount": int_value(self.amount),
            "offset": self.offset,
            "end": self.end,
        })
    }
}

/// `08 <len> <path> 10 <zig-zag amount>` runs: a recipe's ingredients and output.
pub fn decode_quantified_recipe_paths(content: &[u8]) -> Vec<QuantifiedPath> {
    let mut rows = Vec::new();
    let n = content.len();
    let mut pos = 0;
    while pos + 3 < n {
        if content[pos] != 0x08 {
            pos += 1;
            continue;
        }
        let Some((length, cursor)) = read_varint(content, pos + 1) else {
            pos += 1;
            continue;
        };
        if length == 0 || cursor as u128 + length > n as u128 {
            pos += 1;
            continue;
        }
        let next = cursor + length as usize;
        let raw = &content[cursor..next];
        if raw.iter().any(|&b| !(32..=126).contains(&b)) {
            pos += 1;
            continue;
        }
        let text = normalize_recipe_string(&py::latin1(raw));
        if !looks_like_path(&text) {
            pos += 1;
            continue;
        }
        if next >= n || content[next] != 0x10 {
            pos = next;
            continue;
        }
        let Some((amount_raw, end)) = read_varint(content, next + 1) else {
            pos += 1;
            continue;
        };
        rows.push(QuantifiedPath { path: text, amount_raw, amount: zig_zag_decode(amount_raw as i128), offset: pos, end });
        pos = end;
    }
    rows
}

/// `30 <00|02> 50 <mastery> 70 <byte> 80 01 <byte> 98 01` at `pos`.
pub fn match_recipe_mastery_struct(content: &[u8], pos: usize) -> Option<u128> {
    let n = content.len();
    if pos >= n || content[pos] != 0x30 {
        return None;
    }
    let (v6, cur) = read_varint(content, pos + 1)?;
    if v6 != 0 && v6 != 2 {
        return None;
    }
    if cur >= n || content[cur] != 0x50 {
        return None;
    }
    let (mastery, cur) = read_varint(content, cur + 1)?;
    if cur >= n || content[cur] != 0x70 {
        return None;
    }
    let (_, cur) = read_varint(content, cur + 1)?;
    if cur + 1 >= n || content[cur] != 0x80 || content[cur + 1] != 0x01 {
        return None;
    }
    let (_, cur) = read_varint(content, cur + 2)?;
    if cur + 1 >= n || content[cur] != 0x98 || content[cur + 1] != 0x01 {
        return None;
    }
    Some(mastery)
}

/// The recipe-mastery byte when every structural match agrees.
pub fn recipe_mastery_from_prefab(content: &[u8]) -> Option<u128> {
    let matches: Vec<u128> = (0..content.len()).filter(|&p| content[p] == 0x30).filter_map(|p| match_recipe_mastery_struct(content, p)).collect();
    let first = *matches.first()?;
    matches.iter().all(|&m| m == first).then_some(first)
}

#[derive(Debug, Clone, PartialEq)]
pub struct MasteryInfo {
    pub value: Option<i128>,
    pub source: &'static str,
    pub prefab_byte: Option<u128>,
}

/// A multipliers row overrides, then the structural prefab byte, else review-only.
pub fn resolve_recipe_mastery(recipe_id: &str, content: &[u8], multipliers: &MultiplierMap) -> MasteryInfo {
    let prefab_byte = recipe_mastery_from_prefab(content);
    let normalized = recipe_id.replace('\\', "/");
    let stem = normalized.rsplit('/').next().unwrap_or("");
    if let Some(row) = multipliers.get(stem) {
        return MasteryInfo { value: Some(row.predicted as i128), source: "multipliers", prefab_byte };
    }
    if let Some(b) = prefab_byte {
        return MasteryInfo { value: Some(b as i128), source: "prefab", prefab_byte };
    }
    MasteryInfo { value: None, source: "review", prefab_byte: None }
}

pub fn split_recipe_sections(strings: &[String]) -> (Vec<String>, Vec<String>) {
    let normalized: Vec<String> = strings.iter().map(|s| normalize_recipe_string(s)).collect();
    let nulls: Vec<usize> = normalized.iter().enumerate().filter(|(_, t)| t.to_lowercase() == "null").map(|(i, _)| i).collect();
    match nulls.len() {
        0 => (normalized, Vec::new()),
        1 => (normalized[..nulls[0]].to_vec(), normalized[nulls[0] + 1..].to_vec()),
        _ => (normalized[..nulls[0]].to_vec(), normalized[nulls[1] + 1..].to_vec()),
    }
}

pub fn is_material_path(path: &str) -> bool {
    let lowered = path.to_lowercase();
    lowered.starts_with("item/crafting/") || lowered.starts_with("item/currency/") || lowered.starts_with("item/dragon/")
}

pub fn is_output_candidate(path: &str) -> bool {
    let lowered = path.to_lowercase();
    if lowered.is_empty() || lowered.starts_with("effects/") || lowered.starts_with("collections/") {
        return false;
    }
    lowered.starts_with("item/") || lowered.starts_with("placeable/") || lowered.starts_with("block/")
}

pub fn choose_recipe_output(strings: &[String]) -> String {
    let (head, tail) = split_recipe_sections(strings);
    for section in [&tail, &head] {
        if let Some(t) = section.iter().find(|t| is_output_candidate(t) && !is_material_path(t)) {
            return t.clone();
        }
    }
    tail.iter().chain(&head).find(|t| t.starts_with("collections/")).cloned().unwrap_or_default()
}

pub fn derive_output_amount(output_path: &str, quantified: &[QuantifiedPath]) -> i128 {
    let output_path = normalize_recipe_string(output_path);
    for row in quantified.iter().rev() {
        if normalize_recipe_string(&row.path) == output_path {
            if row.amount > 0 {
                return row.amount;
            }
            break;
        }
    }
    1
}

pub fn decode_requirements(strings: &[String], ingredient_paths: &HashSet<String>, output_path: &str) -> Vec<String> {
    let normalized: Vec<String> = strings.iter().map(|s| normalize_recipe_string(s)).collect();
    let output_path = normalize_recipe_string(output_path);
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !out.contains(&s) {
            out.push(s);
        }
    };
    for (i, text) in normalized.iter().enumerate() {
        let lowered = text.to_lowercase();
        if text.is_empty() || lowered == "null" {
            continue;
        }
        if ingredient_paths.contains(text) || *text == output_path || looks_like_path(text) || lowered.starts_with("$prefabs_") {
            continue;
        }
        if lowered == "zonetag" && i + 1 < normalized.len() {
            let zone = &normalized[i + 1];
            if !zone.is_empty() && zone.to_lowercase() != "zonetag" {
                push(format!("Zone: {}", zone));
            }
            continue;
        }
        let label = match lowered.as_str() {
            "activeclass" => "Active Class",
            "powerrank" => "Power Rank",
            "hascollection" => "Requires Collection",
            "hastitle" => "Requires Title",
            _ => continue,
        };
        push(label.to_string());
    }
    out
}

/// Sorts like `key=(".blueprint" not in lowered, len)`, stable.
fn shortest_blueprint_first(candidates: &mut [String]) {
    candidates.sort_by_key(|v| (!v.to_lowercase().contains(".blueprint"), v.chars().count()));
}

pub fn choose_blueprint_from_strings(strings: &[String]) -> String {
    let mut candidates: Vec<String> = strings
        .iter()
        .filter(|t| {
            let l = t.to_lowercase();
            !l.ends_with(".pkfx") && (l.ends_with(".blueprint") || l.starts_with("c_mt_") || l.starts_with("c_c_") || l.contains("/ui"))
        })
        .cloned()
        .collect();
    shortest_blueprint_first(&mut candidates);
    candidates.into_iter().next().unwrap_or_default()
}

pub fn heuristic_blueprint_from_content(prefab_path: &str, content: &[u8]) -> String {
    if let Some(bp) = py::rfind(content, b".blueprint") {
        if let Some(start) = content[..bp].iter().rposition(|&b| b == 0x08) {
            if start + 2 < content.len() {
                let length = content[start + 1] as usize;
                let text = py::strip(&py::ascii_ignore(py::slice(content, start + 2, start + 2 + length))).to_string();
                if text.to_lowercase().ends_with(".blueprint") {
                    return text;
                }
            }
        }
    }
    if prefab_path.to_lowercase().contains("placeable/") {
        let stem = py::stem_any_sep(&prefab_path.replace('\\', "/")).to_string();
        if !stem.is_empty() {
            return stem;
        }
    }
    String::new()
}

/// `extract_prefab_metadata`: what the codexes show for any prefab.
#[derive(Debug, Clone, PartialEq)]
pub struct PrefabMetadata {
    pub name: String,
    pub desc: String,
    pub blueprint: String,
    pub blueprint_source: &'static str,
    pub designer: String,
    pub name_key: String,
    pub desc_key: String,
    pub display_category: String,
    pub tradable: Option<bool>,
    pub strings: Vec<String>,
}

pub fn extract_prefab_metadata(prefab_path: &str, content: &[u8], language: &LanguageMap, blueprints: &BlueprintMap) -> Result<PrefabMetadata> {
    let strings: Vec<String> = extract_strings(content).iter().map(|s| normalize_recipe_string(&s.text)).filter(|s| !s.is_empty()).collect();
    let identity = decode_identity(content)?;
    let (mut name_key, mut desc_key, mut literal_name) = (String::new(), String::new(), String::new());
    let (mut display_category, mut tradable) = (String::new(), None);
    if let Some(id) = &identity {
        display_category = id.category.clone().unwrap_or_default();
        tradable = id.tradable;
        let gname = id.name_key.as_deref().unwrap_or("");
        let gdesc = id.desc_key.as_deref().unwrap_or("");
        if gname.starts_with('$') {
            name_key = clean_localized_text(gname);
        } else if !gname.is_empty() {
            literal_name = gname.to_string();
        }
        if gdesc.starts_with('$') {
            desc_key = clean_localized_text(gdesc);
        }
    }
    for text in &strings {
        if !name_key.is_empty() && !desc_key.is_empty() {
            break;
        }
        if name_key.is_empty() && literal_name.is_empty() {
            if let Some(c) = NAME_KEY_RE.captures(text) {
                name_key = clean_localized_text(&c[1]);
            }
        }
        if desc_key.is_empty() {
            if let Some(c) = DESC_KEY_RE.captures(text) {
                desc_key = clean_localized_text(&c[1]);
            }
        }
    }
    let mut blueprint = choose_blueprint_from_strings(&strings);
    let mut source = if blueprint.is_empty() { "" } else { "decoded" };
    if blueprint.is_empty() {
        blueprint = heuristic_blueprint_from_content(prefab_path, content);
        source = if blueprint.is_empty() { "" } else { "heuristic" };
    }
    if blueprint.is_empty() {
        blueprint = py::stem_any_sep(&prefab_path.replace('\\', "/")).to_string();
        source = "fallback";
    }
    let resolved = resolve_blueprint_catalog_path(&blueprint, blueprints);
    let mut name = resolve_localized_value(language, &name_key);
    if name.is_empty() {
        name = if literal_name.is_empty() { pretty_name_from_path(prefab_path) } else { literal_name };
    }
    let designer = match extract_designer_from_blueprint(&resolved) {
        d if d.is_empty() => "Trove Team".to_string(),
        d => d,
    };
    Ok(PrefabMetadata {
        name,
        desc: resolve_localized_value(language, &desc_key),
        blueprint: resolved,
        blueprint_source: source,
        designer,
        name_key,
        desc_key,
        display_category,
        tradable,
        strings,
    })
}

pub fn extract_prefab_unlocks(strings: &[String], identifier: &str) -> Vec<String> {
    let ident = py::strip(&identifier.replace('\\', "/")).to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for text in strings {
        let normalized = normalize_recipe_string(text).replace('\\', "/");
        let lowered = normalized.to_lowercase();
        if lowered.starts_with("collections/") && lowered != ident && !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
}

pub fn category_from_output(recipe_path: &str, output_path: &str) -> String {
    let lowered_output = output_path.to_lowercase();
    const MAPPING: [(&str, &str); 11] = [
        ("item/mount/", "Mount"),
        ("item/pet/", "Ally"),
        ("collections/pet/", "Ally"),
        ("item/unlocker/", "Memento"),
        ("item/plantseed/", "Seed"),
        ("item/consumable/titles/", "Title"),
        ("placeable/", "Placeable"),
        ("block/", "Block"),
        ("item/lootbox/newrings/", "Ring"),
        ("item/consumable/gearcrafting/", "Gear"),
        ("item/costume/", "Costume"),
    ];
    if let Some((_, label)) = MAPPING.iter().find(|(p, _)| lowered_output.starts_with(p)) {
        return label.to_string();
    }
    let lowered_recipe = recipe_path.to_lowercase();
    let stem = py::stem_any_sep(&lowered_recipe);
    let stem = stem.strip_prefix("recipe_").unwrap_or(stem);
    if !stem.is_empty() {
        return py::title(stem.split('_').next().unwrap_or(""));
    }
    "Recipe".into()
}

/// A recipe's place in `collection_recipe.binfab`.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogueEntry {
    pub order: usize,
    pub duplicate: bool,
}

impl CatalogueEntry {
    pub fn to_value(&self) -> Value {
        let mut v = json!({"order": self.order, "in_catalogue": true});
        if self.duplicate {
            v["duplicate"] = json!(true);
        }
        v
    }
}

/// Known recipe ids among a prefab's `recipe_*` tokens, each trimmed to the longest id.
fn recipe_tokens<'a>(content: &[u8], known_ids: &'a HashSet<String>) -> Vec<&'a str> {
    let mut out = Vec::new();
    for (_, _, text) in harvest_strings(content, 2, 512) {
        let lowered = text.to_lowercase();
        for m in RECIPE_TOKEN_RE.find_iter(&lowered) {
            let mut tok = m.as_str();
            while !tok.is_empty() && !known_ids.contains(tok) {
                tok = &tok[..tok.len() - 1];
            }
            if let Some(id) = known_ids.get(tok) {
                out.push(id.as_str());
            }
        }
    }
    out
}

pub fn parse_recipe_catalogue(content: &[u8], known_ids: &HashSet<String>) -> IndexMap<String, CatalogueEntry> {
    let mut out: IndexMap<String, CatalogueEntry> = IndexMap::new();
    for tok in recipe_tokens(content, known_ids) {
        let order = out.len();
        out.entry(tok.to_string()).and_modify(|e| e.duplicate = true).or_insert(CatalogueEntry { order, duplicate: false });
    }
    out
}

pub fn provider_lane_for(path: &str) -> &'static str {
    let l = path.to_lowercase();
    if l.contains("profession") {
        "profession"
    } else if l.contains("workbench") || l.contains("/crafting/") || l.contains("forge") {
        "bench"
    } else if l.contains("vendor") {
        "vendor"
    } else if l.contains("guideui") {
        "guide"
    } else if l.contains("interact") {
        "interactive"
    } else {
        "other"
    }
}

pub fn provider_id_from_path(path: &str) -> String {
    let text = path.replace('\\', "/");
    let text = text.strip_prefix("prefabs/").unwrap_or(&text);
    text.strip_suffix(".binfab").unwrap_or(text).to_string()
}

pub fn extract_provider_refs(content: &[u8], known_ids: &HashSet<String>) -> Vec<String> {
    let mut seen: IndexMap<&str, ()> = IndexMap::new();
    for tok in recipe_tokens(content, known_ids) {
        seen.entry(tok).or_insert(());
    }
    seen.into_keys().map(str::to_string).collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRow {
    pub provider: String,
    pub provider_path: String,
    pub lane: &'static str,
}

impl ProviderRow {
    pub fn to_value(&self) -> Value {
        json!({"provider": self.provider, "provider_path": self.provider_path, "lane": self.lane})
    }
}

pub fn known_recipe_ids(index: &PrefabIndex) -> HashSet<String> {
    index
        .keys()
        .filter(|k| k.starts_with(RECIPE_PREFIX) && k.ends_with(".binfab"))
        .map(|k| {
            let last = k.rsplit('/').next().unwrap_or("");
            last.strip_suffix(".binfab").unwrap_or(last).to_lowercase()
        })
        .collect()
}

pub fn load_recipe_catalogue(index: &PrefabIndex, known_ids: &HashSet<String>) -> Result<IndexMap<String, CatalogueEntry>> {
    Ok(match index.read_prefab_content(RECIPE_CATALOGUE_PATH)? {
        Some((_, content)) => parse_recipe_catalogue(&content, known_ids),
        None => IndexMap::new(),
    })
}

/// `recipe_id -> providers`: the crafting stations and professions that list it.
pub fn build_recipe_provider_map(index: &PrefabIndex) -> Result<HashMap<String, Vec<ProviderRow>>> {
    let known_ids = known_recipe_ids(index);
    let candidates: Vec<&IndexedFile> = index.iter().filter(|(k, _)| k.ends_with(".binfab") && PROVIDER_PATH_RE.is_match(k)).map(|(_, f)| f).collect();
    let refs: Vec<Vec<String>> = read_files(&candidates)?.par_iter().map(|c| extract_provider_refs(c, &known_ids)).collect();
    let mut providers: HashMap<String, Vec<ProviderRow>> = HashMap::new();
    for (f, refs) in candidates.iter().zip(refs) {
        if refs.is_empty() {
            continue;
        }
        let provider = provider_id_from_path(&f.full_path);
        let lane = provider_lane_for(&f.full_path);
        for recipe_id in refs {
            let rows = providers.entry(recipe_id).or_default();
            if !rows.iter().any(|r| r.provider == provider) {
                rows.push(ProviderRow { provider: provider.clone(), provider_path: f.full_path.clone(), lane });
            }
        }
    }
    Ok(providers)
}

/// One `item_meta_cache` entry: a field is `None` where the Python dict lacked the key.
#[derive(Debug, Clone, Default)]
struct MetaEntry {
    name: Option<String>,
    desc: Option<String>,
    blueprint: Option<String>,
    blueprint_source: Option<&'static str>,
    designer: Option<String>,
    lootbox: Option<bool>,
    decay: Option<bool>,
    unlocks: Option<usize>,
}

impl MetaEntry {
    fn from_meta(m: &PrefabMetadata) -> Self {
        MetaEntry {
            name: Some(m.name.clone()),
            desc: Some(m.desc.clone()),
            blueprint: Some(m.blueprint.clone()),
            blueprint_source: Some(m.blueprint_source),
            designer: Some(m.designer.clone()),
            ..Default::default()
        }
    }
}

/// What a referenced prefab resolves to: its metadata and the LootTable / decay markers.
type Resolved = Option<(PrefabMetadata, bool, bool)>;

/// [`PrefabIndex::read_prefab_content`] for each path, then its metadata (in parallel).
fn resolve_referenced<'a>(index: &PrefabIndex, paths: &'a [String], language: &LanguageMap, blueprints: &BlueprintMap) -> Result<HashMap<&'a str, Resolved>> {
    let targets: Vec<Option<&IndexedFile>> = paths.iter().map(|p| index.lookup_prefab(p)).collect();
    let mut contents = read_files(&targets.iter().flatten().copied().collect::<Vec<_>>())?.into_iter();
    let contents: Vec<Option<Blob>> = targets.iter().map(|t| t.and_then(|_| contents.next())).collect();
    paths
        .par_iter()
        .zip(targets)
        .zip(contents)
        .map(|((path, target), content)| {
            let resolved = match (target, content) {
                (Some(f), Some(c)) => {
                    let meta = extract_prefab_metadata(&f.full_path, &c, language, blueprints)?;
                    Some((meta, py::contains(&c, b"LootTable"), py::contains(&c, b"quantitydecay")))
                }
                _ => None,
            };
            Ok((path.as_str(), resolved))
        })
        .collect()
}

struct RecipeScan<'a> {
    file: &'a IndexedFile,
    content: Blob,
    strings: Vec<String>,
    quantified: Vec<QuantifiedPath>,
    output_path: String,
}

pub fn build_recipes_dataset(game_path: &Path, locale: &str) -> Result<(Map<String, Value>, Map<String, Value>)> {
    let game = &GameFiles::open(game_path);
    let index = PrefabIndex::build(game)?;
    let language = load_language_map(game, locale)?;
    let blueprints = load_blueprint_path_map(game)?;
    let multipliers = load_multipliers_map(game)?;
    let known_ids = known_recipe_ids(&index);
    let catalogue = load_recipe_catalogue(&index, &known_ids)?;
    let providers = build_recipe_provider_map(&index)?;

    let mut lookups: Vec<&str> = index.keys().filter(|k| k.starts_with(RECIPE_PREFIX) && k.ends_with(".binfab")).collect();
    lookups.sort_unstable();
    let files: Vec<&IndexedFile> = lookups.iter().map(|k| index.get(k).unwrap()).collect();
    let scans: Vec<RecipeScan> = files
        .par_iter()
        .zip(read_files(&files)?)
        .map(|(&file, content)| {
            let strings: Vec<String> = extract_strings(&content).iter().map(|s| normalize_recipe_string(&s.text)).collect();
            let quantified = decode_quantified_recipe_paths(&content);
            let output_path = choose_recipe_output(&strings);
            Ok(RecipeScan { file, content, strings, quantified, output_path })
        })
        .collect::<Result<_>>()?;

    // Every prefab a recipe names, resolved once up front; the cache below decides use.
    let normalized_output = |s: &RecipeScan| s.output_path.strip_suffix(".binfab").unwrap_or(&s.output_path).to_string();
    let mut referenced: Vec<String> = Vec::new();
    for s in &scans {
        referenced.push(normalized_output(s));
        referenced.extend(s.quantified.iter().map(|q| normalize_recipe_string(&q.path)));
    }
    referenced.sort_unstable();
    referenced.dedup();
    referenced.retain(|r| !r.is_empty());
    let resolved = resolve_referenced(&index, &referenced, &language, &blueprints)?;

    let mut cache: HashMap<String, MetaEntry> = HashMap::new();
    let mut rows = Map::new();
    let (mut decoded_outputs, mut heuristic_bp, mut decoded_bp, mut total_ingredients) = (0, 0, 0, 0);
    for scan in &scans {
        let output = normalized_output(scan);
        if !scan.output_path.is_empty() {
            decoded_outputs += 1;
        }
        let fallback_path = if scan.output_path.is_empty() { scan.file.full_path.as_str() } else { scan.output_path.as_str() };
        let default_meta = || MetaEntry {
            name: Some(pretty_name_from_path(fallback_path)),
            desc: Some(String::new()),
            blueprint: Some(py::stem_any_sep(fallback_path).to_string()),
            blueprint_source: Some("fallback"),
            designer: Some("Trove Team".into()),
            lootbox: Some(false),
            decay: Some(false),
            unlocks: Some(0),
        };
        let output_meta = if output.is_empty() {
            default_meta()
        } else {
            cache
                .entry(output.to_lowercase())
                .or_insert_with(|| match &resolved[output.as_str()] {
                    Some((meta, loot, decay)) => MetaEntry {
                        lootbox: Some(*loot),
                        decay: Some(*decay),
                        unlocks: Some(extract_prefab_unlocks(&meta.strings, &output).len()),
                        ..MetaEntry::from_meta(meta)
                    },
                    None => default_meta(),
                })
                .clone()
        };
        match output_meta.blueprint_source {
            Some("decoded") => decoded_bp += 1,
            Some("heuristic") => heuristic_bp += 1,
            _ => {}
        }

        let mut ingredient_paths = HashSet::new();
        let mut ingredients = Vec::new();
        for row in &scan.quantified {
            let path = normalize_recipe_string(&row.path);
            if path.is_empty() || path == output || path.starts_with("collections/") {
                continue;
            }
            ingredient_paths.insert(path.clone());
            let fallback = pretty_name_from_path(&path);
            let cached = cache.entry(path.to_lowercase()).or_insert_with(|| match &resolved[path.as_str()] {
                Some((meta, _, _)) => MetaEntry::from_meta(meta),
                None => MetaEntry { name: Some(fallback.clone()), ..Default::default() },
            });
            let name = cached.name.clone().filter(|n| !n.is_empty()).unwrap_or(fallback);
            ingredients.push(json!({
                "path": path,
                "amount": int_value(row.amount),
                "raw_amount": int_value(row.amount_raw as i128),
                "name": name,
            }));
        }
        total_ingredients += ingredients.len();

        let recipe_id = scan.file.full_path.strip_suffix(".binfab").unwrap_or(&scan.file.full_path).to_string();
        let mastery = resolve_recipe_mastery(&recipe_id, &scan.content, &multipliers);
        let stem = recipe_id.replace('\\', "/").rsplit('/').next().unwrap_or("").to_lowercase();
        let catalogue_info = catalogue.get(&stem);
        let provider_rows: Vec<Value> = providers.get(&stem).map(|rows| rows.iter().map(ProviderRow::to_value).collect()).unwrap_or_default();
        let name = output_meta.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| pretty_name_from_path(&recipe_id));
        rows.insert(
            recipe_id.clone(),
            json!({
                "name": name,
                "desc": output_meta.desc.clone().unwrap_or_default(),
                "category": category_from_output(&recipe_id, &output),
                "designer": output_meta.designer.clone().unwrap_or_else(|| "Trove Team".into()),
                "filename": recipe_id,
                "mastery": mastery.value.map(int_value),
                "mastery_source": mastery.source,
                "mastery_prefab_byte": mastery.prefab_byte.map(|b| int_value(b as i128)),
                "blueprint": output_meta.blueprint.clone().unwrap_or_default(),
                "lootbox": output_meta.lootbox.unwrap_or(false),
                "decay": output_meta.decay.unwrap_or(false),
                "unlock_count": output_meta.unlocks.unwrap_or(0),
                "output_path": output,
                "output_amount": int_value(derive_output_amount(&output, &scan.quantified)),
                "ingredients": ingredients,
                "requirements": decode_requirements(&scan.strings, &ingredient_paths, &output),
                "raw_string_count": scan.strings.len(),
                "in_catalogue": catalogue_info.is_some(),
                "catalogue": catalogue_info.map(CatalogueEntry::to_value),
                "providers": provider_rows,
            }),
        );
    }

    let count = |f: &dyn Fn(&Value) -> bool| rows.values().filter(|r| f(r)).count();
    let truthy = |v: &Value| crate::args::truthy(v);
    let mut manifest = Map::new();
    manifest.insert("game_path".into(), json!(py::path_str_simple(game_path)));
    manifest.insert("recipe_count".into(), json!(rows.len()));
    manifest.insert("decoded_outputs".into(), json!(decoded_outputs));
    manifest.insert("resolved_names".into(), json!(count(&|r| truthy(&r["name"]))));
    manifest.insert("resolved_descriptions".into(), json!(count(&|r| truthy(&r["desc"]))));
    manifest.insert("decoded_blueprints".into(), json!(decoded_bp));
    manifest.insert("heuristic_blueprints".into(), json!(heuristic_bp));
    manifest.insert("with_requirements".into(), json!(count(&|r| truthy(&r["requirements"]))));
    manifest.insert("with_ingredients".into(), json!(count(&|r| truthy(&r["ingredients"]))));
    manifest.insert("total_ingredients".into(), json!(total_ingredients));
    manifest.insert("mastery_from_multipliers".into(), json!(count(&|r| r["mastery_source"] == "multipliers")));
    manifest.insert("mastery_from_prefab".into(), json!(count(&|r| r["mastery_source"] == "prefab")));
    manifest.insert("mastery_review_only".into(), json!(count(&|r| r["mastery_source"] == "review")));
    manifest.insert("catalogue_rows".into(), json!(catalogue.len()));
    manifest.insert("in_catalogue".into(), json!(count(&|r| truthy(&r["in_catalogue"]))));
    manifest.insert("with_providers".into(), json!(count(&|r| truthy(&r["providers"]))));
    manifest.insert("provider_recipes".into(), json!(providers.len()));
    Ok((rows, manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipe_strings() {
        assert_eq!(normalize_recipe_string(" item/x(\"("), "item/x(");
        assert_eq!(normalize_recipe_string(&normalize_recipe_string(" item/x(\"(")), "item/x");
        assert_eq!(pretty_name_from_path("item/pet/cool_cat_notrade.binfab"), "Cool Cat");
        assert_eq!(category_from_output("recipes/recipe_block_glass", ""), "Block");
        assert_eq!(provider_id_from_path("prefabs/placeable/x_interactive.binfab"), "placeable/x_interactive");
    }

    #[test]
    fn mastery_struct() {
        let c = [0x30, 0x02, 0x50, 0x04, 0x70, 0x01, 0x80, 0x01, 0x00, 0x98, 0x01];
        assert_eq!(recipe_mastery_from_prefab(&c), Some(4));
        let q = decode_quantified_recipe_paths(b"\x08\x08item/abc\x10\x06xx");
        assert_eq!((q[0].path.as_str(), q[0].amount, q[0].end), ("item/abc", 3, 12));
    }
}
