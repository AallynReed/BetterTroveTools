from __future__ import annotations

import html
import json
import re
import struct
from pathlib import Path


ASCII_STRING_RE = re.compile(rb"[ -~]{4,}")
TOOLTIP_LI_RE = re.compile(r"<li>(.*?)</li>", re.IGNORECASE | re.DOTALL)
TOOLTIP_P_RE = re.compile(r"<p>(.*?)</p>", re.IGNORECASE | re.DOTALL)


def _clean_ascii_string(raw: bytes) -> str:
    text = raw.decode("ascii", errors="ignore")
    text = re.sub(r"^[^A-Za-z$]+", "", text)
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
            entries.append(
                {
                    "text": cleaned,
                    "start": match.start(),
                    "end": match.end(),
                }
            )
    return entries


def _read_float_before(data: bytes, string_start: int) -> float | None:
    if string_start < 6:
        return None
    raw = data[string_start - 6:string_start - 2]
    if len(raw) != 4:
        return None
    value = struct.unpack("<f", raw)[0]
    if not (-1_000_000.0 < value < 1_000_000.0):
        return None
    return value


def _is_stat_identifier(text: str) -> bool:
    lowered = text.lower()
    return "mods" in lowered or lowered.startswith("pet\\") or lowered.startswith("pet/")


def _is_ability_identifier(text: str) -> bool:
    return "abilities/" in text.lower()


def format_stat_value(value: float) -> str:
    if abs(value) < 1 and value != int(value):
        pct = value * 100
        return f"{pct:.1f}".rstrip("0").rstrip(".") + "%"
    if abs(value - round(value)) < 1e-6:
        return str(int(round(value)))
    return f"{value:.3f}".rstrip("0").rstrip(".")


def parse_ally_binfab(path: str | Path) -> dict:
    path = Path(path)
    data = path.read_bytes()
    strings = extract_strings(data)

    stats = []
    abilities = []
    blueprint = None
    npc_path = None

    for entry in strings:
        text = entry["text"]
        lowered = text.lower()
        if _is_stat_identifier(text):
            value = _read_float_before(data, entry["start"])
            if value is not None:
                stats.append(
                    {
                        "source": text.rstrip("F"),
                        "value": value,
                        "value_display": format_stat_value(value),
                    }
                )
        elif _is_ability_identifier(text):
            abilities.append(text)
        elif lowered.endswith(".blueprint"):
            blueprint = text
        elif "collections/pet/" in lowered:
            npc_path = text

    return {
        "path": str(path),
        "extracted_stats": stats,
        "extracted_abilities": abilities,
        "blueprint": blueprint,
        "npc_path": npc_path,
        "strings": strings,
    }


def resolve_ally_binfab(path: str | Path, allies_data: dict, ally_key: str) -> dict:
    parsed = parse_ally_binfab(path)
    ally = allies_data.get(ally_key, {})
    tooltip = parse_tooltip(ally.get("tooltip", ""))

    return {
        "ally_key": ally_key,
        "ally_name": ally.get("name", ally_key),
        "extracted_stats": parsed["extracted_stats"],
        "extracted_abilities": parsed["extracted_abilities"],
        "blueprint": parsed["blueprint"],
        "npc_path": parsed["npc_path"],
        "expected_result": {
            "source": "allies.json tooltip",
            "stats": tooltip["stats"],
            "abilities": tooltip["abilities"],
        },
    }


def load_allies_json(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))
