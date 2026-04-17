from __future__ import annotations

import contextlib
import io
import zlib
from pathlib import Path

from backend.qubicle_qb import QubicleDocument, QubicleHeader, QubicleMatrix, QubicleVoxel


class BlueprintDecodeError(ValueError):
    pass


def _clone_document_payload(payload: dict) -> dict:
    return {
        "path": str(payload.get("path", "")),
        "file_name": str(payload.get("file_name", "")),
        "source_format": str(payload.get("source_format", "qb")),
        "source_file_type": str(payload.get("source_file_type", "qb")),
        "header": dict(payload.get("header") or {}),
        "matrices": [
            {
                "name": str(matrix.get("name", "Matrix")),
                "size_x": int(matrix.get("size_x", 1)),
                "size_y": int(matrix.get("size_y", 1)),
                "size_z": int(matrix.get("size_z", 1)),
                "pos_x": int(matrix.get("pos_x", 0)),
                "pos_y": int(matrix.get("pos_y", 0)),
                "pos_z": int(matrix.get("pos_z", 0)),
                "voxels": [list(voxel) for voxel in (matrix.get("voxels") or [])],
            }
            for matrix in (payload.get("matrices") or [])
        ],
    }


def _blueprint_version(data: bytes) -> int | None:
    if not data.startswith(b"kiwib") or len(data) < 9:
        return None
    return int.from_bytes(data[5:9], "little", signed=False)


def _decompress_v5_payload(data: bytes) -> bytes:
    try:
        return zlib.decompressobj().decompress(data[9:])
    except zlib.error as exc:
        raise BlueprintDecodeError(f"Failed to decompress kiwib v5 blueprint: {exc}") from exc


def _is_empty_v3_blueprint(data: bytes) -> bool:
    version = _blueprint_version(data)
    if version != 3:
        return False
    return len(data) <= 12 and all(byte == 0 for byte in data[9:])


def _is_empty_v4_blueprint(data: bytes) -> bool:
    version = _blueprint_version(data)
    if version != 4:
        return False
    return len(data) <= 11 and all(byte == 0 for byte in data[9:])


def _is_empty_v5_blueprint(data: bytes) -> bool:
    if _blueprint_version(data) != 5:
        return False
    try:
        payload = _decompress_v5_payload(data)
    except BlueprintDecodeError:
        return False
    return len(payload) >= 32 and payload[:32] == (b"\x00" * 32)


def _is_empty_blueprint_placeholder(data: bytes) -> bool:
    return _is_empty_v3_blueprint(data) or _is_empty_v4_blueprint(data) or _is_empty_v5_blueprint(data)


def _detect_first_glyph_install() -> Path | None:
    try:
        from utils.registry import get_trove_locations

        with contextlib.redirect_stdout(io.StringIO()):
            locations = list(get_trove_locations())
    except Exception:
        locations = []
    for game in locations:
        if getattr(game, "is_glyph", False) and getattr(game, "is_valid", False):
            return Path(game.path)

    for drive_letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        candidate = Path(f"{drive_letter}:\\Glyph\\Games\\Trove\\Live")
        if candidate.joinpath("Trove.exe").exists():
            return candidate
    return None


def _find_nearest_game_root(path: Path) -> Path | None:
    for parent in [path.parent, *path.parents]:
        if parent.joinpath("Trove.exe").exists():
            return parent
    return None


def _candidate_export_directories(blueprint_path: Path) -> list[Path]:
    directories: list[Path] = []

    def add(candidate: Path | None) -> None:
        if not candidate:
            return
        try:
            resolved = candidate.resolve()
        except OSError:
            return
        if not resolved.exists() or not resolved.is_dir():
            return
        if resolved not in directories:
            directories.append(resolved)

    add(blueprint_path.parent.joinpath("qbexport"))
    add(blueprint_path.parent)

    local_game_root = _find_nearest_game_root(blueprint_path)
    if local_game_root:
        add(local_game_root.joinpath("qbexport"))

    glyph_root = _detect_first_glyph_install()
    if glyph_root:
        add(glyph_root.joinpath("qbexport"))

    return directories


def _companion_sort_key(base_name: str, path: Path) -> tuple[int, str]:
    stem = path.stem.lower()
    base_name = base_name.lower()
    suffix_rank = {
        base_name: 0,
        f"{base_name}_a": 1,
        f"{base_name}_s": 2,
        f"{base_name}_t": 3,
        f"{base_name}_entities": 10,
    }.get(stem, 5 if path.suffix.lower() == ".qb" else 20)
    return (suffix_rank, path.name.lower())


def _discover_companion_assets(blueprint_path: Path) -> list[Path]:
    base_name = blueprint_path.stem.lower()
    prefix = f"{base_name}_"
    matches: dict[str, Path] = {}

    try:
        blueprint_resolved = blueprint_path.resolve()
    except OSError:
        blueprint_resolved = blueprint_path

    for directory in _candidate_export_directories(blueprint_path):
        for child in directory.iterdir():
            if not child.is_file():
                continue
            child_suffix = child.suffix.lower()
            if child_suffix not in {".qb", ".blueprint"}:
                continue
            child_name = child.name.lower()
            child_stem = child.stem.lower()
            if child_stem != base_name and not child_stem.startswith(prefix):
                continue
            try:
                child_resolved = child.resolve()
            except OSError:
                child_resolved = child
            if child_resolved == blueprint_resolved:
                continue
            matches.setdefault(child.name.lower(), child)

    paths = list(matches.values())
    blueprint_stems = {path.stem.lower() for path in paths if path.suffix.lower() == ".blueprint"}
    filtered_paths = [
        path
        for path in paths
        if path.suffix.lower() == ".blueprint" or path.stem.lower() not in blueprint_stems
    ]

    return sorted(filtered_paths, key=lambda path: _companion_sort_key(base_name, path))


def _load_qb_payload(path: Path) -> dict:
    document = QubicleDocument.from_bytes(path.read_bytes()).to_dict()
    document["path"] = str(path)
    document["file_name"] = path.name
    document["source_format"] = "qb"
    document["source_file_type"] = "qb"
    return document


def _load_blueprint_document(path: Path) -> dict:
    payload = blueprint_to_document(path.read_bytes(), path.name)
    payload["path"] = str(path)
    payload["file_name"] = path.name
    return payload


def _build_asset_label(path: Path) -> str:
    stem = path.stem
    lower_stem = stem.lower()
    if lower_stem.endswith("_a"):
        return f"{stem[:-2]} [A]"
    if lower_stem.endswith("_s"):
        return f"{stem[:-2]} [S]"
    if lower_stem.endswith("_t"):
        return f"{stem[:-2]} [T]"
    return stem


def _build_blueprint_package(
    blueprint_path: Path,
    assets: dict[str, dict],
    visited: set[Path],
    counters: dict[str, int],
) -> dict:
    try:
        resolved = blueprint_path.resolve()
    except OSError:
        resolved = blueprint_path

    counters["node"] += 1
    node = {
        "id": f"bp-node-{counters['node']}",
        "label": blueprint_path.name,
        "kind": "blueprint",
        "path": str(blueprint_path),
        "children": [],
    }

    if resolved in visited:
        node["error"] = "Blueprint recursion loop detected."
        return node

    visited.add(resolved)
    companion_paths = _discover_companion_assets(blueprint_path)

    for child_path in companion_paths:
        if child_path.suffix.lower() == ".blueprint":
            node["children"].append(_build_blueprint_package(child_path, assets, visited, counters))
            continue

        counters["asset"] += 1
        asset_id = f"bp-asset-{counters['asset']}"
        asset_payload = _load_qb_payload(child_path)
        asset_payload["asset_id"] = asset_id
        asset_payload["asset_label"] = _build_asset_label(child_path)
        assets[asset_id] = asset_payload
        node["children"].append(
            {
                "id": asset_id,
                "label": asset_payload["asset_label"],
                "kind": "qb",
                "path": str(child_path),
                "asset_id": asset_id,
            }
        )

    if not node["children"]:
        try:
            counters["asset"] += 1
            asset_id = f"bp-asset-{counters['asset']}"
            asset_payload = _load_blueprint_document(blueprint_path)
            asset_payload["asset_id"] = asset_id
            asset_payload["asset_label"] = f"{blueprint_path.stem} [Decoded]"
            assets[asset_id] = asset_payload
            node["asset_id"] = asset_id
        except BlueprintDecodeError as exc:
            if not _is_empty_blueprint_placeholder(blueprint_path.read_bytes()):
                node["error"] = str(exc)

    visited.remove(resolved)
    return node


def _find_first_asset_id(node: dict) -> str | None:
    asset_id = node.get("asset_id")
    if asset_id:
        return str(asset_id)
    for child in node.get("children") or []:
        nested = _find_first_asset_id(child)
        if nested:
            return nested
    return None


def blueprint_to_package(blueprint_path: str | Path) -> dict:
    path = Path(blueprint_path)
    assets: dict[str, dict] = {}
    counters = {"node": 0, "asset": 0}
    root = _build_blueprint_package(path, assets, set(), counters)
    selected_asset_id = _find_first_asset_id(root)
    if not selected_asset_id:
        error = root.get("error") or "This blueprint does not expose any editable QB assets yet."
        raise BlueprintDecodeError(str(error))

    return {
        "container_path": str(path),
        "file_name": path.name,
        "source_file_type": "blueprint",
        "source_format": "trove_blueprint_package",
        "root": root,
        "assets": {asset_id: _clone_document_payload(payload) | {
            "asset_id": asset_id,
            "asset_label": payload.get("asset_label", payload.get("file_name", asset_id)),
        } for asset_id, payload in assets.items()},
        "selected_asset_id": selected_asset_id,
    }


def _default_alpha(alpha_hint: int, r: int, g: int, b: int) -> int:
    alpha_hint = int(alpha_hint) & 0xFF
    if alpha_hint:
        return alpha_hint
    if r or g or b:
        return 255
    return 0


def _build_bounded_document(
    matrix_name: str,
    size_x: int,
    size_y: int,
    size_z: int,
    pos_x: int,
    pos_y: int,
    pos_z: int,
    voxels: list[tuple[int, int, int, int, int, int, int]],
) -> QubicleDocument:
    if size_x <= 0 or size_y <= 0 or size_z <= 0:
        raise BlueprintDecodeError("Blueprint matrix bounds are invalid.")

    matrix = QubicleMatrix(
        name=matrix_name,
        size_x=size_x,
        size_y=size_y,
        size_z=size_z,
        pos_x=pos_x,
        pos_y=pos_y,
        pos_z=pos_z,
        voxels=[
            QubicleVoxel(x=x, y=y, z=z, r=r, g=g, b=b, a=a)
            for x, y, z, r, g, b, a in voxels
            if 0 <= x < size_x and 0 <= y < size_y and 0 <= z < size_z and a > 0
        ],
    )
    matrix.validate()

    document = QubicleDocument(
        header=QubicleHeader(
            version=QubicleHeader().version,
            color_format=0,
            z_axis_orientation=1,
            compressed=True,
            visibility_mask_encoded=False,
        ),
        matrices=[matrix],
    )
    document.validate()
    return document


def _odd_centered_extent(max_coordinate: int) -> tuple[int, int]:
    size = int(max_coordinate) + 1
    if size <= 0:
        raise BlueprintDecodeError("Blueprint matrix bounds are invalid.")
    if size % 2 == 0:
        size += 1
    return size, -(size // 2)


def _build_document(matrix_name: str, voxels: list[tuple[int, int, int, int, int, int, int]]) -> QubicleDocument:
    if not voxels:
        raise BlueprintDecodeError("Blueprint did not decode into any visible voxels.")

    min_x = min(voxel[0] for voxel in voxels)
    min_y = min(voxel[1] for voxel in voxels)
    min_z = min(voxel[2] for voxel in voxels)
    max_x = max(voxel[0] for voxel in voxels)
    max_y = max(voxel[1] for voxel in voxels)
    max_z = max(voxel[2] for voxel in voxels)

    matrix = QubicleMatrix(
        name=matrix_name,
        size_x=max_x - min_x + 1,
        size_y=max_y - min_y + 1,
        size_z=max_z - min_z + 1,
        pos_x=min_x,
        pos_y=min_y,
        pos_z=min_z,
        voxels=[
            QubicleVoxel(
                x=x - min_x,
                y=y - min_y,
                z=z - min_z,
                r=r,
                g=g,
                b=b,
                a=a,
            )
            for x, y, z, r, g, b, a in voxels
            if a > 0
        ],
    )
    matrix.validate()

    document = QubicleDocument(
        header=QubicleHeader(
            version=QubicleHeader().version,
            color_format=0,
            z_axis_orientation=1,
            compressed=True,
            visibility_mask_encoded=False,
        ),
        matrices=[matrix],
    )
    document.validate()
    return document


def _parse_v3_records(data: bytes, matrix_name: str) -> QubicleDocument:
    record_offset = None
    for candidate in (10, 11, 12, 14, 15):
        if len(data) > candidate and (len(data) - candidate) % 9 == 0:
            record_offset = candidate
            break
    if record_offset is None:
        raise BlueprintDecodeError("Unsupported kiwib v3 blueprint layout.")

    voxels: list[tuple[int, int, int, int, int, int, int]] = []
    for offset in range(record_offset, len(data), 9):
        record = data[offset : offset + 9]
        if record_offset >= 12:
            r, g, b, alpha_hint = record[2], record[3], record[4], record[5]
            x, y, z = record[6], record[7], record[8]
        else:
            x, y, z = record[0], record[1], record[2]
            r, g, b, alpha_hint = record[5], record[6], record[7], record[8]
        alpha = _default_alpha(alpha_hint, r, g, b)
        if alpha <= 0:
            continue
        voxels.append((x, y, z, r, g, b, alpha))

    if not voxels:
        raise BlueprintDecodeError("Blueprint did not decode into any visible voxels.")

    max_x = max(voxel[0] for voxel in voxels)
    max_y = max(voxel[1] for voxel in voxels)
    max_z = max(voxel[2] for voxel in voxels)
    size_x, pos_x = _odd_centered_extent(max_x)
    size_y, pos_y = _odd_centered_extent(max_y)
    size_z, pos_z = _odd_centered_extent(max_z)

    return _build_bounded_document(matrix_name, size_x, size_y, size_z, pos_x, pos_y, pos_z, voxels)


def _parse_v4_records(data: bytes, matrix_name: str) -> QubicleDocument:
    if len(data) < 10:
        raise BlueprintDecodeError("kiwib v4 blueprint is too small.")

    def parse_synthetic_layout() -> QubicleDocument | None:
        record_count = data[9]
        record_offset = 10
        expected_size = record_offset + (record_count * 9)
        if expected_size > len(data) or record_count <= 0:
            return None
        records = [data[record_offset + (index * 9) : record_offset + ((index + 1) * 9)] for index in range(record_count)]
        sample = records[: min(32, len(records))]
        marker_matches = sum(1 for record in sample if record[3] == 0x15 and record[4] == 0x00)
        if marker_matches < max(1, int(len(sample) * 0.75)):
            return None
        alpha_like_matches = sum(1 for record in sample if record[8] > 0x1F)
        if alpha_like_matches == 0:
            return None

        voxels: list[tuple[int, int, int, int, int, int, int]] = []
        for record in records:
            x, y, z = record[0], record[1], record[2]
            r, g, b, alpha_hint = record[5], record[6], record[7], record[8]
            alpha = _default_alpha(alpha_hint, r, g, b)
            if alpha <= 0:
                continue
            voxels.append((x, y, z, r, g, b, alpha))

        return _build_document(matrix_name, voxels) if voxels else None

    def parse_live_layout(record_offset: int) -> QubicleDocument | None:
        if len(data) <= record_offset or (len(data) - record_offset) % 9 != 0:
            return None
        records = [data[offset : offset + 9] for offset in range(record_offset, len(data), 9)]
        sample = records[: min(32, len(records))]
        if not sample:
            return None
        marker_matches = sum(1 for record in sample if record[3] == 0x00 and record[2] != 0x00)
        if marker_matches < max(1, int(len(sample) * 0.75)):
            return None

        voxels: list[tuple[int, int, int, int, int, int, int]] = []
        for record in records:
            x, y, z = record[8], record[0], record[1]
            r, g, b, alpha_hint = record[4], record[5], record[6], record[7]
            alpha = _default_alpha(alpha_hint, r, g, b)
            if alpha <= 0:
                continue
            voxels.append((x, y, z, r, g, b, alpha))

        if not voxels:
            return None

        max_x = max(voxel[0] for voxel in voxels)
        max_y = max(voxel[1] for voxel in voxels)
        max_z = max(voxel[2] for voxel in voxels)
        size_x, pos_x = _odd_centered_extent(max_x)
        size_y, pos_y = _odd_centered_extent(max_y)
        size_z, pos_z = _odd_centered_extent(max_z)
        return _build_bounded_document(matrix_name, size_x, size_y, size_z, pos_x, pos_y, pos_z, voxels)

    document = parse_synthetic_layout()
    if document is not None:
        return document

    for candidate_offset in (11, 12):
        document = parse_live_layout(candidate_offset)
        if document is not None:
            return document
    raise BlueprintDecodeError("kiwib v4 blueprint record table is truncated.")


def _decode_v5_geometry_candidates(size_x: int, size_y: int, size_z: int, geometry_tokens: list[bytes]) -> list[tuple[int, int, int] | None]:
    best_coords: list[tuple[int, int, int] | None] = [None] * len(geometry_tokens)
    best_score = (-1, -1, -1, -1)

    def score_coords(coords: list[tuple[int, int, int] | None]) -> tuple[int, int, int, int]:
        valid_points = [point for point in coords if point is not None]
        if not valid_points:
            return (-1, -1, -1, -1)

        unique_points = set(valid_points)
        span_x = max(point[0] for point in unique_points) - min(point[0] for point in unique_points) + 1
        span_y = max(point[1] for point in unique_points) - min(point[1] for point in unique_points) + 1
        span_z = max(point[2] for point in unique_points) - min(point[2] for point in unique_points) + 1
        span_volume = span_x * span_y * span_z

        # V5 blueprints are strongly procedural and often build mirrored cores.
        # Favor coordinate interpretations that preserve left/right reflection.
        mirrored_matches = 0
        for x, y, z in unique_points:
            mirrored = (size_x - 1 - x, y, z)
            if mirrored in unique_points:
                mirrored_matches += 1

        return (
            mirrored_matches,
            span_volume,
            len(unique_points),
            len(valid_points),
        )

    for combo in (
        (0, 1, 2),
        (0, 2, 4),
        (0, 4, 2),
        (2, 0, 4),
        (2, 4, 0),
        (4, 0, 2),
        (4, 2, 0),
        (1, 3, 5),
        (5, 3, 1),
    ):
        coords: list[tuple[int, int, int] | None] = []
        unique_valid: set[tuple[int, int, int]] = set()
        valid_count = 0
        for token in geometry_tokens:
            x, y, z = token[combo[0]], token[combo[1]], token[combo[2]]
            if x < size_x and y < size_y and z < size_z:
                point = (x, y, z)
                coords.append(point)
            else:
                coords.append(None)
        score = score_coords(coords)
        if score > best_score:
            best_score = score
            best_coords = coords

    return best_coords


def _parse_v5_records(data: bytes, matrix_name: str) -> QubicleDocument:
    if len(data) <= 9:
        raise BlueprintDecodeError("kiwib v5 blueprint is too small.")

    payload = _decompress_v5_payload(data)

    if len(payload) < 32:
        raise BlueprintDecodeError("kiwib v5 blueprint payload is too small.")
    if payload[:32] == (b"\x00" * 32):
        raise BlueprintDecodeError("Blueprint is an empty placeholder.")

    pos_x = int.from_bytes(payload[0:4], "little", signed=True)
    pos_y = int.from_bytes(payload[4:8], "little", signed=True)
    pos_z = int.from_bytes(payload[8:12], "little", signed=True)
    size_x = int.from_bytes(payload[12:16], "little", signed=True)
    size_y = int.from_bytes(payload[16:20], "little", signed=True)
    size_z = int.from_bytes(payload[20:24], "little", signed=True)
    token_count = int.from_bytes(payload[24:28], "little", signed=True)
    if size_x <= 0 or size_y <= 0 or size_z <= 0 or token_count <= 0:
        raise BlueprintDecodeError("kiwib v5 blueprint header is invalid.")

    minimum_layout_size = 28 + (token_count * 10)
    if len(payload) < minimum_layout_size:
        raise BlueprintDecodeError("Unsupported kiwib v5 blueprint token layout.")

    geometry_stream = payload[28 : 28 + (token_count * 6)]
    color_stream = payload[28 + (token_count * 6) : 28 + (token_count * 10)]
    geometry_tokens = [geometry_stream[index : index + 6] for index in range(0, len(geometry_stream), 6)]
    color_tokens = [color_stream[index : index + 4] for index in range(0, len(color_stream), 4)]
    if len(geometry_tokens) != token_count or len(color_tokens) != token_count:
        raise BlueprintDecodeError("Unsupported kiwib v5 geometry/color stream layout.")

    candidate_coords = _decode_v5_geometry_candidates(size_x, size_y, size_z, geometry_tokens)
    unique_candidate_coords = []
    seen_candidate_coords: set[tuple[int, int, int]] = set()
    for point in candidate_coords:
        if point is None or point in seen_candidate_coords:
            continue
        seen_candidate_coords.add(point)
        unique_candidate_coords.append(point)

    next_fill_index = 0
    used_positions: set[tuple[int, int, int]] = set()
    voxels: list[tuple[int, int, int, int, int, int, int]] = []
    visible_color_count = 0

    for index in range(token_count):
        r, g, b, alpha_hint = color_tokens[index]
        alpha = _default_alpha(alpha_hint, r, g, b)
        if alpha <= 0:
            continue
        visible_color_count += 1

        point = candidate_coords[index]
        if point is None or point in used_positions:
            while next_fill_index < (size_x * size_y * size_z):
                x = next_fill_index % size_x
                y = (next_fill_index // size_x) % size_y
                z = next_fill_index // (size_x * size_y)
                next_fill_index += 1
                point = (x, y, z)
                if point not in used_positions:
                    break
            else:
                break

        used_positions.add(point)
        voxels.append((point[0], point[1], point[2], r, g, b, alpha))

    if not voxels and visible_color_count == 0 and unique_candidate_coords:
        # Procedural V5 blueprints can still define occupancy even when the
        # immediate color stream is empty. Prefer showing inferred geometry
        # instead of failing hard on clearly structured token streams.
        voxels = [(x, y, z, 255, 255, 255, 255) for x, y, z in unique_candidate_coords]

    if not voxels:
        raise BlueprintDecodeError("kiwib v5 blueprint heuristic decode produced no visible voxels.")

    return _build_bounded_document(matrix_name, size_x, size_y, size_z, pos_x, pos_y, pos_z, voxels)


def blueprint_to_document(data: bytes, file_name: str = "untitled.blueprint") -> dict:
    if not data.startswith(b"kiwib") or len(data) < 9:
        raise BlueprintDecodeError("Not a supported Trove blueprint file.")
    if _is_empty_blueprint_placeholder(data):
        raise BlueprintDecodeError("Blueprint is an empty placeholder.")

    version = int.from_bytes(data[5:9], "little", signed=False)
    matrix_name = Path(str(file_name or "Blueprint")).stem or "Blueprint"

    if version == 3:
        document = _parse_v3_records(data, matrix_name)
        source_format = "trove_blueprint_v3"
    elif version == 4:
        document = _parse_v4_records(data, matrix_name)
        source_format = "trove_blueprint_v4"
    elif version == 5:
        document = _parse_v5_records(data, matrix_name)
        source_format = "trove_blueprint_v5_heuristic"
    else:
        raise BlueprintDecodeError(f"Unsupported kiwib blueprint version: {version}.")

    payload = document.to_dict()
    payload["source_format"] = source_format
    payload["source_file_type"] = "blueprint"
    return payload
