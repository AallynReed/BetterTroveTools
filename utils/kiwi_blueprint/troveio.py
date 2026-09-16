"""Canonical Trove binary primitives: the FNV-1a-variant checksum + LEB128.

Both are used across more than one Trove feature (`.tmod` mod files and the
`.tfa`/`.tfi` archive format), so they live in one place. `calculate_hash` is
verified byte-for-byte against the native `trove.dll` (golden values pinned in
tests/unit/trove/test_tmod.py) - do NOT "simplify" the signed-char tail handling.
"""

_FNV_OFFSET = 2166136261
_FNV_PRIME = 16777619
_MASK32 = 0xFFFFFFFF


def _se(b: int) -> int:
    """A signed `char` widened to uint32 (sign extension).

    trove.c reads the hash's trailing bytes through a `char *` (signed on MSVC/gcc),
    so a byte >= 0x80 becomes negative and fills the upper 24 bits with 1s.
    """
    return b if b < 0x80 else (b | 0xFFFFFF00)


def calculate_hash(data: bytes) -> int:
    """Trove's FNV-1a-variant checksum (trove.c / trove.dll). 32-bit unsigned.

    Full 4-byte words are folded little-endian (read unsigned); the trailing 1-3
    bytes are folded big-endian AND sign-extended. Verified against trove.dll.
    """
    h = _FNV_OFFSET
    n = len(data)
    full = n & ~3
    for i in range(0, full, 4):
        chunk = int.from_bytes(data[i:i + 4], "little")
        h = (_FNV_PRIME * (h ^ chunk)) & _MASK32
    rem = n & 3
    if rem == 1:
        val = _se(data[full])
    elif rem == 2:
        val = ((_se(data[full]) << 8) & _MASK32) | _se(data[full + 1])
    elif rem == 3:
        v1 = (_se(data[full]) << 8) & _MASK32
        v1 = ((_se(data[full + 1]) | v1) << 8) & _MASK32
        val = v1 | _se(data[full + 2])
    else:
        return h & _MASK32
    return (_FNV_PRIME * (h ^ val)) & _MASK32


def write_leb128(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value & 0x7F)
    return bytes(out)


def read_leb128(buf: bytes, pos: int) -> tuple[int, int]:
    """Return (value, new_pos). Masks to 32-bit like Trove's own readers."""
    result = 0
    shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result & _MASK32, pos
        shift += 7
        if shift >= 64:
            raise ValueError("varint too long")
