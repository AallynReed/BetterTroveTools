import eel
import asyncio
from pathlib import Path
import os
import json
from utils.archive_parser import TFIndex, TFArchive, TroveFile
from utils.registry import get_trove_locations
from collections import defaultdict
from backend.settings import get_settings

import tkinter as tk
from tkinter import filedialog
import time


@eel.expose
def get_detected_game_paths():
    paths = []
    try:
        for game in get_trove_locations():
            paths.append({
                "name": game.name,
                "path": str(game.path),
                "is_steam": game.is_steam,
                "is_glyph": game.is_glyph
            })
            
        settings = get_settings()
        for custom_dir in settings.get("custom_directories", []):
            name = custom_dir.get("name", "Unknown") if isinstance(custom_dir, dict) else Path(str(custom_dir)).name
            path = custom_dir.get("path", "") if isinstance(custom_dir, dict) else str(custom_dir)
            
            paths.append({
                "name": f"(Custom) {name}",
                "path": path,
                "is_steam": False,
                "is_glyph": False
            })
            
        return {"success": True, "paths": paths}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}
    

@eel.expose
def load_entire_game_tree(game_path_str):
    try:
        tree = asyncio.run(_build_full_tree_async(game_path_str))
        return {"success": True, "tree": tree}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

async def _build_full_tree_async(game_path_str):
    game_path = Path(game_path_str)
    if not game_path.exists():
        raise FileNotFoundError("Game path does not exist.")

    master_tree = {"type": "folder", "children": {}}

    for tfi_path in game_path.rglob("index.tfi"):
        relative_dir = tfi_path.parent.relative_to(game_path)
        
        base_parts = list(relative_dir.parts)

        index = TFIndex(tfi_path)
        files = await index.files_list
        
        for file_data in files:
            internal_path = file_data["name"].replace('\\', '/')
            internal_parts = internal_path.split('/')
            
            full_parts = base_parts + internal_parts
            
            current_node = master_tree["children"]
            
            for part in full_parts[:-1]: 
                if part not in current_node:
                    current_node[part] = {"type": "folder", "children": {}}
                current_node = current_node[part]["children"]
                
            file_name = full_parts[-1]
            current_node[file_name] = {
                "type": "file",
                "size": file_data["size"],
                "archive_index": file_data["archive_index"],
                "offset": file_data["offset"],
                "hash": file_data["hash"],
                "tfi_parent": str(tfi_path)
            }
            
    return master_tree

@eel.expose
def browse_for_game_dir():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()

    folder_path = filedialog.askdirectory(title="Select Trove Installation Folder")
    
    root.destroy()

    if not folder_path:
        return {"success": False, "canceled": True}

    path = Path(folder_path)
    
    if (path / "Trove.exe").exists():
        return {"success": True, "path": str(path)}
    else:
        return {"success": False, "error": "Trove.exe was not found in the selected directory."}
    
@eel.expose
def extract_file_to_disk(tfi_path_str, archive_index, offset, size, default_file_name):
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    
    _, ext = os.path.splitext(default_file_name)
    
    save_path_str = filedialog.asksaveasfilename(
        title="Save Game File As...",
        initialfile=default_file_name,
        defaultextension=ext,
        filetypes=[("All Files", "*.*")]
    )
    root.destroy()
    
    if not save_path_str:
        return {"success": False, "canceled": True}
        
    try:
        asyncio.run(_extract_and_save_async(tfi_path_str, archive_index, offset, size, save_path_str))
        return {"success": True, "saved_to": save_path_str}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


async def _extract_and_save_async(tfi_path_str, archive_index, offset, size, save_path_str):
    tfi_path = Path(tfi_path_str)
    
    index = TFIndex(tfi_path)
    
    tfa_name = f"archive{archive_index}.tfa"
    tfa_path = tfi_path.parent / tfa_name
    
    archive = TFArchive(index, tfa_path)
    
    file_obj = TroveFile(offset=offset, size=size, archive=archive)
    
    file_bytes = await file_obj.content
    
    with open(save_path_str, "wb") as out_file:
        out_file.write(file_bytes)

@eel.expose
def ask_extraction_directory():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    folder_path = filedialog.askdirectory(title="Select Extraction Destination")
    root.destroy()
    return folder_path

@eel.expose
def mass_extract_files(dest_dir_str, file_list):
    try:
        asyncio.run(_mass_extract_async(dest_dir_str, file_list))
        return {"success": True}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

async def _mass_extract_async(dest_dir_str, file_list):
    dest_path = Path(dest_dir_str)
    total_files = len(file_list)
    processed_count = 0
    start_time = time.time()
    
    groups = defaultdict(lambda: defaultdict(list))
    for f in file_list:
        groups[f["tfi"]][f["archive"]].append(f)

    for tfi_path_str, archives in groups.items():
        tfi_path = Path(tfi_path_str)
        index = TFIndex(tfi_path)
        
        for archive_idx, files in archives.items():
            tfa_name = f"archive{archive_idx}.tfa"
            tfa_path = tfi_path.parent / tfa_name
            
            archive = TFArchive(index, tfa_path)
            
            for f in files:
                file_obj = TroveFile(offset=f["offset"], size=f["size"], archive=archive)
                file_bytes = await file_obj.content
                
                clean_relative_path = Path(f["filepath"].replace("\\", "/"))
                out_file_path = dest_path / clean_relative_path
                out_file_path.parent.mkdir(parents=True, exist_ok=True)
                
                with open(out_file_path, "wb") as out:
                    out.write(file_bytes)
                
                processed_count += 1
                if processed_count % max(1, total_files // 50) == 0 or processed_count == total_files:
                    elapsed = time.time() - start_time
                    if elapsed > 0.5:
                        rate = processed_count / elapsed
                        eta_secs = int((total_files - processed_count) / rate)
                        mins, secs = divmod(eta_secs, 60)
                        eta_str = f"{mins}m {secs}s" if mins > 0 else f"{secs}s"
                    else:
                        eta_str = "Calculating..."
                        
                    eel.update_progress_ui(processed_count, total_files, f["filepath"], eta_str)