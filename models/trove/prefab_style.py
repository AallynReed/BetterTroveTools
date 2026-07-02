"""Style Codex dataset, decoded from Trove .binfab via the grounded wire reader.

Verified against the live archive: styles are the ``equipment/`` appearance prefabs
(``equipment/adventure/helm_clubits_01``, ``equipment/banner/.../banner_*``, …), the
hats/faces/hair/weapons/banners shown in the in-game Styles collection. The catalogue
is ``collections/collection_equipmentappearance.binfab``; the prefab path itself is the
stable equipment id.

Per style we extract:
  - name / description   (identity loc keys, resolved)
  - family               (Hat / Face / Hair / Weapon / Banner, best-effort from the
                           stem; "" when the slot can't be inferred)
  - equipment_ref        (the prefab stem - the stable equipment id)
  - mastery / geode      (the documented EquipmentAppearance base of 1, unless a
                           multipliers row scales it; geode is opt-in -> 0/None)
  - blueprint            (model)

Mirrors the Kiwi API ``app/trove/codexes/styles.py``. Mastery is source-backed: a
multipliers row overrides, else the EquipmentAppearance base (1) - never a guess.
"""
from __future__ import annotations

from pathlib import Path

from models.trove.prefab_ally import (
    detect_first_glyph_install,
    load_geode_multipliers_map,
    load_language_map,
    load_multipliers_map,
    read_archive_content,
    resolve_localized_value,
)
from models.trove.prefab_recipe import build_prefab_entry_map
from utils.binfab_reader import decode_identity, harvest_strings

STYLE_PREFIX = "equipment/"
EQUIPMENT_APPEARANCE_BASE = 1   # EquipmentAppearance => 1 (handoff)

# Stem token -> display family. Scanned over the lowercased stem; first hit wins.
_FAMILY_TOKENS = (
    ("banner", "Banner"),
    ("helm", "Hat"),
    ("hat", "Hat"),
    ("face", "Face"),
    ("hair", "Hair"),
    ("mask", "Face"),
    ("weapon", "Weapon"),
    ("sword", "Weapon"),
    ("staff", "Weapon"),
    ("bow", "Weapon"),
    ("gun", "Weapon"),
    ("pistol", "Weapon"),
    ("spear", "Weapon"),
    ("fist", "Weapon"),
    ("axe", "Weapon"),
    ("lance", "Weapon"),
)


def equipment_id(rel: str) -> str:
    """The style's stable equipment id - its prefab stem (no dir, no .binfab)."""
    return str(rel or "").replace("\\", "/").rsplit("/", 1)[-1].removesuffix(".binfab")


def style_family(rel: str) -> str:
    """Best-effort equipment slot family from the stem (Hat/Face/Weapon/Banner), or ""."""
    stem = equipment_id(rel).lower()
    for token, label in _FAMILY_TOKENS:
        if token in stem:
            return label
    return ""


def resolve_style_mastery(rel: str, multipliers: dict[str, dict]) -> int:
    """Style mastery: a multipliers row (keyed by id, then `equipment_<id>`) overrides,
    else the EquipmentAppearance base of 1."""
    eid = equipment_id(rel)
    for key in (eid, f"equipment_{eid}"):
        row = multipliers.get(key)
        if row is not None:
            return int(row["predicted"])
    return EQUIPMENT_APPEARANCE_BASE


def resolve_style_geode_mastery(rel: str, geode_multipliers: dict[str, dict]) -> int | None:
    """Style geode mastery - opt-in membership lookup, None when unlisted."""
    eid = equipment_id(rel)
    for key in (eid, f"equipment_{eid}"):
        row = geode_multipliers.get(key)
        if row is not None:
            return int(row["predicted"])
    return None


async def build_styles_dataset(game_path: Path | None = None, *, locale: str = "en") -> tuple[dict[str, dict], dict]:
    game_path = game_path or detect_first_glyph_install()
    prefab_index = build_prefab_entry_map(game_path)
    language_map = load_language_map(game_path, locale)
    multipliers = load_multipliers_map(game_path)
    geode_multipliers = load_geode_multipliers_map(game_path)

    rows: dict[str, dict] = {}
    style_lookups = [p for p in prefab_index if p.startswith(STYLE_PREFIX) and p.endswith(".binfab")]
    for lookup in sorted(style_lookups):
        entry = prefab_index[lookup]
        archive_path = entry["tfi_path"].parent / f"archive{entry['archive_index']}.tfa"
        content = read_archive_content(archive_path)[entry["offset"]: entry["offset"] + entry["size"]]
        identifier = entry["prefab_path"].removesuffix(".binfab")
        eid = equipment_id(identifier)

        identity = decode_identity(content) or {}
        name = resolve_localized_value(language_map, identity.get("name_key")) or eid.replace("_", " ").title()
        desc = resolve_localized_value(language_map, identity.get("desc_key")) or ""
        blueprint = next((s for _, _, s in harvest_strings(content) if s.endswith(".blueprint")), "")
        family = style_family(identifier)

        rows[identifier] = {
            "name": name,
            "desc": desc,
            "category": family or (identity.get("category") or ""),
            "family": family,
            "equipment_ref": eid,
            "mastery": resolve_style_mastery(identifier, multipliers),
            "mastery_geode": resolve_style_geode_mastery(identifier, geode_multipliers),
            "blueprint": blueprint,
            "filename": identifier,
            "name_key": identity.get("name_key", ""),
        }

    families = sorted({r["family"] for r in rows.values() if r["family"]})
    manifest = {
        "game_path": str(game_path),
        "style_count": len(rows),
        "families": families,
        "decoded_names": sum(1 for r in rows.values() if r["name"]),
        "decoded_descriptions": sum(1 for r in rows.values() if r["desc"]),
        "with_geode": sum(1 for r in rows.values() if r["mastery_geode"]),
        "total_mastery": sum(r["mastery"] for r in rows.values()),
    }
    return rows, manifest
