import os
import sys
from pathlib import Path

if sys.platform == "win32":
    BasePath = Path(sys.argv[0]).parent
else:
    BasePath = Path(__file__).parent.parent


def get_app_data_dir() -> Path:
    """Per-user writable base directory for all Better Trove Tools storage
    (settings, caches, mod cfgs, downloaded data).

    Windows: %APPDATA%/Trove -- unchanged from the original layout, so the same
    files keep resolving to the same place (the app shares the game's "Trove"
    AppData folder, which is intentional).

    Linux/macOS: $XDG_DATA_HOME/BetterTroveTools (or ~/.local/share/...). Trove
    itself isn't installed there, so we use a dedicated app folder instead of a
    shared "Trove" dir.
    """
    if sys.platform == "win32":
        base = os.getenv("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "Trove"

    xdg = os.getenv("XDG_DATA_HOME")
    base = Path(xdg) if xdg else (Path.home() / ".local" / "share")
    return base / "BetterTroveTools"


def get_cache_root() -> Path:
    """Mod-manager / codex / downloaded-asset cache root.

    Resolves to %APPDATA%/Trove/ModManagerCache on Windows (identical to the
    historical path) and ~/.local/share/BetterTroveTools/ModManagerCache on
    Linux. Pure path computation -- callers create the directory when needed.
    """
    return get_app_data_dir() / "ModManagerCache"
