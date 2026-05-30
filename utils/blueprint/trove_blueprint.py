"""Adapter exposing the native Trove blueprint codec to the app.

The heavy lifting (the real, reverse-engineered kiwib format) lives in
``backend.trove_blueprint_codec``.  This module bridges it to the QB-document
shape the UI already renders, and adds a ``.blueprint`` save path so blueprints
can be opened, edited and written back directly -- no game QB export needed.

Public API (kept stable for the rest of the app):
    * ``BlueprintDecodeError``
    * ``blueprint_to_document(data: bytes, file_name) -> dict``
    * ``blueprint_to_package(path) -> dict``
    * ``document_to_blueprint(document) -> bytes``      (new: encode/save)
"""
from __future__ import annotations

import itertools
import subprocess
import tempfile
from pathlib import Path

from utils.blueprint.qubicle_qb import QubicleDocument, QubicleHeader, QubicleMatrix, QubicleVoxel
from utils.blueprint import trove_blueprint_codec as codec
from models.trove import blueprint_maps as maps
from utils.blueprint.trove_blueprint_codec import (
    DEFAULT_TYPE,
    DEFAULT_W,
    DecodedBlueprint,
    is_empty_blueprint,
)

# The four editable layers a blueprint exposes. "base" carries the colour and the
# round-trip metadata; the other three are the material maps the game derives
# from each voxel's (type, w).
_LAYERS = ("base", "type", "alpha", "specular")
_LAYER_LABEL = {"base": "Base", "type": "Type (_t)", "alpha": "Alpha (_a)", "specular": "Specular (_s)"}
_PLACEHOLDER_TYPE = 39  # "placeholder" voxel type -- renders cyan; filled by an entity

# Rendered-decos preview (explode build ×12 + composite decos). Temporarily OFF:
# the in-editor 2D viewport can't draw a full build live, and building the deco
# resolver on every open scans the whole blueprints catalogue. The backend render
# helpers + the .qb export endpoint stay available; this only governs whether the
# package auto-adds the rendered layer and resolves deco model names on open.
_RENDER_DECOS_ENABLED = False

# Keep the historical exception name; alias to the codec's error so that both
# ``except BlueprintDecodeError`` and codec-raised errors are caught.
BlueprintDecodeError = codec.BlueprintError


# --------------------------------------------------------------------------- #
# Decode -> QB-compatible document
# --------------------------------------------------------------------------- #
def _decoded_to_document(decoded: DecodedBlueprint, file_name: str) -> dict:
    sx, sy, sz = decoded.size
    matrix = QubicleMatrix(
        name=(Path(str(file_name or "Blueprint")).stem or "Blueprint"),
        size_x=sx,
        size_y=sy,
        size_z=sz,
        pos_x=decoded.pos[0],
        pos_y=decoded.pos[1],
        pos_z=decoded.pos[2],
        voxels=[
            QubicleVoxel(x=v["x"], y=v["y"], z=v["z"], r=v["r"], g=v["g"], b=v["b"], a=255)
            for v in decoded.voxels
        ],
    )
    matrix.validate()

    document = QubicleDocument(
        header=QubicleHeader(color_format=0, z_axis_orientation=1, compressed=True, visibility_mask_encoded=False),
        matrices=[matrix],
    )
    document.validate()

    payload = document.to_dict()
    payload["source_format"] = f"trove_blueprint_v{decoded.version}"
    payload["source_file_type"] = "blueprint"

    # Preserve per-voxel attributes (Trove voxel-type id + the high "w" byte) so
    # edits round-trip losslessly.  Keyed by mirrored Qubicle coordinates.
    attributes = {
        f"{v['x']},{v['y']},{v['z']}": [int(v["type"]), int(v["w"])]
        for v in decoded.voxels
    }
    payload["blueprint"] = {
        "version": decoded.version,
        "pos": list(decoded.pos),
        "size": list(decoded.size),
        "scale": list(decoded.scale),
        "offset": list(decoded.offset),
        "entity_blob": decoded.entity_blob.hex(),
        "entity_bytes": len(decoded.entity_blob),
        "attributes": attributes,
        "voxel_count": len(decoded.voxels),
    }
    payload["decode_info"] = {
        "version": decoded.version,
        "kind": f"trove_blueprint_v{decoded.version}_native",
        "decoded_voxel_count": len(decoded.voxels),
        "has_entities": len(decoded.entity_blob) > 4,
    }
    return payload


def blueprint_to_document(data: bytes, file_name: str = "untitled.blueprint") -> dict:
    """Decode raw ``.blueprint`` bytes into a QB-compatible document dict."""
    decoded = codec.decode(bytes(data))
    return _decoded_to_document(decoded, file_name)


# --------------------------------------------------------------------------- #
# Exact procedural tints via the game's own -generatemaps (dynamic, no tables)
# --------------------------------------------------------------------------- #
def _find_trove_exe(game_path: Path) -> Path | None:
    for name in ("Trove_x64.exe", "Trove.exe"):
        exe = game_path / name
        if exe.exists():
            return exe
    return None


def _qb_positions(qb_path: Path) -> dict:
    doc = QubicleDocument.from_bytes(qb_path.read_bytes()).to_dict()
    out = {}
    for matrix in doc.get("matrices", []):
        for vx in matrix.get("voxels", []):
            x, y, z, r, g, b, a = (list(vx) + [0] * 7)[:7]
            if int(a) > 0:
                out[(int(x), int(y), int(z))] = (int(r), int(g), int(b))
    return out


def _align(my_positions, game_positions) -> tuple | None:
    """Find (signs, translation) mapping decoded voxels onto the game's base QB
    (the -generatemaps reframes/mirrors); returns None if it can't align well."""
    gset = set(game_positions)
    if not gset or not my_positions:
        return None
    mng = (min(p[0] for p in gset), min(p[1] for p in gset), min(p[2] for p in gset))
    best = None
    for signs in itertools.product((1, -1), repeat=3):
        P = [(signs[0] * x, signs[1] * y, signs[2] * z) for (x, y, z) in my_positions]
        mnp = (min(p[0] for p in P), min(p[1] for p in P), min(p[2] for p in P))
        T = (mng[0] - mnp[0], mng[1] - mnp[1], mng[2] - mnp[2])
        ov = sum(1 for p in P if (p[0] + T[0], p[1] + T[1], p[2] + T[2]) in gset)
        if best is None or ov > best[0]:
            best = (ov, signs, T)
    if best[0] < 0.5 * len(my_positions):
        return None
    return best[1], best[2]


def exact_base_colors(data: bytes, game_path: str | Path) -> dict:
    """Return {(x,y,z): (r,g,b)} of the game's exact tinted base colour for each
    decoded voxel, by running ``copyblueprint -generatemaps`` and aligning its
    output to our decode. Empty dict if the game tool isn't available.

    Coordinates are in the editor frame (same as blueprint_to_package voxels).
    """
    game_path = Path(game_path)
    exe = _find_trove_exe(game_path)
    if exe is None:
        return {}
    try:
        decoded = codec.decode(bytes(data))
    except codec.BlueprintError:
        return {}
    my_positions = [(v["x"], v["y"], v["z"]) for v in decoded.voxels]

    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "in.blueprint"
        dst = Path(td) / "out.qb"
        src.write_bytes(bytes(data))
        try:
            subprocess.run([str(exe), "-tool", "copyblueprint", "-generatemaps", "1",
                            str(src), str(dst)],
                           cwd=str(game_path), timeout=90,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.SubprocessError, OSError):
            return {}
        if not dst.exists():
            return {}
        game = _qb_positions(dst)

    aligned = _align(my_positions, game)
    if aligned is None:
        return {}
    signs, T = aligned
    out = {}
    for (x, y, z) in my_positions:
        gp = (signs[0] * x + T[0], signs[1] * y + T[1], signs[2] * z + T[2])
        rgb = game.get(gp)
        if rgb is not None:
            out[(x, y, z)] = rgb
    return out


# --------------------------------------------------------------------------- #
# Multi-layer package: base + type/alpha/specular maps (the QBs the game derives)
# --------------------------------------------------------------------------- #
def _layer_voxel_color(layer: str, v: dict, exact_colors: dict | None = None) -> tuple[int, int, int]:
    if layer == "base":
        # The game's exact -generatemaps tint is only meaningful for procedural /
        # auto-colour voxels (which store black and are tinted at runtime). Authored
        # voxels carry their real colour already, and the base layer is also the
        # recompile source, so applying a (possibly mis-aligned) tint to an authored
        # voxel would make save lossy -- restrict the override to auto-colour voxels.
        if exact_colors is not None and maps.is_auto_color(v["type"], (v["r"], v["g"], v["b"])):
            hit = exact_colors.get((v["x"], v["y"], v["z"]))
            if hit is not None:
                return hit  # game's exact tinted colour
        # Auto-colour (procedural) voxels store black; show the native tint.
        return maps.display_base_color(v["type"], (v["r"], v["g"], v["b"]))
    alpha_rgb, spec_rgb, type_rgb = maps.maps_from_type_w(v["type"], v["w"])
    if layer == "alpha":
        return alpha_rgb
    if layer == "specular":
        return spec_rgb
    return type_rgb  # "type"


def _layer_document(layer: str, decoded: DecodedBlueprint, file_name: str,
                    exact_colors: dict | None = None) -> dict:
    sx, sy, sz = decoded.size
    name_stem = Path(str(file_name or "Blueprint")).stem or "Blueprint"
    voxels = []
    for v in decoded.voxels:
        r, g, b = _layer_voxel_color(layer, v, exact_colors)
        voxels.append(QubicleVoxel(x=v["x"], y=v["y"], z=v["z"], r=r, g=g, b=b, a=255))
    matrix = QubicleMatrix(
        name=f"{name_stem}_{layer}" if layer != "base" else name_stem,
        size_x=sx, size_y=sy, size_z=sz,
        pos_x=decoded.pos[0], pos_y=decoded.pos[1], pos_z=decoded.pos[2],
        voxels=voxels,
    )
    matrix.validate()
    document = QubicleDocument(
        header=QubicleHeader(color_format=0, z_axis_orientation=1, compressed=True, visibility_mask_encoded=False),
        matrices=[matrix],
    )
    document.validate()
    payload = document.to_dict()
    payload["source_format"] = f"trove_blueprint_v{decoded.version}"
    payload["source_file_type"] = "blueprint"
    payload["layer"] = layer
    if layer == "base":
        # Base asset carries everything needed to recompile losslessly.
        # For auto-colour voxels we also stash the original stored RGB (the
        # displayed base colour is a substituted tint), so save stays lossless.
        attributes = {}
        for v in decoded.voxels:
            key = f"{v['x']},{v['y']},{v['z']}"
            if maps.is_auto_color(v["type"], (v["r"], v["g"], v["b"])):
                attributes[key] = [int(v["type"]), int(v["w"]), int(v["r"]), int(v["g"]), int(v["b"])]
            else:
                attributes[key] = [int(v["type"]), int(v["w"])]
        payload["blueprint"] = {
            "version": decoded.version,
            "pos": list(decoded.pos),
            "size": list(decoded.size),
            "scale": list(decoded.scale),
            "offset": list(decoded.offset),
            "entity_blob": decoded.entity_blob.hex(),
            "entity_bytes": len(decoded.entity_blob),
            "attributes": attributes,
            "voxel_count": len(decoded.voxels),
        }
        payload["decode_info"] = {
            "version": decoded.version,
            "kind": f"trove_blueprint_v{decoded.version}_native",
            "decoded_voxel_count": len(decoded.voxels),
            "has_entities": len(decoded.entity_blob) > 4,
        }
    return payload


# --------------------------------------------------------------------------- #
# Entity fill compositing -- render decos onto the cyan type-39 placeholders
# --------------------------------------------------------------------------- #
def _nearest_model_voxel(grid: dict, x: int, y: int, z: int, radius: int = 2):
    """Nearest filled model voxel to (x,y,z) within a small radius, or None."""
    best = None
    for r in range(radius + 1):
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if max(abs(dx), abs(dy), abs(dz)) != r:
                        continue
                    v = grid.get((x + dx, y + dy, z + dz))
                    if v is not None:
                        return v
        if best is not None:
            break
    return None


def composite_entity_fill(decoded: DecodedBlueprint, resolver) -> dict:
    """Fill the type-39 placeholder cells with colours sampled from each entity's
    resolved deco model. Returns ``{(x, y, z): (r, g, b, type, w)}``.

    The placeholders mark *exactly* where each deco goes (the in-file footprint),
    so we assign every placeholder cell to its nearest placed entity and map that
    entity's decoded model bounding box onto the cluster, sampling the model's
    per-voxel colour + (type, w). Orientation is NOT stored in the blueprint -- the
    engine orients/instances at runtime -- so the model is *fitted* to the footprint
    rather than rotated, which keeps the rendered silhouette identical to the cyan
    placeholders while showing the real deco colours/materials.
    """
    if resolver is None:
        return {}
    placeholders = [(v["x"], v["y"], v["z"]) for v in decoded.voxels
                    if v["type"] == _PLACEHOLDER_TYPE]
    if not placeholders:
        return {}
    info = codec.parse_entity_section(decoded.entity_blob, version=decoded.version)
    ents = info.get("entities", [])
    if not ents:
        return {}

    # Decode each entity's model once (cache by path tuple).
    model_cache: dict[tuple, list | None] = {}
    ent_models: list = []
    for e in ents:
        if not e.get("path"):
            ent_models.append((e, None))
            continue
        key = tuple(e["paths"])
        if key not in model_cache:
            mv = None
            try:
                mb = resolver.resolve_model_bytes(list(e["paths"]))
                if mb:
                    md = codec.decode(mb)
                    mv = md.voxels or None
            except Exception:
                mv = None
            model_cache[key] = mv
        ent_models.append((e, model_cache[key]))

    usable = [(i, e) for i, (e, mv) in enumerate(ent_models) if mv]
    if not usable:
        return {}

    # Assign each placeholder to its nearest usable entity.
    clusters: dict[int, list] = {i: [] for i, _ in usable}
    for (px, py, pz) in placeholders:
        best_i = None
        best_d = None
        for i, e in usable:
            d = (px - e["x"]) ** 2 + (py - e["y"]) ** 2 + (pz - e["z"]) ** 2
            if best_d is None or d < best_d:
                best_d, best_i = d, i
        clusters[best_i].append((px, py, pz))

    def _lerp(c, cn, cx, mn, mx):
        if cx == cn:
            return mn
        return mn + round((c - cn) / (cx - cn) * (mx - mn))

    fill: dict = {}
    for i, e in usable:
        cells = clusters[i]
        if not cells:
            continue
        mv = ent_models[i][1]
        grid = {(v["x"], v["y"], v["z"]): v for v in mv}
        mnx = min(v["x"] for v in mv); mxx = max(v["x"] for v in mv)
        mny = min(v["y"] for v in mv); mxy = max(v["y"] for v in mv)
        mnz = min(v["z"] for v in mv); mxz = max(v["z"] for v in mv)
        cnx = min(c[0] for c in cells); cxx = max(c[0] for c in cells)
        cny = min(c[1] for c in cells); cxy = max(c[1] for c in cells)
        cnz = min(c[2] for c in cells); cxz = max(c[2] for c in cells)
        avg = (sum(v["r"] for v in mv) // len(mv),
               sum(v["g"] for v in mv) // len(mv),
               sum(v["b"] for v in mv) // len(mv))
        for (px, py, pz) in cells:
            mx_ = _lerp(px, cnx, cxx, mnx, mxx)
            my_ = _lerp(py, cny, cxy, mny, mxy)
            mz_ = _lerp(pz, cnz, cxz, mnz, mxz)
            v = grid.get((mx_, my_, mz_)) or _nearest_model_voxel(grid, mx_, my_, mz_)
            if v is None:
                fill[(px, py, pz)] = (avg[0], avg[1], avg[2], 21, 0)
            else:
                fill[(px, py, pz)] = (v["r"], v["g"], v["b"], v["type"], v["w"])
    return fill


def _rendered_document(decoded: DecodedBlueprint, file_name: str, fill: dict,
                       exact_colors: dict | None = None) -> dict:
    """A composite base layer: real voxels in their display colour, with the cyan
    type-39 placeholders replaced by the sampled deco-fill colours."""
    sx, sy, sz = decoded.size
    name_stem = Path(str(file_name or "Blueprint")).stem or "Blueprint"
    voxels = []
    for v in decoded.voxels:
        key = (v["x"], v["y"], v["z"])
        if v["type"] == _PLACEHOLDER_TYPE and key in fill:
            r, g, b, _t, _w = fill[key]
        else:
            r, g, b = _layer_voxel_color("base", v, exact_colors)
        voxels.append(QubicleVoxel(x=v["x"], y=v["y"], z=v["z"], r=r, g=g, b=b, a=255))
    matrix = QubicleMatrix(name=f"{name_stem}_rendered", size_x=sx, size_y=sy, size_z=sz,
                           pos_x=decoded.pos[0], pos_y=decoded.pos[1], pos_z=decoded.pos[2],
                           voxels=voxels)
    matrix.validate()
    document = QubicleDocument(
        header=QubicleHeader(color_format=0, z_axis_orientation=1, compressed=True,
                             visibility_mask_encoded=False),
        matrices=[matrix],
    )
    document.validate()
    payload = document.to_dict()
    payload["source_format"] = f"trove_blueprint_v{decoded.version}"
    payload["source_file_type"] = "blueprint"
    payload["layer"] = "rendered"
    payload["read_only"] = True  # composite preview -- not an editable source layer
    return payload


# Trove authors deco/block models at this many voxels per blueprint block, so a
# faithful "fully rendered" preview must explode the block-resolution build by
# this factor and drop each deco's model in at full detail (1 block = 12^3 voxels).
BLOCK_VOXELS = 12
_FACE_DIRS = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))


def _explode_decos(decoded: DecodedBlueprint, resolver, B: int) -> tuple[dict, int]:
    """Place every resolved deco model into exploded space at full voxel detail,
    scaled by its binfab render scale. Returns ({(x,y,z): (r,g,b)}, decos_placed)."""
    vox: dict[tuple, tuple] = {}
    info = codec.parse_entity_section(decoded.entity_blob, version=decoded.version)
    cache: dict[tuple, tuple | None] = {}
    placed = 0
    for e in info.get("entities", []):
        if not e.get("path"):
            continue
        key = tuple(e["paths"])
        if key not in cache:
            mv = None
            try:
                mb = resolver.resolve_model_bytes(list(e["paths"])) if resolver else None
                if mb:
                    md = codec.decode(mb)
                    mvx = md.voxels
                    if mvx:
                        mnx = min(p["x"] for p in mvx)
                        mny = min(p["y"] for p in mvx)
                        mnz = min(p["z"] for p in mvx)
                        scale = resolver.resolve_scale(list(e["paths"])) if resolver else 1.0
                        mv = (mvx, mnx, mny, mnz, scale)
            except Exception:
                mv = None
            cache[key] = mv
        mv = cache[key]
        if not mv:
            continue
        mvx, mnx, mny, mnz, scale = mv
        ox, oy, oz = e["x"] * B, e["y"] * B, e["z"] * B
        if scale == 1.0:
            for p in mvx:
                vox[(ox + p["x"] - mnx, oy + p["y"] - mny, oz + p["z"] - mnz)] = \
                    maps.display_base_color(p["type"], (p["r"], p["g"], p["b"]))
        else:
            for p in mvx:
                vox[(ox + round((p["x"] - mnx) * scale),
                     oy + round((p["y"] - mny) * scale),
                     oz + round((p["z"] - mnz) * scale))] = \
                    maps.display_base_color(p["type"], (p["r"], p["g"], p["b"]))
        placed += 1
    return vox, placed


def build_exploded_render(decoded: DecodedBlueprint, resolver, *,
                          block: int = BLOCK_VOXELS,
                          max_voxels: int = 2_500_000) -> dict:
    """Full-detail render: explode the block-resolution build by ``block`` (=12)
    and place every resolved deco model at its entity block in full voxel detail
    (scaled by its binfab render scale, so a 24³ deco @0.5 becomes one 12³ block).

    Decos are built first (they're the point). The build's solid blocks are then
    added as hollow ``block^3`` shells (only faces adjacent to air, so the count
    stays sane) **only if** the total fits under ``max_voxels`` -- otherwise the
    structure is omitted and the decos render alone. This keeps the payload small
    enough for the editor *and* stops a full enclosing shell from occluding the
    furniture inside. Read-only preview; never feeds recompile.
    """
    sx, sy, sz = decoded.size
    B = block

    # 1. Decos first (full detail, scaled). This is what the user wants to see.
    vox, placed = _explode_decos(decoded, resolver, B)

    # 2. Structure shell -- only if it fits (and won't bury the decos).
    struct: dict[tuple, tuple] = {}
    for v in decoded.voxels:
        if v["type"] != _PLACEHOLDER_TYPE:
            struct[(v["x"], v["y"], v["z"])] = maps.display_base_color(
                v["type"], (v["r"], v["g"], v["b"]))
    exposed_faces = 0
    for (bx, by, bz) in struct:
        for (dx, dy, dz) in _FACE_DIRS:
            if (bx + dx, by + dy, bz + dz) not in struct:
                exposed_faces += 1
    structure_estimate = exposed_faces * B * B
    structure_omitted = (len(vox) + structure_estimate) > max_voxels
    if not structure_omitted:
        for (bx, by, bz), col in struct.items():
            ex, ey, ez = bx * B, by * B, bz * B
            for (dx, dy, dz) in _FACE_DIRS:
                if (bx + dx, by + dy, bz + dz) in struct:
                    continue
                if dx:
                    xv = B - 1 if dx == 1 else 0
                    for y in range(B):
                        for z in range(B):
                            vox.setdefault((ex + xv, ey + y, ez + z), col)
                elif dy:
                    yv = B - 1 if dy == 1 else 0
                    for x in range(B):
                        for z in range(B):
                            vox.setdefault((ex + x, ey + yv, ez + z), col)
                else:
                    zv = B - 1 if dz == 1 else 0
                    for x in range(B):
                        for y in range(B):
                            vox.setdefault((ex + x, ey + y, ez + zv), col)

    if not vox:
        return {"error": "Nothing to render (no resolvable decos found).",
                "voxel_estimate": 0}
    if len(vox) > max_voxels:
        return {"error": (f"Full render is {len(vox):,} voxels (over the "
                          f"{max_voxels:,} cap). Open individual deco models instead."),
                "voxel_estimate": len(vox)}

    voxels = [QubicleVoxel(x=x, y=y, z=z, r=c[0], g=c[1], b=c[2], a=255)
              for (x, y, z), c in vox.items()]
    matrix = QubicleMatrix(name="rendered", size_x=sx * B, size_y=sy * B, size_z=sz * B,
                           pos_x=decoded.pos[0] * B, pos_y=decoded.pos[1] * B,
                           pos_z=decoded.pos[2] * B, voxels=voxels)
    matrix.validate()
    document = QubicleDocument(
        header=QubicleHeader(color_format=0, z_axis_orientation=1, compressed=True,
                             visibility_mask_encoded=False),
        matrices=[matrix],
    )
    document.validate()
    payload = document.to_dict()
    payload["source_format"] = f"trove_blueprint_v{decoded.version}"
    payload["source_file_type"] = "blueprint"
    payload["layer"] = "rendered"
    payload["read_only"] = True
    payload["render_info"] = {"block_voxels": B, "decos_placed": placed,
                              "voxel_count": len(vox),
                              "structure_omitted": structure_omitted}
    return payload


def _render_resolver(game_path):
    if not game_path:
        return None
    try:
        from utils.blueprint.trove_block_mapping import load_deco_resolver
        return load_deco_resolver(game_path)
    except Exception:
        return None


# The 2D-canvas editor viewport builds a face object per voxel face, so it can only
# render a modest number of voxels interactively before it freezes. Keep the LIVE
# preview under this; the uncapped full render goes to a .qb file (export) instead.
_LIVE_RENDER_CAP = 80_000


def blueprint_render_document(blueprint_path: str | Path,
                              game_path: str | Path | None = None) -> dict:
    """On-demand render for the editor's "Rendered (decos)" layer. Bounded by the
    live 2D renderer -- for the full, uncapped build use ``export_blueprint_render``."""
    path = Path(blueprint_path)
    decoded = codec.decode(path.read_bytes())
    doc = build_exploded_render(decoded, _render_resolver(game_path),
                                max_voxels=_LIVE_RENDER_CAP)
    if "error" not in doc:
        doc["path"] = str(path)
        doc["file_name"] = path.name
        doc["asset_id"] = "bp-asset-rendered"
        doc["asset_label"] = f"{path.stem} [Rendered]"
    return doc


def export_blueprint_render(blueprint_path: str | Path, out_path: str | Path,
                            game_path: str | Path | None = None) -> dict:
    """Build the FULL, uncapped exploded render (build body + every deco at 12³/block,
    full detail) and write it as a ``.qb`` file. No voxel limit -- the live editor
    can't draw it, but a GPU voxel viewer (MagicaVoxel/Qubicle) opens it fine.

    Returns ``{"voxel_count", "decos_placed", "path"}`` or ``{"error": ...}``.
    """
    path = Path(blueprint_path)
    out = Path(out_path)
    if out.suffix.lower() != ".qb":
        out = out.with_suffix(".qb")
    decoded = codec.decode(path.read_bytes())
    doc = build_exploded_render(decoded, _render_resolver(game_path),
                                max_voxels=50_000_000)
    if "error" in doc:
        return doc
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(QubicleDocument.from_dict(doc).to_bytes())
    info = doc.get("render_info", {})
    return {"path": str(out), "file_name": out.name,
            "voxel_count": info.get("voxel_count"),
            "decos_placed": info.get("decos_placed"),
            "structure_omitted": info.get("structure_omitted")}


def blueprint_to_package(blueprint_path: str | Path, game_path: str | Path | None = None) -> dict:
    path = Path(blueprint_path)
    data = path.read_bytes()
    decoded = codec.decode(data)

    # When a game install is available, fetch exact tinted base colours (so
    # procedural/terrain voxels show their real in-game colour) and resolve every
    # voxel to its named block from the dynamic registry.
    exact_colors: dict | None = None
    block_legend: dict = {}
    deco_resolver = None
    if game_path:
        # Only pay the -generatemaps cost when the blueprint actually has
        # procedural voxels (artist models with authored colours don't need it).
        has_procedural = any(
            maps.is_auto_color(v["type"], (v["r"], v["g"], v["b"])) for v in decoded.voxels
        )
        try:
            exact_colors = (exact_base_colors(data, game_path) or None) if has_procedural else None
        except Exception:
            exact_colors = None
        try:
            from utils.blueprint.trove_block_mapping import load_block_resolver
            resolver = load_block_resolver(game_path)
            for v in decoded.voxels:
                ident = resolver.resolve(v["type"], v["w"], (v["r"], v["g"], v["b"]))
                if not ident:
                    continue
                entry = block_legend.setdefault(ident, {
                    "identifier": ident, "type": v["type"], "style": v["w"],
                    "colour": f"{v['r']:02x}{v['g']:02x}{v['b']:02x}", "count": 0,
                })
                entry["count"] += 1
        except Exception:
            block_legend = {}
        # Deco model resolver -- only needed for the rendered-decos preview/export.
        # DISABLED for now: building it scans the whole blueprints TFA catalogue
        # (~71k members) on every open, which makes loading feel like it hangs.
        # Re-enable by flipping _RENDER_DECOS_ENABLED (and cache the resolver per
        # game_path so it's built once, not on every blueprint open).
        if _RENDER_DECOS_ENABLED and any(v["type"] == _PLACEHOLDER_TYPE for v in decoded.voxels):
            try:
                from utils.blueprint.trove_block_mapping import load_deco_resolver
                deco_resolver = load_deco_resolver(game_path)
            except Exception:
                deco_resolver = None

    assets: dict[str, dict] = {}
    children = []
    base_asset_id = ""
    for i, layer in enumerate(_LAYERS, start=1):
        asset_id = f"bp-asset-{layer}"
        doc = _layer_document(layer, decoded, path.name,
                              exact_colors if layer == "base" else None)
        doc["path"] = str(path)
        doc["file_name"] = path.name
        doc["asset_id"] = asset_id
        doc["asset_label"] = f"{path.stem} [{_LAYER_LABEL[layer]}]"
        assets[asset_id] = doc
        children.append({
            "id": f"bp-node-{i}", "label": _LAYER_LABEL[layer], "kind": "qb",
            "path": str(path), "asset_id": asset_id,
        })
        if layer == "base":
            base_asset_id = asset_id

    # Entity placements (decos / interactive blocks that fill the cyan type-39
    # placeholder voxels). Exact per-entity positions + prefab paths decode from
    # the entity section using the schema reverse-engineered from Trove_x64.exe
    # (FUN_007bc5f0); positions are model-local and align with the voxel grid.
    entity_info = codec.parse_entity_section(decoded.entity_blob,
                                             version=decoded.version)
    ent_counts: dict = {}
    placements = []
    for e in entity_info.get("entities", []):
        if e.get("path"):
            ent_counts[e["path"]] = ent_counts.get(e["path"], 0) + 1
        placements.append({
            "x": e["x"], "y": e["y"], "z": e["z"],
            "path": e.get("path"),
            "interactive": e.get("interactive", False),
        })
    # Fall back to the path-only references if exact framing failed.
    if not placements:
        for r in entity_info.get("references", []):
            ent_counts[r["path"]] = ent_counts.get(r["path"], 0) + 1
    placeholder_count = sum(
        1 for v in decoded.voxels if v["type"] == _PLACEHOLDER_TYPE
    )

    # Composite render: a full-detail, read-only preview that explodes the build by
    # 12 (1 block = 12^3 deco voxels) and drops each resolved deco model in at full
    # resolution. It can be hundreds of thousands of voxels, so it is built LAZILY
    # (a stub node here; the editor calls build_blueprint_render on selection). The
    # editable base/map layers are untouched and still save losslessly.
    rendered_asset_id = ""
    decos_resolved = 0
    if deco_resolver is not None and placeholder_count and entity_info.get("entities"):
        rendered_asset_id = "bp-asset-rendered"
        assets[rendered_asset_id] = {
            "asset_id": rendered_asset_id,
            "asset_label": f"{path.stem} [Rendered]",
            "path": str(path), "file_name": path.name,
            "layer": "rendered", "read_only": True, "lazy": True,
            "matrices": [],  # populated on demand by build_blueprint_render
            "source_format": f"trove_blueprint_v{decoded.version}",
            "source_file_type": "blueprint",
        }
        children.insert(0, {
            "id": "bp-node-rendered", "label": "Rendered (decos)", "kind": "qb",
            "path": str(path), "asset_id": rendered_asset_id, "lazy": True,
        })

    # Resolve the model name for each distinct deco (for the legend / UI).
    decos_list = []
    for p, c in sorted(ent_counts.items(), key=lambda kv: -kv[1]):
        model = None
        if deco_resolver is not None:
            try:
                model = deco_resolver.resolve_model_name([p])
            except Exception:
                model = None
        if model:
            decos_resolved += 1
        decos_list.append({"path": p, "count": c, "model": model})

    root = {
        "id": "bp-node-root", "label": path.name, "kind": "blueprint",
        "path": str(path), "children": children,
    }
    return {
        "container_path": str(path),
        "file_name": path.name,
        "source_file_type": "blueprint",
        "source_format": "trove_blueprint_package",
        "root": root,
        "assets": assets,
        "selected_asset_id": base_asset_id,
        "block_legend": sorted(block_legend.values(), key=lambda e: -e["count"]),
        "exact_tints": bool(exact_colors),
        "rendered_asset_id": rendered_asset_id,
        "entities": {
            "count": entity_info["count"],
            "exact": entity_info.get("exact", False),
            "placeholder_voxels": placeholder_count,
            "decos": decos_list,
            "decos_resolved": decos_resolved,
            "placements": placements,
        },
    }


def _color_lookup(document: dict | None) -> dict:
    """(x,y,z) -> (r,g,b) for a QB-document's first matrix."""
    out = {}
    if not document:
        return out
    matrices = document.get("matrices") or []
    if not matrices:
        return out
    for vx in matrices[0].get("voxels") or []:
        x, y, z, r, g, b, a = (list(vx) + [0] * 7)[:7]
        if int(a) > 0:
            out[(int(x), int(y), int(z))] = (int(r), int(g), int(b))
    return out


def recompile_blueprint_package(package: dict) -> bytes:
    """Combine the four edited layer assets back into ``.blueprint`` bytes.

    For every voxel, if its alpha/specular/type map values are unchanged from
    what decode produced, the original (type, w) is written back verbatim
    (byte-lossless for any material). Edited map cells are translated through the
    verified material tables.
    """
    assets = package.get("assets") or {}
    by_layer = {a.get("layer"): a for a in assets.values() if a.get("layer")}
    base = by_layer.get("base")
    if not base:
        raise BlueprintDecodeError("Blueprint package is missing its base layer.")

    meta = base.get("blueprint") or {}
    version = int(meta.get("version", 5))
    pos = tuple(meta.get("pos")) if meta.get("pos") else None
    entity_blob = bytes.fromhex(meta.get("entity_blob", "") or "")
    attributes = meta.get("attributes") or {}
    scale = tuple(meta.get("scale") or (1, 1, 1))
    offset = tuple(meta.get("offset") or (0, 0, 0))

    base_colors = _color_lookup(base)
    alpha_map = _color_lookup(by_layer.get("alpha"))
    spec_map = _color_lookup(by_layer.get("specular"))
    type_map = _color_lookup(by_layer.get("type"))

    voxels = []
    for (x, y, z), (r, g, b) in base_colors.items():
        attr = attributes.get(f"{x},{y},{z}")
        o_type = int(attr[0]) if attr else DEFAULT_TYPE
        o_w = int(attr[1]) if attr else DEFAULT_W
        # Auto-colour voxel: the base layer shows a substituted tint and the
        # game ignores the stored colour anyway -> always restore the original.
        if attr and len(attr) >= 5:
            r, g, b = int(attr[2]), int(attr[3]), int(attr[4])

        cur_a = alpha_map.get((x, y, z))
        cur_s = spec_map.get((x, y, z))
        cur_t = type_map.get((x, y, z))
        dec_a, dec_s, dec_t = maps.maps_from_type_w(o_type, o_w)

        # Unedited material cells -> keep original (type, w) exactly.
        if (cur_a in (None, dec_a)) and (cur_s in (None, dec_s)) and (cur_t in (None, dec_t)):
            vtype, w = o_type, o_w
        else:
            vtype, w = maps.type_w_from_maps(
                cur_a or dec_a, cur_s or dec_s, cur_t or dec_t,
                fallback_type=o_type, fallback_w=o_w,
            )
        voxels.append({"x": x, "y": y, "z": z, "r": r, "g": g, "b": b, "w": w, "type": vtype})

    return codec.encode(voxels, version=version, pos=pos, entity_blob=entity_blob,
                        scale=scale, offset=offset)


# --------------------------------------------------------------------------- #
# Encode -> .blueprint bytes (save path)
# --------------------------------------------------------------------------- #
def document_to_blueprint(document: dict) -> bytes:
    """Encode an edited QB-document back into ``.blueprint`` bytes the game reads.

    Honours the ``blueprint`` metadata block produced by :func:`blueprint_to_document`
    (version, origin, entity data, and per-voxel type/w attributes).  New voxels
    that have no stored attributes default to a standard solid voxel.
    """
    meta = document.get("blueprint") or {}
    version = int(meta.get("version", 5))
    pos = tuple(meta.get("pos")) if meta.get("pos") else None
    entity_blob = bytes.fromhex(meta.get("entity_blob", "") or "")
    attributes = meta.get("attributes") or {}
    scale = tuple(meta.get("scale") or (1, 1, 1))
    offset = tuple(meta.get("offset") or (0, 0, 0))

    matrices = document.get("matrices") or []
    if not matrices:
        raise BlueprintDecodeError("Document has no matrices to encode.")
    matrix = matrices[0]

    voxels = []
    for vx in matrix.get("voxels") or []:
        x, y, z, r, g, b, a = (list(vx) + [0] * 7)[:7]
        if int(a) <= 0:
            continue
        attr = attributes.get(f"{int(x)},{int(y)},{int(z)}")
        vtype = int(attr[0]) if attr else DEFAULT_TYPE
        w = int(attr[1]) if attr else DEFAULT_W
        voxels.append({"x": int(x), "y": int(y), "z": int(z),
                       "r": int(r), "g": int(g), "b": int(b), "w": w, "type": vtype})

    return codec.encode(voxels, version=version, pos=pos, entity_blob=entity_blob, scale=scale, offset=offset)
