//! utils/prefab_binfab.py: string harvesting and stat-record scanning over a `.binfab`.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use super::py;

/// Stat id (the zig-zag decoded header byte) to the game's `KStatType` name.
pub const STAT_GUESSES: [&str; 45] = [
    "PhysicalDamage",
    "SpellDamage",
    "MaxHealth",
    "MaxEnergy",
    "HealthRegen",
    "EnergyRegen",
    "Stability",
    "CriticalHitChance",
    "MovementSpeed",
    "Jump",
    "Superstition",
    "IncomingDamageMod",
    "OutgoingDamageMod",
    "MagicFind",
    "Mining",
    "AttackSpeed",
    "MaxFlasks",
    "CraftingSpeed",
    "CooldownSpeed",
    "Acceleration",
    "TurningRate",
    "ExperienceBoost",
    "CriticalHitDamage",
    "BattleFactor",
    "ActionTimeMod",
    "PowerRank",
    "Glide",
    "ShootProjectileSpeedMultiplier",
    "RedGemStatBoost",
    "BlueGemStatBoost",
    "YellowGemStatBoost",
    "DoubleHitChance",
    "JackpotExperience",
    "GemEfficiency",
    "AdventurineGainBoost",
    "ClubExperienceBoost",
    "MaxExploration",
    "JumpSpeedMultiplier",
    "GreenGemStatBoost",
    "Light",
    "Dark",
    "OpalGemStatBoost",
    "MaxNCharge",
    "NChargeRegen",
    "MaxArmor",
];

pub fn stat_guess(id: i64) -> &'static str {
    usize::try_from(id).ok().and_then(|i| STAT_GUESSES.get(i)).copied().unwrap_or("")
}

pub fn stat_label_of(name: &str) -> Option<&'static str> {
    Some(match name {
        "PhysicalDamage" => "Physical Damage",
        "SpellDamage" => "Magic Damage",
        "MaxHealth" => "Maximum Health",
        "MaxEnergy" => "Maximum Energy",
        "HealthRegen" => "Health Regen",
        "EnergyRegen" => "Energy Regen",
        "Stability" => "Stability",
        "CriticalHitChance" => "Critical Hit",
        "MovementSpeed" => "Movement Speed",
        "Jump" => "Jump",
        "Superstition" => "Superstition",
        "IncomingDamageMod" => "Incoming Damage",
        "OutgoingDamageMod" => "Damage",
        "MagicFind" => "Magic Find",
        "Mining" => "Lasermancy",
        "AttackSpeed" => "Attack Speed",
        "MaxFlasks" => "Flask Capacity",
        "CraftingSpeed" => "Crafting Speed",
        "CooldownSpeed" => "Cooldown Speed",
        "Acceleration" => "Acceleration",
        "TurningRate" => "Turning Rate",
        "ExperienceBoost" => "Experience Boost",
        "CriticalHitDamage" => "Critical Damage",
        "BattleFactor" => "Battle Factor",
        "ActionTimeMod" => "Action Time Mod",
        "PowerRank" => "Power Rank",
        "Glide" => "Glide",
        "ShootProjectileSpeedMultiplier" => "Projectile Speed",
        "RedGemStatBoost" => "Red Gem Stat Boost",
        "BlueGemStatBoost" => "Blue Gem Stat Boost",
        "YellowGemStatBoost" => "Yellow Gem Stat Boost",
        "DoubleHitChance" => "Double Hit",
        "JackpotExperience" => "Jackpot Experience",
        "GemEfficiency" => "Gem Efficiency",
        "AdventurineGainBoost" => "Adventurine",
        "ClubExperienceBoost" => "Club Experience Boost",
        "MaxExploration" => "Maximum Exploration",
        "JumpSpeedMultiplier" => "Jump Speed",
        "GreenGemStatBoost" => "Green Gem Stat Boost",
        "Light" => "Light",
        "Dark" => "Dark",
        "OpalGemStatBoost" => "Opal Gem Stat Boost",
        "MaxNCharge" => "Maximum N-Charge",
        "NChargeRegen" => "N-Charge Regen",
        "MaxArmor" => "Maximum Armor",
        _ => return None,
    })
}

/// The `KModType` operation byte (the zig-zag of its index).
pub fn operation_name(op: Option<u8>) -> &'static str {
    match op {
        Some(0) => "MultiplySum",
        Some(2) => "Add",
        Some(4) => "Set",
        Some(6) => "Nullify",
        Some(8) => "Multiply",
        Some(10) => "Minimum",
        Some(12) => "Maximum",
        _ => "",
    }
}

/// `stat_label`: a `…Bonus` twin is named off the stat it scales.
pub fn stat_label(stat_name: &str) -> String {
    if let Some(base) = stat_name.strip_suffix("Bonus") {
        if let Some(label) = stat_label_of(base) {
            return format!("{} Bonus", label);
        }
    }
    stat_label_of(stat_name).map(str::to_string).unwrap_or_else(|| stat_name.to_string())
}

/// One printable-ASCII run (`extract_strings`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinString {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

impl BinString {
    pub fn to_value(&self) -> Value {
        json!({"text": self.text, "start": self.start, "end": self.end})
    }
}

const KNOWN_PREFIXES: [&str; 12] =
    ["collections/", "abilities/", "allies/", "mounts/", "pets/", "item/", "equipment/", "prefabs_", "C_C_", "C_MT_", "c_c_", "c_mt_"];

fn clean_ascii_string(text: &str) -> &str {
    let mut text = text;
    match text.find('$') {
        Some(i) if i > 0 => text = &text[i..],
        _ => {
            for prefix in KNOWN_PREFIXES {
                if let Some(i) = text.find(prefix) {
                    if i > 0 {
                        text = &text[i..];
                        break;
                    }
                }
            }
        }
    }
    py::strip(text)
}

/// Every run of 4+ printable ASCII bytes, trimmed to where its identifier starts.
pub fn extract_strings(data: &[u8]) -> Vec<BinString> {
    let mut out = Vec::new();
    let mut i = 0;
    let n = data.len();
    while i < n {
        if !(0x20..=0x7E).contains(&data[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < n && (0x20..=0x7E).contains(&data[i]) {
            i += 1;
        }
        if i - start >= 4 {
            // Printable ASCII is valid UTF-8.
            let raw = std::str::from_utf8(&data[start..i]).unwrap_or_default();
            let cleaned = clean_ascii_string(raw);
            if !cleaned.is_empty() {
                out.push(BinString { text: cleaned.to_string(), start, end: i });
            }
        }
    }
    out
}

pub fn decode_little_endian_float(raw: &[u8]) -> Option<f64> {
    let bytes: [u8; 4] = raw.try_into().ok()?;
    let v = f32::from_le_bytes(bytes) as f64;
    v.is_finite().then_some(v)
}

/// `format_float_value`: an integer when it is one, else up to six decimals.
pub fn format_float_value(value: f64) -> String {
    if (value - value.trunc()).abs() < 1e-9 {
        return py::int_str(value);
    }
    strip_zeros(format!("{:.6}", value))
}

fn strip_zeros(s: String) -> String {
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// `(display value, is percentage)` for a record, decided by its operation byte.
pub fn get_stat_display_value(record: &StatRecord) -> (f64, bool) {
    let value = record.value;
    match record.operation {
        Some(0) => (value * 100.0, true),
        Some(8) => ((value - 1.0) * 100.0, true),
        Some(2) => match record.decoded_stat_name {
            "CriticalHitChance" => (value / 10.0, true),
            "CriticalHitDamage" | "AttackSpeed" => (value, true),
            _ => (value, false),
        },
        _ => (value, false),
    }
}

pub fn format_stat_display(value: f64, is_percent: bool) -> String {
    if is_percent {
        let r = value.round_ties_even();
        if (value - r).abs() < 1e-9 {
            return format!("{}%", py::int_str(r));
        }
        return format!("{}%", strip_zeros(format!("{:.1}", value)));
    }
    format_float_value(value)
}

pub fn collection_h2d(first: u8, second: u8) -> f64 {
    let denom = 67.0 - second as f64;
    let p = 4f64.powf(denom);
    if first > 128 {
        2.0 * (128.0 / p) + 2.0 * (first as f64 - 128.0) / p
    } else {
        128.0 / p + first as f64 / p
    }
}

/// One row of `extracted_stats`.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractedStat {
    pub source: String,
    pub stat: String,
    pub label: String,
    pub value: f64,
    pub display_value: f64,
    pub is_percent: bool,
    pub value_display: String,
    pub display: String,
    pub group: String,
    pub component_type: String,
}

impl ExtractedStat {
    pub fn to_value(&self) -> Value {
        json!({
            "source": self.source,
            "stat": self.stat,
            "label": self.label,
            "value": self.value,
            "display_value": self.display_value,
            "is_percent": self.is_percent,
            "value_display": self.value_display,
            "display": self.display,
            "group": self.group,
            "component_type": self.component_type,
        })
    }
}

const COLLECTION_VALUE_MARKERS: [(&[u8], &str, &str, &str, &str); 4] = [
    (b"\x38\x10ground_movespeedF", "ground_movespeed", "MovementSpeed", "Movement Speed", "Mount"),
    (b"\x38\x0Ewing_movespeedF", "wing_movespeed", "MovementSpeed", "Movement Speed", "Wings"),
    (b"\x38\x1Cyellow_dragon_wing_movespeedF", "wing_movespeed", "MovementSpeed", "Movement Speed", "Wings"),
    (b"\x38\x0Fglide_movespeedF", "glide_movespeed", "Glide", "Glide", "Wings"),
];

/// Movement stats a mount/wings collection component stores inline after its marker.
pub fn extract_collection_value_stats(data: &[u8]) -> Vec<ExtractedStat> {
    let mut out = Vec::new();
    let mut seen: HashSet<(&str, String)> = HashSet::new();
    for (marker, source, stat, label, component) in COLLECTION_VALUE_MARKERS {
        let mut start = 0;
        while let Some(index) = py::find(data, marker, start) {
            if index < 2 {
                break;
            }
            let value = collection_h2d(data[index - 2], data[index - 1]);
            if seen.insert((source, format!("{:.6}", value))) {
                let shown = format_float_value(value);
                out.push(ExtractedStat {
                    source: source.into(),
                    stat: stat.into(),
                    label: label.into(),
                    value,
                    display_value: value,
                    is_percent: false,
                    value_display: shown.clone(),
                    display: shown,
                    group: String::new(),
                    component_type: component.into(),
                });
            }
            start = index + 1;
        }
    }
    out
}

pub fn zig_zag_decode(value: i128) -> i128 {
    (value >> 1) ^ -(value & 1)
}

fn allowed_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'/' | b'.' | b'$' | b'-')
}

/// `ALLOWED_STRING_RE.fullmatch`.
pub fn allowed_string(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(allowed_char)
}

pub fn find_string_start(contents: &[u8], marker_pos: usize) -> usize {
    let mut start = marker_pos;
    while start > 0 && allowed_char(contents[start - 1]) {
        start -= 1;
    }
    start
}

pub fn read_length_prefixed_string_at(contents: &[u8], start: usize) -> String {
    if start == 0 || start > contents.len() {
        return String::new();
    }
    let length = contents[start - 1] as usize;
    if length == 0 || start + length > contents.len() {
        return String::new();
    }
    let text = py::ascii_ignore(&contents[start..start + length]);
    if allowed_string(&text) {
        text
    } else {
        String::new()
    }
}

pub fn guess_stat_from_header(header: &[u8]) -> String {
    let mut guesses: Vec<String> = Vec::new();
    for &b in header {
        let name = stat_guess(b as i64);
        if !name.is_empty() {
            let g = format!("0x{:02X} {}", b, name);
            if !guesses.contains(&g) {
                guesses.push(g);
            }
        }
    }
    guesses.join(" | ")
}

/// One stat record found by [`detect_stat_records`].
#[derive(Debug, Clone, PartialEq)]
pub struct StatRecord {
    pub offset: usize,
    pub group_index: Option<u8>,
    pub group_marker_hex: String,
    pub tag: u8,
    /// The record's label, empty when unlabeled.
    pub label: String,
    pub float_bytes: [u8; 4],
    pub value: f64,
    pub header: Vec<u8>,
    pub decoded_stat_id: Option<i64>,
    pub decoded_stat_name: &'static str,
    pub operation: Option<u8>,
    pub component_type: String,
}

impl StatRecord {
    pub fn is_unlabeled(&self) -> bool {
        self.label.is_empty()
    }

    /// Python's `record["label"]`.
    pub fn label_display(&self) -> &str {
        if self.label.is_empty() {
            "[no label]"
        } else {
            &self.label
        }
    }

    pub fn group_display(&self) -> String {
        self.group_index.map(|g| format!("Component {}", g)).unwrap_or_default()
    }

    /// `record_stat_name`: the `…Bonus` twin under MultiplySum.
    pub fn stat_name(&self) -> String {
        if !self.decoded_stat_name.is_empty() && self.operation == Some(0) {
            format!("{}Bonus", self.decoded_stat_name)
        } else {
            self.decoded_stat_name.to_string()
        }
    }

    pub fn to_value(&self) -> Value {
        let id_hex = match self.decoded_stat_id {
            None => String::new(),
            Some(id) if id < 0 => format!("0x-{:X}", -id),
            Some(id) => format!("0x{:02X}", id),
        };
        json!({
            "offset": self.offset,
            "group_index": self.group_index,
            "group_display": self.group_display(),
            "group_marker_hex": self.group_marker_hex,
            "tag_hex": format!("{:02X}", self.tag),
            "label": self.label_display(),
            "float_hex": py::hex_upper(&self.float_bytes),
            "value": self.value,
            "value_display": format_float_value(self.value),
            "header_hex": py::hex_upper(&self.header),
            "header_decoded": self.header.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", "),
            "header_bytes_array": self.header,
            "decoded_stat_id": self.decoded_stat_id,
            "decoded_stat_id_hex": id_hex,
            "decoded_stat_name": self.decoded_stat_name,
            "operation": self.operation,
            "operation_name": operation_name(self.operation),
            "is_unlabeled": self.is_unlabeled(),
            "record_style": if self.is_unlabeled() { "unlabeled" } else { "labeled" },
            "header_guess": guess_stat_from_header(&self.header),
            "component_type": self.component_type,
        })
    }
}

/// Scans `chunk` for stat records: `<header> <f32> 0x38 <len> <label> 0x46`.
pub fn detect_stat_records(chunk: &[u8], offset_base: usize) -> Vec<StatRecord> {
    let mut records = Vec::new();
    let length = chunk.len();
    let mut group: Option<u8> = None;
    let mut group_hex = String::new();
    let mut i = 0;
    while i < length {
        if i + 4 <= length && chunk[i] == 0xAE && chunk[i + 2] == 0x00 && chunk[i + 3] == 0x04 {
            let g = chunk[i + 1];
            if 0 < g && g < 32 {
                group = Some(g);
                let ms = i.saturating_sub(2);
                let me = ms + 6.min(length - ms);
                group_hex = py::hex_upper(&chunk[ms..me]);
            }
        }
        if chunk[i] != 0x38 || i + 1 >= length {
            i += 1;
            continue;
        }
        let string_length = chunk[i + 1] as usize;
        if i + 2 + string_length > length {
            i += 1;
            continue;
        }
        let label = py::ascii_ignore(&chunk[i + 2..i + 2 + string_length]);
        if string_length > 0 && (!allowed_string(&label) || (!label.contains('_') && !label.ends_with("mods"))) {
            i += 1;
            continue;
        }
        if i < 4 {
            i += 1;
            continue;
        }
        let float_bytes: [u8; 4] = chunk[i - 4..i].try_into().unwrap();
        let value = match decode_little_endian_float(&float_bytes) {
            Some(v) if v.abs() <= 1_000_000.0 => v,
            _ => {
                i += 1;
                continue;
            }
        };
        let post = i + 2 + string_length;
        let is_mods = label.ends_with("mods") && post < length && chunk[post] == 0x46;
        if !is_mods && (post >= length || chunk[post] != 0x46) {
            i += 1;
            continue;
        }
        let header_start = i.saturating_sub(if is_mods { 8 } else { 10 });
        let header = chunk[header_start..i - 4].to_vec();
        let idx = if is_mods { 0 } else { 2 };
        let (decoded_stat_id, decoded_stat_name) = match header.get(idx) {
            Some(&b) => {
                let id = zig_zag_decode(b as i128) as i64;
                (Some(id), stat_guess(id))
            }
            None => (None, ""),
        };
        let operation = if i >= 6 { Some(chunk[i - 6]) } else { None };
        records.push(StatRecord {
            offset: offset_base + i,
            group_index: group,
            group_marker_hex: group_hex.clone(),
            tag: chunk[i],
            label,
            float_bytes,
            value,
            header,
            decoded_stat_id,
            decoded_stat_name,
            operation,
            component_type: String::new(),
        });
        i += 2 + string_length;
    }
    records
}

const PASSIVE_STATS: [&str; 34] = [
    "PhysicalDamage",
    "SpellDamage",
    "MaxHealth",
    "MaxEnergy",
    "HealthRegen",
    "EnergyRegen",
    "Stability",
    "CriticalHitChance",
    "Superstition",
    "IncomingDamageMod",
    "OutgoingDamageMod",
    "MagicFind",
    "Mining",
    "AttackSpeed",
    "MaxFlasks",
    "CraftingSpeed",
    "CooldownSpeed",
    "ExperienceBoost",
    "CriticalHitDamage",
    "BattleFactor",
    "ActionTimeMod",
    "PowerRank",
    "JackpotExperience",
    "GemEfficiency",
    "AdventurineGainBoost",
    "ClubExperienceBoost",
    "MaxExploration",
    "JumpSpeedMultiplier",
    "Light",
    "Dark",
    "MaxNCharge",
    "NChargeRegen",
    "MaxArmor",
    "Jump",
];

pub fn infer_component_type(stats: &[&str], values_by_stat: &HashMap<&str, Vec<f64>>) -> &'static str {
    if stats.is_empty() {
        return "";
    }
    if stats.contains(&"Glide") {
        return "Wings";
    }
    if stats.contains(&"TurningRate") || stats.contains(&"Acceleration") {
        return "Boat/Ship";
    }
    if stats.iter().all(|s| *s == "MovementSpeed") {
        if values_by_stat.get("MovementSpeed").map(|v| v.contains(&25.0)).unwrap_or(false) {
            return "Mag Rider";
        }
        return "Mount";
    }
    if stats.iter().any(|s| PASSIVE_STATS.contains(s)) {
        return "Stat Stats";
    }
    "Unknown"
}

/// Tags each record with its component's inferred type; returns `component -> type`.
pub fn classify_components(records: &mut [StatRecord]) -> IndexMap<String, &'static str> {
    struct Component<'a> {
        stats: Vec<&'a str>,
        values: HashMap<&'a str, Vec<f64>>,
        records: Vec<usize>,
    }
    let mut components: IndexMap<String, Component> = IndexMap::new();
    for (index, record) in records.iter().enumerate() {
        let key = match record.group_display() {
            g if g.is_empty() => "No component".to_string(),
            g => g,
        };
        let c = components.entry(key).or_insert_with(|| Component { stats: Vec::new(), values: HashMap::new(), records: Vec::new() });
        if !record.decoded_stat_name.is_empty() {
            c.stats.push(record.decoded_stat_name);
            c.values.entry(record.decoded_stat_name).or_default().push(record.value);
        }
        c.records.push(index);
    }
    let mut classified = IndexMap::new();
    let mut assign = Vec::new();
    for (key, c) in &components {
        let mut unique: Vec<&str> = Vec::new();
        for s in &c.stats {
            if !unique.contains(s) {
                unique.push(s);
            }
        }
        let t = infer_component_type(&unique, &c.values);
        classified.insert(key.clone(), t);
        assign.extend(c.records.iter().map(|&i| (i, t)));
    }
    for (i, t) in assign {
        records[i].component_type = t.to_string();
    }
    classified
}

/// `inspect_pet_prefab_stats_content`: where the stat block sits and what it holds.
#[derive(Debug, Clone, PartialEq)]
pub struct StatAnalysis {
    pub file: String,
    pub desc_identifier: String,
    pub ui_identifier: String,
    pub chunk_start: usize,
    pub chunk_end: usize,
    pub chunk_length: usize,
    pub records: Vec<StatRecord>,
    pub component_types: IndexMap<String, &'static str>,
    pub warnings: Vec<String>,
}

impl StatAnalysis {
    /// `summarize_records`, as JSON.
    pub fn record_summary(&self) -> Value {
        let mut visible: IndexMap<String, Vec<Value>> = IndexMap::new();
        let mut hidden = Vec::new();
        for r in &self.records {
            if r.is_unlabeled() {
                if !r.decoded_stat_name.is_empty() {
                    hidden.push(r.to_value());
                }
                continue;
            }
            let key = match r.group_display() {
                g if g.is_empty() => "No component".to_string(),
                g => g,
            };
            visible.entry(key).or_default().push(r.to_value());
        }
        let visible: Map<String, Value> = visible.into_iter().map(|(k, v)| (k, Value::Array(v))).collect();
        json!({"visible_groups": visible, "hidden_like_records": hidden})
    }

    pub fn to_value(&self) -> Value {
        json!({
            "file": self.file,
            "desc_identifier": self.desc_identifier,
            "ui_identifier": self.ui_identifier,
            "chunk_start": self.chunk_start,
            "chunk_end": self.chunk_end,
            "chunk_length": self.chunk_length,
            "records": self.records.iter().map(StatRecord::to_value).collect::<Vec<_>>(),
            "record_summary": self.record_summary(),
            "component_types": self.component_types.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<Map<String, Value>>(),
            "warnings": self.warnings,
        })
    }
}

pub fn inspect_pet_prefab_stats_content(contents: &[u8], source_name: &str) -> StatAnalysis {
    const DESC: &[u8] = b"_description";
    const UI: &[u8] = b"_UI";
    let mut a = StatAnalysis {
        file: source_name.to_string(),
        desc_identifier: String::new(),
        ui_identifier: String::new(),
        chunk_start: 0,
        chunk_end: 0,
        chunk_length: 0,
        records: Vec::new(),
        component_types: IndexMap::new(),
        warnings: Vec::new(),
    };
    let base = py::stem(if source_name.is_empty() { "prefab" } else { source_name });
    let mut desc_pos = py::find(contents, DESC, 0);
    let ui_pos = py::rfind(contents, UI);
    if desc_pos.is_none() {
        a.warnings.push("Could not locate a \"_description\" marker.".into());
        if let Some(ds) = py::find(contents, py::ascii_ignore(base.as_bytes()).as_bytes(), 0) {
            desc_pos = py::find(contents, DESC, ds);
        }
    }
    let Some(desc_pos) = desc_pos else {
        a.warnings.push("Could not locate a usable \"_description\" marker. Falling back to a full-file scan.".into());
        a.records = detect_stat_records(contents, 0);
        a.component_types = classify_components(&mut a.records);
        a.chunk_end = contents.len();
        a.chunk_length = contents.len();
        return a;
    };

    let desc_start = find_string_start(contents, desc_pos);
    let mut desc_identifier = read_length_prefixed_string_at(contents, desc_start);
    if desc_identifier.is_empty() {
        desc_identifier = py::ascii_ignore(py::slice(contents, desc_start, desc_pos + DESC.len()));
    }
    let chunk_start = desc_start + desc_identifier.len();
    let chunk_end = match ui_pos {
        Some(ui_pos) if ui_pos > desc_pos => {
            let ui_start = find_string_start(contents, ui_pos);
            let mut ui = read_length_prefixed_string_at(contents, ui_start);
            if ui.is_empty() {
                ui = py::ascii_ignore(py::slice(contents, ui_start, ui_pos + UI.len()));
            }
            a.ui_identifier = ui;
            ui_start
        }
        _ => {
            a.warnings.push("Could not locate a usable \"_UI\" marker. Using a fallback scan window.".into());
            contents.len().min(chunk_start + 4096)
        }
    };
    let mut records = detect_stat_records(py::slice(contents, chunk_start, chunk_end), chunk_start);
    if records.is_empty() {
        records = detect_stat_records(contents, 0);
    }
    a.component_types = classify_components(&mut records);
    a.records = records;
    a.desc_identifier = desc_identifier;
    a.chunk_start = chunk_start;
    a.chunk_end = chunk_end;
    a.chunk_length = chunk_end.saturating_sub(chunk_start);
    a
}

pub fn build_stat_lines(records: &[StatRecord]) -> Vec<String> {
    let mut lines = Vec::new();
    let mut seen = HashSet::new();
    for r in records {
        let stat_name = r.stat_name();
        if stat_name.is_empty() {
            continue;
        }
        let label = stat_label(&stat_name);
        let (value, percent) = get_stat_display_value(r);
        let shown = format_stat_display(value, percent);
        let line = py::strip(&format!("{} {}", shown, label)).to_string();
        if seen.insert((stat_name, shown, percent)) {
            lines.push(line);
        }
    }
    lines
}

/// `html.escape(text)` (quote=True).
pub fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
    out
}

pub fn build_tooltip_html(stat_lines: &[String], abilities: &[String]) -> String {
    if stat_lines.is_empty() && abilities.is_empty() {
        return String::new();
    }
    let mut parts = vec!["<p>Ally</p>".to_string()];
    if !stat_lines.is_empty() {
        parts.push("<ul>".into());
        parts.extend(stat_lines.iter().map(|l| format!("<li>{}</li>", html_escape(l))));
        parts.push("</ul>".into());
    }
    parts.extend(abilities.iter().map(|a| format!("<p>{}</p>", html_escape(a))));
    parts.join("\r\n")
}

fn extracted_stat_row(r: &StatRecord) -> ExtractedStat {
    let stat_name = r.stat_name();
    let (display_value, is_percent) = get_stat_display_value(r);
    let display = format_stat_display(display_value, is_percent);
    ExtractedStat {
        source: r.label_display().to_string(),
        label: stat_label(&stat_name),
        stat: stat_name,
        value: r.value,
        display_value,
        is_percent,
        value_display: display.clone(),
        display,
        group: r.group_display(),
        component_type: r.component_type.clone(),
    }
}

/// `parse_binfab_content`: stat records, abilities and display strings of one prefab.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPrefab {
    pub path: String,
    pub analysis: StatAnalysis,
    pub stat_lines: Vec<String>,
    pub tooltip: String,
    pub extracted_stats: Vec<ExtractedStat>,
    pub extracted_abilities: Vec<String>,
    pub blueprint: Option<String>,
    pub npc_path: Option<String>,
    pub strings: Vec<BinString>,
}

impl ParsedPrefab {
    pub fn records(&self) -> &[StatRecord] {
        &self.analysis.records
    }

    pub fn to_value(&self) -> Value {
        let analysis = self.analysis.to_value();
        let records = analysis["records"].clone();
        let mut m = Map::new();
        m.insert("path".into(), json!(self.path));
        m.insert("analysis".into(), analysis);
        m.insert("records".into(), records);
        m.insert("stat_lines".into(), json!(self.stat_lines));
        m.insert("tooltip".into(), json!(self.tooltip));
        m.insert("extracted_stats".into(), Value::Array(self.extracted_stats.iter().map(ExtractedStat::to_value).collect()));
        m.insert("extracted_abilities".into(), json!(self.extracted_abilities));
        m.insert("blueprint".into(), json!(self.blueprint));
        m.insert("npc_path".into(), json!(self.npc_path));
        m.insert("strings".into(), Value::Array(self.strings.iter().map(BinString::to_value).collect()));
        Value::Object(m)
    }
}

/// Parses one `.binfab`. `collection_fallbacks` is the mount/dragon variant: movement
/// stats the records lack come from the collection markers, and the display lines are
/// derived from the merged stat list.
pub fn parse_binfab_content(data: &[u8], source_name: &str, collection_fallbacks: bool) -> ParsedPrefab {
    let analysis = inspect_pet_prefab_stats_content(data, source_name);
    let strings = extract_strings(data);

    let mut blueprint = None;
    let mut npc_path = None;
    let mut abilities: Vec<String> = Vec::new();
    for entry in &strings {
        let text = &entry.text;
        let lowered = text.to_lowercase();
        if lowered.ends_with(".blueprint") || lowered.contains("_ui[") || lowered.contains("/c_c_") || lowered.starts_with("allies/") || lowered.contains("/allies/") {
            blueprint = Some(text.clone());
        } else if lowered.contains("collections/pet/") || lowered.contains("collections\\pet\\") {
            npc_path = Some(text.replace('\\', "/"));
        } else if lowered.contains("abilities/") {
            abilities.push(text.clone());
        }
    }

    let mut extracted_stats: Vec<ExtractedStat> =
        analysis.records.iter().filter(|r| !r.decoded_stat_name.is_empty()).map(extracted_stat_row).collect();

    let stat_lines = if collection_fallbacks {
        let existing: HashSet<String> = extracted_stats.iter().map(|r| r.source.clone()).collect();
        extracted_stats.extend(extract_collection_value_stats(data).into_iter().filter(|r| !existing.contains(&r.source)));
        let mut lines: Vec<String> = Vec::new();
        for row in &extracted_stats {
            let line = py::strip(&format!("{} {}", row.display, row.label)).to_string();
            if !lines.contains(&line) {
                lines.push(line);
            }
        }
        lines
    } else {
        build_stat_lines(&analysis.records)
    };

    let mut ability_ids: Vec<String> = Vec::new();
    for a in abilities {
        if !ability_ids.contains(&a) {
            ability_ids.push(a);
        }
    }

    ParsedPrefab {
        path: source_name.to_string(),
        tooltip: build_tooltip_html(&stat_lines, &[]),
        analysis,
        stat_lines,
        extracted_stats,
        extracted_abilities: ability_ids,
        blueprint,
        npc_path,
        strings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_formats() {
        assert_eq!(format_float_value(90.0), "90");
        assert_eq!(format_float_value(0.30000001192092896), "0.3");
        assert_eq!(format_float_value(-1e-7), "-0");
        assert_eq!(format_stat_display(30.000001192092896, true), "30%");
        assert_eq!(format_stat_display(2.5, true), "2.5%");
        assert_eq!(stat_label("CriticalHitDamageBonus"), "Critical Damage Bonus");
        assert_eq!(html_escape("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&#x27;");
    }

    #[test]
    fn strings_are_trimmed_to_identifiers() {
        let s = extract_strings(b"\x01\x02xx$prefabs_a_name\x00abc\x00zzcollections/pet/x\x00");
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].text, "$prefabs_a_name");
        assert_eq!(s[1].text, "collections/pet/x");
        assert_eq!((s[1].start, s[1].end), (24, 43));
    }
}
