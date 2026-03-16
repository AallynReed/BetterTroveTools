import eel
from pathlib import Path
from models.trove.mod import TroveModList, TroveGamePath
import asyncio

@eel.expose
def get_installed_mods(game_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        
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
            
        return {"success": True, "mods": result_mods}
        
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
def check_mod_updates(game_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        asyncio.run(mod_list.update_trovesaurus_data())
        
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
        asyncio.run(mod_list.update_trovesaurus_data()) 
        
        for mod in mod_list:
            if str(mod.mod_path) == mod_path_str:
                success = asyncio.run(mod.update())
                return {"success": success}
                
        return {"success": False, "error": "Mod not found in the list."}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}