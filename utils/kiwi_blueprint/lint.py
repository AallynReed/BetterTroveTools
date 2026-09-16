"""Trove Creations checks for a ``.blueprint``.

A port of Troxel's ``TroveCreationsLint`` (chrmoritz/Troxel), which encodes the
Trove Creations submission guidelines - the rules a model has to satisfy before the
game will hold it the right way round and the subreddit will accept it. Troxel checks
authored ``.qb`` files; this checks the compiled blueprint, which changes three things:

* **The attachment point isn't a voxel any more.** In a ``.qb`` it's a magenta
  (255, 0, 255) voxel with the sentinel material ``t=7, s=7, a=250``. The compiler
  consumes it: not one of the 72,584 blueprints in the live catalogue contains a
  magenta voxel. It survives as the model's ORIGIN instead - see
  ``codec.attachment_point`` - so "exactly one attachment point" can't be violated
  here, and the position checks work off the origin.
* **Two of Troxel's rules cannot fail.** "Alpha on a solid voxel" and "specular on a
  non-solid voxel" describe a ``.qb`` carrying three independent material maps that
  can disagree. A blueprint stores one ``(type, w)`` pair where ``w`` *is* the
  specular index on a solid and *is* the opacity on glass, so the contradiction has
  nowhere to live. Reported as satisfied rather than silently dropped.
* **"Too dark" skips procedural voxels.** Terrain and friends legitimately store
  near-black - the game tints them at runtime - so flagging them would be noise.

Sizes below are in the blueprint's own frame. Troxel's bounding box includes the
attachment voxel and the gap beneath a hat/mask, so its published limits read
``20x14x20`` for a hat "but yours is x, y-6, z"; that ``y-6`` is exactly our ``sy``,
and the x/z limits carry over unchanged.
"""
from __future__ import annotations

from collections import deque

from utils.kiwi_blueprint import codec, materials

# label -> (max_x, max_y, max_z) in the blueprint's own frame.
DIMENSIONS = {
    "melee": (10, 10, 35),
    "gun": (5, 12, 5),
    "staff": (12, 12, 35),
    "bow": (3, 9, 21),
    "fist": (6, 9, 5),
    "spear": (11, 11, 45),
    "mask": (10, 10, 5),
    "hat": (20, 14, 20),
    "hair": (20, 14, 20),
    "deco": (12, 12, 12),
}

# Types that must carry an attachment point (Troxel skips deco, lairs and dungeons).
NEEDS_ATTACHMENT = frozenset({"melee", "gun", "staff", "bow", "spear", "fist", "mask", "hat", "hair"})

CREATION_TYPES = (*DIMENSIONS, "other")

_GUIDE = "https://trovesaurus.com/wiki"


def _finding(level, title, body, voxels=None):
    return {"level": level, "title": title, "body": body, "voxels": voxels or []}


# --------------------------------------------------------------------------- #
# individual checks
# --------------------------------------------------------------------------- #
def _check_dimensions(kind: str, size: tuple[int, int, int]) -> list[dict]:
    limit = DIMENSIONS.get(kind)
    if not limit:
        return []
    sx, sy, sz = size
    lx, ly, lz = limit
    if sx <= lx and sy <= ly and sz <= lz:
        return []

    # Troxel's trick: if the model WOULD fit with two axes swapped, the problem is
    # orientation, not size - and saying so is far more useful than "too big",
    # because the fix is a rotation rather than a rebuild.
    rotations = [(sx, sz, sy), (sy, sx, sz), (sy, sz, sx), (sz, sx, sy), (sz, sy, sx)]
    if any(a <= lx and b <= ly and c <= lz for a, b, c in rotations):
        return [_finding(
            "error", "The model is facing the wrong way",
            f"A {kind} should fit within {lx}x{ly}x{lz}, and yours ({sx}x{sy}x{sz}) would "
            f"if it were turned. Use the rotate buttons under 'Turn it' - weapons point "
            f"forward along the long axis, hats point up.")]
    return [_finding(
        "error", "The model is too big",
        f"A {kind} should not exceed {lx}x{ly}x{lz} voxels, but yours is {sx}x{sy}x{sz}.")]


def _check_spear_length(kind: str, size: tuple[int, int, int]) -> list[dict]:
    if kind == "spear" and size[2] != 45:
        return [_finding(
            "error", "A spear has to be exactly 45 voxels long",
            f"Yours is {size[2]}. The game positions the shaft assuming that length.")]
    return []


def _check_bow_thickness(kind: str, size: tuple[int, int, int]) -> list[dict]:
    if kind == "bow" and 3 < size[0] <= 5:
        return [_finding(
            "warning", "This bow is thicker than the guidelines allow",
            f"A bow should be at most 3 voxels thick; yours is {size[0]}. Up to 5 is "
            f"sometimes accepted if the design really needs it.")]
    return []


def _check_dark_voxels(payload_voxels) -> list[dict]:
    """Trove's style guide bans near-black voxels: they read as holes in game.

    Troxel's threshold is ``min + max < 20``. Procedural voxels are skipped - their
    stored colour is a placeholder the game overwrites, so it is not the author's."""
    hits = [
        i for i, v in enumerate(payload_voxels)
        if not materials.is_procedural(v["type"], v["r"], v["g"], v["b"])
        and min(v["r"], v["g"], v["b"]) + max(v["r"], v["g"], v["b"]) < 20
    ]
    if not hits:
        return []
    return [_finding(
        "error", f"{len(hits):,} voxel{'s are' if len(hits) != 1 else ' is'} almost black",
        "Trove's style guide asks for nothing darker than (10, 10, 10) - pure black "
        "reads as a hole in game. Use a dark grey instead.", hits)]


def _check_floating(payload_voxels) -> list[dict]:
    """Every voxel should be face-connected to the rest of the model.

    Corner-touching doesn't count, which is the point: a corner-connected voxel looks
    attached in an editor and falls apart in game. This is cleaner than Troxel's
    version, which had to special-case the attachment voxel as legitimately floating -
    in a blueprint the attachment point isn't a voxel, so nothing is exempt."""
    if not payload_voxels:
        return []
    cells = {(v["x"], v["y"], v["z"]): i for i, v in enumerate(payload_voxels)}
    seen = set()
    start = next(iter(cells))
    queue = deque([start])
    seen.add(start)
    while queue:
        x, y, z = queue.popleft()
        for n in ((x + 1, y, z), (x - 1, y, z), (x, y + 1, z),
                  (x, y - 1, z), (x, y, z + 1), (x, y, z - 1)):
            if n in cells and n not in seen:
                seen.add(n)
                queue.append(n)
    stray = [i for cell, i in cells.items() if cell not in seen]
    if not stray:
        return []
    return [_finding(
        "warning", f"{len(stray):,} voxel{'s are' if len(stray) != 1 else ' is'} not connected to the model",
        "These only touch the rest of the model at a corner, or not at all. Trove "
        "renders them, but the style guide asks for face-connected geometry.", stray)]


def _check_materials_used(payload_voxels) -> list[dict]:
    if any(v["type"] != 21 or v["w"] != 0 for v in payload_voxels):
        return []
    return [_finding(
        "info", "No materials are used",
        "Every voxel is a plain rough solid. Glass, glowing and the metal/waxy/"
        "iridescent finishes are what give a model depth in game - worth trying "
        "where they suit the design.")]


def _check_attachment(kind: str, attach, size, cells) -> list[dict]:
    """Position rules for the attachment point, per creation type.

    ``attach`` is in the same frame as the voxels, and for a hat or a mask it sits
    OUTSIDE the model - below it or behind it - which is correct and expected."""
    out: list[dict] = []
    if attach is None:
        if kind in NEEDS_ATTACHMENT:
            out.append(_finding(
                "warning", "This model stores no attachment point",
                "Older blueprints (format v3/v4) don't record an origin, so there's "
                "nothing to check and nothing to show. The game positions these by "
                "other means."))
        return out

    ax, ay, az = attach
    sx, sy, sz = size

    if kind in ("melee", "staff", "bow", "spear", "gun", "fist"):
        if (ax, ay, az) not in cells:
            out.append(_finding(
                "warning", "The attachment point isn't on a voxel",
                f"The hand grips ({ax}, {ay}, {az}), but there's no voxel there. On a "
                f"weapon the attachment point should sit inside the handle."))

    if kind in ("melee", "staff", "bow"):
        limit = 3 if kind == "bow" else 4
        if ay > limit or sy - ay > 6:
            out.append(_finding(
                "warning", "The handle sits too high or too low",
                f"There shouldn't be more than 5 voxels above or {limit} below the "
                f"attachment point; yours has {sy - ay - 1} above and {ay} below."))
        blocked = [cells[c] for c in cells
                   if abs(c[0] - ax) <= 1 and abs(c[1] - ay) <= 1 and abs(c[2] - az) <= 1
                   and not (c[0] == ax and c[1] == ay)]
        if blocked:
            out.append(_finding(
                "warning", "The grip is crowded",
                "Around the attachment point there should be nothing in a 3x3x3 cube "
                "except the handle running lengthwise - that space is the hand.", blocked))

    if kind == "staff":
        if not 8 <= az <= 14:
            out.append(_finding(
                "warning", "The staff handle is the wrong length",
                f"The handle behind the attachment point should be 8-14 voxels; yours is {az}."))
        if sz - az < 17:
            out.append(_finding(
                "warning", "The staff head is too close to the grip",
                f"There should be at least 16 voxels between the attachment point and "
                f"the tip; yours has {sz - az - 1}."))

    if kind == "spear" and not 8 <= az <= 12:
        out.append(_finding(
            "warning", "The spear grip is in the wrong place",
            f"The attachment point should be 9-13 voxels from the base of the shaft; "
            f"yours is {az + 1}."))

    if kind == "gun" and az != 0:
        out.append(_finding(
            "warning", "There's geometry behind the grip",
            f"A gun's attachment point should sit at the back of the model (z = 0); "
            f"yours is at z = {az}."))

    # A hat hangs above its attachment point and a mask sits in front of one; the gap
    # is how the game seats them on the head.
    if kind in ("hat", "hair"):
        if ay > -6:
            out.append(_finding(
                "error", "The model isn't high enough above its attachment point",
                f"The attachment point should be at least 6 voxels below the model "
                f"(the head fills that space); yours is {-ay if ay < 0 else 0}."))
        if ax > 10 or sx - ax > 10 or az > 9 or sz - az > 11:
            out.append(_finding(
                "warning", "The model is off-centre over the head",
                f"There shouldn't be more than ~10 voxels to any side of the attachment "
                f"point; yours reaches {ax} right, {sx - ax - 1} left, {az} back, "
                f"{sz - az - 1} front."))

    if kind == "mask":
        if az > -6:
            out.append(_finding(
                "error", "The mask isn't far enough in front of its attachment point",
                f"The attachment point should be 6 voxels behind the mask (that space "
                f"is the head); yours is {-az if az < 0 else 0}."))
        if ax > 5 or sx - ax > 5 or ay > 4 or sy - ay > 6:
            out.append(_finding(
                "warning", "The mask is off-centre on the face",
                f"There shouldn't be more than ~5 voxels to any side of the attachment "
                f"point; yours reaches {ax} right, {sx - ax - 1} left, {sy - ay - 1} up, "
                f"{ay} down."))
    return out


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #
def check(decoded: codec.DecodedBlueprint, kind: str = "other") -> dict:
    """Run every applicable check. ``kind`` is one of :data:`CREATION_TYPES`.

    Returns ``{findings, satisfied, attachment, kind}``. ``findings`` carry voxel
    indices where a rule can point at the offenders, so the editor can highlight them.
    CPU-bound - call via ``asyncio.to_thread``."""
    kind = kind if kind in CREATION_TYPES else "other"
    voxels = decoded.voxels
    size = decoded.size
    attach = codec.attachment_point(decoded)
    cells = {(v["x"], v["y"], v["z"]): i for i, v in enumerate(voxels)}

    findings: list[dict] = []
    findings += _check_dimensions(kind, size)
    findings += _check_spear_length(kind, size)
    findings += _check_bow_thickness(kind, size)
    findings += _check_dark_voxels(voxels)
    if kind not in ("deco",):
        findings += _check_floating(voxels)
    findings += _check_materials_used(voxels)
    if kind != "other":
        findings += _check_attachment(kind, attach, size, cells)

    order = {"error": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda f: order[f["level"]])

    # Say what PASSED too, not just what failed - a checker that only ever speaks up
    # to complain leaves you unsure whether it looked.
    satisfied = [
        "A blueprint stores one material per voxel, so alpha-on-solid and "
        "specular-on-glass - two of the classic .qb mistakes - can't happen here.",
    ]
    if not any(f["title"].endswith("almost black") for f in findings):
        satisfied.append("No near-black voxels.")
    if kind in NEEDS_ATTACHMENT and attach is not None:
        satisfied.append(f"Attachment point recorded at ({attach[0]}, {attach[1]}, {attach[2]}).")

    return {
        "kind": kind,
        "attachment": list(attach) if attach else None,
        "findings": findings,
        "satisfied": satisfied,
        "counts": {
            "error": sum(1 for f in findings if f["level"] == "error"),
            "warning": sum(1 for f in findings if f["level"] == "warning"),
            "info": sum(1 for f in findings if f["level"] == "info"),
        },
    }
