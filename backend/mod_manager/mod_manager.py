import json
import os
import shutil
import time
import uuid
from pathlib import Path

import eel
import requests

from backend.response import resp
from models.trove.mod import TroveGamePath, TroveModList
from utils.functions import BasePath
from utils.path import get_cache_root
from utils.trove_cfg import ensure_mods_enabled




def _cache_root():
    root = get_cache_root()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _trash_manifest_path():
    trash_dir = _cache_root() / "trash"
    trash_dir.mkdir(parents=True, exist_ok=True)
    return trash_dir / "deletions.json"


def _read_trash_manifest():
    manifest_path = _trash_manifest_path()
    if not manifest_path.exists():
        return {}
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_trash_manifest(manifest):
    manifest_path = _trash_manifest_path()
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


@eel.expose
def get_installed_mods(game_path_str, fix_names=False, fix_configs=False):
    try:
        # The game can flip [Mods] DisableAllMods on; undo it before listing.
        ensure_mods_enabled()

        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(
            path=trove_path,
            partial=True,
            fix_names=fix_names,
            fix_configs=fix_configs,
        )

        result_mods = []
        for mod in mod_list:
            result_mods.append(
                {
                    "name": mod.name or "Unknown Mod",
                    "author": mod.author or "Unknown Author",
                    "status": "enabled" if mod.enabled else "disabled",
                    "path": str(mod.mod_path),
                    "image": mod.image,
                    "has_conflicts": mod.has_conflicts,
                    "conflicts_with": [
                        {"name": c.name, "enabled": c.enabled} for c in mod.conflicts
                    ],
                }
            )

        cache_dir = _cache_root()
        cache_file = cache_dir / "installed_mods.json"

        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump({"mods": result_mods}, f)

        return resp(
            True,
            data={
                "cached_file": "/api/cache/installed_mods.json",
                "read_only_configs": mod_list.read_only_configs,
            },
            cached_file="/api/cache/installed_mods.json",
            read_only_configs=mod_list.read_only_configs,
        )

    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="INSTALLED_MODS_FAILED")


@eel.expose
def toggle_mod(game_path_str, mod_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)

        for mod in mod_list:
            if str(mod.mod_path) == mod_path_str:
                mod.toggle()
                return resp(
                    True, data={"new_path": str(mod.mod_path)}, new_path=str(mod.mod_path)
                )

        return resp(False, error="Could not locate the mod in the parsed list.", code="MOD_NOT_FOUND")

    except FileExistsError:
        return resp(False, error="A file with the toggled name already exists.", code="TOGGLE_COLLISION")
    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="TOGGLE_FAILED")


@eel.expose
def delete_mod(game_path_str, mod_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mods_dir = trove_path.path.joinpath("mods").resolve()
        mod_path = Path(mod_path_str).resolve()

        if not str(mod_path).lower().startswith(str(mods_dir).lower()):
            return resp(False, error="Refusing to delete file outside mods directory.", code="INVALID_PATH")

        if not mod_path.exists():
            return resp(False, error="Mod file does not exist.", code="MISSING_FILE")

        if not mod_path.is_file():
            return resp(False, error="Target path is not a file.", code="NOT_A_FILE")

        trash_dir = _cache_root() / "trash"
        trash_dir.mkdir(parents=True, exist_ok=True)
        deletion_token = uuid.uuid4().hex
        trash_name = f"{int(time.time())}_{deletion_token}_{mod_path.name}"
        trash_path = trash_dir / trash_name

        shutil.move(str(mod_path), str(trash_path))

        manifest = _read_trash_manifest()
        manifest[deletion_token] = {
            "original_path": str(mod_path),
            "trash_path": str(trash_path),
        }
        _write_trash_manifest(manifest)

        return resp(
            True,
            data={
                "undo_token": deletion_token,
                "original_path": str(mod_path),
                "trash_path": str(trash_path),
            },
            undo_token=deletion_token,
            original_path=str(mod_path),
            trash_path=str(trash_path),
        )

    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="DELETE_FAILED")


@eel.expose
def undo_delete_mod(undo_token):
    try:
        manifest = _read_trash_manifest()
        info = manifest.get(str(undo_token))
        if not info:
            return resp(False, error="Undo token not found or expired.", code="UNDO_TOKEN_NOT_FOUND")

        original_path = Path(info["original_path"])
        trash_path = Path(info["trash_path"])

        if not trash_path.exists():
            manifest.pop(str(undo_token), None)
            _write_trash_manifest(manifest)
            return resp(False, error="Deleted file can no longer be restored.", code="UNDO_SOURCE_MISSING")

        original_path.parent.mkdir(parents=True, exist_ok=True)
        if original_path.exists():
            return resp(False, error="Cannot restore because a file already exists at the original path.", code="UNDO_CONFLICT")

        shutil.move(str(trash_path), str(original_path))
        manifest.pop(str(undo_token), None)
        _write_trash_manifest(manifest)

        return resp(True, data={"restored_path": str(original_path)}, restored_path=str(original_path))
    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="UNDO_FAILED")


@eel.expose
def clear_mod_manager_cache():
    try:
        cache_dir = _cache_root()
        removed = []

        for filename in ["installed_mods.json"]:
            path = cache_dir / filename
            if path.exists():
                path.unlink()
                removed.append(filename)

        return resp(True, data={"removed": removed}, removed=removed)
    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="CACHE_CLEAR_FAILED")


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

        return resp(True, data={"fixed_count": fixed_count}, fixed_count=fixed_count)

    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="FIX_NAMES_FAILED")


@eel.expose
def get_mod_urls(game_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)

        hash_to_path = {
            getattr(mod, "hash").lower(): str(mod.mod_path)
            for mod in mod_list
            if getattr(mod, "hash", None)
        }
        if not hash_to_path:
            return resp(True, data={"urls": {}}, urls={})

        urls = {}
        hashes_list = list(hash_to_path.keys())
        hash_batches = [hashes_list[i : i + 200] for i in range(0, len(hashes_list), 200)]

        for batch in hash_batches:
            payload = {"hashes": ",".join(batch)}
            req_id = None
            try:
                req_id = eel.add_external_request(
                    "Fetching Mod Hashes", "https://trovesaurus.com/api/mods-hashes-to-mods"
                )()
            except Exception:
                pass
            try:
                resp = requests.post(
                    "https://trovesaurus.com/api/mods-hashes-to-mods", data=payload, timeout=10
                )
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

        return resp(True, data={"urls": urls}, urls=urls)

    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="MOD_URLS_FAILED")


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

        return resp(True, data={"updates": updates_available}, updates=updates_available)

    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="CHECK_UPDATES_FAILED")


@eel.expose
def perform_mod_update(game_path_str, mod_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        mod_list.update_trovesaurus_data()

        for mod in mod_list:
            if str(mod.mod_path) == mod_path_str:
                success = mod.update()
                return resp(
                    bool(success),
                    data={"updated": bool(success)},
                    updated=bool(success),
                    code="OK" if success else "UPDATE_REJECTED",
                )

        return resp(False, error="Mod not found in the list.", code="MOD_NOT_FOUND")

    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="UPDATE_FAILED")
