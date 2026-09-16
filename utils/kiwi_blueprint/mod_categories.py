"""Mod category flags.

A mod can be tagged with one or more **categories** from a fixed vocabulary. They
are stored *twice*:

  1. the natural Trove way - as plain tag strings in the ``tags`` header property
     (and in ``ModProject.tags``), and
  2. as a compact integer **bitmask** in a ``flags`` header property,

so a consumer can recover the exact category set from one number (``flags=96`` →
``tags_from_flags(96)``) instead of string-matching tag text. Each category owns
one bit; with 19 categories the mask spans more than a single byte, so ``flags``
is a plain integer, not literally one byte.

Bit order is a public contract - a category's bit must never change. ALWAYS append
new categories to the end; never reorder or remove.
"""

from __future__ import annotations

from collections.abc import Iterable

# Ordered vocabulary. Index i -> bit (1 << i). Append-only.
_CATEGORY_NAMES: list[str] = [
    "Allies",          # 1 << 0
    "Banners",         # 1 << 1
    "Boats and Sails", # 1 << 2
    "Cosmetics",       # 1 << 3
    "Costumes",        # 1 << 4
    "Dragons",         # 1 << 5
    "Fishing",         # 1 << 6
    "GUI",             # 1 << 7
    "Helmets",         # 1 << 8
    "Language",        # 1 << 9
    "Mag Riders",      # 1 << 10
    "Mounts",          # 1 << 11
    "NPCs",            # 1 << 12
    "Wings",           # 1 << 13
    "Automation",      # 1 << 14
    "Optimization",    # 1 << 15
    "Reskin",          # 1 << 16
    "Waypoint",        # 1 << 17
    "Radar",           # 1 << 18
]

# Canonical name -> bit, and lowercased name -> bit (for case-insensitive matching).
CATEGORY_BITS: dict[str, int] = {name: 1 << i for i, name in enumerate(_CATEGORY_NAMES)}
_BIT_BY_LOWER: dict[str, int] = {name.lower(): 1 << i for i, name in enumerate(_CATEGORY_NAMES)}
ALL_CATEGORIES_MASK: int = (1 << len(_CATEGORY_NAMES)) - 1


def category_names() -> list[str]:
    """The canonical category labels, in bit order."""
    return list(_CATEGORY_NAMES)


def categories() -> list[dict]:
    """``[{name, bit}]`` for the API / UI - the vocabulary plus each bit value."""
    return [{"name": name, "bit": 1 << i} for i, name in enumerate(_CATEGORY_NAMES)]


def flags_from_tags(tags: Iterable[str]) -> int:
    """OR together the bits of every recognized category found in ``tags``
    (case-insensitive; unknown tags are ignored)."""
    flags = 0
    for tag in tags or ():
        flags |= _BIT_BY_LOWER.get(str(tag).strip().lower(), 0)
    return flags


def tags_from_flags(flags: int) -> list[str]:
    """The canonical category labels encoded in ``flags``, in bit order."""
    try:
        mask = int(flags) & ALL_CATEGORIES_MASK
    except (TypeError, ValueError):
        return []
    return [name for i, name in enumerate(_CATEGORY_NAMES) if mask & (1 << i)]
