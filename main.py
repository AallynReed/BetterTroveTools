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
import webview
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

WEBVIEW2_RUNTIME_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"
WEBVIEW2_CLIENT_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


def webview2_runtime_installed():
    """Return True if the Evergreen WebView2 runtime is installed.

    The runtime registers a version (`pv`) under the EdgeUpdate Clients key,
    either per-machine (HKLM, both registry views) or per-user (HKCU).
    """
    if sys.platform != 'win32':
        return True

    locations = [
        (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_64KEY),
        (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY),
        (winreg.HKEY_CURRENT_USER, 0),
    ]
    for root, view in locations:
        try:
            with winreg.OpenKey(
                root,
                rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_GUID}",
                0,
                winreg.KEY_READ | view,
            ) as key:
                version, _ = winreg.QueryValueEx(key, "pv")
                if version and version != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


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
        # os._exit skips atexit, so drop the single-instance lock ourselves
        # before exiting — otherwise the post-update relaunch sees a stale lock.
        IPC_LOCK_FILE.unlink(missing_ok=True)
        os._exit(0)

    threading.Thread(target=_exit_later, daemon=True).start()


@eel.expose
def finalize_self_update_exit(delay_seconds=1.5):
    try:
        delay = float(delay_seconds)
    except Exception:
        delay = 1.5
    _schedule_process_exit(max(0.2, delay))
    return {"success": True}


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
    if ".." in filename or "/" in filename or "\\" in filename:
        return bottle.HTTPError(403, "Forbidden")

    cache_root = get_cache_root()
    direct_path = cache_root / filename
    if direct_path.is_file():
        response = bottle.static_file(filename, root=str(cache_root))
        response.set_header("Cache-Control", "no-cache, no-store, must-revalidate")
        return response

    matches = list(cache_root.rglob(filename))
    if not matches:
        return bottle.HTTPError(404, "Cache file not found")

    response = bottle.static_file(matches[0].name, root=str(matches[0].parent))
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

# pywebview renders the UI in the Microsoft Edge WebView2 runtime, so we don't
# ship or depend on a full browser install. Eel runs as a server only.
if not webview2_runtime_installed():
    # base="gui" has no console, so a printed message is never seen — show a
    # native dialog and offer to open the download page.
    import ctypes

    message = (
        "Better Trove Tools needs the Microsoft Edge WebView2 runtime, "
        "but it isn't installed on this PC.\n\n"
        f"Download and install it from:\n{WEBVIEW2_RUNTIME_URL}\n\n"
        "Open the download page now?"
    )
    # MB_YESNO (0x4) | MB_ICONERROR (0x10) | MB_SETFOREGROUND (0x10000)
    choice = ctypes.windll.user32.MessageBoxW(0, message, "WebView2 runtime required", 0x4 | 0x10 | 0x10000)
    if choice == 6:  # IDYES
        try:
            os.startfile(WEBVIEW2_RUNTIME_URL)
        except Exception:
            pass
    sys.exit(1)

try:
    with open(os.path.join(base_dir, "metadata.json"), "r", encoding="utf-8") as meta_file:
        window_title = json.load(meta_file).get("APP_NAME", "Better Trove Tools")
except Exception:
    window_title = "Better Trove Tools"

webview_storage_path = os.path.join(os.getenv('APPDATA'), 'Trove', 'WebView2')

print("✅ Starting app...")

install_safe_eel_websocket()
eel.init(os.path.join(base_dir, 'web'))

eel_port = get_free_port()
print(f"Launching UI server on port {eel_port}...")


def run_eel_server():
    # mode=None serves the app without launching a browser. The no-op
    # close_callback stops Eel from shutting the server down when the websocket
    # drops — pywebview owns the window lifecycle below.
    eel.start(
        'index.html',
        mode=None,
        port=eel_port,
        block=True,
        close_callback=lambda *args: None,
        suppress_error=True,
    )


def wait_for_server(port, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(('localhost', port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


threading.Thread(target=run_eel_server, daemon=True).start()

if not wait_for_server(eel_port):
    print("❌ ERROR: UI server failed to start.")
    sys.exit(1)

print("✅ Server ready. Opening window...")
webview.create_window(
    window_title,
    f'http://localhost:{eel_port}/index.html',
    width=1700,
    height=1000,
    min_size=(1100, 700),
)
webview.start(
    private_mode=False,
    storage_path=webview_storage_path,
    icon=os.path.join(base_dir, 'web', 'favicon.ico'),
)

# webview.start() returns once the user closes the window — shut everything down.
IPC_LOCK_FILE.unlink(missing_ok=True)
os._exit(0)
