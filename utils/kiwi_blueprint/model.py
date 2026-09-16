"""Model projects: a whole creature open in the Blueprint Editor at once.

A Trove model is not one file. A mount is a head, a jaw, four legs, a body and a tail,
each its own ``.blueprint``, and the game assembles them onto a skeleton at runtime.
The editor opened one at a time, so recolouring a dragon meant sixteen open-edit-save
rounds with no way to see the thing you were actually making.

This opens the whole set: every ``.blueprint`` inside a ``.tmod``/``.zip`` (or a pile
of loose files) is decoded into the same payload ``editor.inspect`` returns, and each
one is told WHERE it sits - the attach point on the rig, from the game's own prefab
bindings. The page then draws the assembled creature, edits one part at a time, and
posts the lot back to be written into a rebuilt mod.

Stateless like the rest of the editor: the archive arrives with the request, the parts
go back with the response, and the save carries the original archive again. Nothing is
held between the two.

**The rig is resolved authoritatively or not at all** (``rig_index.resolve``, from the
binfab bindings the game ships). A part the map doesn't place comes back ``ap: null``
and the page lays it out beside the model rather than guessing a bone for it - a wrong
bone is a model that looks assembled and isn't.
"""
from __future__ import annotations

import base64

from utils.kiwi_blueprint import tmod
from utils.kiwi_blueprint import codec, editor
from utils.kiwi_blueprint import transform as bp_transform
from utils.kiwi_blueprint import assembly
from utils.kiwi_blueprint import workshop as mods_workshop

# A creature is tens of parts, not hundreds; the biggest rigs in the game carry ~60
# attach points. Past this the caller sent an archive of something else.
MAX_PARTS = 48

# Every part is held in browser memory with its material arrays and re-meshed on each
# edit, so a project caps well below the per-model limit times the part count.
PROJECT_VOXEL_CAP = 300_000


def unpack(data: bytes, filename: str = "") -> tuple[str, dict, list[tuple[str, bytes]]]:
    """A ``.tmod`` or ``.zip`` taken apart into ``(kind, header, files)``.

    The Mod Workshop's reader, so a mod opens the same way in both places and a project
    saved here rebuilds into the same shape a rebuild there would."""
    try:
        return mods_workshop.read_archive(data, filename)
    except mods_workshop.WorkshopError as exc:
        raise editor.EditorError(str(exc)) from exc


def repack(kind: str, props: dict, files: list[tuple[str, bytes]]) -> tuple[bytes, str]:
    """Put an edited project back into the file it came out of: ``(bytes, extension)``.

    Paths are kept exactly as they arrived rather than re-planned. They came out of a
    mod that already loads, so the placement question the Workshop answers has been
    answered - re-deciding it here could move a file that was fine where it was."""
    if kind == "tmod":
        try:
            return tmod.build_tmod(1, props, files), "tmod"
        except tmod.TmodError as exc:
            raise editor.EditorError(f"That mod couldn't be rebuilt: {exc}") from exc
    return mods_workshop.to_zip(files), "zip"


def parts_of(files: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    """The ``.blueprint`` files out of an unpacked archive, in path order."""
    return sorted(((p, d) for p, d in files if p.lower().endswith(".blueprint")),
                  key=lambda pd: pd[0].lower())


def basename_of(path: str) -> str:
    """The key ``rig_index`` binds attach points against: the lowercased filename with
    its extension off (``blueprints/DragonHead.blueprint`` -> ``dragonhead``)."""
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    return name[: -len(".blueprint")].lower()


def open_project(files: list[tuple[str, bytes]], *, rig_name: str | None,
                 attach: dict[str, str], name: str = "model", head_scale: float = 1.0,
                 part_scales: dict[str, float] | None = None) -> dict:
    """Decode every blueprint in an unpacked mod into an editable project.

    ``rig_name`` + ``attach`` (basename -> AP key) come from ``rig_index.resolve`` and
    are the ONLY source of placement. A part that isn't in the map, or sits at a socket
    this skeleton hasn't got, comes back unplaced rather than guessed onto a bone.

    Each part carries its own bytes back to the browser (``blueprint``, base64) so that
    every single-file tool the page already has - the checks, the ``.qb`` export, a
    rotation - keeps working on one part of a project exactly as it does on an opened
    file. CPU-bound; call via ``asyncio.to_thread``."""
    blueprints = parts_of(files)
    if not blueprints:
        raise editor.EditorError(
            "There are no .blueprint files in there. A model project is a mod's voxel "
            "parts - open a .tmod, a .zip or the blueprints themselves.")
    if len(blueprints) > MAX_PARTS:
        raise editor.EditorError(
            f"That's {len(blueprints):,} models in one file, past the {MAX_PARTS} a "
            "project holds. Open the parts you want to work on instead.")

    pose = assembly.rig_pose(rig_name) if rig_name else None
    parts: list[dict] = []
    skipped: list[dict] = []
    total = 0
    for path, raw in blueprints:
        try:
            payload = editor.inspect(raw, name=path.rsplit("/", 1)[-1])
        except editor.EditorError as exc:
            # One part the editor can't open must not cost the other fifteen. An empty
            # placeholder blueprint is the common case and a normal thing for a mod to
            # ship, so it is reported rather than raised.
            skipped.append({"path": path, "reason": str(exc)})
            continue
        total += payload["count"]
        if total > PROJECT_VOXEL_CAP:
            raise editor.EditorError(
                f"This model is past the editor's {PROJECT_VOXEL_CAP:,} voxel limit for "
                "a whole project. Open its parts one at a time instead.")
        ap = attach.get(basename_of(path))
        if pose is not None and ap not in pose["rest"]:
            ap = None                      # a socket this skeleton hasn't got: unplaced
        scale = (part_scales or {}).get(basename_of(path))
        if scale is None:
            scale = assembly.scale_for(ap, rig_name, head_scale) if ap else 1.0
        parts.append({
            "path": path,
            "name": payload["name"],
            "ap": ap,
            "scale": scale if ap else 1.0,
            "blueprint": base64.b64encode(raw).decode("ascii"),
            "model": payload,
        })
    if not parts:
        raise editor.EditorError(
            "None of the blueprints in there could be opened." if skipped
            else "There's nothing to edit in there.")

    return {
        "name": name,
        "rig": rig_payload(rig_name, head_scale) if pose else None,
        "parts": parts,
        "skipped": skipped,
        # Everything that isn't a blueprint - the config, the preview image, textures -
        # rides through the save untouched. Counted so the page can say so.
        "extras": len(files) - len(blueprints),
    }


def rig_payload(rig_name: str, head_scale: float = 1.0) -> dict | None:
    """The whole skeleton as the editor needs it: the rest matrices, the voxel size and
    the resolution multiplier of EVERY socket - not just the ones this mod fills.

    All of them, because a part added to an open project is placed by the person adding
    it. They pick the socket off this list, so the list has to hold the empty ones too -
    a mod that ships no hat is exactly the mod someone is about to add a hat to. The
    scale comes from here rather than being re-derived in the browser: a head-area socket
    takes the creature's declared ``head_scale`` (``scale_for``), and that rule lives in
    one place."""
    pose = assembly.rig_pose(rig_name) if rig_name else None
    if pose is None:
        return None
    return {
        "name": rig_name,
        "voxel_scale": pose["voxel_scale"],
        "rest": pose["rest"],
        "scales": {ap: assembly.scale_for(ap, rig_name, head_scale) for ap in pose["rest"]},
        # Names + frame counts only. A clip is fetched from /site/rigs/<rig>/anim/<name>
        # when it is played, the same way the model viewer does it - a rig ships up to
        # 80 of them and the payload is already the heaviest thing this page asks for.
        "animations": assembly.animations_for(rig_name),
    }


def apply_project(files: list[tuple[str, bytes]], edits: dict[str, list],
                  extra: list[tuple[str, bytes]] | None = None,
                  moves: dict[str, list] | None = None,
                  ) -> tuple[list[tuple[str, bytes]], dict]:
    """Write each part's edits back into the mod's file list.

    ``edits`` is ``{path: edit list}`` against the paths ``open_project`` returned.
    ``extra`` is parts that weren't in the mod when it was opened - a blueprint dropped
    onto an open model - each at the path it should be packed at; one whose path is
    already taken replaces that file, which is how you swap a part out for a new one.
    ``moves`` is ``{path: [dx, dy, dz]}``, the part slid along its bone - applied AFTER
    its edits, because adding a voxel past an edge can refit the box and recompute the
    origin, and the move is relative to wherever the part ends up sitting.

    Everything else in the archive is carried through byte for byte, so a mod comes out
    of the editor with its config, preview and textures exactly as they went in.
    CPU-bound; call via ``asyncio.to_thread``."""
    # A part whose path is already in the mod REPLACES it; what's left over is new and
    # goes on the end.
    incoming = dict(extra or ())
    merged: list[tuple[str, bytes]] = [(p, incoming.pop(p, d)) for p, d in files]
    merged += list(incoming.items())

    moves = {k: v for k, v in (moves or {}).items() if tuple(v or ()) != (0, 0, 0)}
    known = {p for p, _ in merged}
    unknown = [p for p in list(edits) + list(moves) if p not in known]
    if unknown:
        raise editor.EditorError(
            f"'{unknown[0]}' isn't a file in that mod - reopen the model and try again.")
    if len(parts_of(merged)) > MAX_PARTS:
        raise editor.EditorError(
            f"That's more than the {MAX_PARTS} parts a project holds.")

    out: list[tuple[str, bytes]] = []
    summary = {"parts": 0, "added_parts": len(incoming), "moved": len(moves),
               "recoloured": 0, "rematerialised": 0, "added": 0, "erased": 0,
               "ignored": 0}
    for path, raw in merged:
        entries, delta = edits.get(path), moves.get(path)
        if not entries and not delta:
            out.append((path, raw))
            continue
        data = raw
        if entries:
            data, part_summary = editor.apply_edits(raw, entries)
            for key in ("recoloured", "rematerialised", "added", "erased", "ignored"):
                summary[key] += part_summary[key]
        if delta:
            data = _moved(data, delta)
        out.append((path, data))
        summary["parts"] += 1
    return out, summary


def _moved(raw: bytes, delta) -> bytes:
    """One part slid along its bone, re-encoded. See ``transform.move_on_rig`` - it is
    the origin that moves, so the voxels come back out of the encoder untouched."""
    try:
        moved = bp_transform.move_on_rig(codec.decode_full(raw), _delta(delta))
        return codec.encode(moved.voxels, version=moved.version, pos=moved.pos,
                            entity_blob=moved.entity_blob, offset=moved.offset,
                            size=moved.size)
    except (bp_transform.TransformError, codec.BlueprintError) as exc:
        raise editor.EditorError(str(exc)) from exc


def _delta(value) -> tuple[int, int, int]:
    try:
        dx, dy, dz = (int(v) for v in value)
    except (TypeError, ValueError):
        raise editor.EditorError("A part's move wasn't understood.") from None
    return dx, dy, dz


BLUEPRINT_DIR = "blueprints/"


def pack_path(path: str) -> str:
    """Where a newly added part goes inside the mod.

    Trove reads voxel models out of ``blueprints/`` and nowhere else, so a bare filename
    is placed there - the same placement the Mod Workshop would give it. A path that
    already names a folder is kept (that is how a part gets swapped for a new one), with
    the traversal segments taken out: these become entries in an archive."""
    clean = [seg for seg in (path or "").replace("\\", "/").split("/")
             if seg not in ("", ".", "..")]
    name = "/".join(clean) or "part.blueprint"
    if not name.lower().endswith(".blueprint"):
        name += ".blueprint"
    return name if "/" in name else BLUEPRINT_DIR + name
