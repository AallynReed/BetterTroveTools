import atexit
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import winreg
from pathlib import Path

import bottle
import eel
import requests
from gevent.exceptions import ConcurrentObjectUseError

os.environ["GOOGLE_API_KEY"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_ID"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_SECRET"] = "no"

import backend.about
import backend.allies
import backend.calculators
import backend.file_manager
import backend.gems_and_builds.gem_builds
import backend.gems_and_builds.gem_evaluator
import backend.gems_and_builds.gem_simulator
import backend.home
import backend.items
import backend.mementos
import backend.mounts
import backend.mod_manager
import backend.modder_tools
import backend.recipes
import backend.settings
import backend.gems_and_builds.star_chart
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

IPC_LOCK_FILE = Path(os.getenv('APPDATA', '')) / 'Trove' / 'btt_ipc.lock'

def get_free_port():
    """Ask the OS for an available port by binding to port 0."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('localhost', 0))
        return s.getsockname()[1]

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
        port = int(IPC_LOCK_FILE.read_text().strip())
    except Exception:
        return url  # No lock file or unreadable — we are the first instance

    try:
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(2)
        client.connect(('localhost', port))

        if url:
            client.sendall(url.encode('utf-8'))
            print("Link sent to existing instance. Exiting.")
        else:
            client.sendall(b"WAKE_UP")
            print("Another instance is already running. Exiting.")

        client.close()
        sys.exit(0)
    except (ConnectionRefusedError, OSError):
        # Stale lock file from a crashed previous run — clean up and continue
        try:
            IPC_LOCK_FILE.unlink()
        except Exception:
            pass

    return url

def start_ipc_server():
    ipc_port = get_free_port()

    IPC_LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    IPC_LOCK_FILE.write_text(str(ipc_port))
    atexit.register(lambda: IPC_LOCK_FILE.unlink(missing_ok=True))

    def listen():
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(('localhost', ipc_port))
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

def install_safe_eel_websocket():
    def safe_websocket(ws):
        for js_function in eel._js_functions:
            eel._import_js_function(js_function)

        page = bottle.request.query.page
        if page not in eel._mock_queue_done:
            for call in eel._mock_queue:
                eel._repeated_send(ws, eel._safe_json(call))
            eel._mock_queue_done.add(page)

        eel._websockets += [(page, ws)]

        try:
            while True:
                try:
                    msg = ws.receive()
                except (ConcurrentObjectUseError, BlockingIOError, OSError):
                    break

                if msg is None:
                    break

                message = eel.jsn.loads(msg)
                eel.spawn(eel._process_message, message, ws)
        finally:
            try:
                eel._websockets.remove((page, ws))
            except ValueError:
                pass
            try:
                eel._websocket_close(page)
            except Exception:
                pass

    eel._websocket = safe_websocket
    eel.BOTTLE_ROUTES["/eel"] = (safe_websocket, dict(apply=[eel.wbs.websocket]))


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


def get_cache_root():
    appdata = os.getenv("APPDATA")
    if appdata:
        return Path(appdata) / "Trove" / "ModManagerCache"
    return Path(tempfile.gettempdir()) / "BetterTroveToolsCache"


def _safe_asset_name(asset_name, version_tag):
    candidate = Path(str(asset_name or "").strip()).name
    if candidate.lower().endswith(".msi"):
        return candidate

    clean_version = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "_" for ch in str(version_tag or "latest"))
    return f"BetterTroveTools-{clean_version}.msi"


def _build_update_script(script_path, msi_path, app_path, installer_log_path):
    def q(value):
        return str(value).replace('"', '""')

    return "\n".join([
        'On Error Resume Next',
        'Dim shell, fso, service, processes, process, exitCode, success, scriptPath',
        'Set shell = CreateObject("WScript.Shell")',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        f'scriptPath = "{q(script_path)}"',
        '',
        'Function WaitForProcessExit(pid, maxChecks, sleepMs)',
        '    Dim i, svc, procSet',
        '    Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")',
        '    For i = 1 To maxChecks',
        '        Set procSet = svc.ExecQuery("Select * from Win32_Process Where ProcessId = " & pid)',
        '        If procSet.Count = 0 Then',
        '            WaitForProcessExit = True',
        '            Exit Function',
        '        End If',
        '        WScript.Sleep sleepMs',
        '    Next',
        '    WaitForProcessExit = False',
        'End Function',
        '',
        f'Call WaitForProcessExit({os.getpid()}, 240, 500)',
        f'exitCode = shell.Run("msiexec.exe /i ""{q(msi_path)}"" /passive /norestart /log ""{q(installer_log_path)}""", 0, True)',
        'success = (exitCode = 0) Or (exitCode = 1641) Or (exitCode = 3010)',
        '',
        'If success Then',
        '    WScript.Sleep 2000',
        f'    If fso.FileExists("{q(app_path)}") Then',
        f'        shell.Run """" & "{q(app_path)}" & """", 0, False',
        '    End If',
        'Else',
        f'    shell.Run "explorer.exe /select,""" & "{q(msi_path)}" & """", 1, False',
        'End If',
        '',
        'WScript.Sleep 1000',
        'If fso.FileExists(scriptPath) Then',
        '    fso.DeleteFile scriptPath, True',
        'End If',
    ])


def _schedule_process_exit(delay_seconds=1.5):
    def _exit_later():
        time.sleep(delay_seconds)
        os._exit(0)

    threading.Thread(target=_exit_later, daemon=True).start()


@eel.expose
def start_self_update(download_url, version_tag="", asset_name=""):
    if sys.platform != "win32":
        return {"success": False, "error": "Self-update is only supported on Windows."}
    if not getattr(sys, "frozen", False):
        return {"success": False, "error": "Self-update is only available in the packaged app build."}

    url = str(download_url or "").strip()
    if not url.lower().startswith(("https://", "http://")):
        return {"success": False, "error": "A valid installer download URL is required."}

    cache_root = get_cache_root()
    update_dir = cache_root / "updates"
    update_dir.mkdir(parents=True, exist_ok=True)

    safe_name = _safe_asset_name(asset_name, version_tag)
    msi_path = update_dir / safe_name
    installer_log_path = update_dir / f"{msi_path.stem}.log"
    helper_script_path = update_dir / f"apply_update_{int(time.time())}_{os.getpid()}.vbs"
    request_id = None
    download_ok = False

    try:
        try:
            request_id = eel.add_external_request(f"Downloading app update {version_tag}".strip(), url)()
        except Exception:
            request_id = None

        with requests.get(
            url,
            stream=True,
            timeout=(10, 300),
            headers={"User-Agent": "BetterTroveTools-Updater", "Accept": "application/octet-stream"},
        ) as response:
            response.raise_for_status()
            with open(msi_path, "wb") as installer_file:
                for chunk in response.iter_content(chunk_size=1024 * 512):
                    if chunk:
                        installer_file.write(chunk)

        download_ok = True
        helper_script_path.write_text(
            _build_update_script(
                helper_script_path,
                msi_path,
                Path(sys.executable),
                installer_log_path,
            ),
            encoding="utf-8",
        )

        subprocess.Popen(
            [
                "wscript.exe",
                "//B",
                "//NoLogo",
                str(helper_script_path),
            ],
            cwd=str(update_dir),
            close_fds=True,
        )

        _schedule_process_exit()
        return {
            "success": True,
            "data": {
                "installer_path": str(msi_path),
                "helper_script": str(helper_script_path),
                "version": str(version_tag or ""),
            },
        }
    except Exception as e:
        try:
            if msi_path.exists() and not download_ok:
                msi_path.unlink(missing_ok=True)
        except Exception:
            pass
        return {"success": False, "error": str(e)}
    finally:
        if request_id:
            try:
                eel.remove_external_request(request_id, download_ok)()
            except Exception:
                pass


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
install_safe_eel_websocket()

eel.init(os.path.join(base_dir, 'web'))

eel_port = get_free_port()
print(f"Launching UI on port {eel_port}...")
try:
    eel.start('index.html', mode='chrome', size=(1700, 1000), port=eel_port, cmdline_args=[
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
except OSError as e:
    print(f"❌ ERROR: Could not bind UI port {eel_port}: {e}")
    sys.exit(1)
except (SystemExit, MemoryError, KeyboardInterrupt):
    sys.exit(0)

try:
    clean_chromium_startup(chromium_path)
except Exception as e:
    print(f"⚠️ Failed to clean up startup registry: {e}")
