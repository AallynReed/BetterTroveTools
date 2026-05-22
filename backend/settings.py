import json
import os
from pathlib import Path

import eel

from backend.response import resp, standardize_response


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

    normalized = dict(payload)

    if "custom_directories" not in normalized or not isinstance(normalized.get("custom_directories"), list):
        normalized["custom_directories"] = []
    if "ui_preferences" not in normalized or not isinstance(normalized.get("ui_preferences"), dict):
        normalized["ui_preferences"] = {}
    if "app_font" not in normalized or normalized.get("app_font") not in ("system", "product-sans", "noto-sans", "inter", "roboto", "segoe-ui", "arial"):
        normalized["app_font"] = "system"

    # Strip accidental envelope keys if they leaked into file payload.
    for key in ("success", "code", "error", "meta", "data"):
        if key in normalized and key not in ("ui_preferences",):
            normalized.pop(key, None)
    normalized.pop("auto_fix_configs", None)
    normalized.pop("auto_fix_configs_enabled_v1", None)

    return normalized

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
                if target_path.exists() and next(target_path.glob("[Tt]rove*.exe"), None):
                    migrated.append(item_dict)
                else:
                    changed = True

            data["custom_directories"] = migrated

            if changed:
                save_settings(data)

            return resp(True, data=data, **data)
        except Exception:
            pass

    data = {
        "custom_directories": [],
        "ui_preferences": {},
    }
    return resp(True, data=data, **data)

@eel.expose
@standardize_response
def save_settings(settings):
    normalized = _normalize_settings_payload(settings)
    settings_file = get_settings_file()
    settings_file.write_text(json.dumps(normalized), encoding="utf-8")
    return resp(True)
