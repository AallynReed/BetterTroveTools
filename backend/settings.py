import eel
import json
import os
from pathlib import Path

def get_settings_file():
    appdata = Path(os.getenv("APPDATA"))
    settings_dir = appdata.joinpath("Trove", "ModManagerCache")
    settings_dir.mkdir(parents=True, exist_ok=True)
    return settings_dir.joinpath("settings.json")

@eel.expose
def get_settings():
    settings_file = get_settings_file()
    if settings_file.exists():
        try:
            data = json.loads(settings_file.read_text(encoding="utf-8"))
            
            if "custom_directories" in data:
                migrated = []
                changed = False
                for item in data["custom_directories"]:
                    if isinstance(item, str):
                        item_dict = {"name": Path(item).name, "path": item}
                        changed = True
                    else:
                        item_dict = item
                        
                    target_path = Path(item_dict.get("path", ""))
                    if target_path.exists() and (target_path / "Trove.exe").exists():
                        migrated.append(item_dict)
                    else:
                        changed = True
                        
                data["custom_directories"] = migrated
                
                if changed:
                    save_settings(data)
                
            return data
        except Exception:
            pass
    return {"custom_directories": []}

@eel.expose
def save_settings(settings):
    settings_file = get_settings_file()
    settings_file.write_text(json.dumps(settings), encoding="utf-8")
    return {"success": True}