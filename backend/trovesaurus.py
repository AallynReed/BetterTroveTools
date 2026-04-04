import json
import math
import os
import time
import webbrowser
from pathlib import Path

import gevent
import eel
import requests

from models.trove.mod import TroveModList
from utils.registry import TroveGamePath

_local_hash_cache = {}

def _get_cached_api(endpoint, cache_filename, expiry=900):
    appdata = Path(os.getenv("APPDATA"))
    cache_dir = appdata.joinpath("Trove", "ModManagerCache")
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
        response = requests.get(endpoint, headers=headers, timeout=15)
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
def get_trovesaurus_mods(page=1, query="", category="", sort="hot", game_path_str=""):
    def task():
        try:
            req_id = None
            try:
                req_id = eel.add_external_request("Pinging Trovesaurus", "https://trovesaurus.com/api/ping")()
            except Exception:
                pass
            try:
                test_resp = requests.head("https://trovesaurus.com/api/ping", timeout=5)
                if req_id:
                    eel.remove_external_request(req_id, test_resp.status_code < 500)()
                if test_resp.status_code >= 500:
                    eel.receive_trovesaurus_mods({"success": False, "error": "Trovesaurus is currently experiencing server issues."})
                    return
            except Exception:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                eel.receive_trovesaurus_mods({"success": False, "error": "Trovesaurus didn't respond, it may be down or you might not have an internet connection."})
                return

            mods_all = _get_cached_api("https://trovesaurus.com/api/mods-all", "mods_all.json")
            mods_hot = _get_cached_api("https://trovesaurus.com/api/mods-hot", "mods_hot.json")

            if not mods_all:
                eel.receive_trovesaurus_mods({"success": False, "error": "Trovesaurus didn't respond, it may be down or you might not have an internet connection."})
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

            installed_mod_states = {}
            if game_path_str:
                mods_dir = Path(game_path_str) / "mods"
                try:
                    current_mtime = mods_dir.stat().st_mtime if mods_dir.exists() else 0
                except:
                    current_mtime = 0

                global _local_hash_cache
                if game_path_str in _local_hash_cache and _local_hash_cache[game_path_str].get("mtime") == current_mtime:
                    installed_mod_states = _local_hash_cache[game_path_str]["states"]
                else:
                    try:
                        trove_path = TroveGamePath(Path(game_path_str))
                        mod_list = TroveModList(path=trove_path, partial=True)
                        local_hashes = mod_list.all_hashes
                        
                        if local_hashes:
                            hash_to_id = {}
                            hash_batches = [local_hashes[i:i + 200] for i in range(0, len(local_hashes), 200)]
                            
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
                                    if resp.status_code == 200:
                                        batch_results = resp.json()
                                        hash_to_id.update(batch_results)
                                except Exception as e:
                                    if req_id:
                                        eel.remove_external_request(req_id, False)()
                                    print(f"Failed hash batch: {e}")
                                    
                            mods_all_dict = {str(m.get("id")): m for m in mods_all if isinstance(m, dict) and "id" in m}
                            
                            for local_hash, mod_id in hash_to_id.items():
                                mod_id_str = str(mod_id)
                                m = mods_all_dict.get(mod_id_str)
                                if m:
                                    downloads = m.get("downloads", [])
                                    valid_downloads = [d for d in downloads if not int(d.get("extra", 0))]
                                    valid_downloads.sort(key=lambda x: -int(x.get("fileid", 0)))
                                    
                                    needs_update = False
                                    if valid_downloads:
                                        latest_hash = valid_downloads[0].get("hash", "")
                                        if latest_hash:
                                            needs_update = (latest_hash.lower() != local_hash.lower())
                                    
                                    if mod_id_str not in installed_mod_states:
                                        installed_mod_states[mod_id_str] = {"is_installed": True, "needs_update": needs_update}
                                    else:
                                        if not needs_update:
                                            installed_mod_states[mod_id_str]["needs_update"] = False

                        _local_hash_cache[game_path_str] = {
                            "mtime": current_mtime,
                            "states": installed_mod_states
                        }
                    except Exception as e:
                        print(f"Failed to load local mods for hash check: {e}")

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

            eel.receive_trovesaurus_mods({"success": True, "mods": result, "page": safe_page, "max_pages": max_pages})
        except Exception as e:
            eel.receive_trovesaurus_mods({"success": False, "error": str(e)})
            
    gevent.spawn(task)


@eel.expose
def install_trovesaurus_mod(game_path_str, mod_id):
    def task():
        try:
            if not game_path_str: 
                eel.receive_install_result({"success": False, "error": "No game path provided.", "mod_id": mod_id})
                return

            req_id = None
            try:
                req_id = eel.add_external_request("Pinging Trovesaurus", "https://trovesaurus.com/api/ping")()
            except Exception:
                pass
            try:
                test_resp = requests.head("https://trovesaurus.com/api/ping", timeout=5)
                if req_id:
                    eel.remove_external_request(req_id, test_resp.status_code < 500)()
                if test_resp.status_code >= 500:
                    eel.receive_install_result({"success": False, "error": "Trovesaurus is currently experiencing server issues.", "mod_id": mod_id})
                    return
            except Exception:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                eel.receive_install_result({"success": False, "error": "Trovesaurus didn't respond, it may be down or you might not have an internet connection.", "mod_id": mod_id})
                return

            mods_all = _get_cached_api("https://trovesaurus.com/api/mods-all", "mods_all.json")
            
            if isinstance(mods_all, list):
                mods_all = {str(m.get("id")): m for m in mods_all if isinstance(m, dict)}
            elif not mods_all:
                eel.receive_install_result({"success": False, "error": "Trovesaurus didn't respond, it may be down or you might not have an internet connection.", "mod_id": mod_id})
                return

            mod_data = mods_all.get(str(mod_id))
            if not mod_data: 
                eel.receive_install_result({"success": False, "error": "Mod no longer exists.", "mod_id": mod_id})
                return

            downloads = mod_data.get("downloads", [])
            if not downloads: 
                eel.receive_install_result({"success": False, "error": "This mod has no files uploaded.", "mod_id": mod_id})
                return

            downloads.sort(key=lambda f: -int(f.get("fileid", 0)))
            latest_file = downloads[0]
            
            file_id = latest_file.get("fileid")
            ext = f".{latest_file.get('format', 'tmod')}"
            
            url = f"https://trovesaurus.com/client/downloadfile.php?fileid={file_id}"
            
            req_id = None
            try:
                req_id = eel.add_external_request(f"Downloading Mod {mod_id}", url)()
            except Exception:
                pass
            try:
                resp = requests.get(url, headers={"User-Agent": "TroveLocalModManager/1.0"})
                if req_id:
                    eel.remove_external_request(req_id, resp.status_code == 200)()
                    req_id = None
                if resp.status_code != 200:
                    eel.receive_install_result({"success": False, "error": f"Download failed. Status: {resp.status_code}", "mod_id": mod_id})
                    return
                
                data = resp.content

                safe_name = "".join([c for c in mod_data.get("name", "mod") if c.isalpha() or c.isdigit() or c in " _-"]).strip()
                
                out_path = Path(game_path_str) / "mods" / f"{safe_name}{ext}"
                
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(data)
                
                eel.receive_install_result({"success": True, "mod_id": mod_id})
            except Exception as e:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                eel.receive_install_result({"success": False, "error": "Failed to connect to Trovesaurus to download the mod file.", "mod_id": mod_id})
        except Exception as e:
            eel.receive_install_result({"success": False, "error": str(e), "mod_id": mod_id})
            
    gevent.spawn(task)

@eel.expose
def open_url_in_browser(url):
    webbrowser.open(url)