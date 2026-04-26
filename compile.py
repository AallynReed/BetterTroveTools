import urllib.request
import zipfile
import os
import json
from pathlib import Path
from cx_Freeze import setup, Executable

with open("metadata.json", "r", encoding="utf-8") as f:
    meta = json.load(f)

APP_NAME = meta["APP_NAME"]
APP_TECH_NAME = meta["APP_TECH_NAME"]
APP_VERSION = meta["APP_VERSION"]
APP_AUTHOR = meta["APP_AUTHOR"]
APP_DESCRIPTION = meta["APP_DESCRIPTION"]
APP_GUID = meta["APP_GUID"]

def download_chromium():
    bin_dir = Path("bin")
    chrome_win_dir = bin_dir / "chrome-win"
    
    if chrome_win_dir.exists() and (chrome_win_dir / "chrome.exe").exists():
        print("✅ Chromium already exists in bin/chrome-win. Skipping download.")
        return

    print("🔍 Fetching latest Chromium revision...")
    revision_url = "https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Win_x64%2FLAST_CHANGE?alt=media"
    
    try:
        req = urllib.request.Request(revision_url)
        with urllib.request.urlopen(req) as response:
            revision = response.read().decode('utf-8').strip()
            
        print(f"📥 Downloading Chromium revision {revision} (This may take a minute)...")
        zip_url = f"https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Win_x64%2F{revision}%2Fchrome-win.zip?alt=media"
        zip_path = "chrome-win.zip"
        
        urllib.request.urlretrieve(zip_url, zip_path)
        
        print("📦 Extracting Chromium...")
        bin_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(bin_dir)
        
        os.remove(zip_path)
        print("✅ Chromium download and extraction complete!")
        
    except Exception as e:
        print(f"❌ Failed to download Chromium: {e}")
        exit(1)

download_chromium()

build_exe_options = {
    "excludes": [
        "wheel",
        "cx_Freeze",
    ],
    "include_files": [
        ("web/", "web/"),
        ("bin/", "bin/"),
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
