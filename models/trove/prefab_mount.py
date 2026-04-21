from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

from models.trove.prefab_ally import (
    clean_localized_text,
    detect_first_glyph_install,
    extract_designer_from_blueprint,
    infer_mastery_base,
    iter_index_entries,
    load_blueprint_path_map,
    load_language_map,
    load_multiplier_file_map,
    parse_item_pet_signature,
    read_archive_content,
    require_prefabs_root,
    resolve_blueprint_catalog_path,
    resolve_localized_value,
)
from utils.mount_binfab import extract_strings, parse_ally_binfab_content


MOUNT_PREFIX = "collections/mount/"
ITEM_MOUNT_PREFIX = "item/mount/"
MOUNT_NAME_KEY_RE = re.compile(r"(\$prefabs_[A-Za-z0-9_]+(?:_item)?_name)")
MOUNT_DESCRIPTION_KEY_RE = re.compile(r"(\$prefabs_[A-Za-z0-9_]+(?:_description|_desc))")


def mount_key_from_prefab_path(prefab_path: str) -> str:
    normalized = prefab_path.replace("\\", "/")
    if normalized.lower().startswith(MOUNT_PREFIX):
        normalized = normalized[len(MOUNT_PREFIX):]
    return Path(normalized).stem


def item_mount_key_from_prefab_path(prefab_path: str) -> str:
    key = mount_key_from_prefab_path(prefab_path)
    for suffix in ("_notrade", "_trade"):
        if key.endswith(suffix):
            return key[: -len(suffix)]
    return key


def load_collection_mount_category_map(game_path: Path) -> dict[str, str]:
    prefabs_root = require_prefabs_root(game_path)
    target_file = "collections/collection_mount.binfab"
    for tfi_path, full_path, entry in iter_index_entries(prefabs_root):
        if full_path.replace("\\", "/").lower() != target_file:
            continue
        archive_path = tfi_path.parent / f"archive{entry['archive_index']}.tfa"
        archive_content = read_archive_content(archive_path)
        content = archive_content[entry["offset"] : entry["offset"] + entry["size"]]
        strings = [row["text"] for row in extract_strings(content)]
        category_map: dict[str, str] = {}
        current_category = ""
        for index, text in enumerate(strings):
            next_text = strings[index + 1] if index + 1 < len(strings) else ""
            if next_text.startswith("$CollectionName_"):
                current_category = text
                continue
            normalized = text.lstrip("$")
            if normalized.startswith("collections/mount/") and current_category:
                category_map[Path(normalized).stem] = current_category
        return category_map
    return {}


def load_mount_multipliers_map(game_path: Path) -> dict[str, dict]:
    rows = load_multiplier_file_map(game_path, "meta/multipliers.binfab")
    return {key: value for key, value in rows.items() if key.startswith("collections/mount/")}


def extract_mount_localization_keys(strings: list[dict]) -> tuple[str, str]:
    name_key = ""
    description_key = ""
    for item in strings:
        text = item["text"]
        if not name_key:
            match = MOUNT_NAME_KEY_RE.search(text)
            if match:
                name_key = clean_localized_text(match.group(1))
        if not description_key:
            match = MOUNT_DESCRIPTION_KEY_RE.search(text)
            if match:
                description_key = clean_localized_text(match.group(1))
        if name_key and description_key:
            break
    return name_key, description_key


def resolve_mount_name_value(strings: list[dict], language_map: dict[str, str], name_key: str) -> str:
    name = resolve_localized_value(language_map, name_key)
    if name:
        return name
    for item in strings:
        text = item["text"]
        if text.startswith("$"):
            continue
        if "Pets and MountsX" in text:
            continue
        if "(" in text and len(text) < 80:
            return text.replace("(", "").strip()
    return ""


def resolve_mount_description_value(strings: list[dict], language_map: dict[str, str], desc_key: str) -> str:
    desc = resolve_localized_value(language_map, desc_key)
    if desc:
        return desc
    for item in strings:
        text = item["text"]
        if text.startswith("$"):
            continue
        if text.startswith("Pets and MountsX") and "$" not in text:
            return text.removeprefix("Pets and MountsX").rstrip("h").strip()
    return ""


def choose_mount_blueprint(parsed: dict) -> str:
    candidates = []
    for entry in parsed.get("strings", []):
        text = entry["text"]
        lowered = text.lower()
        if "_ui" not in lowered:
            continue
        if lowered.endswith(".blueprint") or "/mounts/" in lowered or lowered.startswith("c_mt_"):
            candidates.append(text)
    if candidates:
        candidates.sort(key=lambda value: (".blueprint" not in value.lower(), len(value)))
        return candidates[0]
    return parsed.get("blueprint", "")


async def find_mount_prefabs(game_path: Path) -> list[dict]:
    prefabs_root = require_prefabs_root(game_path)
    matches = []
    for tfi_path, prefab_path, file_data in iter_index_entries(prefabs_root):
        lowered = prefab_path.lower()
        if lowered.startswith(MOUNT_PREFIX) and lowered.endswith(".binfab"):
            matches.append(
                {
                    "tfi_path": tfi_path,
                    "archive_index": file_data["archive_index"],
                    "offset": file_data["offset"],
                    "size": file_data["size"],
                    "internal_name": file_data["name"].replace("\\", "/"),
                    "prefab_path": prefab_path,
                    "mount_key": mount_key_from_prefab_path(prefab_path),
                }
            )
    return matches


async def find_item_mount_prefabs(game_path: Path) -> list[dict]:
    prefabs_root = require_prefabs_root(game_path)
    matches = []
    for tfi_path, prefab_path, file_data in iter_index_entries(prefabs_root):
        lowered = prefab_path.lower()
        if lowered.startswith(ITEM_MOUNT_PREFIX) and lowered.endswith(".binfab"):
            matches.append(
                {
                    "tfi_path": tfi_path,
                    "archive_index": file_data["archive_index"],
                    "offset": file_data["offset"],
                    "size": file_data["size"],
                    "internal_name": file_data["name"].replace("\\", "/"),
                    "prefab_path": prefab_path,
                    "mount_key": item_mount_key_from_prefab_path(prefab_path),
                }
            )
    return matches


async def load_mount_prefabs(game_path: Path, matches: list[dict]) -> list[dict]:
    loaded = []
    grouped: dict[tuple[Path, int], list[dict]] = defaultdict(list)
    for match in matches:
        grouped[(match["tfi_path"], match["archive_index"])].append(match)

    for (tfi_path, archive_index), group_matches in grouped.items():
        archive_path = tfi_path.parent / f"archive{archive_index}.tfa"
        archive_content = read_archive_content(archive_path)
        for match in group_matches:
            start = match["offset"]
            end = start + match["size"]
            content = archive_content[start:end]
            loaded.append(
                {
                    **match,
                    "content": content,
                    "parsed": parse_ally_binfab_content(content, match["prefab_path"]),
                }
            )
    return loaded


async def load_item_mount_prefabs(game_path: Path, matches: list[dict]) -> list[dict]:
    loaded = []
    grouped: dict[tuple[Path, int], list[dict]] = defaultdict(list)
    for match in matches:
        grouped[(match["tfi_path"], match["archive_index"])].append(match)

    for (tfi_path, archive_index), group_matches in grouped.items():
        archive_path = tfi_path.parent / f"archive{archive_index}.tfa"
        archive_content = read_archive_content(archive_path)
        for match in group_matches:
            start = match["offset"]
            end = start + match["size"]
            content = archive_content[start:end]
            loaded.append(
                {
                    **match,
                    "content": content,
                    "signature": parse_item_pet_signature(content),
                    "strings": extract_strings(content),
                }
            )
    return loaded


def movement_stats_from_parsed(parsed: dict) -> dict[str, float | None]:
    result = {"ground": None, "wing": None, "glide": None}
    for entry in parsed.get("strings", []):
        text = entry["text"]
        lowered = text.lower()
        if lowered == "ground_movespeedf":
            result["ground"] = 1.0
        elif lowered == "wing_movespeedf":
            result["wing"] = 1.0
        elif lowered == "glide_movespeedf":
            result["glide"] = 1.0
    return result


def merge_mounts(
    extracted: list[dict],
    item_mounts: list[dict],
    language_map: dict[str, str],
    blueprint_map: dict[str, object],
    category_map: dict[str, str],
    multiplier_map: dict[str, dict],
) -> tuple[dict[str, dict], dict[str, int]]:
    item_by_key: dict[str, list[dict]] = defaultdict(list)
    for item in item_mounts:
        item_by_key[item["mount_key"]].append(item)

    merged: dict[str, dict] = {}
    for item in extracted:
        mount_key = item["mount_key"]
        parsed = item["parsed"]
        strings = parsed.get("strings", [])
        name_key, desc_key = extract_mount_localization_keys(strings)
        name = resolve_mount_name_value(strings, language_map, name_key)
        desc = resolve_mount_description_value(strings, language_map, desc_key)
        blueprint = resolve_blueprint_catalog_path(choose_mount_blueprint(parsed), blueprint_map)
        category = category_map.get(mount_key, "Unknown")
        multiplier_row = multiplier_map.get(f"collections/mount/{mount_key}")
        base_identifier, base_mastery = infer_mastery_base(f"collections/mount/{mount_key}")
        final_mastery = base_mastery
        if multiplier_row is not None:
            final_mastery = multiplier_row["predicted"]
        record = {
            "name": name,
            "desc": desc,
            "category": category,
            "designer": extract_designer_from_blueprint(blueprint) or "Trove Team",
            "filename": f"collections/mount/{mount_key}",
            "blueprint": blueprint,
            "mastery": str(final_mastery),
            "mastery_base": str(base_mastery),
            "mastery_source": "multiplier" if multiplier_row is not None else ("base" if base_identifier.startswith("collections/mount/") else "unknown"),
            "stats": parsed.get("extracted_stats", []),
            "tooltip": parsed.get("tooltip", "").replace("<p>Ally</p>", "<p>Mount</p>", 1),
            "ability_paths": list(parsed.get("extracted_abilities", [])),
            "movement_flags": movement_stats_from_parsed(parsed),
            "item_variants": [
                {
                    "path": row["prefab_path"],
                    "signature": row.get("signature", {}),
                }
                for row in item_by_key.get(mount_key, [])
            ],
            "name_key": name_key,
            "desc_key": desc_key,
        }
        merged[mount_key] = record

    manifest = {
        "decoded_names": sum(1 for row in merged.values() if row.get("name")),
        "decoded_descriptions": sum(1 for row in merged.values() if row.get("desc")),
        "decoded_mastery": sum(1 for row in merged.values() if row.get("mastery") not in ("", "0")),
        "base_mastery_fallbacks": sum(1 for row in merged.values() if row.get("mastery_source") == "base"),
        "decoded_blueprints": sum(1 for row in merged.values() if row.get("blueprint")),
        "decoded_categories": sum(1 for row in merged.values() if row.get("category") and row.get("category") != "Unknown"),
        "with_item_variants": sum(1 for row in merged.values() if row.get("item_variants")),
        "with_stats": sum(1 for row in merged.values() if row.get("stats")),
    }
    return dict(sorted(merged.items())), manifest


async def build_mounts_dataset(
    game_path: Path | None = None,
    *,
    locale: str = "en",
) -> tuple[dict[str, dict], dict[str, object]]:
    game_path = game_path or detect_first_glyph_install()
    mount_matches = await find_mount_prefabs(game_path)
    item_mount_matches = await find_item_mount_prefabs(game_path)
    loaded_mounts = await load_mount_prefabs(game_path, mount_matches)
    loaded_item_mounts = await load_item_mount_prefabs(game_path, item_mount_matches)
    language_map = load_language_map(game_path, locale)
    blueprint_map = load_blueprint_path_map(game_path)
    category_map = load_collection_mount_category_map(game_path)
    multiplier_map = load_mount_multipliers_map(game_path)
    merged, counts = merge_mounts(
        loaded_mounts,
        loaded_item_mounts,
        language_map,
        blueprint_map,
        category_map,
        multiplier_map,
    )
    manifest = {
        "game_path": str(game_path),
        "mount_count": len(merged),
        "collection_mount_prefabs": len(mount_matches),
        "item_mount_prefabs": len(item_mount_matches),
        **counts,
    }
    return merged, manifest
