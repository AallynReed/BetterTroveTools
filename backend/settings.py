import json
import os
from pathlib import Path

import eel

from backend.response import resp, standardize_response
from utils.executable import find_trove_executable
from utils.path import (
    DATA_DIR_ENV_VAR,
    get_app_data_dir,
    get_cache_root,
    get_data_dir_override,
    get_data_dir_override_file,
    get_default_app_data_dir,
    get_default_mod_cfgs_dir,
    get_mod_cfgs_dir,
    get_mod_cfgs_override,
    set_data_dir_override,
    supports_data_dir_override,
)
from utils.registry import get_trove_locations, TroveGamePath, invalidate_trove_locations_cache


def _normalize_settings_payload(payload):
    if not isinstance(payload, dict):
        return {
            "custom_directories": [],
            "ui_preferences": {},
            "app_font": "system",
            "ui_scale": 1,
        }

    # Accept wrapped responses and extract raw settings payload.
    if all(k in payload for k in ("success", "code", "data", "error", "meta")) and isinstance(payload.get("data"), dict):
        payload = payload.get("data") or {}

    normalized = {}

    normalized["custom_directories"] = payload.get("custom_directories", []) if isinstance(payload.get("custom_directories"), list) else []
    normalized["ui_preferences"] = payload.get("ui_preferences", {}) if isinstance(payload.get("ui_preferences"), dict) else {}

    app_font = payload.get("app_font")
    normalized["app_font"] = app_font if app_font in ("system", "product-sans", "noto-sans", "inter", "roboto", "segoe-ui", "arial") else "system"

    # Accessibility UI scale. Clamped to the same 0.7-1.5 range the frontend
    # offers so a hand-edited settings.json can't zoom the app into unusability.
    try:
        ui_scale = float(payload.get("ui_scale", 1))
    except (TypeError, ValueError):
        ui_scale = 1.0
    normalized["ui_scale"] = min(1.5, max(0.7, ui_scale))

    allowed_keys = [
        "accent_color", "show_community_content", "show_official_news",
        "show_player_activity",
        "auto_fix_names", "show_mod_preview_on_info_side", "hide_beta_features",
        "enable_legacy_projects", "close_to_tray", "beta_builds",
        "last_game_path", "locale", "mod_cfgs_path"
    ]
    for key in allowed_keys:
        if key in payload:
            normalized[key] = payload[key]

    # Rotation-reminder config: a nested dict the desktop app persists here so
    # the backend scheduler can be re-armed on launch. (On Android this lives in
    # local web-mode storage instead.) Passed through as-is -- the frontend owns
    # its shape and deep-merges defaults on load.
    if isinstance(payload.get("notifications"), dict):
        normalized["notifications"] = payload["notifications"]

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

    # Follow the selected install with the mods-folder watch, so picking a
    # different game here also moves what the app is watching -- the Mod Manager
    # doesn't have to be open for that.
    last_path = normalized.get("last_game_path")
    if isinstance(last_path, str) and last_path.strip():
        try:
            from backend.mod_manager.mod_watcher import watcher
            watcher.set_target(last_path.strip())
        except Exception:
            pass

    normalized["game_installs"] = [{"name": game.name, "path": str(game.path)} for game in games]
    return resp(True, data=normalized, **normalized)


# --- Folders -------------------------------------------------------------
# Two paths the user can move. The data directory can't be a normal setting
# (settings.json sits inside it) so it lives in a pointer file; the mod-config
# folder is an ordinary key in settings.json.


def _validate_folder(raw):
    """Resolve a user-entered folder, creating and write-testing it. Returns
    (path, None) or (None, error_response)."""
    target = Path(os.path.expandvars(raw)).expanduser()
    if not target.is_absolute():
        return None, resp(False, error="Enter an absolute path.", code="INVALID_PATH")
    if target.exists() and not target.is_dir():
        return None, resp(False, error="That path is a file, not a folder.", code="INVALID_PATH")
    try:
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".btt-write-test"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        return None, resp(False, error=f"That folder isn't writable: {exc}", code="NOT_WRITABLE")
    return target, None


def _folders_payload():
    data_override = get_data_dir_override()
    cfgs_override = get_mod_cfgs_override()
    return {
        "data_dir": {
            "supported": supports_data_dir_override(),
            "current": str(get_app_data_dir()),
            "default": str(get_default_app_data_dir()),
            "override": str(data_override) if data_override else "",
            "from_env": bool(os.getenv(DATA_DIR_ENV_VAR, "").strip()),
            "env_var": DATA_DIR_ENV_VAR,
            "config_file": str(get_data_dir_override_file()),
        },
        "mod_cfgs": {
            "supported": True,
            "current": str(get_mod_cfgs_dir()),
            "default": str(get_default_mod_cfgs_dir()),
            "override": str(cfgs_override) if cfgs_override else "",
        },
    }


@eel.expose
@standardize_response
def get_folder_settings():
    return resp(True, data=_folders_payload())


@eel.expose
@standardize_response
def set_data_dir(path=None):
    """Point the app at a different data directory (or, with an empty path,
    back at the default). Existing files are not moved, and the change only
    applies after a restart."""
    if not supports_data_dir_override():
        return resp(False, error="The data folder can only be changed on Linux and macOS.",
                    code="UNSUPPORTED_PLATFORM")

    raw = str(path or "").strip()
    if raw:
        _, error = _validate_folder(raw)
        if error:
            return error

    set_data_dir_override(raw)
    payload = _folders_payload()
    payload["restart_required"] = True
    return resp(True, data=payload)


@eel.expose
@standardize_response
def set_mod_cfgs_path(path=None):
    """Point mod configs at the folder the game actually reads (or, with an
    empty path, back at %APPDATA%/Trove/ModCfgs). Applies immediately: the
    installed mods are re-probed so their .cfg files land in the new folder."""
    raw = str(path or "").strip()
    if raw:
        target, error = _validate_folder(raw)
        if error:
            return error
        raw = str(target)

    stored = _read_settings_from_disk()
    stored["mod_cfgs_path"] = raw
    save_settings(stored)

    last_path = stored.get("last_game_path")
    if isinstance(last_path, str) and last_path.strip():
        try:
            from backend.mod_manager.mod_watcher import probe_configs
            probe_configs(last_path.strip())
        except Exception:
            pass

    return resp(True, data=_folders_payload())
