from __future__ import annotations

from pathlib import Path

from models.trove.prefab_ally import (
    detect_first_glyph_install,
    load_blueprint_path_map,
    load_language_map,
    read_archive_content,
)
from models.trove.prefab_recipe import build_prefab_entry_map, extract_prefab_metadata
from utils.binfab_reader import decode_identity


ITEM_PREFIX = "item/"
COLLECTION_PREFIX = "collections/"


def category_from_item_path(identifier: str) -> str:
    normalized = str(identifier or "").replace("\\", "/").strip().lower()
    if normalized.startswith("item/pet/"):
        return "Ally"
    if normalized.startswith("item/mount/"):
        return "Mount"
    if normalized.startswith("item/unlocker/"):
        return "Unlocker"
    if normalized.startswith("item/companion/"):
        return "Companion"
    if normalized.startswith("item/consumable/"):
        parts = normalized.split("/")
        if len(parts) >= 3 and parts[2]:
            return parts[2].replace("_", " ").title()
        return "Consumable"
    parts = normalized.split("/")
    if len(parts) >= 2 and parts[1]:
        return parts[1].replace("_", " ").title()
    return "Item"


def tradability_from_item_path(identifier: str) -> str:
    normalized = str(identifier or "").replace("\\", "/").strip().lower()
    stem = Path(normalized).stem
    if stem.endswith("_notrade"):
        return "Untradable"
    if stem.endswith("_trade"):
        return "Tradable"
    return ""


def tradability_from_item_content(content: bytes, identifier: str = "") -> str:
    # Grounded: tradability is identity-component field 14 (== 2 means Tradable),
    # read via the exe-derived wire format. Falls back to the old marker/byte scan
    # and finally the _trade/_notrade filename convention.
    identity = decode_identity(content)
    if identity and identity.get("tradable") is not None:
        return "Tradable" if identity["tradable"] else "Untradable"
    marker = b"\xE0\x01"
    pos = content.find(marker)
    if pos != -1 and pos + len(marker) < len(content):
        flag = content[pos + len(marker)]
        return "Tradable" if flag == 0x02 else "Untradable"
    return tradability_from_item_path(identifier)


def extract_unlocks(strings: list[str], identifier: str) -> list[str]:
    normalized_identifier = str(identifier or "").replace("\\", "/").strip().lower()
    unlocks = []
    seen = set()
    for text in strings:
        normalized = str(text or "").replace("\\", "/").strip()
        lowered = normalized.lower()
        if not lowered.startswith(COLLECTION_PREFIX):
            continue
        if lowered == normalized_identifier:
            continue
        if normalized not in seen:
            seen.add(normalized)
            unlocks.append(normalized)
    return unlocks


def resolve_unlock_entries(
    unlock_paths: list[str],
    prefab_index: dict[str, dict],
    language_map: dict[str, str],
    blueprint_map: dict[str, object],
    meta_cache: dict[str, dict],
) -> list[dict]:
    rows = []
    for unlock_path in unlock_paths:
        normalized = str(unlock_path or "").replace("\\", "/").strip().removesuffix(".binfab")
        if not normalized:
            continue
        cache_key = normalized.lower()
        cached = meta_cache.get(cache_key)
        if cached is None:
            lookup_key = f"{normalized}.binfab".lower()
            entry = prefab_index.get(lookup_key)
            if entry:
                archive_path = entry["tfi_path"].parent / f"archive{entry['archive_index']}.tfa"
                archive_content = read_archive_content(archive_path)
                start = entry["offset"]
                end = start + entry["size"]
                content = archive_content[start:end]
                cached = extract_prefab_metadata(normalized, content, language_map, blueprint_map)
            else:
                cached = {"name": Path(normalized).stem.replace("_", " ").title()}
            meta_cache[cache_key] = cached
        rows.append(
            {
                "path": normalized,
                "name": cached.get("name") or Path(normalized).stem.replace("_", " ").title(),
            }
        )
    return rows


def build_item_record(
    identifier: str,
    content: bytes,
    prefab_index: dict[str, dict],
    language_map: dict[str, str],
    blueprint_map: dict[str, object],
    meta_cache: dict[str, dict],
) -> dict:
    metadata = extract_prefab_metadata(identifier, content, language_map, blueprint_map)
    strings = metadata.get("strings", [])
    unlock_paths = extract_unlocks(strings, identifier)
    unlocks = resolve_unlock_entries(unlock_paths, prefab_index, language_map, blueprint_map, meta_cache)
    return {
        "name": metadata.get("name", "") or Path(identifier).stem.replace("_", " ").title(),
        "desc": metadata.get("desc", ""),
        "category": category_from_item_path(identifier),
        "tradability": tradability_from_item_content(content, identifier),
        "designer": metadata.get("designer", "Trove Team"),
        "filename": identifier,
        "blueprint": metadata.get("blueprint", ""),
        "name_key": metadata.get("name_key", ""),
        "desc_key": metadata.get("desc_key", ""),
        "lootbox": b"LootTable" in content,
        "decay": b"quantitydecay" in content,
        "unlocks": unlocks,
    }


async def build_items_dataset(
    game_path: Path | None = None,
    *,
    locale: str = "en",
) -> tuple[dict[str, dict], dict[str, object]]:
    game_path = game_path or detect_first_glyph_install()
    prefab_index = build_prefab_entry_map(game_path)
    language_map = load_language_map(game_path, locale)
    blueprint_map = load_blueprint_path_map(game_path)
    meta_cache: dict[str, dict] = {}

    rows: dict[str, dict] = {}
    total_unlocks = 0

    item_paths = [path for path in prefab_index.keys() if path.startswith(ITEM_PREFIX) and path.endswith(".binfab")]
    for item_lookup in sorted(item_paths):
        entry = prefab_index[item_lookup]
        archive_path = entry["tfi_path"].parent / f"archive{entry['archive_index']}.tfa"
        archive_content = read_archive_content(archive_path)
        start = entry["offset"]
        end = start + entry["size"]
        content = archive_content[start:end]
        identifier = entry["prefab_path"].removesuffix(".binfab")
        record = build_item_record(identifier, content, prefab_index, language_map, blueprint_map, meta_cache)
        total_unlocks += len(record["unlocks"])
        rows[identifier] = record

    manifest = {
        "game_path": str(game_path),
        "item_count": len(rows),
        "decoded_names": sum(1 for row in rows.values() if row.get("name")),
        "decoded_descriptions": sum(1 for row in rows.values() if row.get("desc")),
        "decoded_blueprints": sum(1 for row in rows.values() if row.get("blueprint")),
        "with_unlocks": sum(1 for row in rows.values() if row.get("unlocks")),
        "lootboxes": sum(1 for row in rows.values() if row.get("lootbox")),
        "decay_items": sum(1 for row in rows.values() if row.get("decay")),
        "with_tradability": sum(1 for row in rows.values() if row.get("tradability")),
        "total_unlocks": total_unlocks,
    }
    return rows, manifest
