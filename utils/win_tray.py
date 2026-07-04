"""Minimal Windows system-tray (notification area) icon via pywin32.

Powers the "close to system tray" option: when enabled, closing the main window
hides it and drops an icon in the notification area (the hidden-icons flyout)
instead of quitting. The icon is the way back in -- left-click restores the
window, right-click offers Open / Quit.

Windows-only and strictly best-effort. If pywin32 isn't importable (a dev
checkout without it) or the host isn't Windows, ``create_tray_icon`` returns
None and the caller falls back to closing the app normally -- so nothing here
can make the app un-closable.

All Win32 calls that touch the icon's message loop run on a dedicated daemon
thread that owns the hidden message window; ``show``/``hide``/``destroy`` are
safe to call from any thread.
"""
from __future__ import annotations

import sys
import threading

# Command ids for the right-click popup menu.
_ID_OPEN = 1023
_ID_QUIT = 1024

# Private window message the tray icon posts its mouse events back on.
_WM_TRAY = 0x0400 + 20  # WM_USER + 20


def create_tray_icon(*, title, icon_path, on_open, on_quit, tooltip=None):
    """Create the tray icon and start its message loop on a background thread.

    Returns a controller exposing ``show()`` / ``hide()`` / ``destroy()`` and a
    ``notify(title, message)`` balloon helper, or ``None`` when tray icons
    aren't supported on this platform/build (caller should then close normally).

    ``on_open`` fires when the user asks to restore the window (left-click or the
    Open menu item); ``on_quit`` fires when the user picks Quit. Both run on the
    tray thread.
    """
    if sys.platform != "win32":
        return None
    try:
        import win32con  # noqa: F401
        import win32gui  # noqa: F401
    except Exception:
        return None

    tray = _WinTray(title, icon_path, on_open, on_quit, tooltip or title)
    if not tray._wait_ready():
        return None
    return tray


class _WinTray:
    def __init__(self, title, icon_path, on_open, on_quit, tooltip):
        self._title = title
        self._icon_path = icon_path
        self._on_open = on_open
        self._on_quit = on_quit
        self._tooltip = tooltip

        self._hwnd = None
        self._hicon = None
        self._visible = False
        self._ready = threading.Event()
        self._started_ok = False

        self._thread = threading.Thread(target=self._run, name="tray-icon", daemon=True)
        self._thread.start()

    def _wait_ready(self, timeout=5.0):
        self._ready.wait(timeout)
        return self._started_ok

    # --- tray thread ----------------------------------------------------
    def _run(self):
        import win32api
        import win32con
        import win32gui

        try:
            hinst = win32api.GetModuleHandle(None)
            wc = win32gui.WNDCLASS()
            wc.hInstance = hinst
            wc.lpszClassName = "BetterTroveToolsTray"
            wc.lpfnWndProc = self._wndproc
            class_atom = win32gui.RegisterClass(wc)

            self._hwnd = win32gui.CreateWindow(
                class_atom, self._title, win32con.WS_OVERLAPPED,
                0, 0, 0, 0, 0, 0, hinst, None,
            )
            win32gui.UpdateWindow(self._hwnd)

            self._hicon = self._load_icon(hinst)
            self._started_ok = True
        except Exception:
            self._started_ok = False
        finally:
            self._ready.set()

        if not self._started_ok:
            return

        # Blocks until WM_QUIT (posted by destroy()).
        win32gui.PumpMessages()

    def _load_icon(self, hinst):
        import win32con
        import win32gui

        try:
            flags = win32con.LR_LOADFROMFILE | win32con.LR_DEFAULTSIZE
            hicon = win32gui.LoadImage(
                hinst, self._icon_path, win32con.IMAGE_ICON, 0, 0, flags
            )
            if hicon:
                return hicon
        except Exception:
            pass
        # Fall back to a stock application icon so the tray is never blank.
        try:
            return win32gui.LoadIcon(0, win32con.IDI_APPLICATION)
        except Exception:
            return None

    def _notify_icon_data(self, flags, extra=()):
        # (hwnd, id, flags, callback_msg, hicon, tip, *extra)
        return (self._hwnd, 0, flags, _WM_TRAY, self._hicon, self._tooltip) + extra

    def _wndproc(self, hwnd, msg, wparam, lparam):
        import win32con
        import win32gui

        if msg == _WM_TRAY:
            if lparam in (win32con.WM_LBUTTONUP, win32con.WM_LBUTTONDBLCLK):
                self._invoke(self._on_open)
            elif lparam == win32con.WM_RBUTTONUP:
                self._show_menu()
            return 0
        if msg == win32con.WM_DESTROY:
            self._remove_icon()
            win32gui.PostQuitMessage(0)
            return 0
        return win32gui.DefWindowProc(hwnd, msg, wparam, lparam)

    def _show_menu(self):
        import win32con
        import win32gui

        menu = win32gui.CreatePopupMenu()
        win32gui.AppendMenu(menu, win32con.MF_STRING, _ID_OPEN, "Open Better Trove Tools")
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")
        win32gui.AppendMenu(menu, win32con.MF_STRING, _ID_QUIT, "Quit")

        pos = win32gui.GetCursorPos()
        # SetForegroundWindow + the trailing WM_NULL is the documented dance that
        # makes a tray popup menu dismiss correctly when clicked away from.
        win32gui.SetForegroundWindow(self._hwnd)
        cmd = win32gui.TrackPopupMenu(
            menu, win32con.TPM_LEFTALIGN | win32con.TPM_RETURNCMD | win32con.TPM_NONOTIFY,
            pos[0], pos[1], 0, self._hwnd, None,
        )
        win32gui.PostMessage(self._hwnd, win32con.WM_NULL, 0, 0)
        win32gui.DestroyMenu(menu)

        if cmd == _ID_OPEN:
            self._invoke(self._on_open)
        elif cmd == _ID_QUIT:
            self._invoke(self._on_quit)

    def _invoke(self, cb):
        if not cb:
            return
        try:
            cb()
        except Exception:
            pass

    def _remove_icon(self):
        import win32gui
        from win32gui import NIM_DELETE

        if not self._visible:
            return
        try:
            win32gui.Shell_NotifyIcon(NIM_DELETE, self._notify_icon_data(0))
        except Exception:
            pass
        self._visible = False

    # --- public API (any thread) ---------------------------------------
    def show(self):
        """Add the icon to the notification area (idempotent)."""
        import win32gui
        from win32gui import NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD

        if self._visible or not self._hwnd:
            return
        try:
            flags = NIF_ICON | NIF_MESSAGE | NIF_TIP
            win32gui.Shell_NotifyIcon(NIM_ADD, self._notify_icon_data(flags))
            self._visible = True
        except Exception:
            pass

    def hide(self):
        """Remove the icon from the notification area (idempotent)."""
        self._remove_icon()

    def notify(self, title, message):
        """Show a balloon tip on the icon. No-op if the icon isn't visible."""
        import win32gui
        from win32gui import NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIM_MODIFY

        if not self._visible or not self._hwnd:
            return
        try:
            niif_info = getattr(win32gui, "NIIF_INFO", 0x00000001)
            flags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_INFO
            # Balloon fields extend the base tuple in this order:
            # (szInfo, uTimeout, szInfoTitle, dwInfoFlags).
            data = self._notify_icon_data(flags, (message, 200, title, niif_info))
            win32gui.Shell_NotifyIcon(NIM_MODIFY, data)
        except Exception:
            pass

    def destroy(self):
        """Tear down the icon and stop the message loop."""
        import win32con
        import win32gui

        if not self._hwnd:
            return
        try:
            win32gui.PostMessage(self._hwnd, win32con.WM_CLOSE, 0, 0)
        except Exception:
            pass
