"""Fish Codex dataset, decoded from Trove .binfab via the grounded wire reader.

Per fish (item/fish/<source>/<key>.binfab) we extract:
  - name / description  (identity loc keys, resolved)
  - source              (the liquid/biome you fish it in -- the folder name)
  - rarity              (Common/Uncommon/Rare/... -- the filename prefix, confirmed
                         against the description's leading word)
  - blueprint           (the fish model)
  - tradable            (identity field 14)
  - trophies            (basic/silver/gold deco paths, from fish/fish.binfab)
  - weight range        (min/max from meta/fishing/fishweightdata, by rarity tier)
"""
from __future__ import annotations

import struct
from pathlib import Path

from models.trove.prefab_ally import (
    detect_first_glyph_install,
    load_language_map,
    resolve_localized_value,
)
from models.trove.prefab_recipe import (
    build_prefab_entry_map,
    read_prefab_content,
)
from utils.binfab_reader import decode_identity, harvest_strings

FISH_PREFIX = "item/fish/"
CATALOGUE_PATH = "fish/fish"
WEIGHT_TABLE_PATH = "meta/fishing/fishweightdata"

# rarity order = weight-table tier order (lightest/most-common first)
RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary", "relic"]
_RARITY_SET = set(RARITY_ORDER)

# friendlier source labels (folders are the fishing liquid)
SOURCE_LABELS = {
    "water": "Water",
    "lava": "Lava",
    "chocolate": "Chocolate",
    "plasma": "Plasma",
    "enchanted": "Enchanted Water",
}


def rarity_from(filename: str, desc: str) -> str:
    """Authoritative rarity: the leading word of the localized description if it is a
    known rarity, else the rarity keyword embedded in the filename."""
    first = (desc or "").strip().split(" ", 1)[0].lower()
    if first in _RARITY_SET:
        return first.title()
    for token in str(filename or "").lower().split("_"):
        if token in _RARITY_SET:
            return token.title()
    return ""


def source_from(path: str) -> str:
    parts = str(path or "").split("/")
    folder = parts[2] if len(parts) > 3 else ""
    return SOURCE_LABELS.get(folder, folder.replace("_", " ").title())


def parse_fish_catalogue(prefab_index: dict) -> dict[str, dict]:
    """fish/fish.binfab -> {fish_item_path: {basic, silver, gold}} trophy deco paths."""
    _, content = read_prefab_content(prefab_index, CATALOGUE_PATH)
    if not content:
        return {}
    out: dict[str, dict] = {}
    current: str | None = None
    for _off, field, text in harvest_strings(content):
        if field == 0 and text.startswith(FISH_PREFIX):
            current = text
            out[current] = {}
        elif current and text.startswith("placeable/deco/trophy"):
            slot = {1: "basic", 2: "silver", 3: "gold"}.get(field)
            if slot and slot not in out[current]:
                out[current][slot] = text
    return out


def parse_fish_weight_tiers(prefab_index: dict) -> list[dict]:
    """meta/fishing/fishweightdata -> [{min, max}, ...] by rarity tier (index order).
    Each entry stores field1 (0x16) = min weight and field2 (0x26) = max weight as
    little-endian doubles (fixed64)."""
    _, content = read_prefab_content(prefab_index, WEIGHT_TABLE_PATH)
    if not content:
        return []
    tiers: list[dict] = []
    n = len(content)
    i = 0
    while i < n - 9:
        # pattern: 0x16 <8B double> ... 0x26 <8B double>
        if content[i] == 0x16 and i + 9 <= n:
            wmin = struct.unpack("<d", content[i + 1:i + 9])[0]
            j = i + 9
            # the matching max (field2, key 0x26) follows shortly after
            k = content.find(b"\x26", j, j + 4)
            if k != -1 and k + 9 <= n:
                wmax = struct.unpack("<d", content[k + 1:k + 9])[0]
                if 0 <= wmin < 100000 and 0 <= wmax < 100000:
                    tiers.append({"min": round(wmin, 3), "max": round(wmax, 3)})
                i = k + 9
                continue
        i += 1
    return tiers


async def build_fish_dataset(game_path: Path | None = None, *, locale: str = "en") -> tuple[dict[str, dict], dict]:
    game_path = game_path or detect_first_glyph_install()
    prefab_index = build_prefab_entry_map(game_path)
    language_map = load_language_map(game_path, locale)
    catalogue = parse_fish_catalogue(prefab_index)
    weight_tiers = parse_fish_weight_tiers(prefab_index)

    rows: dict[str, dict] = {}
    fish_lookups = [p for p in prefab_index if p.startswith(FISH_PREFIX) and p.endswith(".binfab")]
    for lookup in sorted(fish_lookups):
        entry = prefab_index[lookup]
        archive_path = entry["tfi_path"].parent / f"archive{entry['archive_index']}.tfa"
        from models.trove.prefab_ally import read_archive_content
        content = read_archive_content(archive_path)[entry["offset"]: entry["offset"] + entry["size"]]
        identifier = entry["prefab_path"].removesuffix(".binfab")
        filename = identifier.split("/")[-1]

        identity = decode_identity(content) or {}
        name = resolve_localized_value(language_map, identity.get("name_key")) or filename.replace("_", " ").title()
        desc = resolve_localized_value(language_map, identity.get("desc_key")) or ""
        blueprint = next((s for _, _, s in harvest_strings(content) if s.endswith(".blueprint")), "")

        rarity = rarity_from(filename, desc)
        tier = RARITY_ORDER.index(rarity.lower()) if rarity.lower() in RARITY_ORDER else None
        weight = weight_tiers[tier] if (tier is not None and tier < len(weight_tiers)) else {}
        trophies = catalogue.get(identifier, {})

        rows[identifier] = {
            "name": name,
            "desc": desc,
            "source": source_from(identifier),
            "rarity": rarity,
            "blueprint": blueprint,
            "tradable": identity.get("tradable"),
            "filename": identifier,
            "weight_min": weight.get("min"),
            "weight_max": weight.get("max"),
            "trophies": trophies,
            "name_key": identity.get("name_key", ""),
        }

    sources = sorted({r["source"] for r in rows.values() if r["source"]})
    rarities = sorted({r["rarity"] for r in rows.values() if r["rarity"]},
                      key=lambda r: RARITY_ORDER.index(r.lower()) if r.lower() in RARITY_ORDER else 99)
    manifest = {
        "game_path": str(game_path),
        "fish_count": len(rows),
        "sources": sources,
        "rarities": rarities,
        "decoded_names": sum(1 for r in rows.values() if r["name"]),
        "decoded_descriptions": sum(1 for r in rows.values() if r["desc"]),
        "with_blueprint": sum(1 for r in rows.values() if r["blueprint"]),
        "with_trophies": sum(1 for r in rows.values() if r["trophies"]),
        "with_weight": sum(1 for r in rows.values() if r["weight_min"] is not None),
        "weight_tiers": weight_tiers,
    }
    return rows, manifest
