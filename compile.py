import json
from cx_Freeze import setup, Executable

with open("metadata.json", "r", encoding="utf-8") as f:
    meta = json.load(f)

APP_NAME = meta["APP_NAME"]
APP_TECH_NAME = meta["APP_TECH_NAME"]
APP_VERSION = meta["APP_VERSION"]
APP_AUTHOR = meta["APP_AUTHOR"]
APP_DESCRIPTION = meta["APP_DESCRIPTION"]
APP_GUID = meta["APP_GUID"]

build_exe_options = {
    "excludes": [
        "wheel",
        "cx_Freeze",
    ],
    "include_files": [
        ("web/", "web/"),
        ("trove.dll", "trove.dll"),
        ("metadata.json", "metadata.json"),
        ("LICENSE", "LICENSE"),
        ("README.md", "README.md"),
    ],
    "optimize": 2,
    "include_msvcr": True,
}

bdist_msi_options = {
    "initial_target_dir": rf"[ProgramFiles64Folder]\{APP_TECH_NAME}",
    "upgrade_code": APP_GUID,
    "add_to_path": False,
    "all_users": True,
    "install_icon": "web/favicon.ico",
    "launch_on_finish": True,
}

options = {"build_exe": build_exe_options, "bdist_msi": bdist_msi_options}

setup(
    name=APP_NAME,
    version=APP_VERSION,
    author=APP_AUTHOR,
    description=APP_NAME,
    options=options,
    executables=[
        Executable(
            "main.py",
            icon="web/favicon.ico",
            target_name=f"{APP_TECH_NAME}.exe",
            base="gui",
            shortcut_name=APP_NAME,
            shortcut_dir="DesktopFolder",
            copyright=f"{APP_AUTHOR} 2026-Present",
        )
    ],
)
