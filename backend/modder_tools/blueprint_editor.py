"""Local endpoints for the Blueprint Editor, ported from KiwiAPI's ``/site/blueprint-editor/*``.

Plain HTTP rather than eel calls because the page is KiwiAPI's: it posts ``FormData`` with the
files attached and reads the answers (and their ``X-Kiwi-*`` headers) as blobs. Every route is
the KiwiAPI one with ``/site`` swapped for ``/api``; heavy work runs on gevent's thread pool so
the eel websocket keeps breathing while a model is decoded.
"""
from __future__ import annotations

import base64
import json
import re
import tkinter as tk
from pathlib import Path
from tkinter import filedialog
from urllib.parse import quote

import bottle
import eel
import gevent

from backend.response import standardize_response
from utils.kiwi_blueprint import assembly, game_data
from utils.kiwi_blueprint import editor as bp_editor
from utils.kiwi_blueprint import model as bp_model

# Models, layer stacks and whole .tmods ride in one multipart body.
bottle.BaseRequest.MEMFILE_MAX = 256 * 1024 * 1024

_INDEX_WAIT_SECONDS = 600


class _Refused(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def _route(path: str, method: str = "GET"):
    """A bottle route whose ``_Refused``/``EditorError`` becomes KiwiAPI's ``{"detail"}`` body."""
    def wrap(fn):
        def handler(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except _Refused as exc:
                return _json({"detail": exc.detail}, exc.status)
            except bp_editor.EditorError as exc:
                return _json({"detail": str(exc)}, 400)
        return bottle.route(path, method=method)(handler)
    return wrap


def _off_thread(fn, *args, **kwargs):
    return gevent.get_hub().threadpool.apply(fn, args, kwargs)


def _json(payload, status: int = 200) -> bottle.HTTPResponse:
    return bottle.HTTPResponse(json.dumps(payload), status,
                               {"Content-Type": "application/json", "Cache-Control": "no-store"})


def _binary(content: bytes, media: str = "application/octet-stream", **headers) -> bottle.HTTPResponse:
    return bottle.HTTPResponse(content, 200, {"Content-Type": media, "Cache-Control": "no-store",
                                             **headers})


def _attachment(name: str) -> str:
    fallback = re.sub(r"[^\x20-\x7e]", "_", name).replace('"', "") or "download"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name)}"


def _upload(field: str):
    part = bottle.request.files.get(field)
    return part if part is not None and part.raw_filename else None


def _uploads(field: str) -> list:
    return [p for p in bottle.request.files.getall(field) if p.raw_filename]


def _read(part) -> bytes:
    part.file.seek(0)
    return part.file.read()


def _name(part, default: str) -> str:
    return (part.raw_filename or default).replace("\\", "/").rsplit("/", 1)[-1]


def _form(field: str, default: str) -> str:
    return bottle.request.forms.getunicode(field, default=default) or default


def _form_json(field: str, default: str, what: str = "The edit list wasn't understood."):
    try:
        return json.loads(_form(field, default))
    except ValueError:
        raise _Refused(400, what) from None


def _base() -> tuple[bytes, str]:
    part = _upload("file")
    data = _read(part) if part else b""
    if not data:
        raise _Refused(400, "That file is empty.")
    return data, _name(part, "blueprint")


def _stack() -> tuple[list[bytes], list]:
    data = [_read(p) for p in _uploads("layers")]
    if not data:
        return [], []
    specs = _form_json("stack", "[]", "The layer list wasn't understood.")
    if not isinstance(specs, list):
        raise _Refused(400, "The layer list wasn't understood.")
    return data, specs


def _anchor() -> int:
    try:
        return int(_form("anchor_at", "0"))
    except ValueError:
        return 0


# --- the game install -------------------------------------------------------- #


def _game_path() -> Path | None:
    """The install Modder Tools has selected, else the first one detected."""
    from backend.settings import get_settings
    from models.trove.prefab_ally import resolve_game_install

    saved = ""
    try:
        saved = str(get_settings(include_games=False).get("last_game_path") or "")
    except Exception:
        pass
    for candidate in (saved or None, None):
        try:
            return resolve_game_install(candidate)
        except RuntimeError:
            continue
    return None


def _require_game() -> Path:
    path = _game_path()
    if path is None:
        raise _Refused(404, "No Trove installation was found, so the game's models can't be read.")
    return path


def _rig_map(wait: bool) -> game_data.RigMap:
    """The install's rig map. Without an install the map is empty, which opens a model
    with its parts laid out side by side rather than refusing it."""
    path = _game_path()
    if path is None:
        return game_data.RigMap()
    waited = 0.0
    while True:
        rig = game_data.rig_map(path)
        if rig is not None:
            return rig
        status = game_data.index_status()
        if status["error"]:
            raise _Refused(500, f"The game's models couldn't be indexed: {status['error']}")
        if not wait or waited >= _INDEX_WAIT_SECONDS:
            raise _Refused(503, "Still reading the game's models - try again in a moment.")
        gevent.sleep(0.25)
        waited += 0.25


# --- single blueprints -------------------------------------------------------- #


@_route("/api/blueprint-editor/inspect", "POST")
def inspect():
    data, name = _base()
    return _json(_off_thread(bp_editor.inspect, data, name=name))


@_route("/api/blueprint-editor/flatten", "POST")
def flatten():
    data, _name_ = _base()
    parts, specs = _stack()
    if not parts:
        raise _Refused(400, "There are no layers to flatten.")
    edits = _form_json("edits", "[]")
    out, summary = _off_thread(bp_editor.composite, data, edits, parts, specs, _anchor())
    return _binary(out, **{"X-Kiwi-Summary": json.dumps(summary)})


@_route("/api/blueprint-editor/transform", "POST")
def transform():
    data, _name_ = _base()
    edits = _form_json("edits", "[]", "The request wasn't understood.")
    ops = _form_json("ops", "[]", "The request wasn't understood.")
    out, summary = _off_thread(bp_editor.transform, data, edits, ops)
    return _binary(out, **{"X-Kiwi-Summary": json.dumps(summary)})


@_route("/api/blueprint-editor/export-qb", "POST")
def export_qb():
    data, name = _base()
    edits = _form_json("edits", "[]")
    stem = name[: -len(".blueprint")] if name.lower().endswith(".blueprint") else name
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", stem) or "model"
    parts, specs = _stack()
    archive, summary = _off_thread(bp_editor.export_qb, data, edits, parts, specs, _anchor(), stem=stem)
    return _binary(archive, "application/zip", **{
        "Content-Disposition": _attachment(f"{stem}_qb.zip"),
        "X-Kiwi-Notes": json.dumps(summary["notes"]),
    })


@_route("/api/blueprint-editor/import-qb", "POST")
def import_qb():
    parts: dict[str, bytes] = {}
    for part in _uploads("files"):
        name = _name(part, "model.qb")
        if not name.lower().endswith(".qb"):
            raise _Refused(400, f"'{name}' isn't a .qb file.")
        parts[name] = _read(part)
    if not parts:
        raise _Refused(400, "No .qb files were sent.")
    if len(parts) > 4:
        raise _Refused(400, "Send the model and up to three material maps.")
    data, summary = _off_thread(bp_editor.import_qb, parts)
    return _binary(data, **{"X-Kiwi-Summary": json.dumps(summary)})


@_route("/api/blueprint-editor/check", "POST")
def check():
    data, _name_ = _base()
    edits = _form_json("edits", "[]")
    parts, specs = _stack()
    report = _off_thread(bp_editor.check, data, edits, _form("kind", "other"), parts, specs, _anchor())
    return _json(report)


@_route("/api/blueprint-editor/save", "POST")
def save():
    data, name = _base()
    edits = _form_json("edits", "[]")
    parts, specs = _stack()
    out, summary = _off_thread(bp_editor.composite, data, edits, parts, specs, _anchor())
    if not name.lower().endswith(".blueprint"):
        name += ".blueprint"
    return _binary(out, **{
        "Content-Disposition": _attachment(name),
        "X-Kiwi-Recoloured": str(summary["recoloured"]),
        "X-Kiwi-Rematerialised": str(summary["rematerialised"]),
        "X-Kiwi-Ignored": str(summary["ignored"]),
    })


# --- model projects ------------------------------------------------------------ #


def _model_files(use_file: bool = True) -> tuple[str, dict, list, str]:
    part = _upload("file") if use_file else None
    if part is not None:
        data = _read(part)
        if not data:
            raise _Refused(400, "That file is empty.")
        name = _name(part, "model")
        kind, props, unpacked = _off_thread(bp_model.unpack, data, name)
        return kind, props, unpacked, name
    loose = []
    for p in _uploads("files"):
        name = _name(p, "part.blueprint")
        if not name.lower().endswith(".blueprint"):
            raise _Refused(400, f"'{name}' isn't a .blueprint.")
        loose.append((name, _read(p)))
    if not loose:
        raise _Refused(400, "Send a .tmod or .zip, or the .blueprint files themselves.")
    return "files", {}, loose, "model"


@_route("/api/blueprint-editor/model", "POST")
def open_model():
    kind, _props, unpacked, name = _model_files()
    blueprints = bp_model.parts_of(unpacked)
    if not blueprints:
        raise _Refused(400, "There are no .blueprint files in there.")
    rig = _rig_map(wait=True)
    skeleton, attach = game_data.resolve(rig, [bp_model.basename_of(p) for p, _ in blueprints])
    if skeleton and not assembly.has_baked_rig(skeleton):
        skeleton = None
    scales = game_data.scales_for(rig, attach, skeleton)
    payload = _off_thread(bp_model.open_project, unpacked, rig_name=skeleton, attach=attach,
                          name=name, head_scale=scales.head, part_scales=scales.parts)
    payload["source"] = kind
    return _json(payload)


@_route("/api/blueprint-editor/game-model")
def open_game_model():
    prefab = (bottle.request.query.getunicode("prefab") or "").strip()
    if not prefab:
        raise _Refused(400, "Say which creature to open.")
    game = _require_game()
    rig = _rig_map(wait=True)
    canonical, candidates = game_data.prefab_path(rig, prefab)
    if not canonical:
        if candidates:
            raise _Refused(400, f"'{prefab}' names {len(candidates)} different creatures. "
                                f"Use the full path: {candidates[0]}")
        raise _Refused(404, f"The game data has no creature at '{prefab}'.")
    skeleton, parts = rig.creatures[canonical]

    def read_parts():
        paths = game_data.blueprint_paths(game)
        files = []
        for basename in parts:
            path = game_data.nearest_path(paths.get(f"{basename}.blueprint", []), canonical)
            raw = game_data.read_game_file(game, path) if path else None
            if raw:
                files.append((f"{basename}.blueprint", raw))
        return files

    files = _off_thread(read_parts)
    if not files:
        raise _Refused(404, "None of that creature's parts are in the game archive.")
    scales = game_data.creature_scales(rig, canonical)
    payload = _off_thread(bp_model.open_project, files,
                          rig_name=skeleton if assembly.has_baked_rig(skeleton) else None,
                          attach=dict(parts), name=game_data.prefab_stem(canonical) + ".zip",
                          head_scale=scales.head, part_scales=scales.parts)
    payload["source"] = "game"
    payload["prefab"] = canonical
    return _json(payload)


@_route("/api/blueprint-editor/model-save", "POST")
def save_model():
    has_archive = _upload("file") is not None
    kind, props, unpacked, source_name = _model_files(use_file=has_archive)
    name = _form("name", "").replace("\\", "/").rsplit("/", 1)[-1] or source_name
    edits = _form_json("edits", "{}")
    moves = _form_json("moves", "{}")
    extra_paths = _form_json("paths", "[]")
    if not isinstance(edits, dict) or not isinstance(moves, dict) or not isinstance(extra_paths, list):
        raise _Refused(400, "The edit list wasn't understood.")
    extra = []
    if has_archive:
        added = _uploads("files")
        if len(extra_paths) != len(added):
            raise _Refused(400, "The added parts didn't match the paths that arrived.")
        for part, want in zip(added, extra_paths, strict=True):
            extra.append((bp_model.pack_path(str(want) or part.raw_filename or ""), _read(part)))
    edited, summary = _off_thread(bp_model.apply_project, unpacked, edits, extra, moves)
    out, ext = _off_thread(bp_model.repack, kind, props, edited)
    stem = re.sub(r"\.(tmod|zip)$", "", name, flags=re.I) or "model"
    return _binary(out, **{"Content-Disposition": _attachment(f"{stem}.{ext}"),
                           "X-Kiwi-Summary": json.dumps(summary)})


# --- game data ------------------------------------------------------------------ #


@_route("/api/blueprint-editor/search")
def search():
    game = _game_path()
    if game is None:
        return _json({"items": [], "total": 0, "error": "No Trove installation was found."})
    rig = game_data.rig_map(game)
    if rig is None:
        status = game_data.index_status()
        return _json({"items": [], "total": 0, "indexing": not status["error"],
                      "error": status["error"]})
    try:
        limit = max(1, min(200, int(bottle.request.query.get("limit") or 60)))
    except ValueError:
        limit = 60
    items, total = game_data.search(rig, bottle.request.query.getunicode("q") or "",
                                    bottle.request.query.getunicode("type") or "", limit)
    return _json({"items": items, "count": len(items), "total": total})


@_route("/api/rigs/<skeleton>/anim/<name>")
def rig_animation(skeleton, name):
    anim = assembly.load_animation(skeleton, name)
    if anim is None:
        raise _Refused(404, "No such rig animation")
    return _binary(anim)


@_route("/api/rigs/<skeleton>/graph")
def rig_graph(skeleton):
    graph = assembly.load_animation_graph(skeleton)
    if graph is None:
        raise _Refused(404, "No such rig animation graph")
    return _binary(graph, "application/json")


@_route("/api/render/brdf-map.png")
def brdf_map():
    game = _game_path()
    png = _off_thread(game_data.brdf_png, game) if game else None
    if not png:
        raise _Refused(404, "brdf map not available")
    return bottle.HTTPResponse(png, 200, {"Content-Type": "image/png",
                                          "Cache-Control": "public, max-age=86400"})


# --- saving to disk ------------------------------------------------------------- #


@eel.expose
@standardize_response
def save_blueprint_editor_file(filename, data_base64):
    """The page's downloads, through a Save As dialog - WebView2 has no download shelf."""
    name = str(filename or "download").replace("\\", "/").rsplit("/", 1)[-1] or "download"
    ext = Path(name).suffix.lower()
    root = tk.Tk()
    root.attributes("-topmost", True)
    root.withdraw()
    try:
        path = filedialog.asksaveasfilename(
            title="Save", initialfile=name, defaultextension=ext,
            filetypes=[(f"{ext[1:].upper()} file", f"*{ext}"), ("All Files", "*.*")] if ext
            else [("All Files", "*.*")],
        )
    finally:
        root.destroy()
    if not path:
        return {"success": True, "cancelled": True}
    Path(path).write_bytes(base64.b64decode(data_base64 or ""))
    return {"success": True, "path": path}
