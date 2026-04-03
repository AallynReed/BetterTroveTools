import json
import os
import socket
import sys
import threading
import time
import winreg
from pathlib import Path

import requests
import bottle
import eel

os.environ["GOOGLE_API_KEY"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_ID"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_SECRET"] = "no"

import backend.about
import backend.calculators
import backend.file_manager
import backend.gem_builds
import backend.gem_simulator
import backend.home
import backend.mod_manager
import backend.modder_tools
import backend.settings
import backend.star_chart
import backend.trovesaurus

if getattr(sys, 'frozen', False):
    base_dir = os.path.dirname(sys.executable)
    if not hasattr(sys, '_MEIPASS'):
        sys._MEIPASS = base_dir
        DEV_MODE = False
    os.chdir(base_dir)
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    DEV_MODE = True

IPC_PORT = 28923

def register_btt_protocol():
    if sys.platform == 'win32':
        try:
            exe_path = sys.executable if getattr(sys, 'frozen', False) else os.path.abspath(sys.argv[0])
            
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\btt")
            winreg.SetValue(key, "", winreg.REG_SZ, "URL:btt Protocol")
            winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
            
            cmd_key = winreg.CreateKey(key, r"shell\open\command")
            winreg.SetValue(cmd_key, "", winreg.REG_SZ, f'"{exe_path}" "%1"')
        except Exception as e:
            print(f"Failed to register protocol: {e}")

def check_single_instance_and_send_ipc():
    url = None
    for arg in sys.argv:
        if arg.startswith('btt://'):
            url = arg
            break

    try:
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.connect(('localhost', IPC_PORT))
        
        if url:
            client.sendall(url.encode('utf-8'))
            print("Link sent to existing instance. Exiting.")
        else:
            client.sendall(b"WAKE_UP") 
            print("Another instance is already running. Exiting.")
            
        client.close()
        sys.exit(0)
    except ConnectionRefusedError:
        pass  
            
    return url

def start_ipc_server():
    def listen():
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(('localhost', IPC_PORT))
        server.listen(1)
        while True:
            conn, addr = server.accept()
            data = conn.recv(1024).decode('utf-8')
            if data and data.startswith('btt://'):
                eel.handle_deep_link(data)()
            conn.close()
            
    threading.Thread(target=listen, daemon=True).start()

def clean_chromium_startup(exe_path):
    """
    Checks the HKCU Run registry key for entries containing the specific
    Chromium executable path and removes them.
    """
    if sys.platform != 'win32':
        return

    run_key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, run_key_path, 0, winreg.KEY_READ | winreg.KEY_WRITE)
        
        values_to_delete = []
        i = 0
        
        while True:
            try:
                name, value, _ = winreg.EnumValue(key, i)
                if exe_path.lower() in value.lower():
                    values_to_delete.append(name)
                i += 1
            except OSError:
                break
                
        for name in values_to_delete:
            winreg.DeleteValue(key, name)
            print(f"✅ Removed unwanted Chromium startup entry: '{name}'")
            
        winreg.CloseKey(key)
    except Exception as e:
        print(f"⚠️ Failed to check/remove startup registry keys: {e}")

register_btt_protocol()
startup_url = check_single_instance_and_send_ipc()
start_ipc_server()

@eel.expose
def get_startup_url():
    return startup_url

@eel.expose
def get_app_metadata():
    meta_path = os.path.join(base_dir, "metadata.json")
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


LOCALE_DIR = Path("web/assets/locale")

@eel.expose
def get_available_languages():
    LOCALE_DIR.mkdir(parents=True, exist_ok=True)
    languages = []
    
    for file_path in LOCALE_DIR.glob("*.json"):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                keys = data.get("keys", {})
                total_keys = len(keys)
                
                if file_path.stem == "en_US":
                    percent = 100
                elif total_keys == 0:
                    percent = 0
                else:
                    empty_keys = sum(1 for v in keys.values() if str(v).strip() == "")
                    percent = int(((total_keys - empty_keys) / total_keys) * 100)

                languages.append({
                    "code": file_path.stem,
                    "name": data.get("language_name", file_path.stem),
                    "percent": percent
                })
        except Exception as e:
            print(f"⚠️ Error reading locale file {file_path}: {e}")
            
    languages.sort(key=lambda x: (x["code"] != "en_US", x["name"]))
    
    return languages

@eel.expose
def add_missing_translation_keys(locale_code, missing_keys):
    if not missing_keys:
        return {"success": True}
    
    file_path = LOCALE_DIR / f"{locale_code}.json"
    if not file_path.exists():
        return {"success": False, "error": "Locale file not found."}
        
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        if "keys" not in data:
            data["keys"] = {}
            
        added_count = 0
        for key in missing_keys:
            if key not in data["keys"]:
                data["keys"][key] = ""
                added_count += 1
                
        if added_count > 0:
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4, ensure_ascii=False)
                
        return {"success": True, "added": added_count}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@bottle.route('/api/cache/<filename>')
def serve_cache(filename):
    cache_dir = Path(os.getenv("APPDATA")) / "Trove" / "ModManagerCache"
    
    if ".." in filename or "/" in filename or "\\" in filename:
        return bottle.HTTPError(403, "Forbidden")
        
    response = bottle.static_file(filename, root=str(cache_dir))
    response.set_header("Cache-Control", "no-cache, no-store, must-revalidate")
    return response

@bottle.route('/proxy/bilibili_image')
def proxy_bilibili_image():
    url = bottle.request.query.get('url')
    if not url or "hdslb.com" not in url:
        return bottle.HTTPError(403, "Forbidden")
        
    try:
        headers = {
            "Referer": "https://www.bilibili.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        resp = requests.get(url, headers=headers, timeout=5)
        bottle.response.set_header("Cache-Control", "max-age=86400")
        bottle.response.content_type = resp.headers.get('content-type', 'image/jpeg')
        return resp.content
    except Exception as e:
        return bottle.HTTPError(500, str(e))

chromium_path = os.path.join(base_dir, 'bin', 'chrome-win', 'chrome.exe')
appdata_path = os.path.join(os.getenv('APPDATA'), 'Trove', 'ModManagerCache', 'profile')

print(f"Looking for Chromium at: {chromium_path}")
if not os.path.exists(chromium_path):
    print("❌ ERROR: Chromium .exe not found at the path above!")
    print("Please check your 'bin' folder and update the folder names in main.py.")
    sys.exit(1)
else:
    print("✅ Chromium found! Cleaning up startup registry...")
    clean_chromium_startup(chromium_path)
    print("✅ Starting app...")

eel.browsers.set_path('chrome', chromium_path)

eel.init(os.path.join(base_dir, 'web'))

start_port = 28924
max_ports_to_try = 10

for current_port in range(start_port, start_port + max_ports_to_try):
    try:
        print(f"Attempting to launch UI on port {current_port}...")
        eel.start('index.html', mode='chrome', size=(1600, 1000), port=current_port, cmdline_args=[
            '--disable-infobars',
            '--no-default-browser-check',
            '--no-first-run',
            '--disable-background-mode',
            '--disable-features=BackgroundMode,AutoLaunchAtStartup',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--disable-default-apps',
            '--metrics-recording-only',
            f'--user-data-dir={appdata_path}',
            '--incognito',
            '--disable-cache',
            '--disk-cache-size=0',
            '--media-cache-size=0',
            '--disable-application-cache',
            '--disable-component-extensions-with-background-pages',
            '--disable-client-side-phishing-detection',
            '--disable-breakpad',
        ])
        break
    except OSError as e:
        print(f"⚠️ Port {current_port} is unavailable ({e}).")
        if current_port == start_port + max_ports_to_try - 1:
            print(f"❌ ERROR: Could not find an open port after {max_ports_to_try} attempts. Exiting cleanly.")
            sys.exit(1)
    except (SystemExit, MemoryError, KeyboardInterrupt):
        sys.exit(0)

try:
    clean_chromium_startup(chromium_path)
except Exception as e:
    print(f"⚠️ Failed to clean up startup registry: {e}")