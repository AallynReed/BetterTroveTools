"""Read and patch the `[Mods]` section of Trove's own `Trove.cfg`.

Two keys there switch mods off without touching the files, so the Mod Manager
would otherwise show them as enabled:

* `DisableAllMods = true` -- safe mode after a crash, or the launcher's "start
  without mods" path. We clear it whenever we read the mods folder.
* `DisabledMods = <key>|<key>|...` -- mods the player switched off in game, and
  the ones Trove itself turns off when mods conflict (it keeps one and disables
  the rest). A key is `<source>-<title>-<author>`, where source is `Workshop`
  for Steam Workshop items and `Trove` for the install's `mods` folder.

Every write rewrites only the line it changes, so the rest of the file
(ordering, casing, unknown keys, line endings) survives untouched.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, Optional

from utils.path import get_app_data_dir

_TRUTHY = {"true", "1", "yes", "on"}
_DISABLE_ALL_RE = re.compile(r"^(\s*DisableAllMods\s*=)(.*)$", re.IGNORECASE)
_DISABLED_MODS_RE = re.compile(r"^(\s*DisabledMods\s*=)(.*)$", re.IGNORECASE)


def get_trove_cfg_path() -> Path:
    """`%APPDATA%/Trove/Trove.cfg` — the game's own settings file."""
    return get_app_data_dir() / "Trove.cfg"


def mod_key(title, author, workshop) -> str:
    """The `DisabledMods` entry Trove writes for a mod."""
    return f"{'Workshop' if workshop else 'Trove'}-{title or ''}-{author or ''}"


def _read_lines(path: Path) -> Optional[list[str]]:
    # newline="" everywhere: no universal-newline translation, so a CRLF file
    # stays CRLF.
    try:
        with open(path, encoding="utf-8", errors="surrogateescape", newline="") as f:
            return f.read().split("\n")
    except OSError:
        return None


def _write_lines(path: Path, lines: list[str]) -> bool:
    try:
        with open(path, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
            f.write("\n".join(lines))
    except OSError:
        return False
    return True


def _mods_lines(lines: list[str]):
    """(index, line) for every line inside the `[Mods]` section."""
    in_mods = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("["):
            in_mods = stripped.lower() == "[mods]"
            continue
        if in_mods:
            yield index, line


def _split_entries(value: str) -> list[str]:
    return [entry.strip() for entry in value.split("|") if entry.strip()]


def ensure_mods_enabled(cfg_path: Optional[Path] = None) -> bool:
    """Blank out `[Mods] DisableAllMods` if the game set it to a truthy value.
    Returns True if the file was actually changed."""
    path = Path(cfg_path) if cfg_path else get_trove_cfg_path()
    lines = _read_lines(path)
    if lines is None:
        return False

    changed = False
    for index, line in _mods_lines(lines):
        match = _DISABLE_ALL_RE.match(line)
        if match and match.group(2).strip().lower() in _TRUTHY:
            eol = "\r" if line.endswith("\r") else ""
            lines[index] = f"{match.group(1)} {eol}"
            changed = True

    if not changed or not _write_lines(path, lines):
        return False

    print(f"[trove_cfg] cleared DisableAllMods in {path}")
    return True


def read_disabled_mods(cfg_path: Optional[Path] = None) -> set[str]:
    """The keys in `[Mods] DisabledMods` (see `mod_key`)."""
    lines = _read_lines(Path(cfg_path) if cfg_path else get_trove_cfg_path())
    for _, line in _mods_lines(lines or []):
        match = _DISABLED_MODS_RE.match(line)
        if match:
            return set(_split_entries(match.group(2)))
    return set()


def set_mods_disabled(enable: Iterable[str] = (), disable: Iterable[str] = (),
                      cfg_path: Optional[Path] = None) -> bool:
    """Drop `enable` keys from `DisabledMods` and append `disable` keys to it,
    keeping every other entry where it was. Creates the line (and the `[Mods]`
    section) when Trove hasn't written one yet. Returns True if the file was
    actually changed."""
    path = Path(cfg_path) if cfg_path else get_trove_cfg_path()
    enable, disable = set(enable), [k for k in dict.fromkeys(disable) if k]
    lines = _read_lines(path) or [""]

    target, prefix, entries = None, "DisabledMods =", []
    for index, line in _mods_lines(lines):
        match = _DISABLED_MODS_RE.match(line)
        if match:
            target, prefix, entries = index, match.group(1), _split_entries(match.group(2))
            break

    updated = [e for e in entries if e not in enable]
    updated += [k for k in disable if k not in updated]
    if updated == entries:
        return False

    eol = "\r" if lines[0].endswith("\r") else ""
    new_line = f"{prefix} {'|'.join(updated)}{eol}"
    header = next((i for i, line in enumerate(lines) if line.strip().lower() == "[mods]"), None)
    if target is not None:
        lines[target] = new_line
    elif header is not None:
        lines.insert(header + 1, new_line)
    else:
        if lines[-1].strip():
            lines[-1] += eol
            lines.append("")
        lines[-1:] = [f"[Mods]{eol}", new_line, ""]

    return _write_lines(path, lines)
