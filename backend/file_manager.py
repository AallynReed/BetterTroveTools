import shutil

import eel
from backend.response import resp, standardize_response
import asyncio
from pathlib import Path
import os
import json
from utils.archive_parser import TFIndex, TFArchive, TroveFile, hash_archive_blocking
import concurrent.futures
from utils.registry import get_trove_locations, invalidate_trove_locations_cache
from utils.helper import read_storage, write_storage
from utils.executable import find_trove_executable
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
    """Run an async coroutine on a worker thread so the calling eel handler
    stays cooperative. Polls with a threading.Event so we wake up the instant
    the work is done -- the previous 50 ms eel.sleep cap added 0-50 ms of
    pure idle latency to every short call (single-file extract, cache-hit
    tree loads, etc.). 10 ms keeps the eel server responsive without that
    floor."""
    result = []
    error = []
    done = threading.Event()

    def _thread_target():
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            result.append(loop.run_until_complete(coro))
        except Exception as e:
            error.append(e)
        finally:
            done.set()

    t = threading.Thread(target=_thread_target)
    t.start()
    while not done.is_set():
        eel.sleep(0.01)
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
def get_detected_game_paths(force_refresh=False):
    # `force_refresh=True` is for the explicit "scan again" code paths. Without
    # it we reuse the cached registry/Steam scan -- the second through Nth
    # caller in a session hits an in-memory list instead of re-walking the
    # registry, parsing libraryfolders.vdf, and re-running PE checks per dir.
    if force_refresh:
        invalidate_trove_locations_cache()
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
            if find_trove_executable(saved_path):
                _add_path("(Saved) Last Used", str(saved_path), False, False)
            
        return resp(True, data={"paths": paths}, paths=paths)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return resp(False, error=str(e), code="DETECT_GAME_PATHS_FAILED", data={"paths": []}, paths=[])
    

def _stat_sig(path: Path) -> str:
    """Cheap content-change proxy for a file: modification time + size. A Trove
    patch always rewrites archives (new mtime/size), so this reliably flags real
    changes without reading or decompressing the file. Empty on stat failure so
    it never matches a cached signature (forcing the content-hash path)."""
    try:
        st = path.stat()
    except OSError:
        return ""
    return f"{st.st_mtime_ns}:{st.st_size}"


def _index_signature(game_path: Path) -> str:
    """Cheap fingerprint of every index.tfi (path + mtime + size). Globbing and
    statting is fast; it's the per-index parsing that's slow, so when this is
    unchanged we can skip rebuilding the tree entirely."""
    import hashlib

    parts = []
    for tfi_path in game_path.rglob("index.tfi"):
        try:
            st = tfi_path.stat()
        except OSError:
            continue
        parts.append(f"{tfi_path.relative_to(game_path).as_posix()}|{st.st_mtime_ns}|{st.st_size}")
    parts.sort()
    return hashlib.md5("\n".join(parts).encode("utf-8")).hexdigest()


@eel.expose
@standardize_response
def load_entire_game_tree(game_path_str, force_refresh=False):
    try:
        _reset_cancel_flag("load_tree")
        cache_dir = Path(os.getenv("APPDATA")) / "Trove" / "ModManagerCache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / "temp_tree.json"
        manifest_file = cache_dir / "temp_tree_manifest.json"

        game_path = Path(game_path_str)
        if not game_path.exists():
            raise FileNotFoundError("Game path does not exist.")

        signature = _index_signature(game_path)

        # Reuse the previously built tree when no index.tfi has changed.
        if not force_refresh and cache_file.exists() and manifest_file.exists():
            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            except Exception:
                manifest = {}
            if manifest.get("game_path") == str(game_path) and manifest.get("signature") == signature:
                return {"success": True, "cached_file": "/api/cache/temp_tree.json", "from_cache": True}

        tree = _run_async(_build_full_tree_async(game_path_str))

        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(tree, f)
        manifest_file.write_text(
            json.dumps({"game_path": str(game_path), "signature": signature}),
            encoding="utf-8",
        )

        return {"success": True, "cached_file": "/api/cache/temp_tree.json", "from_cache": False}
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

    # Reading every index.tfi sequentially was a major share of "Load tree"
    # latency: each await yields the event loop but we still hit the disk
    # one index at a time. Pre-list them, then asyncio.gather a bounded
    # batch of reads so the OS can pipeline the I/O. The cap on concurrent
    # readers keeps file handle / memory pressure predictable on very large
    # installs.
    tfi_paths = list(game_path.rglob("index.tfi"))
    _raise_if_cancelled("load_tree")

    sem = asyncio.Semaphore(16)

    async def read_one(tfi_path):
        async with sem:
            _raise_if_cancelled("load_tree")
            index = TFIndex(tfi_path)
            return tfi_path, await index.files_list

    parsed = await asyncio.gather(*(read_one(p) for p in tfi_paths))

    for tfi_path, files_from_index in parsed:
        _raise_if_cancelled("load_tree")
        relative_dir = tfi_path.parent.relative_to(game_path)
        base_parts = list(relative_dir.parts)
        tfi_parent_str = str(tfi_path)

        for file_data in files_from_index:
            internal_path = file_data["name"].replace('\\', '/')
            internal_parts = internal_path.split('/')
            full_parts = base_parts + internal_parts

            current_node = master_tree

            for part in full_parts[:-1]:
                child = current_node["children"].get(part)
                if child is None:
                    child = {"type": "folder", "children": {}, "files": []}
                    current_node["children"][part] = child
                current_node = child

            file_name = full_parts[-1]
            current_node["files"].append({
                "name": file_name,
                "type": "file",
                "size": file_data["size"],
                "archive_index": file_data["archive_index"],
                "offset": file_data["offset"],
                "hash": file_data["hash"],
                "tfi_parent": tfi_parent_str
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
    
    if find_trove_executable(path):
        return {"success": True, "path": str(path)}
    else:
        return {"success": False, "error": "No trove*.exe was found in the selected directory."}


@eel.expose
@standardize_response
def open_path_in_explorer(path_str, select_file=False):
    try:
        raw = str(path_str or "").strip()
        if not raw:
            return {"success": False, "error": "No path was provided."}

        target = Path(raw).expanduser()
        if not target.exists():
            return {"success": False, "error": "The selected path does not exist."}

        if select_file and target.is_file():
            subprocess.Popen(["explorer", "/select,", str(target)])
            return {"success": True}

        open_target = target.parent if target.is_file() else target
        subprocess.Popen(["explorer", str(open_target)])
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}
    
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
        "files": {},
        "stats": {}
    }

    tfi_files = list(game_path.rglob("index.tfi"))

    # ---- Pass 1: parse every index (small files), record stat signatures and
    # the index hashes, and build a FLAT list of archive work items across all
    # indexes. Most Trove directories ship a single archive (archive0.tfa), so
    # parallelizing within one index buys almost nothing -- the real win is
    # decompressing + hashing archives from many different directories at once.
    work_items = []  # (rel_tfa, tfa_path_str, [(file_key, offset, size), ...])
    for tfi_path in tfi_files:
        _raise_if_cancelled("build_baseline")
        rel_tfi = tfi_path.relative_to(game_path).as_posix()
        index = TFIndex(tfi_path)
        archive_list = list(index.archives)

        cache["stats"][rel_tfi] = _stat_sig(tfi_path)
        files = await index.files_list               # reads + parses index.tfi
        cache["archives"][rel_tfi] = await index.content_hash  # cached by files_list, instant

        files_by_archive = defaultdict(list)
        for f in files:
            file_key = f"{rel_tfi}::{f['name'].replace(chr(92), '/')}"
            files_by_archive[f["archive_index"]].append((file_key, f["offset"], f["size"]))

        for archive in archive_list:
            rel_tfa = archive.path.relative_to(game_path).as_posix()
            cache["stats"][rel_tfa] = _stat_sig(archive.path)
            work_items.append((rel_tfa, str(archive.path), files_by_archive.get(archive.id, [])))

    # ---- Pass 2: decompress + hash archives in parallel across CPU cores.
    # zlib.decompress and hashlib.md5 release the GIL on large buffers, so a
    # thread pool gives genuine multi-core speedup here. Concurrency is bounded
    # so we never hold more than `workers` decompressed archives in memory at
    # once (each can be tens-to-hundreds of MB).
    total = len(work_items)
    start_time = time.time()
    workers = max(2, min((os.cpu_count() or 4), 6))
    loop = asyncio.get_running_loop()
    done = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        sem = asyncio.Semaphore(workers)

        async def process(item):
            rel_tfa, tfa_path_str, file_entries = item
            async with sem:
                _raise_if_cancelled("build_baseline")
                result = await loop.run_in_executor(pool, hash_archive_blocking, tfa_path_str, file_entries)
                return rel_tfa, result

        tasks = [asyncio.ensure_future(process(it)) for it in work_items]
        try:
            for coro in asyncio.as_completed(tasks):
                rel_tfa, (archive_hash, file_hashes) = await coro
                cache["archives"][rel_tfa] = archive_hash
                for key, file_hash in file_hashes:
                    cache["files"][key] = file_hash

                done += 1
                elapsed = time.time() - start_time
                eta_secs = ""
                if elapsed > 0.5 and done > 0:
                    rate = done / elapsed
                    eta_secs = int((total - done) / rate)
                eel.update_progress_ui(done, total, rel_tfa, "Building Baseline Cache...", eta_secs, int(elapsed))()
        except BaseException:
            for tk in tasks:
                tk.cancel()
            raise

    data_path = tracking_dir / "extraction_data.json"
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=4)


@eel.expose
@standardize_response
def scan_and_extract_updates(game_path_str, tracking_dir_str, run_catalog=False, full_rescan=False):
    try:
        _reset_cancel_flag("scan_updates")
        result = _run_async(_scan_and_extract_updates_async(game_path_str, tracking_dir_str, run_catalog, full_rescan))
        return {"success": True, "details": result}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

async def _scan_and_extract_updates_async(game_path_str, tracking_dir_str, run_catalog, full_rescan=False):
    game_path = Path(game_path_str)
    tracking_dir = Path(tracking_dir_str)
    data_path = tracking_dir / "extraction_data.json"
    
    with open(data_path, "r", encoding="utf-8") as f:
        old_cache = json.load(f)

    old_stats = old_cache.get("stats", {})

    new_cache = {
        "last_scan_date": datetime.utcnow().isoformat() + "Z",
        "game_path": game_path_str,
        "archives": {},
        "files": {},
        "stats": {}
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
        archive_list = list(index.archives)

        # Cheap fast-gate: if the index and every archive match their cached
        # modification time + size, nothing changed on disk — carry the cached
        # hashes forward and skip reading/decompressing the archives entirely.
        # (A real game patch always changes mtime/size; content hashing below
        # still runs whenever the stat differs, so there are no false positives.)
        tfi_sig = _stat_sig(tfi_path)
        new_cache["stats"][rel_tfi] = tfi_sig
        archive_rels = {}
        stat_unchanged = (not full_rescan) and bool(old_stats) and (old_stats.get(rel_tfi) == tfi_sig)
        for archive in archive_list:
            rel_tfa = archive.path.relative_to(game_path).as_posix()
            archive_rels[id(archive)] = rel_tfa
            sig = _stat_sig(archive.path)
            new_cache["stats"][rel_tfa] = sig
            if old_stats.get(rel_tfa) != sig:
                stat_unchanged = False

        if stat_unchanged:
            if rel_tfi in old_cache.get("archives", {}):
                new_cache["archives"][rel_tfi] = old_cache["archives"][rel_tfi]
            for archive in archive_list:
                rel_tfa = archive_rels[id(archive)]
                if rel_tfa in old_cache.get("archives", {}):
                    new_cache["archives"][rel_tfa] = old_cache["archives"][rel_tfa]
            prefix = f"{rel_tfi}::"
            for k, v in old_cache["files"].items():
                if k.startswith(prefix):
                    new_cache["files"][k] = v
            continue

        # Same parallel-hash pattern as the baseline build: the index + every
        # archive's content_hash can be gathered so the file reads overlap
        # while decompress/hash work fills the CPU pauses between them.
        new_tfi_hash, *new_archive_hashes = await asyncio.gather(
            index.content_hash,
            *(archive.content_hash for archive in archive_list),
        )
        new_cache["archives"][rel_tfi] = new_tfi_hash

        archives_dict = {}
        tfa_changed = False

        for archive, new_tfa_hash in zip(archive_list, new_archive_hashes):
            rel_tfa = archive_rels[id(archive)]
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
                trove_exe = find_trove_executable(game_path) or (game_path / "Trove_x64.exe")
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
