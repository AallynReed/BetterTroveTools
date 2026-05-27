"""Dynamic Trove block registry, decoded from ``prefabs/blocks/mapping/mapping.binfab``.

Replaces a static JSON dump: the registry is read straight from the game's own
``.binfab`` so new blocks shipped in updates are picked up automatically.

Each block record maps a ``(type, style, colour)`` tuple -- the same ``type`` and
``style`` (= blueprint voxel ``w``) used by the blueprint codec -- to a block
``identifier`` path (e.g. ``placeable/block/color/blue_01``).

binfab record layout (after a small file header):
    varint  index           # zigzag
    0x00 varint  type        # zigzag  (blueprint voxel type)
    0x10 varint  style       # zigzag  (blueprint voxel 'w' / style)
    0x20 varint  colour      # zigzag of packed R<<16 | G<<8 | B
    0x38 u8 len  identifier  # ASCII path
    0x1e                     # record terminator
Stdlib-only (struct + zlib) so it works in both the desktop and web builds.
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path


# --------------------------------------------------------------------------- #
# binfab record parsing
# --------------------------------------------------------------------------- #
def _uvarint(data, pos):
    r = s = 0
    while True:
        b = data[pos]; pos += 1
        r |= (b & 0x7F) << s
        if not (b & 0x80):
            return r, pos
        s += 7


def _unzig(v):
    return (v >> 1) ^ -(v & 1)


def _parse_record(data, pos):
    index, pos = _uvarint(data, pos); index = _unzig(index)
    if data[pos] != 0x00:
        raise ValueError("type tag")
    pos += 1
    vtype, pos = _uvarint(data, pos); vtype = _unzig(vtype)
    if data[pos] != 0x10:
        raise ValueError("style tag")
    pos += 1
    style, pos = _uvarint(data, pos); style = _unzig(style)
    if data[pos] != 0x20:
        raise ValueError("colour tag")
    pos += 1
    colour, pos = _uvarint(data, pos); colour = _unzig(colour)
    if data[pos] != 0x38:
        raise ValueError("string tag")
    pos += 1
    slen = data[pos]; pos += 1
    ident = data[pos:pos + slen].decode("utf-8", "replace"); pos += slen
    return index, vtype, style, colour, ident, pos


def _find_first_record(data) -> int:
    """Robustly locate the first record (header is normally 5 bytes, but detect
    it so a future header change doesn't break parsing)."""
    for start in range(0, 16):
        try:
            _parse_record(data, start)
            return start
        except (IndexError, ValueError):
            continue
    return 5


def parse_mapping(data: bytes) -> list[dict]:
    """Parse mapping.binfab bytes into a list of block records."""
    pos = _find_first_record(data)
    out = []
    n = len(data)
    while pos < n:
        rec_off = pos
        try:
            index, vtype, style, colour, ident, pos = _parse_record(data, pos)
        except (IndexError, ValueError):
            break  # trailing footer / end of the record table
        if pos < n and data[pos] == 0x1e:
            pos += 1  # record terminator
        out.append({
            "index": index,
            "type": vtype,
            "style": style,
            "colour": f"{colour & 0xFFFFFF:06x}",
            "identifier": ident,
            "offset": rec_off,
        })
    return out


# --------------------------------------------------------------------------- #
# Extraction from the game install (.tfi index + zlib .tfa archive)
# --------------------------------------------------------------------------- #
def _read_uleb128(buf, pos):
    r = s = 0
    while True:
        b = buf[pos]; pos += 1
        r |= (b & 0x7F) << s
        if not (b & 0x80):
            return r & 0xFFFFFFFF, pos
        s += 7


def _extract_from_tfi(tfi_path: Path, member: str = "mapping.binfab") -> bytes | None:
    data = tfi_path.read_bytes()
    pos = 0
    while pos < len(data):
        nlen, pos = _read_uleb128(data, pos)
        name = data[pos:pos + nlen].decode("utf-8", "replace"); pos += nlen
        arc, pos = _read_uleb128(data, pos)
        off, pos = _read_uleb128(data, pos)
        size, pos = _read_uleb128(data, pos)
        _hash, pos = _read_uleb128(data, pos)
        if name == member or name.endswith(member):
            tfa = tfi_path.parent / f"archive{arc}.tfa"
            if not tfa.exists():
                return None
            blob = zlib.decompressobj(wbits=zlib.MAX_WBITS).decompress(tfa.read_bytes())
            return blob[off:off + size]
    return None


def load_block_mapping(game_path: str | Path) -> list[dict]:
    """Extract + parse the block mapping from a Trove install.

    Looks for ``<game>/prefabs/blocks/mapping/index.tfi``.
    Returns [] if the file is not present (caller may fall back to a cached copy).
    """
    tfi = Path(game_path) / "prefabs" / "blocks" / "mapping" / "index.tfi"
    if not tfi.exists():
        return []
    raw = _extract_from_tfi(tfi)
    if raw is None:
        return []
    return parse_mapping(raw)


def mapping_by_type_style(records: list[dict]) -> dict:
    """Index records as {(type, style): [records...]} for quick palette lookups."""
    out: dict[tuple[int, int], list[dict]] = {}
    for r in records:
        out.setdefault((r["type"], r["style"]), []).append(r)
    return out


# --------------------------------------------------------------------------- #
# Voxel -> named block resolution
# --------------------------------------------------------------------------- #
class BlockResolver:
    """Resolves a blueprint voxel (type, style/w, colour) to its named block
    identifier from the dynamic registry. Built once from load_block_mapping()."""

    def __init__(self, records: list[dict]):
        self.records = records
        self._exact: dict[tuple[int, int, str], str] = {}   # (type, style, colour) -> id
        self._by_ts: dict[tuple[int, int], str] = {}        # (type, style) -> id (procedural / fallback)
        for r in records:
            key = (r["type"], r["style"], r["colour"].lower())
            self._exact.setdefault(key, r["identifier"])
            self._by_ts.setdefault((r["type"], r["style"]), r["identifier"])

    def resolve(self, vtype: int, style: int, rgb) -> str | None:
        """Return the block identifier for a voxel, or None if it's a custom
        (artist-coloured) voxel with no catalogue entry."""
        colour = f"{int(rgb[0]):02x}{int(rgb[1]):02x}{int(rgb[2]):02x}"
        hit = self._exact.get((int(vtype), int(style), colour))
        if hit:
            return hit
        # Procedural / functional blocks store a black placeholder -> match by
        # (type, style) against the registry's black-coloured entry.
        if max(int(rgb[0]), int(rgb[1]), int(rgb[2])) <= 24:
            return self._by_ts.get((int(vtype), int(style)))
        return None


def load_block_resolver(game_path: str | Path) -> "BlockResolver":
    return BlockResolver(load_block_mapping(game_path))


# --------------------------------------------------------------------------- #
# Full block/deco prefab catalogue -- prefabs/blocks/blocks.binfab
# --------------------------------------------------------------------------- #
# blocks.binfab is the rich prefab registry (deco, blocks, build, collectibles,
# lights). Records are protobuf-like with length-prefixed string fields (markers
# 0x08 identifier, 0x18 item ref, ...) interleaved with fixed-size binary blobs
# (models/transforms). Rather than decode every binary field, we robustly pull
# every length-prefixed reference string and group them per prefab record -- this
# yields the complete catalogue + all references, dynamically.
_REF_PREFIXES = ("placeable/", "item", "collections/", "blueprints/", "prefabs/",
                 "$", "blueprint/", "ui/", "particles/", "sound/", "models/")


def _iter_lenprefixed_strings(data: bytes):
    """Yield (offset, marker, text) for every <marker><u8 len><printable> field."""
    n = len(data)
    i = 1
    while i < n - 1:
        L = data[i]
        if 3 <= L <= 100 and i + 1 + L <= n:
            chunk = data[i + 1:i + 1 + L]
            if all(32 <= c < 127 for c in chunk):
                text = chunk.decode("ascii")
                if any(text.startswith(p) for p in _REF_PREFIXES) or ("/" in text and " " not in text):
                    yield i - 1, data[i - 1], text
                    i += 1 + L
                    continue
        i += 1


def parse_blocks_binfab(data: bytes) -> list[dict]:
    """Parse blocks.binfab into prefab records: identifier + referenced paths.

    A new record begins at each top-level ``placeable/...`` identifier; strings
    until the next identifier are that prefab's references (item given, models,
    blueprints, localization keys, ...).
    """
    records: list[dict] = []
    cur: dict | None = None
    for off, marker, text in _iter_lenprefixed_strings(data):
        is_identifier = text.startswith("placeable/")
        if is_identifier and (cur is None or text != cur["identifier"]):
            cur = {"identifier": text, "offset": off, "references": []}
            records.append(cur)
        elif cur is not None:
            if text != cur["identifier"] and text not in cur["references"]:
                cur["references"].append(text)
    return records


def load_full_block_catalogue(game_path: str | Path) -> list[dict]:
    """Extract + parse prefabs/blocks/blocks.binfab into a prefab reference list."""
    tfi = Path(game_path) / "prefabs" / "blocks" / "index.tfi"
    if not tfi.exists():
        return []
    raw = _extract_from_tfi(tfi, "blocks.binfab")
    if raw is None:
        return []
    return parse_blocks_binfab(raw)


# --------------------------------------------------------------------------- #
# Deco model resolution -- entity prefab path -> voxel model .blueprint
# --------------------------------------------------------------------------- #
# A placed entity references a prefab path (e.g. "placeable/deco/keg"). Its voxel
# MODEL is found by two sources, both reverse-engineered from the game data:
#   1. prefabs/blocks/blocks.binfab: each record is `0x08 <len> <identifier>`
#      followed by `0x18 <len> <model>` where <model> is the model blueprint path
#      relative to blueprints/ (no extension). Covers decos/blocks (~2834 entries).
#      e.g. placeable/deco/keg -> "deco_keg[Kahleaf]"  (blueprints/deco_keg[Kahleaf].blueprint)
#   2. The prefab's own binfab (prefabs/<path>.binfab) embeds the model with the
#      ".blueprint" extension for interactive entities (chests, crafting stations).
#      e.g. placeable/crafting/deconstructor -> "interactive_deconstructor.blueprint"
# Verified: all 16 distinct cs.blueprint decos resolve to real blueprint members.
def build_deco_model_index(blocks_binfab: bytes) -> dict:
    """{identifier -> model path (relative to blueprints/, no extension)} from
    blocks.binfab field 0x08 (id) immediately followed by field 0x18 (model)."""
    out: dict[str, str] = {}
    n = len(blocks_binfab)
    i = 0
    while i < n - 2:
        if blocks_binfab[i] == 0x08:
            ln, j = _read_uleb128(blocks_binfab, i + 1)
            if 3 <= ln <= 200 and j + ln <= n:
                ident = blocks_binfab[j:j + ln]
                if ident[:9] == b"placeable" and all(32 <= c < 127 for c in ident):
                    k = j + ln
                    if k < n and blocks_binfab[k] == 0x18:
                        mln, mj = _read_uleb128(blocks_binfab, k + 1)
                        if 1 <= mln <= 200 and mj + mln <= n:
                            model = blocks_binfab[mj:mj + mln]
                            if all(32 <= c < 127 for c in model):
                                out.setdefault(ident.decode(), model.decode())
                    i = k
                    continue
        i += 1
    return out


def build_deco_scale_index(blocks_binfab: bytes) -> dict:
    """{identifier -> render scale (float)} from blocks.binfab.

    Each prefab record carries a ``0x94 0x02 <float32>`` field = the scale the deco
    is rendered at relative to a 12-voxel block. Most decos are 1.0 (their model is
    already <=12 voxels), but oversized models store a fraction so they normalise to
    ~1 block: e.g. chest_september2020 (20³) @ 0.5 -> 10³, qubeslick_oven
    (23×24×15) @ 0.5 -> ~12³. Verified across the catalogue (49 decos < 1.0).
    """
    out: dict[str, float] = {}
    n = len(blocks_binfab)
    # identifier offsets (one record begins at each new distinct placeable id)
    records: list[tuple[int, str]] = []
    i = 0
    while i < n - 2:
        if blocks_binfab[i] == 0x08:
            ln, j = _read_uleb128(blocks_binfab, i + 1)
            if 3 <= ln <= 200 and j + ln <= n:
                ident = blocks_binfab[j:j + ln]
                if ident[:9] == b"placeable" and all(32 <= c < 127 for c in ident):
                    name = ident.decode()
                    if not records or records[-1][1] != name:
                        records.append((i, name))
                    i = j + ln
                    continue
        i += 1
    for k, (off, name) in enumerate(records):
        end = records[k + 1][0] if k + 1 < len(records) else n
        j = off
        sc = None
        while j < end - 5:
            if blocks_binfab[j] == 0x94 and blocks_binfab[j + 1] == 0x02:
                f = struct.unpack_from("<f", blocks_binfab, j + 2)[0]
                if 0.01 <= f <= 8.0:
                    sc = round(f, 4)
                j += 6
                continue
            j += 1
        if sc is not None:
            out.setdefault(name, sc)
    return out


def _scale_from_prefab_binfab(blob: bytes | None) -> float | None:
    """Pull the render scale out of an interactive prefab's transform: the first
    plausible scale float (0.1..1.5, a multiple of 0.05). Interactive crafting
    stations / chests store e.g. 0.5 so their ~22-24 voxel models become ~1 block."""
    if not blob:
        return None
    for i in range(len(blob) - 3):
        f = struct.unpack_from("<f", blob, i)[0]
        if 0.1 <= f <= 1.5 and abs(f * 20 - round(f * 20)) < 1e-3:
            return round(f, 4)
    return None


def _tfi_members(tfi_path: Path):
    """Yield (name, archive, offset, size) for each member of an index.tfi."""
    data = tfi_path.read_bytes()
    pos = 0
    n = len(data)
    while pos < n:
        nlen, pos = _read_uleb128(data, pos)
        name = data[pos:pos + nlen].decode("utf-8", "replace"); pos += nlen
        arc, pos = _read_uleb128(data, pos)
        off, pos = _read_uleb128(data, pos)
        size, pos = _read_uleb128(data, pos)
        _hash, pos = _read_uleb128(data, pos)
        yield name, arc, off, size


class DecoResolver:
    """Resolves a placed-entity prefab path to its voxel model blueprint bytes.

    Built once per game install (scans blocks.binfab + the blueprints TFA index).
    Reading the .tfa archives is deferred until a model is actually requested.
    """

    def __init__(self, game_path: str | Path):
        self.game = Path(game_path)
        self.model_index: dict[str, str] = {}
        self.scale_index: dict[str, float] = {}
        # blueprint member catalogues
        self._by_rel: dict[str, tuple[Path, str, int]] = {}   # "dir/name.blueprint" -> (tfi, member, arc)
        self._by_name: dict[str, tuple[Path, str, int]] = {}  # "name.blueprint" -> (tfi, member, arc)
        self._tfa_cache: dict[Path, bytes] = {}
        self._scale_cache: dict[tuple, float] = {}
        self._build()

    def _build(self):
        blocks = _extract_from_tfi(self.game / "prefabs" / "blocks" / "index.tfi",
                                   "blocks.binfab")
        if blocks:
            self.model_index = build_deco_model_index(blocks)
            self.scale_index = build_deco_scale_index(blocks)
        bp_root = self.game / "blueprints"
        if bp_root.exists():
            for tfi in bp_root.rglob("index.tfi"):
                reldir = tfi.parent.relative_to(bp_root)
                prefix = "" if str(reldir) == "." else str(reldir).replace("\\", "/") + "/"
                for name, arc, _off, _size in _tfi_members(tfi):
                    self._by_name.setdefault(name.lower(), (tfi, name, arc))
                    self._by_rel.setdefault((prefix + name).lower(), (tfi, name, arc))

    def _read_member(self, tfi: Path, member: str, arc: int) -> bytes | None:
        tfa = tfi.parent / f"archive{arc}.tfa"
        blob = self._tfa_cache.get(tfa)
        if blob is None:
            if not tfa.exists():
                return None
            blob = zlib.decompressobj(wbits=zlib.MAX_WBITS).decompress(tfa.read_bytes())
            self._tfa_cache[tfa] = blob
        # locate offset/size for this member in its tfi
        for name, a, off, size in _tfi_members(tfi):
            if name == member and a == arc:
                return blob[off:off + size]
        return None

    def _model_path_for(self, paths: list[str]) -> str | None:
        """Return the model blueprint name (with .blueprint) for an entity's paths."""
        cands = list(paths)
        for p in list(paths):
            if p.endswith("_interactive"):
                cands.append(p[: -len("_interactive")])
        # 1. blocks.binfab model index (model relative to blueprints/, no extension)
        for p in cands:
            m = self.model_index.get(p)
            if m:
                key = (m + ".blueprint").lower()
                if key in self._by_rel:
                    return key
                if (m.lower() + ".blueprint") in self._by_name:
                    return m.lower() + ".blueprint"
        # 2. prefab's own binfab -> first "*.blueprint" string (interactive entities)
        for p in cands:
            blob = self._read_prefab_binfab(p)
            m = _model_from_prefab_binfab(blob)
            if m and m.lower() in self._by_name:
                return m.lower()
        return None

    def _read_prefab_binfab(self, placeable_path: str) -> bytes | None:
        parts = placeable_path.split("/")
        member = parts[-1] + ".binfab"
        subdir = self.game / "prefabs" / Path(*parts[:-1]) if len(parts) > 1 else self.game / "prefabs"
        tfi = subdir / "index.tfi"
        if not tfi.exists():
            return None
        return _extract_from_tfi(tfi, member)

    def resolve_model_bytes(self, paths: list[str]) -> bytes | None:
        """Return the raw .blueprint bytes of the model for an entity, or None."""
        key = self._model_path_for(paths)
        if not key:
            return None
        ent = self._by_rel.get(key) or self._by_name.get(key)
        if not ent:
            return None
        return self._read_member(*ent)

    def resolve_model_name(self, paths: list[str]) -> str | None:
        return self._model_path_for(paths)

    def resolve_scale(self, paths: list[str]) -> float:
        """Render scale for an entity's deco (1.0 = model already block-sized).

        blocks.binfab carries an exact per-deco scale; interactive entities store it
        in their prefab transform. Returns 1.0 when nothing is found."""
        key = tuple(paths)
        if key in self._scale_cache:
            return self._scale_cache[key]
        cands = list(paths)
        for p in list(paths):
            if p.endswith("_interactive"):
                cands.append(p[: -len("_interactive")])
        scale = None
        for p in cands:
            if p in self.scale_index:
                scale = self.scale_index[p]
                break
        if scale is None:
            for p in cands:
                s = _scale_from_prefab_binfab(self._read_prefab_binfab(p))
                if s is not None:
                    scale = s
                    break
        if scale is None or scale <= 0:
            scale = 1.0
        self._scale_cache[key] = scale
        return scale


def _model_from_prefab_binfab(blob: bytes | None) -> str | None:
    """Scan a prefab binfab for the first length-prefixed '*.blueprint' string."""
    if not blob:
        return None
    n = len(blob)
    i = 1
    while i < n - 1:
        L = blob[i]
        if 3 <= L <= 120 and i + 1 + L <= n:
            chunk = blob[i + 1:i + 1 + L]
            if all(32 <= c < 127 for c in chunk):
                t = chunk.decode("ascii")
                if t.endswith(".blueprint"):
                    return t
        i += 1
    return None


def load_deco_resolver(game_path: str | Path) -> "DecoResolver | None":
    try:
        return DecoResolver(game_path)
    except (OSError, zlib.error):
        return None
