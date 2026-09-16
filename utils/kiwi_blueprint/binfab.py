"""Creature rig bindings and identity, from KiwiAPI's ``app/trove/codexes/binfab.py``."""
from __future__ import annotations

import re
import struct


def read_uleb(data: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("uleb128 too long")


def read_varint(data: bytes, offset: int) -> tuple[int | None, int]:
    value = shift = 0
    cursor = offset
    while cursor < len(data) and shift <= 63:
        byte = data[cursor]
        value |= (byte & 0x7F) << shift
        cursor += 1
        if not (byte & 0x80):
            return value, cursor
        shift += 7
    return None, offset


def unzig(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


def content_start(data: bytes) -> int:
    if len(data) >= 4 and data[1] == 0:
        try:
            length, pos = read_uleb(data, 2)
            if pos + length == len(data):
                return pos
        except (IndexError, ValueError):
            pass
    return 0


def _marker_blocks(data: bytes) -> list[dict[tuple[str, int], object]]:
    pos = content_start(data)
    n = len(data)
    blocks: list[dict[tuple[str, int], object]] = []
    cur: dict[tuple[str, int], object] | None = None
    while pos < n:
        try:
            key, pos = read_uleb(data, pos)
        except (IndexError, ValueError):
            break
        field, wt = key >> 4, key & 0xF
        try:
            if wt in (0, 2):
                value, pos = read_uleb(data, pos)
                if cur is not None:
                    cur.setdefault(("v", field), unzig(value) if wt == 2 else value)
            elif wt == 4:
                pos += 4
            elif wt == 6:
                pos += 8
            elif wt == 8:
                length, pos = read_uleb(data, pos)
                if pos + length > n:
                    break
                raw = data[pos:pos + length]
                pos += length
                if cur is not None:
                    text = raw.decode("latin1") if raw and all(32 <= b < 127 for b in raw) else None
                    cur.setdefault(("s", field), text)
            else:
                cur = {}
                blocks.append(cur)
        except (IndexError, struct.error):
            break
    return blocks


def decode_identity(data: bytes) -> dict | None:
    """The identity component: name/description loc keys and display category."""
    blocks = _marker_blocks(data)
    if not blocks:
        return None
    ident = blocks[0]
    if not ident.get(("s", 1)):
        ident = next((b for b in blocks
                      if isinstance(b.get(("s", 1)), str) and b[("s", 1)].startswith("$")),
                     ident)
    if not ident:
        return None
    return {"name_key": ident.get(("s", 1)), "category": ident.get(("s", 2))}


def harvest_strings(data: bytes, min_len: int = 2, max_len: int = 512) -> list[tuple[int, int, str]]:
    out: list[tuple[int, int, str]] = []
    n = len(data)
    for i in range(n - 1):
        try:
            key, j = read_uleb(data, i)
        except (IndexError, ValueError):
            continue
        if (key & 0xF) != 8:
            continue
        try:
            length, k = read_uleb(data, j)
        except (IndexError, ValueError):
            continue
        if min_len <= length <= max_len and k + length <= n:
            raw = data[k:k + length]
            if all(32 <= b < 127 for b in raw):
                out.append((i, key >> 4, raw.decode("ascii")))
    return out


def _real_fields(data: bytes) -> list[tuple[int, int, str]]:
    out: list[tuple[int, int, str]] = []
    last_end = -1
    for off, field, text in harvest_strings(data):
        try:
            _key, j = read_uleb(data, off)
            length, k = read_uleb(data, j)
        except (IndexError, ValueError):
            continue
        if k >= last_end:
            out.append((off, field, text))
            last_end = k + length
    return out


def extract_rig_refs(data: bytes) -> dict | None:
    """``{"skeleton", "parts": {basename: ap}, "refs", "scales", "head_scale"}`` for a
    creature prefab, read from the wire structure; None for non-creatures."""
    rows = _real_fields(data)
    skeleton: str | None = None
    skel_off = gsf_off = next_skel_off = None
    for off, _field, s in rows:
        base = s.rsplit("/", 1)[-1].lower()
        if base.endswith(".skeleton.gr2"):
            if skeleton is None:
                skeleton, skel_off = base[: -len(".skeleton.gr2")], off
            elif next_skel_off is None:
                next_skel_off = off
        elif gsf_off is None and base.endswith(".gsf"):
            gsf_off = off
    if skeleton is None or skel_off is None:
        return None
    ends = [o for o in (gsf_off, next_skel_off) if o is not None and o > skel_off]
    end = min(ends) if ends else len(data)

    parts: dict[str, str] = {}
    refs: dict[str, str] = {}
    scales: dict[str, float] = {}
    last_ap_end = skel_off
    for (off, field, s), (n_off, n_field, n_s) in zip(rows, rows[1:], strict=False):
        if not (skel_off < off < end):
            continue
        if field == 0 and n_field == 1 and n_s.startswith("AP_"):
            ref = s.replace("\\", "/").lower()
            base = ref.rsplit("/", 1)[-1]
            parts[base] = n_s[3:].lower()
            refs[base] = ref
            last_ap_end = _field_end(data, n_off)
            scales[base] = _mesh_scale(data, last_ap_end)
    if not parts:
        return None
    head_scale = _head_scale(data, last_ap_end, next_skel_off or len(data))
    return {"skeleton": skeleton, "parts": parts, "refs": refs,
            "scales": {b: v for b, v in scales.items() if v != 1.0}, "head_scale": head_scale}


_HEAD_SCALE_RE = re.compile(rb"\x1e\x1e\x08\x24(.{4})", re.S)
_HEAD_SCALE_WINDOW = 96


def _field_end(data: bytes, off: int) -> int:
    _key, j = read_uleb(data, off)
    length, k = read_uleb(data, j)
    return k + length


def _f32_scale(raw: bytes) -> float:
    v = struct.unpack("<f", raw)[0]
    return v if 0.0 < v <= 16.0 else 1.0


def _mesh_scale(data: bytes, pos: int) -> float:
    prev = 1
    for _ in range(4):
        key, nxt = read_varint(data, pos)
        if key is None:
            break
        fld, wire = key >> 4, key & 0xF
        if fld <= prev:
            break
        prev = fld
        if wire == 4:
            if nxt + 4 > len(data):
                break
            if fld == 3:
                return _f32_scale(data[nxt:nxt + 4])
            pos = nxt + 4
        elif wire == 8:
            length, nxt = read_varint(data, nxt)
            if length is None:
                break
            pos = nxt + length
        elif wire == 0:
            value, nxt = read_varint(data, nxt)
            if value is None:
                break
            pos = nxt
        else:
            break
    return 1.0


def _head_scale(data: bytes, start: int, stop: int) -> float:
    m = _HEAD_SCALE_RE.search(data, start, min(stop, start + _HEAD_SCALE_WINDOW))
    return _f32_scale(m.group(1)) if m else 1.0
