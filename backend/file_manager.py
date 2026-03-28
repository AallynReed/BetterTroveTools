import shutil
import eel
import asyncio
from pathlib import Path
import os
import json
from utils.archive_parser import TFIndex, TFArchive, TroveFile
from utils.registry import get_trove_locations
from utils.helper import read_storage, write_storage
from collections import defaultdict
from backend.settings import get_settings

import tkinter as tk
from tkinter import filedialog
import time
from datetime import datetime
import re
import subprocess


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
        cache_dir = Path(os.getenv("APPDATA")) / "Trove" / "ModManagerCache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / "temp_tree.json"
        
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(tree, f)

        # Tell JS to fetch from the custom Bottle route we just made
        return {"success": True, "cached_file": "/api/cache/temp_tree.json"}
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
def mass_extract_files(dest_dir, files_to_extract):
    try:
        total_files = len(files_to_extract)
        start_time = time.time()
        
        for index, file_data in enumerate(files_to_extract):
            # Send raw integers to the frontend
            if index % 50 == 0 or index == total_files - 1:
                elapsed = time.time() - start_time
                files_per_sec = (index + 1) / elapsed if elapsed > 0 else 0
                eta_seconds = (total_files - (index + 1)) / files_per_sec if files_per_sec > 0 else 0
                
                eel.update_progress_ui(
                    index + 1, 
                    total_files, 
                    file_data.get('filepath', 'Unknown'), 
                    "Extracting...",  # Safe translation key
                    int(eta_seconds), # Raw Integer
                    int(elapsed)      # Raw Integer
                )
                eel.sleep(0.001)

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
                    
                    eta_secs = ""
                    if elapsed > 0.5:
                        rate = processed_count / elapsed
                        eta_secs = int((total_files - processed_count) / rate)
                        
                    eel.update_progress_ui(processed_count, total_files, f["filepath"], "Extracting...", eta_secs, int(elapsed))()

@eel.expose
def select_tracking_directory():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    folder_path = filedialog.askdirectory(title="Select Update Tracking Folder")
    root.destroy()
    return {"success": True, "path": folder_path} if folder_path else {"success": False}

@eel.expose
def get_tracking_status(tracking_dir_str):
    data_path = Path(tracking_dir_str) / "extraction_data.json"
    if data_path.exists():
        try:
            with open(data_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {
                "exists": True, 
                "last_scan": data.get("last_scan_date", "Unknown"), 
                "game_path": data.get("game_path", "Unknown")
            }
        except Exception as e:
            return {"exists": False, "error": str(e)}
    return {"exists": False}

@eel.expose
def build_baseline_cache(game_path_str, tracking_dir_str):
    try:
        asyncio.run(_build_baseline_async(game_path_str, tracking_dir_str))
        return {"success": True}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

async def _build_baseline_async(game_path_str, tracking_dir_str):
    game_path = Path(game_path_str)
    tracking_dir = Path(tracking_dir_str)
    
    cache = {
        "last_scan_date": datetime.utcnow().isoformat() + "Z",
        "game_path": game_path_str,
        "archives": {},
        "files": {}
    }
    
    tfi_files = list(game_path.rglob("index.tfi"))
    total_tfis = len(tfi_files)
    start_time = time.time()
    
    for i, tfi_path in enumerate(tfi_files):
        rel_tfi = tfi_path.relative_to(game_path).as_posix()
        elapsed = time.time() - start_time
        
        eta_secs = ""
        if elapsed > 0.5 and (i + 1) > 0:
            rate = (i + 1) / elapsed
            eta_secs = int((total_tfis - (i + 1)) / rate)
            
        eel.update_progress_ui(i + 1, total_tfis, rel_tfi, "Building Baseline Cache...", eta_secs, int(elapsed))()
        
        index = TFIndex(tfi_path)
        cache["archives"][rel_tfi] = await index.content_hash
        
        archives_dict = {}
        for archive in index.archives:
            rel_tfa = archive.path.relative_to(game_path).as_posix()
            cache["archives"][rel_tfa] = await archive.content_hash
            archives_dict[archive.id] = archive
            
        files = await index.files_list
        for f in files:
            arch_id = f["archive_index"]
            if arch_id in archives_dict:
                archive = archives_dict[arch_id]
                file_obj = TroveFile(offset=f["offset"], size=f["size"], archive=archive)
                file_key = f"{rel_tfi}::{f['name'].replace(chr(92), '/')}"
                cache["files"][file_key] = await file_obj.content_hash

    data_path = tracking_dir / "extraction_data.json"
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=4)


@eel.expose
def scan_and_extract_updates(game_path_str, tracking_dir_str, run_catalog=False):
    try:
        result = asyncio.run(_scan_and_extract_updates_async(game_path_str, tracking_dir_str, run_catalog))
        return {"success": True, "details": result}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

async def _scan_and_extract_updates_async(game_path_str, tracking_dir_str, run_catalog):
    game_path = Path(game_path_str)
    tracking_dir = Path(tracking_dir_str)
    data_path = tracking_dir / "extraction_data.json"
    
    with open(data_path, "r", encoding="utf-8") as f:
        old_cache = json.load(f)
        
    new_cache = {
        "last_scan_date": datetime.utcnow().isoformat() + "Z",
        "game_path": game_path_str,
        "archives": {},
        "files": {}
    }
    
    date_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    update_folder = tracking_dir / date_str
    
    added_files = []
    changed_files = []
    removed_files = []
    
    tfi_files = list(game_path.rglob("index.tfi"))
    total_tfis = len(tfi_files)
    start_time = time.time()
    
    for i, tfi_path in enumerate(tfi_files):
        rel_tfi = tfi_path.relative_to(game_path).as_posix()
        tfi_dir = tfi_path.parent.relative_to(game_path) 
        
        elapsed = time.time() - start_time
        eta_secs = ""
        
        if elapsed > 0.5 and (i + 1) > 0:
            rate = (i + 1) / elapsed
            eta_secs = int((total_tfis - (i + 1)) / rate)
            
        eel.update_progress_ui(i + 1, total_tfis, rel_tfi, "Scanning for Updates...", eta_secs, int(elapsed))()
        
        index = TFIndex(tfi_path)
        new_tfi_hash = await index.content_hash
        new_cache["archives"][rel_tfi] = new_tfi_hash
        
        archives_dict = {}
        tfa_changed = False
        
        for archive in index.archives:
            rel_tfa = archive.path.relative_to(game_path).as_posix()
            new_tfa_hash = await archive.content_hash
            new_cache["archives"][rel_tfa] = new_tfa_hash
            archives_dict[archive.id] = archive
            
            if old_cache["archives"].get(rel_tfa) != new_tfa_hash:
                tfa_changed = True
                
        if not tfa_changed and old_cache["archives"].get(rel_tfi) == new_tfi_hash:
            prefix = f"{rel_tfi}::"
            for k, v in old_cache["files"].items():
                if k.startswith(prefix):
                    new_cache["files"][k] = v
            continue
            
        files = await index.files_list
        current_tfi_files = set()
        
        for f in files:
            arch_id = f["archive_index"]
            if arch_id in archives_dict:
                archive = archives_dict[arch_id]
                file_obj = TroveFile(offset=f["offset"], size=f["size"], archive=archive)
                
                clean_name = f['name'].replace(chr(92), '/')
                file_key = f"{rel_tfi}::{clean_name}"
                current_tfi_files.add(file_key)
                
                full_clean_path = (tfi_dir / clean_name).as_posix()
                
                new_file_hash = await file_obj.content_hash
                new_cache["files"][file_key] = new_file_hash
                
                old_file_hash = old_cache["files"].get(file_key)
                
                if old_file_hash is None:
                    added_files.append((file_obj, full_clean_path, "added"))
                elif old_file_hash != new_file_hash:
                    changed_files.append((file_obj, full_clean_path, "changed"))
                    
        prefix = f"{rel_tfi}::"
        for old_key in old_cache["files"]:
            if old_key.startswith(prefix) and old_key not in current_tfi_files:
                removed_files.append(old_key)
                
    if added_files or changed_files or removed_files:
        update_folder.mkdir(parents=True, exist_ok=True)
        
        async def extract_list(file_list, subfolder_name):
            for file_obj, full_clean_path, status in file_list:
                out_path = update_folder / subfolder_name / full_clean_path
                out_path.parent.mkdir(parents=True, exist_ok=True)
                with open(out_path, "wb") as out:
                    out.write(await file_obj.content)
                    
        await extract_list(added_files, "added")
        await extract_list(changed_files, "changed")
        
        if run_catalog and (added_files or changed_files):
            eel.update_progress_ui(1, 1, "Generating Blueprint Previews...", "Cataloging...", "", "")()
            blueprints_to_catalog = set()
            
            for file_list in [added_files, changed_files]:
                for _, full_clean_path, _ in file_list:
                    if full_clean_path.endswith(".blueprint"):
                        bp_name = re.sub(r"(?:\[.*\])?\.blueprint", "", Path(full_clean_path).name)
                        if len(bp_name.split("_")) >= 5:
                            match = re.match(r"^.*_", bp_name)
                            if match: blueprints_to_catalog.add(match.group(0))
                            else: blueprints_to_catalog.add(bp_name)
                        else:
                            blueprints_to_catalog.add(bp_name)
        
            if blueprints_to_catalog:                
                trove_exe = game_path / "Trove.exe"
                active_processes = []
                cpu_limit = max(1, (os.cpu_count() or 4) - 1)
                
                for bp in blueprints_to_catalog:
                    cmd = f'"{trove_exe}" -tool catalog -filter "{bp}" -dimension "256"'
                    
                    startupinfo = None
                    if os.name == 'nt':
                        startupinfo = subprocess.STARTUPINFO()
                        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                        
                    proc = subprocess.Popen(cmd, cwd=str(game_path), startupinfo=startupinfo)
                    active_processes.append(proc)
                    
                    if len(active_processes) >= cpu_limit:
                        for p in active_processes: p.wait()
                        active_processes = []
                
                for p in active_processes: p.wait()
                
                game_catalog_dir = game_path / "catalog"
                if game_catalog_dir.exists():
                    dest_catalog_dir = update_folder
                    shutil.move(str(game_catalog_dir), str(dest_catalog_dir))
                    
                    for png_file in dest_catalog_dir.glob("*.blueprint.png"):
                        dest_name = png_file.name.replace(".blueprint.png", ".png")
                        png_file.rename(png_file.with_name(dest_name))

    total_elapsed = time.time() - start_time
    emins, esecs = divmod(int(total_elapsed), 60)
    total_elapsed_str = f"{emins}m {esecs}s" if emins > 0 else f"{esecs}s"

    changelog_path = update_folder / "changelog.txt"
    with open(changelog_path, "w", encoding="utf-8") as clog:
        clog.write(f"Trove Update Scan - {date_str}\n")
        clog.write(f"Game Path: {game_path_str}\n")
        clog.write(f"Time Elapsed: {total_elapsed_str}\n")
        clog.write("="*40 + "\n\n")
        
        clog.write(f"ADDED FILES ({len(added_files)}):\n")
        for _, name, _ in added_files: clog.write(f" + {name}\n")
        
        clog.write(f"\nCHANGED FILES ({len(changed_files)}):\n")
        for _, name, _ in changed_files: clog.write(f" ~ {name}\n")
        
        clog.write(f"\nREMOVED FILES ({len(removed_files)}):\n")
        for name in removed_files: 
            clean_removed_name = name.split("::")[-1] if "::" in name else name
            clog.write(f" - {clean_removed_name}\n")
        
    backup_path = update_folder / "extraction_data_backup.json"
    shutil.copy2(data_path, backup_path)
    
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(new_cache, f, indent=4)
        
    return {
        "added": len(added_files),
        "changed": len(changed_files),
        "removed": len(removed_files),
        "folder": str(update_folder) if (added_files or changed_files or removed_files) else None
    }

@eel.expose
def get_tracking_directories():
    data = read_storage()
    dirs = data.get("tracking_directories", [])
    valid_dirs = []
    changed = False
    
    for d in dirs:
        if Path(d["path"]).exists():
            valid_dirs.append(d)
        else:
            changed = True

    if changed:
        data["tracking_directories"] = valid_dirs
        write_storage(data)

    last_used = data.get("last_tracking_directory", "")
    return {"success": True, "directories": valid_dirs, "last_used": last_used}

@eel.expose
def save_tracking_directory(name, path_str):
    data = read_storage()
    dirs = data.get("tracking_directories", [])
    now = datetime.utcnow().isoformat() + "Z"
    
    found = False
    for d in dirs:
        if d["path"] == path_str:
            d["name"] = name
            d["last_used"] = now
            found = True
            break
            
    if not found:
        dirs.append({"name": name, "path": path_str, "last_used": now})

    data["tracking_directories"] = dirs
    data["last_tracking_directory"] = path_str
    write_storage(data)
    return {"success": True}

@eel.expose
def set_last_tracking_directory(path_str):
    data = read_storage()
    dirs = data.get("tracking_directories", [])
    now = datetime.utcnow().isoformat() + "Z"
    
    for d in dirs:
        if d["path"] == path_str:
            d["last_used"] = now
            break
            
    data["tracking_directories"] = dirs
    data["last_tracking_directory"] = path_str
    write_storage(data)
    return {"success": True}