import os
import threading
from pathlib import Path
from typing import Optional

from utils.executable import find_trove_executable
import vdf

# Cached result of the registry + Steam-library scan. The scan touches the
# Windows registry, parses libraryfolders.vdf, and runs find_trove_executable
# per discovered directory -- none of that changes during the lifetime of
# the app unless the user installs/uninstalls Trove or edits their custom
# directories. Many frontend views call get_detected_game_paths() / get_settings()
# at init time, so caching this turned ~5-10 redundant registry scans per
# session into a single one at startup.
_TROVE_LOCATIONS_CACHE: Optional[list] = None
_TROVE_LOCATIONS_LOCK = threading.Lock()


def invalidate_trove_locations_cache() -> None:
    """Drop the cached scan. Call this when something that could change which
    installs are detected actually changes (e.g. custom_directories saved).
    The next get_trove_locations() call performs a fresh scan."""
    global _TROVE_LOCATIONS_CACHE
    with _TROVE_LOCATIONS_LOCK:
        _TROVE_LOCATIONS_CACHE = None


if os.name == "nt":
    import winreg

    Hives = [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]
    Nodes = ["WOW6432Node\\"]
    TrovePath = "Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
    TroveKey = "Glyph Trove"
    TroveInstallValue = "InstallLocation"
    SteamPath = "Valve\\"
    SteamKey = "Steam"
    SteamInstallValue = "InstallPath"
    SteamTroveID = "304050"


def add_to_startup(exe_path, app_name, args):
    key = r"Software\Microsoft\Windows\CurrentVersion\Run"
    command = f'"{exe_path}" {args}'
    registry_key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_WRITE)
    winreg.SetValueEx(registry_key, app_name, 0, winreg.REG_SZ, command)
    winreg.CloseKey(registry_key)


def remove_from_startup(app_name):
    key = r"Software\Microsoft\Windows\CurrentVersion\Run"
    registry_key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_WRITE)
    winreg.DeleteValue(registry_key, app_name)
    winreg.CloseKey(registry_key)


class TroveGamePath:
    def __init__(self, path: Path, steam: Optional[Path] = None, name: str = None):
        self.path = path
        self.steam = steam
        self._clean_name = None
        self.clean_name = name or self.path.name
        self._is_custom = bool(name)
        self._executable = None

    def __str__(self):
        return str(self.path)

    def __bool__(self):
        return self.is_valid

    def __repr__(self):
        return f"TroveGamePath({self.path!r}, steam={self.steam})"

    def __eq__(self, other):
        return self.path == other.path

    @property
    def clean_name(self):
        return self._clean_name

    @clean_name.setter
    def clean_name(self, value):
        self._clean_name = value

    @property
    def name(self):
        platform_name = "Steam" if self.is_steam else "Glyph"
        return f"({platform_name}) {self.clean_name}"

    @property
    def is_glyph(self):
        return not self.is_custom and self.steam is None

    @property
    def is_steam(self):
        return not self.is_custom and self.steam is not None

    @property
    def is_custom(self):
        return self._is_custom

    @property
    def icon(self):
        if self.is_glyph:
            return "icons/brands/glyph.png"
        if self.is_steam:
            return "icons/brands/steam.png"
        return "icons/brands/trove.png"

    @property
    def executable(self):
        # Resolved once per instance: is_valid touches this, and instances are
        # short-lived (rebuilt each get_settings).
        if self._executable is None:
            exe = find_trove_executable(self.path)
            self._executable = exe if exe else self.path.joinpath("Trove_x64.exe")
        return self._executable

    @property
    def is_valid(self):
        return self.path.exists() and self.executable.exists()

    @property
    def mods_path(self):
        if not self.is_custom:
            mods_path = self.path.joinpath("mods")
            mods_path.mkdir(exist_ok=True, parents=True)
            return mods_path
        return self.path

    @property
    def workshop_path(self):
        if self.is_steam:
            workshop_path = self.steam.joinpath("steamapps", "workshop", "content", "304050")
            if workshop_path.exists():
                return workshop_path
        return None

    @staticmethod
    def get_from_dir(path: Path, pattern: str, recursive: bool = False):
        tree = path.rglob(pattern) if recursive else path.glob(pattern)
        for mod in tree:
            if mod.is_file():
                yield mod

    @property
    def enabled_tmods(self):
        mods = []
        for mod in self.get_from_dir(self.mods_path, "*.tmod"):
            mods.append(mod)
        if self.workshop_path:
            for mod in self.get_from_dir(self.workshop_path, "*.tmod", True):
                mods.append(mod)
        return mods

    @property
    def disabled_tmods(self):
        mods = []
        for mod in self.get_from_dir(self.mods_path, "*.tmod.disabled"):
            mods.append(mod)
        if self.workshop_path:
            for mod in self.get_from_dir(self.workshop_path, "*.tmod.disabled", True):
                mods.append(mod)
        return mods

    @property
    def enabled_zips(self):
        mods = []
        for mod in self.get_from_dir(self.mods_path, "*.zip"):
            mods.append(mod)
        if self.workshop_path:
            for mod in self.get_from_dir(self.workshop_path, "*.zip", True):
                mods.append(mod)
        return mods

    @property
    def disabled_zips(self):
        mods = []
        for mod in self.get_from_dir(self.mods_path, "*.zip.disabled"):
            mods.append(mod)
        if self.workshop_path:
            for mod in self.get_from_dir(self.workshop_path, "*.zip.disabled", True):
                mods.append(mod)
        return mods


def sanity_check(path):
    return bool(find_trove_executable(path))


def get_keys(key, path, look_for):
    i = 0
    while True:
        try:
            subkey = winreg.EnumKey(key, i)
            if subkey.startswith(look_for):
                yield path + subkey + "\\"
        except WindowsError:
            break
        i += 1


def search_glyph_registry():
    for hive in Hives:
        for node in Nodes:
            try:
                look_path = "SOFTWARE\\" + node + TrovePath
                registry_key_path = winreg.OpenKeyEx(hive, look_path)
                keys = get_keys(registry_key_path, look_path, TroveKey)
                for Key in keys:
                    yield winreg.OpenKeyEx(hive, Key)
            except WindowsError:
                ...


def search_steam_registry():
    for hive in Hives:
        for node in Nodes:
            try:
                look_path = "SOFTWARE\\" + node + SteamPath
                registry_key_path = winreg.OpenKeyEx(hive, look_path)
                keys = get_keys(registry_key_path, look_path, SteamKey)
                for Key in keys:
                    yield winreg.OpenKeyEx(hive, Key)
            except WindowsError:
                ...


def _trove_from_steam_root(steam_root: Path) -> list:
    """Given a Steam installation root, parse libraryfolders.vdf and return any
    valid Trove installs found under steamapps/common/Trove/Games/Trove. Shared
    by the Windows (registry-derived root) and POSIX (well-known roots) scans."""
    found = []
    libraries_vdf = steam_root.joinpath("steamapps", "libraryfolders.vdf")
    if not libraries_vdf.exists():
        return found
    try:
        with libraries_vdf.open("r", encoding="utf-8") as f:
            data = vdf.load(f)
    except Exception:
        return found

    for _lib_index, library in data.get("libraryfolders", {}).items():
        lib_path_str = library.get("path") if isinstance(library, dict) else None
        if not lib_path_str:
            continue
        library_path = Path(lib_path_str)
        trove_root = library_path.joinpath("steamapps", "common", "Trove", "Games", "Trove")
        if not trove_root.exists():
            continue
        try:
            for game_path in trove_root.iterdir():
                if game_path.is_dir():
                    game = TroveGamePath(game_path, library_path)
                    if game.is_valid:
                        found.append(game)
        except OSError:
            continue
    return found


def _scan_trove_locations_posix() -> list:
    """Best-effort auto-detection on Linux/macOS: walk the well-known Steam
    install roots (incl. Flatpak) for a Trove install. Trove ships only on
    Windows, but a Steam/Proton install lays the game files out identically, and
    the codexes/mod tools only READ those files -- so detection still unlocks
    them. Returns [] when nothing is found; callers degrade gracefully."""
    home = Path.home()
    steam_roots = [
        home / ".steam" / "steam",
        home / ".steam" / "root",
        home / ".local" / "share" / "Steam",
        home / ".var" / "app" / "com.valvesoftware.Steam" / ".local" / "share" / "Steam",
        home / "Library" / "Application Support" / "Steam",  # macOS
    ]

    results = []
    seen_roots = set()
    seen_game_paths = set()
    for root in steam_roots:
        if not root.exists():
            continue
        try:
            resolved = root.resolve()
        except Exception:
            resolved = root
        if resolved in seen_roots:
            continue
        seen_roots.add(resolved)
        for game in _trove_from_steam_root(root):
            if game.path in seen_game_paths:
                continue
            seen_game_paths.add(game.path)
            results.append(game)
    return results


def _scan_trove_locations():
    """Actual scan -- registry + Steam library walk. Not called directly; go
    through get_trove_locations() so the result is cached for the rest of the
    process lifetime."""
    print("\n--- STARTING TROVE LOCATION SCAN ---")
    if os.name != "nt":
        # No Windows registry off-Windows; fall back to scanning Steam roots.
        return _scan_trove_locations_posix()

    results = []

    print("\n--- Scanning for Glyph ---")
    for Key in search_glyph_registry():
        try:
            game_path_str = winreg.QueryValueEx(Key, TroveInstallValue)[0]
            game_path = Path(game_path_str)
            print(f"[Glyph] Found registry path: {game_path}")

            game = TroveGamePath(game_path)
            if game.is_valid:
                print(f"[Glyph] ✅ Valid game found at: {game_path}")
                results.append(game)
            else:
                print(f"[Glyph] ❌ Invalid game path (missing trove*.exe): {game_path}")
        except OSError as e:
            print(f"[Glyph] Error reading registry value: {e}")
            continue

    for Key in search_steam_registry():
        try:
            try:
                steam_path_str = winreg.QueryValueEx(Key, "InstallPath")[0]
            except FileNotFoundError:
                try:
                    steam_path_str = winreg.QueryValueEx(Key, "SteamPath")[0]
                except FileNotFoundError:
                    continue

            results.extend(_trove_from_steam_root(Path(steam_path_str)))

        except OSError:
            continue

    return results


def get_trove_locations():
    """Return the cached list of detected Trove installs. The expensive scan
    (registry + Steam VDF + per-dir PE checks) runs at most once per process
    -- subsequent calls return the same list instantly. Call
    invalidate_trove_locations_cache() to force a rescan."""
    global _TROVE_LOCATIONS_CACHE
    cached = _TROVE_LOCATIONS_CACHE
    if cached is not None:
        return cached

    with _TROVE_LOCATIONS_LOCK:
        if _TROVE_LOCATIONS_CACHE is not None:
            return _TROVE_LOCATIONS_CACHE
        scanned = _scan_trove_locations()
        _TROVE_LOCATIONS_CACHE = scanned
        return scanned