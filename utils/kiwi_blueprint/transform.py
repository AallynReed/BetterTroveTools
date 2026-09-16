"""Rotate and mirror a blueprint.

Turning a model is the fix for the commonest thing the Trove Creations checks report -
"the model is facing the wrong way" - so the two belong together. Three things have to
move with the geometry, and getting any of them wrong breaks the model quietly:

* **The bounding box.** A quarter turn swaps two axes, and v5 addresses voxels by a
  linear index computed from that box, so the box has to be rebuilt before encoding.

* **The attachment point.** It lives in the model's origin, not in a voxel, so nothing
  about it moves on its own. Rotate a sword without rotating its grip and the game keeps
  holding it by a point that is now somewhere out in the air. It transforms by the same
  formula as a voxel, including when it sits outside the box (a hat's does).

* **Placed decos.** A cornerstone's entity section stores model-local positions that line
  up with the type-39 placeholder voxels. Rotating the voxels and leaving the entities
  put would slide every piece of furniture out of its socket. Their coordinates are
  rewritten too, and if the entity section can't be parsed exactly the transform is
  refused rather than performed half-way.

Materials are scalars, so they simply travel with their voxel. Rotations are 90 degrees
clockwise looking down the named axis; apply one twice for 180.
"""
from __future__ import annotations

from utils.kiwi_blueprint import codec

OPERATIONS = ("rotate_x", "rotate_y", "rotate_z", "mirror_x", "mirror_y", "mirror_z")

OPERATION_LABELS = {
    "rotate_x": "Rotate on X", "rotate_y": "Rotate on Y", "rotate_z": "Rotate on Z",
    "mirror_x": "Flip left-right", "mirror_y": "Flip upside-down", "mirror_z": "Flip front-back",
}


class TransformError(ValueError):
    """A transform that can't be applied without corrupting the model."""


def _mapper(op: str, size: tuple[int, int, int]):
    """``(point -> point, new size)`` for one operation.

    The point function is deliberately total: it is applied to the attachment point as
    well as to voxels, and that can legitimately sit outside the box."""
    sx, sy, sz = size
    if op == "rotate_x":
        return (lambda x, y, z: (x, z, (sy - 1) - y)), (sx, sz, sy)
    if op == "rotate_y":
        return (lambda x, y, z: (z, y, (sx - 1) - x)), (sz, sy, sx)
    if op == "rotate_z":
        return (lambda x, y, z: (y, (sx - 1) - x, z)), (sy, sx, sz)
    if op == "mirror_x":
        return (lambda x, y, z: ((sx - 1) - x, y, z)), (sx, sy, sz)
    if op == "mirror_y":
        return (lambda x, y, z: (x, (sy - 1) - y, z)), (sx, sy, sz)
    if op == "mirror_z":
        return (lambda x, y, z: (x, y, (sz - 1) - z)), (sx, sy, sz)
    raise TransformError(f"Unknown transform: {op}.")


def _rewrite_entities(blob: bytes, point) -> bytes:
    """Move every placed entity by ``point``, keeping its sub-message verbatim."""
    if len(blob) < 4:
        return blob
    read = codec.read_entity_records(blob)
    if read is None:
        raise TransformError(
            "This model has placed objects whose data can't be read, so it can't be "
            "moved without leaving them behind.")
    records, tail = read
    if not records:
        return blob
    return codec.write_entity_records(
        [(*point(x, y, z), sub) for (x, y, z, sub) in records], tail)


def translate_entities(blob: bytes, shift: tuple[int, int, int]) -> bytes:
    """Move every placed entity by a fixed offset.

    Adding a voxel at a negative coordinate shifts the whole grid (a blueprint starts at
    zero), and the decos have to come along or they end up one socket over."""
    if shift == (0, 0, 0):
        return blob
    return _rewrite_entities(
        blob, lambda x, y, z: (x + shift[0], y + shift[1], z + shift[2]))


MAX_MOVE = 512


def move_on_rig(decoded: codec.DecodedBlueprint,
                delta: tuple[int, int, int]) -> codec.DecodedBlueprint:
    """Move the model within the space that HOLDS it, by ``delta`` voxels.

    For a part of a creature that means sliding it along its bone - the leg down, the
    horn forward. **Nothing about the geometry changes**: a blueprint's voxels are
    box-local and the box says nothing about where the box goes. Where it goes is the
    ORIGIN, which is exactly what this moves (the v5 header's ``pos``, or for v3/v4 the
    min corner their absolute coordinates are written around), and the assembled-
    creature pipeline adds that origin to every voxel it places.

    So this is also, and equivalently, a move of the ATTACHMENT POINT relative to the
    model - the two are the same number read from opposite ends (``codec.attachment_
    point``). A weapon whose grip sits half a voxel too low is fixed by the same
    operation as a horn that sits too far back.

    Placed decos are NOT moved, and that is not an oversight: their coordinates are
    model-local and the model has not moved inside its own box, so they stay on the
    placeholder voxels they belong to - unlike a translation from ``_reframe``, which
    shifts the grid itself and must carry them along."""
    dx, dy, dz = (int(v) for v in delta)
    if max(abs(dx), abs(dy), abs(dz)) > MAX_MOVE:
        raise TransformError("That's further than a part can be moved on its rig.")
    if (dx, dy, dz) == (0, 0, 0):
        return decoded
    if decoded.version == 5:
        px, py, pz = decoded.pos
        return codec.DecodedBlueprint(
            decoded.version, decoded.size, (px + dx, py + dy, pz + dz),
            decoded.voxels, decoded.entity_blob, decoded.offset)
    ox, oy, oz = decoded.offset
    return codec.DecodedBlueprint(
        decoded.version, decoded.size, decoded.pos, decoded.voxels,
        decoded.entity_blob, (ox + dx, oy + dy, oz + dz))


def apply(decoded: codec.DecodedBlueprint, ops) -> codec.DecodedBlueprint:
    """Apply operations in order, returning a new decoded blueprint.

    CPU-bound - call via ``asyncio.to_thread``."""
    if not isinstance(ops, list) or not ops:
        raise TransformError("No transform was given.")
    if len(ops) > 16:
        raise TransformError("That's more transforms than one step should carry.")

    voxels = [dict(v) for v in decoded.voxels]
    size = decoded.size
    attach = codec.attachment_point(decoded)
    entity_blob = decoded.entity_blob

    for op in ops:
        if op not in OPERATIONS:
            raise TransformError(f"Unknown transform: {op}.")
        point, size = _mapper(op, size)
        for v in voxels:
            v["x"], v["y"], v["z"] = point(v["x"], v["y"], v["z"])
        if attach is not None:
            attach = point(*attach)
        entity_blob = _rewrite_entities(entity_blob, point)

    if attach is not None:
        # Inverse of codec.attachment_point: put the origin back where the grip is.
        pos = (-attach[0], -attach[1], -attach[2])
    elif decoded.version == 5:
        pos = (-(size[0] // 2), decoded.pos[1], -(size[2] // 2))
    else:
        pos = (-(size[0] // 2), -(size[1] // 2), -(size[2] // 2))

    # v3/v4 store signed coordinates around a centred box rather than an origin, and the
    # old min corner means nothing once the axes have moved - so re-centre it, which is
    # how Trove writes those files in the first place.
    offset = ((-(size[0] // 2), -(size[1] // 2), -(size[2] // 2))
              if decoded.version in (3, 4) else decoded.offset)

    return codec.DecodedBlueprint(decoded.version, size, pos, voxels, entity_blob, offset)
