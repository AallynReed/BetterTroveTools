"""The Blueprint Editor's engine: inspect a ``.blueprint``, apply edits, re-encode.

Stateless by design. A file arrives with the request, the answer goes back with the
response, and nothing is kept -- on save the browser posts the original bytes back
alongside the edits, so the server never has to hold a session between the two.

Edits are indexed against the decoded voxel order, which the codec keeps stable
(v5 by linear index, v3/v4 by file order). The same file always decodes to the same
sequence, so an index means the same voxel on the save request as it did on the
inspect response -- and an untouched voxel is written back byte for byte, because the
encoder is handed the original ``(type, w)`` it decoded.
"""
from __future__ import annotations

from utils.kiwi_blueprint import codec, lint, materials, qb
from utils.kiwi_blueprint import merge as bp_merge
from utils.kiwi_blueprint import transform as bp_transform
from utils.kiwi_blueprint import workshop as mods_workshop
from utils.kiwi_blueprint.voxel import KIND_CODE, material_for

# The editor holds every voxel's material in browser memory and re-meshes on each
# edit, so it caps lower than the read-only viewer's 250k.
EDITOR_VOXEL_CAP = 150_000

# A blueprint is a small file: the largest of the 72,584 in the live game catalogue is
# 515 KB. 4 MB is eight times that - room for anything a modder builds, while still
# rejecting a mis-picked archive early instead of inflating it.
MAX_BLUEPRINT_BYTES = 4 * 1024 * 1024

# A .qb set is four uncompressed-ish grids rather than one packed model, so it is much
# bulkier than the blueprint it compiles to.
MAX_QB_BYTES = 48 * 1024 * 1024

# Building is voxel-at-a-time in a browser, so a save carrying tens of thousands of new
# cells is a runaway client rather than a person. The total still has to clear
# EDITOR_VOXEL_CAP afterwards.
MAX_ADDED_VOXELS = 20_000

# Blueprints are small models, not worlds; this bounds the grid a stray coordinate can
# ask us to allocate before the box is even fitted.
COORD_LIMIT = 4096


class EditorError(ValueError):
    """A blueprint the editor can't open, or an edit it won't apply."""


def _decode_or_raise(raw: bytes) -> codec.DecodedBlueprint:
    if len(raw) > MAX_BLUEPRINT_BYTES:
        raise EditorError("That file is too large to be a Trove blueprint.")
    if codec.is_empty_blueprint(raw):
        raise EditorError("This blueprint is an empty placeholder - there's nothing to edit.")
    try:
        return codec.decode_full(raw)
    except codec.BlueprintError as exc:
        raise EditorError(str(exc)) from exc


def inspect(raw: bytes, *, name: str = "blueprint") -> dict:
    """Decode a blueprint into the editor payload.

    On top of the arrays the 3D viewers already consume (``x/y/z/rgb/kind/level/spec``)
    this carries the raw ``type`` and ``w`` per voxel, plus an ``edit`` flag marking
    which voxels the material palette is allowed to rewrite. The client needs all three
    to show a voxel's real material and to grey out the ones it must not touch.

    CPU-bound - call via ``asyncio.to_thread``."""
    decoded = _decode_or_raise(raw)
    voxels = decoded.voxels
    if len(voxels) > EDITOR_VOXEL_CAP:
        raise EditorError(
            f"This model has {len(voxels):,} voxels, past the editor's "
            f"{EDITOR_VOXEL_CAP:,} limit. It can still be viewed in 3D.")

    xs: list[int] = []; ys: list[int] = []; zs: list[int] = []
    rgb: list[int] = []; kind: list[int] = []; level: list[int] = []; spec: list[int] = []
    types: list[int] = []; ws: list[int] = []; editable: list[int] = []
    paintable: list[int] = []
    procedural = placeholders = locked = 0
    seen: dict[tuple[int, int], int] = {}

    for v in voxels:
        vt, w = int(v["type"]), int(v["w"])
        r, g, b, k, lv, sp = material_for(v["r"], v["g"], v["b"], w, vt)
        xs.append(v["x"]); ys.append(v["y"]); zs.append(v["z"])
        rgb.append((r << 16) | (g << 8) | b)
        kind.append(KIND_CODE.get(k, 0)); level.append(lv); spec.append(sp)
        types.append(vt); ws.append(w)
        can_edit = materials.is_editable(vt)
        editable.append(1 if can_edit else 0)
        if not can_edit:
            locked += 1
        if vt == materials.PLACEHOLDER_TYPE:
            placeholders += 1
        # A procedural voxel's stored colour is a placeholder the game overwrites at
        # runtime, so painting it would change the file and nothing in game. Marked
        # separately from `edit`: that governs the MATERIAL, this governs the COLOUR,
        # and a voxel can be one without the other.
        is_proc = materials.is_procedural(vt, v["r"], v["g"], v["b"])
        paintable.append(0 if is_proc else 1)
        if is_proc:
            procedural += 1
        seen[(vt, w)] = seen.get((vt, w), 0) + 1

    entities = codec.parse_entity_section(decoded.entity_blob)
    attach = codec.attachment_point(decoded)
    return {
        "name": name,
        "count": len(voxels),
        "size": list(decoded.size),
        "version": decoded.version,
        # Where the game grips or seats this model. Outside the box for a hat or mask
        # (the gap is the head), inside the handle for a weapon, absent on v3/v4.
        "attachment": list(attach) if attach else None,
        # Where this model sits in the space that HOLDS it - a creature's rig, for a
        # part of one. The decoded voxels are box-local and x-mirrored, and the
        # assembled-creature pipeline reads the same file un-mirrored with the origin
        # added, so a consumer that wants to place a part the way the game does needs
        # both: `rig = (origin.x + size.x - 1 - x, origin.y + y, origin.z + z)`.
        # v5 keeps it in the header; v3/v4 store absolute coordinates and no header, so
        # it is the box's min corner. Same arithmetic either way.
        "origin": list(decoded.pos if decoded.version == 5 else decoded.offset),
        "creation_types": list(lint.CREATION_TYPES),
        "transforms": [{"op": op, "label": bp_transform.OPERATION_LABELS[op]}
                       for op in bp_transform.OPERATIONS],
        "align_modes": [{"mode": m, "label": bp_merge.ALIGN_LABELS[m]}
                        for m in bp_merge.ALIGN_MODES],
        "x": xs, "y": ys, "z": zs, "rgb": rgb,
        "kind": kind, "level": level, "spec": spec,
        "type": types, "w": ws, "edit": editable, "paint": paintable,
        "materials": [
            {"type": t, "w": w, "count": n, "label": materials.describe(t, w),
             "editable": materials.is_editable(t)}
            for (t, w), n in sorted(seen.items(), key=lambda kv: -kv[1])
        ],
        "stats": {
            "voxels": len(voxels),
            "locked": locked,
            "procedural": procedural,
            "placeholders": placeholders,
            "entities": entities["count"],
        },
        "palette": materials.palette(),
    }


def _material_of(entry) -> tuple[int, int]:
    """The ``(type, w)`` in an edit entry. Both or neither: ``w`` means a different
    thing per type (specular finish on a solid, opacity on glass), so half a material
    is not a material."""
    try:
        raw_type, raw_w = int(entry["type"]), int(entry["w"])
    except (KeyError, TypeError, ValueError):
        raise EditorError("A material edit needs both a type and a w.") from None
    try:
        return materials.validate_material(raw_type, raw_w)
    except ValueError as exc:
        raise EditorError(str(exc)) from None


def _colour_of(entry) -> int:
    try:
        packed = int(entry["rgb"])
    except (TypeError, ValueError):
        raise EditorError("An edit has an invalid colour.") from None
    if not 0 <= packed <= 0xFFFFFF:
        raise EditorError("An edit has an invalid colour.")
    return packed


def _coerce_edits(edits, total: int) -> tuple[dict[int, dict], set[int], list[dict]]:
    """Validate the incoming edit list into ``(changes, deletes, adds)``.

    Three shapes, all indexed against the order ``inspect`` returned:
      ``{"i": n, "type"/"w"/"rgb": ...}``  recolour or re-material voxel n
      ``{"i": n, "del": true}``            erase voxel n
      ``{"add": [x, y, z], "type", "w", "rgb"}``   place a new voxel

    Rejects rather than clamps anything structural: an out-of-range index or a
    non-palette type means the client is out of step with the file it posted, and
    applying a best guess would write a model the user never saw."""
    if not isinstance(edits, list):
        raise EditorError("The edit list wasn't understood.")
    if len(edits) > total + MAX_ADDED_VOXELS:
        raise EditorError("That's more edits than one save should carry.")

    changes: dict[int, dict] = {}
    deletes: set[int] = set()
    adds: list[dict] = []

    for entry in edits:
        if not isinstance(entry, dict):
            raise EditorError("The edit list wasn't understood.")

        if "add" in entry:
            coords = entry["add"]
            if not isinstance(coords, (list, tuple)) or len(coords) != 3:
                raise EditorError("A new voxel needs an x, y and z.")
            try:
                x, y, z = (int(c) for c in coords)
            except (TypeError, ValueError):
                raise EditorError("A new voxel has invalid coordinates.") from None
            if not all(-COORD_LIMIT <= c <= COORD_LIMIT for c in (x, y, z)):
                raise EditorError("A new voxel is outside the buildable area.")
            vtype, w = _material_of(entry)
            adds.append({"x": x, "y": y, "z": z, "rgb": _colour_of(entry),
                         "type": vtype, "w": w})
            if len(adds) > MAX_ADDED_VOXELS:
                raise EditorError(
                    f"That's more than {MAX_ADDED_VOXELS:,} new voxels in one save.")
            continue

        try:
            idx = int(entry["i"])
        except (KeyError, TypeError, ValueError):
            raise EditorError("An edit is missing its voxel index.") from None
        if not 0 <= idx < total:
            raise EditorError("An edit points outside the blueprint.")

        if entry.get("del"):
            deletes.add(idx)
            continue

        change: dict = {}
        if "type" in entry or "w" in entry:
            change["type"], change["w"] = _material_of(entry)
        if "rgb" in entry:
            change["rgb"] = _colour_of(entry)
        if change:
            changes[idx] = {**changes.get(idx, {}), **change}
    return changes, deletes, adds


def _reframe(voxels: list[dict], decoded: codec.DecodedBlueprint) -> tuple:
    """Fit the box around voxels that may now sit outside it, and keep the model
    anchored where it was.

    Adding a voxel past an edge grows the box; adding one at a negative coordinate also
    shifts everything, because a blueprint's grid starts at zero. The shift has to carry
    the attachment point and any placed decos with it, or the model would keep its shape
    and lose its grip and its furniture - the same failure a rotation would cause.

    Returns ``(voxels, size, pos, offset, entity_blob)``."""
    sx, sy, sz = decoded.size
    mnx = min(0, min(v["x"] for v in voxels))
    mny = min(0, min(v["y"] for v in voxels))
    mnz = min(0, min(v["z"] for v in voxels))
    # Never shrink: a delete at the edge leaves the box as it was, which keeps the
    # origin - and so the attachment point - exactly where the user left it.
    size = (max(sx, max(v["x"] for v in voxels) + 1) - mnx,
            max(sy, max(v["y"] for v in voxels) + 1) - mny,
            max(sz, max(v["z"] for v in voxels) + 1) - mnz)

    shift = (-mnx, -mny, -mnz)
    entity_blob = decoded.entity_blob
    attach = codec.attachment_point(decoded)
    if shift != (0, 0, 0):
        for v in voxels:
            v["x"] += shift[0]; v["y"] += shift[1]; v["z"] += shift[2]
        if attach is not None:
            attach = (attach[0] + shift[0], attach[1] + shift[1], attach[2] + shift[2])
        entity_blob = bp_transform.translate_entities(entity_blob, shift)

    if attach is not None:
        pos = (-attach[0], -attach[1], -attach[2])
    elif decoded.version == 5:
        pos = (-(size[0] // 2), decoded.pos[1], -(size[2] // 2))
    else:
        pos = (-(size[0] // 2), -(size[1] // 2), -(size[2] // 2))

    # v3/v4 store signed coordinates around a centred box; once the box changes the old
    # min corner means nothing, so re-centre it the way Trove writes those files.
    offset = ((-(size[0] // 2), -(size[1] // 2), -(size[2] // 2))
              if decoded.version in (3, 4) else decoded.offset)
    return voxels, size, pos, offset, entity_blob


def transform(raw: bytes, edits, ops, layers=None, specs=None) -> tuple[bytes, dict]:
    """Rotate and/or mirror the edited model, returning a new blueprint.

    Edits are baked in first, so the result is one file the page can reopen - which it
    must, because a transform renumbers every voxel and the caller's edit indices stop
    meaning anything the moment the axes move. CPU-bound - call via
    ``asyncio.to_thread``."""
    edited, _ = composite(raw, edits, layers, specs)
    decoded = codec.decode_full(edited)
    before = decoded.size
    try:
        moved = bp_transform.apply(decoded, ops)
        data = codec.encode(moved.voxels, version=moved.version, pos=moved.pos,
                            entity_blob=moved.entity_blob, offset=moved.offset,
                            size=moved.size)
    except (bp_transform.TransformError, codec.BlueprintError) as exc:
        raise EditorError(str(exc)) from exc
    attach = codec.attachment_point(moved)
    return data, {
        "applied": list(ops),
        "size_before": list(before),
        "size_after": list(moved.size),
        "attachment": list(attach) if attach else None,
        "entities": codec.parse_entity_section(moved.entity_blob)["count"],
    }


MAX_LAYERS = 8


def _layer_specs(specs, count: int):
    """Validate the per-layer placement list that rides alongside the layer files."""
    if not isinstance(specs, list) or len(specs) != count:
        raise EditorError("The layer list didn't match the files that arrived.")
    if count > MAX_LAYERS:
        raise EditorError(f"That's more than {MAX_LAYERS} layers in one stack.")
    out = []
    for spec in specs:
        if not isinstance(spec, dict):
            raise EditorError("A layer's placement wasn't understood.")
        mode = str(spec.get("mode") or "attachment")
        try:
            off = tuple(int(v) for v in (spec.get("offset") or (0, 0, 0)))
        except (TypeError, ValueError):
            raise EditorError("A layer has an invalid offset.") from None
        if len(off) != 3 or any(abs(v) > COORD_LIMIT for v in off):
            raise EditorError("A layer has an invalid offset.")
        # Every layer is a blueprint in its own right, so every layer can have been
        # painted on - its edits ride along with its placement.
        out.append((mode, off, spec.get("edits") or []))
    return out


def composite(raw: bytes, edits, layers: list[bytes] | None = None,
              specs=None, anchor_at: int = 0) -> tuple[bytes, dict]:
    """The model as it would be OUTPUT: edits applied, then the layer stack flattened.

    This is the one place a stack turns into a single blueprint, and every output path
    goes through it - download, the Trove Creations checks, the ``.qb`` export. Layering
    is non-destructive right up to here: a layer hides what is under it rather than
    replacing it, so moving it back off brings the covered voxels straight back, and
    only at this point does the stacking order decide which voxel wins a shared cell.

    With no layers this is exactly ``apply_edits``, byte-identical output included.
    CPU-bound - call via ``asyncio.to_thread``."""
    edited, summary = apply_edits(raw, edits)
    if not layers:
        return edited, {**summary, "layers": 0}
    placements = _layer_specs(specs if specs is not None else [], len(layers))
    if not 0 <= anchor_at <= len(layers):
        raise EditorError("The anchor layer isn't in the stack.")
    try:
        stack = []
        for data, (mode, off, layer_edits) in zip(layers, placements, strict=True):
            painted, _ = apply_edits(data, layer_edits) if layer_edits else (data, None)
            stack.append((_decode_or_raise(painted), mode, off))
        # The anchor arrives as `file` rather than as one of the layers, so it is put
        # back at the position it occupies in the stacking order. Which layer is the
        # frame and which layer is on top are separate questions.
        stack.insert(anchor_at, (codec.decode_full(edited), "corner", (0, 0, 0)))
        merged, msum = bp_merge.flatten(stack, anchor_at)
        data = codec.encode(merged.voxels, version=merged.version, pos=merged.pos,
                            entity_blob=merged.entity_blob, offset=merged.offset,
                            size=merged.size)
    except (bp_merge.MergeError, codec.BlueprintError) as exc:
        raise EditorError(str(exc)) from exc
    return data, {**summary, **msum}


def export_qb(raw: bytes, edits, layers=None, specs=None, anchor_at: int = 0, *,
              stem: str = "model") -> tuple[bytes, dict]:
    """Export the edited model as the four authoring ``.qb`` files, zipped.

    Edits are applied first, for the same reason ``check`` applies them: the export is
    of the model as it stands, not as it was opened. CPU-bound - call via
    ``asyncio.to_thread``."""
    edited, _ = composite(raw, edits, layers, specs, anchor_at)
    try:
        built = qb.from_blueprint(codec.decode_full(edited), stem=stem)
    except (qb.QbError, codec.BlueprintError) as exc:
        raise EditorError(str(exc)) from exc
    archive = mods_workshop.to_zip(list(built["files"].items()))
    return archive, {"notes": built["notes"], "attachment": built["attachment"],
                     "size": built["size"], "files": sorted(built["files"])}


def import_qb(files: dict[str, bytes]) -> tuple[bytes, dict]:
    """Compile a ``.qb`` (plus any material maps supplied with it) into a blueprint.

    CPU-bound - call via ``asyncio.to_thread``."""
    total = sum(len(v) for v in files.values())
    if total > MAX_QB_BYTES:
        raise EditorError("Those .qb files are too large to compile.")
    try:
        return qb.to_blueprint(files)
    except (qb.QbError, codec.BlueprintError) as exc:
        raise EditorError(str(exc)) from exc


def check(raw: bytes, edits, kind: str = "other", layers=None, specs=None,
          anchor_at: int = 0) -> dict:
    """Run the Trove Creations checks against the model *as it would be saved*.

    Edits are applied first on purpose: linting the file that arrived would grade work
    the user has already moved on from, and the question they're asking is "is what I'm
    about to download acceptable". CPU-bound - call via ``asyncio.to_thread``."""
    edited, _ = composite(raw, edits, layers, specs, anchor_at)
    return lint.check(codec.decode_full(edited), kind)


def apply_edits(raw: bytes, edits) -> tuple[bytes, dict]:
    """Apply edits to a blueprint and re-encode it.

    Handles recolour, re-material, erase and add. Returns ``(bytes, summary)``. With an
    empty edit list the version, origin, box and entity section all come straight off
    the decode, so the output is byte-identical to the input for v3/v4 and
    payload-identical for v5 (only the zlib container differs).

    Adding or erasing changes the shape of the model, so the box is refitted and - if a
    new voxel sits at a negative coordinate - the whole grid shifts, carrying the
    attachment point and the placed decos with it. See :func:`_reframe`.

    CPU-bound - call via ``asyncio.to_thread``."""
    decoded = _decode_or_raise(raw)
    changes, deletes, adds = _coerce_edits(edits, len(decoded.voxels))

    out: list[dict] = []
    recoloured = rematerialised = ignored = 0
    for i, v in enumerate(decoded.voxels):
        if i in deletes:
            continue
        change = changes.get(i)
        if not change:
            out.append(v)
            continue
        nv = dict(v)
        if "type" in change:
            # Refuse on the ORIGINAL type: the palette may only rewrite a voxel whose
            # meaning the editor showed the user. A placeholder or terrain voxel keeps
            # what it had rather than being converted into a solid block.
            if not materials.is_editable(v["type"]):
                ignored += 1
            else:
                nv["type"], nv["w"] = change["type"], change["w"]
                rematerialised += 1
        if "rgb" in change:
            # The game tints procedural voxels itself and ignores what's stored, so
            # writing a colour there would change the file and nothing the player
            # sees. Refused for the same reason a material change is: the editor
            # doesn't make edits that quietly don't happen.
            if materials.is_procedural(v["type"], v["r"], v["g"], v["b"]):
                ignored += 1
            else:
                packed = change["rgb"]
                nv["r"] = (packed >> 16) & 0xFF
                nv["g"] = (packed >> 8) & 0xFF
                nv["b"] = packed & 0xFF
                recoloured += 1
        out.append(nv)

    # A new voxel on a cell that already has one replaces it rather than doubling up:
    # v5 would silently collapse the pair anyway, and v3/v4 would write both.
    if adds:
        occupied = {(v["x"], v["y"], v["z"]): i for i, v in enumerate(out)}
        for a in adds:
            cell = (a["x"], a["y"], a["z"])
            nv = {"x": a["x"], "y": a["y"], "z": a["z"],
                  "r": (a["rgb"] >> 16) & 0xFF, "g": (a["rgb"] >> 8) & 0xFF,
                  "b": a["rgb"] & 0xFF, "w": a["w"], "type": a["type"]}
            if cell in occupied:
                out[occupied[cell]] = nv
            else:
                occupied[cell] = len(out)
                out.append(nv)

    if not out:
        raise EditorError("That would erase the whole model - a blueprint needs at "
                          "least one voxel.")
    if len(out) > EDITOR_VOXEL_CAP:
        raise EditorError(f"That would take the model past the editor's "
                          f"{EDITOR_VOXEL_CAP:,} voxel limit.")

    if adds or deletes:
        out, size, pos, offset, entity_blob = _reframe(out, decoded)
    else:
        size, pos = decoded.size, decoded.pos
        offset, entity_blob = decoded.offset, decoded.entity_blob

    try:
        data = codec.encode(out, version=decoded.version, pos=pos,
                            entity_blob=entity_blob, offset=offset, size=size)
    except (codec.BlueprintError, bp_transform.TransformError) as exc:
        raise EditorError(str(exc)) from exc
    return data, {
        "voxels": len(out),
        "recoloured": recoloured,
        "rematerialised": rematerialised,
        "added": len(adds),
        "erased": len(deletes),
        "size": list(size),
        "ignored": ignored,
        "version": decoded.version,
        "bytes": len(data),
    }
