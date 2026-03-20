import json
import os
import sys

import eel

os.environ["GOOGLE_API_KEY"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_ID"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_SECRET"] = "no"

import backend.file_manager
import backend.mod_manager
import backend.modder_tools
import backend.settings
import backend.star_chart
import backend.trovesaurus

if getattr(sys, 'frozen', False):
    base_dir = os.path.dirname(sys.executable)
    if not hasattr(sys, '_MEIPASS'):
        sys._MEIPASS = base_dir
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))

@eel.expose
def get_app_metadata():
    meta_path = os.path.join(base_dir, "metadata.json")
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

chromium_path = os.path.join(base_dir, 'bin', 'chrome-win', 'chrome.exe')

print(f"Looking for Chromium at: {chromium_path}")
if not os.path.exists(chromium_path):
    print("❌ ERROR: Chromium .exe not found at the path above!")
    print("Please check your 'bin' folder and update the folder names in main.py.")
    sys.exit(1)
else:
    print("✅ Chromium found! Starting app...")

eel.browsers.set_path('chrome', chromium_path)

eel.init(os.path.join(base_dir, 'web'))

try:
    eel.start('index.html', mode='chrome', size=(1600, 900), port=28924, cmdline_args=[
        '--disable-infobars',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-background-mode',
        '--disable-dev-tools',
        '--disable-extensions',
        '--disable-sync',
        '--disable-translate',
    ])
except (SystemExit, MemoryError, KeyboardInterrupt):
    sys.exit()