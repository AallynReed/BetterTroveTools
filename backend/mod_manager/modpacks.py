"""Modpacks tab — browse + install curated bundles of hub mods.

A modpack downloads as a **`.tpack`**: the same container format as a `.tmod`
(see models.trove.mod), except its inner "files" are each a complete `.tmod`
named `<internal title>.tmod` (case preserved — Trove validates the filename
against the mod's header title). Installing a modpack = decompile the `.tpack`
into those individual `.tmod`s and drop them into the game's `mods/` folder.

We do NOT track modpacks as installed (unlike the Mods Hub) — installing just
places the mods. Before writing, any locally-installed mod whose name collides
with one of the modpack's mods is quarantined into `mods/disabled/` so the
modpack's version wins without leaving a duplicate behind.
"""

import math
import shutil
import time
import zlib
from pathlib import Path
from urllib.parse import quote

import eel
import gevent
import requests
from binary_reader import BinaryReader

try:
    import tkinter as tk
    from tkinter import filedialog
except ImportError:  # headless / no Tk (e.g. some Linux/web hosts)
    tk = None
    filedialog = None

from backend.home import KIWI_API_BASE
from models.trove.mod import TMod, TroveModFile, TroveModList
from utils.functions import chunks, read_leb128, write_leb128
from utils.registry import TroveGamePath

USER_AGENT = "BetterTroveTools/1.0"
ITEMS_PER_PAGE = 24
VALID_SORTS = {"recent", "downloads", "new", "title"}
MODPACK_PAGE_BASE = "https://trove.aallyn.net/modpacks"


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


def _ref(handle, slug):
    handle = str(handle or "").strip().strip("/")
    slug = str(slug or "").strip().strip("/")
    return f"{handle}/{slug}" if handle else slug


def _to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


# --- .tpack decompile ------------------------------------------------------

def _tpack_file_names(data):
    """Read the inner file names from a .tpack header WITH CASE PRESERVED.
    (TroveModFile lowercases its trove_path, which would break Trove's
    case-sensitive filename-vs-title validation, so we read the raw header.)"""
    br = BinaryReader(bytearray(data))
    header_size = br.read_uint64()
    br.read_uint16()  # version
    properties_count = br.read_uint16()
    for _ in range(properties_count):
        ns = read_leb128(br, br.pos()); br.read_str(ns)
        vs = read_leb128(br, br.pos()); br.read_str(vs)
    names = []
    while br.pos() < header_size:
        ns = br.read_uint8()
        names.append(br.read_str(ns))
        read_leb128(br, br.pos())  # index
        read_leb128(br, br.pos())  # offset
        read_leb128(br, br.pos())  # size
        read_leb128(br, br.pos())  # checksum
    return names


def _decompile_tpack(data):
    """Decompile a .tpack into its inner mods. Returns [(filename, tmod_bytes)],
    each a complete `.tmod` with its case-preserved `<title>.tmod` filename."""
    data = bytes(data)
    # TMod.read_bytes handles the (chunked) zlib body + per-file content extraction;
    # we pair its content with the case-preserved names read from the same header.
    mod = TMod.read_bytes(Path("modpack.tpack"), data, partial=False)
    names = _tpack_file_names(data)
    files = mod.files
    if len(names) == len(files):
        return [(names[i], bytes(files[i].data)) for i in range(len(files))]
    # Order mismatch shouldn't happen, but fall back to the (lowercased) trove paths.
    return [(f.trove_path, bytes(f.data)) for f in files]


def _decompile_tpack_meta(data):
    """Like `_decompile_tpack` but also returns the outer container's version and
    properties, so a rebuilt `.tpack` can preserve them. Returns
    (version, [(prop_name, prop_value)], [(filename, tmod_bytes)])."""
    data = bytes(data)
    mod = TMod.read_bytes(Path("modpack.tpack"), data, partial=False)
    names = _tpack_file_names(data)
    files = mod.files
    if len(names) == len(files):
        entries = [(names[i], bytes(files[i].data)) for i in range(len(files))]
    else:
        entries = [(f.trove_path, bytes(f.data)) for f in files]
    props = [(p.name, p.value) for p in mod.properties]
    return mod.version, props, entries


def _rebuild_tpack(version, outer_props, entries):
    """Recompile a `.tpack` container from `entries` ([(filename, tmod_bytes)]).

    A dedicated writer mirroring `TMod.compile_tmod` byte-for-byte, but WITHOUT
    its three modpack-hostile behaviours: it never injects `modLoader=BTT` into
    the container, never lowercases the inner filenames (Trove validates each
    `<Title>.tmod` name against the mod's header title), and preserves the source
    `version` + outer properties. The result round-trips through `_decompile_tpack`.
    """
    files = []
    offset = 0
    for filename, content in entries:
        f = TroveModFile(Path(filename), content)
        f.trove_path = str(filename)  # restore case (TroveModFile.__init__ lowercases)
        f.index = 0
        f.offset = offset
        files.append(f)
        offset += len(f.padded_data)

    header_stream = BinaryReader(bytearray())
    properties_stream = BinaryReader(bytearray())
    files_list_stream = BinaryReader(bytearray())

    for name, value in outer_props:
        properties_stream.write_bytes(write_leb128(len(name)))
        properties_stream.write_str(name)
        properties_stream.write_bytes(write_leb128(len(value)))
        properties_stream.write_str(value)

    body = BinaryReader(bytearray())
    for f in files:
        body.extend(bytearray(f.padded_data))
    compressor = zlib.compressobj(level=0, strategy=0, wbits=zlib.MAX_WBITS)
    compressed = BinaryReader(bytearray())
    for chunk in chunks(body.buffer(), 32768):
        compressed.extend(bytearray(compressor.compress(chunk)))
    compressed.extend(bytearray(compressor.flush(zlib.Z_SYNC_FLUSH)))

    for f in files:
        files_list_stream.extend(bytearray(f.header_format))

    header_stream.write_uint64(0)
    header_stream.write_uint16(version)
    header_stream.write_uint16(len(outer_props))
    header_stream.extend(properties_stream.buffer())
    header_stream.extend(files_list_stream.buffer())
    header_stream.seek(0)
    header_stream.write_uint64(len(header_stream.buffer()))

    out = BinaryReader(bytearray())
    out.extend(header_stream.buffer() + compressed.buffer())
    return out.buffer()


def _name_from_filename(filename):
    """The internal mod title a `.tmod` filename encodes (drop the extension)."""
    name = Path(str(filename)).name
    low = name.lower()
    for ext in (".tmod.disabled", ".zip.disabled", ".tmod", ".zip"):
        if low.endswith(ext):
            return name[: -len(ext)]
    return name


def _safe_pack_filename(filename):
    """Strip any directory components (anti path-traversal) but keep the exact
    case/spaces — Trove matches the filename against the mod's header title."""
    base = Path(str(filename)).name.strip()
    return base or "mod.tmod"


def _unique_path(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem, suffix = dest.stem, dest.suffix
    i = 1
    while True:
        candidate = dest.with_name(f"{stem}_{i}{suffix}")
        if not candidate.exists():
            return candidate
        i += 1


def _quarantine_conflicts(game_path_str, names_lower):
    """Move any locally installed mod whose NAME matches one of `names_lower`
    into `mods/disabled/`. Returns the list of moved mod names."""
    moved = []
    try:
        trove_path = TroveGamePath(Path(game_path_str))
        mod_list = TroveModList(path=trove_path, partial=True)
    except Exception as e:
        print(f"Modpack conflict scan failed: {e}")
        return moved

    disabled_dir = trove_path.mods_path / "disabled"
    for mod in mod_list:
        name = (mod.name or "").strip()
        if not name or name.lower() not in names_lower:
            continue
        try:
            disabled_dir.mkdir(parents=True, exist_ok=True)
            dest = _unique_path(disabled_dir / mod.mod_path.name)
            shutil.move(str(mod.mod_path), str(dest))
            moved.append(name)
        except OSError as e:
            print(f"Failed to quarantine conflicting mod {name}: {e}")
    return moved


def _fetch_modpack_detail(handle, slug):
    ref = _ref(handle, slug)
    url = f"{KIWI_API_BASE}/modpacks/{ref}"
    req_id = None
    try:
        req_id = eel.add_external_request(f"Fetching Modpack {ref}", url)()
    except Exception:
        pass
    try:
        resp = requests.get(url, headers=_headers(), timeout=15)
        if req_id:
            eel.remove_external_request(req_id, resp.status_code == 200)()
            req_id = None
        if resp.status_code == 200:
            return resp.json() or {}
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Modpack detail fetch failed: {e}")
    return None


# --- eel surface -----------------------------------------------------------

@eel.expose
def get_modpacks(page=1, query="", sort="recent", request_token=None):
    def task():
        try:
            page_num = max(1, int(page or 1))
            sort_value = sort if sort in VALID_SORTS else "recent"
            params = {
                "limit": ITEMS_PER_PAGE,
                "offset": (page_num - 1) * ITEMS_PER_PAGE,
                "sort": sort_value,
            }
            if query:
                params["q"] = query

            req_id = None
            try:
                req_id = eel.add_external_request("Browsing Modpacks", f"{KIWI_API_BASE}/modpacks")()
            except Exception:
                pass
            try:
                resp = requests.get(f"{KIWI_API_BASE}/modpacks", params=params, headers=_headers(), timeout=15)
                if req_id:
                    eel.remove_external_request(req_id, resp.status_code == 200)()
                    req_id = None
            except Exception:
                if req_id:
                    eel.remove_external_request(req_id, False)()
                eel.receive_modpacks({
                    "success": False,
                    "error": "Couldn't reach the Modpacks hub. It may be down or you might be offline.",
                    "request_token": request_token,
                })()
                return

            if resp.status_code != 200:
                eel.receive_modpacks({
                    "success": False,
                    "error": f"The modpacks hub returned HTTP {resp.status_code}.",
                    "request_token": request_token,
                })()
                return

            payload = resp.json() or {}
            items = payload.get("items") or []
            total = int(payload.get("total") or len(items))
            max_pages = max(1, math.ceil(total / ITEMS_PER_PAGE))

            result = []
            for m in items:
                if not isinstance(m, dict):
                    continue
                slug = m.get("slug")
                handle = m.get("handle")
                ref = _ref(handle, slug)
                preview = m.get("banner_url") or (m.get("preview_urls") or [None])[0] or ""
                result.append({
                    "slug": slug,
                    "handle": handle,
                    "ref": ref,
                    "name": m.get("title") or "Unnamed Modpack",
                    "author": m.get("author") or "Unknown",
                    "summary": m.get("summary") or "",
                    "downloads": _to_int(m.get("download_count")),
                    "stars": _to_int(m.get("star_count")),
                    "mod_count": _to_int(m.get("mod_count")),
                    "variant_count": _to_int(m.get("variant_count")),
                    "default_variant": m.get("default_variant"),
                    "image": preview,
                    "page_url": m.get("page_url") or f"{MODPACK_PAGE_BASE}/{ref}",
                    "tags": m.get("tags") or [],
                })

            eel.receive_modpacks({
                "success": True,
                "modpacks": result,
                "page": min(page_num, max_pages),
                "max_pages": max_pages,
                "total": total,
                "request_token": request_token,
            })()
        except Exception as e:
            eel.receive_modpacks({"success": False, "error": str(e), "request_token": request_token})()

    gevent.spawn(task)


@eel.expose
def get_modpack_variants(handle, slug):
    """List a modpack's variants so the UI can let the user pick which to install.
    A single-variant pack returns one entry."""
    detail = _fetch_modpack_detail(handle, slug)
    if detail is None:
        return _resp(False, error="Couldn't reach the Modpacks hub to load this pack's variants.", code="MODPACK_VARIANTS_FAILED")

    variants = []
    for v in (detail.get("variants") or []):
        if not isinstance(v, dict):
            continue
        variants.append({
            "name": v.get("name"),
            "label": v.get("label") or v.get("name") or "Default",
            "mod_count": _to_int(v.get("mod_count")),
            "available_count": _to_int(v.get("available_count")),
            "mods": [
                {"title": mm.get("title"), "available": bool(mm.get("available", True))}
                for mm in (v.get("mods") or []) if isinstance(mm, dict)
            ],
        })

    title = detail.get("title") or _ref(handle, slug)
    return _resp(True, data={"title": title, "default_variant": detail.get("default_variant"), "variants": variants},
                 title=title, default_variant=detail.get("default_variant"), variants=variants)


def _install_tpack_bytes(game_path_str, data):
    """Decompile raw `.tpack` bytes, quarantine same-name local mods into
    `mods/disabled/`, then write the modpack's `.tmod`s. Returns
    (ok, error, result_dict). Shared by the hub download and the manual import."""
    if not game_path_str:
        return False, "No game path provided.", None

    try:
        entries = _decompile_tpack(data)
    except Exception as e:
        return False, f"Couldn't read the modpack file: {e}", None

    if not entries:
        return False, "The modpack contained no mods.", None

    # Names the modpack will install (matched case-insensitively against locals).
    installing_names = {_name_from_filename(fn).strip().lower() for fn, _ in entries}
    quarantined = _quarantine_conflicts(game_path_str, installing_names)

    mods_dir = Path(game_path_str) / "mods"
    mods_dir.mkdir(parents=True, exist_ok=True)
    installed = []
    for filename, content in entries:
        out_path = mods_dir / _safe_pack_filename(filename)
        out_path.write_bytes(content)
        installed.append(out_path.name)

    return True, None, {"installed": len(installed), "files": installed, "quarantined": quarantined}


def _download_tpack(handle, slug, variant=None):
    """Download a modpack's raw `.tpack` bytes from the hub. Returns
    (data, error) — exactly one is non-None. Shared by `install_modpack` (install
    in place) and the profiles feature (save the bytes for later re-use)."""
    ref = _ref(handle, slug)
    url = f"{KIWI_API_BASE}/modpacks/{ref}/download?format=tpack"
    if variant:
        url += f"&variant={quote(str(variant))}"

    req_id = None
    try:
        req_id = eel.add_external_request(f"Downloading Modpack {ref}", url)()
    except Exception:
        pass
    try:
        dl = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=(10, 600))
        if req_id:
            eel.remove_external_request(req_id, dl.status_code == 200)()
            req_id = None
    except Exception:
        if req_id:
            eel.remove_external_request(req_id, False)()
        return None, "Failed to download the modpack from the hub."

    if dl.status_code != 200:
        return None, f"Download failed. Status: {dl.status_code}"
    return dl.content, None


@eel.expose
def install_modpack(game_path_str, handle, slug, variant=None):
    """Download a modpack's `.tpack`, decompile it into the individual `.tmod`s,
    quarantine same-name local mods into `mods/disabled/`, then install. Returns
    a count of installed mods + the names quarantined."""
    try:
        if not game_path_str:
            return _resp(False, error="No game path provided.", code="MISSING_GAME_PATH")

        data, error = _download_tpack(handle, slug, variant)
        if error:
            return _resp(False, error=error, code="MODPACK_DOWNLOAD_FAILED")

        ok, error, result = _install_tpack_bytes(game_path_str, data)
        if not ok:
            return _resp(False, error=error, code="MODPACK_INSTALL_FAILED")
        return _resp(True, data=result, **result)
    except Exception as e:
        return _resp(False, error=str(e), code="MODPACK_INSTALL_FAILED")


@eel.expose
def import_tpack_file(game_path_str):
    """Pick a local `.tpack` via a native file dialog and install it the same way
    a downloaded modpack installs (decompile + quarantine conflicts + write).
    Returns the install result, or `cancelled` if the user closed the dialog."""
    try:
        if not game_path_str:
            return _resp(False, error="No game path provided.", code="MISSING_GAME_PATH")
        if filedialog is None:
            return _resp(False, error="A file dialog isn't available on this platform.", code="NO_FILE_DIALOG")

        root = tk.Tk()
        root.attributes("-topmost", True)
        root.withdraw()
        file_path = filedialog.askopenfilename(
            title="Select a .tpack modpack file",
            initialdir=str(Path(game_path_str) / "mods") if game_path_str else None,
            filetypes=[("Trove Modpacks", "*.tpack"), ("All Files", "*.*")],
        )
        root.destroy()

        if not file_path:
            return _resp(True, data={"cancelled": True}, cancelled=True)

        data = Path(file_path).read_bytes()
        ok, error, result = _install_tpack_bytes(game_path_str, data)
        if not ok:
            return _resp(False, error=error, code="TPACK_IMPORT_FAILED")

        payload = dict(result)
        payload["cancelled"] = False
        payload["source"] = Path(file_path).name
        return _resp(True, data=payload, **payload)
    except Exception as e:
        return _resp(False, error=str(e), code="TPACK_IMPORT_FAILED")
