"""Machine-y launch bits: the per-region auth-server `-C` string, bringing the
freshly-launched game window to the foreground, and closing a process down
(used to get rid of Trove's crash handler when auto-relog is on).

Trimmed from TroveImposter/utils/trove_launch.py — the mod / Trove.cfg merging
that lived here is intentionally omitted, because Better Trove Tools' own Mod
Manager owns that side. The ticket->running-game glue lives in the caller
(backend/trove.py), which mints via ``trionauth`` and spawns via ``inject``.
"""

from __future__ import annotations

import ctypes
import time
from ctypes import wintypes

# Verified EU string from GlyphClient.3.log; NA/PTS from the Trion auth guide.
AUTH_SERVERS = {
    "EU": ("[AuthServer] Address = "
           "ams-c12-b01.ams.triongames.com:6560|ams-c12-b02.ams.triongames.com:6560|"
           "ams-c12-b03.ams.triongames.com:6560|ams-c12-b04.ams.triongames.com:6560|"
           "ams-c12-b05.ams.triongames.com:6560"),
    "NA": ("[AuthServer] Address = "
           "dal-c35-b05.dal.triongames.com:6560|dal-c35-b06.dal.triongames.com:6560|"
           "dal-c35-b07.dal.triongames.com:6560|dal-c35-b08.dal.triongames.com:6560|"
           "dal-c35-b09.dal.triongames.com:6560"),
    "PTS": ("[AuthServer] Address = "
            "auth-pcpts01.trovegame.com:6560|auth-pcpts02.trovegame.com:6560"),
}


def get_auth_server(region: str) -> str:
    try:
        return AUTH_SERVERS[region.upper()]
    except KeyError:
        raise ValueError(f"unknown region {region!r}; choose {list(AUTH_SERVERS)}")


# --- window focus (ctypes user32; replaces the missing pywin32) -------------

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
_SW_RESTORE = 9
_WM_CLOSE = 0x0010
_SYNCHRONIZE = 0x00100000
_PROCESS_TERMINATE = 0x0001
_WAIT_OBJECT_0 = 0x0

_kernel32.OpenProcess.restype = wintypes.HANDLE
_kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
_kernel32.WaitForSingleObject.restype = wintypes.DWORD
_kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
_kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def visible_windows_for_pid(pid: int) -> list[int]:
    """Every visible top-level window owned by `pid`."""
    found: list[int] = []

    def _cb(hwnd, _lparam):
        wpid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid and _user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    _user32.EnumWindows(_WNDENUMPROC(_cb), 0)
    return found


def focus_window_by_pid(pid: int) -> bool:
    """Bring the first visible top-level window owned by `pid` to the foreground."""
    found = visible_windows_for_pid(pid)
    if not found:
        return False
    hwnd = found[0]
    _user32.ShowWindow(hwnd, _SW_RESTORE)
    _user32.SetForegroundWindow(hwnd)
    return True


def close_process(pid: int, grace: float = 5.0) -> bool:
    """Ask `pid` to close (WM_CLOSE to its windows), then kill it if it lingers.

    Returns True if the process is gone afterwards."""
    for hwnd in visible_windows_for_pid(pid):
        _user32.PostMessageW(wintypes.HWND(hwnd), _WM_CLOSE, 0, 0)

    h = _kernel32.OpenProcess(_SYNCHRONIZE | _PROCESS_TERMINATE, False, int(pid))
    if not h:
        return True  # already gone (or not ours to touch)
    try:
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if _kernel32.WaitForSingleObject(h, 250) == _WAIT_OBJECT_0:
                return True
        _kernel32.TerminateProcess(h, 1)
        return _kernel32.WaitForSingleObject(h, 3000) == _WAIT_OBJECT_0
    finally:
        _kernel32.CloseHandle(h)
