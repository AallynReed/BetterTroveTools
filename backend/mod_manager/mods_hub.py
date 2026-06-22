"""Mods Hub tab — browse + install mods delivered through the Kiwi API
(api.aallyn.net/v1/mods), the project's own Mods Hub at trove.aallyn.net/mods.

Mirrors backend.mod_manager.trovesaurus, but talks to the Kiwi mod catalog
instead of Trovesaurus:
  * listing/search is server-paginated (`GET /v1/mods`),
  * installed/update state is resolved by sha256 content hash
    (`POST /v1/mods/lookup`) — the local .tmod/.zip bytes BTT writes on install
    are the exact published artifact, so their sha256 round-trips,
  * installs download a release's `download_url` straight to the mods folder.
"""

import hashlib
import json
import math
import time
from pathlib import Path

import eel
import gevent
import requests

from backend.home import KIWI_API_BASE
from backend.mod_manager.mod_manager import delete_mod
from utils.path import get_cache_root
from utils.registry import TroveGamePath

USER_AGENT = "BetterTroveTools/1.0"
ITEMS_PER_PAGE = 24
VALID_SORTS = {"popular", "downloads", "stars", "recent", "new", "title"}
MOD_PAGE_BASE = "https://trove.aallyn.net/mods"
DETAIL_TTL = 300  # seconds — short-cache /mods/<handle>/<slug> detail (carries releases[])

# game_path -> {"mtime": float, "states": {ref: {...}}, "paths": {ref: str}}  (ref = "<handle>/<slug>")
_install_state_cache = {}
# ref -> (fetched_at, detail). The /mods/<handle>/<slug> detail is the only endpoint
# that carries releases[] (the list cards and /lookup omit them), so update-checking
# and the variant picker both lean on it — cache it so a list render that resolves
# several installed mods doesn't refetch each one per page.
_detail_cache = {}


def _resp(success, data=None, error=None, code=None, meta=None, **legacy):
    payload = {
        "success": success,
        "code": code or ("OK" if success else "ERROR"),
        "data": data if data is not None else {},
        "error": error,
        "meta": meta or {},
    }
    payload.update(legacy)
    return payload


def _headers():
    return {"User-Agent": USER_AGENT, "Accept": "application/json"}


def _get_cached_api(endpoint, cache_filename, expiry=3600):
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
        label = f"Fetching {cache_filename.split('.')[0].replace('_', ' ').title()}"
        req_id = eel.add_external_request(label, endpoint)()
    except Exception:
        pass

    try:
        response = requests.get(endpoint, headers=_headers(), timeout=15)
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
        print(f"Failed to fetch {endpoint}: {e}")

    if cache_file.exists():
        try:
            cached_data = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(cached_data, dict) and "data" in cached_data:
                return cached_data.get("data")
            return cached_data
        except json.JSONDecodeError:
            pass
    return None


def _pub(release):
    # published_at is an ISO-8601 string (UTC, fixed format) — lexicographic order
    # is chronological. Default to "" (oldest) so a missing value never forces a
    # str-vs-int comparison against an int default.
    return release.get("published_at") or ""


def _to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _mod_ref(handle, slug):
    """Canonical hub identifier. Slugs are unique PER OWNER (not globally), so a
    mod is addressed by `<handle>/<slug>` — both the detail endpoint
    (GET /v1/mods/<handle>/<slug>) and our internal dict keys use this. Falls back
    to the bare slug if no handle is known (older data)."""
    handle = (str(handle or "").strip().strip("/"))
    slug = (str(slug or "").strip().strip("/"))
    return f"{handle}/{slug}" if handle else slug


def _latest_release(releases, branch=None):
    """Newest release (by published_at). Scoped to `branch` when given so an
    update on the variant the user actually installed wins over an unrelated
    branch's newer build."""
    candidates = [r for r in releases if isinstance(r, dict) and r.get("branch") == branch] if branch else []
    if not candidates:
        candidates = [r for r in releases if isinstance(r, dict)]
    if not candidates:
        return None
    candidates.sort(key=_pub, reverse=True)
    return candidates[0]


def _branch_variants(releases):
    """One entry per branch (= variant): the latest release of each, newest first.
    A mod with a single branch yields a single variant."""
    by_branch = {}
    for r in releases:
        if not isinstance(r, dict):
            continue
        branch = r.get("branch") or "main"
        current = by_branch.get(branch)
        if current is None or _pub(r) > _pub(current):
            by_branch[branch] = r
    return sorted(by_branch.values(), key=_pub, reverse=True)


def _release_outdated(matched, releases):
    """True when a newer release exists ON THE SAME BRANCH the user installed.
    A newer release on a different variant does NOT count as an update."""
    if not matched or not releases:
        return False
    latest = _latest_release(releases, matched.get("branch"))
    if not latest:
        return False
    matched_hash = (matched.get("sha256") or "").lower()
    latest_hash = (latest.get("sha256") or "").lower()
    return bool(matched_hash) and bool(latest_hash) and matched_hash != latest_hash


def _release_extension(release):
    filename = (release.get("filename") or "").lower()
    if filename.endswith(".zip") or filename.endswith(".zip.disabled"):
        return ".zip"
    if filename.endswith(".tmod"):
        return ".tmod"
    fmt = (release.get("format") or "").lower().lstrip(".")
    return ".zip" if fmt == "zip" else ".tmod"


def _safe_filename(name):
    safe = "".join(c for c in str(name) if c.isalpha() or c.isdigit() or c in " _-").strip()
    return safe or "mod"


def _lookup_hashes(hashes):
    """POST a batch of <=200 sha256s to /v1/mods/lookup -> {hash: {mod, release}}."""
    if not hashes:
        return {}
    req_id = None
    try:
        req_id = eel.add_external_request("Identifying Installed Mods", f"{KIWI_API_BASE}/mods/lookup")()
    except Exception:
        pass
    try:
        resp = requests.post(
            f"{KIWI_API_BASE}/mods/lookup",
            json={"hashes": list(hashes)},
            headers=_headers(),
            timeout=15,
        )
        if req_id:
            eel.remove_external_request(req_id, resp.status_code == 200)()
            req_id = None
        if resp.status_code == 200:
            return (resp.json() or {}).get("results", {}) or {}
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Mods Hub lookup failed: {e}")
    return {}


def _compute_install_states(game_path_str):
    """Resolve which of the locally installed mods come from the hub (and whether
    each is outdated). Returns (states_by_ref, path_by_ref), keyed by the mod's
    `<handle>/<slug>` ref. Cached per mods dir by mtime so repeated page loads
    don't re-hash every file."""
    if not game_path_str:
        return {}, {}

    mods_dir = Path(game_path_str) / "mods"
    try:
        mtime = mods_dir.stat().st_mtime if mods_dir.exists() else 0
    except OSError:
        mtime = 0

    cached = _install_state_cache.get(game_path_str)
    if cached and cached.get("mtime") == mtime:
        return cached["states"], cached["paths"]

    try:
        trove_path = TroveGamePath(Path(game_path_str))
        files = (
            list(trove_path.enabled_tmods)
            + list(trove_path.disabled_tmods)
            + list(trove_path.enabled_zips)
            + list(trove_path.disabled_zips)
        )
    except Exception as e:
        print(f"Failed to enumerate local mods for hub lookup: {e}")
        files = []

    hash_to_path = {}
    for f in files:
        try:
            digest = hashlib.sha256(Path(f).read_bytes()).hexdigest()
        except OSError:
            continue
        hash_to_path.setdefault(digest, str(f))

    # Resolve every local hash -> {ref, installed release}. The /lookup `mod`
    # object does NOT carry releases[], so we keep the matched release here and
    # fetch the mod detail once per ref below to decide "outdated on this branch".
    ref_match = {}  # ref -> {"path", "matched", "name", "page_url", "handle", "slug"}
    if hash_to_path:
        all_hashes = list(hash_to_path.keys())
        for i in range(0, len(all_hashes), 200):
            batch = all_hashes[i:i + 200]
            for h, entry in _lookup_hashes(batch).items():
                mod = (entry or {}).get("mod") or {}
                matched = (entry or {}).get("release") or {}
                slug = mod.get("slug")
                handle = mod.get("handle")
                if not slug:
                    continue
                ref = _mod_ref(handle, slug)
                if ref in ref_match:
                    continue
                ref_match[ref] = {
                    "path": hash_to_path.get(h),
                    "matched": matched,
                    "name": mod.get("title"),
                    "page_url": mod.get("page_url") or f"{MOD_PAGE_BASE}/{ref}",
                    "handle": handle,
                    "slug": slug,
                }

    states = {}
    paths = {}
    for ref, info in ref_match.items():
        matched = info["matched"]
        detail = _fetch_mod_detail(ref)
        releases = (detail or {}).get("releases") or []
        states[ref] = {
            "is_installed": True,
            # Update check is scoped to the installed variant's branch.
            "needs_update": _release_outdated(matched, releases),
            "branch": matched.get("branch"),
            "name": info.get("name"),
            "page_url": info.get("page_url"),
            "handle": info.get("handle"),
            "slug": info.get("slug"),
        }
        paths[ref] = info["path"]

    _install_state_cache[game_path_str] = {"mtime": mtime, "states": states, "paths": paths}
    return states, paths


def _fetch_mod_detail(ref, use_cache=True):
    """Fetch a mod's full detail (incl. releases[]) by its `<handle>/<slug>` ref."""
    if use_cache:
        hit = _detail_cache.get(ref)
        if hit and time.time() - hit[0] < DETAIL_TTL:
            return hit[1]
    url = f"{KIWI_API_BASE}/mods/{ref}"
    req_id = None
    try:
        req_id = eel.add_external_request(f"Fetching Mod {ref}", url)()
    except Exception:
        pass
    try:
        resp = requests.get(url, headers=_headers(), timeout=15)
        if req_id:
            eel.remove_external_request(req_id, resp.status_code == 200)()
            req_id = None
        if resp.status_code == 200:
            detail = resp.json() or {}
            _detail_cache[ref] = (time.time(), detail)
            return detail
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Mods Hub detail fetch failed: {e}")
    return None


@eel.expose
def get_mods_hub_mods(page=1, query="", tag="", sort="popular", game_path_str="", request_token=None):
    def task():
        try:
            page_num = max(1, int(page or 1))
            sort_value = sort if sort in VALID_SORTS else "popular"
            params = {
                "limit": ITEMS_PER_PAGE,
                "offset": (page_num - 1) * ITEMS_PER_PAGE,
                "sort": sort_value,
            }
            if query:
                params["q"] = query
            if tag:
                params["tag"] = tag

            req_id = None
            try:
                req_id = eel.add_external_request("Browsing the Mods Hub", f"{KIWI_API_BASE}/mods")()
            except Exception:
                pass
            try:
                resp = requests.get(f"{KIWI_API_BASE}/mods", params=params, headers=_headers(), timeout=15)
                if req_id:
                    eel.remove_external_request(req_id, resp.status_code == 200)()
                    req_id = None
            except Exception:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                eel.receive_mods_hub_mods({
                    "success": False,
                    "error": "Couldn't reach the Mods Hub. It may be down or you might be offline.",
                    "request_token": request_token,
                })()
                return

            if resp.status_code != 200:
                eel.receive_mods_hub_mods({
                    "success": False,
                    "error": f"The mod hub returned HTTP {resp.status_code}.",
                    "request_token": request_token,
                })()
                return

            payload = resp.json() or {}
            items = payload.get("items") or []
            total = int(payload.get("total") or len(items))
            max_pages = max(1, math.ceil(total / ITEMS_PER_PAGE))

            states, _ = _compute_install_states(game_path_str)

            result = []
            for m in items:
                if not isinstance(m, dict):
                    continue
                slug = m.get("slug")
                handle = m.get("handle")
                ref = _mod_ref(handle, slug)
                state = states.get(ref, {})
                preview = m.get("banner_url") or (m.get("preview_urls") or [None])[0] or ""
                result.append({
                    "slug": slug,
                    "handle": handle,
                    "ref": ref,
                    "name": m.get("title") or "Unnamed Mod",
                    "author": m.get("author") or "Unknown",
                    "summary": m.get("summary") or "",
                    "downloads": m.get("download_count") or 0,
                    "stars": m.get("star_count") or 0,
                    "image": preview,
                    "page_url": m.get("page_url") or f"{MOD_PAGE_BASE}/{ref}",
                    "tags": m.get("categories") or m.get("tags") or [],
                    "is_installed": bool(state.get("is_installed")),
                    "needs_update": bool(state.get("needs_update")),
                    "installed_branch": state.get("branch"),
                })

            eel.receive_mods_hub_mods({
                "success": True,
                "mods": result,
                "page": min(page_num, max_pages),
                "max_pages": max_pages,
                "total": total,
                "request_token": request_token,
            })()
        except Exception as e:
            eel.receive_mods_hub_mods({"success": False, "error": str(e), "request_token": request_token})()

    gevent.spawn(task)


def _do_install(game_path_str, ref, branch=None):
    """Core install: download a release and write it into the mods folder. `ref`
    is the mod's `<handle>/<slug>`. Returns (success, error, installed_branch).
    Shared by the Mods Hub tab (callback flavour) and the Mod Manager tab (sync)."""
    if not game_path_str:
        return False, "No game path provided.", None

    detail = _fetch_mod_detail(ref)
    if detail is None:
        return False, "Couldn't reach the mod hub to fetch this mod.", None

    release = _latest_release(detail.get("releases") or [], branch)
    if not release or not release.get("download_url"):
        return False, "This mod has no downloadable releases yet.", None

    url = release["download_url"]
    req_id = None
    try:
        req_id = eel.add_external_request(f"Downloading Mod {detail.get('title') or ref}", url)()
    except Exception:
        pass
    try:
        dl = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=(10, 300))
        if req_id:
            eel.remove_external_request(req_id, dl.status_code == 200)()
            req_id = None
    except Exception:
        if req_id:
            eel.remove_external_request(req_id, False)()
        return False, "Failed to download the mod file from the hub.", None

    if dl.status_code != 200:
        return False, f"Download failed. Status: {dl.status_code}", None

    data = dl.content
    ext = _release_extension(release)
    safe_name = _safe_filename(detail.get("title") or release.get("filename") or "mod")
    mods_dir = Path(game_path_str) / "mods"
    mods_dir.mkdir(parents=True, exist_ok=True)
    out_path = mods_dir / f"{safe_name}{ext}"

    # On update / variant switch the previous artifact may live under a different
    # filename (renamed, or a different format/variant) — clear it so we don't
    # leave a stale duplicate of the same mod behind.
    _, paths = _compute_install_states(game_path_str)
    old_path_str = paths.get(ref)

    out_path.write_bytes(data)

    if old_path_str:
        old_path = Path(old_path_str)
        try:
            if old_path.exists() and old_path.resolve() != out_path.resolve():
                old_path.unlink()
        except OSError:
            pass

    _install_state_cache.pop(game_path_str, None)
    return True, None, release.get("branch")


@eel.expose
def install_mods_hub_mod(game_path_str, ref, branch=None):
    """Install (or update) a mod, replying via the receive_mods_hub_install_result
    callback (used by the Mods Hub tab). `ref` is `<handle>/<slug>`. With `branch`
    set, installs the latest release of that variant; without it, newest overall."""
    def task():
        try:
            ok, error, installed_branch = _do_install(game_path_str, ref, branch)
            if ok:
                eel.receive_mods_hub_install_result({"success": True, "ref": ref, "branch": installed_branch})()
            else:
                eel.receive_mods_hub_install_result({"success": False, "error": error, "ref": ref})()
        except Exception as e:
            eel.receive_mods_hub_install_result({"success": False, "error": str(e), "ref": ref})()

    gevent.spawn(task)


@eel.expose
def install_mods_hub_mod_sync(game_path_str, ref, branch=None):
    """Install (or update/switch-variant) a mod and return the result directly.
    Used by the Mod Manager tab, which has no Mods-Hub callback wired up."""
    try:
        ok, error, installed_branch = _do_install(game_path_str, ref, branch)
        return _resp(ok, data={"branch": installed_branch}, branch=installed_branch,
                     error=error, code="OK" if ok else "INSTALL_FAILED")
    except Exception as e:
        return _resp(False, error=str(e), code="INSTALL_FAILED")


@eel.expose
def get_mods_hub_variants(ref):
    """List a mod's variants (one per branch, latest release of each) so the UI
    can let the user pick which to install. `ref` is `<handle>/<slug>`. A
    single-variant mod returns one entry."""
    detail = _fetch_mod_detail(ref, use_cache=False)
    if detail is None:
        return _resp(False, error="Couldn't reach the Mods Hub to load this mod's variants.", code="MODS_HUB_VARIANTS_FAILED")

    variants = []
    for r in _branch_variants(detail.get("releases") or []):
        variants.append({
            "branch": r.get("branch") or "main",
            "tag": r.get("tag"),
            "title": r.get("title") or r.get("tag") or (r.get("branch") or "main"),
            "format": (r.get("format") or "").lstrip("."),
            "size": _to_int(r.get("size")),
            "published_at": r.get("published_at"),
            "changelog": r.get("changelog") or "",
            "download_count": _to_int(r.get("download_count")),
        })

    title = detail.get("title") or ref
    return _resp(True, data={"ref": ref, "title": title, "variants": variants},
                 ref=ref, title=title, variants=variants)


@eel.expose
def get_mods_hub_install_states(game_path_str):
    """For the Mod Manager (My Mods) tab: which installed mods come from the Mods
    Hub, keyed by file path -> {ref, slug, handle, branch, name, page_url,
    has_update}. Lets the Mod Manager treat hub mods authoritatively (variant-
    scoped updates, variant switching) and skip the Trovesaurus lookup for them."""
    try:
        states, paths = _compute_install_states(game_path_str)
        by_path = {}
        for ref, st in states.items():
            path = paths.get(ref)
            if not path:
                continue
            by_path[path] = {
                "ref": ref,
                "slug": st.get("slug"),
                "handle": st.get("handle"),
                "branch": st.get("branch"),
                "name": st.get("name"),
                "page_url": st.get("page_url"),
                "has_update": bool(st.get("needs_update")),
            }
        return _resp(True, data={"states": by_path}, states=by_path)
    except Exception as e:
        return _resp(False, error=str(e), code="MODS_HUB_STATES_FAILED")


@eel.expose
def delete_mods_hub_installed_mod(game_path_str, ref):
    try:
        if not game_path_str:
            return _resp(False, error="No game path provided.", code="MISSING_GAME_PATH")

        _, paths = _compute_install_states(game_path_str)
        path = paths.get(ref)
        if not path:
            # Cache may predate a manual change — rescan once before giving up.
            _install_state_cache.pop(game_path_str, None)
            _, paths = _compute_install_states(game_path_str)
            path = paths.get(ref)
        if not path:
            return _resp(False, error="Could not find an installed file for this mod.", code="INSTALLED_FILE_NOT_FOUND")

        result = delete_mod(game_path_str, path)
        _install_state_cache.pop(game_path_str, None)
        return result
    except Exception as e:
        return _resp(False, error=str(e), code="DELETE_MODS_HUB_MOD_FAILED")


@eel.expose
def get_mods_hub_categories():
    data = _get_cached_api(f"{KIWI_API_BASE}/mods/categories", "mods_hub_categories.json", expiry=3600)
    categories = data.get("categories") if isinstance(data, dict) else []
    categories = categories or []
    return _resp(True, data={"categories": categories}, categories=categories)


@eel.expose
def clear_mods_hub_cache():
    try:
        cache_dir = get_cache_root()
        removed = []
        cache_file = cache_dir / "mods_hub_categories.json"
        if cache_file.exists():
            cache_file.unlink()
            removed.append(cache_file.name)
        _install_state_cache.clear()
        _detail_cache.clear()
        return _resp(True, data={"removed": removed}, removed=removed)
    except Exception as e:
        return _resp(False, error=str(e), code="CACHE_CLEAR_FAILED")
