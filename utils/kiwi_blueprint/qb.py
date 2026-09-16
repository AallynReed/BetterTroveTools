"""Qubicle Binary (``.qb``) with Trove's material maps -- the authoring format.

Trove's modding pipeline is four ``.qb`` files, not one: a base model carrying colour,
and three *material maps* at identical dimensions whose voxel colours encode what the
material is. ``foo.qb`` + ``foo_a.qb`` (alpha) + ``foo_s.qb`` (specular) + ``foo_t.qb``
(type) compile to one ``.blueprint``, and this module goes both ways.

The map palettes below are Trove's, taken from Troxel (chrmoritz/Troxel), the community
editor modders have used against the real game for years:

    type (_t)      solid (255,255,255) · glass (128,128,128) · tiled glass (64,64,64)
                   glowing solid (255,0,0) · glowing glass (255,255,0)
    specular (_s)  rough (128,0,0) · metal (0,128,0) · water (0,0,128)
                   iridescent (128,128,0) · waxy (128,0,128)
    alpha (_a)     grey 16 + 32*level for glass, white for solid
    attachment     magenta (255,0,255) in ALL FOUR maps

The attachment point is the one thing that doesn't survive as a voxel. A blueprint keeps
it as the model's origin (see ``codec.attachment_point``), and a ``.qb`` keeps it BOTH as
a magenta voxel and as a negative matrix-position offset -- Troxel reads it back as
``-dx, -dy, -dz``, which is the same trick from the other end. Export writes both so the
file works whichever way a tool reads it; import accepts either.

Coordinates: this module works in the codec's decoded frame throughout, which IS the
Qubicle frame -- that's what "the X axis is mirrored relative to Qubicle" in the codec
means, and the mirror is already applied by the time voxels reach here.

Format reference: Qubicle Constructor 1 "Data Exchange With Qubicle Binary".
"""
from __future__ import annotations

import struct

from utils.kiwi_blueprint import codec, materials
from utils.kiwi_blueprint.voxel import material_for

QB_VERSION = 257            # 1.1.0.0
CODEFLAG = 2
NEXTSLICEFLAG = 6

ATTACHMENT_RGB = (255, 0, 255)

# Trove voxel type -> the (_t) map index Troxel uses, and back.
TYPE_TO_INDEX = {21: 0, 18: 1, 54: 2, 55: 3, 56: 4}
INDEX_TO_TYPE = {v: k for k, v in TYPE_TO_INDEX.items()}

TYPE_MAP_RGB = {
    0: (255, 255, 255), 1: (128, 128, 128), 2: (64, 64, 64),
    3: (255, 0, 0), 4: (255, 255, 0),
}
RGB_TO_TYPE_INDEX = {v: k for k, v in TYPE_MAP_RGB.items()}

SPECULAR_MAP_RGB = {
    0: (128, 0, 0), 1: (0, 128, 0), 2: (0, 0, 128),
    3: (128, 128, 0), 4: (128, 0, 128),
}
RGB_TO_SPECULAR = {v: k for k, v in SPECULAR_MAP_RGB.items()}

# The specular byte indexes 8 tiles of the game's brdfmap, but only 0-4 have an agreed
# map colour. 5-7 occur in real game files (~1% of solids) and have nowhere to go in a
# .qb, so export reports them rather than silently writing them out as rough.
MAX_MAPPED_SPECULAR = 4

VALID_ALPHA = frozenset({16, 48, 80, 112, 144, 176, 208, 240, 255})


class QbError(ValueError):
    """A .qb that can't be read, or a set of maps that don't agree."""


# --------------------------------------------------------------------------- #
# read
# --------------------------------------------------------------------------- #
class QbMatrix:
    """One matrix: ``cells`` maps ``(x, y, z)`` to ``(r, g, b)`` for visible voxels."""

    __slots__ = ("name", "size", "pos", "cells")

    def __init__(self, name, size, pos, cells):
        self.name = name
        self.size = size
        self.pos = pos
        self.cells = cells


def read_qb(data: bytes) -> list[QbMatrix]:
    """Parse a ``.qb`` into its matrices. Handles both uncompressed and RLE bodies,
    and both colour orders."""
    if len(data) < 24:
        raise QbError("That file is too short to be a .qb.")
    version, colour_format, z_orientation, compression, vis_mask, count = \
        struct.unpack_from("<6I", data, 0)
    if version != QB_VERSION:
        # Not fatal: the layout has been stable, and refusing a file Qubicle itself
        # wrote over a version byte would be unhelpful.
        pass
    if count == 0 or count > 512:
        raise QbError("That .qb declares an implausible number of matrices.")

    out: list[QbMatrix] = []
    off = 24
    for _ in range(count):
        if off >= len(data):
            raise QbError("That .qb is truncated.")
        name_len = data[off]
        off += 1
        name = data[off:off + name_len].decode("latin-1", "replace")
        off += name_len
        sx, sy, sz = struct.unpack_from("<3I", data, off)
        off += 12
        dx, dy, dz = struct.unpack_from("<3i", data, off)
        off += 12
        if sx * sy * sz > 64_000_000:
            raise QbError("That .qb declares an implausibly large matrix.")

        cells: dict[tuple[int, int, int], tuple[int, int, int]] = {}
        if compression == 0:
            need = 4 * sx * sy * sz
            if off + need > len(data):
                raise QbError("That .qb is truncated.")
            for z in range(sz):
                for y in range(sy):
                    base = off + 4 * (z * sy * sx + y * sx)
                    for x in range(sx):
                        i = base + 4 * x
                        if data[i + 3] > 0:
                            cells[(x, y, z)] = (data[i], data[i + 1], data[i + 2])
            off += need
        else:
            off = _read_rle(data, off, sx, sy, sz, cells)

        if colour_format == 1:          # BGRA
            cells = {k: (b, g, r) for k, (r, g, b) in cells.items()}
        if z_orientation == 0:          # left-handed: flip Z into our frame
            cells = {(x, y, sz - 1 - z): v for (x, y, z), v in cells.items()}
        out.append(QbMatrix(name, (sx, sy, sz), (dx, dy, dz), cells))
    if vis_mask:
        # Partial visibility encodes per-face flags in A instead of "is this voxel
        # here"; every voxel above still reads as present, which is the safe way round.
        pass
    return out


def _read_rle(data, off, sx, sy, sz, cells) -> int:
    for z in range(sz):
        index = 0
        while True:
            if off + 4 > len(data):
                raise QbError("That .qb is truncated.")
            chunk = struct.unpack_from("<I", data, off)[0]
            off += 4
            if chunk == NEXTSLICEFLAG:
                break
            if chunk == CODEFLAG:
                if off + 8 > len(data):
                    raise QbError("That .qb is truncated.")
                run = struct.unpack_from("<I", data, off)[0]
                r, g, b, a = data[off + 4], data[off + 5], data[off + 6], data[off + 7]
                off += 8
                if a > 0:
                    for _ in range(run):
                        cells[(index % sx, index // sx, z)] = (r, g, b)
                        index += 1
                else:
                    index += run
            else:
                r, g, b, a = (chunk & 0xFF, (chunk >> 8) & 0xFF,
                              (chunk >> 16) & 0xFF, (chunk >> 24) & 0xFF)
                if a > 0:
                    cells[(index % sx, index // sx, z)] = (r, g, b)
                index += 1
    return off


def _merge(matrices: list[QbMatrix]) -> tuple[dict, tuple[int, int, int], tuple[int, int, int]]:
    """Flatten every matrix into one grid, honouring each one's position offset, and
    return ``(cells, size, first_matrix_pos)``."""
    if not matrices:
        raise QbError("That .qb has no matrices.")
    if len(matrices) == 1:
        m = matrices[0]
        return dict(m.cells), m.size, m.pos
    mnx = min(m.pos[0] for m in matrices)
    mny = min(m.pos[1] for m in matrices)
    mnz = min(m.pos[2] for m in matrices)
    cells: dict = {}
    for m in matrices:
        ox, oy, oz = m.pos[0] - mnx, m.pos[1] - mny, m.pos[2] - mnz
        for (x, y, z), v in m.cells.items():
            cells[(x + ox, y + oy, z + oz)] = v
    sx = max(x for x, _, _ in cells) + 1
    sy = max(y for _, y, _ in cells) + 1
    sz = max(z for _, _, z in cells) + 1
    return cells, (sx, sy, sz), matrices[0].pos


# --------------------------------------------------------------------------- #
# write
# --------------------------------------------------------------------------- #
def write_qb(cells: dict, size: tuple[int, int, int], *,
             name: str = "Model", pos: tuple[int, int, int] = (0, 0, 0)) -> bytes:
    """Write one RLE-compressed matrix. ``cells`` maps ``(x, y, z)`` to ``(r, g, b)``.

    RLE rather than a flat grid because a map is one file per model and a sparse model
    in a large box is mostly empty: a 100-cube would be 4 MB raw, per map, four times
    over."""
    sx, sy, sz = size
    head = bytearray(struct.pack(
        "<6I", QB_VERSION, 0, 1, 1, 0, 1))       # RGBA, right-handed, RLE, 1 matrix
    stem = name.encode("latin-1", "replace")[:255]
    head.append(len(stem))
    head += stem
    head += struct.pack("<3I", sx, sy, sz)
    head += struct.pack("<3i", *pos)

    body = bytearray()
    for z in range(sz):
        run_val = None
        run_len = 0

        def flush(val=None, length=0):
            if length == 0:
                return
            if length > 1:
                body.extend(struct.pack("<II", CODEFLAG, length))
            body.extend(struct.pack("<4B", val[0], val[1], val[2], 255) if val
                        else b"\0\0\0\0")

        for y in range(sy):
            for x in range(sx):
                v = cells.get((x, y, z))
                if v == run_val:
                    run_len += 1
                else:
                    flush(run_val, run_len)
                    run_val, run_len = v, 1
        flush(run_val, run_len)
        body.extend(struct.pack("<I", NEXTSLICEFLAG))
    return bytes(head + body)


# --------------------------------------------------------------------------- #
# blueprint -> .qb set
# --------------------------------------------------------------------------- #
def from_blueprint(decoded: codec.DecodedBlueprint, *, stem: str = "model") -> dict:
    """Build the four authoring ``.qb`` files from a decoded blueprint.

    Returns ``{"files": {filename: bytes}, "notes": [...], "attachment": [x,y,z]|None}``.

    The attachment point is written back as a magenta voxel in all four maps *and* as a
    negative matrix offset, which is how both Trove and Troxel expect to find it. That
    can grow the grid: on a hat the attachment sits below the model, so the exported
    ``.qb`` is taller than the blueprint's own bounding box by exactly the gap the game
    needs -- which is the shape a modder authored in the first place.

    Lossy in one narrow place, reported rather than hidden: the specular byte indexes 8
    brdfmap tiles and only 0-4 have an agreed map colour, so a solid using 5-7 is written
    as rough. CPU-bound - call via ``asyncio.to_thread``."""
    voxels = decoded.voxels
    attach = codec.attachment_point(decoded)

    # Grow the grid to cover the attachment point when it falls outside the model.
    mnx = mny = mnz = 0
    sx, sy, sz = decoded.size
    if attach is not None:
        mnx, mny, mnz = min(0, attach[0]), min(0, attach[1]), min(0, attach[2])
        sx = max(sx, attach[0] + 1) - mnx
        sy = max(sy, attach[1] + 1) - mny
        sz = max(sz, attach[2] + 1) - mnz

    base: dict = {}
    amap: dict = {}
    smap: dict = {}
    tmap: dict = {}
    dropped_spec = 0
    unmapped_types: dict[int, int] = {}

    # THE mirror. A blueprint indexes X one way and Qubicle draws it the other, and
    # this boundary is the only place that difference is anyone's business - the codec
    # used to do it for every caller, which mirrored every 3D preview on the site.
    def _qx(x):
        return sx - 1 - (x - mnx)

    for v in voxels:
        key = (_qx(v["x"]), v["y"] - mny, v["z"] - mnz)
        vt, w = int(v["type"]), int(v["w"])
        rgb = (int(v["r"]), int(v["g"]), int(v["b"]))
        # A procedural voxel stores a near-black placeholder the game replaces at
        # runtime. Writing that verbatim would open as a black blob in Qubicle, so the
        # export carries the colour a human actually sees - and the .blueprint it came
        # from still holds the original bytes either way.
        if materials.is_procedural(vt, *rgb):
            r, g, b, _k, _l, _s = material_for(rgb[0], rgb[1], rgb[2], w, vt)
            rgb = (r, g, b)
        base[key] = rgb

        index = TYPE_TO_INDEX.get(vt)
        if index is None:
            # Not a UGC type (placeholder, terrain, anything internal). The .qb palette
            # has no way to say what it is, so it goes out as a plain solid and the
            # count is reported.
            unmapped_types[vt] = unmapped_types.get(vt, 0) + 1
            index = 0
        tmap[key] = TYPE_MAP_RGB[index]

        if materials.material_class(vt) == materials.GLASS:
            level = materials.alpha_for_w(w)
            amap[key] = (level, level, level)
            smap[key] = SPECULAR_MAP_RGB[0]          # specular is unused on glass
        else:
            amap[key] = (255, 255, 255)              # opaque
            if w > MAX_MAPPED_SPECULAR:
                dropped_spec += 1
                smap[key] = SPECULAR_MAP_RGB[0]
            else:
                smap[key] = SPECULAR_MAP_RGB.get(w, SPECULAR_MAP_RGB[0])

    if attach is not None:
        akey = (_qx(attach[0]), attach[1] - mny, attach[2] - mnz)
        for grid in (base, amap, smap, tmap):
            grid[akey] = ATTACHMENT_RGB
        # Negative offset: Qubicle stores where the matrix sits, and Troxel reads the
        # attachment point straight back out of it as (-dx, -dy, -dz).
        pos = (-akey[0], -akey[1], -akey[2])
    else:
        pos = (0, 0, 0)

    size = (sx, sy, sz)
    files = {
        f"{stem}.qb": write_qb(base, size, name=stem, pos=pos),
        f"{stem}_a.qb": write_qb(amap, size, name=f"{stem}_a", pos=pos),
        f"{stem}_s.qb": write_qb(smap, size, name=f"{stem}_s", pos=pos),
        f"{stem}_t.qb": write_qb(tmap, size, name=f"{stem}_t", pos=pos),
    }

    notes = []
    if attach is not None:
        notes.append(
            f"The attachment point is written as a magenta voxel at "
            f"({akey[0]}, {akey[1]}, {akey[2]}) in all four files.")
    elif decoded.version != 5:
        notes.append(
            f"This is a v{decoded.version} blueprint, which stores no attachment point, "
            f"so none was written. Add a magenta (255, 0, 255) voxel where the model "
            f"should be held before compiling it back.")
    if dropped_spec:
        notes.append(
            f"{dropped_spec:,} solid voxel{'s' if dropped_spec != 1 else ''} use a "
            f"specular finish beyond the five the material maps can express, and were "
            f"written as rough. Re-importing this .qb will not bring them back.")
    if unmapped_types:
        total = sum(unmapped_types.values())
        names = ", ".join(materials.describe(t, 0) for t in sorted(unmapped_types)[:3])
        notes.append(
            f"{total:,} voxel{'s' if total != 1 else ''} use materials the game keeps to "
            f"itself ({names}) and were written as plain solid. The .blueprint you "
            f"exported from still has them.")
    return {"files": files, "notes": notes,
            "attachment": list(attach) if attach else None,
            "size": list(size)}


# --------------------------------------------------------------------------- #
# .qb set -> blueprint
# --------------------------------------------------------------------------- #
def _classify(files: dict[str, bytes]) -> dict[str, bytes]:
    """Sort uploaded files into base / a / s / t by the ``_a`` / ``_s`` / ``_t`` suffix
    Trove's pipeline uses. Anything else is the base."""
    out: dict[str, bytes] = {}
    for name, data in files.items():
        stem = name.rsplit("/", 1)[-1]
        stem = stem[:-3] if stem.lower().endswith(".qb") else stem
        low = stem.lower()
        if low.endswith("_a"):
            out["a"] = data
        elif low.endswith("_s"):
            out["s"] = data
        elif low.endswith("_t"):
            out["t"] = data
        else:
            out.setdefault("base", data)
    if "base" not in out:
        raise QbError("No base .qb was found - the model file must not end in _a, _s or _t.")
    return out


def to_blueprint(files: dict[str, bytes], *, version: int = 5) -> tuple[bytes, dict]:
    """Compile a ``.qb`` (plus whatever material maps came with it) into a blueprint.

    Only the base file is required. A missing map means its default: opaque, rough,
    solid -- the same thing the game assumes.

    The attachment point is taken from the magenta voxel if there is one, else from a
    negative matrix offset, else nothing. It is removed from the geometry (it is a
    marker, not part of the model) and becomes the blueprint's origin.

    Returns ``(blueprint bytes, summary)``. CPU-bound - call via ``asyncio.to_thread``."""
    parts = _classify(files)
    base_mats = read_qb(parts["base"])
    cells, size, base_pos = _merge(base_mats)
    if not cells:
        raise QbError("That .qb has no visible voxels.")

    maps: dict[str, dict] = {}
    for key in ("a", "s", "t"):
        if key in parts:
            m_cells, m_size, _ = _merge(read_qb(parts[key]))
            if m_size != size:
                raise QbError(
                    f"The {key.upper()} map is {m_size[0]}x{m_size[1]}x{m_size[2]} but the "
                    f"model is {size[0]}x{size[1]}x{size[2]}. Material maps have to match "
                    f"the model exactly.")
            maps[key] = m_cells

    # The attachment point: a magenta voxel, or failing that a negative matrix offset.
    attach = next((c for c, rgb in cells.items() if rgb == ATTACHMENT_RGB), None)
    from_marker = attach is not None
    if attach is None and len(base_mats) == 1:
        dx, dy, dz = base_pos
        if (dx <= 0 and dy <= 0 and dz <= 0 and (dx or dy or dz)
                and -dx < size[0] and -dy < size[1] and -dz < size[2]):
            attach = (-dx, -dy, -dz)

    # The marker cell: keep it or drop it?
    #
    # In a .qb the attachment point is a magenta voxel, and on a weapon the modder puts
    # it inside the handle - so the marker sits ON a cell the model needs. Dropping it
    # would punch a hole through the grip. On a hat or mask it floats below or behind
    # the model and is nothing but a marker, so dropping it is right.
    #
    # Face-connectivity is exactly that distinction, and the game agrees: across 263
    # real weapons whose attachment cell is filled, 98.5% carry a material identical to
    # a face neighbour - i.e. Trove fills the marker cell from the surrounding handle.
    # This does the same, and says so in the summary rather than pretending it knew.
    filled_marker = None
    if attach is not None:
        nbrs = [(attach[0] + 1, attach[1], attach[2]), (attach[0] - 1, attach[1], attach[2]),
                (attach[0], attach[1] + 1, attach[2]), (attach[0], attach[1] - 1, attach[2]),
                (attach[0], attach[1], attach[2] + 1), (attach[0], attach[1], attach[2] - 1)]
        donor = next((c for c in nbrs
                      if c in cells and cells[c] != ATTACHMENT_RGB), None)
        if donor is not None:
            filled_marker = donor

    voxels = []
    unknown_alpha = unknown_type = unknown_spec = 0
    for (x, y, z), rgb in sorted(cells.items(), key=lambda kv: (kv[0][2], kv[0][1], kv[0][0])):
        src = (x, y, z)
        if rgb == ATTACHMENT_RGB:
            if src != attach or filled_marker is None:
                continue                              # a free-floating marker: not geometry
            # A connected marker keeps its cell and inherits the neighbour's colour and
            # its material, since the maps are magenta at this cell too.
            rgb = cells[filled_marker]
            src = filled_marker

        t_rgb = maps.get("t", {}).get(src)
        if t_rgb is None or t_rgb == ATTACHMENT_RGB:
            index = 0
        elif t_rgb in RGB_TO_TYPE_INDEX:
            index = RGB_TO_TYPE_INDEX[t_rgb]
        else:
            unknown_type += 1
            index = 0
        vtype = INDEX_TO_TYPE[index]

        if materials.material_class(vtype) == materials.GLASS:
            a_rgb = maps.get("a", {}).get(src)
            if a_rgb is None or a_rgb == ATTACHMENT_RGB:
                w = 0
            elif a_rgb[0] == a_rgb[1] == a_rgb[2] and a_rgb[0] in VALID_ALPHA:
                w = 0 if a_rgb[0] == 255 else max(0, min((a_rgb[0] - 16) // 32, 7))
            else:
                unknown_alpha += 1
                w = 3
        else:
            s_rgb = maps.get("s", {}).get(src)
            if s_rgb is None or s_rgb == ATTACHMENT_RGB or s_rgb == (255, 255, 255):
                w = 0                                 # the game's own default
            elif s_rgb in RGB_TO_SPECULAR:
                w = RGB_TO_SPECULAR[s_rgb]
            else:
                unknown_spec += 1
                w = 0
        voxels.append({"x": x, "y": y, "z": z,
                       "r": rgb[0], "g": rgb[1], "b": rgb[2], "w": w, "type": vtype})

    if not voxels:
        raise QbError("That .qb is only an attachment point - there's no model to compile.")

    # Tighten to the geometry, then place the origin at the attachment point. Dropping
    # the marker can leave the grid larger than the model (the hat gap), and the game
    # reads the box as the model's own extent.
    mnx = min(v["x"] for v in voxels); mxx = max(v["x"] for v in voxels)
    mny = min(v["y"] for v in voxels); mxy = max(v["y"] for v in voxels)
    mnz = min(v["z"] for v in voxels); mxz = max(v["z"] for v in voxels)
    tight = (mxx - mnx + 1, mxy - mny + 1, mxz - mnz + 1)
    # Out of Qubicle's frame and into the blueprint's - the inverse of `_qx` above.
    for v in voxels:
        v["x"] = tight[0] - 1 - (v["x"] - mnx); v["y"] -= mny; v["z"] -= mnz

    if attach is not None:
        ax = tight[0] - 1 - (attach[0] - mnx)
        ay, az = attach[1] - mny, attach[2] - mnz
        # Inverse of codec.attachment_point.
        pos = (-ax, -ay, -az)
    else:
        pos = (-(tight[0] // 2), 0, -(tight[2] // 2))

    data = codec.encode(voxels, version=version, pos=pos, size=tight,
                        entity_blob=b"\x00\x00\x00\x00")
    return data, {
        "voxels": len(voxels),
        "size": list(tight),
        "attachment": [attach[0] - mnx, attach[1] - mny, attach[2] - mnz] if attach else None,
        "attachment_source": "marker" if from_marker else ("offset" if attach else None),
        "maps": sorted(maps),
        "unknown_type": unknown_type,
        "unknown_alpha": unknown_alpha,
        "unknown_specular": unknown_spec,
    }
