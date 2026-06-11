import json
import os
from pathlib import Path

import eel

from backend.response import resp, standardize_response
from utils.executable import find_trove_executable
from utils.path import get_cache_root
from utils.registry import get_trove_locations, TroveGamePath, invalidate_trove_locations_cache


def _normalize_settings_payload(payload):
    if not isinstance(payload, dict):
        return {
            "custom_directories": [],
            "ui_preferences": {},
            "app_font": "system",
        }

    # Accept wrapped responses and extract raw settings payload.
    if all(k in payload for k in ("success", "code", "data", "error", "meta")) and isinstance(payload.get("data"), dict):
        payload = payload.get("data") or {}

    normalized = {}

    normalized["custom_directories"] = payload.get("custom_directories", []) if isinstance(payload.get("custom_directories"), list) else []
    normalized["ui_preferences"] = payload.get("ui_preferences", {}) if isinstance(payload.get("ui_preferences"), dict) else {}

    app_font = payload.get("app_font")
    normalized["app_font"] = app_font if app_font in ("system", "product-sans", "noto-sans", "inter", "roboto", "segoe-ui", "arial") else "system"

    allowed_keys = [
        "accent_color", "show_community_content", "show_official_news",
        "show_player_activity",
        "auto_fix_names", "show_mod_preview_on_info_side", "hide_beta_features",
        "last_game_path", "locale"
    ]
    for key in allowed_keys:
        if key in payload:
            normalized[key] = payload[key]

    return normalized

def _get_all_games(settings_data):
    games = list(get_trove_locations())
    for item in settings_data.get("custom_directories", []):
        if isinstance(item, dict) and "path" in item:
            p = Path(item["path"])
            if not any(g.path == p for g in games):
                games.append(TroveGamePath(p, name=f"(Custom) {item.get('name', p.name)}"))
        elif isinstance(item, str):
            p = Path(item)
            if not any(g.path == p for g in games):
                games.append(TroveGamePath(p, name=f"(Custom) {p.name}"))
    return games

def get_settings_file():
    settings_dir = get_cache_root()
    settings_dir.mkdir(parents=True, exist_ok=True)
    return settings_dir.joinpath("settings.json")


def _attach_games_payload(data, include_games):
    """Populate game_installs on `data`. When include_games is False we skip
    the registry scan entirely -- callers that only need font/locale/preferences
    don't pay that cost. Settings page passes include_games=True explicitly."""
    if not include_games:
        return
    games = _get_all_games(data)
    data["game_installs"] = [{"name": game.name, "path": str(game.path)} for game in games]


@eel.expose
@standardize_response
def get_settings(include_games=True):
    settings_file = get_settings_file()
    if settings_file.exists():
        try:
            data = _normalize_settings_payload(json.loads(settings_file.read_text(encoding="utf-8")))

            migrated = []
            changed = False
            for item in data["custom_directories"]:
                if isinstance(item, str):
                    item_dict = {"name": Path(item).name, "path": item}
                    changed = True
                else:
                    item_dict = item

                target_path = Path(item_dict.get("path", ""))
                if find_trove_executable(target_path):
                    migrated.append(item_dict)
                else:
                    changed = True

            data["custom_directories"] = migrated

            if changed:
                return save_settings(data)

            _attach_games_payload(data, include_games)
            return resp(True, data=data, **data)
        except Exception:
            pass

    data = {
        "custom_directories": [],
        "ui_preferences": {},
    }
    _attach_games_payload(data, include_games)
    return resp(True, data=data, **data)

def _custom_dirs_key(payload):
    """Stable signature of the custom_directories list so we can tell whether a
    save actually added/removed/edited a custom install. Order matters because
    UI ordering is preserved."""
    items = (payload or {}).get("custom_directories", []) if isinstance(payload, dict) else []
    if not isinstance(items, list):
        return ()
    out = []
    for item in items:
        if isinstance(item, dict):
            out.append((str(item.get("name", "")), str(item.get("path", ""))))
        elif isinstance(item, str):
            out.append(("", item))
    return tuple(out)


def _read_settings_from_disk():
    settings_file = get_settings_file()
    if not settings_file.exists():
        return {}
    try:
        return _normalize_settings_payload(json.loads(settings_file.read_text(encoding="utf-8")))
    except Exception:
        return {}


@eel.expose
@standardize_response
def save_settings(settings):
    normalized = _normalize_settings_payload(settings)

    # Only the custom_directories list changes which installs the registry-scan
    # cache should return. If save_settings was called purely to update the
    # font / accent / locale, we keep the cache. Otherwise the next
    # get_trove_locations() call rescans.
    prior_payload = _read_settings_from_disk()
    if _custom_dirs_key(prior_payload) != _custom_dirs_key(normalized):
        invalidate_trove_locations_cache()

    games = _get_all_games(normalized)

    settings_file = get_settings_file()
    settings_file.write_text(json.dumps(normalized), encoding="utf-8")
    normalized["game_installs"] = [{"name": game.name, "path": str(game.path)} for game in games]
    return resp(True, data=normalized, **normalized)
