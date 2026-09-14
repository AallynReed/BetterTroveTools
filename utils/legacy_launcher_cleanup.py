"""Purge data left behind by the removed Trove launcher tab and in-game overlay.

The launcher stored DPAPI-encrypted Glyph passwords and login tickets under
``<data dir>/TroveLauncher``; the overlay kept ``overlay.json`` in the cache
root. Both features are gone, so this runs on every launch and deletes whatever
is still there, overwriting secret blobs before unlinking them.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from utils.path import get_app_data_dir, get_cache_root, get_default_app_data_dir


def _scrub(path: Path) -> None:
    try:
        size = path.stat().st_size
        with open(path, "r+b") as fh:
            fh.write(b"\0" * size)
            fh.flush()
    except OSError:
        pass


def _purge_launcher_dir(root: Path) -> bool:
    folder = root / "TroveLauncher"
    if not folder.is_dir():
        return False
    for blob in folder.glob("*.bin"):
        _scrub(blob)
    shutil.rmtree(folder, ignore_errors=True)
    return True


def purge() -> None:
    roots = {get_app_data_dir(), get_default_app_data_dir()}
    for root in roots:
        try:
            if _purge_launcher_dir(root):
                print(f"Removed leftover Trove launcher data from {root}")
        except Exception:
            pass
    try:
        (get_cache_root() / "overlay.json").unlink(missing_ok=True)
    except Exception:
        pass
