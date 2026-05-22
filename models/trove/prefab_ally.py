from __future__ import annotations

import contextlib
import io
import re
import zlib
from collections import defaultdict
from pathlib import Path

from binary_reader import BinaryReader

from utils.ally_binfab import extract_strings, parse_ally_binfab_content
from utils.registry import get_trove_locations


PREFAB_PREFIX = "collections/pet/"
ITEM_PET_PREFIX = "item/pet/"
DESIGNER_RE = re.compile(r"\[([^\]]+)\]")
MULTIPLIER_FILE = "meta/multipliers.binfab"
GEODE_MULTIPLIER_FILE = "meta/geode_multipliers.binfab"
ALLY_KEY_ALIASES = {
    "tentacle_bopplepod": "tentacle_bobblepod",
}


def detect_first_glyph_install() -> Path:
    with contextlib.redirect_stdout(io.StringIO()):
        locations = list(get_trove_locations())
    for game in locations:
        if game.is_glyph and game.is_valid:
            return game.path
    raise RuntimeError("No valid Glyph Trove installation was detected.")


def resolve_game_install(game_path: str | Path | None = None) -> Path:
    if game_path is not None:
        raw_value = str(game_path).strip()
        if raw_value:
            candidate = Path(raw_value)
            if candidate.exists() and next(candidate.glob("[Tt]rove*.exe"), None):
                return candidate
            raise RuntimeError(f"Selected Trove installation is invalid: {candidate}")
    return detect_first_glyph_install()


def read_leb128(buffer: BinaryReader, pos: int) -> int:
    result = 0
    shift = 0
    while True:
        buffer.seek(pos)
        current = buffer.read_bytes()
        for byte in current:
            result |= (byte & 0x7F) << shift
            pos += 1
            if not (byte & 0x80):
                result &= (1 << 32) - 1
                return int(result)
            shift += 7
            if shift >= 64:
                raise ValueError("Too many bytes when decoding varint.")


def read_index_entries(tfi_path: Path) -> list[dict]:
    reader = BinaryReader(tfi_path.read_bytes())
    entries = []
    while reader.pos() < reader.size():
        name = reader.read_str(read_leb128(reader, reader.pos()))
        entries.append(
            {
                "name": name,
                "archive_index": read_leb128(reader, reader.pos()),
                "offset": read_leb128(reader, reader.pos()),
                "size": read_leb128(reader, reader.pos()),
                "hash": read_leb128(reader, reader.pos()),
            }
        )
    return entries


_archive_cache: dict[Path, bytes] = {}


def read_archive_content(archive_path: Path) -> bytes:
    cached = _archive_cache.get(archive_path)
    if cached is None:
        cached = zlib.decompressobj(wbits=zlib.MAX_WBITS).decompress(archive_path.read_bytes())
        _archive_cache[archive_path] = cached
    return cached


def iter_index_entries(root: Path):
    for tfi_path in root.rglob("index.tfi"):
        prefix = tfi_path.parent.relative_to(root).as_posix()
        for entry in read_index_entries(tfi_path):
            full_path = f"{prefix}/{entry['name']}" if prefix != "." else entry["name"]
            yield tfi_path, full_path.replace("\\", "/"), entry


def require_prefabs_root(game_path: Path) -> Path:
    prefabs_root = game_path / "prefabs"
    if not prefabs_root.exists():
        raise RuntimeError(f"Prefabs directory was not found: {prefabs_root}")
    return prefabs_root


def ally_key_from_prefab_path(prefab_path: str) -> str:
    normalized = prefab_path.replace("\\", "/")
    if normalized.lower().startswith(PREFAB_PREFIX):
        normalized = normalized[len(PREFAB_PREFIX):]
    key = Path(normalized).stem
    return ALLY_KEY_ALIASES.get(key, key)


def item_ally_key_from_prefab_path(prefab_path: str) -> str:
    key = ally_key_from_prefab_path(prefab_path)
    for suffix in ("_notrade", "_trade"):
        if key.endswith(suffix):
            return key[: -len(suffix)]
    return key


def ally_family_key(ally_key: str) -> str:
    parts = str(ally_key or "").split("_")
    if len(parts) >= 2:
        return "_".join(parts[:2])
    return str(ally_key or "")


def encode_varint(value: int) -> bytes:
    encoded = bytearray()
    while True:
        current = value & 0x7F
        value >>= 7
        if value:
            encoded.append(current | 0x80)
        else:
            encoded.append(current)
            return bytes(encoded)


def infer_mastery_base(identifier: str) -> tuple[str, int]:
    normalized = identifier.replace("\\", "/")
    rules = (
        ("collections/mount", 50),
        ("collections/boat", 50),
        ("collections/badge", 20),
        ("collections/tome", 20),
        ("collections/pet", 10),
        ("item/companion", 10),
        ("collections/sail", 10),
        ("item/fish", 5),
        ("item/unlocker", 5),
        ("recipe_", 2),
        ("equipment_", 0),
    )
    for prefix, base in rules:
        if prefix in normalized:
            return normalized, base
    if "/" not in normalized:
        return f"collections/skin/{normalized}", 35
    return normalized, 0


def load_multiplier_file_map(game_path: Path, target_file: str, *, geode_mode: bool = False) -> dict[str, dict]:
    prefabs_root = game_path / "prefabs"
    for tfi_path, full_path, entry in iter_index_entries(prefabs_root):
        if full_path.replace("\\", "/").lower() != target_file:
            continue
        archive_path = tfi_path.parent / f"archive{entry['archive_index']}.tfa"
        archive_content = read_archive_content(archive_path)
        content = archive_content[entry["offset"] : entry["offset"] + entry["size"]]

        position = 9
        groups = (0, 2, 3, 5)
        rows: dict[str, dict] = {}
        for multiplier in groups:
            marker = b"\xBE\x01\xAE"
            marker_pos = content.find(marker, position)
            if marker_pos < 0:
                break
            position = marker_pos + len(marker)
            element_count = read_leb128(BinaryReader(content), position)
            while position < len(content) and content[position] & 0x80:
                position += 1
            position += 1

            for index in range(1, element_count + 1):
                pattern = encode_varint(4 + 16 * (index - 1)) + b"\x00"
                next_pos = content.find(pattern, position)
                if next_pos < 0:
                    break
                position = next_pos + len(pattern)
                position += 2

                string_length = read_leb128(BinaryReader(content), position)
                while position < len(content) and content[position] & 0x80:
                    position += 1
                position += 1

                raw_identifier = content[position : position + string_length].decode("ascii", errors="ignore")
                position += string_length
                identifier, base = infer_mastery_base(raw_identifier)
                predicted = base * multiplier
                if geode_mode and identifier.startswith("collections/pet/") and multiplier == 0:
                    predicted = base
                rows[identifier] = {
                    "identifier": identifier,
                    "multiplier": multiplier,
                    "base": base,
                    "predicted": predicted,
                }
        return rows
    return {}


def load_multipliers_map(game_path: Path) -> dict[str, dict]:
    return load_multiplier_file_map(game_path, MULTIPLIER_FILE)


def load_geode_multipliers_map(game_path: Path) -> dict[str, dict]:
    return load_multiplier_file_map(game_path, GEODE_MULTIPLIER_FILE, geode_mode=True)


def load_collection_pet_category_map(game_path: Path) -> dict[str, str]:
    prefabs_root = game_path / "prefabs"
    target_file = "collections/collection_pet.binfab"
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
            if normalized.startswith("collections/pet/") and current_category:
                category_map[Path(normalized).stem] = current_category
        return category_map
    return {}


def extract_designer_from_blueprint(blueprint: str) -> str:
    stem = Path(blueprint or "").stem
    match = DESIGNER_RE.search(stem)
    return match.group(1) if match else ""


def normalize_blueprint_catalog_id(blueprint: str) -> str:
    text = str(blueprint or "").replace("\\", "/").strip()
    if not text:
        return ""
    text = text.removesuffix(".blueprint")
    text = re.sub(r"^[^A-Za-z0-9_/]+", "", text)
    text = DESIGNER_RE.sub("", text)
    if "/" in text:
        text = text.split("/")[-1]
    text = text.lstrip("$")
    return text


def _normalize_blueprint_lookup_key(value: str) -> str:
    text = str(value or "").replace("\\", "/").strip().lower()
    text = text.removesuffix(".blueprint")
    text = re.sub(r"^[^a-z0-9_/]+", "", text)
    text = DESIGNER_RE.sub("", text)
    return text.split("/")[-1]


def load_blueprint_path_map(game_path: Path) -> dict[str, object]:
    blueprints_root = game_path / "blueprints"
    if not blueprints_root.exists():
        return {"exact": {}, "entries": []}

    mapping: dict[str, str] = {}
    entries: list[tuple[str, str]] = []
    for _tfi_path, full_path, _entry in iter_index_entries(blueprints_root):
        normalized = full_path.replace("\\", "/")
        lowered = normalized.lower()
        if not lowered.endswith(".blueprint"):
            continue
        no_ext = normalized.removesuffix(".blueprint")
        basename = Path(no_ext).name.lower()
        normalized_key = _normalize_blueprint_lookup_key(basename)
        mapping.setdefault(lowered, no_ext)
        mapping.setdefault(basename, no_ext)
        mapping.setdefault(re.sub(r"\[[^\]]+\]", "", basename), no_ext)
        entries.append((normalized_key, no_ext))
    return {"exact": mapping, "entries": entries}


def resolve_blueprint_catalog_path(blueprint: str, blueprint_map: dict[str, object]) -> str:
    normalized = str(blueprint or "").replace("\\", "/").strip()
    if not normalized:
        return ""
    normalized = re.sub(r"^[^A-Za-z0-9_/]+", "", normalized.removesuffix(".blueprint").lstrip("$"))
    basename = Path(normalized).name.lower()
    keys = [
        f"{normalized.lower()}.blueprint",
        basename,
        re.sub(r"\[[^\]]+\]", "", basename),
    ]
    exact_map = blueprint_map.get("exact", {}) if isinstance(blueprint_map, dict) else {}
    for key in keys:
        if key in exact_map:
            return exact_map[key]

    normalized_prefix = _normalize_blueprint_lookup_key(normalized)
    best_match = ""
    for entry_key, entry_path in blueprint_map.get("entries", []) if isinstance(blueprint_map, dict) else []:
        if entry_key.startswith(normalized_prefix):
            if not best_match or len(entry_path) < len(best_match):
                best_match = entry_path
    if best_match:
        return best_match
    return normalize_blueprint_catalog_id(normalized)


async def find_pet_prefabs(game_path: Path) -> list[dict]:
    prefabs_root = require_prefabs_root(game_path)

    matches = []
    for tfi_path, prefab_path, file_data in iter_index_entries(prefabs_root):
        internal_name = file_data["name"].replace("\\", "/")
        lowered = prefab_path.lower()
        if lowered.startswith(PREFAB_PREFIX) and lowered.endswith(".binfab") and not lowered.endswith("_npc.binfab"):
            matches.append(
                {
                    "tfi_path": tfi_path,
                    "archive_index": file_data["archive_index"],
                    "offset": file_data["offset"],
                    "size": file_data["size"],
                    "internal_name": internal_name,
                    "prefab_path": prefab_path,
                    "ally_key": ally_key_from_prefab_path(prefab_path),
                }
            )
    return matches


async def find_item_pet_prefabs(game_path: Path) -> list[dict]:
    prefabs_root = require_prefabs_root(game_path)

    matches = []
    for tfi_path, prefab_path, file_data in iter_index_entries(prefabs_root):
        lowered = prefab_path.lower()
        if lowered.startswith(ITEM_PET_PREFIX) and lowered.endswith(".binfab"):
            matches.append(
                {
                    "tfi_path": tfi_path,
                    "archive_index": file_data["archive_index"],
                    "offset": file_data["offset"],
                    "size": file_data["size"],
                    "internal_name": file_data["name"].replace("\\", "/"),
                    "prefab_path": prefab_path,
                    "ally_key": item_ally_key_from_prefab_path(prefab_path),
                }
            )
    return matches


_prefixed_key_re = re.compile(r"^[A-Za-z]\$(?=\w)")
PET_NAME_KEY_RE = re.compile(r"(\$prefabs_[A-Za-z0-9_]+(?:_item)?_name)")
PET_DESCRIPTION_KEY_RE = re.compile(r"(\$prefabs_[A-Za-z0-9_]+(?:_description|_desc))")


def clean_localized_text(text: str) -> str:
    text = text or ""
    text = _prefixed_key_re.sub("$", text)
    if text.startswith("$$"):
        text = "$" + text.lstrip("$")
    text = text.replace("\\n", "\n").strip("`").strip()
    if not text.startswith("$"):
        if text.startswith('\\"'):
            text = text[1:]
    return text


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


def extract_localization_map(content: bytes) -> dict[str, str]:
    mapping: dict[str, str] = {}
    cursor = 0
    while True:
        start = content.find(b"$", cursor)
        if start < 0:
            break
        end = start + 1
        while end < len(content):
            byte = content[end]
            if not (
                48 <= byte <= 57
                or 65 <= byte <= 90
                or 97 <= byte <= 122
                or byte == 95
                or byte == 36
            ):
                break
            end += 1
        key_bytes = content[start:end]
        if end >= len(content) or content[end] != 0x18:
            cursor = start + 1
            continue
        value_length, value_start = read_varint(content, end + 1)
        if value_length is None or value_length < 0:
            cursor = start + 1
            continue
        value_end = value_start + value_length
        if value_end > len(content):
            cursor = start + 1
            continue
        raw_key = key_bytes.decode("ascii", errors="ignore")
        raw_value = content[value_start:value_end].decode("utf-8", errors="ignore")
        key = clean_localized_text(raw_key)
        value = clean_localized_text(raw_value)
        if key.startswith("$") and value and not value.startswith("$"):
            mapping[key] = value
        cursor = value_end
    return mapping


def load_language_map(game_path: Path, locale: str = "en") -> dict[str, str]:
    root = game_path / "languages" / locale
    if not root.exists():
        return {}
    mapping: dict[str, str] = {}
    for tfi_path, _full_path, entry in iter_index_entries(root):
        archive_path = tfi_path.parent / f"archive{entry['archive_index']}.tfa"
        archive_content = read_archive_content(archive_path)
        content = archive_content[entry["offset"] : entry["offset"] + entry["size"]]
        mapping.update(extract_localization_map(content))
    return mapping


def resolve_ability_prefabs(game_path: Path, language_map: dict[str, str], ability_paths: list[str]) -> dict[str, dict]:
    wanted = {f"{ability}.binfab": ability for ability in ability_paths if ability}
    if not wanted:
        return {}

    resolved: dict[str, dict] = {}
    prefabs_root = game_path / "prefabs"
    for tfi_path, full_path, entry in iter_index_entries(prefabs_root):
        matched = wanted.get(full_path)
        if not matched:
            continue
        archive_path = tfi_path.parent / f"archive{entry['archive_index']}.tfa"
        archive_content = read_archive_content(archive_path)
        content = archive_content[entry["offset"] : entry["offset"] + entry["size"]]
        strings = [clean_localized_text(item["text"]) for item in extract_strings(content)]
        name_key = next((text for text in strings if text.endswith("_name") and text.startswith("$")), None)
        description_key = next(
            (text for text in strings if "_description" in text and text.startswith("$")),
            None,
        )
        description = language_map.get(description_key or "", "")
        if not description and description_key and description_key.endswith("0"):
            description = language_map.get(description_key[:-1], "")
        resolved[matched] = {
            "path": matched,
            "prefab_path": full_path.removesuffix(".binfab"),
            "name_key": name_key,
            "description_key": description_key,
            "name": language_map.get(name_key or "", ""),
            "description": description,
        }
        if len(resolved) == len(wanted):
            break
    return resolved


def extract_pet_localization_keys(strings: list[dict]) -> tuple[str, str]:
    name_key = ""
    description_key = ""
    for item in strings:
        text = item["text"]
        if not name_key:
            match = PET_NAME_KEY_RE.search(text)
            if match:
                name_key = match.group(1)
        if not description_key:
            match = PET_DESCRIPTION_KEY_RE.search(text)
            if match:
                description_key = match.group(1)
        if name_key and description_key:
            break
    return name_key, description_key


def resolve_localized_value(language_map: dict[str, str], key: str) -> str:
    if not key:
        return ""
    normalized_key = clean_localized_text(key)
    value = language_map.get(normalized_key, "")
    if value:
        return value
    if normalized_key.endswith("0"):
        return language_map.get(normalized_key[:-1], "")
    if normalized_key.endswith("_description"):
        return language_map.get(normalized_key[:-12] + "_desc", "")
    if normalized_key.endswith("_desc"):
        return language_map.get(normalized_key[:-5] + "_description", "")
    return ""


def resolve_pet_name_value(language_map: dict[str, str], ally_key: str, key: str) -> str:
    direct = resolve_localized_value(language_map, key)
    if direct:
        return direct

    # Some pet/event allies appear to lack a direct pet name string but do have
    # a nearby title string under the same ally key namespace.
    needle = str(ally_key or "").lower()
    if not needle:
        return ""

    candidates = []
    for candidate_key, value in language_map.items():
        lowered = candidate_key.lower()
        if needle not in lowered:
            continue
        if not value or "vendor" in value.lower():
            continue
        score = 100
        if lowered.endswith("_item_name"):
            score = 0
        elif lowered.endswith("_name"):
            score = 1
        elif lowered.endswith("_sign_title"):
            score = 2
        elif lowered.endswith("_title"):
            score = 3
        candidates.append((score, len(value), value))

    if not candidates:
        return ""

    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    return candidates[0][2]


_STAT_LINE_RE = re.compile(r"^([+-]?\d+(?:\.\d+)?)(%?)\s+(.+)$")


def stat_objects_from_lines(lines: list[str]) -> list[dict]:
    structured = []
    for line in lines:
        text = str(line or "").strip()
        if not text:
            continue
        match = _STAT_LINE_RE.match(text)
        if not match:
            structured.append(
                {
                    "text": text,
                    "name": text,
                    "value": None,
                    "display_value": "",
                    "is_percent": False,
                }
            )
            continue
        value_text, percent_marker, name = match.groups()
        structured.append(
            {
                "text": text,
                "name": name.strip(),
                "value": float(value_text),
                "display_value": f"{value_text}{percent_marker}",
                "is_percent": percent_marker == "%",
            }
        )
    return structured


async def load_pet_prefabs(game_path: Path, matches: list[dict]) -> list[dict]:
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
                    "source_name": match["prefab_path"],
                    "parsed": parse_ally_binfab_content(content, match["prefab_path"]),
                }
            )
    return loaded


def parse_item_pet_signature(content: bytes) -> dict:
    # Most pet item prefabs expose a compact header shaped like:
    # 0x47, 0x20, <mode>, 0x1E, 0x62, <lookup varint>, 0x18, <string_len varint>
    # We only use this as a reverse-engineering signal for PR.
    for pos in range(0, min(len(content) - 8, 96)):
        if content[pos] != 0x47 or content[pos + 1] != 0x20:
            continue
        if content[pos + 3] != 0x1E or content[pos + 4] != 0x62:
            continue
        mode = int(content[pos + 2])
        read_pos = pos + 5
        lookup_id = 0
        shift = 0
        while read_pos < len(content):
            byte = content[read_pos]
            lookup_id |= (byte & 0x7F) << shift
            read_pos += 1
            if not (byte & 0x80):
                break
            shift += 7
        if read_pos >= len(content) or content[read_pos] != 0x18:
            continue
        read_pos += 1
        string_len = 0
        shift = 0
        while read_pos < len(content):
            byte = content[read_pos]
            string_len |= (byte & 0x7F) << shift
            read_pos += 1
            if not (byte & 0x80):
                break
            shift += 7
        return {
            "mode": mode,
            "lookup_id": int(lookup_id),
            "string_len": int(string_len),
            "content_size": len(content),
        }
    return {}


KNOWN_POWER_RANK_PATTERNS = (
    (bytes.fromhex("30EC044001"), "50"),
    (bytes.fromhex("30D8044001"), "50"),
    (bytes.fromhex("30A4064001"), "75"),
    (bytes.fromhex("2E0008300040011EE205"), "30"),
    (bytes.fromhex("30A2064001"), "20"),
    (bytes.fromhex("30A0064001"), "5"),
    (bytes.fromhex("30004001"), "0"),
)


def decode_known_power_rank(content: bytes) -> str:
    for pattern, value in KNOWN_POWER_RANK_PATTERNS:
        if pattern in content:
            return value
    return ""


async def load_item_pet_prefabs(game_path: Path, matches: list[dict]) -> list[dict]:
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
                }
            )
    return loaded


def best_prefab_record(items: list[dict]) -> dict:
    parsed_candidates = [item["parsed"] for item in items]
    parsed_candidates.sort(
        key=lambda item: (
            len(item["stat_lines"]),
            len(item["extracted_abilities"]),
            1 if item["blueprint"] else 0,
        ),
        reverse=True,
    )
    return parsed_candidates[0]


async def build_allies_dataset(
    game_path: Path,
    extract_dir: str | Path = "build/prefabs_pet",
    locale: str = "en",
) -> tuple[dict, dict]:
    matches = await find_pet_prefabs(game_path)
    loaded = await load_pet_prefabs(game_path, matches)
    ability_paths = sorted(
        {
            ability
            for prefab in loaded
            for ability in prefab["parsed"].get("extracted_abilities", [])
        }
    )
    language_map = load_language_map(game_path, locale)
    blueprint_map = load_blueprint_path_map(game_path)
    ability_lookup = resolve_ability_prefabs(game_path, language_map, ability_paths)
    multipliers_map = load_multipliers_map(game_path)
    geode_multipliers_map = load_geode_multipliers_map(game_path)
    category_map = load_collection_pet_category_map(game_path)
    merged, decoded_count, matched_count = merge_allies(
        loaded,
        ability_lookup,
        multipliers_map,
        geode_multipliers_map,
        language_map,
        blueprint_map,
        category_map,
    )
    manifest = {
        "game_path": str(game_path),
        "match_count": len(matches),
        "extracted_count": len(loaded),
        "matched_allies": matched_count,
        "decoded_tooltips": decoded_count,
        "extract_dir": str(extract_dir),
        "ability_paths": len(ability_paths),
        "resolved_abilities": sum(1 for item in ability_lookup.values() if item.get("description") or item.get("name")),
        "decoded_mastery": sum(1 for ally in merged.values() if multipliers_map.get(ally.get("filename", ""))),
        "decoded_geode_mastery": sum(1 for ally in merged.values() if geode_multipliers_map.get(ally.get("filename", ""))),
        "decoded_names": sum(1 for ally in merged.values() if ally.get("name")),
        "decoded_descriptions": sum(1 for ally in merged.values() if ally.get("desc")),
        "decoded_powerrank": sum(1 for ally in merged.values() if ally.get("powerrank") != ""),
    }
    return merged, manifest


def merge_allies(
    extracted: list[dict],
    ability_lookup: dict[str, dict],
    multipliers_map: dict[str, dict],
    geode_multipliers_map: dict[str, dict],
    language_map: dict[str, str],
    blueprint_map: dict[str, str],
    category_map: dict[str, str],
) -> tuple[dict, int, int]:
    by_ally: dict[str, list[dict]] = defaultdict(list)
    paths_by_ally: dict[str, list[str]] = defaultdict(list)
    for item in extracted:
        by_ally[item["ally_key"]].append(item)
        paths_by_ally[item["ally_key"]].append(item["prefab_path"])

    merged = {}
    decoded_count = 0
    for ally_key in sorted(by_ally.keys()):
        record = {
            "category": "",
            "name": "",
            "desc": "",
            "designer": "Trove Team",
            "filename": "",
            "blueprint": "",
            "mastery": "0",
            "mastery_geode": "0",
            "powerrank": "",
            "stats": [],
            "ability_paths": [],
            "ability_names": [],
            "abilities": [],
        }

        prefab_items = by_ally[ally_key]
        parsed = best_prefab_record(prefab_items)
        if parsed["stat_lines"]:
            decoded_count += 1
        if parsed["blueprint"]:
            record["blueprint"] = resolve_blueprint_catalog_path(parsed["blueprint"], blueprint_map)
            designer = extract_designer_from_blueprint(parsed["blueprint"])
            if designer:
                record["designer"] = designer
        if not record.get("designer"):
            record["designer"] = "Trove Team"
        category = category_map.get(ally_key, "")
        if category:
            record["category"] = category
        record["filename"] = paths_by_ally[ally_key][0].removesuffix(".binfab")
        name_key, description_key = extract_pet_localization_keys(parsed.get("strings", []))
        localized_name = resolve_pet_name_value(language_map, ally_key, name_key)
        localized_description = resolve_localized_value(language_map, description_key)
        if localized_name:
            record["name"] = localized_name
        if localized_description:
            record["desc"] = localized_description
        decoded_powerranks = {
            value
            for item in prefab_items
            for value in [decode_known_power_rank(item.get("content", b""))]
            if value != ""
        }
        if len(decoded_powerranks) == 1:
            record["powerrank"] = next(iter(decoded_powerranks))
        multiplier_row = multipliers_map.get(record["filename"])
        if multiplier_row is not None:
            record["mastery"] = str(multiplier_row["predicted"])
        geode_multiplier_row = geode_multipliers_map.get(record["filename"])
        if geode_multiplier_row is not None:
            record["mastery_geode"] = str(geode_multiplier_row["predicted"])
        record["stats"] = stat_objects_from_lines(list(parsed["stat_lines"]))
        ability_paths = list(parsed["extracted_abilities"])
        final_ability_descriptions = []
        final_ability_names = []
        for ability_path in ability_paths:
            resolved = ability_lookup.get(ability_path, {})
            if resolved.get("name"):
                final_ability_names.append(resolved["name"])
            if resolved.get("description"):
                final_ability_descriptions.append(resolved["description"])
        record["ability_paths"] = ability_paths
        record["ability_names"] = final_ability_names
        record["abilities"] = final_ability_descriptions
        if not record.get("category"):
            continue
        merged[ally_key] = record

    return merged, decoded_count, len(merged)
