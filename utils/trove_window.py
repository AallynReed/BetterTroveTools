"""Locate the running Trove game window (Windows only).

The in-game overlay has exactly one job before it can draw anything: know where
Trove is on screen, and whether the player is actually looking at it. That is all
this module does -- it never touches the game's memory, never sends it input, and
never writes to it. It reads the same public window geometry any screen-capture
or accessibility tool reads.

Why a window and not just a process: Trove's process can be alive while its
window is minimized, on another monitor, or behind the browser the player alt-
tabbed to. The overlay must follow the *client area* (the rendered viewport,
excluding the title bar) so a widget pinned to "top-right" lands on the game's
top-right and not on its window chrome.

Everything here is best-effort and returns None on any failure. On non-Windows
hosts the module imports fine and reports "no Trove window", which is what keeps
the overlay feature inert on Linux instead of crashing the app.
"""
from __future__ import annotations

import os
import sys
import time

# The exe names Trove actually ships. Both are checked because a 32-bit install
# (Trove.exe) is still out there, and utils/executable.py already treats the pair
# as interchangeable identifiers for "this is Trove".
TROVE_PROCESS_NAMES = ("Trove_x64.exe", "Trove.exe")

_IS_WINDOWS = sys.platform == "win32"

if _IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetClientRect.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    user32.ClientToScreen.restype = wintypes.BOOL
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = wintypes.LONG
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromWindow.restype = wintypes.HANDLE

    GWL_STYLE = -16
    WS_CAPTION = 0x00C00000
    WS_THICKFRAME = 0x00040000
    MONITOR_DEFAULTTONEAREST = 0x00000002

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]
    user32.GetMonitorInfoW.restype = wintypes.BOOL

    user32.GetClipCursor.argtypes = [ctypes.POINTER(wintypes.RECT)]
    user32.GetClipCursor.restype = wintypes.BOOL

    user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
    user32.GetAsyncKeyState.restype = ctypes.c_short

    user32.VkKeyScanW.argtypes = [wintypes.WCHAR]
    user32.VkKeyScanW.restype = ctypes.c_short

    VK_MENU = 0x12


def _trove_pids():
    """PIDs of every running Trove process, newest-enumerated last.

    Reuses the Toolhelp snapshot helper the launcher already ships rather than
    adding psutil for one call. Returns [] when the launcher module can't be
    imported (non-Windows, or a checkout without the Win32 pieces).
    """
    if not _IS_WINDOWS:
        return []
    try:
        from backend.trove_launcher.inject import (
            INVALID_HANDLE_VALUE,
            PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
            kernel32,
        )
    except Exception:
        return []

    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE.value:
        return []
    wanted = {name.lower() for name in TROVE_PROCESS_NAMES}
    pids = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() in wanted:
                pids.append(entry.th32ProcessID)
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return pids


def _main_hwnd_for_pids(pids):
    """The largest visible top-level window owned by any of ``pids``.

    Trove owns more than one top-level window (splash/helper windows come and
    go), and picking the wrong one parks the overlay over a 1x1 stub. Area is a
    blunt but reliable discriminator: the render viewport is always the biggest
    thing the game owns.
    """
    if not pids:
        return None
    wanted = set(pids)
    best = {"hwnd": None, "area": 0}

    def callback(hwnd, _lparam):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in wanted:
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        area = max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top)
        if area > best["area"]:
            best["area"] = area
            best["hwnd"] = hwnd
        return True

    try:
        user32.EnumWindows(WNDENUMPROC(callback), 0)
    except Exception:
        return None
    # A minimized window reports a nonsense rect (-32000); still a valid handle,
    # the caller decides what to do about it via is_minimized().
    return best["hwnd"] if best["area"] > 0 or best["hwnd"] else None


def find_trove_hwnd():
    """Handle of Trove's main window, or None when the game isn't running."""
    if not _IS_WINDOWS:
        return None
    return _main_hwnd_for_pids(_trove_pids())


def is_window(hwnd) -> bool:
    return bool(_IS_WINDOWS and hwnd and user32.IsWindow(hwnd))


def is_minimized(hwnd) -> bool:
    return bool(_IS_WINDOWS and hwnd and user32.IsIconic(hwnd))


def is_foreground(hwnd) -> bool:
    """True when ``hwnd`` is the window the user is currently interacting with."""
    if not (_IS_WINDOWS and hwnd):
        return False
    return user32.GetForegroundWindow() == hwnd


def client_rect_on_screen(hwnd):
    """``(x, y, width, height)`` of the window's *client* area in screen pixels.

    The client area is the part Trove actually renders into. Anchoring to it
    (rather than to GetWindowRect) is what stops a top-anchored widget from
    sitting on the title bar in windowed mode. Returns None if the window is
    gone, minimized, or has no area.
    """
    if not (_IS_WINDOWS and hwnd) or not user32.IsWindow(hwnd):
        return None
    if user32.IsIconic(hwnd):
        return None

    rect = wintypes.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
        return None
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        return None

    origin = wintypes.POINT(rect.left, rect.top)
    if not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        return None
    return (origin.x, origin.y, width, height)


def looks_borderless(hwnd) -> bool:
    """Whether the window has no caption/resize frame.

    Used only to tailor the "your overlay may not show" hint: a bordered
    (windowed) Trove and a borderless-fullscreen Trove both work fine with a
    topmost overlay, but exclusive fullscreen does not, and exclusive fullscreen
    is always borderless. So borderless is the case worth warning about; it is
    not a positive detection of exclusive mode.
    """
    if not (_IS_WINDOWS and hwnd):
        return False
    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
    return not (style & (WS_CAPTION | WS_THICKFRAME))


def covers_monitor(hwnd) -> bool:
    """True when the window fills the whole monitor it sits on."""
    if not (_IS_WINDOWS and hwnd):
        return False
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return False
    monitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    if not monitor:
        return False
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return False
    m = info.rcMonitor
    return (rect.left <= m.left and rect.top <= m.top
            and rect.right >= m.right and rect.bottom >= m.bottom)


def mouse_captured(rect=None):
    """Whether the game currently owns the mouse (i.e. the player is playing).

    This is how the overlay tells "playing" from "reading a menu" without
    touching the game. Trove *confines* the cursor while it controls the
    camera -- measured on a live client, ``GetClipCursor`` returns a literal
    1x1 rectangle at the centre of the screen -- and releases the clip to the
    whole desktop the moment a UI panel opens (inventory, store, map, chat).

    Note the cursor is NOT hidden during play, which is why the obvious check
    (``GetCursorInfo``'s CURSOR_SHOWING) is useless here: it reads "showing"
    either way. Confinement is the signal that actually changes.

    Returns None when the clip can't be read, so callers can tell "no" from
    "don't know" and leave the overlay alone.
    """
    if not _IS_WINDOWS:
        return None
    clip = wintypes.RECT()
    if not user32.GetClipCursor(ctypes.byref(clip)):
        return None
    clip_w = max(0, clip.right - clip.left)
    clip_h = max(0, clip.bottom - clip.top)
    if clip_w <= 0 or clip_h <= 0:
        return None

    # Compare against the game's own client area rather than a fixed pixel
    # threshold: "confined" means confined relative to where the game is, and a
    # clip that merely matches the window is the game keeping the pointer inside
    # a windowed session, not taking the camera.
    if rect:
        _, _, win_w, win_h = rect
        if win_w > 0 and win_h > 0:
            return clip_w < win_w / 2 or clip_h < win_h / 2

    # No window rect to compare with: fall back to the virtual desktop.
    screen_w = user32.GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
    screen_h = user32.GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN
    if screen_w <= 0 or screen_h <= 0:
        return None
    return clip_w < screen_w / 2 or clip_h < screen_h / 2


def key_held(vk) -> bool:
    """Whether a virtual key is physically down right now.

    GetAsyncKeyState is a global keyboard-state read, not a hook: it answers
    "is this key down", takes no input, and sees nothing about what is being
    typed anywhere else.
    """
    if not _IS_WINDOWS:
        return False
    try:
        return bool(user32.GetAsyncKeyState(int(vk)) & 0x8000)
    except Exception:
        return False


# --- the "release mouse" binding --------------------------------------------
#
# Holding this key frees the cursor in Trove, which by cursor-confinement alone
# is indistinguishable from opening a bag -- so the overlay has to know the key
# to tell "the player wants the cursor" from "a panel opened". It is rebindable,
# so it is read from the game's own config rather than assumed to be Alt.

_RELEASE_MOUSE_KEY = "ReleaseMouse"
# Alt is the shipped binding, and an empty value in the config means exactly
# that: nothing overrode the default.
_RELEASE_MOUSE_DEFAULT = (VK_MENU,) if _IS_WINDOWS else ()
# Re-stat the config at most this often. The menu check runs every 50ms and the
# binding changes when a player edits their controls, not mid-fight.
_BINDING_TTL_SECONDS = 5.0

# Trove is an SDL app, so non-printable keys arrive under SDL's names. Printable
# ones come through as the character itself and are mapped with VkKeyScanW.
_NAMED_KEYS = {
    "left alt": 0xA4, "right alt": 0xA5, "alt": VK_MENU if _IS_WINDOWS else 0x12,
    "left shift": 0xA0, "right shift": 0xA1, "shift": 0x10,
    "left ctrl": 0xA2, "right ctrl": 0xA3, "ctrl": 0x11,
    "left control": 0xA2, "right control": 0xA3, "control": 0x11,
    "space": 0x20, "tab": 0x09, "return": 0x0D, "enter": 0x0D, "escape": 0x1B,
    "backspace": 0x08, "capslock": 0x14, "caps lock": 0x14, "insert": 0x2D,
    "delete": 0x2E, "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    **{f"f{n}": 0x6F + n for n in range(1, 25)},
}

_binding_cache = {"checked_at": 0.0, "stamp": None, "vks": _RELEASE_MOUSE_DEFAULT}


def _trove_cfg_path():
    appdata = os.environ.get("APPDATA")
    return os.path.join(appdata, "Trove", "Trove.cfg") if appdata else None


def split_binding(value):
    """``'.,\\'`` -> ``['.', '\\']``. Two keys joined by one comma.

    A bound key can itself BE a comma, so the separator cannot just be split on:
    two comma-bound keys are written ``,,,``. The separator is the comma that
    leaves a usable key on each side -- empty (only one key bound), a single
    comma, or anything with no comma in it.
    """
    value = (value or "").strip()
    if not value:
        return []
    if "," not in value:
        return [value]

    def usable(part):
        return part == "" or part == "," or "," not in part

    for index, char in enumerate(value):
        if char != ",":
            continue
        left, right = value[:index], value[index + 1:]
        if usable(left) and usable(right):
            return [p for p in (left, right) if p]
    return []


def _vk_for_token(token):
    """One key name from the config -> a virtual-key code, or None."""
    named = _NAMED_KEYS.get(token.strip().lower())
    if named:
        return named
    if len(token) == 1 and _IS_WINDOWS:
        scan = user32.VkKeyScanW(token)
        if scan != -1:
            return scan & 0xFF
    return None


def _read_release_mouse_vks():
    """Parse the binding out of Trove.cfg, or fall back to the default."""
    path = _trove_cfg_path()
    if not path or not os.path.exists(path):
        return _RELEASE_MOUSE_DEFAULT

    value = None
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        section = None
        for line in handle:
            line = line.strip()
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1]
            elif section == "InputBindings" and line.startswith(_RELEASE_MOUSE_KEY):
                key, _, raw = line.partition("=")
                if key.strip() == _RELEASE_MOUSE_KEY:
                    value = raw.strip()
                    break

    # Missing or blank both mean "the player never rebound it", which is Alt.
    if not value:
        return _RELEASE_MOUSE_DEFAULT
    vks = tuple(dict.fromkeys(
        vk for vk in (_vk_for_token(t) for t in split_binding(value)) if vk
    ))
    return vks or _RELEASE_MOUSE_DEFAULT


def release_mouse_vks():
    """The virtual keys currently bound to "release mouse", cached."""
    now = time.monotonic()
    if now - _binding_cache["checked_at"] < _BINDING_TTL_SECONDS:
        return _binding_cache["vks"]
    _binding_cache["checked_at"] = now

    path = _trove_cfg_path()
    try:
        stamp = os.path.getmtime(path) if path and os.path.exists(path) else None
    except OSError:
        stamp = None
    if stamp == _binding_cache["stamp"] and _binding_cache["vks"]:
        return _binding_cache["vks"]

    try:
        vks = _read_release_mouse_vks()
    except Exception:
        vks = _RELEASE_MOUSE_DEFAULT
    _binding_cache.update({"stamp": stamp, "vks": vks})
    return vks


def release_mouse_held() -> bool:
    """Whether the player is holding their free-the-cursor key right now."""
    return any(key_held(vk) for vk in release_mouse_vks())


def describe(hwnd=None):
    """Snapshot of what the overlay tracker needs, in one call.

    ``{running, hwnd, rect, foreground, minimized, fullscreen_risk}`` where
    ``rect`` is the client rect tuple (or None). ``hwnd`` may be passed in to
    re-validate a handle we already have; the expensive process scan only runs
    when that handle has gone stale.
    """
    if not _IS_WINDOWS:
        return {"running": False, "hwnd": None, "rect": None,
                "foreground": False, "minimized": False, "fullscreen_risk": False}

    if not is_window(hwnd):
        hwnd = find_trove_hwnd()

    if not hwnd:
        return {"running": False, "hwnd": None, "rect": None,
                "foreground": False, "minimized": False, "fullscreen_risk": False}

    rect = client_rect_on_screen(hwnd)
    return {
        "running": True,
        "hwnd": hwnd,
        "rect": rect,
        "foreground": is_foreground(hwnd),
        "minimized": is_minimized(hwnd),
        "fullscreen_risk": looks_borderless(hwnd) and covers_monitor(hwnd),
        "mouse_captured": mouse_captured(rect),
    }
