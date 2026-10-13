"""Trovesaurus mods the Kiwi API says to hide, by mod id, author id or file hash.

The list comes from /v1/btt/mod-blocklist; the filtering happens here. No answer
within 2 seconds means nothing is hidden."""

import eel

from backend.home import KIWI_API_BASE
from utils.http import SESSION

BLOCKLIST_URL = f"{KIWI_API_BASE}/btt/mod-blocklist"


def _fetch():
    req_id = None
    try:
        req_id = eel.add_external_request("Fetching Mod Blocklist", BLOCKLIST_URL)()
    except Exception:
        pass
    try:
        response = SESSION.get(BLOCKLIST_URL, headers={"Accept": "application/json"}, timeout=2)
        if req_id:
            eel.remove_external_request(req_id, response.status_code == 200)()
            req_id = None
        if response.status_code == 200:
            return response.json()
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Failed to fetch the mod blocklist: {e}")
    return {}


def load():
    """A predicate over raw /api/mods-all entries: True when the mod is hidden."""
    data = _fetch()
    if not isinstance(data, dict):
        data = {}
    authors = {str(a) for a in data.get("authors") or ()}
    mods = {str(m) for m in data.get("mods") or ()}
    hashes = {str(h).lower() for h in data.get("hashes") or ()}

    def blocked(mod):
        mod_id = str(mod.get("id") or "")
        author = mod.get("author")
        author_id = str(author.get("ID") or "") if isinstance(author, dict) else ""
        file_hashes = {
            str(f.get("hash") or "").lower()
            for f in mod.get("downloads") or () if isinstance(f, dict)
        }
        file_hashes.discard("")
        return bool((mod_id and mod_id in mods)
                    or (author_id and author_id in authors)
                    or not file_hashes.isdisjoint(hashes))

    return blocked
