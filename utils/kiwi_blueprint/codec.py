"""Native Trove ``.blueprint`` (kiwib) codec -- decode AND encode.

The read side is the same format the catalog renderer has always spoken; what is new
here is ``encode``, which writes a blueprint the game reads back natively. That is the
whole reason the editor can exist: every previous tool had to round-trip through the
game's own QB exporter.

Format (all versions open ``b"kiwib"`` + ``u32 version``)::

    v3 / v4 -- uncompressed:
        uleb128 count
        count x:  svarint x, svarint y, svarint z, u16 type, u8 B, u8 G, u8 R, u8 w
        entity section (v4 only, kept verbatim)

    v5 -- the body after the 9-byte header is a raw zlib stream:
        i32 pos_x, pos_y, pos_z      # blueprint origin (world space)
        i32 size_x, size_y, size_z   # bounding box
        i32 count, i32 start         # voxel count, linear index of the first voxel
        i32 deltas[count-1]          # gaps between consecutive voxel indices
        u16 types[count]
        u32 colors[count]            # bytes [B, G, R, w]
        entity section (u32 count + records)

Geometry (v5): linear index ``L`` -> ``y = L // (sx*sz)``, ``z = (L % (sx*sz)) // sx``,
``x = L % sx``, and all three axes are decoded as the format stores them. There is no
mirror here: X used to be flipped into *Qubicle* convention on both sides, which made
every 3D preview draw blueprints as their own mirror image (the model viewer, fed by
``mods_hub/assembly.py``, never flipped and was the one drawing them right). The flip
belongs at the ``.qb`` boundary, which is the only place Qubicle's frame is the
question -- see ``qb.py``. v3/v4 store explicit signed coordinates, decoded the same way.

``type`` (u16) and ``w`` (u8) are the per-voxel material attributes. They are carried
through decode/edit/encode untouched unless the caller changes them explicitly, so a
save can never silently downgrade a voxel the editor did not understand.

Ported from the BetterTroveTools implementation, which was reverse-engineered from
``Trove_x64.exe -tool copyblueprint`` and validated against the live game catalogue.
``tests/test_blueprint_codec.py`` re-checks the round trip against real game files.
"""
from __future__ import annotations

import struct
import zlib

MAGIC = b"kiwib"
DEFAULT_TYPE = 0x15          # 21 -- standard solid voxel
DEFAULT_W = 0
SUPPORTED_VERSIONS = (3, 4, 5)


class BlueprintError(ValueError):
    """Raised when bytes are not a decodable kiwib blueprint."""


# --------------------------------------------------------------------------- #
# varints
# --------------------------------------------------------------------------- #
def read_uleb128(data: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        if pos >= len(data):
            raise BlueprintError("Truncated LEB128 value.")
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result & 0xFFFFFFFF, pos
        shift += 7
        if shift >= 64:
            raise BlueprintError("LEB128 value too large.")


def write_uleb128(value: int) -> bytes:
    out = bytearray()
    value &= 0xFFFFFFFF
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def read_svarint(data: bytes, pos: int) -> tuple[int, int]:
    """v3/v4 coordinates: zigzag-decoded unsigned LEB128."""
    raw, pos = read_uleb128(data, pos)
    return (raw >> 1) ^ -(raw & 1), pos


def write_svarint(value: int) -> bytes:
    return write_uleb128(((value << 1) ^ (value >> 31)) & 0xFFFFFFFF)


# --------------------------------------------------------------------------- #
# version / payload
# --------------------------------------------------------------------------- #
def blueprint_version(data: bytes) -> int | None:
    if len(data) < 9 or data[:5] != MAGIC:
        return None
    return struct.unpack_from("<I", data, 5)[0]


def inflate_v5(data: bytes) -> bytes:
    """Inflate a v5 body. ``decompressobj`` + ``flush`` rather than ``zlib.decompress``:
    a few catalogue files carry trailing bytes past the stream, and the one-shot call
    treats those as a truncation error."""
    try:
        d = zlib.decompressobj()
        return d.decompress(data[9:]) + d.flush()
    except zlib.error as exc:
        raise BlueprintError(f"Failed to inflate v5 blueprint: {exc}") from exc


def is_empty_blueprint(data: bytes) -> bool:
    """True for placeholder blueprints with no voxels, and for anything undecodable --
    i.e. nothing a viewer could show. Cheap: reads the count, not the model."""
    version = blueprint_version(data)
    if version is None:
        return True
    if version in (3, 4):
        try:
            count, _ = read_uleb128(data, 9)
        except BlueprintError:
            return True
        return count == 0
    if version == 5:
        try:
            body = inflate_v5(data)
        except BlueprintError:
            return True
        if len(body) < 28:
            return True
        return struct.unpack_from("<i", body, 24)[0] <= 0
    return True


# --------------------------------------------------------------------------- #
# decode
# --------------------------------------------------------------------------- #
class DecodedBlueprint:
    """A decoded blueprint in Qubicle-convention (X-mirrored, 0-based) coordinates.

    ``voxels`` are dicts ``{x, y, z, r, g, b, w, type}`` **in file order**, which the
    encoder preserves so a v3/v4 save is byte-identical to what was opened.
    ``offset`` carries the signed min corner v3/v4 stored, so those exact coordinates
    can be restored on encode.
    """

    __slots__ = ("version", "size", "pos", "voxels", "entity_blob", "offset")

    def __init__(self, version, size, pos, voxels, entity_blob, offset=(0, 0, 0)):
        self.version = version
        self.size = size
        self.pos = pos
        self.voxels = voxels
        self.entity_blob = entity_blob
        self.offset = offset


def _decode_v34(data: bytes, version: int) -> DecodedBlueprint:
    count, pos = read_uleb128(data, 9)
    raw = []
    for _ in range(count):
        x, pos = read_svarint(data, pos)
        y, pos = read_svarint(data, pos)
        z, pos = read_svarint(data, pos)
        if pos + 6 > len(data):
            raise BlueprintError("v3/v4 voxel record is truncated.")
        vtype = struct.unpack_from("<H", data, pos)[0]
        b, g, r, w = data[pos + 2], data[pos + 3], data[pos + 4], data[pos + 5]
        pos += 6
        raw.append((x, y, z, r, g, b, w, vtype))
    if not raw:
        raise BlueprintError("Blueprint contains no voxels (empty placeholder).")
    # The version-4 entity section (and anything else past the voxel table) is kept
    # verbatim so it round-trips untouched.
    entity_blob = data[pos:]

    mnx = min(v[0] for v in raw); mxx = max(v[0] for v in raw)
    mny = min(v[1] for v in raw); mxy = max(v[1] for v in raw)
    mnz = min(v[2] for v in raw); mxz = max(v[2] for v in raw)
    size = (mxx - mnx + 1, mxy - mny + 1, mxz - mnz + 1)
    voxels = [
        {"x": x - mnx, "y": y - mny, "z": z - mnz,
         "r": r, "g": g, "b": b, "w": w, "type": vtype}
        for (x, y, z, r, g, b, w, vtype) in raw
    ]
    # v3/v4 store no origin; Trove centres the bounding box.
    origin = (-(size[0] // 2), -(size[1] // 2), -(size[2] // 2))
    return DecodedBlueprint(version, size, origin, voxels, entity_blob,
                            offset=(mnx, mny, mnz))


def _decode_v5(data: bytes) -> DecodedBlueprint:
    body = inflate_v5(data)
    if len(body) < 32:
        raise BlueprintError("v5 blueprint payload is too small.")
    px, py, pz, sx, sy, sz, count, start = struct.unpack_from("<8i", body, 0)
    if count <= 0 or sx <= 0 or sy <= 0 or sz <= 0:
        raise BlueprintError("v5 blueprint is empty or has invalid bounds.")
    off = 32
    deltas = struct.unpack_from(f"<{count - 1}i", body, off) if count > 1 else ()
    off += 4 * (count - 1)
    types = struct.unpack_from(f"<{count}H", body, off)
    off += 2 * count
    colors = struct.unpack_from(f"<{count}I", body, off)
    off += 4 * count
    if off > len(body):
        raise BlueprintError("v5 blueprint payload is truncated.")
    entity_blob = body[off:]

    plane = sx * sz
    indices = [start]
    for d in deltas:
        indices.append(indices[-1] + d)

    voxels = []
    for L, vtype, color in zip(indices, types, colors, strict=False):
        y = L // plane
        rem = L % plane
        voxels.append({
            "x": rem % sx, "y": y, "z": rem // sx,
            "r": (color >> 16) & 0xFF, "g": (color >> 8) & 0xFF, "b": color & 0xFF,
            "w": (color >> 24) & 0xFF, "type": vtype,
        })
    return DecodedBlueprint(5, (sx, sy, sz), (px, py, pz), voxels, entity_blob)


def decode_full(data: bytes) -> DecodedBlueprint:
    """Decode to a ``DecodedBlueprint`` (voxels **plus** size, origin and entity blob).

    Use this whenever the result will be re-encoded; ``decode`` keeps only the voxels,
    which is enough to draw a model but not to save one back losslessly."""
    version = blueprint_version(data)
    if version is None:
        raise BlueprintError("Not a Trove blueprint (missing 'kiwib' magic).")
    if version in (3, 4):
        return _decode_v34(data, version)
    if version == 5:
        return _decode_v5(data)
    raise BlueprintError(f"Unsupported kiwib blueprint version: {version}.")


def decode(data: bytes) -> list[dict]:
    """Decode to just the voxel list -- what the renderers and 3D viewers consume."""
    return decode_full(data).voxels


def attachment_point(decoded: DecodedBlueprint) -> tuple[int, int, int] | None:
    """Where the model attaches to a hand or a head, in the decoded voxel frame.

    A modder marks this in the authored ``.qb`` as a magenta (255, 0, 255) voxel with
    the sentinel material ``t=7, s=7, a=250``. The compiler consumes it -- not one of
    the 72,584 blueprints in the live catalogue contains a magenta voxel -- and keeps
    it as the model's ORIGIN: the v5 header's ``pos`` says where world-zero sits, and
    Trove seats a wearable or a weapon by putting its attachment point there. So
    world-zero *is* the attachment point, and recovering it is arithmetic:

        blueprint-local  x = -pos_x, y = -pos_y, z = -pos_z
                         (world = pos + local, as the assembled-creature pipeline
                          places its parts -- the same frame this decoder emits)

    Verified three ways against the live catalogue: it agrees with the origin
    convention ``mods_hub/assembly.py`` already places creature parts by; it satisfies
    Troxel's published Trove Creations rules on 86-98% of real items per category
    (the rest bend guidelines that are documented as bendable); and on weapons -- where
    the point must land inside the handle -- it hits a filled voxel 94.8% of the time,
    against 1.6% and 0.8% for the y-1 and y+1 variants.

    ``None`` for v3/v4, which store no origin at all. Those get no guess: the decoder
    synthesises a centred origin so the model has somewhere to sit, and reporting that
    back as an attachment point would be inventing data.

    For a hat or a mask the result lies OUTSIDE the bounding box -- below or behind the
    model -- because the gap is where the head goes. That is correct, not an error.
    """
    if decoded.version != 5:
        return None
    sx, _, _ = decoded.size
    px, py, pz = decoded.pos
    return (-px, -py, -pz)


# --------------------------------------------------------------------------- #
# entity section
# --------------------------------------------------------------------------- #
_PATH_PREFIXES = ("placeable/", "item", "collections/", "prefabs/", "blueprints/")
PLACEHOLDER_TYPE = 39   # deco placeholder -- an entity fills this cell at runtime


def _extract_sub_paths(sub: bytes) -> list[str]:
    """Every length-prefixed prefab path in an entity sub-message: a marker byte, a
    uleb128 string length, that many ASCII bytes, a 0x1e terminator."""
    paths = []
    j = 0
    n = len(sub)
    while j < n - 1:
        try:
            ln, k = read_uleb128(sub, j + 1)
        except BlueprintError:
            j += 1
            continue
        if 3 <= ln <= 200 and k + ln <= n:
            chunk = sub[k:k + ln]
            if all(32 <= c < 127 for c in chunk):
                text = chunk.decode("ascii")
                if text.startswith(_PATH_PREFIXES):
                    paths.append(text)
                    j = k + ln
                    continue
        j += 1
    return paths


def read_entity_records(blob: bytes) -> tuple[list[tuple[int, int, int, bytes]], bytes] | None:
    """``([(x, y, z, sub_message)], trailing_bytes)``, or ``None`` if the section can't
    be read exactly.

    The low-level form of the entity section, for the callers that need to REWRITE it -
    moving a model moves its placed objects, and merging two models has to concatenate
    both lists. The sub-message is opaque: it holds the prefab path and whatever else
    the engine wrote, and only the coordinates in front of it are ours to touch."""
    if len(blob) < 4:
        return [], b""
    count = struct.unpack_from("<I", blob, 0)[0]
    records: list[tuple[int, int, int, bytes]] = []
    i = 4
    try:
        for _ in range(count):
            x, i = read_svarint(blob, i)
            y, i = read_svarint(blob, i)
            z, i = read_svarint(blob, i)
            sublen, i = read_uleb128(blob, i)
            if i + sublen > len(blob):
                return None
            records.append((x, y, z, blob[i:i + sublen]))
            i += sublen
    except BlueprintError:
        return None
    return records, blob[i:]


def write_entity_records(records, tail: bytes = b"") -> bytes:
    """Rebuild an entity section from records produced by :func:`read_entity_records`."""
    out = bytearray(struct.pack("<I", len(records)))
    for x, y, z, sub in records:
        out += write_svarint(x)
        out += write_svarint(y)
        out += write_svarint(z)
        out += write_uleb128(len(sub))
        out += sub
    return bytes(out + tail)


def parse_entity_section(entity_blob: bytes) -> dict:
    """Decode the entity section: ``u32 count``, then per entity a zigzag-LEB128
    ``x, y, z`` (model-local, aligned with the voxel grid), a uleb128 sub-message
    length, and that sub-message.

    Read-only: the editor never rewrites this blob, it copies it through byte for byte.
    ``exact`` is False when framing desynced and only the path scan succeeded."""
    if len(entity_blob) < 4:
        return {"count": 0, "entities": [], "exact": True}
    count = struct.unpack_from("<I", entity_blob, 0)[0]
    n = len(entity_blob)
    entities: list[dict] = []
    i = 4
    exact = True
    try:
        for _ in range(count):
            x, i = read_svarint(entity_blob, i)
            y, i = read_svarint(entity_blob, i)
            z, i = read_svarint(entity_blob, i)
            sublen, i = read_uleb128(entity_blob, i)
            if sublen < 0 or i + sublen > n:
                exact = False
                break
            paths = _extract_sub_paths(entity_blob[i:i + sublen])
            i += sublen
            entities.append({"x": x, "y": y, "z": z,
                             "path": paths[0] if paths else None,
                             "paths": paths, "interactive": len(paths) > 1})
    except BlueprintError:
        exact = False
    if not exact or len(entities) != count:
        return {"count": count, "entities": [], "exact": False}
    return {"count": count, "entities": entities, "exact": True}


# --------------------------------------------------------------------------- #
# encode
# --------------------------------------------------------------------------- #
def encode(
    voxels: list[dict],
    *,
    version: int = 5,
    pos: tuple[int, int, int] | None = None,
    entity_blob: bytes = b"",
    offset: tuple[int, int, int] = (0, 0, 0),
    size: tuple[int, int, int] | None = None,
) -> bytes:
    """Encode voxels back into ``.blueprint`` bytes the game reads natively.

    ``voxels`` are in the same Qubicle-convention space ``decode`` emits; each needs
    ``x, y, z, r, g, b`` and may carry ``w`` and ``type``. Pass the ``version``, ``pos``,
    ``offset``, ``size`` and ``entity_blob`` from the ``DecodedBlueprint`` that produced
    them and the result is byte-identical to the original when nothing was edited.

    ``size`` pins the declared bounding box. Without it the box is derived from the
    voxel extent, which would shrink the model if an edit removed an edge voxel -- for
    v5 that also renumbers every linear index, so the origin would no longer line up
    with where the game expects the model to sit.
    """
    if not voxels:
        raise BlueprintError("Cannot encode a blueprint with no voxels.")
    if version not in SUPPORTED_VERSIONS:
        raise BlueprintError(f"Unsupported encode version: {version}.")

    if size is None:
        size = (max(v["x"] for v in voxels) + 1,
                max(v["y"] for v in voxels) + 1,
                max(v["z"] for v in voxels) + 1)
    sx, sy, sz = size
    if max(v["x"] for v in voxels) >= sx or max(v["y"] for v in voxels) >= sy \
            or max(v["z"] for v in voxels) >= sz \
            or min(min(v["x"], v["y"], v["z"]) for v in voxels) < 0:
        raise BlueprintError("A voxel lies outside the blueprint's bounding box.")

    if version in (3, 4):
        return _encode_v34(voxels, version, sx, entity_blob, offset)
    return _encode_v5(voxels, sx, sy, sz, pos, entity_blob or b"\x00\x00\x00\x00")


def _encode_v34(voxels, version, sx, entity_blob, offset) -> bytes:
    mnx, mny, mnz = offset
    out = bytearray(MAGIC)
    out += struct.pack("<I", version)
    out += write_uleb128(len(voxels))
    for v in voxels:
        # restore the signed, origin-centred coords (re-add the min corner)
        out += write_svarint(mnx + int(v["x"]))
        out += write_svarint(mny + int(v["y"]))
        out += write_svarint(mnz + int(v["z"]))
        out += struct.pack(
            "<HBBBB",
            int(v.get("type", DEFAULT_TYPE)) & 0xFFFF,
            int(v["b"]) & 0xFF, int(v["g"]) & 0xFF, int(v["r"]) & 0xFF,
            int(v.get("w", DEFAULT_W)) & 0xFF,
        )
    out += entity_blob
    return bytes(out)


def _encode_v5(voxels, sx, sy, sz, pos, entity_blob) -> bytes:
    if pos is None:                       # a brand-new model: centre it like the game does
        pos = (-(sx // 2), 0, -(sz // 2))
    plane = sx * sz
    cells = {}
    for v in voxels:
        # un-mirror back to blueprint-local, then linearise
        L = int(v["x"]) + int(v["z"]) * sx + int(v["y"]) * plane
        cells[L] = (int(v.get("type", DEFAULT_TYPE)) & 0xFFFF,
                    int(v["r"]) & 0xFF, int(v["g"]) & 0xFF,
                    int(v["b"]) & 0xFF, int(v.get("w", DEFAULT_W)) & 0xFF)
    order = sorted(cells)   # the format requires strictly increasing indices

    payload = bytearray(struct.pack("<8i", pos[0], pos[1], pos[2],
                                    sx, sy, sz, len(order), order[0]))
    for i in range(1, len(order)):
        payload += struct.pack("<i", order[i] - order[i - 1])
    for L in order:
        payload += struct.pack("<H", cells[L][0])
    for L in order:
        _t, r, g, b, w = cells[L]
        payload += struct.pack("<I", b | (g << 8) | (r << 16) | (w << 24))
    payload += entity_blob

    return MAGIC + struct.pack("<I", 5) + zlib.compress(bytes(payload), 9)
