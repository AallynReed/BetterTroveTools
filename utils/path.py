import os
import sys
from pathlib import Path

if sys.platform == "win32":
    BasePath = Path(sys.argv[0]).parent
else:
    BasePath = Path(__file__).parent.parent


# Environment variable / pointer file that relocate the data directory. The
# choice can't live in settings.json -- that file sits inside the very folder
# it would be pointing at.
DATA_DIR_ENV_VAR = "BTT_DATA_DIR"

_UNSET = object()
_override_cache = _UNSET


def supports_data_dir_override() -> bool:
    """Windows keeps %APPDATA%/Trove: the game itself reads ModCfgs from there,
    so moving it would silently break in-game mod configs."""
    return sys.platform != "win32"


def get_data_dir_override_file() -> Path:
    """Pointer file holding the user's chosen data directory."""
    xdg = os.getenv("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else (Path.home() / ".config")
    return base / "BetterTroveTools" / "data_dir"


def _clean(value) -> Path | None:
    text = os.path.expandvars(str(value or "").strip())
    return Path(text).expanduser() if text else None


def refresh_data_dir_override() -> None:
    """Drop the cached pointer-file read (after writing it, or in tests)."""
    global _override_cache
    _override_cache = _UNSET


def get_data_dir_override() -> Path | None:
    """The user's replacement for the default data directory, or None.

    First match wins: the BTT_DATA_DIR environment variable, then the pointer
    file written by the Settings page. Ignored on Windows.
    """
    global _override_cache
    if not supports_data_dir_override():
        return None

    env = _clean(os.getenv(DATA_DIR_ENV_VAR))
    if env:
        return env

    if _override_cache is _UNSET:
        try:
            _override_cache = _clean(get_data_dir_override_file().read_text(encoding="utf-8"))
        except OSError:
            _override_cache = None
    return _override_cache


def set_data_dir_override(path) -> Path | None:
    """Write (or, for an empty path, delete) the pointer file. Only takes full
    effect on the next launch -- paths resolved during this run keep pointing at
    the old directory."""
    target = _clean(path)
    file = get_data_dir_override_file()
    if target is None:
        file.unlink(missing_ok=True)
    else:
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(str(target), encoding="utf-8")
    refresh_data_dir_override()
    return target


def get_default_app_data_dir() -> Path:
    """Where storage lives when nothing overrides it.

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


def get_app_data_dir() -> Path:
    """Per-user writable base directory for all Better Trove Tools storage
    (settings, caches, mod cfgs, downloaded data). Honours the user's override
    where the platform allows one, otherwise the default layout."""
    return get_data_dir_override() or get_default_app_data_dir()


def get_cache_root() -> Path:
    """Mod-manager / codex / downloaded-asset cache root.

    Resolves to %APPDATA%/Trove/ModManagerCache on Windows (identical to the
    historical path) and ~/.local/share/BetterTroveTools/ModManagerCache on
    Linux. Pure path computation -- callers create the directory when needed.
    """
    return get_app_data_dir() / "ModManagerCache"
