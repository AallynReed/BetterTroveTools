import json
import os
import shutil
import time
import uuid
from pathlib import Path

import eel

from backend.feature_flags import MODS_HUB_ENABLED
from backend.response import resp
from models.trove.mod import TroveGamePath, TroveModList
from utils.functions import BasePath
from utils.http import SESSION
from utils.path import get_app_data_dir, get_cache_root
from utils.trove_cfg import ensure_mods_enabled




def _cache_root():
    root = get_cache_root()
    root.mkdir(parents=True, exist_ok=True)
    return root


def mods_signature(game_path_str):
    """Cheap fingerprint of a mods folder: path, size and mtime of every file in
    it, plus the Steam Workshop folder when the install has one. Callers cache
    installed/outdated state against this.

    The folder's own mtime is deliberately NOT used: updating a mod overwrites
    its file in place, which leaves the directory timestamp untouched on
    Windows, so an mtime-keyed cache would keep serving "update available" for a
    mod that was just updated."""
    trove_path = TroveGamePath(Path(game_path_str))
    sources = [(trove_path.mods_path, False)]
    workshop = trove_path.workshop_path
    if workshop:
        sources.append((workshop, True))

    entries = []
    for directory, recursive in sources:
        try:
            tree = directory.rglob("*") if recursive else directory.iterdir()
            for entry in tree:
                if entry.is_file():
                    stat = entry.stat()
                    entries.append((str(entry), stat.st_size, stat.st_mtime_ns))
        except OSError:
            continue
    return tuple(sorted(entries))


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


# --- Update locks ----------------------------------------------------------
# A locked mod is pinned: nothing offers or installs an update for it until the
# user unlocks it. Kept in app data, not the cache, so "Clear Cache" never drops
# the user's pins.


def _locks_path():
    return get_app_data_dir() / "mod_locks.json"


def _lock_key(mod_path):
    """Stable per-mod key. Toggling a mod renames it in place (`.tmod` <->
    `.tmod.disabled`), so the key is the file name with that suffix stripped
    rather than the full path."""
    name = Path(mod_path).name
    if name.lower().endswith(".disabled"):
        name = name[: -len(".disabled")]
    return name.lower()


def _install_key(game_path_str):
    return str(Path(game_path_str)).lower()


def _read_locks():
    try:
        data = json.loads(_locks_path().read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_locks(data):
    path = _locks_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _locked_keys(game_path_str):
    entry = _read_locks().get(_install_key(game_path_str))
    return {str(k).lower() for k in entry} if isinstance(entry, list) else set()


@eel.expose
def set_mod_update_lock(game_path_str, mod_path_str, locked):
    try:
        data = _read_locks()
        install = _install_key(game_path_str)
        keys = _locked_keys(game_path_str)
        if locked:
            keys.add(_lock_key(mod_path_str))
        else:
            keys.discard(_lock_key(mod_path_str))

        if keys:
            data[install] = sorted(keys)
        else:
            data.pop(install, None)
        _write_locks(data)

        return resp(True, data={"locked": bool(locked)}, locked=bool(locked))
    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="LOCK_FAILED")


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

        locked_keys = _locked_keys(game_path_str)

        result_mods = []
        for mod in mod_list:
            result_mods.append(
                {
                    "name": mod.name or "Unknown Mod",
                    "author": mod.author or "Unknown Author",
                    "version": mod.mod_version,
                    "status": "enabled" if mod.enabled else "disabled",
                    "path": str(mod.mod_path),
                    "workshop": mod.is_workshop,
                    "locked": _lock_key(mod.mod_path) in locked_keys,
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

        if trove_path.is_workshop_file(mod_path):
            return resp(False, error="Steam Workshop mods are removed by unsubscribing in Steam.", code="WORKSHOP_MOD")

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

        for filename in ["installed_mods.json", "trovesaurus_mods_all.json"]:
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
            if mod.has_wrong_name and not mod.is_workshop:
                mod.fix_name()
                fixed_count += 1

        return resp(True, data={"fixed_count": fixed_count}, fixed_count=fixed_count)

    except Exception as e:
        import traceback

        traceback.print_exc()
        return resp(False, error=str(e), code="FIX_NAMES_FAILED")


def _hub_claimed(game_path_str):
    """Installed paths the Mods Hub already owns, or an empty set when the hub is
    off. Imported lazily on purpose: with the flag off `main.py` never loads the
    module at all."""
    if not MODS_HUB_ENABLED:
        return set()
    try:
        from backend.mod_manager import mods_hub
        return mods_hub.hub_claimed_paths(game_path_str)
    except Exception:
        return set()


@eel.expose
def get_mod_urls(game_path_str):
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)

        # Hub mods are resolved by the hub and their rows are discarded on the
        # other side, so leave them out of the batch entirely.
        claimed = _hub_claimed(game_path_str)
        hash_to_path = {
            getattr(mod, "hash").lower(): str(mod.mod_path)
            for mod in mod_list
            if getattr(mod, "hash", None) and not mod.is_workshop
            and str(mod.mod_path) not in claimed
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
                response = SESSION.post(
                    "https://trovesaurus.com/api/mods-hashes-to-mods", data=payload, timeout=10
                )
                if req_id:
                    eel.remove_external_request(req_id, response.status_code == 200)()
                    req_id = None
                if response.status_code == 200:
                    batch_results = response.json()
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
def check_mod_updates(game_path_str, force=False):
    """`force` skips the 15-minute master-list cache, so the Refresh button
    actually sees releases published since the last check."""
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
        mod_list.update_trovesaurus_data(force, skip_paths=_hub_claimed(game_path_str))

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
        # The lock is a user pin, so it is enforced here too and not only in the
        # UI -- a stale card must not be able to push an update through.
        if _lock_key(mod_path_str) in _locked_keys(game_path_str):
            return resp(False, error="Updates are locked for this mod.", code="MOD_LOCKED")

        trove_path = TroveGamePath(Path(game_path_str))
        if trove_path.is_workshop_file(mod_path_str):
            return resp(False, error="Steam Workshop mods are updated by Steam, not here.", code="WORKSHOP_MOD")

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


def auto_update_unlocked_mods(game_path_str):
    """Update every mod that has a pending update, skipping the ones the user
    locked. Used by the launch-time auto-update; returns (updated, failed) as
    lists of mod names.

    Mods Hub mods update at the variant level (same branch, latest release) and
    are excluded from the Trovesaurus pass below, mirroring what the Mod Manager
    does when the user clicks Update All."""
    locked = _locked_keys(game_path_str)
    updated, failed = [], []
    hub_paths = set()

    if MODS_HUB_ENABLED:
        from backend.mod_manager import mods_hub

        try:
            states = mods_hub.get_mods_hub_install_states(game_path_str, True)
            states = (states.get("data") or {}).get("states") or {}
        except Exception:
            states = {}
        for path, state in states.items():
            hub_paths.add(path)
            if not state.get("has_update") or _lock_key(path) in locked:
                continue
            name = state.get("name") or Path(path).stem
            try:
                result = mods_hub.install_mods_hub_mod_sync(
                    game_path_str, state.get("ref"), state.get("branch")
                )
                ok = bool(result and result.get("success"))
            except Exception:
                ok = False
            (updated if ok else failed).append(name)

    trove_path = TroveGamePath(Path(game_path_str))
    mod_list = TroveModList(path=trove_path, partial=True)
    mod_list.update_trovesaurus_data(True, skip_paths=hub_paths)
    for mod in mod_list:
        path = str(mod.mod_path)
        if path in hub_paths or not mod.has_update or _lock_key(path) in locked:
            continue
        name = mod.name or Path(path).stem
        try:
            ok = bool(mod.update())
        except Exception:
            ok = False
        (updated if ok else failed).append(name)

    return updated, failed
