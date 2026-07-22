"""Machine-y launch bits: the per-region auth-server `-C` string and bringing
the freshly-launched game window to the foreground.

Trimmed from TroveImposter/utils/trove_launch.py — the mod / Trove.cfg merging
that lived here is intentionally omitted, because Better Trove Tools' own Mod
Manager owns that side. The ticket->running-game glue lives in the caller
(backend/trove.py), which mints via ``trionauth`` and spawns via ``inject``.
"""

from __future__ import annotations

import ctypes
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
_WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
_SW_RESTORE = 9


def focus_window_by_pid(pid: int) -> bool:
    """Bring the first visible top-level window owned by `pid` to the foreground."""
    found: list[int] = []

    def _cb(hwnd, _lparam):
        wpid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid and _user32.IsWindowVisible(hwnd):
            found.append(hwnd)
            return False  # stop enumerating
        return True

    _user32.EnumWindows(_WNDENUMPROC(_cb), 0)
    if not found:
        return False
    hwnd = found[0]
    _user32.ShowWindow(hwnd, _SW_RESTORE)
    _user32.SetForegroundWindow(hwnd)
    return True
