import os
from pathlib import Path
from typing import Optional

import vdf

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
        return self.path.joinpath("Trove_x64.exe")

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
            workshop_path = self.steam.joinpath("steamapps\\workshop\\content\\304050")
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
    trove_executable = path.joinpath("Trove_x64.exe")
    if not trove_executable.exists():
        return False
    return True


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


def get_trove_locations():
    print("\n--- STARTING TROVE LOCATION SCAN ---")
    if os.name != "nt":
        print("Not running on Windows (nt). Aborting.")
        return []

    print("\n--- Scanning for Glyph ---")
    for Key in search_glyph_registry():
        try:
            game_path_str = winreg.QueryValueEx(Key, TroveInstallValue)[0]
            game_path = Path(game_path_str)
            print(f"[Glyph] Found registry path: {game_path}")
            
            game = TroveGamePath(game_path)
            if game.is_valid:
                print(f"[Glyph] ✅ Valid game found at: {game_path}")
                yield game
            else:
                print(f"[Glyph] ❌ Invalid game path (missing Trove_x64.exe): {game_path}")
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

            steam_path = Path(steam_path_str)
            steam_libraries_path = steam_path.joinpath("steamapps", "libraryfolders.vdf")

            if not steam_libraries_path.exists():
                continue

            with steam_libraries_path.open("r", encoding="utf-8") as f:
                steam_libraries = vdf.load(f)

            libraries = steam_libraries.get("libraryfolders", {})

            for lib_index, library in libraries.items():
                lib_path_str = library.get("path")
                library_path = Path(lib_path_str)
                
                local_trove_path = library_path.joinpath("steamapps", "common", "Trove", "Games", "Trove")

                if not local_trove_path.exists():
                    continue

                for game_path in local_trove_path.iterdir():
                    if game_path.is_dir():
                        game = TroveGamePath(game_path, library_path)
                        if game.is_valid:
                            yield game

        except OSError:
            continue