import atexit
import json
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

if sys.platform == "win32":
    import winreg

import bottle
import eel
import requests
import webview
from gevent.exceptions import ConcurrentObjectUseError

from utils.path import get_app_data_dir, get_cache_root

os.environ["GOOGLE_API_KEY"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_ID"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_SECRET"] = "no"

import backend.about
import backend.auth
import backend.codexes.allies
import backend.codexes.badges
import backend.calculators
import backend.modder_tools.file_manager
import backend.codexes.fish
import backend.gems_and_builds.gem_builds
import backend.gems_and_builds.gem_evaluator
import backend.gems_and_builds.gem_simulator
import backend.home
import backend.codexes.items
import backend.codexes.mementos
import backend.codexes.mounts
import backend.mod_manager.mod_manager
import backend.modder_tools.modder_tools
import backend.codexes.recipes
import backend.settings
import backend.gems_and_builds.star_chart
import backend.mod_manager.trovesaurus
import backend.mod_manager.mods_hub
import backend.mod_manager.modpacks
import backend.mod_manager.profiles

if getattr(sys, 'frozen', False):
    base_dir = os.path.dirname(sys.executable)
    if not hasattr(sys, '_MEIPASS'):
        sys._MEIPASS = base_dir
        DEV_MODE = False
    os.chdir(base_dir)
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    DEV_MODE = True

IPC_LOCK_FILE = get_app_data_dir() / 'btt_ipc.lock'

try:
    with open(os.path.join(base_dir, "metadata.json"), "r", encoding="utf-8") as _meta_file:
        WINDOW_TITLE = json.load(_meta_file).get("APP_NAME", "Better Trove Tools")
except Exception:
    WINDOW_TITLE = "Better Trove Tools"

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
            # Any second-launch ping (deep link or WAKE_UP) should surface the
            # already-running window instead of silently doing nothing.
            if data:
                _surface_app_window(only_if_hidden=False)
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


def _surface_app_window(only_if_hidden=False, retries=1):
    """Find this process's main window by title and bring it to the front.

    The post-update relaunch can start the app hidden (the updater uses a
    minimized/hidden show flag), and a second launch should focus the running
    window. This works directly on the Win32 handle so it doesn't depend on the
    window-show state pywebview thinks it has.
    """
    if sys.platform != 'win32':
        return

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL

    my_pid = os.getpid()
    SW_SHOW, SW_RESTORE = 5, 9

    def find_hwnd():
        match = []

        def callback(hwnd, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value == my_pid:
                length = user32.GetWindowTextLengthW(hwnd)
                if length:
                    buffer = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buffer, length + 1)
                    if buffer.value == WINDOW_TITLE:
                        match.append(hwnd)
                        return False
            return True

        user32.EnumWindows(WNDENUMPROC(callback), 0)
        return match[0] if match else None

    for _ in range(max(1, retries)):
        hwnd = find_hwnd()
        if hwnd:
            if only_if_hidden and user32.IsWindowVisible(hwnd):
                return
            user32.ShowWindow(hwnd, SW_RESTORE if user32.IsIconic(hwnd) else SW_SHOW)
            user32.SetForegroundWindow(hwnd)
            return
        time.sleep(0.2)


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
        f'        shell.Run """" & "{q(app_path)}" & """", 1, False',
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


def _is_locale_file(file_path):
    # Only treat <lang>_<REGION>.json as a language file; skips engine aux files
    # like _ui_ids.json and locale.schema.json that also live in the locale dir.
    parts = file_path.stem.split("_")
    return (
        len(parts) == 2
        and 2 <= len(parts[0]) <= 3 and parts[0].islower()
        and 2 <= len(parts[1]) <= 4 and parts[1].isalpha()
    )


def _completion(data):
    # User-facing coverage over everything visible: UI strings + content. (The
    # contributor-facing validator reports UI-only separately.)
    strings = data.get("strings")
    if strings is None:
        values = list(data.get("keys", {}).values())  # legacy { language_name, keys }
    else:
        values = list(strings.values()) + list(data.get("content", {}).values())
    total = len(values)
    if total == 0:
        return 0
    empty = sum(1 for v in values if v == "" or v is None)
    return int(((total - empty) / total) * 100)


@eel.expose
def get_available_languages():
    LOCALE_DIR.mkdir(parents=True, exist_ok=True)
    languages = []

    for file_path in LOCALE_DIR.glob("*.json"):
        if not _is_locale_file(file_path):
            continue
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            meta = data.get("meta") or {}
            name = meta.get("name") or data.get("language_name") or file_path.stem
            percent = 100 if file_path.stem == "en_US" else _completion(data)
            languages.append({"code": file_path.stem, "name": name, "percent": percent})
        except Exception as e:
            print(f"⚠️ Error reading locale file {file_path}: {e}")

    languages.sort(key=lambda x: (x["code"] != "en_US", x["name"]))

    return languages


@eel.expose
def add_missing_translation_keys(locale_code, missing_keys):
    # Auto-populating missing translation keys is a DEV-ONLY convenience for
    # seeding locale files while building the UI. It must never write in the
    # packaged build shipped to users -- this is the authoritative guard, so
    # even if a frontend path calls it the shipped app is a no-op.
    if getattr(sys, "frozen", False):
        return {"success": True, "added": 0, "skipped": "not_dev_mode"}

    if not missing_keys:
        return {"success": True}

    file_path = LOCALE_DIR / f"{locale_code}.json"
    if not file_path.exists():
        return {"success": False, "error": "Locale file not found."}

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Normalize payload to (token, kind). Tolerate the old bare-string list
        # (treated as source-text/content) for one release.
        items = []
        for item in missing_keys:
            if isinstance(item, dict):
                token, kind = item.get("token"), item.get("kind", "content")
            else:
                token, kind = item, "content"
            if token:
                items.append((token, kind if kind in ("ui", "content") else "content"))

        is_new_shape = any(k in data for k in ("strings", "content", "meta"))
        added = 0

        if is_new_shape:
            strings = data.setdefault("strings", {})
            content = data.setdefault("content", {})
            for token, kind in items:
                target = strings if kind == "ui" else content
                if token not in target:
                    target[token] = ""
                    added += 1
        else:
            # legacy { language_name, keys }: only source-text tokens belong here;
            # symbolic UI ids must not be seeded into a legacy English-keyed map.
            keys = data.setdefault("keys", {})
            for token, kind in items:
                if kind == "ui":
                    continue
                if token not in keys:
                    keys[token] = ""
                    added += 1

        if added > 0:
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4, ensure_ascii=False)

        return {"success": True, "added": added}
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

webview_storage_path = str(get_app_data_dir() / 'WebView2')
try:
    # GTK/WebKit (Linux) expects the data dir to exist; WebView2 (Windows) is
    # happy either way. Create it defensively so the backend never fails to init.
    Path(webview_storage_path).mkdir(parents=True, exist_ok=True)
except OSError:
    pass

print("✅ Starting app...")

install_safe_eel_websocket()
eel.init(os.path.join(base_dir, 'web'))

eel_port = get_free_port()
print(f"Launching UI server on port {eel_port}...")


# Set before the server thread starts. In webview mode pywebview owns the
# window lifecycle, so a dropped websocket must NOT stop the server. In browser
# mode there's no window we control, so a closed tab is our shutdown signal.
_use_webview = True
_shutdown_event = threading.Event()


def webview_backend_available():
    """True if pywebview has a usable native window backend on this platform.

    Windows always does (WebView2). On Linux/macOS it needs GTK (system
    PyGObject + WebKit2) or Qt (PyQt/PySide WebEngine). When none is present we
    fall back to opening the app in the user's default browser instead.
    """
    if sys.platform == 'win32':
        return True
    try:
        import gi
        for ver in ('4.1', '4.0'):
            try:
                gi.require_version('WebKit2', ver)
                return True
            except ValueError:
                continue
    except Exception:
        pass
    import importlib.util
    for mod in ('PyQt6.QtWebEngineWidgets', 'PySide6.QtWebEngineWidgets', 'PyQt5.QtWebEngineWidgets'):
        try:
            if importlib.util.find_spec(mod) is not None:
                return True
        except Exception:
            continue
    return False


def _on_websocket_close(page, open_sockets):
    # Browser mode only: when the last tab/window closes, shut down. A reload
    # briefly drops the socket, so debounce and only exit if nothing reconnected.
    if _use_webview:
        return
    def _check():
        if len(eel._websockets) == 0:
            _shutdown_event.set()
    threading.Timer(1.5, _check).start()


def run_eel_server():
    # mode=None serves the app without launching a browser (pywebview or the
    # default browser opens the page). See _on_websocket_close for shutdown.
    eel.start(
        'index.html',
        mode=None,
        port=eel_port,
        block=True,
        close_callback=_on_websocket_close,
        suppress_error=True,
    )


def warm_codex_caches():
    """Pre-build any missing/stale codex caches in the background so the first
    open of a codex tab is instant. All codexes share the parsed game-file index
    (built once, reused), so warming them in sequence is far cheaper than building
    each one cold on demand. Best-effort: silently skipped when no game install."""
    try:
        from models.trove.prefab_ally import resolve_game_install
        resolve_game_install("")
    except Exception:
        return  # no valid Trove install detected -> nothing to warm

    try:
        from backend.codexes.allies import _build_allies_from_game_files
        from backend.codexes.mounts import _build_mounts_from_game_files
        from backend.codexes.mementos import _build_mementos_from_game_files
        from backend.codexes.recipes import _build_recipes_from_game_files
        from backend.codexes.items import _build_items_from_game_files
        from backend.codexes.fish import _build_fish_from_game_files
    except Exception:
        return

    builders = (
        _build_allies_from_game_files,
        _build_mounts_from_game_files,
        _build_mementos_from_game_files,
        _build_recipes_from_game_files,
        _build_items_from_game_files,
        _build_fish_from_game_files,
    )
    for build in builders:
        try:
            build(force_refresh=False)
        except Exception:
            pass


def wait_for_server(port, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(('localhost', port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


# Windows ALWAYS uses the embedded WebView2 window -- the browser fallback never
# applies there (and BTT_BROWSER is ignored). Elsewhere (Linux/macOS) prefer an
# embedded webview window when a GTK/Qt backend is available, otherwise fall back
# to the user's default browser so the app still runs with no extra install.
# BTT_BROWSER=1 forces the browser path on non-Windows platforms.
if sys.platform == 'win32':
    _use_webview = True
else:
    _use_webview = webview_backend_available() and os.getenv('BTT_BROWSER') != '1'

threading.Thread(target=run_eel_server, daemon=True).start()

if not wait_for_server(eel_port):
    print("❌ ERROR: UI server failed to start.")
    sys.exit(1)

# Warm codex caches in the background once the UI server is up, so opening a
# codex tab for the first time doesn't pay the full game-file scan inline.
threading.Thread(target=warm_codex_caches, daemon=True, name="codex-warmup").start()

app_url = f'http://localhost:{eel_port}/index.html'

if _use_webview:
    print("✅ Server ready. Opening window...")
    webview.create_window(
        WINDOW_TITLE,
        app_url,
        width=1700,
        height=1000,
        min_size=(1100, 700),
    )

    # Safety net: if a launcher (e.g. an older self-updater) starts us hidden,
    # bring the window to the foreground once it exists.
    threading.Thread(
        target=lambda: _surface_app_window(only_if_hidden=True, retries=50),
        daemon=True,
    ).start()

    webview.start(
        private_mode=False,
        storage_path=webview_storage_path,
        icon=os.path.join(base_dir, 'web', 'favicon.ico'),
    )
    # webview.start() returns once the user closes the window.
else:
    print(f"✅ Server ready. Opening {app_url} in your default browser...")
    try:
        opened = webbrowser.open(app_url)
    except Exception:
        opened = False
    if not opened:
        print(f"⚠️ Couldn't open a browser automatically. Open this URL manually:\n    {app_url}")
    # Run until the browser tab/window is closed (see _on_websocket_close).
    _shutdown_event.wait()

# Shut everything down.
IPC_LOCK_FILE.unlink(missing_ok=True)
os._exit(0)
