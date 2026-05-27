from __future__ import annotations

import re
from pathlib import Path

from models.trove.prefab_ally import (
    clean_localized_text,
    detect_first_glyph_install,
    extract_designer_from_blueprint,
    iter_index_entries,
    load_blueprint_path_map,
    load_language_map,
    read_archive_content,
    require_prefabs_root,
    resolve_blueprint_catalog_path,
    resolve_localized_value,
)
from utils.mount_binfab import extract_strings, zig_zag_decode
from utils.binfab_reader import decode_identity


RECIPE_PREFIX = "recipes/"
PATH_PREFIXES = ("item/", "placeable/", "block/", "collections/", "effects/")
NAME_KEY_RE = re.compile(r"(\$prefabs_[A-Za-z0-9_]+(?:_item)?_name)")
DESC_KEY_RE = re.compile(r"(\$prefabs_[A-Za-z0-9_]+(?:_item_)?(?:description|desc))")


def read_varint(data: bytes, offset: int) -> tuple[int | None, int]:
    value = 0
    shift = 0
    cursor = offset
    while cursor < len(data) and shift <= 63:
        byte = data[cursor]
        value |= (byte & 0x7F) << shift
        cursor += 1
        if not (byte & 0x80):
            return value, cursor
        shift += 7
    return None, offset


def looks_like_path(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return False
    return lowered.startswith(PATH_PREFIXES)


def normalize_recipe_string(text: str) -> str:
    return clean_localized_text(str(text or "").strip()).rstrip("(").strip('"').strip("'").strip()


def pretty_name_from_path(path: str) -> str:
    stem = Path(str(path or "").replace("\\", "/")).stem
    for suffix in ("_notrade", "_trade"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return stem.replace("_", " ").strip().title()


def build_prefab_entry_map(game_path: Path) -> dict[str, dict]:
    prefabs_root = require_prefabs_root(game_path)
    mapping: dict[str, dict] = {}
    for tfi_path, full_path, entry in iter_index_entries(prefabs_root):
        mapping[full_path.lower()] = {
            "tfi_path": tfi_path,
            "archive_index": entry["archive_index"],
            "offset": entry["offset"],
            "size": entry["size"],
            "prefab_path": full_path,
        }
    return mapping


def read_prefab_content(prefab_index: dict[str, dict], prefab_path: str) -> tuple[str, bytes] | tuple[None, None]:
    normalized = str(prefab_path or "").replace("\\", "/").strip().removesuffix(".binfab")
    if not normalized:
        return None, None
    lookup_key = f"{normalized}.binfab".lower()
    entry = prefab_index.get(lookup_key)
    if not entry:
        return None, None
    archive_path = entry["tfi_path"].parent / f"archive{entry['archive_index']}.tfa"
    archive_content = read_archive_content(archive_path)
    start = entry["offset"]
    end = start + entry["size"]
    return entry["prefab_path"], archive_content[start:end]


def decode_quantified_recipe_paths(content: bytes) -> list[dict]:
    rows: list[dict] = []
    pos = 0
    while pos < len(content) - 3:
        if content[pos] != 0x08:
            pos += 1
            continue
        length, cursor = read_varint(content, pos + 1)
        if length is None or length <= 0 or cursor + length > len(content):
            pos += 1
            continue
        raw = content[cursor : cursor + length]
        if any(byte < 32 or byte > 126 for byte in raw):
            pos += 1
            continue
        text = normalize_recipe_string(raw.decode("ascii", errors="ignore"))
        if not looks_like_path(text):
            pos += 1
            continue
        next_pos = cursor + length
        if next_pos >= len(content) or content[next_pos] != 0x10:
            pos = next_pos
            continue
        amount_raw, end_pos = read_varint(content, next_pos + 1)
        if amount_raw is None:
            pos += 1
            continue
        rows.append(
            {
                "path": text,
                "amount_raw": int(amount_raw),
                "amount": int(zig_zag_decode(int(amount_raw))),
                "offset": pos,
                "end": end_pos,
            }
        )
        pos = end_pos
    return rows


def split_recipe_sections(strings: list[str]) -> tuple[list[str], list[str]]:
    normalized = [normalize_recipe_string(text) for text in strings]
    null_indexes = [index for index, text in enumerate(normalized) if text.lower() == "null"]
    if len(null_indexes) >= 2:
        return normalized[: null_indexes[0]], normalized[null_indexes[1] + 1 :]
    if len(null_indexes) == 1:
        return normalized[: null_indexes[0]], normalized[null_indexes[0] + 1 :]
    return normalized, []


def is_material_path(path: str) -> bool:
    lowered = str(path or "").lower()
    return lowered.startswith("item/crafting/") or lowered.startswith("item/currency/") or lowered.startswith("item/dragon/")


def is_output_candidate(path: str) -> bool:
    lowered = str(path or "").lower()
    if not lowered or lowered.startswith("effects/"):
        return False
    if lowered.startswith("collections/"):
        return False
    return lowered.startswith("item/") or lowered.startswith("placeable/") or lowered.startswith("block/")


def choose_recipe_output(strings: list[str]) -> str:
    head, tail = split_recipe_sections(strings)
    for section in (tail, head):
        for text in section:
            if is_output_candidate(text) and not is_material_path(text):
                return text
    for text in tail + head:
        if text.startswith("collections/"):
            return text
    return ""


def derive_output_amount(output_path: str, quantified_paths: list[dict]) -> int:
    output_path = normalize_recipe_string(output_path)
    for row in reversed(quantified_paths):
        if normalize_recipe_string(row["path"]) == output_path:
            if row["amount"] > 0:
                return int(row["amount"])
            break
    return 1


def decode_requirements(strings: list[str], ingredient_paths: set[str], output_path: str) -> list[str]:
    requirements: list[str] = []
    normalized = [normalize_recipe_string(text) for text in strings]
    output_path = normalize_recipe_string(output_path)
    label_map = {
        "activeclass": "Active Class",
        "powerrank": "Power Rank",
        "hascollection": "Requires Collection",
        "hastitle": "Requires Title",
    }
    for index, text in enumerate(normalized):
        if not text or text.lower() == "null":
            continue
        lowered = text.lower()
        if text in ingredient_paths or text == output_path or looks_like_path(text) or lowered.startswith("$prefabs_"):
            continue
        if lowered == "zonetag" and index + 1 < len(normalized):
            zone_name = normalized[index + 1]
            if zone_name and zone_name.lower() != "zonetag":
                requirements.append(f"Zone: {zone_name}")
            continue
        if lowered in label_map:
            requirements.append(label_map[lowered])
    return list(dict.fromkeys(requirements))


def choose_blueprint_from_strings(strings: list[str]) -> str:
    candidates = []
    for text in strings:
        lowered = text.lower()
        if lowered.endswith(".pkfx"):
            continue
        if lowered.endswith(".blueprint") or lowered.startswith("c_mt_") or lowered.startswith("c_c_") or "/ui" in lowered:
            candidates.append(text)
    if not candidates:
        return ""
    candidates.sort(key=lambda value: (".blueprint" not in value.lower(), len(value)))
    return candidates[0]


def heuristic_blueprint_from_content(prefab_path: str, content: bytes) -> str:
    blueprint_pos = content.rfind(b".blueprint")
    if blueprint_pos >= 0:
        start_pos = content[:blueprint_pos].rfind(b"\x08")
        if start_pos >= 0 and start_pos + 2 < len(content):
            length = content[start_pos + 1]
            value = content[start_pos + 2 : start_pos + 2 + length]
            text = value.decode("ascii", errors="ignore").strip()
            if text.lower().endswith(".blueprint"):
                return text

    if "placeable/" in str(prefab_path or "").lower():
        stem = Path(str(prefab_path or "").replace("\\", "/")).stem
        if stem:
            return stem
    return ""


def extract_prefab_metadata(
    prefab_path: str,
    content: bytes,
    language_map: dict[str, str],
    blueprint_map: dict[str, object],
) -> dict:
    raw_strings = [normalize_recipe_string(row["text"]) for row in extract_strings(content)]
    strings = [row for row in raw_strings if row]

    # Grounded read of the identity component (exe-derived wire format). Falls back
    # to regex string-scan for prefab families without an identity component.
    identity = decode_identity(content)
    name_key = ""
    desc_key = ""
    literal_name = ""
    display_category = ""
    tradable = None
    if identity:
        display_category = identity.get("category") or ""
        tradable = identity.get("tradable")
        gname = identity.get("name_key") or ""
        gdesc = identity.get("desc_key") or ""
        if gname.startswith("$"):
            name_key = clean_localized_text(gname)
        elif gname:
            literal_name = gname  # already a display name, not a localization key
        if gdesc.startswith("$"):
            desc_key = clean_localized_text(gdesc)

    for text in strings:
        if name_key and desc_key:
            break
        if not name_key and not literal_name:
            match = NAME_KEY_RE.search(text)
            if match:
                name_key = clean_localized_text(match.group(1))
        if not desc_key:
            match = DESC_KEY_RE.search(text)
            if match:
                desc_key = clean_localized_text(match.group(1))

    blueprint = choose_blueprint_from_strings(strings)
    blueprint_source = "decoded" if blueprint else ""
    if not blueprint:
        blueprint = heuristic_blueprint_from_content(prefab_path, content)
        blueprint_source = "heuristic" if blueprint else ""
    if not blueprint:
        blueprint = Path(str(prefab_path or "").replace("\\", "/")).stem
        blueprint_source = "fallback"

    resolved_blueprint = resolve_blueprint_catalog_path(blueprint, blueprint_map)
    name = (
        resolve_localized_value(language_map, name_key)
        or literal_name
        or pretty_name_from_path(prefab_path)
    )
    desc = resolve_localized_value(language_map, desc_key)

    return {
        "name": name,
        "desc": desc,
        "blueprint": resolved_blueprint,
        "blueprint_source": blueprint_source,
        "designer": extract_designer_from_blueprint(resolved_blueprint) or "Trove Team",
        "name_key": name_key,
        "desc_key": desc_key,
        "display_category": display_category,
        "tradable": tradable,
        "strings": strings,
    }


def extract_prefab_unlocks(strings: list[str], identifier: str) -> list[str]:
    normalized_identifier = str(identifier or "").replace("\\", "/").strip().lower()
    unlocks = []
    seen = set()
    for text in strings:
        normalized = normalize_recipe_string(text).replace("\\", "/")
        lowered = normalized.lower()
        if not lowered.startswith("collections/"):
            continue
        if lowered == normalized_identifier:
            continue
        if normalized not in seen:
            seen.add(normalized)
            unlocks.append(normalized)
    return unlocks


def category_from_output(recipe_path: str, output_path: str) -> str:
    lowered_output = str(output_path or "").lower()
    lowered_recipe = str(recipe_path or "").lower()
    mapping = (
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
    )
    for prefix, label in mapping:
        if lowered_output.startswith(prefix):
            return label
    stem = Path(lowered_recipe).stem.removeprefix("recipe_")
    if stem:
        return stem.split("_", 1)[0].replace("_", " ").title()
    return "Recipe"


async def build_recipes_dataset(
    game_path: Path | None = None,
    *,
    locale: str = "en",
) -> tuple[dict[str, dict], dict[str, object]]:
    game_path = game_path or detect_first_glyph_install()
    prefab_index = build_prefab_entry_map(game_path)
    language_map = load_language_map(game_path, locale)
    blueprint_map = load_blueprint_path_map(game_path)

    item_meta_cache: dict[str, dict] = {}
    rows: dict[str, dict] = {}

    decoded_output_count = 0
    heuristic_blueprint_count = 0
    decoded_blueprint_count = 0
    total_ingredients = 0

    recipe_paths = [path for path in prefab_index.keys() if path.startswith(RECIPE_PREFIX) and path.endswith(".binfab")]
    for recipe_lookup in sorted(recipe_paths):
        recipe_entry = prefab_index[recipe_lookup]
        archive_path = recipe_entry["tfi_path"].parent / f"archive{recipe_entry['archive_index']}.tfa"
        archive_content = read_archive_content(archive_path)
        start = recipe_entry["offset"]
        end = start + recipe_entry["size"]
        content = archive_content[start:end]

        strings = [normalize_recipe_string(row["text"]) for row in extract_strings(content)]
        quantified = decode_quantified_recipe_paths(content)
        output_path = choose_recipe_output(strings)
        if output_path:
            decoded_output_count += 1

        output_meta = {
            "name": pretty_name_from_path(output_path or recipe_entry["prefab_path"]),
            "desc": "",
            "blueprint": Path(str(output_path or recipe_entry["prefab_path"])).stem,
            "blueprint_source": "fallback",
            "designer": "Trove Team",
            "lootbox": False,
            "decay": False,
            "unlocks": [],
        }
        normalized_output = output_path.removesuffix(".binfab") if output_path else ""
        if normalized_output:
            cached = item_meta_cache.get(normalized_output.lower())
            if cached is None:
                resolved_prefab_path, resolved_content = read_prefab_content(prefab_index, normalized_output)
                if resolved_prefab_path and resolved_content is not None:
                    cached = extract_prefab_metadata(
                        resolved_prefab_path,
                        resolved_content,
                        language_map,
                        blueprint_map,
                    )
                    cached["lootbox"] = b"LootTable" in resolved_content
                    cached["decay"] = b"quantitydecay" in resolved_content
                    cached["unlocks"] = extract_prefab_unlocks(cached.get("strings", []), normalized_output)
                else:
                    cached = output_meta
                item_meta_cache[normalized_output.lower()] = cached
            output_meta = cached

        if output_meta.get("blueprint_source") == "decoded":
            decoded_blueprint_count += 1
        elif output_meta.get("blueprint_source") == "heuristic":
            heuristic_blueprint_count += 1

        ingredient_paths = set()
        ingredients = []
        for row in quantified:
            ingredient_path = normalize_recipe_string(row["path"])
            if not ingredient_path or ingredient_path == normalized_output or ingredient_path.startswith("collections/"):
                continue
            ingredient_paths.add(ingredient_path)
            ingredient_name = pretty_name_from_path(ingredient_path)
            cached = item_meta_cache.get(ingredient_path.lower())
            if cached is None:
                resolved_prefab_path, resolved_content = read_prefab_content(prefab_index, ingredient_path)
                if resolved_prefab_path and resolved_content is not None:
                    cached = extract_prefab_metadata(
                        resolved_prefab_path,
                        resolved_content,
                        language_map,
                        blueprint_map,
                    )
                else:
                    cached = {"name": ingredient_name}
                item_meta_cache[ingredient_path.lower()] = cached
            ingredient_name = cached.get("name") or ingredient_name
            ingredients.append(
                {
                    "path": ingredient_path,
                    "amount": int(row["amount"]),
                    "raw_amount": int(row["amount_raw"]),
                    "name": ingredient_name,
                }
            )
        total_ingredients += len(ingredients)

        recipe_id = recipe_entry["prefab_path"].removesuffix(".binfab")
        rows[recipe_id] = {
            "name": output_meta.get("name") or pretty_name_from_path(recipe_id),
            "desc": output_meta.get("desc", ""),
            "category": category_from_output(recipe_id, normalized_output),
            "designer": output_meta.get("designer", "Trove Team"),
            "filename": recipe_id,
            "blueprint": output_meta.get("blueprint", ""),
            "lootbox": bool(output_meta.get("lootbox")),
            "decay": bool(output_meta.get("decay")),
            "unlock_count": len(output_meta.get("unlocks", [])),
            "output_path": normalized_output,
            "output_amount": derive_output_amount(normalized_output, quantified),
            "ingredients": ingredients,
            "requirements": decode_requirements(strings, ingredient_paths, normalized_output),
            "raw_string_count": len(strings),
        }

    manifest = {
        "game_path": str(game_path),
        "recipe_count": len(rows),
        "decoded_outputs": decoded_output_count,
        "resolved_names": sum(1 for row in rows.values() if row.get("name")),
        "resolved_descriptions": sum(1 for row in rows.values() if row.get("desc")),
        "decoded_blueprints": decoded_blueprint_count,
        "heuristic_blueprints": heuristic_blueprint_count,
        "with_requirements": sum(1 for row in rows.values() if row.get("requirements")),
        "with_ingredients": sum(1 for row in rows.values() if row.get("ingredients")),
        "total_ingredients": total_ingredients,
    }
    return rows, manifest
