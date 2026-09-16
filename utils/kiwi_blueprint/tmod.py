"""Read and build Trove ``.tmod`` mod files (binary format).

Ported from BetterTroveTools (`models/trove/mod.py`, `trove.c`, `utils/functions.py`).
Pure Python - the FNV-1a-variant checksum (BTT ships it as a C extension) is
reimplemented here so the API needs no native lib. Nothing is stored: read parses
an uploaded tmod; build serializes one in memory and returns the bytes.

Format (all multi-byte ints little-endian, strings UTF-8):
  [u64 header_size][u16 version][u16 prop_count]
  prop_count × ( leb128 name_len, name, leb128 val_len, value )
  files × ( u8 path_len, path, leb128 index, leb128 offset, leb128 size, leb128 checksum )
  (all three lengths count BYTES; some writers wrongly count characters - see ``_read_header``)
  ...header ends at header_size...
  zlib stream (level 0, 32 KiB chunks, Z_SYNC_FLUSH) of the 4-byte-padded file contents
"""

from __future__ import annotations

import base64
import zlib

from pydantic import BaseModel, Field

from utils.kiwi_blueprint import mod_categories

# The Trove FNV-1a checksum + LEB128 live in troveio (shared with the archive
# reader). Re-exported here so `tmod.calculate_hash` etc. keep working.
from utils.kiwi_blueprint.troveio import calculate_hash, read_leb128, write_leb128

__all__ = ["calculate_hash", "read_leb128", "write_leb128"]

_CHUNK = 32768
# The modLoader header BTT stamps as "BTT"; the API stamps its own marker instead.
KIWI_MOD_LOADER = "KiwiAPI"
# A ``.tpack`` (modpack) is the SAME container format as a ``.tmod`` - it just
# packs whole ``.tmod`` files where a ``.tmod`` packs raw game files, so it reuses
# the same ``modLoader`` marker. A consumer tells a pack from a mod by the ``.tpack``
# extension + the ``manifest``/``packVersion`` header properties + the inner files
# being ``.tmod`` builds, not by a distinct loader string.
KIWI_PACK_LOADER = KIWI_MOD_LOADER


class TmodError(ValueError):
    """Raised on malformed tmod input or invalid build params (mapped to 400)."""


# --- Pydantic models -------------------------------------------------------


class TmodFileEntry(BaseModel):
    path: str                       # internal trove path (lowercase posix)
    index: int
    offset: int                     # byte offset in the decompressed file stream
    size: int                       # uncompressed content size
    checksum: int                   # FNV-1a-variant, 32-bit unsigned
    content_base64: str | None = None  # omitted in metadata-only mode


class TmodReadResponse(BaseModel):
    version: int
    header_size: int
    properties: dict[str, str]      # tmod header key/values (modLoader, title, author, …)
    file_count: int
    files: list[TmodFileEntry]
    metadata_only: bool
    header_repaired: bool = False   # header strings were length-counted in chars, not bytes


class TmodBuildFile(BaseModel):
    path: str                       # internal trove path
    content_base64: str             # file bytes, base64


class TmodBuildRequest(BaseModel):
    version: int = 1
    properties: dict[str, str] = Field(default_factory=dict)  # title, author, modVersion, notes, tags, …
    files: list[TmodBuildFile]


# --- Reader ----------------------------------------------------------------


def _manual_decompress(data: bytes) -> bytes:
    """De-frame Trove's custom .tmod stream: a 7-byte head, then raw 32 KiB chunks
    separated by 5-byte sync markers, and a 5-byte tail. (The blocks are STORED, so
    there's nothing to inflate - just strip the framing.)"""
    buf = data[7:-5]
    out = bytearray()
    pos = 0
    for _ in range(len(buf) // (_CHUNK + 5)):
        out += buf[pos:pos + _CHUNK]
        pos += _CHUNK + 5  # skip the 5-byte sync-flush marker
    out += buf[pos:]
    return bytes(out)


def _verify_stream(stream: bytes, entries: list[dict]) -> bool:
    """True if the file slices in ``stream`` hash to their stored checksums. A few
    non-empty files matching is conclusive. We can't trust a no-exception zlib
    decompress: zlib silently MIS-decodes Trove's custom framing (lying block
    lengths) into shifted/garbage bytes without raising, so we check the data."""
    checked = 0
    for e in entries:
        if e["size"] == 0:
            continue
        end = e["offset"] + e["size"]
        if end > len(stream):
            return False
        if calculate_hash(stream[e["offset"]:end]) != e["checksum"]:
            return False
        checked += 1
        if checked >= 4:
            return True
    return True   # all files empty, or every checked file matched


def _decompress_file_stream(compressed: bytes, entries: list[dict]) -> bytes:
    """Decompress a .tmod file stream, robust to BOTH a standard zlib stream (our own
    ``build_tmod``) AND Trove's custom stored-block framing (real game / BTT mods).
    zlib decodes the latter WITHOUT raising but yields shifted/garbage bytes, so we
    verify each candidate against the per-file checksums and fall back to the manual
    de-framer when zlib's output doesn't check out."""
    primary: bytes | None = None
    try:
        d = zlib.decompressobj(wbits=zlib.MAX_WBITS)
        primary = d.decompress(compressed) + d.flush()
    except zlib.error:
        primary = None
    if primary is not None and _verify_stream(primary, entries):
        return primary
    manual = _manual_decompress(compressed)
    if _verify_stream(manual, entries):
        return manual
    return primary if primary is not None else manual


def _utf8_char_span(data: bytes, pos: int, chars: int) -> int:
    """Byte length of the next ``chars`` UTF-8 characters starting at ``pos``."""
    end = pos
    for _ in range(chars):
        lead = data[end]
        if lead < 0x80:
            end += 1
        elif 0xC2 <= lead <= 0xDF:
            end += 2
        elif 0xE0 <= lead <= 0xEF:
            end += 3
        elif 0xF0 <= lead <= 0xF4:
            end += 4
        else:
            raise TmodError("not a UTF-8 lead byte")
    if end > len(data):
        raise TmodError("header string runs past the end of the file")
    return end - pos


def _parse_header(data: bytes, header_size: int, prop_count: int,
                  char_lengths: bool) -> tuple[dict[str, str], list[dict], int]:
    """Parse the properties + file table, reading every string length as a byte
    count (the format) or a character count (the quirk ``_read_header`` handles).
    Returns the properties, the file entries, and the position it stopped at."""
    def read_string(pos: int, declared: int) -> tuple[str, int]:
        span = _utf8_char_span(data, pos, declared) if char_lengths else declared
        return data[pos:pos + span].decode("utf-8"), pos + span

    pos = 12
    properties: dict[str, str] = {}
    for _ in range(prop_count):
        name_size, pos = read_leb128(data, pos)
        name, pos = read_string(pos, name_size)
        value_size, pos = read_leb128(data, pos)
        value, pos = read_string(pos, value_size)
        properties[name] = value

    entries: list[dict] = []
    while pos < header_size:
        path, pos = read_string(pos + 1, data[pos])
        index, pos = read_leb128(data, pos)
        offset, pos = read_leb128(data, pos)
        size, pos = read_leb128(data, pos)
        checksum, pos = read_leb128(data, pos)
        entries.append({"path": path, "index": index, "offset": offset,
                        "size": size, "checksum": checksum})
    return properties, entries, pos


def _read_header(data: bytes, header_size: int,
                 prop_count: int) -> tuple[dict[str, str], list[dict], bool]:
    """Parse the header, tolerating tmods whose string lengths count CHARACTERS
    where the format wants UTF-8 BYTES. Returns (properties, entries, repaired).

    BetterTroveTools - and so a large share of published mods - wrote ``len(str)``
    for header strings while writing them as UTF-8, so a single non-ASCII character
    anywhere in the header (an accented word in ``notes``, say) under-declares that
    length and desyncs every field after it, taking the whole file table with it.
    The reading isn't guessed: the file table has to end exactly on ``header_size``,
    which only the correct interpretation does.
    """
    def attempt(char_lengths: bool) -> tuple[dict[str, str], list[dict]] | None:
        try:
            properties, entries, pos = _parse_header(data, header_size, prop_count, char_lengths)
        except (IndexError, UnicodeDecodeError, ValueError):
            return None
        return (properties, entries) if pos == header_size else None

    for char_lengths in (False, True):
        parsed = attempt(char_lengths)
        if parsed is not None:
            return parsed[0], parsed[1], char_lengths
    # Neither reading holds up - re-run the strict one so its own error surfaces.
    _parse_header(data, header_size, prop_count, False)
    raise TmodError("the file table does not end where the declared header size says")


def read_tmod(data: bytes, metadata_only: bool = False) -> dict:
    """Parse a .tmod byte string. With metadata_only, file contents are not loaded/returned."""
    if len(data) < 12:
        raise TmodError("file too small to be a .tmod")
    try:
        header_size = int.from_bytes(data[0:8], "little")
        version = int.from_bytes(data[8:10], "little")
        prop_count = int.from_bytes(data[10:12], "little")
        if not 12 <= header_size <= len(data):
            raise TmodError("declared header size is outside the file")

        # The file table (path/offset/size/checksum) lives in the header. Parse it
        # FIRST so the decompressor can verify its output against the checksums
        # (needed to detect zlib's silent mis-decode of Trove's custom framing).
        properties, entries, header_repaired = _read_header(data, header_size, prop_count)

        file_stream = b""
        if not metadata_only:
            file_stream = _decompress_file_stream(data[header_size:], entries)

        files: list[dict] = []
        for e in entries:
            entry = dict(e)
            if not metadata_only:
                entry["content_base64"] = base64.b64encode(
                    file_stream[e["offset"]:e["offset"] + e["size"]]).decode("ascii")
            files.append(entry)
    except (IndexError, UnicodeDecodeError, ValueError) as e:
        if isinstance(e, TmodError):
            raise
        raise TmodError(f"malformed .tmod file: {e}") from e

    # Decode the category bitmask (if present) back into its labels - far easier
    # for a consumer than string-matching the `tags` text.
    try:
        flags_val = int(properties.get("flags", 0) or 0)
    except (TypeError, ValueError):
        flags_val = 0
    return {
        "version": version, "header_size": header_size, "properties": properties,
        "files": files, "file_count": len(files), "metadata_only": metadata_only,
        "header_repaired": header_repaired,
        "flags": flags_val, "categories": mod_categories.tags_from_flags(flags_val),
    }


# --- Builder ---------------------------------------------------------------


def build_tmod(version: int, properties: dict[str, str], files: list[tuple[str, bytes]],
               mod_loader: str = KIWI_MOD_LOADER, lowercase_paths: bool = True) -> bytes:
    """Serialize a .tmod from (path, bytes) files + header properties. Returns the bytes.

    `modLoader` is always (re)stamped to `mod_loader` (the API uses "KiwiAPI",
    where BTT uses "BTT"). Paths are normalized to posix; with `lowercase_paths`
    (the default, for real Trove game files - the engine stores them lowercase) they
    are also lowercased. A `.tpack` packs each mod's `.tmod` under its exact
    title-cased filename, so it passes `lowercase_paths=False` to preserve case.

    A `.cfg` keeps its case either way. It is not a game file and is never resolved
    as one: it is extracted to `ModCfgs/<Mod Title>.cfg`, and a lowercased packed
    path is the wrong name for it.
    """
    if not files:
        raise TmodError("a .tmod needs at least one file")

    props = dict(properties)
    props["modLoader"] = mod_loader  # set or override - never trust a client-sent value
    # Encode any category tags as a compact integer bitmask alongside the natural
    # comma-separated `tags` string, so a consumer can recover the category set
    # from one number. Skipped if the caller already set `flags`.
    if props.get("tags") and "flags" not in props:
        flags = mod_categories.flags_from_tags(str(props["tags"]).split(","))
        if flags:
            props["flags"] = str(flags)

    file_stream = bytearray()
    files_table = bytearray()
    offset = 0
    for raw_path, content in files:
        path = raw_path.replace("\\", "/").lstrip("/")
        if lowercase_paths and not path.lower().endswith(".cfg"):
            path = path.lower()
        path_bytes = path.encode("utf-8")
        if len(path_bytes) > 255:
            raise TmodError(f"internal path too long for the .tmod format (>255 bytes): {path}")
        size = len(content)
        padded = content + b"\x00" * ((4 - size % 4) % 4)
        files_table += bytes([len(path_bytes)]) + path_bytes
        files_table += write_leb128(0)                       # index (always 0)
        files_table += write_leb128(offset if size else 0)
        files_table += write_leb128(size)
        files_table += write_leb128(calculate_hash(content))
        file_stream += padded
        offset += len(padded)

    compressor = zlib.compressobj(level=0, strategy=0, wbits=zlib.MAX_WBITS)
    compressed = bytearray()
    for i in range(0, len(file_stream), _CHUNK):
        compressed += compressor.compress(bytes(file_stream[i:i + _CHUNK]))
    compressed += compressor.flush(zlib.Z_SYNC_FLUSH)

    props_stream = bytearray()
    for name, value in props.items():
        nb, vb = name.encode("utf-8"), value.encode("utf-8")
        props_stream += write_leb128(len(nb)) + nb
        props_stream += write_leb128(len(vb)) + vb

    header = bytearray()
    header += (0).to_bytes(8, "little")          # header_size placeholder
    header += version.to_bytes(2, "little")
    header += len(props).to_bytes(2, "little")
    header += props_stream
    header += files_table
    header[0:8] = len(header).to_bytes(8, "little")  # backfill real header size

    return bytes(header) + bytes(compressed)


def build_tpack(version: int, properties: dict[str, str],
                tmods: list[tuple[str, bytes]]) -> bytes:
    """Serialize a ``.tpack`` (modpack) from ``(tmod_filename, tmod_bytes)`` entries
    plus header properties. A ``.tpack`` is structurally a ``.tmod`` (same header +
    file-table + zlib stream + ``modLoader``) whose packed "files" are whole ``.tmod``
    builds. A consumer tells a pack from a mod by the ``.tpack`` extension + the
    ``manifest``/``packVersion`` header properties + the inner ``.tmod`` files, not by
    the loader string. The pack's mod manifest (which mod + variant + version each
    entry resolved to) is carried as the ``manifest`` JSON header property by the
    caller - it round-trips through ``read_tmod(...)["properties"]``.

    Each ``tmod_filename`` MUST be the packed ``.tmod``'s exact ``<title>.tmod`` (Trove
    validates a mod's filename against the ``title`` baked into its header), so paths
    are NOT lowercased here - case is preserved verbatim. Category-flag encoding is
    skipped (a pack carries no game-category ``tags``); ``properties`` is stamped as-is
    apart from ``modLoader``.
    """
    return build_tmod(version, properties, tmods,
                      mod_loader=KIWI_PACK_LOADER, lowercase_paths=False)
