"""Badge Codex dataset, decoded from Trove .binfab via the grounded wire reader.

Per badge (collections/badge/<id>.binfab) we extract:
  - name / description  (identity loc keys, resolved)
  - group               (the badge family, e.g. "boxesopened", "dragon_beard")
  - tier                (Bronze/Silver/Gold/Platinum/Diamond/Obsidian/Trovium, or "")
  - in_game_category    (from collections/collection_badge.binfab grouping --
                          e.g. "Boxes Opened", "Friends", "Consecutive Days")
  - mastery             (base 20 x multiplier from meta/multipliers.binfab; missing
                          row means just base, per the handoff)
  - blueprint           (model)

Per-tier mastery example (validated vs in-game): Boxes Opened sums to 240 =
20+20+20+40+40+100 (bronze/silver/gold each 20, platinum/diamond each 40 via the
multiplier-2 group, obsidian 100 via the multiplier-5 group).
"""
from __future__ import annotations

from pathlib import Path

from models.trove.prefab_ally import (
    detect_first_glyph_install,
    infer_mastery_base,
    load_language_map,
    load_multipliers_map,
    resolve_localized_value,
    read_archive_content,
)
from models.trove.prefab_recipe import build_prefab_entry_map, read_prefab_content
from utils.binfab_reader import decode_identity, harvest_strings, parse_collection_table

BADGE_PREFIX = "collections/badge/"
COLLECTION_TABLE_PATH = "collections/collection_badge"

TIER_ORDER = ["bronze", "silver", "gold", "platinum", "diamond", "obsidian", "trovium"]
_TIER_SET = set(TIER_ORDER)


def split_group_tier(stem: str) -> tuple[str, str]:
    """Split 'boxesopened_platinum' -> ('boxesopened', 'Platinum'). Returns
    (stem, '') if the trailing token isn't a known tier."""
    parts = stem.rsplit("_", 1)
    if len(parts) == 2 and parts[1] in _TIER_SET:
        return parts[0], parts[1].title()
    return stem, ""


def load_badge_category_map(prefab_index: dict) -> dict[str, str]:
    """member_id (stem) -> in-game category label from collection_badge.binfab."""
    _, content = read_prefab_content(prefab_index, COLLECTION_TABLE_PATH)
    if not content:
        return {}
    out: dict[str, str] = {}
    for group in parse_collection_table(content):
        for member in group["members"]:
            stem = Path(member.replace("\\", "/")).stem
            out.setdefault(stem, group["id"])
    return out


def compute_badge_mastery(identifier: str, multipliers: dict) -> tuple[int, int, int]:
    """Returns (base, multiplier, mastery). Missing multiplier row => base (×1)."""
    _, base = infer_mastery_base(identifier)
    row = multipliers.get(identifier)
    mult = int(row["multiplier"]) if row and row.get("multiplier") else 1
    return base, mult, base * mult


async def build_badges_dataset(game_path: Path | None = None, *, locale: str = "en") -> tuple[dict[str, dict], dict]:
    game_path = game_path or detect_first_glyph_install()
    prefab_index = build_prefab_entry_map(game_path)
    language_map = load_language_map(game_path, locale)
    multipliers = load_multipliers_map(game_path)
    category_map = load_badge_category_map(prefab_index)

    rows: dict[str, dict] = {}
    badge_lookups = [p for p in prefab_index if p.startswith(BADGE_PREFIX) and p.endswith(".binfab")]
    for lookup in sorted(badge_lookups):
        entry = prefab_index[lookup]
        archive_path = entry["tfi_path"].parent / f"archive{entry['archive_index']}.tfa"
        content = read_archive_content(archive_path)[entry["offset"]: entry["offset"] + entry["size"]]
        identifier = entry["prefab_path"].removesuffix(".binfab")
        stem = identifier.split("/")[-1]

        identity = decode_identity(content) or {}
        name = resolve_localized_value(language_map, identity.get("name_key")) or stem.replace("_", " ").title()
        desc = resolve_localized_value(language_map, identity.get("desc_key")) or ""
        blueprint = next((s for _, _, s in harvest_strings(content) if s.endswith(".blueprint")), "")

        group, tier = split_group_tier(stem)
        base, mult, mastery = compute_badge_mastery(identifier, multipliers)
        in_game_category = category_map.get(stem, "")

        rows[identifier] = {
            "name": name,
            "desc": desc,
            "group": group,
            "tier": tier,
            "in_game_category": in_game_category,
            "mastery": mastery,
            "base": base,
            "multiplier": mult,
            "blueprint": blueprint,
            "filename": identifier,
            "name_key": identity.get("name_key", ""),
        }

    tiers = sorted({r["tier"] for r in rows.values() if r["tier"]},
                   key=lambda t: TIER_ORDER.index(t.lower()) if t.lower() in TIER_ORDER else 99)
    categories = sorted({r["in_game_category"] for r in rows.values() if r["in_game_category"]})
    manifest = {
        "game_path": str(game_path),
        "badge_count": len(rows),
        "tiers": tiers,
        "in_game_categories": categories,
        "group_count": len({r["group"] for r in rows.values()}),
        "decoded_names": sum(1 for r in rows.values() if r["name"]),
        "decoded_descriptions": sum(1 for r in rows.values() if r["desc"]),
        "with_mastery": sum(1 for r in rows.values() if r["mastery"] > 0),
        "total_mastery": sum(r["mastery"] for r in rows.values()),
    }
    return rows, manifest
