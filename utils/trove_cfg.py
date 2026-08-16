"""Guard against Trove's own `Trove.cfg` silently killing every installed mod.

The game writes `DisableAllMods = true` into the `[Mods]` section (safe mode
after a crash, or the launcher's "start without mods" path). Nothing in the Mod
Manager surfaces that, so the whole load order still looks installed and simply
does nothing in game. We clear the flag whenever we read the mods folder.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from utils.path import get_app_data_dir

_TRUTHY = {"true", "1", "yes", "on"}
_DISABLE_ALL_RE = re.compile(r"^(\s*DisableAllMods\s*=)(.*)$", re.IGNORECASE)


def get_trove_cfg_path() -> Path:
    """`%APPDATA%/Trove/Trove.cfg` — the game's own settings file."""
    return get_app_data_dir() / "Trove.cfg"


def ensure_mods_enabled(cfg_path: Optional[Path] = None) -> bool:
    """Blank out `[Mods] DisableAllMods` if the game set it to a truthy value.

    Rewrites only that one line so the rest of the file (ordering, casing,
    unknown keys, line endings) survives untouched. Returns True if the file
    was actually changed.
    """
    path = Path(cfg_path) if cfg_path else get_trove_cfg_path()
    try:
        # newline="" everywhere: no universal-newline translation, so a CRLF
        # file stays CRLF.
        with open(path, encoding="utf-8", errors="surrogateescape", newline="") as f:
            raw = f.read()
    except OSError:
        return False

    lines = raw.split("\n")
    in_mods = False
    changed = False

    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("["):
            in_mods = stripped.lower() == "[mods]"
            continue
        if not in_mods:
            continue
        match = _DISABLE_ALL_RE.match(line)
        if match and match.group(2).strip().lower() in _TRUTHY:
            eol = "\r" if line.endswith("\r") else ""
            lines[index] = f"{match.group(1)} {eol}"
            changed = True

    if not changed:
        return False

    try:
        with open(path, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
            f.write("\n".join(lines))
    except OSError:
        return False

    print(f"[trove_cfg] cleared DisableAllMods in {path}")
    return True
