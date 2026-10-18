"""Steam tab of the Mod Manager: Trove's Steam Workshop, to subscribe to.

The list comes from the Kiwi API (/v1/btt/workshop), which mirrors the Workshop with
the blocklist already applied, so browsing needs no Steam. Subscribing does: it goes
through the Steam copy of Trove's steam_api64.dll, and Steam then downloads the item
into the Workshop folder, where My Mods picks it up."""

import time
from pathlib import Path

import eel

from backend.home import KIWI_API_BASE
from backend.response import resp
from utils.http import SESSION
from utils.registry import TroveGamePath

CATALOG_URL = f"{KIWI_API_BASE}/btt/workshop"
FRESH_SECONDS = 600

_cache = {"at": 0.0, "data": None}


def _fetch():
    req_id = None
    try:
        req_id = eel.add_external_request("Fetching Steam Workshop", CATALOG_URL)()
    except Exception:
        pass
    try:
        response = SESSION.get(CATALOG_URL, headers={"Accept": "application/json"}, timeout=20)
        if req_id:
            eel.remove_external_request(req_id, response.status_code == 200)()
            req_id = None
        if response.status_code == 200:
            data = response.json()
            if isinstance(data, dict) and isinstance(data.get("items"), list):
                return data
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Failed to fetch the Steam Workshop list: {e}")
    return None


def _installed(game_path_str):
    workshop = TroveGamePath(Path(game_path_str)).workshop_path if game_path_str else None
    if not workshop:
        return set()
    try:
        return {p.name for p in workshop.iterdir() if p.is_dir()}
    except OSError:
        return set()


@eel.expose
def get_steam_workshop_catalog(game_path_str, force=False):
    """The Workshop list with each item marked `installed` when its folder is in this
    install's Workshop folder. A failed fetch serves the last good list."""
    if force or _cache["data"] is None or time.time() - _cache["at"] > FRESH_SECONDS:
        data = _fetch()
        if data is not None:
            _cache.update(at=time.time(), data=data)
    data = _cache["data"]
    if data is None:
        return resp(False, error="The Steam Workshop list could not be loaded.", code="CATALOG_UNAVAILABLE")
    installed = _installed(game_path_str)
    items = [dict(i, installed=str(i.get("published_file_id")) in installed) for i in data["items"]]
    return resp(True, data={"items": items, "fetched_at": data.get("fetched_at")})


@eel.expose
def subscribe_workshop_item(item_id):
    from backend.modder_tools.steam_workshop import SteamError, subscribe_item

    item_id = str(item_id or "").strip()
    if not item_id.isdigit():
        return resp(False, error="Not a Steam Workshop item id.", code="INVALID_ID")
    try:
        if not subscribe_item(item_id):
            return resp(False, error="Steam did not subscribe this account to the item.", code="SUBSCRIBE_REFUSED")
    except SteamError as e:
        return resp(False, error=str(e), code="STEAM_UNAVAILABLE")
    except Exception as e:
        return resp(False, error=str(e), code="SUBSCRIBE_FAILED")
    return resp(True, data={"item_id": item_id})
