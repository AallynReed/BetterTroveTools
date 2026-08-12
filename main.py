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

from utils import image_proxy
from utils.path import get_app_data_dir, get_cache_root
from utils.win_tray import create_tray_icon

os.environ["GOOGLE_API_KEY"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_ID"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_SECRET"] = "no"

from backend.feature_flags import MODS_HUB_ENABLED
from backend import locales

import backend.about
import backend.auth
import backend.codexes.allies
import backend.codexes.badges
import backend.calculators
import backend.desktop_notifications
import backend.event_notifications
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
import backend.overlay
import backend.codexes.recipes
import backend.codexes.styles
import backend.settings
import backend.trove
import backend.gems_and_builds.star_chart
import backend.mod_manager.trovesaurus

# Mods Hub endpoints are only registered while the hub is enabled — see
# backend/feature_flags.py. Profiles ride on the hub's .tpack pipeline, so it
# goes with them.
if MODS_HUB_ENABLED:
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

# When the app is hidden in the system tray (close-to-tray), a second launch
# should bring the window back rather than just poke a Win32 handle. This hook
# is set to the tray-aware restore once the window exists; until then we fall
# back to the raw Win32 surface. See _restore_from_tray / the IPC listener.
_second_instance_handler = None

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
            # already-running window instead of silently doing nothing. When the
            # app is sitting in the tray, the handler restores it from there.
            if data:
                if _second_instance_handler:
                    _second_instance_handler()
                else:
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


# Everything the self-update flow drops in the cache: the installer, the msiexec
# log, and the VBS helper (which deletes itself, but only if it runs to the end).
_UPDATE_ARTIFACT_SUFFIXES = (".msi", ".log", ".vbs")


def _clear_update_cache(min_age_seconds=300):
    """Delete leftover update artifacts. Returns (files_removed, bytes_freed)."""
    update_dir = get_cache_root() / "updates"
    if not update_dir.is_dir():
        return 0, 0

    cutoff = time.time() - max(0, float(min_age_seconds))
    removed = 0
    freed = 0

    for entry in update_dir.iterdir():
        if entry.suffix.lower() not in _UPDATE_ARTIFACT_SUFFIXES:
            continue
        try:
            info = entry.stat()
            # Anything recent may belong to an install that is still running.
            if not entry.is_file() or info.st_mtime > cutoff:
                continue
            entry.unlink()
        except OSError:
            # Locked by msiexec, or already gone — leave it for the next sweep.
            continue
        removed += 1
        freed += info.st_size

    try:
        update_dir.rmdir()  # only succeeds once the folder is empty
    except OSError:
        pass

    return removed, freed


@eel.expose
def clear_update_cache(min_age_seconds=300):
    """Called by the frontend once it knows the app is already up to date."""
    try:
        removed, freed = _clear_update_cache(min_age_seconds)
        return {"success": True, "data": {"removed": removed, "freed_bytes": freed}}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _sweep_stale_update_cache():
    """Startup safety net for installs that never reach an update check
    (offline app, abandoned download): drop artifacts older than a day."""
    try:
        _clear_update_cache(24 * 60 * 60)
    except Exception:
        pass


threading.Thread(target=_sweep_stale_update_cache, daemon=True).start()


def _read_settings_dict():
    """Best-effort read of the raw settings file. Returns {} on any problem."""
    try:
        settings_file = get_cache_root() / "settings.json"
        if settings_file.exists():
            data = json.loads(settings_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def close_to_tray_enabled():
    """Read the current 'close to system tray' preference straight from the
    settings file so a toggle in the UI takes effect without a restart.

    Defaults to True (enabled) when the setting is missing or unreadable -- the
    app ships closing to the tray by default.
    """
    return _read_settings_dict().get("close_to_tray", True) is not False


def notifications_enabled():
    """Whether the user has rotation reminders turned on. Used to keep the tray
    icon present from startup (balloons need a visible icon). Defaults off."""
    notifications = _read_settings_dict().get("notifications")
    return isinstance(notifications, dict) and notifications.get("enabled") is True


LOCALE_DIR = Path("web/assets/locale")


@eel.expose
def get_available_languages():
    return locales.available_languages(LOCALE_DIR)


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
    # All the validation lives in utils.image_proxy. The URL is rebuilt from
    # constants there; nothing the caller sent is forwarded verbatim.
    status, body, content_type = image_proxy.fetch_image(bottle.request.query.get('url'))
    if status != 200:
        return bottle.HTTPError(status, body.decode("utf-8", "replace"))

    for header, value in image_proxy.RESPONSE_HEADERS.items():
        bottle.response.set_header(header, value)
    bottle.response.content_type = content_type
    return body

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
        from backend.codexes.codex_cache import REGISTRY
    except Exception:
        return

    # Badges is deliberately not warmed -- it is not part of the startup set.
    for key in ("allies", "mounts", "mementos", "recipes", "styles", "items", "fish"):
        codex = REGISTRY.get(key)
        if codex is None:
            continue
        try:
            codex.build(force_refresh=False)
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
    main_window = webview.create_window(
        WINDOW_TITLE,
        app_url,
        width=1700,
        height=1000,
        min_size=(1100, 700),
    )

    # --- Close to system tray + desktop reminders ----------------------------
    # When close-to-tray is enabled (default), closing the window hides it to the
    # notification area and keeps the app running instead of quitting. The tray
    # icon is the way back. It also carries rotation-reminder balloons, so while
    # reminders are enabled the icon stays visible even when the window is open
    # (a balloon needs a live icon). Tray support is Windows-only and
    # best-effort: with no tray, closing behaves normally (see create_tray_icon).
    _tray_state = {"quitting": False}
    tray_icon = None
    notifier = backend.desktop_notifications.notifier

    # Two independent reasons the icon may need to be visible; the icon is shown
    # if either holds. "collapsed" = window hidden to tray; "reminders" = the
    # user has rotation reminders on (initial value read from settings).
    _tray_wanted = {"collapsed": False, "reminders": notifications_enabled()}

    def _apply_tray_visibility():
        if not tray_icon:
            return
        if _tray_wanted["collapsed"] or _tray_wanted["reminders"]:
            tray_icon.show()
        else:
            tray_icon.hide()

    def _set_reminders_active(active):
        # Called by the frontend scheduler (via the notifier) when reminders are
        # toggled, so the icon can persist for as long as balloons must deliver.
        _tray_wanted["reminders"] = bool(active)
        _apply_tray_visibility()

    def _restore_from_tray():
        try:
            main_window.show()
        except Exception:
            pass
        _tray_wanted["collapsed"] = False
        _apply_tray_visibility()
        _surface_app_window(only_if_hidden=False)

    def _quit_from_tray():
        _tray_state["quitting"] = True
        # Tear the overlay down first: it's a topmost window over the game, and
        # leaving it behind after the app quits would strand it there.
        try:
            backend.overlay.shutdown()
        except Exception:
            pass
        if tray_icon:
            try:
                tray_icon.destroy()
            except Exception:
                pass
        try:
            main_window.destroy()
        except Exception:
            IPC_LOCK_FILE.unlink(missing_ok=True)
            os._exit(0)

    def _on_window_closing():
        # Returning False cancels the native close (pywebview honors this).
        if _tray_state["quitting"] or tray_icon is None:
            return True
        if not close_to_tray_enabled():
            return True
        try:
            main_window.hide()
        except Exception:
            return True
        _tray_wanted["collapsed"] = True
        _apply_tray_visibility()
        # First time ever the app tucks into the tray, tell the user where it
        # went — once, then never again (persisted across restarts). Defer the
        # balloon: _apply_tray_visibility may have JUST added the tray icon, and
        # Windows silently drops a balloon fired before the shell has finished
        # registering a freshly-added icon. A short delay lets it register so the
        # notification actually renders (notify_once only records it once shown).
        def _first_time_tray_hint():
            notifier.notify_once(
                "close_to_tray_first_time",
                WINDOW_TITLE,
                f"{WINDOW_TITLE} is still running in the system tray. "
                "Right-click the tray icon to quit.",
            )
        threading.Timer(1.2, _first_time_tray_hint).start()
        return False

    main_window.events.closing += _on_window_closing

    tray_icon = create_tray_icon(
        title=WINDOW_TITLE,
        icon_path=os.path.join(base_dir, 'web', 'favicon.ico'),
        on_open=_restore_from_tray,
        on_quit=_quit_from_tray,
        tooltip=WINDOW_TITLE,
    )

    # --- In-game overlay -----------------------------------------------------
    # A second frameless/transparent/topmost WebView2 window that only ever
    # appears over a running Trove. pywebview owns window creation, so the host
    # object lives here and backend/overlay.py's tracker drives it; the tracker
    # runs on its own thread, which is also what lets create_window() build the
    # child window immediately instead of queueing it for the next start().
    # Windows-only: see backend.overlay.SUPPORTED for why.
    overlay_url = f'http://localhost:{eel_port}/overlay.html'

    class _OverlayWindowHost(backend.overlay.OverlayHost):
        def __init__(self):
            self._lock = threading.Lock()
            self._window = None
            self._hwnd = None

        def ensure_window(self):
            with self._lock:
                if self._hwnd:
                    return self._hwnd
                if self._window is None:
                    self._window = webview.create_window(
                        f'{WINDOW_TITLE} Overlay',
                        overlay_url,
                        # Sized/placed by the tracker the moment it's shown; these
                        # are only the values it holds while still hidden.
                        width=800, height=600, min_size=(100, 100),
                        resizable=False, frameless=True, easy_drag=False,
                        shadow=False, on_top=True, transparent=True,
                        # focus=False adds WS_EX_NOACTIVATE, so showing the
                        # overlay never pulls keyboard focus out of the game.
                        focus=False, hidden=True, confirm_close=False,
                        background_color='#000000',
                    )
                if self._window is None:
                    return None
                # The hidden-window path still fires Shown (pywebview shows and
                # immediately re-hides it), which is when `native` gets set.
                self._window.events.shown.wait(15)
                native = getattr(self._window, 'native', None)
                if native is None:
                    return None
                try:
                    self._hwnd = int(native.Handle.ToInt64())
                except Exception:
                    return None
                return self._hwnd

        def show(self):
            if self._window:
                self._window.show()

        def hide(self):
            if self._window:
                self._window.hide()

        def destroy(self):
            window = None
            with self._lock:
                window, self._window, self._hwnd = self._window, None, None
            if window:
                try:
                    window.destroy()
                except Exception:
                    pass

    if backend.overlay.SUPPORTED:
        backend.overlay.tracker.set_host(_OverlayWindowHost())
        # Re-arm on launch if the user left the overlay enabled last session.
        threading.Thread(
            target=backend.overlay.start_from_settings, daemon=True, name='overlay-init'
        ).start()

    def _notification_sink(title, message):
        """Prefer the overlay, fall back to the tray balloon.

        While the overlay is actually on screen and the user has opted in, a
        notification renders as a dismissable card over the game -- a Windows
        toast during combat is worse than useless. `tracker.notify` returns False
        for every other case (overlay off, muted, page not mounted, opted out),
        and delivery falls straight back to the balloon it always used.
        """
        if backend.overlay.tracker.notify(title, message):
            return True
        if tray_icon:
            return tray_icon.notify(title, message)
        return False

    # Route desktop notifications, and let the reminder scheduler keep the tray
    # icon present. The sink is registered when *either* delivery path can work,
    # so `desktop_notifications_available()` stays an honest answer.
    if tray_icon or backend.overlay.SUPPORTED:
        notifier.set_sink(_notification_sink)
        notifier.set_active_handler(_set_reminders_active)
    if tray_icon:
        _apply_tray_visibility()  # show now if reminders were already enabled
    # Second launches restore the window from the tray instead of just poking
    # the Win32 handle (keeps pywebview's own shown/hidden state in sync).
    _second_instance_handler = _restore_from_tray

    # Safety net: if a launcher (e.g. an older self-updater) starts us hidden,
    # bring the window to the foreground once it exists.
    threading.Thread(
        target=lambda: _surface_app_window(only_if_hidden=True, retries=50),
        daemon=True,
    ).start()

    # Enable WebView2 devtools (right-click → Inspect / F12) in dev, or in a
    # packaged build when launched with BTT_DEBUG=1 — lets us read the JS console
    # to diagnose frontend issues in the shipped app.
    _webview_debug = bool(globals().get('DEV_MODE', False)) or os.getenv('BTT_DEBUG') == '1'
    webview.start(
        private_mode=False,
        storage_path=webview_storage_path,
        icon=os.path.join(base_dir, 'web', 'favicon.ico'),
        debug=_webview_debug,
    )
    # webview.start() returns once the user closes the window (real quit).
    try:
        backend.overlay.shutdown()
    except Exception:
        pass
    if tray_icon:
        try:
            tray_icon.destroy()
        except Exception:
            pass
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
