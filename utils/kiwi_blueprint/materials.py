"""The voxel material model the editor edits: ``(type, w)`` directly.

Trove stores a material as two numbers per voxel -- a u16 ``type`` and a u8 ``w`` --
and the ``_t``/``_a``/``_s`` QB maps modders author against are *derived* from that
pair, not stored. Editing through those maps means going ``(type, w) -> 3 colours ->
(type, w)``, and that trip is lossy: 21 of the 55 pairs the live catalogue actually
uses do not come back the same. Two of them matter a lot -- type 39 (the deco
placeholder) collapses to plain solid, taking the build's furniture with it, and a
solid with ``w=7`` loses its ``w``. So this editor edits the pair itself and leaves the
derived maps to the export path, where a lossy conversion is the user's explicit choice.

Three classes of voxel, and the distinction is the whole point:

* **UGC palette** (``PALETTE``) -- the five types a modder can author, with ``w``
  meaning specular finish on solids and opacity on glass. Fully editable.
* **Known internal** (``INTERNAL_NAMES``) -- types the game uses that aren't in the
  UGC palette but that we can name. Shown by name, preserved verbatim.
* **Unknown** -- anything else. Shown as its raw type number, preserved verbatim, and
  never silently reinterpreted. Not knowing what a voxel is, and saying so, beats
  guessing it into a solid block.
"""
from __future__ import annotations

SOLID, GLASS = "solid", "glass"

# type -> (label, class). The five types Trove's UGC pipeline lets a modder author.
PALETTE_TYPES: dict[int, tuple[str, str]] = {
    21: ("Solid", SOLID),
    18: ("Glass", GLASS),
    54: ("Tiled Glass", GLASS),
    55: ("Glowing Solid", SOLID),
    56: ("Glowing Glass", GLASS),
}

# w on a SOLID voxel = specular finish. The index the game's shader uses to pick a
# tile out of textures/brdfmap.dds.
SPECULAR_NAMES = {
    0: "Rough", 1: "Metal", 2: "Water", 3: "Iridescent", 4: "Waxy", 5: "Wave",
}

# ...but NOT on a glowing one. A glow voxel is emissive, and the specular index is only
# read for a shaded solid (``render/voxel.material_for``: `spec = 0 if kind != "S"`, and
# a glowing solid is kind "E"). So a finish on type 55 is a number the game never looks
# at and neither does any renderer here - offering the choice was offering a control
# that could not do anything, and writing one put a value in the file that means nothing.
NO_SPECULAR_TYPES = frozenset({55})

# w on a GLASS voxel = opacity level; the alpha the game renders is 16 + 32*w.
GLASS_LEVELS = 8


def alpha_for_w(w: int) -> int:
    return 16 + 32 * max(0, min(int(w), GLASS_LEVELS - 1))


# Game-internal types we can name. Preserved on save exactly like unknown types; the
# name is only so the UI can tell the user what they are looking at.
INTERNAL_NAMES = {
    1: "Terrain (dirt)", 2: "Terrain (grass)", 3: "Terrain (stone)",
    4: "Terrain (shadow)", 24: "Placeable colour", 28: "Decorative",
    38: "Trigger", 39: "Deco placeholder", 59: "Attachment",
    79: "Terrain (ice)", 94: "Collision", 100: "Terrain (snow)",
    174: "Terrain (lava)",
}

PLACEHOLDER_TYPE = 39

# Types whose STORED colour is the real one. Every other type that stores a near-black
# value is procedurally tinted by the game at runtime, so its stored colour is a
# placeholder and repainting it would do nothing in game. Schema fact, not a content
# list: it does not grow as Trove adds blocks.
AUTHORED_COLOUR_TYPES = frozenset({21, 18, 54, 55, 56, 24})


def is_near_black(r: int, g: int, b: int) -> bool:
    return max(int(r), int(g), int(b)) <= 24


def is_procedural(vtype: int, r: int, g: int, b: int) -> bool:
    """True when the stored colour is a runtime-tinted placeholder rather than the
    voxel's real colour -- i.e. repainting this voxel would have no effect in game."""
    return int(vtype) not in AUTHORED_COLOUR_TYPES and is_near_black(r, g, b)


def material_class(vtype: int) -> str:
    """What ``w`` means for this type. Unknown types are treated as solid for display
    purposes only -- their ``w`` is still carried through untouched."""
    entry = PALETTE_TYPES.get(int(vtype))
    return entry[1] if entry else SOLID


def describe(vtype: int, w: int) -> str:
    """A human label for a ``(type, w)`` pair, for the inspector readout."""
    vtype, w = int(vtype), int(w)
    entry = PALETTE_TYPES.get(vtype)
    if entry:
        label, cls = entry
        if cls == GLASS:
            return f"{label} - {round(alpha_for_w(w) / 255 * 100)}% opacity"
        # An emissive type has no finish to name. A file that carries one anyway still
        # says so rather than being quietly tidied up in the readout.
        if vtype in NO_SPECULAR_TYPES:
            return label if w == 0 else f"{label} - unused finish {w}"
        return f"{label} - {SPECULAR_NAMES.get(w, f'finish {w}')}"
    name = INTERNAL_NAMES.get(vtype)
    return f"{name} (type {vtype})" if name else f"Unknown type {vtype}"


def is_editable(vtype: int) -> bool:
    """Whether the material palette may rewrite this voxel's ``(type, w)``.

    Only the UGC types. Everything else -- placeholders, terrain, triggers, anything
    unrecognised -- is display-and-preserve. The editor refuses rather than converting
    a voxel whose meaning it does not know."""
    return int(vtype) in PALETTE_TYPES


def _qb_hex(rgb) -> str | None:
    if rgb is None:
        return None
    r, g, b = rgb
    return f"#{r:02x}{g:02x}{b:02x}"


def palette() -> dict:
    """The editable material options, for the UI. ``w`` options depend on the class:
    a specular finish for solids, an opacity level for glass.

    Every entry also carries the colour it is written as in a ``.qb`` material map
    (``qb``, and which map it belongs to in ``qb_map``). Authoring in Qubicle a material
    IS a colour -- you paint the ``_t`` map white for solid, the ``_s`` map green for
    metal -- so a modder arriving from that workflow knows these by their swatch and not
    by our name for them. Shown, never edited: this editor writes Trove's real
    ``(type, w)``, and editing through the map colours is exactly the lossy round-trip
    this module exists to avoid.
    """
    from utils.kiwi_blueprint import qb

    def options_for(t: int, cls: str) -> list[dict]:
        if cls == GLASS:
            # Opacity rides in the _a map as a grey, and the level IS the channel value.
            return [{"w": w, "label": f"{round(alpha_for_w(w) / 255 * 100)}%",
                     "alpha": alpha_for_w(w), "qb_map": "_a",
                     "qb": _qb_hex((alpha_for_w(w),) * 3)} for w in range(GLASS_LEVELS)]
        if t in NO_SPECULAR_TYPES:
            return [{"w": 0, "label": SPECULAR_NAMES[0]}]      # emissive: no finish
        return [{"w": w, "label": name, "qb_map": "_s",
                 "qb": _qb_hex(qb.SPECULAR_MAP_RGB.get(w))}
                for w, name in sorted(SPECULAR_NAMES.items())]

    types = [
        {"type": t, "label": label, "class": cls, "options": options_for(t, cls),
         "qb_map": "_t",
         "qb": _qb_hex(qb.TYPE_MAP_RGB.get(qb.TYPE_TO_INDEX[t]))
         if t in qb.TYPE_TO_INDEX else None}
        for t, (label, cls) in PALETTE_TYPES.items()
    ]
    return {"types": types, "glass_levels": GLASS_LEVELS}


def validate_material(vtype: int, w: int) -> tuple[int, int]:
    """Clamp an incoming ``(type, w)`` to something the palette can actually express.

    Raises ``ValueError`` for a type outside the palette: a client asking to write a
    non-UGC type is either confused or malicious, and honouring it would let an edit
    fabricate voxels the editor never showed the user."""
    vtype, w = int(vtype), int(w)
    if vtype not in PALETTE_TYPES:
        raise ValueError(f"Type {vtype} is not an editable material.")
    if material_class(vtype) == GLASS:
        w = max(0, min(w, GLASS_LEVELS - 1))
    elif vtype in NO_SPECULAR_TYPES:
        w = 0                     # emissive: the finish is read by nothing (see above)
    else:
        w = max(0, min(w, max(SPECULAR_NAMES)))
    return vtype, w
