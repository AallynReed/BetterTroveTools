import json
import os
from pathlib import Path

import eel

from backend.response import resp, standardize_response
from utils.executable import find_trove_executable, FPS_OPTIONS, UNCAPPED_FPS
from utils.registry import get_trove_locations, TroveGamePath

_ALLOWED_FPS = set(FPS_OPTIONS) | {0, UNCAPPED_FPS}  # 0 accepted as alias for uncapped


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

def _apply_fps_payload(target, games, default=120):
    """Populate target['fps_caps'] (path -> current cap) and target['fps_repair']
    (paths whose FPS slot could not be read, i.e. the install needs a repair).
    UNCAPPED_FPS is preserved; only an unreadable slot falls back to default."""
    raw = {str(game.path): game.get_current_fps() for game in games}
    target["fps_caps"] = {p: (default if v is None else v) for p, v in raw.items()}
    target["fps_repair"] = [p for p, v in raw.items() if v is None]

def get_settings_file():
    appdata = Path(os.getenv("APPDATA"))
    settings_dir = appdata.joinpath("Trove", "ModManagerCache")
    settings_dir.mkdir(parents=True, exist_ok=True)
    return settings_dir.joinpath("settings.json")


@eel.expose
@standardize_response
def get_settings():
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

            games = _get_all_games(data)
            _apply_fps_payload(data, games)
            data["game_installs"] = [{"name": game.name, "path": str(game.path)} for game in games]
            return resp(True, data=data, **data)
        except Exception:
            pass

    data = {
        "custom_directories": [],
        "ui_preferences": {},
    }
    games = _get_all_games(data)
    _apply_fps_payload(data, games)
    data["game_installs"] = [{"name": game.name, "path": str(game.path)} for game in games]
    return resp(True, data=data, **data)

@eel.expose
@standardize_response
def save_settings(settings):
    incoming_payload = settings.get("data", settings) if isinstance(settings, dict) and "data" in settings else settings
    incoming_fps_caps = incoming_payload.get("fps_caps", {}) if isinstance(incoming_payload, dict) else {}
    
    normalized = _normalize_settings_payload(settings)
    games = _get_all_games(normalized)
    
    for game in games:
        path_str = str(game.path)
        if path_str in incoming_fps_caps:
            try:
                target = int(incoming_fps_caps[path_str])
                if target in _ALLOWED_FPS:  # selectable caps + uncapped (9999 / 0)
                    game.patch_fps(target)
            except (ValueError, TypeError):
                pass
                
    settings_file = get_settings_file()
    settings_file.write_text(json.dumps(normalized), encoding="utf-8")
    _apply_fps_payload(normalized, games)
    normalized["game_installs"] = [{"name": game.name, "path": str(game.path)} for game in games]
    return resp(True, data=normalized, **normalized)
