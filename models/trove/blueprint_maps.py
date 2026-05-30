"""Trove voxel material maps (alpha / specular / type) <-> per-voxel (type, w).

Verified against the game's own ``copyblueprint -generatemaps`` output and the
official Trove UGC mapping guide. The ``_a``/``_s``/``_t`` QB maps are not stored
in the blueprint -- they are derived per voxel from the blueprint's ``type``
(u16) and ``w`` byte:

* Type map (``_t``) <- type category:
    Solid 255,255,255 | Glass 128,128,128 | Tiled Glass 64,64,64
    Glowing Solid 255,0,0 | Glowing Glass 255,255,0
* The ``w`` byte is overloaded by category:
    - SOLID class (Solid, Glowing Solid): ``w`` = specular index
        0 Rough(128,0,0) 1 Metal(0,128,0) 2 Water(0,0,128)
        3 Iridescent(128,128,0) 4 Waxy(128,0,128) 5 Wave(0,128,128)
      alpha map is white for solid voxels.
    - GLASS class (Glass, Tiled Glass, Glowing Glass): ``w`` = alpha level
        alpha = 16 + 32*w  -> 16,48,80,112,144,176,208,240 (8 levels)
      specular map is white for glass voxels.

Voxels of game-internal types (not part of the UGC palette) keep their measured
type-map colour and are treated as solid; their original ``(type, w)`` is always
preserved on recompile so they round-trip losslessly even if a colour view is
approximate.
"""
from __future__ import annotations

WHITE = (255, 255, 255)

# --- type category + type-map colour -------------------------------------- #
# category: "solid" -> specular from w, alpha white;  "glass" -> alpha from w, specular white
SOLID = "solid"
GLASS = "glass"

TYPE_CATEGORY = {
    21: (SOLID, (255, 255, 255)),   # Solid
    55: (SOLID, (255, 0, 0)),       # Glowing Solid
    18: (GLASS, (128, 128, 128)),   # Glass
    54: (GLASS, (64, 64, 64)),      # Tiled Glass
    56: (GLASS, (255, 255, 0)),     # Glowing Glass
}

# Measured type-map colours for game-internal (non-UGC) voxel types. Treated as
# solid for specular/alpha purposes; lossless passthrough covers any imprecision.
INTERNAL_TYPE_T = {
    1: (151, 100, 50), 2: (0, 201, 0), 3: (90, 90, 101),
    24: (255, 253, 255), 100: (0, 206, 0),
}

# --- specular palette (solid voxels), w -> RGB ---------------------------- #
SPECULAR = {
    0: (128, 0, 0),     # Rough (default)
    1: (0, 128, 0),     # Metal
    2: (0, 0, 128),     # Water
    3: (128, 128, 0),   # Iridescent
    4: (128, 0, 128),   # Waxy
    5: (0, 128, 128),   # Wave
}
SPECULAR_INV = {v: k for k, v in SPECULAR.items()}

# --- alpha ramp (glass voxels), 8 levels ---------------------------------- #
def alpha_for_w(w: int) -> tuple[int, int, int]:
    lvl = 16 + 32 * max(0, min(int(w), 7))
    return (lvl, lvl, lvl)


def w_for_alpha(rgb) -> int:
    g = int(rgb[0]) if isinstance(rgb, (tuple, list)) else int(rgb)
    return max(0, min((g - 16) // 32, 7))


# --------------------------------------------------------------------------- #
# Auto-colour (procedural / biome) voxel types  -- classification is DYNAMIC
# --------------------------------------------------------------------------- #
# Some voxel types store a black/near-black placeholder in the colour field; the
# game tints them from the voxel type at runtime (terrain, foliage, snow, ...).
# We substitute a visible colour for display but always keep the stored bytes for
# a lossless save.
#
# Only a small, fixed set of voxel types carry an *authored* colour (the stored
# RGB is the real colour, even when dark): the 5 UGC artist map categories plus
# type 24 (the placeable colour / metal block). This is a schema fact, not a
# content list -- it does not grow with new blocks. Any OTHER type that stores a
# near-black placeholder is procedural (game-tinted), so a procedural type added
# by a future update is auto-detected with no list to maintain. (A new *authored*
# bright type also works: bright voxels are never near-black, so never substituted.)
AUTHORED_COLOUR_TYPES = frozenset({21, 18, 54, 55, 56, 24})


def is_near_black(rgb) -> bool:
    return max(int(rgb[0]), int(rgb[1]), int(rgb[2])) <= 24


def is_auto_color(vtype: int, stored_rgb) -> bool:
    """True when a voxel's stored colour is a procedural placeholder, not real:
    a near-black colour on a type that isn't an authored-colour block."""
    return int(vtype) not in AUTHORED_COLOUR_TYPES and is_near_black(stored_rgb)


# Optional display hints: captured procedural tints (from -generatemaps) so e.g.
# snow shows white rather than a neutral grey. Not authoritative and NOT required
# for correctness (lossless save is independent of these). The true source is
# biome data; this is only a viewing nicety and may be extended/removed freely.
AUTO_COLOR_TINT_HINTS = {
    1: (150, 130, 100), 2: (40, 170, 0), 3: (120, 120, 120),
    4: (110, 78, 165), 79: (185, 194, 197), 100: (220, 222, 225), 174: (232, 33, 70),
}
AUTO_COLOR_FALLBACK = (110, 110, 110)   # neutral grey for procedural voxels w/o a hint


def display_base_color(vtype: int, stored_rgb):
    """Colour to SHOW for the base layer: a visible tint for procedural voxels
    (so they aren't black), the real stored colour for authored voxels."""
    if is_auto_color(vtype, stored_rgb):
        return AUTO_COLOR_TINT_HINTS.get(int(vtype), AUTO_COLOR_FALLBACK)
    return tuple(stored_rgb)


def type_category(vtype: int) -> str:
    cat = TYPE_CATEGORY.get(int(vtype))
    return cat[0] if cat else SOLID


def typemap_color(vtype: int) -> tuple[int, int, int]:
    cat = TYPE_CATEGORY.get(int(vtype))
    if cat:
        return cat[1]
    return INTERNAL_TYPE_T.get(int(vtype), WHITE)


# --- forward: (type, w) -> (alpha_rgb, specular_rgb, typemap_rgb) --------- #
def maps_from_type_w(vtype: int, w: int):
    cat = type_category(vtype)
    t_rgb = typemap_color(vtype)
    if cat == GLASS:
        return alpha_for_w(w), WHITE, t_rgb            # alpha varies, specular white
    return WHITE, SPECULAR.get(int(w), (128, 0, 0)), t_rgb  # specular varies, alpha white


# --- inverse: (alpha_rgb, specular_rgb, typemap_rgb) -> (type, w) --------- #
_TYPE_BY_TCOLOR = {}
for _t, (_cat, _rgb) in TYPE_CATEGORY.items():
    _TYPE_BY_TCOLOR[_rgb] = _t
for _t, _rgb in INTERNAL_TYPE_T.items():
    _TYPE_BY_TCOLOR.setdefault(_rgb, _t)


def type_w_from_maps(alpha_rgb, specular_rgb, typemap_rgb, *, fallback_type=21, fallback_w=0):
    t = _TYPE_BY_TCOLOR.get(tuple(typemap_rgb), fallback_type)
    if type_category(t) == GLASS:
        w = w_for_alpha(alpha_rgb)
    else:
        w = SPECULAR_INV.get(tuple(specular_rgb), fallback_w)
    return t, w


# --------------------------------------------------------------------------- #
# Named presets for the strict map layers (so the UI can offer "Metal" etc.
# instead of requiring the user to know the exact RGB). All values come straight
# from the verified palettes above -- nothing hardcoded beyond the RE'd tables.
# --------------------------------------------------------------------------- #
_TYPE_PRESETS = [
    ("Solid", 21, (255, 255, 255), "Opaque solid voxel (default)."),
    ("Glass", 18, (128, 128, 128), "Transparent glass (alpha set by the Alpha map)."),
    ("Tiled Glass", 54, (64, 64, 64), "Tiled/leaded glass (alpha from Alpha map)."),
    ("Glowing Solid", 55, (255, 0, 0), "Emissive solid voxel."),
    ("Glowing Glass", 56, (255, 255, 0), "Emissive transparent glass."),
]


def material_presets() -> dict:
    """Named, clickable options for each strict map layer.

    Returns ``{layer: [{label, rgb, type?/w?, category, description}]}`` for the
    ``type`` (_t), ``specular`` (_s) and ``alpha`` (_a) layers. ``rgb`` is the
    exact colour to paint into that layer; ``type``/``w`` give the resulting voxel
    attribute so callers can show what a click means.
    """
    type_opts = [
        {"label": lbl, "rgb": list(rgb), "type": t,
         "category": type_category(t), "description": desc}
        for (lbl, t, rgb, desc) in _TYPE_PRESETS
    ]
    spec_labels = {0: "Rough", 1: "Metal", 2: "Water",
                   3: "Iridescent", 4: "Waxy", 5: "Wave"}
    spec_opts = [
        {"label": spec_labels[w], "rgb": list(SPECULAR[w]), "w": w,
         "category": SOLID,
         "description": f"Specular finish '{spec_labels[w]}' (solid voxels)."
                        + (" Default." if w == 0 else "")}
        for w in sorted(SPECULAR)
    ]
    alpha_opts = []
    for w in range(8):
        lvl = 16 + 32 * w
        alpha_opts.append({
            "label": f"{round(lvl / 255 * 100)}% ({lvl})",
            "rgb": list(alpha_for_w(w)), "w": w, "category": GLASS,
            "description": f"Glass opacity level {w + 1}/8 (alpha {lvl}).",
        })
    return {"type": type_opts, "specular": spec_opts, "alpha": alpha_opts}
