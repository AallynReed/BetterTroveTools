"""The material half of KiwiAPI's ``app/trove/render/voxel.py`` - no rasterizer, so no numpy."""
from __future__ import annotations

from utils.kiwi_blueprint import codec as _codec

MAGIC = _codec.MAGIC
BlueprintError = _codec.BlueprintError
decode = _codec.decode
is_empty_blueprint = _codec.is_empty_blueprint
_uleb = _codec.read_uleb128
_svar = _codec.read_svarint

_TINTS = {1: (150, 130, 100), 2: (40, 170, 0), 3: (120, 120, 120), 4: (110, 78, 165),
          79: (185, 194, 197), 100: (220, 222, 225), 174: (232, 33, 70)}
_AUTHORED = {21, 18, 54, 55, 56, 24}

SPEC_NAMES = {0: "rough", 1: "metal", 2: "water", 3: "iridescent", 4: "waxy"}
KIND_CODE = {"S": 0, "G": 1, "E": 2, "GE": 3}


def _kind(t: int) -> str:
    if t == 55:
        return "E"
    if t == 56:
        return "GE"
    if t in (18, 54):
        return "G"
    return "S"


def material_for(r: int, g: int, b: int, w: int, t: int) -> tuple[int, int, int, str, int, int]:
    """A voxel's material: ``(r, g, b, kind, level, spec)``."""
    if t not in _AUTHORED and max(r, g, b) <= 24:
        r, g, b = _TINTS.get(t, (110, 110, 110))
    kind = _kind(t)
    glassy = kind in ("G", "GE")
    level = 16 + 32 * max(0, min(int(w), 7)) if glassy else 255
    return r, g, b, kind, level, (0 if kind != "S" else max(0, min(int(w), 7)))
