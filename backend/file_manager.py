import shutil

import eel
from backend.response import resp, standardize_response
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

import threading


class OperationCancelled(Exception):
    pass


_FILE_MANAGER_CANCEL_FLAGS = {
    "load_tree": threading.Event(),
    "mass_extract": threading.Event(),
    "build_baseline": threading.Event(),
    "scan_updates": threading.Event(),
}


def _reset_cancel_flag(operation):
    event = _FILE_MANAGER_CANCEL_FLAGS.get(operation)
    if event:
        event.clear()


def _is_cancelled(operation):
    event = _FILE_MANAGER_CANCEL_FLAGS.get(operation)
    return event.is_set() if event else False


def _raise_if_cancelled(operation):
    if _is_cancelled(operation):
        raise OperationCancelled("Operation cancelled by user.")

def _run_async(coro):
    result = []
    error = []
    def _thread_target():
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            result.append(loop.run_until_complete(coro))
        except Exception as e:
            error.append(e)
    t = threading.Thread(target=_thread_target)
    t.start()
    while t.is_alive():
        eel.sleep(0.05)
    if error:
        raise error[0]
    return result[0] if result else None


@eel.expose
@standardize_response
def cancel_file_manager_operation(operation):
    event = _FILE_MANAGER_CANCEL_FLAGS.get(str(operation or ""))
    if not event:
        return {"success": False, "error": "Unknown operation."}
    event.set()
    return {"success": True}

@eel.expose
@standardize_response
def get_detected_game_paths():
    paths = []
    try:
        seen_paths = set()

        def _add_path(name, path, is_steam=False, is_glyph=False):
            normalized = str(path or "").strip()
            if not normalized:
                return
            key = normalized.lower()
            if key in seen_paths:
                return
            seen_paths.add(key)
            paths.append({
                "name": name,
                "path": normalized,
                "is_steam": bool(is_steam),
                "is_glyph": bool(is_glyph),
            })

        for game in get_trove_locations():
            _add_path(game.name, str(game.path), game.is_steam, game.is_glyph)
            
        settings = get_settings()
        for custom_dir in settings.get("custom_directories", []):
            name = custom_dir.get("name", "Unknown") if isinstance(custom_dir, dict) else Path(str(custom_dir)).name
            path = custom_dir.get("path", "") if isinstance(custom_dir, dict) else str(custom_dir)

            _add_path(f"(Custom) {name}", path, False, False)

        # Fallback to the saved install if registry auto-detection returns nothing.
        last_game_path = settings.get("last_game_path")
        if isinstance(last_game_path, str) and last_game_path.strip():
            saved_path = Path(last_game_path)
            if saved_path.exists() and (saved_path / "Trove.exe").exists():
                _add_path("(Saved) Last Used", str(saved_path), False, False)
            
        return resp(True, data={"paths": paths}, paths=paths)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return resp(False, error=str(e), code="DETECT_GAME_PATHS_FAILED", data={"paths": []}, paths=[])
    

@eel.expose
@standardize_response
def load_entire_game_tree(game_path_str):
    try:
        _reset_cancel_flag("load_tree")
        tree = _run_async(_build_full_tree_async(game_path_str))
        cache_dir = Path(os.getenv("APPDATA")) / "Trove" / "ModManagerCache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / "temp_tree.json"
        
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(tree, f)

        return {"success": True, "cached_file": "/api/cache/temp_tree.json"}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


async def _build_full_tree_async(game_path_str):
    game_path = Path(game_path_str)
    if not game_path.exists():
        raise FileNotFoundError("Game path does not exist.")

    master_tree = {"type": "folder", "children": {}, "files": []}

    for tfi_path in game_path.rglob("index.tfi"):
        _raise_if_cancelled("load_tree")
        relative_dir = tfi_path.parent.relative_to(game_path)
        base_parts = list(relative_dir.parts)

        index = TFIndex(tfi_path)
        files_from_index = await index.files_list
        
        for file_data in files_from_index:
            _raise_if_cancelled("load_tree")
            internal_path = file_data["name"].replace('\\', '/')
            internal_parts = internal_path.split('/')
            full_parts = base_parts + internal_parts
            
            current_node = master_tree
            
            for part in full_parts[:-1]: 
                if part not in current_node["children"]:
                    current_node["children"][part] = {"type": "folder", "children": {}, "files": []}
                current_node = current_node["children"][part]
                
            file_name = full_parts[-1]
            current_node["files"].append({
                "name": file_name,
                "type": "file",
                "size": file_data["size"],
                "archive_index": file_data["archive_index"],
                "offset": file_data["offset"],
                "hash": file_data["hash"],
                "tfi_parent": str(tfi_path)
            })
            
    def process_node(node):
        node.get("files", []).sort(key=lambda x: x["name"])
        sorted_children = dict(sorted(node.get("children", {}).items()))
        node["children"] = sorted_children
        node["dir_count_direct"] = len(node.get("children", {}))
        node["file_count_direct"] = len(node.get("files", []))
        total_dir_count = node["dir_count_direct"]
        total_file_count = node["file_count_direct"]
        for child_node in node.get("children", {}).values():
            process_node(child_node)
            total_dir_count += child_node.get("dir_count_total", 0)
            total_file_count += child_node.get("file_count_total", 0)
        node["dir_count_total"] = total_dir_count
        node["file_count_total"] = total_file_count
    process_node(master_tree)
    return master_tree

@eel.expose
@standardize_response
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
@standardize_response
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
        _run_async(_extract_and_save_async(tfi_path_str, archive_index, offset, size, save_path_str))
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
@standardize_response
def ask_extraction_directory():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    folder_path = filedialog.askdirectory(title="Select Extraction Destination")
    root.destroy()
    return folder_path

@eel.expose
@standardize_response
def mass_extract_files(dest_dir, files_to_extract):
    try:
        _reset_cancel_flag("mass_extract")
        _run_async(_mass_extract_async(dest_dir, files_to_extract))
        return {"success": True}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
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
        _raise_if_cancelled("mass_extract")
        tfi_path = Path(tfi_path_str)
        index = TFIndex(tfi_path)
        
        for archive_idx, files in archives.items():
            _raise_if_cancelled("mass_extract")
            tfa_name = f"archive{archive_idx}.tfa"
            tfa_path = tfi_path.parent / tfa_name
            
            archive = TFArchive(index, tfa_path)
            
            for f in files:
                _raise_if_cancelled("mass_extract")
                file_obj = TroveFile(offset=f["offset"], size=f["size"], archive=archive)
                file_bytes = await file_obj.content
                
                clean_relative_path = Path(f["filepath"].replace("\\", "/"))
                out_file_path = dest_path / clean_relative_path
                out_file_path.parent.mkdir(parents=True, exist_ok=True)
                
                with open(out_file_path, "wb") as out:
                    out.write(file_bytes)
                
                processed_count += 1
                if processed_count % 50 == 0 or processed_count == total_files:
                    elapsed = time.time() - start_time
                    
                    eta_secs = ""
                    rate = 0
                    if elapsed > 0.5:
                        rate = processed_count / elapsed
                    if rate > 0:
                        eta_secs = int((total_files - processed_count) / rate)
                    eel.update_progress_ui(processed_count, total_files, f["filepath"], "Extracting...", eta_secs, int(elapsed))()
                    eel.sleep(0.001)

@eel.expose
@standardize_response
def select_tracking_directory():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    folder_path = filedialog.askdirectory(title="Select Update Tracking Folder")
    root.destroy()
    return {"success": True, "path": folder_path} if folder_path else {"success": False}

@eel.expose
@standardize_response
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
@standardize_response
def build_baseline_cache(game_path_str, tracking_dir_str):
    try:
        _reset_cancel_flag("build_baseline")
        _run_async(_build_baseline_async(game_path_str, tracking_dir_str))
        return {"success": True}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
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
        _raise_if_cancelled("build_baseline")
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
            _raise_if_cancelled("build_baseline")
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
@standardize_response
def scan_and_extract_updates(game_path_str, tracking_dir_str, run_catalog=False):
    try:
        _reset_cancel_flag("scan_updates")
        result = _run_async(_scan_and_extract_updates_async(game_path_str, tracking_dir_str, run_catalog))
        return {"success": True, "details": result}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
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
        _raise_if_cancelled("scan_updates")
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
            _raise_if_cancelled("scan_updates")
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
                _raise_if_cancelled("scan_updates")
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

                async def _wait_for_active_processes(processes):
                    while True:
                        _raise_if_cancelled("scan_updates")
                        remaining = [p for p in processes if p.poll() is None]
                        if not remaining:
                            return
                        await asyncio.sleep(0.1)

                def _terminate_active_processes(processes):
                    for p in processes:
                        try:
                            if p.poll() is None:
                                p.terminate()
                        except Exception:
                            pass
                
                try:
                    for bp in blueprints_to_catalog:
                        _raise_if_cancelled("scan_updates")
                        cmd = f'"{trove_exe}" -tool catalog -filter "{bp}" -dimension "256"'
                        
                        startupinfo = None
                        if os.name == 'nt':
                            startupinfo = subprocess.STARTUPINFO()
                            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                            
                        proc = subprocess.Popen(cmd, cwd=str(game_path), startupinfo=startupinfo)
                        active_processes.append(proc)
                        
                        if len(active_processes) >= cpu_limit:
                            await _wait_for_active_processes(active_processes)
                            active_processes = []
                    
                    await _wait_for_active_processes(active_processes)
                except OperationCancelled:
                    _terminate_active_processes(active_processes)
                    raise
                
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
@standardize_response
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
@standardize_response
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
@standardize_response
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