import eel
import sys
import os

import backend.mod_manager
import backend.file_manager
import backend.trovesaurus

if hasattr(sys, '_MEIPASS'):
    base_dir = sys._MEIPASS
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))

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
    eel.start('index.html', mode='chrome', size=(1600, 900), port=28924)
except (SystemExit, MemoryError, KeyboardInterrupt):
    sys.exit()