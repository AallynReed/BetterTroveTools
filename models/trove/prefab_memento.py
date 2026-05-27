from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

from models.trove.prefab_ally import (
    clean_localized_text,
    detect_first_glyph_install,
    extract_designer_from_blueprint,
    find_index_entry,
    infer_mastery_base,
    iter_index_entries,
    load_blueprint_path_map,
    load_language_map,
    load_multiplier_file_map,
    read_archive_content,
    require_prefabs_root,
    resolve_blueprint_catalog_path,
    resolve_localized_value,
)
from utils.mount_binfab import extract_strings


ITEM_UNLOCKER_PREFIX = "item/unlocker/"
MEMENTO_NAME_KEY_RE = re.compile(r"(\$prefabs_[A-Za-z0-9_]+_name)")
MEMENTO_DESC_KEY_RE = re.compile(r"(\$prefabs_[A-Za-z0-9_]+(?:_description|_desc))")
MEMENTO_PREFIX_RE = re.compile(r"^\s*Memento:\s*", re.IGNORECASE)
DELVE_TIER_PREFIX = "$DelveTier_"
MEMENTO_BLUEPRINT_PREFIXES = (
    "memento_biome_",
    "memento_mob_",
    "memento_boss_",
)
MEMENTO_KEY_PREFIXES = (
    "$prefabs_item_unlocker_delve_path_",
    "$prefabs_item_unlocker_delve_boss_",
    "$prefabs_item_unlocker_delve_decor_",
    "$prefabs_npc_delve_path_",
    "$prefabs_npc_delve_boss_",
)


def _normalize_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _extract_key_suffix(value: str, prefixes: tuple[str, ...]) -> str:
    text = clean_localized_text(str(value or "")).strip()
    text = text.removesuffix("_name").removesuffix("_description").removesuffix("_desc")
    for prefix in prefixes:
        if text.startswith(prefix):
            return text.removeprefix(prefix)
    return text.lstrip("$")


def _extract_identifier_suffix(identifier: str) -> str:
    normalized = str(identifier or "").replace("\\", "/").strip()
    prefixes = (
        f"{ITEM_UNLOCKER_PREFIX}delve/path/",
        f"{ITEM_UNLOCKER_PREFIX}delve/boss/",
        f"{ITEM_UNLOCKER_PREFIX}delve/decor/",
    )
    for prefix in prefixes:
        if normalized.startswith(prefix):
            return normalized.removeprefix(prefix)
    return Path(normalized).name


def _extract_blueprint_suffix(raw_blueprint: str) -> str:
    stem = Path(str(raw_blueprint or "").replace("\\", "/").removesuffix(".blueprint")).name
    for prefix in MEMENTO_BLUEPRINT_PREFIXES:
        if stem.startswith(prefix):
            return stem.removeprefix(prefix)
    return stem


def _split_words(value: str) -> list[str]:
    text = str(value or "").replace("\\", "/")
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    text = re.sub(r"[^A-Za-z0-9]+", " ", text)
    words = []
    for part in text.split():
        normalized = _normalize_token(part)
        if normalized and not normalized.isdigit() and len(normalized) >= 3:
            words.append(normalized)
    return words


def _build_match_features(values: list[str]) -> dict[str, set[str]]:
    words: set[str] = set()
    joined: set[str] = set()
    for value in values:
        normalized = _normalize_token(value)
        if normalized:
            joined.add(normalized)
        words.update(_split_words(value))
    return {"words": words, "joined": joined}


def _build_memento_source_values(identifier: str, raw_blueprint: str, name_key: str, name: str = "") -> list[str]:
    values = [
        _extract_identifier_suffix(identifier),
        _extract_blueprint_suffix(raw_blueprint),
        _extract_key_suffix(name_key, MEMENTO_KEY_PREFIXES),
        MEMENTO_PREFIX_RE.sub("", str(name or "")).strip(),
    ]
    return [value for value in values if value]


def _collect_profile_tokens(profile: dict[str, object], *fields: str) -> set[str]:
    tokens: set[str] = set()
    for field in fields:
        tokens.update(profile.get(field, set()))
    return tokens


def _build_token_weights(profiles: list[dict[str, object]], *fields: str) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for profile in profiles:
        for token in _collect_profile_tokens(profile, *fields):
            counts[token] += 1
    return {
        token: max(len(token) * len(token) // count, 1)
        for token, count in counts.items()
    }


def _build_delve_tier_profiles(language_map: dict[str, str]) -> list[dict[str, object]]:
    profiles: list[dict[str, object]] = []
    for key, value in language_map.items():
        if not value or not key.startswith(DELVE_TIER_PREFIX):
            continue
        tier_key = key.removeprefix(DELVE_TIER_PREFIX)
        key_features = _build_match_features([tier_key])
        name_features = _build_match_features([value])
        profiles.append(
            {
                "tier_key": tier_key,
                "biome_name": value,
                "key_words": key_features["words"],
                "key_joined": key_features["joined"],
                "name_words": name_features["words"],
                "name_joined": name_features["joined"],
                "extra_words": set(),
                "extra_joined": set(),
            }
        )
    return profiles


def _score_delve_tier_profile(
    profile: dict[str, object],
    features: dict[str, set[str]],
    key_word_weights: dict[str, int],
    key_joined_weights: dict[str, int],
    other_word_weights: dict[str, int],
    other_joined_weights: dict[str, int],
) -> tuple[int, int, int, int]:
    profile_key_words = _collect_profile_tokens(profile, "key_words")
    profile_key_joined = _collect_profile_tokens(profile, "key_joined")
    profile_other_words = _collect_profile_tokens(profile, "name_words", "extra_words")
    profile_other_joined = _collect_profile_tokens(profile, "name_joined", "extra_joined")
    source_words = features.get("words", set())
    source_joined = features.get("joined", set())

    shared_key_words = profile_key_words & source_words
    shared_key_joined = profile_key_joined & source_joined
    shared_other_words = profile_other_words & source_words
    shared_other_joined = profile_other_joined & source_joined

    key_word_score = sum(key_word_weights.get(token, 1) for token in shared_key_words)
    key_joined_score = sum(key_joined_weights.get(token, 1) for token in shared_key_joined)
    other_word_score = sum(other_word_weights.get(token, 1) for token in shared_other_words)
    other_joined_score = sum(other_joined_weights.get(token, 1) for token in shared_other_joined)

    prefix_bonus = 0
    for source_word in source_words:
        if len(source_word) < 4:
            continue
        for profile_word in profile_key_words:
            if len(profile_word) < 4:
                continue
            if source_word.startswith(profile_word) or profile_word.startswith(source_word):
                prefix_bonus += min(len(source_word), len(profile_word))

    score = key_joined_score * 20 + key_word_score * 10 + other_joined_score * 2 + other_word_score + prefix_bonus
    return score, len(shared_key_words), len(shared_key_joined), len(shared_other_words)


def _match_delve_tier_profile(profiles: list[dict[str, object]], values: list[str]) -> dict[str, object] | None:
    features = _build_match_features(values)
    key_word_weights = _build_token_weights(profiles, "key_words")
    key_joined_weights = _build_token_weights(profiles, "key_joined")
    other_word_weights = _build_token_weights(profiles, "name_words", "extra_words")
    other_joined_weights = _build_token_weights(profiles, "name_joined", "extra_joined")
    best_profile = None
    best_score = (0, 0, 0, 0)
    for profile in profiles:
        score = _score_delve_tier_profile(
            profile,
            features,
            key_word_weights,
            key_joined_weights,
            other_word_weights,
            other_joined_weights,
        )
        if score > best_score:
            best_score = score
            best_profile = profile
    if best_profile is None or best_score[0] <= 0:
        return None
    return best_profile


def _match_delve_tier_by_biome_name(profiles: list[dict[str, object]], name: str) -> dict[str, object] | None:
    normalized_name = _normalize_token(MEMENTO_PREFIX_RE.sub("", str(name or "")).strip())
    if not normalized_name:
        return None
    for profile in profiles:
        if _normalize_token(str(profile.get("biome_name") or "")) == normalized_name:
            return profile
    return None


def _enrich_delve_tier_profile(profile: dict[str, object], values: list[str]) -> None:
    features = _build_match_features([value for value in values if value])
    profile["extra_words"] = set(profile.get("extra_words", set())) | features["words"]
    profile["extra_joined"] = set(profile.get("extra_joined", set())) | features["joined"]


def _strip_memento_prefix(name: str) -> str:
    return MEMENTO_PREFIX_RE.sub("", str(name or "")).strip()


def _build_memento_source(category: str, name: str, biome_name: str) -> tuple[str, str]:
    if category == "DelveBiome":
        return "Biome", biome_name or _strip_memento_prefix(name)
    if category == "DelveBoss":
        return "Boss", _strip_memento_prefix(name)
    if category == "DelveCreature":
        return "Creature", _strip_memento_prefix(name)
    return "", ""


def infer_memento_biome_name(
    identifier: str,
    raw_blueprint: str,
    name_key: str,
    name: str,
    category: str,
    delve_tier_profiles: list[dict[str, object]],
) -> str:
    if category == "DelveBiome":
        profile = _match_delve_tier_by_biome_name(delve_tier_profiles, name)
        if profile:
            return str(profile.get("biome_name") or "")

    source_values = _build_memento_source_values(identifier, raw_blueprint, name_key, name)
    profile = _match_delve_tier_profile(delve_tier_profiles, source_values)
    if not profile:
        return ""
    return str(profile.get("biome_name") or "")


def load_collection_memento_category_map(game_path: Path) -> dict[str, str]:
    prefabs_root = require_prefabs_root(game_path)
    target_file = "collections/collection_memento.binfab"
    found = find_index_entry(prefabs_root, target_file)
    if not found:
        return {}
    tfi_path, entry = found
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
        if normalized.startswith(ITEM_UNLOCKER_PREFIX) and current_category:
            category_map[normalized] = current_category
    return category_map


def load_memento_multipliers_map(game_path: Path) -> dict[str, dict]:
    rows = load_multiplier_file_map(game_path, "meta/multipliers.binfab")
    return {key: value for key, value in rows.items() if key.startswith(ITEM_UNLOCKER_PREFIX)}


async def find_memento_prefabs(game_path: Path) -> list[dict]:
    prefabs_root = require_prefabs_root(game_path)
    matches = []
    for tfi_path, prefab_path, file_data in iter_index_entries(prefabs_root):
        lowered = prefab_path.lower()
        if lowered.startswith(ITEM_UNLOCKER_PREFIX) and lowered.endswith(".binfab"):
            matches.append(
                {
                    "tfi_path": tfi_path,
                    "archive_index": file_data["archive_index"],
                    "offset": file_data["offset"],
                    "size": file_data["size"],
                    "internal_name": file_data["name"].replace("\\", "/"),
                    "prefab_path": prefab_path,
                    "identifier": prefab_path.removesuffix(".binfab").replace("\\", "/"),
                }
            )
    return matches


async def load_memento_prefabs(game_path: Path, matches: list[dict]) -> list[dict]:
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
                    "strings": extract_strings(content),
                }
            )
    return loaded


def extract_memento_localization_keys(strings: list[dict]) -> tuple[str, str]:
    name_key = ""
    description_key = ""
    for item in strings:
        text = clean_localized_text(item["text"]).strip("#!@")
        if not name_key:
            match = MEMENTO_NAME_KEY_RE.search(text)
            if match:
                name_key = clean_localized_text(match.group(1))
        if not description_key:
            match = MEMENTO_DESC_KEY_RE.search(text)
            if match:
                description_key = clean_localized_text(match.group(1))
        if name_key and description_key:
            break
    return name_key, description_key


def choose_memento_blueprint(strings: list[dict]) -> str:
    candidates = []
    for entry in strings:
        text = clean_localized_text(entry["text"]).strip("#!@").lstrip("$")
        lowered = text.lower()
        if ".blueprint" in lowered:
            candidates.append(text)
        elif "/mementos/" in lowered:
            candidates.append(f"{text}.blueprint" if not lowered.endswith(".blueprint") else text)
    if not candidates:
        return ""
    candidates.sort(key=lambda value: (".blueprint" not in value.lower(), len(value)))
    return candidates[0]


def build_memento_record(
    identifier: str,
    prefab_lookup: dict[str, dict],
    blueprint_map: dict[str, object],
    language_map: dict[str, str],
    category: str,
    multipliers_map: dict[str, dict],
    delve_tier_profiles: list[dict[str, object]],
) -> dict:
    prefab = prefab_lookup.get(identifier, {}) or prefab_lookup.get(str(identifier).lower(), {})
    strings = prefab.get("strings", [])
    name_key, desc_key = extract_memento_localization_keys(strings)
    name = resolve_localized_value(language_map, name_key)
    desc = resolve_localized_value(language_map, desc_key)
    raw_blueprint = choose_memento_blueprint(strings)
    blueprint = resolve_blueprint_catalog_path(raw_blueprint, blueprint_map) or raw_blueprint.removesuffix(".blueprint")
    biome_name = ""
    if category == "DelveBiome":
        biome_name = infer_memento_biome_name(
            identifier,
            raw_blueprint,
            name_key,
            name,
            category,
            delve_tier_profiles,
        )
    source_label, source_name = _build_memento_source(category, name, biome_name)
    _, base_mastery = infer_mastery_base(identifier)
    multiplier_row = multipliers_map.get(identifier)
    mastery = multiplier_row["predicted"] if multiplier_row is not None else base_mastery

    return {
        "name": name,
        "desc": desc,
        "category": category,
        "designer": extract_designer_from_blueprint(blueprint) or "Trove Team",
        "filename": identifier,
        "blueprint": blueprint,
        "biome_name": biome_name,
        "context_name": source_name,
        "source_label": source_label,
        "source_name": source_name,
        "mastery": str(mastery),
        "mastery_base": str(base_mastery),
        "mastery_source": "multiplier" if multiplier_row is not None else "base",
        "name_key": name_key,
        "desc_key": desc_key,
        "stats": [],
        "ability_paths": [],
    }


async def build_mementos_dataset(
    game_path: Path | None = None,
    *,
    locale: str = "en",
) -> tuple[dict[str, dict], dict[str, object]]:
    game_path = game_path or detect_first_glyph_install()
    language_map = load_language_map(game_path, locale)
    blueprint_map = load_blueprint_path_map(game_path)
    category_map = load_collection_memento_category_map(game_path)
    multipliers_map = load_memento_multipliers_map(game_path)
    matches = await find_memento_prefabs(game_path)
    loaded_prefabs = await load_memento_prefabs(game_path, matches)
    prefab_lookup = {row["identifier"]: row for row in loaded_prefabs}
    prefab_lookup.update({row["identifier"].lower(): row for row in loaded_prefabs})
    delve_tier_profiles = _build_delve_tier_profiles(language_map)

    merged: dict[str, dict] = {}
    filtered_identifiers = []
    for identifier in sorted(category_map.keys()):
        category = category_map.get(identifier, "")
        if category in {"InProgress", "ReadyForGame", "Hidden"}:
            continue
        filtered_identifiers.append((identifier, category))

    for identifier, category in filtered_identifiers:
        if category != "DelveBiome":
            continue
        prefab = prefab_lookup.get(identifier, {}) or prefab_lookup.get(str(identifier).lower(), {})
        strings = prefab.get("strings", [])
        raw_blueprint = choose_memento_blueprint(strings)
        record = build_memento_record(
            identifier,
            prefab_lookup,
            blueprint_map,
            language_map,
            category,
            multipliers_map,
            delve_tier_profiles,
        )
        merged[identifier] = record
        if record.get("biome_name"):
            profile = _match_delve_tier_by_biome_name(delve_tier_profiles, record.get("biome_name", ""))
            if profile is not None:
                _enrich_delve_tier_profile(
                    profile,
                    _build_memento_source_values(identifier, raw_blueprint, record.get("name_key", ""), record.get("name", "")),
                )

    for identifier, category in filtered_identifiers:
        if category == "DelveBiome":
            continue
        merged[identifier] = build_memento_record(
            identifier,
            prefab_lookup,
            blueprint_map,
            language_map,
            category,
            multipliers_map,
            delve_tier_profiles,
        )

    manifest = {
        "game_path": str(game_path),
        "memento_count": len(merged),
        "collection_categories": len(category_map),
        "item_unlocker_prefabs": len(matches),
        "decoded_names": sum(1 for row in merged.values() if row.get("name")),
        "decoded_descriptions": sum(1 for row in merged.values() if row.get("desc")),
        "decoded_blueprints": sum(1 for row in merged.values() if row.get("blueprint")),
        "decoded_mastery": sum(1 for row in merged.values() if row.get("mastery") not in ("", "0")),
        "decoded_categories": sum(1 for row in merged.values() if row.get("category") and row.get("category") != "Unknown"),
    }
    return merged, manifest
