//! utils/gem_engine.py and models/trove/builds.py: the Gem Builds optimizer and the
//! star chart code parser.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::py::{self, Float, Int, Num};
use super::pyd::{self, Errors};

/// Blessing of the Lilypad: the ally buff, per stat class.
fn lilypad_multiplier(name: &str) -> f64 {
    match name {
        "Light" => 1.155,
        "Physical Damage" | "Magic Damage" | "Critical Damage" => 1.31,
        _ => 1.0,
    }
}

const BOUNTY_HUNT_NODES: [&str; 2] = ["Bounty Hunt Boon", "Bounty Hunt"];

/// What a star chart unlocks of the Bounty Hunt buff.
#[derive(Clone, Debug)]
pub struct Bounty {
    pub available: bool,
    pub name: Value,
    pub physical: Num,
    pub magic: Num,
}

impl Bounty {
    fn none() -> Self {
        Bounty { available: false, name: Value::Null, physical: Float(0.0), magic: Float(0.0) }
    }

    fn json(&self) -> Value {
        json!({"available": self.available, "name": self.name, "physical": self.physical.json(), "magic": self.magic.json()})
    }
}

/// `parse_build_code`'s result.
#[derive(Clone, Debug)]
pub struct ParsedChart {
    /// `(name, flat, pct)` in first-seen order.
    pub stats: Vec<(String, f64, f64)>,
    /// `None` while still Python's `set`, which eel serialised as `null`.
    pub abilities: Option<Vec<Value>>,
    pub paths_count: usize,
    pub bounty: Bounty,
}

impl ParsedChart {
    fn empty() -> Self {
        ParsedChart { stats: Vec::new(), abilities: None, paths_count: 0, bounty: Bounty::none() }
    }

    fn stat(&self, name: &str) -> Option<(f64, f64)> {
        self.stats.iter().find(|s| s.0 == name).map(|s| (s.1, s.2))
    }

    pub fn json(&self) -> Value {
        let mut stats = Map::new();
        for (name, flat, pct) in &self.stats {
            stats.insert(name.clone(), json!({"flat": py::json_float(*flat), "pct": py::json_float(*pct)}));
        }
        json!({
            "stats": stats,
            "abilities": self.abilities,
            "ability_values": {},
            "paths_count": self.paths_count,
            "bounty_hunt": self.bounty.json(),
        })
    }
}

/// The parts of a star chart node the parser reads.
struct Node {
    kind: Value,
    name: Value,
    stats: Value,
    abilities: Option<Value>,
    overwrites: Option<Value>,
    ability_values: Value,
}

impl Node {
    fn is_root(&self) -> bool {
        self.kind == "Root"
    }
}

pub struct StarChartParser {
    node_map: HashMap<String, Node>,
    parent_map: HashMap<String, Option<String>>,
    selectable_paths: Vec<String>,
    bounty_nodes: Vec<String>,
}

impl StarChartParser {
    pub fn new(raw: &Value) -> Self {
        let mut parser = StarChartParser { node_map: HashMap::new(), parent_map: HashMap::new(), selectable_paths: Vec::new(), bounty_nodes: Vec::new() };
        if let Some(map) = raw.as_object() {
            for constell in map.values() {
                parser.flatten(constell, None);
            }
        }
        parser.selectable_paths = parser.node_map.iter().filter(|(_, n)| !n.is_root()).map(|(p, _)| p.clone()).collect();
        parser.selectable_paths.sort();
        parser.bounty_nodes = parser
            .node_map
            .iter()
            .filter(|(_, n)| n.name.as_str().is_some_and(|s| BOUNTY_HUNT_NODES.contains(&s)) && crate::args::truthy(&n.ability_values))
            .map(|(p, _)| p.clone())
            .collect();
        parser
    }

    fn flatten(&mut self, node: &Value, parent: Option<String>) {
        let path = node.get("Path").map(crate::args::to_str);
        if let Some(p) = &path {
            let get = |k: &str| node.get(k).cloned();
            self.node_map.insert(
                p.clone(),
                Node {
                    kind: get("Type").unwrap_or(Value::Null),
                    name: get("Name").unwrap_or(Value::Null),
                    stats: get("Stats").unwrap_or_else(|| json!([])),
                    abilities: get("Abilities"),
                    overwrites: get("Overwrites"),
                    ability_values: get("Ability_Values").unwrap_or(Value::Null),
                },
            );
            self.parent_map.insert(p.clone(), parent);
        }
        if let Some(Value::Array(children)) = node.get("Stars") {
            for child in children {
                self.flatten(child, path.clone());
            }
        }
    }

    fn expand_terminal_path(&self, path: &str, into: &mut BTreeSet<String>) {
        let mut seen = BTreeSet::new();
        let mut current = path.to_string();
        while let Some(node) = self.node_map.get(&current) {
            if node.is_root() || seen.contains(&current) {
                break;
            }
            seen.insert(current.clone());
            let parent = self.parent_map.get(&current).cloned().flatten();
            match parent {
                Some(p) if !p.is_empty() && !self.node_map.get(&p).is_some_and(Node::is_root) => current = p,
                _ => break,
            }
        }
        into.extend(seen);
    }

    fn decode_compact_path(&self, token: &str) -> Option<String> {
        static SEGMENT: OnceLock<Regex> = OnceLock::new();
        let token = py::strip(token).to_lowercase();
        let mut chars = token.chars();
        let root = match chars.next()? {
            'c' => "combat",
            'g' => "gathering",
            'p' => "pve",
            _ => return None,
        };
        let rest = chars.as_str();
        let re = SEGMENT.get_or_init(|| Regex::new(r"[a-z]+|\d+").unwrap());
        let mut path = root.to_string();
        for m in re.find_iter(rest) {
            path.push('.');
            path.push_str(m.as_str());
        }
        match self.node_map.get(&path) {
            Some(node) if !node.is_root() => Some(path),
            _ => None,
        }
    }

    fn decode_build_code(&self, code: &str) -> Result<BTreeSet<String>, String> {
        let code = py::strip(code);
        let mut selected = BTreeSet::new();
        if code.is_empty() {
            return Ok(selected);
        }
        if code.starts_with("SC:") || code.starts_with("v2:") {
            let payload = code.split_once(':').map(|(_, p)| p).unwrap_or("");
            if payload.contains('|') {
                for token in payload.split('|') {
                    if let Some(path) = self.decode_compact_path(token) {
                        self.expand_terminal_path(&path, &mut selected);
                    }
                }
                return Ok(selected);
            }
            let pad = (4 - payload.chars().count() % 4) % 4;
            let padded: Vec<u8> = payload.bytes().chain(std::iter::repeat_n(b'=', pad)).map(|b| match b {
                b'-' => b'+',
                b'_' => b'/',
                b => b,
            }).collect();
            for id in py::a2b_base64(&padded)? {
                if let Some(path) = self.selectable_paths.get(id as usize) {
                    self.expand_terminal_path(path, &mut selected);
                }
            }
            return Ok(selected);
        }
        if !code.is_ascii() {
            return Err("string argument should contain only ASCII characters".into());
        }
        let bytes = py::a2b_base64(code.as_bytes())?;
        let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        Ok(text.split('$').filter(|p| self.node_map.contains_key(*p)).map(str::to_string).collect())
    }

    /// `parse_build_code`: the passive stats of the chart, minus overwritten nodes.
    pub fn parse_build_code(&self, code: &Value) -> ParsedChart {
        let mut result = ParsedChart::empty();
        if !crate::args::truthy(code) || self.node_map.is_empty() {
            return result;
        }
        let text = match code {
            Value::String(s) => s.clone(),
            other => py::repr_latin1(other),
        };
        let Ok(selected) = self.decode_build_code(&text) else {
            return result;
        };
        result.paths_count = selected.len();

        let mut overwrites = BTreeSet::new();
        for path in &selected {
            if let Some(list) = self.node_map.get(path).and_then(|n| n.overwrites.as_ref()) {
                overwrites.extend(py::iterate(list).unwrap_or_default().iter().map(crate::args::to_str));
            }
        }
        let active: Vec<&String> = selected.iter().filter(|p| !overwrites.contains(*p)).collect();
        result.bounty = self.bounty_hunt(&active);

        let mut abilities: Vec<Value> = Vec::new();
        for path in active {
            let Some(node) = self.node_map.get(path) else { continue };
            for stat in py::iterate(&node.stats).unwrap_or_default() {
                let name = stat.get("name").cloned().unwrap_or(Value::Null);
                if !crate::args::truthy(&name) {
                    continue;
                }
                let name = crate::args::to_str(&name);
                let val = match stat.get("value").unwrap_or(&json!(0)) {
                    Value::Null => 0.0,
                    v => py::to_float(v).unwrap_or(0.0),
                };
                let is_pct = stat.get("percentage").is_some_and(crate::args::truthy);
                let idx = match result.stats.iter().position(|s| s.0 == name) {
                    Some(i) => i,
                    None => {
                        result.stats.push((name, 0.0, 0.0));
                        result.stats.len() - 1
                    }
                };
                if is_pct {
                    result.stats[idx].2 += val;
                } else {
                    result.stats[idx].1 += val;
                }
            }
            if let Some(list) = &node.abilities {
                for a in py::iterate(list).unwrap_or_default() {
                    if !abilities.contains(&a) {
                        abilities.push(a);
                    }
                }
            }
        }
        result.abilities = Some(abilities);
        result
    }

    fn bounty_hunt(&self, active: &[&String]) -> Bounty {
        for path in active {
            if !self.bounty_nodes.contains(path) {
                continue;
            }
            let node = &self.node_map[*path];
            let value_of = |name: &str| -> Num {
                for stat in py::iterate(&node.ability_values).unwrap_or_default() {
                    if stat.get("name").is_some_and(|n| n == name) {
                        let v = stat.get("value").cloned().unwrap_or(Value::Null);
                        return if crate::args::truthy(&v) { Num::from_json(&v).unwrap_or(Float(0.0)) } else { Float(0.0) };
                    }
                }
                Float(0.0)
            };
            return Bounty { available: true, name: node.name.clone(), physical: value_of("Physical Damage"), magic: value_of("Magic Damage") };
        }
        Bounty::none()
    }
}

// --- builds.py -------------------------------------------------------------------------

pub const CLASSES: [&str; 18] = [
    "Bard",
    "Boomeranger",
    "Candy Barbarian",
    "Chloromancer",
    "Dino Tamer",
    "Dracolyte",
    "Fae Trickster",
    "Gunslinger",
    "Ice Sage",
    "Knight",
    "Lunar Lancer",
    "Neon Ninja",
    "Pirate Captain",
    "Revenant",
    "Shadow Hunter",
    "Solarion",
    "Tomb Raiser",
    "Vanguardian",
];

const BUILD_TYPES: [&str; 3] = ["Light", "Farm", "Health"];

const STAT_NAMES: [&str; 13] = [
    "Magic Damage",
    "Physical Damage",
    "Maximum Health",
    "Maximum Health %",
    "Energy",
    "Health Regen",
    "Energy Regen",
    "Movement Speed",
    "Attack Speed",
    "Jump",
    "Critical Hit",
    "Critical Damage",
    "Light",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BuildType {
    Light,
    Farm,
    Health,
}

/// `BuildConfig`.
#[derive(Clone, Debug)]
pub struct BuildConfig {
    pub build_type: BuildType,
    pub character: &'static str,
    pub subclass: &'static str,
    pub food: String,
    pub ally: String,
    pub ally_buff: bool,
    pub high_precision: bool,
    pub berserker_battler: bool,
    pub critical_damage_count: i64,
    pub no_face: bool,
    pub light: i64,
    pub subclass_active: bool,
    pub litany: bool,
    pub bounty_hunt: bool,
    pub star_chart: Option<String>,
}

impl BuildConfig {
    /// `BuildConfig(**v)`.
    pub fn validate(v: &Value) -> Result<BuildConfig, String> {
        let obj = v.as_object().ok_or_else(|| pyd::not_a_mapping("models.trove.builds.BuildConfig", v))?;
        let mut e = Errors::new("BuildConfig");
        let build_type = e.field(obj, "", "build_type", Some(|| 0), |_, _, v| pyd::str_enum(v, &BUILD_TYPES));
        let character = e.field(obj, "", "character", Some(|| 0), |_, _, v| pyd::str_enum(v, &CLASSES));
        let subclass = e.field(obj, "", "subclass", Some(|| 1), |_, _, v| pyd::str_enum(v, &CLASSES));
        let food = e.field(obj, "", "food", Some(|| "zephyr_rune".to_string()), |_, _, v| pyd::string(v));
        let ally = e.field(obj, "", "ally", Some(|| "boot_clown".to_string()), |_, _, v| pyd::string(v));
        let flag = |e: &mut Errors, key: &str, default: fn() -> bool| e.field(obj, "", key, Some(default), |_, _, v| pyd::boolean(v));
        let ally_buff = flag(&mut e, "ally_buff", || true);
        let high_precision = flag(&mut e, "high_precision", || false);
        let berserker_battler = flag(&mut e, "berserker_battler", || false);
        let critical_damage_count = e.field(obj, "", "critical_damage_count", Some(|| 3), |_, _, v| pyd::int(v));
        let no_face = flag(&mut e, "no_face", || false);
        let light = e.field(obj, "", "light", Some(|| 0), |_, _, v| pyd::int(v));
        let subclass_active = flag(&mut e, "subclass_active", || false);
        let litany = flag(&mut e, "litany", || false);
        let bounty_hunt = flag(&mut e, "bounty_hunt", || false);
        let star_chart = e.field(obj, "", "star_chart", Some(|| None), |_, _, v| if v.is_null() { Ok(None) } else { pyd::string(v).map(Some) });
        if !e.is_empty() {
            return Err(e.message());
        }
        Ok(BuildConfig {
            build_type: [BuildType::Light, BuildType::Farm, BuildType::Health][build_type.unwrap_or(0)],
            character: CLASSES[character.unwrap_or(0)],
            subclass: CLASSES[subclass.unwrap_or(1)],
            food: food.unwrap_or_default(),
            ally: ally.unwrap_or_default(),
            ally_buff: ally_buff.unwrap_or(true),
            high_precision: high_precision.unwrap_or(false),
            berserker_battler: berserker_battler.unwrap_or(false),
            critical_damage_count: critical_damage_count.unwrap_or(3),
            no_face: no_face.unwrap_or(false),
            light: light.unwrap_or(0),
            subclass_active: subclass_active.unwrap_or(false),
            litany: litany.unwrap_or(false),
            bounty_hunt: bounty_hunt.unwrap_or(false),
            star_chart: star_chart.flatten(),
        })
    }
}

#[derive(Clone, Debug)]
struct ClassStat {
    name: &'static str,
    value: Option<f64>,
}

/// The parts of `TroveClass` the optimizer reads.
#[derive(Clone, Debug)]
pub struct TroveClass {
    pub name: &'static str,
    magic: bool,
    stats: Vec<ClassStat>,
    bonuses: Vec<ClassStat>,
}

impl TroveClass {
    fn parse(v: &Value) -> Option<TroveClass> {
        let pick = |key: &str, options: &[&'static str]| -> Option<&'static str> {
            let s = v.get(key)?.as_str()?;
            options.iter().copied().find(|o| *o == s)
        };
        let stats = |key: &str| -> Option<Vec<ClassStat>> {
            v.get(key)?
                .as_array()?
                .iter()
                .map(|s| {
                    let name = STAT_NAMES.iter().copied().find(|n| s.get("name").and_then(Value::as_str) == Some(*n))?;
                    let value = match s.get("value")? {
                        Value::Null => None,
                        x => Some(pyd::float(x).ok()?),
                    };
                    pyd::boolean(s.get("percentage")?).ok()?;
                    Some(ClassStat { name, value })
                })
                .collect()
        };
        Some(TroveClass { name: pick("name", &CLASSES)?, magic: pick("damage_type", &["Magic", "Physical"])? == "Magic", stats: stats("stats")?, bonuses: stats("bonuses")? })
    }

    /// `get_attr(self.stats, name=...).value`.
    fn stat_value(&self, name: &str) -> Result<Option<f64>, String> {
        self.stats.iter().find(|s| s.name == name).map(|s| s.value).ok_or_else(|| "'NoneType' object has no attribute 'value'".into())
    }
}

/// `x + y` where `y` may be Python's `None`.
fn add_opt(x: Num, y: Option<f64>, op: &str) -> Result<Num, String> {
    y.map(|y| x + Float(y)).ok_or_else(|| format!("unsupported operand type(s) for {op}: '{}' and 'NoneType'", x.type_name()))
}

fn load_json(base: &Path, rel: &str) -> Result<Value, String> {
    let path = base.join(rel);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let text = std::str::from_utf8(&bytes).map_err(|e| format!("'utf-8' codec can't decode bytes: {e}"))?;
            Ok(serde_json::from_str(text).unwrap_or_else(|_| json!({})))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

/// `x[key]` on loaded data, with Python's KeyError text.
fn key<'a>(v: &'a Value, k: &str) -> Result<&'a Value, String> {
    Ok(py::subscript(v, k)?)
}

fn index(v: &Value, i: usize) -> Result<Num, String> {
    let item = v.get(i).ok_or("list index out of range")?;
    Num::from_json(item).ok_or_else(|| format!("unsupported operand type(s) for *: 'int' and '{}'", py::type_name(item)))
}

type Build = ([i64; 2], [i64; 2], [i64; 3], [i64; 3]);

fn generate_combinations(farm: bool) -> Vec<Build> {
    let triples = |n: i64| -> Vec<[i64; 3]> {
        let mut out = Vec::new();
        for x in 0..=n {
            for y in 0..=n {
                for z in 0..=n {
                    if x + y + z == n && (farm || z == n) {
                        out.push([x, y, z]);
                    }
                }
            }
        }
        out
    };
    let (third, fourth) = (triples(3), triples(6));
    let mut out = Vec::new();
    for i in 0..10 {
        for j in 0..19 {
            for c in &third {
                for d in &fourth {
                    out.push(([i, 9 - i], [j, 18 - j], *c, *d));
                }
            }
        }
    }
    out
}

pub struct Engine {
    base: PathBuf,
    pub classes: Vec<(String, TroveClass)>,
    pub foods: Value,
    pub allies: Value,
    face_damage: Num,
    gem_stats: Value,
    pub star_parser: StarChartParser,
}

/// The six gem stat columns `calculate_gem_stats` reads.
struct GemColumns {
    first: [Num; 4],
    second: [Num; 4],
    third: [Num; 4],
}

impl Engine {
    pub fn load(base: PathBuf) -> Result<Engine, String> {
        let classes_data = load_json(&base, "classes.json")?;
        let foods = load_json(&base, "builds/food.json")?;
        let allies = load_json(&base, "builds/ally.json")?;
        let face = load_json(&base, "builds/face_damage.json")?;
        let face_damage = if crate::args::truthy(&face) { face.get("Face").and_then(Num::from_json).unwrap_or(Int(0)) } else { Int(0) };
        let gem_stats = load_json(&base, "mystic.json")?;
        let star_parser = StarChartParser::new(&load_json(&base, "star_chart.json")?);
        let mut classes: Vec<(String, TroveClass)> = Vec::new();
        if crate::args::truthy(&classes_data) {
            for raw in py::iterate(&classes_data)? {
                let name = crate::args::to_str(key(&raw, "name")?);
                let parsed = TroveClass::parse(&raw).ok_or_else(|| format!("1 validation error for TroveClass ({name})"))?;
                match classes.iter_mut().find(|(n, _)| *n == name) {
                    Some(slot) => slot.1 = parsed,
                    None => classes.push((name, parsed)),
                }
            }
        }
        Ok(Engine { base, classes, foods, allies, face_damage, gem_stats, star_parser })
    }

    fn class(&self, name: &str) -> Option<&TroveClass> {
        self.classes.iter().find(|(n, _)| n == name).map(|(_, c)| c)
    }

    fn sum_file_values(&self, rel: &str) -> Result<Num, String> {
        let data = load_json(&self.base, &format!("builds/{rel}.json"))?;
        if !crate::args::truthy(&data) {
            return Ok(Float(0.0));
        }
        let map = data.as_object().ok_or_else(|| format!("'{}' object has no attribute 'values'", py::type_name(&data)))?;
        let mut total = Int(0);
        for v in map.values() {
            total = total + Num::from_json(v).ok_or_else(|| format!("unsupported operand type(s) for +: '{}' and '{}'", total.type_name(), py::type_name(v)))?;
        }
        Ok(total)
    }

    fn gem_columns(&self, health: bool) -> Result<Option<GemColumns>, String> {
        if !crate::args::truthy(&self.gem_stats) {
            return Ok(None);
        }
        let lesser = key(&self.gem_stats, "Lesser")?;
        let empowered = key(&self.gem_stats, "Empowered")?;
        let (a, b) = if health { ("Maximum Health", "Maximum Health %") } else { ("Damage", "Critical Damage") };
        let col = |name: &str| -> Result<[Num; 4], String> {
            let (e, l) = (key(empowered, name)?, key(lesser, name)?);
            Ok([index(e, 0)?, index(e, 1)?, index(l, 0)?, index(l, 1)?])
        };
        Ok(Some(GemColumns { first: col(a)?, second: col(b)?, third: col("Light")? }))
    }

    /// `calculate_gem_stats`: the gem stat totals of one boost layout.
    fn calculate_gem_stats(cols: &Option<GemColumns>, build: &Build) -> (Num, Num, Num) {
        let Some(c) = cols else { return (Int(0), Int(0), Int(0)) };
        let ([fe0, fe1, fl0, fl1], [se0, se1, sl0, sl1], [te0, te1, tl0, tl1]) = (c.first, c.second, c.third);
        let n = Int;
        let (mut first, mut second, mut third) = (n(0), n(0), n(0));
        let (mut cosmic_first, mut cosmic_second) = (n(0), n(0));
        first = first + (n(3) * fe0 + n(6) * fl0);
        second = second + (n(3) * se0 + n(6) * sl0);
        third = third + (n(1) * te0 + n(2) * tl0);
        cosmic_first = cosmic_first + (n(1) * fe0 + n(2) * fl0);
        cosmic_second = cosmic_second + (n(1) * se0 + n(2) * sl0);
        first = first + fe1 * n(build.0[0]);
        second = second + se1 * n(build.0[1]);
        first = first + fl1 * n(build.1[0]);
        second = second + sl1 * n(build.1[1]);
        cosmic_first = cosmic_first + fe1 * n(build.2[0]);
        cosmic_second = cosmic_second + se1 * n(build.2[1]);
        third = third + te1 * n(build.2[2]);
        cosmic_first = cosmic_first + fl1 * n(build.3[0]);
        cosmic_second = cosmic_second + sl1 * n(build.3[1]);
        third = third + tl1 * n(build.3[2]);
        ((first + cosmic_first) * Float(1.1), (second + cosmic_second) * Float(1.1), third * Float(1.1))
    }

    /// Adds the stats of a food or ally entry. `ally` applies the Lilypad buff.
    fn apply_buff_stats(&self, entry: &Value, damage: &str, ally: Option<bool>, t: &mut [Num; 6]) -> Result<(), String> {
        let stats = entry.as_object().and_then(|o| o.get("stats")).cloned().unwrap_or_else(|| json!([]));
        let num = |v: &Value, op: &str| {
            Num::from_json(v).ok_or_else(|| format!("unsupported operand type(s) for {op}: 'float' and '{}'", py::type_name(v)))
        };
        for stat in py::iterate(&stats)? {
            let name = crate::args::to_str(key(&stat, "name")?);
            let buffed = match ally {
                Some(true) => Some(Float(num(key(&stat, "value")?, "*")?.f() * lilypad_multiplier(&name))),
                Some(false) => Some(num(key(&stat, "value")?, "+=")?),
                None => None,
            };
            let value = || buffed.map(Ok).unwrap_or_else(|| num(key(&stat, "value")?, "+="));
            if name == damage {
                if crate::args::truthy(key(&stat, "percentage")?) {
                    t[3] = t[3] + value()?;
                } else {
                    t[0] = t[0] + value()?;
                }
            }
            if name == "Critical Damage" {
                if ally.is_some() && crate::args::truthy(key(&stat, "percentage")?) {
                    t[4] = t[4] + value()?;
                } else {
                    t[1] = t[1] + value()?;
                }
            }
            if name == "Light" {
                t[2] = t[2] + value()?;
            }
        }
        Ok(())
    }

    /// `calculate_builds`: every boost layout, ranked, top 200.
    pub fn calculate_builds(&self, config: &BuildConfig) -> Result<Vec<Value>, String> {
        if self.classes.is_empty() {
            return Err("Class data not loaded. Please ensure classes.json exists.".into());
        }
        let class = self.class(config.character).ok_or("'NoneType' object has no attribute 'damage_type'")?;
        let mut damage = if class.magic { "Magic Damage" } else { "Physical Damage" };
        let has = |names: &[&str], c: &str| names.contains(&c);

        // first, second, third, fourth, fifth, sixth
        let mut t: [Num; 6];
        if config.build_type == BuildType::Health {
            let first = add_opt(self.sum_file_values("health")?, class.stat_value("Maximum Health")?, "+")?;
            let second = add_opt(self.sum_file_values("health_per")?, class.stat_value("Maximum Health %")?, "+")?;
            t = [first, second, Int(0), Int(0), Int(100), Int(100)];
            damage = "Maximum Health";
        } else {
            t = [
                self.sum_file_values("damage")?,
                self.sum_file_values("critical_damage")?,
                self.sum_file_values("light")?,
                self.sum_file_values("bonus_damage")?,
                Int(100),
                Int(100),
            ];
            t[0] = add_opt(t[0], class.stat_value(damage)?, "+=")?;
            t[1] = add_opt(t[1], class.stat_value("Critical Damage")?, "+=")?;
            if !config.no_face {
                t[0] = t[0] + self.face_damage;
            }
            let member = if damage == "Magic Damage" { "magic_damage" } else { "physical_damage" };
            t[0] = t[0] + (self.sum_file_values(&format!("{member}/dragons_damage"))? + self.sum_file_values("dragons_damage")?);
            t[1] = t[1] + self.sum_file_values("dragons_critical_damage")?;

            if !config.food.is_empty() {
                if let Some(food) = self.foods.as_object().and_then(|m| m.get(&config.food)) {
                    self.apply_buff_stats(food, damage, None, &mut t)?;
                }
            }
            if !config.ally.is_empty() {
                if let Some(ally) = self.allies.as_object().and_then(|m| m.get(&config.ally)) {
                    self.apply_buff_stats(ally, damage, Some(config.ally_buff), &mut t)?;
                }
            }

            t[1] = t[1] - Float(48.1) * Int(3 - config.critical_damage_count);
            if config.character == "Solarion" || config.subclass == "Solarion" {
                t[2] = t[2] + Int(140);
            }
            if damage == "Physical Damage" && config.subclass == "Lunar Lancer" {
                t[0] = t[0] + Int(750);
            }
            if damage == "Magic Damage" && has(&["Ice Sage", "Shadow Hunter"], config.subclass) {
                t[0] = t[0] + Int(750);
            }
            if config.subclass == "Bard" {
                t[1] = t[1] + Int(15);
            }
            if config.subclass == "Boomeranger" {
                t[1] = t[1] + Int(20);
            }
            if config.subclass_active {
                if config.subclass == "Bard" {
                    t[3] = t[3] + Int(45);
                    t[1] = t[1] + Int(45);
                }
                if config.subclass == "Gunslinger" {
                    t[3] = t[3] + Float(5.5);
                }
                if has(&["Lunar Lancer", "Candy Barbarian"], config.subclass) {
                    t[3] = t[3] + Int(30);
                }
            }
            if config.berserker_battler {
                t[2] = t[2] + Int(750);
            }
            if config.litany {
                t[5] = t[5] + Int(1);
            }

            if let Some(code) = config.star_chart.as_ref().filter(|c| !c.is_empty()) {
                let parsed = self.star_parser.parse_build_code(&json!(code));
                let get = |name: &str| parsed.stat(name).map(|(f, p)| (Float(f), Float(p))).unwrap_or((Int(0), Int(0)));
                let (dmg, crit, light) = (get(damage), get("Critical Damage"), get("Light"));
                t[0] = t[0] + dmg.0;
                t[1] = t[1] + crit.0;
                t[2] = t[2] + light.0;
                t[3] = t[3] + dmg.1;
                t[4] = t[4] + crit.1;
                t[5] = t[5] + light.1;
                if config.bounty_hunt && parsed.bounty.available {
                    t[3] = t[3] + if damage == "Magic Damage" { parsed.bounty.magic } else { parsed.bounty.physical };
                }
            }
        }
        let [first, second, third, fourth, fifth, sixth] = t;

        let digits = |d: i32| if config.high_precision { 8 } else { d };
        let class_bonus = class.bonuses.iter().find(|b| b.name == damage).and_then(|b| b.value);
        let cols = self.gem_columns(config.build_type == BuildType::Health)?;

        struct Row {
            build: Build,
            cfirst: Num,
            csecond: Num,
            light: f64,
            total: Num,
            coefficient: f64,
        }
        let mut rows: Vec<Row> = generate_combinations(config.build_type == BuildType::Farm)
            .into_iter()
            .map(|build| {
                let (g1, g2, g3) = Self::calculate_gem_stats(&cols, &build);
                let (cfirst, csecond, cthird) = (first + g1, second + g2, third + g3);
                let mut total = cfirst * (Int(1) + fourth.div(Int(100)));
                if let Some(bonus) = class_bonus {
                    total = total * (Int(1) + Float(bonus).div(Int(100)));
                }
                let coefficient = (total * (Int(1) + (csecond * fifth.div(Int(100))).div(Int(100)))).round(digits(2)).f();
                let light = (cthird * sixth.div(Int(100))).round(digits(2)).f();
                Row { build, cfirst, csecond, light, total, coefficient }
            })
            .collect();

        let target = config.light as f64;
        if config.light != 0 {
            rows.sort_by(|a, b| ((a.light - target).abs(), -a.coefficient).partial_cmp(&((b.light - target).abs(), -b.coefficient)).unwrap_or(std::cmp::Ordering::Equal));
        } else {
            rows.sort_by(|a, b| (-a.coefficient).partial_cmp(&-b.coefficient).unwrap_or(std::cmp::Ordering::Equal));
        }

        let health = config.build_type == BuildType::Health;
        Ok(rows
            .iter()
            .take(200)
            .enumerate()
            .map(|(i, row)| {
                let (a, b, c, d) = row.build;
                let mut boosts: Vec<i64> = a.iter().chain(&b).chain(&c).chain(&d).copied().collect();
                if config.light == 0 || health {
                    boosts.remove(9);
                    boosts.remove(6);
                }
                if config.light == 0 && !health {
                    boosts.truncate(4);
                }
                let join = |xs: &[i64]| xs.iter().map(i64::to_string).collect::<Vec<_>>().join("/");
                let mut layout = join(&boosts[..boosts.len().min(4)]);
                if boosts.len() > 4 {
                    layout.push_str(" + ");
                    layout.push_str(&join(&boosts[4..]));
                }
                json!({
                    "rank": i + 1,
                    "layout": layout,
                    "base_dmg": row.cfirst.round(digits(2)).json(),
                    "crit_dmg": row.csecond.round(digits(1)).json(),
                    "light": py::json_float(row.light),
                    "bonus_dmg": fourth.round(8).json(),
                    "crit_bonus": (fifth - Int(100)).round(8).json(),
                    "total_dmg": row.total.round(digits(2)).json(),
                    "class_bonus": class_bonus.map(py::json_float),
                    "coefficient": py::json_float(row.coefficient),
                })
            })
            .collect())
    }
}

/// `gem_engine()`: loaded on first use. A failed load stays failed, like Python's.
pub fn engine() -> Option<&'static Engine> {
    static ENGINE: OnceLock<Option<Engine>> = OnceLock::new();
    ENGINE
        .get_or_init(|| match Engine::load(crate::ctx().web_path("assets/data")) {
            Ok(engine) if !engine.classes.is_empty() => Some(engine),
            Ok(_) => {
                eprintln!("CRITICAL ERROR loading Gem Engine: no class data under web/assets/data.");
                None
            }
            Err(e) => {
                eprintln!("CRITICAL ERROR loading Gem Engine: {e}");
                None
            }
        })
        .as_ref()
}
