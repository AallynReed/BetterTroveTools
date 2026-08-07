from __future__ import annotations

import asyncio
import datetime
import random
import time
from random import randint
from random import sample
from string import ascii_letters, digits
from typing import Callable, Generic, Literal, TypeVar, Union, overload

from binary_reader import BinaryReader

from .path import BasePath  # noqa: F401  (re-exported as utils.functions.BasePath)

# Trove's FNV-1a-variant checksum. Previously a native helper loaded via ctypes
# (trove.dll / trove.so); reimplemented here in pure Python so no compiled
# artifact has to be shipped or built on any platform. Verified byte-for-byte
# against the original native library across every tail length and high-byte case.
_FNV_OFFSET = 2166136261
_FNV_PRIME = 16777619
_MASK32 = 0xFFFFFFFF


def _sign_extend_char(b: int) -> int:
    """A signed C ``char`` widened to uint32. trove.c reads the hash's trailing
    bytes through a ``char *`` (signed on MSVC/gcc), so a byte >= 0x80 becomes
    negative and fills the upper 24 bits with 1s."""
    return b if b < 0x80 else (b | 0xFFFFFF00)


def calculate_hash(data: bytes, length: int | None = None) -> int:
    """Trove's FNV-1a-variant checksum, 32-bit unsigned.

    Full 4-byte words are folded little-endian (read unsigned); the trailing
    1-3 bytes are folded big-endian AND sign-extended. ``length`` is optional
    and only kept for compatibility with the old native signature
    ``calculate_hash(data, len)``; when given it bounds the slice of ``data``.
    """
    if length is not None:
        data = data[:length]
    h = _FNV_OFFSET
    n = len(data)
    full = n & ~3
    for i in range(0, full, 4):
        chunk = int.from_bytes(data[i:i + 4], "little")
        h = (_FNV_PRIME * (h ^ chunk)) & _MASK32
    rem = n & 3
    if rem == 1:
        val = _sign_extend_char(data[full])
    elif rem == 2:
        val = ((_sign_extend_char(data[full]) << 8) & _MASK32) | _sign_extend_char(data[full + 1])
    elif rem == 3:
        v1 = (_sign_extend_char(data[full]) << 8) & _MASK32
        v1 = ((_sign_extend_char(data[full + 1]) | v1) << 8) & _MASK32
        val = v1 | _sign_extend_char(data[full + 2])
    else:
        return h & _MASK32
    return (_FNV_PRIME * (h ^ val)) & _MASK32


def random_id(k=8):
    return "".join(sample(ascii_letters + digits, k=k))


T = TypeVar("T", bool, Literal[True], Literal[False])


class _MissingSentinel:
    __slots__ = ()

    def __eq__(self, other) -> bool:
        return False

    def __bool__(self) -> bool:
        return False

    def __hash__(self) -> int:
        return 0

    def __repr__(self):
        return "..."


class ExponentialBackoff(Generic[T]):
    def __init__(self, base: int = 1, *, integral: T = False):
        self._base: int = base
        self._exp: int = 0
        self._max: int = 10
        self._reset_time: int = base * 2**11
        self._last_invocation: float = time.monotonic()
        rand = random.Random()
        rand.seed()
        self._randfunc: Callable[..., Union[int, float]] = (
            rand.randrange if integral else rand.uniform
        )

    @overload
    def delay(self: ExponentialBackoff[Literal[False]]) -> float: ...

    @overload
    def delay(self: ExponentialBackoff[Literal[True]]) -> int: ...

    @overload
    def delay(self: ExponentialBackoff[bool]) -> Union[int, float]: ...

    def delay(self) -> Union[int, float]:
        invocation = time.monotonic()
        interval = invocation - self._last_invocation
        self._last_invocation = invocation
        if interval > self._reset_time:
            self._exp = 0
        self._exp = min(self._exp + 1, self._max)
        return self._randfunc(0, self._base * 2**self._exp)


def compute_timedelta(dt: datetime.datetime) -> float:
    if dt.tzinfo is None:
        dt = dt.astimezone()
    now = datetime.datetime.now(datetime.timezone.utc)
    return max((dt - now).total_seconds(), 0)


def throttle(actual_handler, data={}, delay=0.5):
    async def wrapper(*args, **kwargs):
        data["last_change"] = datetime.datetime.now(datetime.UTC).timestamp()
        await asyncio.sleep(delay)
        if (
            datetime.datetime.now(datetime.UTC).timestamp() - data["last_change"]
            >= delay - delay * 0.1
        ):
            await actual_handler(*args, **kwargs)
    return wrapper


def long_throttle(actual_handler, data={}, delay=1.5):
    async def wrapper(*args, **kwargs):
        data["last_change"] = datetime.datetime.now(datetime.UTC).timestamp()
        await asyncio.sleep(delay)
        if (
            datetime.datetime.now(datetime.UTC).timestamp() - data["last_change"]
            >= delay - delay * 0.1
        ):
            await actual_handler(*args, **kwargs)

    return wrapper


def split_boosts(n):
    a = randint(0, n)
    b = randint(0, n - a)
    c = n - a - b
    return [a, b, c]


def get_key(iterable, obj: dict):
    for z in iterable:
        try:
            for x, y in obj.items():
                if z[x] == y:
                    ...
            return z
        except KeyError:
            ...
    return None


def get_attr(iterable, **kwargs):
    for z in iterable:
        try:
            for x, y in kwargs.items():
                if getattr(z, x) != y:
                    raise ValueError
            return z
        except ValueError:
            ...
    return None


def chunks(lst, n):
    result = []
    for i in range(0, len(lst), n):
        result.append(lst[i : i + n])
    return result


def read_leb128(buffer: BinaryReader, pos):
    result = 0
    shift = 0
    while 1:
        buffer.seek(pos)
        b = buffer.read_bytes()
        for i, byte in enumerate(b):
            result |= (byte & 0x7F) << shift
            pos += 1
            if not (byte & 0x80):
                result &= (1 << 32) - 1
                result = int(result)
                return result
            shift += 7
            if shift >= 64:
                raise Exception("Too many bytes when decoding varint.")


def write_leb128(value):
    result = bytearray()
    while value >= 0x80:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    result.append(value & 0x7F)

    return bytes(result)