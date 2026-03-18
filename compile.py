import urllib.request
import zipfile
import os
import json
from pathlib import Path
from cx_Freeze import setup, Executable

# --- APP METADATA ---
with open("metadata.json", "r", encoding="utf-8") as f:
    meta = json.load(f)

APP_NAME = meta["APP_NAME"]
APP_TECH_NAME = meta["APP_TECH_NAME"]
APP_VERSION = meta["APP_VERSION"]
APP_AUTHOR = meta["APP_AUTHOR"]
APP_DESCRIPTION = meta["APP_DESCRIPTION"]
APP_GUID = meta["APP_GUID"]

def download_chromium():
    """Fetches the latest Chromium snapshot and extracts it for compilation."""
    bin_dir = Path("bin")
    chrome_win_dir = bin_dir / "chrome-win"
    
    # Check if we already downloaded it to save time
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

# 1. Pre-compile step: ensure Chromium is present
download_chromium()

# 2. Configure cx_Freeze options
build_exe_options = {
    "excludes": [
        "wheel",
        "cx_Freeze",
    ],
    "include_files": [
        ("web/", "web/"),       # Eel frontend
        ("bin/", "bin/"),       # Downloaded Chromium
        ("trove.dll", "trove.dll"), # Needed for utils hash calculation
        ("metadata.json", "metadata.json"),
    ],
    "optimize": 2,
    "include_msvcr": True,
}

bdist_msi_options = {
    "initial_target_dir": rf"[ProgramFiles64Folder]\{APP_TECH_NAME}",
    "upgrade_code": APP_GUID,
    "add_to_path": False,
    "all_users": True,
    "install_icon": "web/favicon.ico", # Uncomment if you add an icon!
}

options = {"build_exe": build_exe_options, "bdist_msi": bdist_msi_options}

setup(
    name=APP_NAME,
    version=APP_VERSION,
    author=APP_AUTHOR,
    description=APP_DESCRIPTION,
    options=options,
    executables=[
        Executable(
            "main.py", # Your new main file
            icon="web/favicon.ico",
            target_name=f"{APP_TECH_NAME}.exe",
            base="gui", # Hides the console window
            shortcut_name=APP_NAME,
            shortcut_dir="DesktopFolder",
        )
    ],
)