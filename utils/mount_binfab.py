from __future__ import annotations

import html
import json
import math
import re
import struct
from pathlib import Path


ASCII_STRING_RE = re.compile(rb"[ -~]{4,}")
ALLOWED_STRING_RE = re.compile(r"^[A-Za-z0-9_/\.\$\-]+$")
TOOLTIP_LI_RE = re.compile(r"<li>(.*?)</li>", re.IGNORECASE | re.DOTALL)
TOOLTIP_P_RE = re.compile(r"<p>(.*?)</p>", re.IGNORECASE | re.DOTALL)

STAT_GUESSES = {
    0x00: "PhysicalDamage",
    0x01: "SpellDamage",
    0x02: "MaxHealth",
    0x03: "MaxEnergy",
    0x04: "HealthRegen",
    0x05: "EnergyRegen",
    0x06: "Stability",
    0x07: "CriticalHitChance",
    0x08: "MovementSpeed",
    0x09: "Jump",
    0x0A: "Superstition",
    0x0B: "IncomingDamageMod",
    0x0C: "OutgoingDamageMod",
    0x0D: "MagicFind",
    0x0E: "Mining",
    0x0F: "AttackSpeed",
    0x10: "MaxFlasks",
    0x11: "CraftingSpeed",
    0x12: "CooldownSpeed",
    0x13: "Acceleration",
    0x14: "TurningRate",
    0x15: "ExperienceBoost",
    0x16: "CriticalHitDamage",
    0x17: "BattleFactor",
    0x18: "ActionTimeMod",
    0x19: "PowerRank",
    0x1A: "Glide",
    0x1B: "ShootProjectileSpeedMultiplier",
    0x1C: "RedGemStatBoost",
    0x1D: "BlueGemStatBoost",
    0x1E: "YellowGemStatBoost",
    0x1F: "DoubleHitChance",
    0x20: "JackpotExperience",
    0x21: "GemEfficiency",
    0x22: "AdventurineGainBoost",
    0x23: "ClubExperienceBoost",
    0x24: "MaxExploration",
    0x25: "JumpSpeedMultiplier",
    0x26: "GreenGemStatBoost",
    0x27: "Light",
    0x28: "Dark",
    0x29: "OpalGemStatBoost",
    0x2A: "MaxNCharge",
    0x2B: "NChargeRegen",
    0x2C: "MaxArmor",
}

STAT_LABELS = {
    "PhysicalDamage": "Physical Damage",
    "SpellDamage": "Magic Damage",
    "MaxHealth": "Maximum Health",
    "MaxEnergy": "Maximum Energy",
    "HealthRegen": "Health Regen",
    "EnergyRegen": "Energy Regen",
    "Stability": "Stability",
    "CriticalHitChance": "Critical Hit",
    "MovementSpeed": "Movement Speed",
    "Jump": "Jump",
    "Superstition": "Lasermancy",
    "IncomingDamageMod": "Incoming Damage",
    "OutgoingDamageMod": "Damage",
    "MagicFind": "Magic Find",
    "Mining": "Lasermancy",
    "AttackSpeed": "Attack Speed",
    "MaxFlasks": "Flask Capacity",
    "CraftingSpeed": "Crafting Speed",
    "CooldownSpeed": "Cooldown Speed",
    "Acceleration": "Acceleration",
    "TurningRate": "Turning Rate",
    "ExperienceBoost": "Experience Boost",
    "CriticalHitDamage": "Critical Damage",
    "BattleFactor": "Battle Factor",
    "ActionTimeMod": "Action Time Mod",
    "PowerRank": "Power Rank",
    "Glide": "Glide",
    "ShootProjectileSpeedMultiplier": "Projectile Speed",
    "RedGemStatBoost": "Red Gem Stat Boost",
    "BlueGemStatBoost": "Blue Gem Stat Boost",
    "YellowGemStatBoost": "Yellow Gem Stat Boost",
    "DoubleHitChance": "Double Hit",
    "JackpotExperience": "Jackpot Experience",
    "GemEfficiency": "Gem Efficiency",
    "AdventurineGainBoost": "Adventurine",
    "ClubExperienceBoost": "Club Experience Boost",
    "MaxExploration": "Maximum Exploration",
    "JumpSpeedMultiplier": "Jump Speed",
    "GreenGemStatBoost": "Green Gem Stat Boost",
    "Light": "Light",
    "Dark": "Dark",
    "OpalGemStatBoost": "Opal Gem Stat Boost",
    "MaxNCharge": "Maximum N-Charge",
    "NChargeRegen": "N-Charge Regen",
    "MaxArmor": "Maximum Armor",
}

PERCENT_STATS = {
    "CriticalHitChance",
    "AttackSpeed",
    "IncomingDamageMod",
    "OutgoingDamageMod",
    "CriticalHitDamage",
    "ExperienceBoost",
    "JackpotExperience",
    "GemEfficiency",
    "AdventurineGainBoost",
    "ClubExperienceBoost",
    "JumpSpeedMultiplier",
    "ShootProjectileSpeedMultiplier",
    "DoubleHitChance",
    "CooldownSpeed",
}

PERCENT_CAPABLE_STATS = PERCENT_STATS | {
    "HealthRegen",
    "EnergyRegen",
    "MagicFind",
    "Mining",
    "PhysicalDamage",
    "SpellDamage",
    "MaxHealth",
    "MaxEnergy",
    "RedGemStatBoost",
    "BlueGemStatBoost",
    "YellowGemStatBoost",
    "GreenGemStatBoost",
    "OpalGemStatBoost",
}


def _clean_ascii_string(raw: bytes) -> str:
    text = raw.decode("ascii", errors="ignore")
    if "$" in text and not text.startswith("$"):
        text = text[text.find("$") :]
    else:
        known_prefixes = (
            "collections/",
            "abilities/",
            "allies/",
            "mounts/",
            "pets/",
            "item/",
            "equipment/",
            "prefabs_",
            "C_C_",
            "C_MT_",
            "c_c_",
            "c_mt_",
        )
        for prefix in known_prefixes:
            index = text.find(prefix)
            if index > 0:
                text = text[index:]
                break
    return text.strip()


def _clean_html_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(" ".join(text.split())).strip()


def parse_tooltip(tooltip_html: str) -> dict:
    tooltip_html = tooltip_html or ""
    stats = [_clean_html_text(match) for match in TOOLTIP_LI_RE.findall(tooltip_html) if _clean_html_text(match)]
    paragraphs = [_clean_html_text(match) for match in TOOLTIP_P_RE.findall(tooltip_html) if _clean_html_text(match)]
    abilities = [p for p in paragraphs if p.lower() != "ally"]
    return {"stats": stats, "abilities": abilities}


def extract_strings(data: bytes) -> list[dict]:
    entries = []
    for match in ASCII_STRING_RE.finditer(data):
        cleaned = _clean_ascii_string(match.group())
        if cleaned:
            entries.append({"text": cleaned, "start": match.start(), "end": match.end()})
    return entries


def decode_little_endian_float(raw: bytes) -> float | None:
    if len(raw) != 4:
        return None
    value = struct.unpack("<f", raw)[0]
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def format_float_value(value: float | None) -> str:
    if value is None:
        return ""
    if abs(value - int(value)) < 1e-9:
        return str(int(value))
    return f"{value:.6f}".rstrip("0").rstrip(".")


def is_percent_encoded(record: dict) -> bool:
    header = record.get("header_bytes_array") or []
    label = str(record.get("label") or "")
    value = abs(record.get("value", 0))
    stat_name = record.get("decoded_stat_name") or ""
    
    if label.endswith("mods"):
        if len(header) > 2 and header[2] == 0 and value <= 1.0:
            return True
        return False
    
    # For non-mods labels, check header[4] for percent encoding
    if len(header) > 4 and header[4] == 0 and value <= 1.0:
        return True
    
    # For bonus stats with small values that belong in percent-capable stats
    # This catches cases where a 0.02-0.5 value is a percentage bonus (e.g., 2-50%)
    # But exclude pure additive stats like MovementSpeed, Jump, Glide which are small but absolute
    if stat_name in PERCENT_CAPABLE_STATS and 0 < value <= 1.0:
        # These stats are typically additive/absolute, not percentages
        additive_only = {"MovementSpeed", "Jump", "Glide", "Light", "Dark", "Acceleration", "TurningRate"}
        if stat_name not in additive_only and value < 0.5:
            return True
    
    return False


def get_stat_display_value(record: dict) -> tuple[float, bool]:
    stat_name = record.get("decoded_stat_name") or ""
    value = float(record.get("value", 0))
    header = record.get("header_bytes_array") or []
    label = str(record.get("label") or "")
    component_type = record.get("component_type") or ""

    if stat_name == "IncomingDamageMod":
        if len(header) > 4 and header[4] == 8:
            return value - 1.0, True
        if label.endswith("mods") and len(header) > 2 and header[2] == 8:
            return value - 1.0, True

    if label.endswith("mods") and len(header) > 2 and header[2] == 2 and value > 1:
        if stat_name == "CriticalHitChance":
            return value / 1000.0, True
        if stat_name in PERCENT_STATS:
            return value / 100.0, True

    # Mount and dragon passive stat components often store these three stats as
    # whole-number percentages directly (e.g. 3, 5, 10) rather than a fractional
    # value or the older *_mods encoding.
    if component_type == "Stat Stats" and value > 0:
        if stat_name in {"CriticalHitChance", "AttackSpeed", "CriticalHitDamage"}:
            return value / 100.0, True

    if stat_name == "IncomingDamageMod" and len(header) > 4 and header[4] == 8:
        return value - 1.0, True

    percent_encoded = is_percent_encoded(record) and stat_name in PERCENT_CAPABLE_STATS
    return value, percent_encoded


def format_stat_display(value: float, stat_name: str, *, is_percent: bool = False) -> str:
    if is_percent:
        display_value = value * 100
        if abs(display_value - round(display_value)) < 1e-9:
            return f"{int(round(display_value))}%"
        return f"{display_value:.1f}".rstrip("0").rstrip(".") + "%"
    return format_float_value(value)


def zig_zag_decode(value: int) -> int:
    return (value >> 1) ^ (-(value & 1))


def find_string_start(contents: bytes, marker_pos: int) -> int:
    start = marker_pos
    while start > 0:
        char = chr(contents[start - 1])
        if not re.match(r"[A-Za-z0-9_/\.\$\-]", char):
            break
        start -= 1
    return start


def read_length_prefixed_string_at(contents: bytes, start: int) -> str:
    if start <= 0:
        return ""
    length = contents[start - 1]
    if length <= 0:
        return ""
    value = contents[start : start + length]
    if len(value) != length:
        return ""
    text = value.decode("ascii", errors="ignore")
    if not ALLOWED_STRING_RE.fullmatch(text):
        return ""
    return text


def guess_stat_from_header(header_bytes: bytes) -> str:
    guesses = []
    for value in header_bytes:
        if value in STAT_GUESSES:
            guesses.append(f"0x{value:02X} {STAT_GUESSES[value]}")
    return " | ".join(dict.fromkeys(guesses))


def summarize_records(records: list[dict]) -> dict:
    summary = {"visible_groups": {}, "hidden_like_records": []}
    for record in records:
        group_key = record["group_display"] or "No component"
        if record["is_unlabeled"]:
            if record["decoded_stat_name"]:
                summary["hidden_like_records"].append(record)
            continue
        summary["visible_groups"].setdefault(group_key, []).append(record)
    return summary


def infer_component_type(stats: list[str], values_by_stat: dict[str, list[float]]) -> str:
    if not stats:
        return ""
    if "Glide" in stats:
        return "Wings"
    if "TurningRate" in stats or "Acceleration" in stats:
        return "Boat/Ship"
    if set(stats).issubset({"MovementSpeed"}) and "MovementSpeed" in stats:
        if any(float(value) == 25.0 for value in values_by_stat.get("MovementSpeed", [])):
            return "Mag Rider"
        return "Mount"
    passive_stats = {
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
    }
    if passive_stats.intersection(stats):
        return "Stat Stats"
    return "Unknown"


def classify_components(records: list[dict]) -> dict[str, str]:
    components: dict[str, dict] = {}
    for index, record in enumerate(records):
        component_key = record["group_display"] or "No component"
        component = components.setdefault(component_key, {"stats": [], "values_by_stat": {}, "records": []})
        if record["decoded_stat_name"]:
            component["stats"].append(record["decoded_stat_name"])
            component["values_by_stat"].setdefault(record["decoded_stat_name"], []).append(record["value"])
        component["records"].append(index)

    classified = {}
    for component_key, component in components.items():
        unique_stats = list(dict.fromkeys(component["stats"]))
        component_type = infer_component_type(unique_stats, component["values_by_stat"])
        classified[component_key] = component_type
        for record_index in component["records"]:
            records[record_index]["component_type"] = component_type
    return classified


def detect_stat_records(chunk: bytes, offset_base: int) -> list[dict]:
    records = []
    length = len(chunk)
    default_stat_byte_index = 2
    current_group_index = None
    current_group_marker_hex = ""
    i = 0

    while i < length:
        if (
            i + 4 <= length
            and chunk[i] == 0xAE
            and chunk[i + 2] == 0x00
            and chunk[i + 3] == 0x04
        ):
            group_byte = chunk[i + 1]
            if 0 < group_byte < 32:
                current_group_index = group_byte
                marker_start = max(0, i - 2)
                marker_end = marker_start + min(6, length - marker_start)
                current_group_marker_hex = chunk[marker_start:marker_end].hex().upper()

        if chunk[i] != 0x38 or i + 1 >= length:
            i += 1
            continue

        string_length = chunk[i + 1]
        if i + 2 + string_length > length:
            i += 1
            continue

        label_bytes = chunk[i + 2 : i + 2 + string_length]
        label = label_bytes.decode("ascii", errors="ignore")
        if string_length > 0:
            if not ALLOWED_STRING_RE.fullmatch(label):
                i += 1
                continue
            if "_" not in label and not label.endswith("mods"):
                i += 1
                continue

        if i < 4:
            i += 1
            continue

        float_bytes = chunk[i - 4 : i]
        value = decode_little_endian_float(float_bytes)
        if value is None or abs(value) > 1_000_000:
            i += 1
            continue

        post_label_pos = i + 2 + string_length
        is_mods_label = label.endswith("mods") and post_label_pos < length and chunk[post_label_pos] == 0x46
        if not is_mods_label:
            if post_label_pos >= length or chunk[post_label_pos] != 0x46:
                i += 1
                continue

        header_start = max(0, i - (8 if is_mods_label else 10))
        header_end = i - 4
        header_bytes = chunk[header_start:header_end]
        header_array = list(header_bytes)
        decoded_stat_id = None
        decoded_stat_id_hex = ""
        decoded_stat_name = ""
        stat_byte_index = 0 if is_mods_label else default_stat_byte_index
        if len(header_array) > stat_byte_index:
            decoded_stat_id = zig_zag_decode(header_array[stat_byte_index])
            decoded_stat_id_hex = f"0x{decoded_stat_id:02X}"
            decoded_stat_name = STAT_GUESSES.get(decoded_stat_id, "")

        is_unlabeled = label == ""
        records.append(
            {
                "offset": offset_base + i,
                "group_index": current_group_index,
                "group_display": "" if current_group_index is None else f"Component {current_group_index}",
                "group_marker_hex": current_group_marker_hex,
                "tag_hex": f"{chunk[i]:02X}",
                "label": label if label else "[no label]",
                "float_hex": float_bytes.hex().upper(),
                "value": value,
                "value_display": format_float_value(value),
                "header_hex": header_bytes.hex().upper(),
                "header_decoded": ", ".join(str(part) for part in header_array),
                "header_bytes_array": header_array,
                "decoded_stat_id": decoded_stat_id,
                "decoded_stat_id_hex": decoded_stat_id_hex,
                "decoded_stat_name": decoded_stat_name,
                "is_unlabeled": is_unlabeled,
                "record_style": "unlabeled" if is_unlabeled else "labeled",
                "header_guess": guess_stat_from_header(header_bytes),
                "component_type": "",
            }
        )
        i += 2 + string_length

    return records


def inspect_pet_prefab_stats_content(contents: bytes, source_name: str = "") -> dict:
    analysis = {
        "file": str(source_name),
        "desc_identifier": "",
        "ui_identifier": "",
        "chunk_start": 0,
        "chunk_end": 0,
        "chunk_length": 0,
        "records": [],
        "record_summary": {},
        "component_types": {},
        "warnings": [],
    }

    base = Path(source_name or "prefab").stem
    desc_marker = b"_description"
    ui_marker = b"_UI"

    desc_pos = contents.find(desc_marker)
    ui_pos = contents.rfind(ui_marker)

    if desc_pos < 0:
        analysis["warnings"].append('Could not locate a "_description" marker.')
        desc_start = contents.find(base.encode("ascii", errors="ignore"))
        if desc_start >= 0:
            desc_pos = contents.find(desc_marker, desc_start)

    if desc_pos < 0:
        analysis["warnings"].append('Could not locate a usable "_description" marker. Falling back to a full-file scan.')
        records = detect_stat_records(contents, 0)
        record_summary = summarize_records(records)
        component_types = classify_components(records)
        analysis.update(
            {
                "chunk_start": 0,
                "chunk_end": len(contents),
                "chunk_length": len(contents),
                "records": records,
                "record_summary": record_summary,
                "component_types": component_types,
            }
        )
        return analysis

    desc_start = find_string_start(contents, desc_pos)
    desc_identifier = read_length_prefixed_string_at(contents, desc_start)
    if not desc_identifier:
        desc_identifier = contents[desc_start : desc_pos + len(desc_marker)].decode("ascii", errors="ignore")

    chunk_start = desc_start + len(desc_identifier)
    ui_identifier = ""
    if ui_pos > desc_pos:
        ui_start = find_string_start(contents, ui_pos)
        ui_identifier = read_length_prefixed_string_at(contents, ui_start)
        if not ui_identifier:
            ui_identifier = contents[ui_start : ui_pos + len(ui_marker)].decode("ascii", errors="ignore")
        chunk_end = ui_start
    else:
        analysis["warnings"].append('Could not locate a usable "_UI" marker. Using a fallback scan window.')
        chunk_end = min(len(contents), chunk_start + 4096)

    chunk = contents[chunk_start:chunk_end]
    records = detect_stat_records(chunk, chunk_start)
    if not records:
        records = detect_stat_records(contents, 0)
    record_summary = summarize_records(records)
    component_types = classify_components(records)

    analysis.update(
        {
            "desc_identifier": desc_identifier,
            "ui_identifier": ui_identifier,
            "chunk_start": chunk_start,
            "chunk_end": chunk_end,
            "chunk_length": max(0, chunk_end - chunk_start),
            "records": records,
            "record_summary": record_summary,
            "component_types": component_types,
        }
    )
    return analysis


def inspect_pet_prefab_stats(path: str | Path) -> dict:
    path = Path(path)
    return inspect_pet_prefab_stats_content(path.read_bytes(), str(path))


def build_stat_lines(records: list[dict]) -> list[str]:
    lines = []
    seen = set()
    for record in records:
        stat_name = record.get("decoded_stat_name") or ""
        if not stat_name:
            continue
        label = STAT_LABELS.get(stat_name, stat_name)
        display_value, percent_encoded = get_stat_display_value(record)
        value_display = format_stat_display(display_value, stat_name, is_percent=percent_encoded)
        line = f"{value_display} {label}".strip()
        key = (stat_name, value_display, percent_encoded)
        if key in seen:
            continue
        seen.add(key)
        lines.append(line)
    return lines


def build_tooltip_html(stat_lines: list[str], abilities: list[str]) -> str:
    if not stat_lines and not abilities:
        return ""
    parts = ["<p>Ally</p>"]
    if stat_lines:
        parts.append("<ul>")
        parts.extend(f"<li>{html.escape(line)}</li>" for line in stat_lines)
        parts.append("</ul>")
    parts.extend(f"<p>{html.escape(ability)}</p>" for ability in abilities)
    return "\r\n".join(parts)


def parse_ally_binfab_content(data: bytes, source_name: str = "") -> dict:
    analysis = inspect_pet_prefab_stats_content(data, source_name)
    strings = extract_strings(data)

    blueprint = None
    npc_path = None
    abilities = []
    for entry in strings:
        text = entry["text"]
        lowered = text.lower()
        if lowered.endswith(".blueprint"):
            blueprint = text
        elif "_ui[" in lowered or "/c_c_" in lowered or lowered.startswith("allies/") or "/allies/" in lowered:
            blueprint = text
        elif "collections/pet/" in lowered or "collections\\pet\\" in lowered:
            npc_path = text.replace("\\", "/")
        elif "abilities/" in lowered:
            abilities.append(text)

    stat_lines = build_stat_lines(analysis["records"])
    ability_ids = list(dict.fromkeys(abilities))

    return {
        "path": str(source_name),
        "analysis": analysis,
        "records": analysis["records"],
        "stat_lines": stat_lines,
        "tooltip": build_tooltip_html(stat_lines, []),
        "extracted_stats": [
            {
                "source": record["label"],
                "stat": record["decoded_stat_name"],
                "label": STAT_LABELS.get(record["decoded_stat_name"], record["decoded_stat_name"]),
                "value": record["value"],
                "display_value": get_stat_display_value(record)[0],
                "is_percent": get_stat_display_value(record)[1],
                "value_display": format_stat_display(
                    get_stat_display_value(record)[0],
                    record["decoded_stat_name"],
                    is_percent=get_stat_display_value(record)[1],
                ),
                "display": format_stat_display(
                    get_stat_display_value(record)[0],
                    record["decoded_stat_name"],
                    is_percent=get_stat_display_value(record)[1],
                ),
                "group": record.get("group_display", ""),
                "component_type": record.get("component_type", ""),
            }
            for record in analysis["records"]
            if record["decoded_stat_name"]
        ],
        "extracted_abilities": ability_ids,
        "blueprint": blueprint,
        "npc_path": npc_path,
        "strings": strings,
    }


def parse_ally_binfab(path: str | Path) -> dict:
    path = Path(path)
    return parse_ally_binfab_content(path.read_bytes(), str(path))


def resolve_ally_binfab(path: str | Path, allies_data: dict, ally_key: str) -> dict:
    parsed = parse_ally_binfab(path)
    ally = allies_data.get(ally_key, {})
    tooltip = parse_tooltip(ally.get("tooltip", ""))
    return {
        "ally_key": ally_key,
        "ally_name": ally.get("name", ally_key),
        "path": parsed["path"],
        "records": parsed["records"],
        "stat_lines": parsed["stat_lines"],
        "tooltip": parsed["tooltip"],
        "extracted_stats": parsed["extracted_stats"],
        "extracted_abilities": parsed["extracted_abilities"],
        "blueprint": parsed["blueprint"],
        "npc_path": parsed["npc_path"],
        "expected_result": {
            "source": "allies.json tooltip",
            "stats": tooltip["stats"],
            "abilities": tooltip["abilities"],
        },
        "analysis": parsed["analysis"],
    }


def load_allies_json(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))
