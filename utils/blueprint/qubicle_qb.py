from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from typing import Iterable


QB_CODEFLAG = 2
QB_NEXTSLICEFLAG = 6
QB_VERSION_DEFAULT = int.from_bytes(bytes((1, 1, 0, 0)), "little")


def _read_exact(stream: BytesIO, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise ValueError("Unexpected end of QB data.")
    return data


def _read_u8(stream: BytesIO) -> int:
    return _read_exact(stream, 1)[0]


def _read_u32(stream: BytesIO) -> int:
    return int.from_bytes(_read_exact(stream, 4), "little", signed=False)


def _read_i32(stream: BytesIO) -> int:
    return int.from_bytes(_read_exact(stream, 4), "little", signed=True)


def _write_u8(stream: BytesIO, value: int) -> None:
    stream.write(int(value).to_bytes(1, "little", signed=False))


def _write_u32(stream: BytesIO, value: int) -> None:
    stream.write(int(value).to_bytes(4, "little", signed=False))


def _write_i32(stream: BytesIO, value: int) -> None:
    stream.write(int(value).to_bytes(4, "little", signed=True))


def version_to_label(version: int) -> str:
    return ".".join(str(part) for part in int(version).to_bytes(4, "little", signed=False))


def pack_color(color_format: int, r: int, g: int, b: int, a: int) -> int:
    if color_format == 0:
        order = (r, g, b, a)
    elif color_format == 1:
        order = (b, g, r, a)
    else:
        raise ValueError(f"Unsupported QB color format: {color_format}")
    return int.from_bytes(bytes(order), "little", signed=False)


def unpack_color(color_format: int, raw: int) -> tuple[int, int, int, int]:
    c0, c1, c2, c3 = int(raw).to_bytes(4, "little", signed=False)
    if color_format == 0:
        return c0, c1, c2, c3
    if color_format == 1:
        return c2, c1, c0, c3
    raise ValueError(f"Unsupported QB color format: {color_format}")


def is_visible_voxel(alpha_or_mask: int) -> bool:
    return int(alpha_or_mask) > 0


def _require_u32(value: int, label: str) -> int:
    value = int(value)
    if value < 0 or value > 0xFFFFFFFF:
        raise ValueError(f"{label} must be between 0 and 4294967295.")
    return value


def _require_i32(value: int, label: str) -> int:
    value = int(value)
    if value < -0x80000000 or value > 0x7FFFFFFF:
        raise ValueError(f"{label} must fit inside a signed 32-bit integer.")
    return value


def _require_u8(value: int, label: str) -> int:
    value = int(value)
    if value < 0 or value > 255:
        raise ValueError(f"{label} must be between 0 and 255.")
    return value


@dataclass(slots=True)
class QubicleHeader:
    version: int = QB_VERSION_DEFAULT
    color_format: int = 0
    z_axis_orientation: int = 1
    compressed: bool = True
    visibility_mask_encoded: bool = False

    @classmethod
    def from_dict(cls, payload: dict | None) -> "QubicleHeader":
        payload = payload or {}
        header = cls(
            version=int(payload.get("version", QB_VERSION_DEFAULT)),
            color_format=int(payload.get("color_format", 0)),
            z_axis_orientation=int(payload.get("z_axis_orientation", 1)),
            compressed=bool(payload.get("compressed", True)),
            visibility_mask_encoded=bool(payload.get("visibility_mask_encoded", False)),
        )
        header.validate()
        return header

    def validate(self) -> None:
        self.version = _require_u32(self.version, "QB version")
        if self.color_format not in (0, 1):
            raise ValueError("QB color_format must be 0 (RGBA) or 1 (BGRA).")
        if self.z_axis_orientation not in (0, 1):
            raise ValueError("QB z_axis_orientation must be 0 (left-handed) or 1 (right-handed).")

    def to_dict(self) -> dict:
        return {
            "version": int(self.version),
            "version_label": version_to_label(self.version),
            "color_format": int(self.color_format),
            "z_axis_orientation": int(self.z_axis_orientation),
            "compressed": bool(self.compressed),
            "visibility_mask_encoded": bool(self.visibility_mask_encoded),
        }


@dataclass(slots=True)
class QubicleVoxel:
    x: int
    y: int
    z: int
    r: int
    g: int
    b: int
    a: int

    @classmethod
    def from_iterable(cls, payload: Iterable[int]) -> "QubicleVoxel":
        values = list(payload)
        if len(values) != 7:
            raise ValueError("QB voxels must contain [x, y, z, r, g, b, a].")
        return cls(*(int(value) for value in values))

    def validate(self, size_x: int, size_y: int, size_z: int) -> None:
        self.x = int(self.x)
        self.y = int(self.y)
        self.z = int(self.z)
        if self.x < 0 or self.x >= size_x:
            raise ValueError(f"Voxel x={self.x} is outside matrix width {size_x}.")
        if self.y < 0 or self.y >= size_y:
            raise ValueError(f"Voxel y={self.y} is outside matrix height {size_y}.")
        if self.z < 0 or self.z >= size_z:
            raise ValueError(f"Voxel z={self.z} is outside matrix depth {size_z}.")
        self.r = _require_u8(self.r, "Voxel red channel")
        self.g = _require_u8(self.g, "Voxel green channel")
        self.b = _require_u8(self.b, "Voxel blue channel")
        self.a = _require_u8(self.a, "Voxel alpha/mask channel")

    def to_list(self) -> list[int]:
        return [self.x, self.y, self.z, self.r, self.g, self.b, self.a]


@dataclass(slots=True)
class QubicleMatrix:
    name: str
    size_x: int
    size_y: int
    size_z: int
    pos_x: int = 0
    pos_y: int = 0
    pos_z: int = 0
    voxels: list[QubicleVoxel] = field(default_factory=list)

    @classmethod
    def from_dict(cls, payload: dict | None) -> "QubicleMatrix":
        payload = payload or {}
        matrix = cls(
            name=str(payload.get("name", "Matrix")),
            size_x=int(payload.get("size_x", 16)),
            size_y=int(payload.get("size_y", 16)),
            size_z=int(payload.get("size_z", 16)),
            pos_x=int(payload.get("pos_x", 0)),
            pos_y=int(payload.get("pos_y", 0)),
            pos_z=int(payload.get("pos_z", 0)),
            voxels=[QubicleVoxel.from_iterable(voxel) for voxel in payload.get("voxels", []) or []],
        )
        matrix.validate()
        return matrix

    def validate(self) -> None:
        encoded_name = self.name.encode("utf-8")
        if not encoded_name:
            raise ValueError("QB matrix names cannot be empty.")
        if len(encoded_name) > 255:
            raise ValueError("QB matrix names must be 255 UTF-8 bytes or fewer.")

        self.size_x = int(self.size_x)
        self.size_y = int(self.size_y)
        self.size_z = int(self.size_z)
        if self.size_x <= 0 or self.size_y <= 0 or self.size_z <= 0:
            raise ValueError("QB matrix dimensions must be at least 1 in every axis.")

        self.pos_x = _require_i32(self.pos_x, "Matrix pos_x")
        self.pos_y = _require_i32(self.pos_y, "Matrix pos_y")
        self.pos_z = _require_i32(self.pos_z, "Matrix pos_z")

        deduped: dict[tuple[int, int, int], QubicleVoxel] = {}
        for voxel in self.voxels:
            voxel.validate(self.size_x, self.size_y, self.size_z)
            if not is_visible_voxel(voxel.a):
                continue
            deduped[(voxel.x, voxel.y, voxel.z)] = voxel
        self.voxels = sorted(deduped.values(), key=lambda voxel: (voxel.z, voxel.y, voxel.x))

    def voxel_lookup(self, color_format: int) -> dict[tuple[int, int, int], int]:
        lookup: dict[tuple[int, int, int], int] = {}
        for voxel in self.voxels:
            lookup[(voxel.x, voxel.y, voxel.z)] = pack_color(color_format, voxel.r, voxel.g, voxel.b, voxel.a)
        return lookup

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "size_x": int(self.size_x),
            "size_y": int(self.size_y),
            "size_z": int(self.size_z),
            "pos_x": int(self.pos_x),
            "pos_y": int(self.pos_y),
            "pos_z": int(self.pos_z),
            "voxel_count": len(self.voxels),
            "voxels": [voxel.to_list() for voxel in self.voxels],
        }


@dataclass(slots=True)
class QubicleDocument:
    header: QubicleHeader = field(default_factory=QubicleHeader)
    matrices: list[QubicleMatrix] = field(default_factory=list)

    @classmethod
    def from_bytes(cls, data: bytes) -> "QubicleDocument":
        stream = BytesIO(data)
        header = QubicleHeader(
            version=_read_u32(stream),
            color_format=_read_u32(stream),
            z_axis_orientation=_read_u32(stream),
            compressed=bool(_read_u32(stream)),
            visibility_mask_encoded=bool(_read_u32(stream)),
        )
        matrix_count = _read_u32(stream)
        header.validate()

        matrices: list[QubicleMatrix] = []
        for _ in range(matrix_count):
            name_length = _read_u8(stream)
            name = _read_exact(stream, name_length).decode("utf-8", errors="replace")
            size_x = _read_u32(stream)
            size_y = _read_u32(stream)
            size_z = _read_u32(stream)
            pos_x = _read_i32(stream)
            pos_y = _read_i32(stream)
            pos_z = _read_i32(stream)

            voxels: list[QubicleVoxel] = []
            if header.compressed:
                slice_size = size_x * size_y
                for z in range(size_z):
                    index = 0
                    while True:
                        token = _read_u32(stream)
                        if token == QB_NEXTSLICEFLAG:
                            break
                        if token == QB_CODEFLAG:
                            run_length = _read_u32(stream)
                            raw_color = _read_u32(stream)
                            if index + run_length > slice_size:
                                raise ValueError("Compressed QB slice overflows matrix bounds.")
                            for _ in range(run_length):
                                x = index % size_x
                                y = index // size_x
                                r, g, b, a = unpack_color(header.color_format, raw_color)
                                if is_visible_voxel(a):
                                    voxels.append(QubicleVoxel(x=x, y=y, z=z, r=r, g=g, b=b, a=a))
                                index += 1
                        else:
                            if index >= slice_size:
                                raise ValueError("Compressed QB slice overflows matrix bounds.")
                            x = index % size_x
                            y = index // size_x
                            r, g, b, a = unpack_color(header.color_format, token)
                            if is_visible_voxel(a):
                                voxels.append(QubicleVoxel(x=x, y=y, z=z, r=r, g=g, b=b, a=a))
                            index += 1
                    if index != slice_size:
                        raise ValueError("Compressed QB slice ended before filling the declared matrix size.")
            else:
                for z in range(size_z):
                    for y in range(size_y):
                        for x in range(size_x):
                            raw_color = _read_u32(stream)
                            r, g, b, a = unpack_color(header.color_format, raw_color)
                            if is_visible_voxel(a):
                                voxels.append(QubicleVoxel(x=x, y=y, z=z, r=r, g=g, b=b, a=a))

            matrix = QubicleMatrix(
                name=name,
                size_x=size_x,
                size_y=size_y,
                size_z=size_z,
                pos_x=pos_x,
                pos_y=pos_y,
                pos_z=pos_z,
                voxels=voxels,
            )
            matrix.validate()
            matrices.append(matrix)

        document = cls(header=header, matrices=matrices)
        document.validate()
        return document

    @classmethod
    def from_dict(cls, payload: dict | None) -> "QubicleDocument":
        payload = payload or {}
        document = cls(
            header=QubicleHeader.from_dict(payload.get("header")),
            matrices=[QubicleMatrix.from_dict(matrix) for matrix in payload.get("matrices", []) or []],
        )
        document.validate()
        return document

    def validate(self) -> None:
        self.header.validate()
        self.matrices = list(self.matrices or [])
        for matrix in self.matrices:
            matrix.validate()

    def to_dict(self) -> dict:
        self.validate()
        return {
            "header": self.header.to_dict(),
            "matrix_count": len(self.matrices),
            "matrices": [matrix.to_dict() for matrix in self.matrices],
        }

    def to_bytes(self) -> bytes:
        self.validate()
        stream = BytesIO()

        _write_u32(stream, self.header.version)
        _write_u32(stream, self.header.color_format)
        _write_u32(stream, self.header.z_axis_orientation)
        _write_u32(stream, 1 if self.header.compressed else 0)
        _write_u32(stream, 1 if self.header.visibility_mask_encoded else 0)
        _write_u32(stream, len(self.matrices))

        for matrix in self.matrices:
            name_bytes = matrix.name.encode("utf-8")
            _write_u8(stream, len(name_bytes))
            stream.write(name_bytes)
            _write_u32(stream, matrix.size_x)
            _write_u32(stream, matrix.size_y)
            _write_u32(stream, matrix.size_z)
            _write_i32(stream, matrix.pos_x)
            _write_i32(stream, matrix.pos_y)
            _write_i32(stream, matrix.pos_z)

            lookup = matrix.voxel_lookup(self.header.color_format)
            if self.header.compressed:
                for z in range(matrix.size_z):
                    slice_values: list[int] = []
                    for y in range(matrix.size_y):
                        for x in range(matrix.size_x):
                            slice_values.append(lookup.get((x, y, z), 0))

                    index = 0
                    while index < len(slice_values):
                        current = slice_values[index]
                        run_length = 1
                        while index + run_length < len(slice_values) and slice_values[index + run_length] == current:
                            run_length += 1

                        if run_length > 1 or current in (QB_CODEFLAG, QB_NEXTSLICEFLAG):
                            _write_u32(stream, QB_CODEFLAG)
                            _write_u32(stream, run_length)
                            _write_u32(stream, current)
                        else:
                            _write_u32(stream, current)
                        index += run_length

                    _write_u32(stream, QB_NEXTSLICEFLAG)
            else:
                for z in range(matrix.size_z):
                    for y in range(matrix.size_y):
                        for x in range(matrix.size_x):
                            _write_u32(stream, lookup.get((x, y, z), 0))

        return stream.getvalue()
