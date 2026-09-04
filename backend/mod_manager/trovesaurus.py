import json
import math
import os
import time
import webbrowser
from pathlib import Path

import gevent
import eel
from utils.http import SESSION

from backend.response import resp
from backend.mod_manager.mod_manager import delete_mod, mods_signature
from models.trove.mod import TroveModList
from utils.path import get_cache_root
from utils.registry import TroveGamePath

HASHES_TO_MODS = "https://trovesaurus.com/api/mods-hashes-to-mods"

# game_path -> {"signature": ..., "states": {mod_id: {...}}}
_local_hash_cache = {}


def _local_hash_to_path(game_path_str):
    """{content hash (lowercase) -> absolute path} for every installed mod.

    Steam Workshop mods are excluded: Trovesaurus doesn't manage them and we
    can't install over them, so hashing them only costs time."""
    trove_path = TroveGamePath(Path(game_path_str))
    mod_list = TroveModList(path=trove_path, partial=True)
    return {
        mod.hash.lower(): str(mod.mod_path)
        for mod in mod_list
        if getattr(mod, "hash", None) and not mod.is_workshop
    }


def _resolve_hashes(hashes, label="Fetching Mod Hashes"):
    """Ask Trovesaurus which mod each local hash belongs to -> {hash: mod id}.

    Returns None if a batch failed, so callers can tell "none of these are
    Trovesaurus mods" apart from "Trovesaurus didn't answer"."""
    resolved = {}
    hashes = list(hashes)
    for i in range(0, len(hashes), 200):
        batch = hashes[i:i + 200]
        req_id = None
        try:
            req_id = eel.add_external_request(label, HASHES_TO_MODS)()
        except Exception:
            pass
        try:
            response = SESSION.post(HASHES_TO_MODS, data={"hashes": ",".join(batch)}, timeout=10)
            if req_id:
                eel.remove_external_request(req_id, response.status_code == 200)()
                req_id = None
            if response.status_code != 200:
                return None
            resolved.update(response.json())
        except Exception as e:
            if req_id:
                eel.remove_external_request(req_id, False)()
                req_id = None
            print(f"Failed hash batch: {e}")
            return None
    return resolved


def _installed_path_for_mod(hash_to_path, mod_id):
    """Which local file (if any) is an install of Trovesaurus mod `mod_id`."""
    target = str(mod_id)
    for local_hash, resolved_id in (_resolve_hashes(hash_to_path, "Resolving Installed Mod") or {}).items():
        if str(resolved_id) == target:
            path = hash_to_path.get(str(local_hash).lower())
            if path:
                return path
    return None


def _latest_mod_file(mod_data):
    """Newest downloadable file of a mod. Config (`extra`) uploads are skipped:
    they get their own file id and would otherwise look like the latest release."""
    files = [
        f for f in (mod_data.get("downloads") or [])
        if not int(f.get("extra", 0) or 0)
    ]
    files.sort(key=lambda f: -int(f.get("fileid", 0)))
    return files[0] if files else None


def _install_target(game_path_str, mod_name, ext, existing_path=None):
    """Where a downloaded file goes. Updating a mod that's already installed
    keeps the file exactly where it is -- same name, same enabled/disabled
    state -- and only swaps the extension when the release changed format. This
    matches what the Mod Manager's own updater does. A first install is named
    after the mod."""
    mods_dir = Path(game_path_str) / "mods"
    if existing_path:
        name = Path(existing_path).name
        disabled = name.endswith(".disabled")
        if disabled:
            name = name[: -len(".disabled")]
        stem = name.rsplit(".", 1)[0] if "." in name else name
        return mods_dir / f"{stem}{ext}{'.disabled' if disabled else ''}"

    safe_name = "".join(
        c for c in str(mod_name) if c.isalpha() or c.isdigit() or c in " _-"
    ).strip()
    return mods_dir / f"{safe_name or 'mod'}{ext}"


def _compute_installed_states(game_path_str, mods_all, force=False):
    """{mod id -> {is_installed, needs_update}} for everything installed locally.

    Cached per mods folder against `mods_signature`; `force` re-checks even when
    nothing changed on disk, which is what the Refresh button needs when a new
    release lands mid-session."""
    if not game_path_str:
        return {}

    signature = mods_signature(game_path_str)
    cached = _local_hash_cache.get(game_path_str)
    if not force and cached and cached.get("signature") == signature:
        return cached["states"]

    states = {}
    try:
        hash_to_path = _local_hash_to_path(game_path_str)
        mods_by_id = {str(m.get("id")): m for m in mods_all if isinstance(m, dict) and "id" in m}

        resolved = _resolve_hashes(hash_to_path)
        if resolved is None:
            # Trovesaurus didn't answer. Report nothing this round rather than
            # caching "nothing is installed" against a signature that only
            # changes when the user touches the mods folder.
            return {}

        for local_hash, mod_id in resolved.items():
            mod_data = mods_by_id.get(str(mod_id))
            if not mod_data:
                continue
            latest = _latest_mod_file(mod_data)
            latest_hash = (latest or {}).get("hash", "")
            needs_update = bool(latest_hash) and latest_hash.lower() != str(local_hash).lower()

            state = states.setdefault(str(mod_id), {"is_installed": True, "needs_update": needs_update})
            # Several local files can map to the same mod (an old copy left
            # behind, a renamed duplicate). If any of them is the current
            # release, the mod is up to date.
            if not needs_update:
                state["needs_update"] = False

        _local_hash_cache[game_path_str] = {"signature": signature, "states": states}
    except Exception as e:
        print(f"Failed to load local mods for hash check: {e}")
    return states


def _get_cached_api(endpoint, cache_filename, expiry=900):
    cache_dir = get_cache_root()
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir.joinpath(cache_filename)

    if cache_file.exists():
        try:
            cached_wrapper = json.loads(cache_file.read_text(encoding="utf-8"))
            if time.time() - cached_wrapper.get("timestamp", 0) < expiry:
                return cached_wrapper.get("data")
        except (json.JSONDecodeError, AttributeError):
            pass

    req_id = None
    try:
        label = f"Fetching {cache_filename.split('.')[0].replace('_', ' ').title()} from Trovesaurus"
        req_id = eel.add_external_request(label, endpoint)()
    except Exception:
        pass

    try:
        headers = {"User-Agent": "TroveManager/1.0"}
        response = SESSION.get(endpoint, headers=headers, timeout=15)
        if req_id:
            eel.remove_external_request(req_id, response.status_code == 200)()
            req_id = None
        if response.status_code == 200:
            data = response.json()
            wrapper = {"timestamp": time.time(), "data": data}
            cache_file.write_text(json.dumps(wrapper), encoding="utf-8")
            return data
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
            req_id = None
        print(f"Failed to fetch {endpoint}: {e}")

    if cache_file.exists():
        try:
            cached_data = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(cached_data, dict) and "data" in cached_data:
                return cached_data.get("data")
            return cached_data
        except json.JSONDecodeError:
            pass
    return []


@eel.expose
def get_trovesaurus_mods(page=1, query="", category="", sort="hot", game_path_str="", request_token=None, force_refresh=False):
    def task():
        try:
            req_id = None
            try:
                req_id = eel.add_external_request("Pinging Trovesaurus", "https://trovesaurus.com/api/ping")()
            except Exception:
                pass
            try:
                test_resp = SESSION.head("https://trovesaurus.com/api/ping", timeout=5)
                if req_id:
                    eel.remove_external_request(req_id, test_resp.status_code < 500)()
                if test_resp.status_code >= 500:
                    eel.receive_trovesaurus_mods({"success": False, "error": "Trovesaurus is currently experiencing server issues.", "request_token": request_token})()
                    return
            except Exception:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                eel.receive_trovesaurus_mods({"success": False, "error": "Trovesaurus didn't respond, it may be down or you might not have an internet connection.", "request_token": request_token})()
                return

            mods_all = _get_cached_api("https://trovesaurus.com/api/mods-all", "mods_all.json")
            mods_hot = _get_cached_api("https://trovesaurus.com/api/mods-hot", "mods_hot.json")

            if not mods_all:
                eel.receive_trovesaurus_mods({"success": False, "error": "Trovesaurus didn't respond, it may be down or you might not have an internet connection.", "request_token": request_token})()
                return

            if isinstance(mods_all, dict):
                mods_all = list(mods_all.values())

            filtered_mods = []
            for mod in mods_all:
                if not isinstance(mod, dict): continue

                if query:
                    q = query.lower()
                    name = str(mod.get("name") or "").lower()
                    mod_id_str = str(mod.get("id") or "")
                    author_data = mod.get("author") or {}
                    author = str(author_data.get("Username") or "").lower() if isinstance(author_data, dict) else ""
                    
                    if q not in name and q not in author and q != mod_id_str:
                        continue

                if category:
                    c = category.lower()
                    m_type = str(mod.get("type") or "").lower()
                    m_subtype = str(mod.get("subtype") or "").lower()
                    if c not in m_type and c not in m_subtype:
                        continue

                filtered_mods.append(mod)

            if sort in ["", "hot"]:
                hot_ranks = {str(m.get("modid")): idx for idx, m in enumerate(mods_hot) if isinstance(m, dict)}
                
                filtered_mods.sort(key=lambda m: (
                    0 if str(m.get("id")) in hot_ranks else 1,
                    hot_ranks.get(str(m.get("id")), 999), 
                    -int(m.get("likes") or 0)
                ))
            elif sort == "date_desc":
                filtered_mods.sort(key=lambda m: -int(m.get("date") or 0))
            elif sort == "date_asc":
                filtered_mods.sort(key=lambda m: int(m.get("date") or 0))
            elif sort == "downloads_desc":
                filtered_mods.sort(key=lambda m: -int(m.get("totaldownloads") or 0))
            elif sort == "likes_desc":
                filtered_mods.sort(key=lambda m: -int(m.get("likes") or 0))

            installed_mod_states = _compute_installed_states(game_path_str, mods_all, force=force_refresh)

            items_per_page = 24
            max_pages = max(1, math.ceil(len(filtered_mods) / items_per_page))
            safe_page = max(1, min(page, max_pages))
            
            start_idx = (safe_page - 1) * items_per_page
            paginated_mods = filtered_mods[start_idx : start_idx + items_per_page]

            result = []
            for m in paginated_mods:
                author_data = m.get("author", {})
                author_name = author_data.get("Username", "Unknown") if isinstance(author_data, dict) else "Unknown"
                author_id = author_data.get("ID", 0) if isinstance(author_data, dict) else 0
                
                mod_id_str = str(m.get("id"))
                is_installed = False
                needs_update = False
                
                if mod_id_str in installed_mod_states:
                    is_installed = installed_mod_states[mod_id_str]["is_installed"]
                    needs_update = installed_mod_states[mod_id_str]["needs_update"]

                result.append({
                    "id": m.get("id"),
                    "name": m.get("name", "Unnamed Mod"),
                    "author": author_name,
                    "author_id": author_id,
                    "downloads": m.get("totaldownloads", 0),
                    "likes": m.get("likes", 0),
                    "image": m.get("image", ""),
                    "is_installed": is_installed,
                    "needs_update": needs_update
                })

            eel.receive_trovesaurus_mods({"success": True, "mods": result, "page": safe_page, "max_pages": max_pages, "request_token": request_token})()
        except Exception as e:
            eel.receive_trovesaurus_mods({"success": False, "error": str(e), "request_token": request_token})()
            
    gevent.spawn(task)


@eel.expose
def install_trovesaurus_mod(game_path_str, mod_id):
    def task():
        try:
            if not game_path_str: 
                eel.receive_install_result({"success": False, "error": "No game path provided.", "mod_id": mod_id})()
                return

            req_id = None
            try:
                req_id = eel.add_external_request("Pinging Trovesaurus", "https://trovesaurus.com/api/ping")()
            except Exception:
                pass
            try:
                test_resp = SESSION.head("https://trovesaurus.com/api/ping", timeout=5)
                if req_id:
                    eel.remove_external_request(req_id, test_resp.status_code < 500)()
                if test_resp.status_code >= 500:
                    eel.receive_install_result({"success": False, "error": "Trovesaurus is currently experiencing server issues.", "mod_id": mod_id})()
                    return
            except Exception:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                eel.receive_install_result({"success": False, "error": "Trovesaurus didn't respond, it may be down or you might not have an internet connection.", "mod_id": mod_id})()
                return

            mods_all = _get_cached_api("https://trovesaurus.com/api/mods-all", "mods_all.json")
            
            if isinstance(mods_all, list):
                mods_all = {str(m.get("id")): m for m in mods_all if isinstance(m, dict)}
            elif not mods_all:
                eel.receive_install_result({"success": False, "error": "Trovesaurus didn't respond, it may be down or you might not have an internet connection.", "mod_id": mod_id})()
                return

            mod_data = mods_all.get(str(mod_id))
            if not mod_data: 
                eel.receive_install_result({"success": False, "error": "Mod no longer exists.", "mod_id": mod_id})()
                return

            latest_file = _latest_mod_file(mod_data)
            if not latest_file:
                eel.receive_install_result({"success": False, "error": "This mod has no files uploaded.", "mod_id": mod_id})()
                return

            file_id = latest_file.get("fileid")
            ext = f".{latest_file.get('format', 'tmod')}"

            # Where this mod already lives, if anywhere. The file on disk is
            # often not named after the Trovesaurus title (auto-fix-names, a
            # manual rename, or a previous release in another format), so we
            # resolve it by content hash and take over that exact path --
            # otherwise an update drops a second copy of the same mod alongside
            # the old one and every conflict/update badge stays stuck.
            existing_path = None
            try:
                existing_path = _installed_path_for_mod(_local_hash_to_path(game_path_str), mod_id)
            except Exception as e:
                print(f"Couldn't resolve the installed copy of mod {mod_id}: {e}")

            url = f"https://trovesaurus.com/client/downloadfile.php?fileid={file_id}"
            
            req_id = None
            try:
                req_id = eel.add_external_request(f"Downloading Mod {mod_id}", url)()
            except Exception:
                pass
            try:
                download = SESSION.get(url, headers={"User-Agent": "TroveLocalModManager/1.0"}, timeout=(10, 300))
                if req_id:
                    eel.remove_external_request(req_id, download.status_code == 200)()
                    req_id = None
                if download.status_code != 200:
                    eel.receive_install_result({"success": False, "error": f"Download failed. Status: {download.status_code}", "mod_id": mod_id})()
                    return

                data = download.content
                out_path = _install_target(game_path_str, mod_data.get("name", "mod"), ext, existing_path)

                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(data)

                if existing_path:
                    previous = Path(existing_path)
                    try:
                        if previous.exists() and previous != out_path:
                            previous.unlink()
                    except OSError as e:
                        print(f"Couldn't remove the previous copy of mod {mod_id}: {e}")

                _local_hash_cache.pop(game_path_str, None)
                eel.receive_install_result({"success": True, "mod_id": mod_id})()
            except Exception as e:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                eel.receive_install_result({"success": False, "error": "Failed to connect to Trovesaurus to download the mod file.", "mod_id": mod_id})()
        except Exception as e:
            eel.receive_install_result({"success": False, "error": str(e), "mod_id": mod_id})()
            
    gevent.spawn(task)


@eel.expose
def delete_trovesaurus_installed_mod(game_path_str, mod_id):
    try:
        if not game_path_str:
            return resp(False, error="No game path provided.", code="MISSING_GAME_PATH")

        hash_to_path = _local_hash_to_path(game_path_str)
        if not hash_to_path:
            return resp(False, error="No installed mods were found.", code="NO_INSTALLED_MODS")

        matched_path = _installed_path_for_mod(hash_to_path, mod_id)
        if not matched_path:
            return resp(False, error="Could not find an installed file for this mod.", code="INSTALLED_FILE_NOT_FOUND")

        return delete_mod(game_path_str, matched_path)
    except Exception as e:
        return resp(False, error=str(e), code="DELETE_TROVESAURUS_MOD_FAILED")

@eel.expose
def open_url_in_browser(url):
    webbrowser.open(url)


@eel.expose
def clear_trovesaurus_cache():
    try:
        cache_dir = get_cache_root()
        removed = []
        # trovesaurus_mods_all.json is the Mod Manager's copy of the same master
        # list; leaving it behind meant Clear Cache didn't affect update checks.
        for filename in ["mods_all.json", "mods_hot.json", "trovesaurus_mods_all.json"]:
            file_path = cache_dir / filename
            if file_path.exists():
                file_path.unlink()
                removed.append(filename)

        _local_hash_cache.clear()
        return resp(True, data={"removed": removed}, removed=removed)
    except Exception as e:
        return resp(False, error=str(e), code="CACHE_CLEAR_FAILED")
