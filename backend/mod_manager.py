import json
import os
from pathlib import Path

import eel
import requests

from models.trove.mod import TroveGamePath, TroveModList
from utils.functions import BasePath


@eel.expose
def get_installed_mods(game_path_str, fix_names=False, fix_configs=False):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True, fix_names=fix_names, fix_configs=fix_configs)
        
        result_mods = []
        for mod in mod_list:
            result_mods.append({
                "name": mod.name or "Unknown Mod",
                "author": mod.author or "Unknown Author",
                "status": "enabled" if mod.enabled else "disabled",
                "path": str(mod.mod_path),
                "image": mod.image,
                "has_conflicts": mod.has_conflicts,
                "conflicts_with": [
                    {"name": c.name, "enabled": c.enabled} 
                    for c in mod.conflicts
                ] 
            })
            
        # SAVE TO APPDATA INSTEAD OF PROGRAM FILES
        cache_dir = Path(os.getenv("APPDATA")) / "Trove" / "ModManagerCache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / "installed_mods.json"
        
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump({"mods": result_mods}, f)
            
        # Tell JS to fetch from the custom Bottle route we just made
        return {"success": True, "cached_file": "/api/cache/installed_mods.json"}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def toggle_mod(game_path_str, mod_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        
        for mod in mod_list:
            if str(mod.mod_path) == mod_path_str:
                mod.toggle()
                return {"success": True, "new_path": str(mod.mod_path)}
                
        return {"success": False, "error": "Could not locate the mod in the parsed list."}
        
    except FileExistsError:
        return {"success": False, "error": "A file with the toggled name already exists."}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}
    
@eel.expose
def fix_mod_names(game_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True, fix_names=False)
        
        fixed_count = 0
        
        for mod in mod_list:
            if mod.has_wrong_name:
                mod.fix_name()
                fixed_count += 1
                
        return {"success": True, "fixed_count": fixed_count}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}
    
@eel.expose
def fix_mod_configs(game_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        
        configs_ensured = 0
        
        for mod in mod_list:
            if mod.is_ui_mod:
                mod.ensure_config()
                configs_ensured += 1
                
        return {"success": True, "configs_ensured": configs_ensured}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}
    
@eel.expose
def get_mod_urls(game_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        
        hash_to_path = {getattr(mod, 'hash').lower(): str(mod.mod_path) for mod in mod_list if getattr(mod, 'hash', None)}
        if not hash_to_path:
            return {"success": True, "urls": {}}
            
        urls = {}
        hashes_list = list(hash_to_path.keys())
        hash_batches = [hashes_list[i:i + 200] for i in range(0, len(hashes_list), 200)]
        
        for batch in hash_batches:
            payload = {"hashes": ",".join(batch)}
            req_id = None
            try:
                req_id = eel.add_external_request("Fetching Mod Hashes", "https://trovesaurus.com/api/mods-hashes-to-mods")()
            except Exception:
                pass
            try:
                resp = requests.post("https://trovesaurus.com/api/mods-hashes-to-mods", data=payload, timeout=10)
                if req_id:
                    eel.remove_external_request(req_id, resp.status_code == 200)()
                    req_id = None
                if resp.status_code == 200:
                    batch_results = resp.json()
                    for h, mod_id in batch_results.items():
                        path = hash_to_path.get(h.lower())
                        if path:
                            urls[path] = f"https://trovesaurus.com/mod={mod_id}"
            except Exception as e:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                    req_id = None
                print(f"Failed hash batch: {e}")

        return {"success": True, "urls": urls}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def check_mod_updates(game_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        mod_list.update_trovesaurus_data()
        
        updates_available = {}
        for mod in mod_list:
            if mod.has_update:
                updates_available[str(mod.mod_path)] = True
                
        return {"success": True, "updates": updates_available}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def perform_mod_update(game_path_str, mod_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        mod_list.update_trovesaurus_data() 
        
        for mod in mod_list:
            if str(mod.mod_path) == mod_path_str:
                success = mod.update()
                return {"success": success}
                
        return {"success": False, "error": "Mod not found in the list."}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}