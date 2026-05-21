from __future__ import annotations

import contextlib
import io
import itertools
from collections import Counter
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
        "decode_info": dict(payload.get("decode_info") or {}),
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
        if candidate.joinpath("Trove_64.exe").exists():
            return candidate
    return None


def _find_nearest_game_root(path: Path) -> Path | None:
    for parent in [path.parent, *path.parents]:
        if parent.joinpath("Trove_64.exe").exists():
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


def _document_payload(
    document: QubicleDocument,
    *,
    source_format: str,
    source_file_type: str = "blueprint",
    decode_info: dict | None = None,
) -> dict:
    payload = document.to_dict()
    payload["source_format"] = source_format
    payload["source_file_type"] = source_file_type
    if decode_info:
        payload["decode_info"] = decode_info
    return payload


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


def _v5_geometry_candidate_bank() -> list[tuple[int, int, int]]:
    direct_permutations = list(itertools.permutations(range(6), 3))
    prioritized = [
        (0, 1, 2),
        (0, 2, 4),
        (0, 4, 2),
        (2, 0, 4),
        (2, 4, 0),
        (4, 0, 2),
        (4, 2, 0),
        (1, 3, 5),
        (5, 3, 1),
    ]
    ordered: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int, int]] = set()
    for combo in [*prioritized, *direct_permutations]:
        if combo in seen:
            continue
        seen.add(combo)
        ordered.append(combo)
    return ordered


def _u32(value: int) -> int:
    return int(value) & 0xFFFFFFFF


def _read_v5_ints(data: bytes) -> list[int]:
    payload = _decompress_v5_payload(data)
    take = (len(payload) // 4) * 4
    if take <= 0:
        return []
    return [int.from_bytes(payload[index : index + 4], "little", signed=True) for index in range(0, take, 4)]


def _v5_origin_mode_bank(size_x: int, size_y: int, size_z: int) -> list[str]:
    modes = ["raw"]
    if size_x > 0 and size_y > 0 and size_z > 0:
        modes.extend(["pack_yz", "pack_yz_zflip"])
    return modes


def _pos_mod(value: int, modulus: int) -> int:
    if modulus <= 0:
        return 0
    result = value % modulus
    return result + modulus if result < 0 else result


def _floor_div(value: int, divisor: int) -> int:
    if divisor <= 0:
        return 0
    quotient = value // divisor
    remainder = value % divisor
    if remainder != 0 and ((remainder > 0) != (divisor > 0)):
        quotient -= 1
    return quotient


def _v5_origin_from_ints(ints: list[int], size_x: int, size_y: int, size_z: int, mode: str) -> tuple[int, int, int]:
    raw_x = int(ints[0] if len(ints) > 0 else 0)
    raw_y = int(ints[1] if len(ints) > 1 else 0)
    raw_z = int(ints[2] if len(ints) > 2 else 0)
    if mode == "raw" or size_x <= 0 or size_y <= 0 or size_z <= 0:
        return raw_x, raw_y, raw_z
    if mode in {"pack_yz", "pack_yz_zflip"}:
        center_x = max(0, size_x - 1) // 2
        center_z = max(0, size_z - 1) // 2
        packed = ((raw_z + center_z) * size_y) + raw_y
        out_y = _floor_div(packed, size_z)
        out_z = _pos_mod(packed, size_z)
        if mode == "pack_yz_zflip":
            out_z = (size_z - 1) - out_z
        return center_x - raw_x, out_y, out_z
    return raw_x, raw_y, raw_z


def _v5_detect_tail_layout(tail_words: list[int]) -> str:
    if not tail_words:
        return "rgb24"
    low_byte_1 = 0
    non_zero_byte_3 = 0
    sum_byte_0 = 0
    sum_byte_2 = 0
    for word in tail_words:
        value = _u32(word)
        byte_0 = value & 0xFF
        byte_1 = (value >> 8) & 0xFF
        byte_2 = (value >> 16) & 0xFF
        byte_3 = (value >> 24) & 0xFF
        sum_byte_0 += byte_0
        sum_byte_2 += byte_2
        if byte_1 <= 8:
            low_byte_1 += 1
        if byte_3 != 0:
            non_zero_byte_3 += 1
    if (low_byte_1 / len(tail_words)) >= 0.75 and (non_zero_byte_3 / len(tail_words)) >= 0.75:
        return "g_hi_b_mid_r_lo" if sum_byte_2 >= sum_byte_0 else "g_hi_r_mid_b_lo"
    return "rgb24"


def _v5_tail_words_to_stream(tail_words: list[int], layout: str) -> list[int]:
    stream: list[int] = []
    for word in tail_words:
        value = _u32(word)
        if layout == "bgr24":
            red = value & 0xFF
            green = (value >> 8) & 0xFF
            blue = (value >> 16) & 0xFF
            stream.append(((blue << 16) | (green << 8) | red) & 0xFFFFFF)
            continue
        if layout == "g_hi_r_mid_b_lo":
            red = (value >> 16) & 0xFF
            green = (value >> 24) & 0xFF
            blue = value & 0xFF
            stream.append(((red << 16) | (green << 8) | blue) & 0xFFFFFF)
            continue
        if layout == "g_hi_b_mid_r_lo":
            red = value & 0xFF
            green = (value >> 24) & 0xFF
            blue = (value >> 16) & 0xFF
            stream.append(((red << 16) | (green << 8) | blue) & 0xFFFFFF)
            continue
        stream.append(value & 0xFFFFFF)
    return stream


def _v5_tail_words_from_ints(ints: list[int], filled: int) -> list[int]:
    tail_length = max(0, filled + 1)
    if tail_length <= 0 or tail_length > len(ints):
        return []
    tail_words = ints[len(ints) - tail_length :]
    if tail_words and int(tail_words[-1]) == 0:
        tail_words = tail_words[:-1]
    return [int(word) for word in tail_words]


def _v5_transform_words(words: list[int], transform: str) -> list[int]:
    if transform == "raw":
        return list(words)
    if transform == "small":
        return [value for value in words if 0 <= value <= 255]
    if transform == "large":
        return [value for value in words if value > 255 or value < 0]
    if transform == "delta_abs":
        out: list[int] = []
        previous = 0
        for value in words:
            out.append(abs(int(value) - previous))
            previous = int(value)
        return out
    if transform == "u16_split":
        out: list[int] = []
        for value in words:
            unsigned = _u32(value)
            out.extend([unsigned & 0xFFFF, (unsigned >> 16) & 0xFFFF])
        return out
    if transform == "u8_split":
        out: list[int] = []
        for value in words:
            unsigned = _u32(value)
            out.extend([
                unsigned & 0xFF,
                (unsigned >> 8) & 0xFF,
                (unsigned >> 16) & 0xFF,
                (unsigned >> 24) & 0xFF,
            ])
        return out
    if transform == "u4_split":
        out: list[int] = []
        for value in words:
            unsigned = _u32(value)
            out.extend((unsigned >> bit) & 0xF for bit in range(0, 32, 4))
        return out
    if transform in {"strip_top1", "strip_top2", "strip_top3"}:
        drop_count = int(transform[-1])
        drop_values = {value for value, _count in Counter(words).most_common(drop_count)}
        return [value for value in words if value not in drop_values]
    if transform.startswith("drop_head"):
        count = int(transform.removeprefix("drop_head"))
        return list(words[count:]) if len(words) > count else []
    if transform.startswith("drop_tail"):
        count = int(transform.removeprefix("drop_tail"))
        return list(words[:-count]) if len(words) > count else []
    if transform == "even_words":
        return list(words[::2])
    if transform == "odd_words":
        return list(words[1::2])
    return list(words)


def _v5_codec_spec(codec: str) -> tuple[str, str]:
    prefixes = {
        "tr_small_": "small",
        "tr_large_": "large",
        "tr_deltaabs_": "delta_abs",
        "tr_u16split_": "u16_split",
        "tr_u8split_": "u8_split",
        "tr_u4split_": "u4_split",
        "tr_strip1_": "strip_top1",
        "tr_strip2_": "strip_top2",
        "tr_strip3_": "strip_top3",
        "tr_head1_": "drop_head1",
        "tr_head2_": "drop_head2",
        "tr_head4_": "drop_head4",
        "tr_head8_": "drop_head8",
        "tr_head16_": "drop_head16",
        "tr_tail1_": "drop_tail1",
        "tr_tail2_": "drop_tail2",
        "tr_even_": "even_words",
        "tr_odd_": "odd_words",
    }
    for prefix, transform in prefixes.items():
        if codec.startswith(prefix):
            return transform, codec[len(prefix) :]
    return "raw", codec


def _v5_run_len(word: int, mode: str) -> int:
    if mode == "abs":
        return abs(word)
    if mode == "u8":
        return _u32(word) & 0xFF
    if mode == "u16":
        return _u32(word) & 0xFFFF
    if mode == "u8h":
        return (_u32(word) >> 8) & 0xFF
    if mode == "u16h":
        return (_u32(word) >> 16) & 0xFFFF
    if mode == "m8":
        return abs(word) % 8
    if mode == "m16":
        return abs(word) % 16
    if mode == "m32":
        return abs(word) % 32
    if mode == "m64":
        return abs(word) % 64
    if mode == "pop":
        return _u32(word).bit_count()
    return abs(word)


def _v5_occ_set_to_coords(occ_set: set[int], size_x: int, size_y: int, size_z: int) -> list[tuple[int, int, int]]:
    coords: list[tuple[int, int, int]] = []
    for idx in sorted(occ_set):
        y = idx // (size_x * size_z)
        rem = idx % (size_x * size_z)
        z = rem // size_x
        x = rem % size_x
        if 0 <= x < size_x and 0 <= y < size_y and 0 <= z < size_z:
            coords.append((x, y, z))
    return coords


def _score_v5_occ_set(
    occ_set: set[int],
    *,
    filled_guess: int,
    size_x: int,
    size_y: int,
    size_z: int,
    codec: str,
) -> tuple[tuple[int, int, int, int, int, int], dict]:
    coords = _v5_occ_set_to_coords(occ_set, size_x, size_y, size_z)
    if not coords:
        return ((-10**9, -10**9, -10**9, -10**9, -10**9, -10**9), {})

    unique_points = set(coords)
    min_x = min(point[0] for point in unique_points)
    max_x = max(point[0] for point in unique_points)
    min_y = min(point[1] for point in unique_points)
    max_y = max(point[1] for point in unique_points)
    min_z = min(point[2] for point in unique_points)
    max_z = max(point[2] for point in unique_points)
    span_x = max_x - min_x + 1
    span_y = max_y - min_y + 1
    span_z = max_z - min_z + 1
    span_volume = span_x * span_y * span_z
    adjacency_pairs = 0
    supported_points = 0
    for point in unique_points:
        neighbors = 0
        x, y, z = point
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            if (x + dx, y + dy, z + dz) in unique_points:
                neighbors += 1
        if neighbors:
            supported_points += 1
            adjacency_pairs += neighbors
    adjacency_pairs //= 2

    count_error = abs(len(unique_points) - filled_guess)
    compactness_ppm = int((len(unique_points) * 1_000_000) / max(1, span_volume))
    support_ppm = int((supported_points * 1_000_000) / max(1, len(unique_points)))
    transform_penalty = codec.count("_")
    score = (
        -count_error,
        adjacency_pairs,
        support_ppm,
        compactness_ppm,
        len(unique_points),
        -transform_penalty,
    )
    return score, {
        "filled_guess": filled_guess,
        "filled_pred": len(unique_points),
        "count_error": count_error,
        "adjacency_pairs": adjacency_pairs,
        "supported_points": supported_points,
        "compactness": round(len(unique_points) / max(1, span_volume), 6),
        "bbox": {
            "min": {"x": min_x, "y": min_y, "z": min_z},
            "max": {"x": max_x, "y": max_y, "z": max_z},
            "size": {"x": span_x, "y": span_y, "z": span_z},
            "volume": span_volume,
        },
        "transform_penalty": transform_penalty,
    }


def _v5_decode_occ_set(words: list[int], volume: int, codec: str, token_word: int = 0, size_x: int = 0) -> set[int]:
    transform, core = _v5_codec_spec(codec)
    values = _v5_transform_words(words, transform)
    occ_set: set[int] = set()

    if core.startswith("word_"):
        for index, word in enumerate(values[:volume]):
            emit = (
                (core == "word_nonzero" and word != 0)
                or (core == "word_eq_1" and word == 1)
                or (core == "word_gt_1" and word > 1)
                or (core == "word_gt_0" and word > 0)
                or (core == "word_lt_0" and word < 0)
                or (core == "word_eq_m1" and word == -1)
                or (core == "word_abs_gt_1" and abs(word) > 1)
                or (core == "word_odd" and (word & 1) != 0)
            )
            if emit:
                occ_set.add(index)
        return occ_set

    if core in {"bit_lsb", "bit_msb"}:
        index = 0
        for word in values:
            unsigned = _u32(word)
            bits = range(32) if core == "bit_lsb" else range(31, -1, -1)
            for bit in bits:
                if index >= volume:
                    return occ_set
                if ((unsigned >> bit) & 1) != 0:
                    occ_set.add(index)
                index += 1
        return occ_set

    if core in {"bit_u8_lsb", "bit_u8_msb", "bit_u16_lsb", "bit_u16_msb"}:
        bit_width = 8 if "u8" in core else 16
        lsb_first = core.endswith("lsb")
        index = 0
        for word in values:
            unsigned = _u32(word)
            bits = range(bit_width) if lsb_first else range(bit_width - 1, -1, -1)
            for bit in bits:
                if index >= volume:
                    return occ_set
                if ((unsigned >> bit) & 1) != 0:
                    occ_set.add(index)
                index += 1
        return occ_set

    if core.startswith("rle_toggle_"):
        _tag, _toggle, len_mode, start = core.split("_")
        index = 0
        bit = 1 if start == "s1" else 0
        for word in values:
            run = _v5_run_len(word, len_mode)
            if run <= 0:
                bit = 1 - bit
                continue
            run = min(run, volume - index)
            if run <= 0:
                break
            if bit == 1:
                occ_set.update(range(index, index + run))
            index += run
            if index >= volume:
                break
            bit = 1 - bit
        return occ_set

    if core.startswith("skip_emit1_"):
        len_mode = core.split("_")[2]
        index = 0
        for word in values:
            index += max(0, _v5_run_len(word, len_mode))
            if index >= volume:
                break
            occ_set.add(index)
            index += 1
            if index >= volume:
                break
        return occ_set

    if core.startswith("skip_clear1_"):
        len_mode = core.split("_")[2]
        occ_set = set(range(volume))
        index = 0
        for word in values:
            index += max(0, _v5_run_len(word, len_mode))
            if index >= volume:
                break
            occ_set.discard(index)
            index += 1
            if index >= volume:
                break
        return occ_set

    if core.startswith("tok_seed_delta_"):
        len_mode = core.split("_")[3]
        index = token_word
        if 0 <= index < volume:
            occ_set.add(index)
        for word in values:
            index += max(0, _v5_run_len(word, len_mode))
            if index < 0 or index >= volume:
                break
            occ_set.add(index)
        return occ_set

    if core == "tok_diag_triplet":
        if volume <= 0 or size_x <= 1 or len(values) < 2:
            return occ_set
        g0 = abs(values[0])
        g1 = abs(values[1])
        if g0 <= 0 or g0 != g1:
            return occ_set
        if len(values) >= 3 and abs(values[2]) < 1_000_000:
            return occ_set
        left = (size_x - 1) - token_word
        center = g0 + token_word
        right = (2 * center) - left
        for idx in (left, center, right):
            if 0 <= idx < volume:
                occ_set.add(idx)
        return occ_set

    if core == "tok_col_stride_sx":
        if volume <= 0 or size_x <= 0 or not values:
            return occ_set
        start = token_word + abs(values[0])
        if not (0 <= start < volume):
            return occ_set
        return set(range(start, volume, size_x))

    return occ_set


def _v5_codec_bank() -> list[str]:
    core = [
        "word_nonzero",
        "word_eq_1",
        "word_gt_1",
        "word_gt_0",
        "word_lt_0",
        "word_eq_m1",
        "word_abs_gt_1",
        "word_odd",
        "bit_lsb",
        "bit_msb",
        "bit_u8_lsb",
        "bit_u8_msb",
        "bit_u16_lsb",
        "bit_u16_msb",
        "rle_toggle_abs_s0",
        "rle_toggle_abs_s1",
        "rle_toggle_u8_s0",
        "rle_toggle_u8_s1",
        "rle_toggle_u16_s0",
        "rle_toggle_u16_s1",
        "rle_toggle_u8h_s0",
        "rle_toggle_u8h_s1",
        "rle_toggle_u16h_s0",
        "rle_toggle_u16h_s1",
        "rle_toggle_m8_s0",
        "rle_toggle_m8_s1",
        "rle_toggle_m16_s0",
        "rle_toggle_m16_s1",
        "rle_toggle_m32_s0",
        "rle_toggle_m32_s1",
        "rle_toggle_m64_s0",
        "rle_toggle_m64_s1",
        "rle_toggle_pop_s0",
        "rle_toggle_pop_s1",
        "skip_emit1_abs",
        "skip_emit1_u8",
        "skip_emit1_u16",
        "skip_emit1_u8h",
        "skip_emit1_u16h",
        "skip_emit1_m8",
        "skip_emit1_m16",
        "skip_emit1_m32",
        "skip_emit1_m64",
        "skip_emit1_pop",
        "skip_clear1_abs",
        "skip_clear1_u8",
        "skip_clear1_u16",
        "skip_clear1_u8h",
        "skip_clear1_u16h",
        "skip_clear1_m8",
        "skip_clear1_m16",
        "skip_clear1_m32",
        "skip_clear1_m64",
        "skip_clear1_pop",
        "tok_seed_delta_abs",
        "tok_seed_delta_u8",
        "tok_seed_delta_u16",
        "tok_seed_delta_u8h",
        "tok_seed_delta_u16h",
        "tok_diag_triplet",
        "tok_col_stride_sx",
    ]
    bank = list(core)
    for codec in core:
        if codec.startswith("bit_") or codec.startswith("tok_diag_") or codec.startswith("tok_col_"):
            continue
        for prefix in (
            "tr_small_",
            "tr_large_",
            "tr_deltaabs_",
            "tr_u16split_",
            "tr_u8split_",
            "tr_u4split_",
            "tr_strip1_",
            "tr_strip2_",
            "tr_strip3_",
            "tr_head1_",
            "tr_head2_",
            "tr_head4_",
            "tr_head8_",
            "tr_head16_",
            "tr_tail1_",
            "tr_tail2_",
            "tr_even_",
            "tr_odd_",
        ):
            bank.append(f"{prefix}{codec}")
    return bank


def _decode_v5_occ_candidates(
    geom_words: list[int],
    *,
    volume: int,
    filled_guess: int,
    token_word: int,
    size_x: int,
    size_y: int,
    size_z: int,
) -> tuple[set[int], dict]:
    best_occ: set[int] = set()
    best_codec = "none"
    best_score = (-10**9, -10**9, -10**9, -10**9, -10**9, -10**9)
    best_details: dict = {}
    candidate_rows: list[dict] = []
    for codec in _v5_codec_bank():
        occ_set = _v5_decode_occ_set(geom_words, volume, codec, token_word, size_x)
        score, details = _score_v5_occ_set(
            occ_set,
            filled_guess=filled_guess,
            size_x=size_x,
            size_y=size_y,
            size_z=size_z,
            codec=codec,
        )
        if details:
            candidate_rows.append({"codec": codec, "score": score, **details})
        if score > best_score:
            best_score = score
            best_codec = codec
            best_occ = occ_set
            best_details = details
    candidate_rows.sort(
        key=lambda row: (row["score"], -row["count_error"], row["filled_pred"]),
        reverse=True,
    )
    return best_occ, {
        "strategy": "codec_bank_structural_scoring",
        "selected_codec": best_codec,
        "selected_score": list(best_score),
        "selected": best_details,
        "top_candidates": [
            {
                "codec": row["codec"],
                "filled_pred": row["filled_pred"],
                "count_error": row["count_error"],
                "adjacency_pairs": row["adjacency_pairs"],
                "compactness": row["compactness"],
            }
            for row in candidate_rows[:5]
        ],
    }


def _score_v5_coords(
    coords: list[tuple[int, int, int] | None],
    *,
    size_x: int,
    size_y: int,
    size_z: int,
) -> tuple[tuple[int, int, int, int, int, int, int], dict]:
    valid_points = [point for point in coords if point is not None]
    if not valid_points:
        return ((-1, -1, -1, -1, -1, -1, -1), {})

    unique_points = set(valid_points)
    unique_count = len(unique_points)
    valid_count = len(valid_points)
    duplicate_count = valid_count - unique_count

    min_x = min(point[0] for point in unique_points)
    max_x = max(point[0] for point in unique_points)
    min_y = min(point[1] for point in unique_points)
    max_y = max(point[1] for point in unique_points)
    min_z = min(point[2] for point in unique_points)
    max_z = max(point[2] for point in unique_points)
    span_x = max_x - min_x + 1
    span_y = max_y - min_y + 1
    span_z = max_z - min_z + 1
    span_volume = span_x * span_y * span_z

    adjacency_pairs = 0
    surface_supported = 0
    for x, y, z in unique_points:
        local_neighbors = 0
        for dx, dy, dz in (
            (1, 0, 0),
            (-1, 0, 0),
            (0, 1, 0),
            (0, -1, 0),
            (0, 0, 1),
            (0, 0, -1),
        ):
            neighbor = (x + dx, y + dy, z + dz)
            if neighbor in unique_points:
                local_neighbors += 1
        if local_neighbors:
            surface_supported += 1
            adjacency_pairs += local_neighbors
    adjacency_pairs //= 2

    mirrored_matches = sum(
        1
        for x, y, z in unique_points
        if (size_x - 1 - x, y, z) in unique_points
    )
    center_weighted = sum(
        1
        for x, _, _ in unique_points
        if abs((size_x - 1) - (2 * x)) <= 1
    )
    compactness_ppm = int((unique_count * 1_000_000) / max(1, span_volume))
    support_ppm = int((surface_supported * 1_000_000) / max(1, unique_count))

    score = (
        unique_count,
        adjacency_pairs,
        compactness_ppm,
        support_ppm,
        mirrored_matches,
        center_weighted,
        -duplicate_count,
    )
    details = {
        "valid_points": valid_count,
        "unique_points": unique_count,
        "duplicate_points": duplicate_count,
        "adjacency_pairs": adjacency_pairs,
        "surface_supported_points": surface_supported,
        "mirrored_matches": mirrored_matches,
        "center_weighted_points": center_weighted,
        "compactness": round(unique_count / max(1, span_volume), 6),
        "bbox": {
            "min": {"x": min_x, "y": min_y, "z": min_z},
            "max": {"x": max_x, "y": max_y, "z": max_z},
            "size": {"x": span_x, "y": span_y, "z": span_z},
            "volume": span_volume,
        },
    }
    return score, details


def _decode_v5_geometry_candidates(
    size_x: int,
    size_y: int,
    size_z: int,
    geometry_tokens: list[bytes],
) -> tuple[list[tuple[int, int, int] | None], dict]:
    best_coords: list[tuple[int, int, int] | None] = [None] * len(geometry_tokens)
    best_score = (-1, -1, -1, -1, -1, -1, -1)
    best_combo = (0, 1, 2)
    best_details: dict = {}
    candidate_summaries: list[dict] = []

    for combo in _v5_geometry_candidate_bank():
        coords: list[tuple[int, int, int] | None] = []
        for token in geometry_tokens:
            x, y, z = token[combo[0]], token[combo[1]], token[combo[2]]
            coords.append((x, y, z) if x < size_x and y < size_y and z < size_z else None)

        score, details = _score_v5_coords(coords, size_x=size_x, size_y=size_y, size_z=size_z)
        if details:
            candidate_summaries.append(
                {
                    "combo": combo,
                    "score": score,
                    "unique_points": details["unique_points"],
                    "valid_points": details["valid_points"],
                    "adjacency_pairs": details["adjacency_pairs"],
                    "compactness": details["compactness"],
                    "mirrored_matches": details["mirrored_matches"],
                }
            )
        if score > best_score:
            best_score = score
            best_combo = combo
            best_coords = coords
            best_details = details

    candidate_summaries.sort(
        key=lambda item: (
            item["score"],
            item["unique_points"],
            item["adjacency_pairs"],
            item["valid_points"],
        ),
        reverse=True,
    )
    return best_coords, {
        "strategy": "candidate_bank_structural_scoring",
        "candidate_count": len(candidate_summaries),
        "selected_combo": list(best_combo),
        "selected_score": list(best_score),
        "selected": best_details,
        "top_candidates": [
            {
                "combo": list(item["combo"]),
                "unique_points": item["unique_points"],
                "valid_points": item["valid_points"],
                "adjacency_pairs": item["adjacency_pairs"],
                "compactness": item["compactness"],
                "mirrored_matches": item["mirrored_matches"],
            }
            for item in candidate_summaries[:5]
        ],
    }


def _find_nearest_available_v5_point(
    preferred: tuple[int, int, int],
    *,
    used_positions: set[tuple[int, int, int]],
    size_x: int,
    size_y: int,
    size_z: int,
) -> tuple[int, int, int] | None:
    px, py, pz = preferred
    if 0 <= px < size_x and 0 <= py < size_y and 0 <= pz < size_z and preferred not in used_positions:
        return preferred

    max_radius = max(size_x, size_y, size_z)
    for radius in range(1, max_radius + 1):
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                for dz in range(-radius, radius + 1):
                    if abs(dx) + abs(dy) + abs(dz) != radius:
                        continue
                    point = (px + dx, py + dy, pz + dz)
                    if point in used_positions:
                        continue
                    x, y, z = point
                    if 0 <= x < size_x and 0 <= y < size_y and 0 <= z < size_z:
                        return point
    return None


def _parse_v5_records(data: bytes, matrix_name: str) -> tuple[QubicleDocument, dict]:
    if len(data) <= 9:
        raise BlueprintDecodeError("kiwib v5 blueprint is too small.")

    payload = _decompress_v5_payload(data)
    ints = _read_v5_ints(data)

    if len(payload) < 32 or len(ints) < 8:
        raise BlueprintDecodeError("kiwib v5 blueprint payload is too small.")
    if payload[:32] == (b"\x00" * 32):
        raise BlueprintDecodeError("Blueprint is an empty placeholder.")

    raw_pos_x = int(ints[0])
    raw_pos_y = int(ints[1])
    raw_pos_z = int(ints[2])
    size_x = int(ints[3])
    size_y = int(ints[4])
    size_z = int(ints[5])
    filled_guess = int(ints[6])
    token_word = int(ints[7])
    volume = size_x * size_y * size_z
    if size_x <= 0 or size_y <= 0 or size_z <= 0 or filled_guess <= 0 or volume <= 0:
        raise BlueprintDecodeError("kiwib v5 blueprint header is invalid.")

    tail_words = _v5_tail_words_from_ints(ints, filled_guess)
    if not tail_words or len(tail_words) >= max(0, len(ints) - 8):
        raise BlueprintDecodeError("Unsupported kiwib v5 blueprint token layout.")
    geom_words = [int(word) for word in ints[8 : len(ints) - len(tail_words)]]
    if not geom_words:
        raise BlueprintDecodeError("Unsupported kiwib v5 geometry stream layout.")

    origin_mode = "raw"
    pos_x, pos_y, pos_z = _v5_origin_from_ints(ints, size_x, size_y, size_z, origin_mode)
    occ_set, geometry_info = _decode_v5_occ_candidates(
        geom_words,
        volume=volume,
        filled_guess=filled_guess,
        token_word=token_word,
        size_x=size_x,
        size_y=size_y,
        size_z=size_z,
    )
    coords = _v5_occ_set_to_coords(occ_set, size_x, size_y, size_z)
    if not coords:
        raise BlueprintDecodeError("kiwib v5 occupancy decode produced no visible voxels.")

    color_layout = _v5_detect_tail_layout(tail_words)
    color_stream = _v5_tail_words_to_stream(tail_words, color_layout)
    voxels: list[tuple[int, int, int, int, int, int, int]] = []
    visible_color_count = 0
    if color_stream:
        for index, (x, y, z) in enumerate(coords):
            rgb = color_stream[index % len(color_stream)] & 0xFFFFFF
            r = (rgb >> 16) & 0xFF
            g = (rgb >> 8) & 0xFF
            b = rgb & 0xFF
            alpha = 1 if (r or g or b) else 0
            if alpha <= 0:
                continue
            visible_color_count += 1
            voxels.append((x, y, z, r, g, b, alpha))
    else:
        voxels = [(x, y, z, 255, 255, 255, 1) for x, y, z in coords]

    if not voxels:
        raise BlueprintDecodeError("kiwib v5 occupancy decode produced no visible voxels.")

    document = _build_bounded_document(matrix_name, size_x, size_y, size_z, pos_x, pos_y, pos_z, voxels)
    decode_info = {
        "version": 5,
        "kind": "trove_blueprint_v5_occ_decode",
        "matrix_name": matrix_name,
        "header": {
            "pos_x": raw_pos_x,
            "pos_y": raw_pos_y,
            "pos_z": raw_pos_z,
            "size_x": size_x,
            "size_y": size_y,
            "size_z": size_z,
            "filled_guess": filled_guess,
            "token_word": token_word,
            "volume": volume,
        },
        "origin": {
            "mode": origin_mode,
            "raw": {"x": raw_pos_x, "y": raw_pos_y, "z": raw_pos_z},
            "resolved": {"x": pos_x, "y": pos_y, "z": pos_z},
            "modes_considered": _v5_origin_mode_bank(size_x, size_y, size_z),
        },
        "geometry": geometry_info | {
            "geom_word_count": len(geom_words),
            "occupied_count": len(coords),
        },
        "colors": {
            "layout": color_layout,
            "tail_word_count": len(tail_words),
            "stream_length": len(color_stream),
            "unique_colors": len({rgb & 0xFFFFFF for rgb in color_stream}),
        },
        "visible_color_count": visible_color_count,
        "decoded_voxel_count": len(voxels),
        "used_white_fallback": bool(not color_stream),
    }
    return document, decode_info


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
        decode_info = {
            "version": 3,
            "kind": "trove_blueprint_v3_records",
            "matrix_name": matrix_name,
            "decoded_voxel_count": sum(len(matrix.voxels) for matrix in document.matrices),
        }
    elif version == 4:
        document = _parse_v4_records(data, matrix_name)
        source_format = "trove_blueprint_v4"
        decode_info = {
            "version": 4,
            "kind": "trove_blueprint_v4_records",
            "matrix_name": matrix_name,
            "decoded_voxel_count": sum(len(matrix.voxels) for matrix in document.matrices),
        }
    elif version == 5:
        document, decode_info = _parse_v5_records(data, matrix_name)
        source_format = "trove_blueprint_v5_occ"
    else:
        raise BlueprintDecodeError(f"Unsupported kiwib blueprint version: {version}.")
    return _document_payload(document, source_format=source_format, decode_info=decode_info)
