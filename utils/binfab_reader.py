"""Grounded Trove .binfab reader (wire format reverse-engineered from Trove.exe).

Unlike the older heuristic string-scanning, this reads prefab data as the real
self-describing fields the game's reflection serializer writes.

Wire grammar (exe-confirmed, FUN_00ae7710 / FUN_00520db0 / FUN_00b94280):
  each field = uleb128 key;  field = key >> 4,  wt = key & 0xF
    wt 0 = unsigned varint      wt 2 = signed varint (zigzag)
    wt 4 = fixed32 (4 bytes)     wt 6 = fixed64 (8 bytes)
    wt 8 = length-prefixed (uleb len + bytes: ascii string OR nested message)
    wt E = composite marker (object / vector / map; framing is schema-driven)
  Header (entity prefabs): <u8 fmt> 00 <uleb content_len>, content_len == len - hdr.

Composite (wt E) nesting is schema-driven and Trove's schema is not extractable as
data, so we parse the leading *flat* run precisely (covers the identity/metadata
component every entity prefab opens) and additionally harvest every length-prefixed
string anywhere (desync-proof). stdlib-only -> works in desktop AND web builds.
"""
from __future__ import annotations

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


def unzig(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


def content_start(data: bytes) -> int:
    """Offset of the field stream after the <fmt> 00 <uleb len> header, else 0."""
    if len(data) >= 4 and data[1] == 0:
        try:
            length, pos = read_uleb(data, 2)
            if pos + length == len(data):
                return pos
        except (IndexError, ValueError):
            pass
    return 0


def parse_flat(data: bytes, start: int | None = None) -> tuple[list[dict], int]:
    """Parse the leading flat field run; stop at the 2nd composite marker (end of
    the identity component) or on an anomaly. Returns (fields, end_pos)."""
    if start is None:
        start = content_start(data)
    pos = start
    n = len(data)
    fields: list[dict] = []
    markers = 0
    while pos < n:
        kstart = pos
        try:
            key, pos = read_uleb(data, pos)
        except (IndexError, ValueError):
            break
        field, wt = key >> 4, key & 0xF
        try:
            if wt == 0:
                value, pos = read_uleb(data, pos)
                fields.append({"off": kstart, "field": field, "wt": wt, "value": value})
            elif wt == 2:
                value, pos = read_uleb(data, pos)
                fields.append({"off": kstart, "field": field, "wt": wt, "value": unzig(value)})
            elif wt == 4:
                raw = data[pos:pos + 4]
                pos += 4
                fields.append({"off": kstart, "field": field, "wt": wt,
                               "u32": int.from_bytes(raw, "little"),
                               "f32": struct.unpack("<f", raw)[0] if len(raw) == 4 else None})
            elif wt == 6:
                raw = data[pos:pos + 8]
                pos += 8
                fields.append({"off": kstart, "field": field, "wt": wt,
                               "u64": int.from_bytes(raw, "little")})
            elif wt == 8:
                length, pos = read_uleb(data, pos)
                if pos + length > n:
                    break  # implausible length -> end of reliable flat run
                raw = data[pos:pos + length]
                pos += length
                text = raw.decode("latin1") if raw and all(32 <= b < 127 for b in raw) else None
                fields.append({"off": kstart, "field": field, "wt": wt,
                               "len": length, "str": text})
            else:
                fields.append({"off": kstart, "field": field, "wt": wt, "marker": True})
                markers += 1
                if markers > 1:
                    break
        except (IndexError, struct.error):
            break
    return fields, pos


def parse_message(data: bytes, start: int | None = None, end: int | None = None) -> list[dict]:
    """Recursive parse. Unlike parse_flat, this descends into `wt 8` payloads that
    aren't ascii (they are length-prefixed nested sub-messages). Because the length
    is exact, the parent stays in sync even if a child sub-scope is messy, so this
    decodes nested structure (costs, requirement objects, node trees, ...) that the
    flat pass can't. Validated on ProgressionSystemData (gearcrafting): costs and
    requirement mins decode exactly.

    Each returned field is a dict with `field`, `wt`, and one of:
      `value` (uleb; for wt0 also `zz`=zigzag) · `f32`+`u32` · `u64` ·
      `str` · `msg` (list of child fields) · `bytes` (opaque) · `marker`=True.
    Note `wt E`/odd-nibble *group* markers carry no length and are schema-framed, so
    deeply-nested object/vector boundaries inside a sub-message can still be noisy —
    but that noise is contained to that length-delimited sub-message.
    """
    if start is None:
        start = content_start(data)
    if end is None:
        end = len(data)
    out: list[dict] = []
    pos = start
    while pos < end:
        try:
            key, pos = read_uleb(data, pos)
        except (IndexError, ValueError):
            break
        field, wt = key >> 4, key & 0xF
        try:
            if wt == 0:
                v, pos = read_uleb(data, pos)
                out.append({"field": field, "wt": wt, "value": v, "zz": unzig(v)})
            elif wt == 2:
                v, pos = read_uleb(data, pos)
                out.append({"field": field, "wt": wt, "value": unzig(v), "raw": v})
            elif wt == 4:
                raw = data[pos:pos + 4]
                pos += 4
                out.append({"field": field, "wt": wt, "u32": int.from_bytes(raw, "little"),
                            "f32": struct.unpack("<f", raw)[0] if len(raw) == 4 else None})
            elif wt == 6:
                raw = data[pos:pos + 8]
                pos += 8
                out.append({"field": field, "wt": wt, "u64": int.from_bytes(raw, "little"),
                            "hex": raw.hex()})
            elif wt == 8:
                ln, pos = read_uleb(data, pos)
                if pos + ln > end:
                    break
                raw = data[pos:pos + ln]
                child_start = pos
                pos += ln           # parent sync guaranteed regardless of child
                if ln >= 1 and all(32 <= b < 127 for b in raw):
                    out.append({"field": field, "wt": wt, "str": raw.decode("latin1")})
                else:
                    out.append({"field": field, "wt": wt,
                                "msg": parse_message(data, child_start, child_start + ln)})
            else:
                out.append({"field": field, "wt": wt, "marker": True})
        except (IndexError, struct.error):
            break
    return out


def iter_fields(msg: list[dict], _path: str = ""):
    """Walk a parse_message() tree depth-first, yielding (path, field_dict).
    path is like 'f0.f1.f5'. Handy for harvesting scalars/strings from nested data."""
    for f in msg:
        p = f"{_path}.f{f['field']}" if _path else f"f{f['field']}"
        yield p, f
        if "msg" in f:
            yield from iter_fields(f["msg"], p)


def decode_identity(data: bytes) -> dict | None:
    """Grounded read of the identity/metadata component every entity prefab opens.
    Replaces string-scan name/desc + the \\xE0\\x01 tradability heuristic.

    Returns None when no identity component is present (recipes / collection tables
    / locale string-tables have a different structure -- use harvest_strings there).

    Identity fields (exact, stable across collectibles / items / placeables):
        f1 str = localization name key ($prefabs_..._name)
        f2 str = display category ("Pets and Mounts" / "Items" / "Decoration" ...)
        f5 str = localization description key
        f8..f25 = unsigned flag bytes;  f14 == 2  =>  Tradable
    """
    fields, _ = parse_flat(data)
    markers = 0
    inside: dict[tuple[str, int], object] = {}
    for f in fields:
        if f.get("marker"):
            markers += 1
            if markers > 1:
                break
            continue
        if markers != 1:           # only the first (identity) object's own fields
            continue
        kind = "s" if "str" in f else ("v" if "value" in f else None)
        if kind:
            inside.setdefault((kind, f["field"]), f.get("str", f.get("value")))
    if not inside:
        return None
    trade = inside.get(("v", 14))
    return {
        "name_key": inside.get(("s", 1)),
        "category": inside.get(("s", 2)),
        "desc_key": inside.get(("s", 5)),
        "tradable": (trade == 2) if trade is not None else None,
        "flags": {fnum: val for (kind, fnum), val in inside.items() if kind == "v"},
    }


def parse_collection_table(data: bytes) -> list[dict]:
    """Decode a collections/collection_{pet,mount,memento,...} table into category
    groups. Each group: {"id", "name_key", "members": [collection-path, ...]}.

    Layout (grounded): root Vector of groups; each group = f0 str <category id>,
    f1 str <$CollectionName_* loc key>, then a members Vector of f0-string paths
    (collections/<type>/<key>). The harvested strings arrive in exactly that order,
    so we group by walking them: a "$CollectionName_*" key starts a new group whose
    id is the immediately preceding bare token; "collections/..." strings are members.
    """
    groups: list[dict] = []
    prev_bare = ""
    cur: dict | None = None
    for _off, _field, s in harvest_strings(data):
        if s.startswith("$CollectionName"):
            cur = {"id": prev_bare or s.removeprefix("$CollectionName_"),
                   "name_key": s, "members": []}
            groups.append(cur)
        elif s.startswith("collections/"):
            if cur is not None:
                cur["members"].append(s)
        elif "/" not in s and not s.startswith("$"):
            prev_bare = s
    return groups


def collection_category_map(data: bytes) -> dict[str, str]:
    """member collection-path (lowercased) -> category id, from a collection table."""
    out: dict[str, str] = {}
    for g in parse_collection_table(data):
        for m in g["members"]:
            out.setdefault(m.replace("\\", "/").lower(), g["id"])
    return out


def harvest_strings(data: bytes, min_len: int = 2, max_len: int = 512) -> list[tuple[int, int, str]]:
    """Desync-proof scan for every length-prefixed ascii string: <key wt8> <uleb len>
    <printable bytes>. Returns [(offset, field, text), ...]."""
    out: list[tuple[int, int, str]] = []
    n = len(data)
    for i in range(n - 1):
        try:
            key, j = read_uleb(data, i)   # (possibly multi-byte) uleb field key
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
