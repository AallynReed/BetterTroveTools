"""The in-game overlay's native window (Windows only).

A ``WS_EX_LAYERED`` popup updated with ``UpdateLayeredWindow``, so the alpha
channel we draw is exactly what DWM composites. That buys three things a
WebView2 child window could not deliver (see the note in ``utils/overlay_draw``):

  * genuinely transparent empty regions,
  * genuinely click-through empty regions -- a layered window hit-tests on its
    alpha, so a click on a zero-alpha pixel reaches the game with no
    WS_EX_TRANSPARENT needed,
  * no browser process, no compositor negotiation, one bitmap blit per second.

The window lives on its own thread with its own message pump, because a window
must be pumped by the thread that created it and the app's main thread belongs
to pywebview. Every public method is safe to call from any thread; they post
work to the window thread rather than touching the HWND directly.
"""
from __future__ import annotations

import ctypes
import sys
import threading
from ctypes import wintypes

from utils import overlay_draw

_IS_WINDOWS = sys.platform == "win32"

if _IS_WINDOWS:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    WS_POPUP = 0x80000000
    WS_EX_LAYERED = 0x00080000
    WS_EX_TRANSPARENT = 0x00000020
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_NOACTIVATE = 0x08000000
    WS_EX_TOPMOST = 0x00000008

    GWL_EXSTYLE = -20
    HWND_TOPMOST = wintypes.HWND(-1)
    SWP_NOSIZE, SWP_NOMOVE = 0x0001, 0x0002
    SWP_NOACTIVATE, SWP_NOOWNERZORDER = 0x0010, 0x0200
    SW_HIDE, SW_SHOWNOACTIVATE = 0, 4

    ULW_ALPHA = 0x00000002
    AC_SRC_OVER, AC_SRC_ALPHA = 0x00, 0x01

    WM_DESTROY = 0x0002
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE = 0x0201, 0x0202, 0x0200
    WM_APP_REDRAW = 0x8000 + 11
    WM_APP_QUIT = 0x8000 + 12

    class BLENDFUNCTION(ctypes.Structure):
        _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte),
                    ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_ubyte)]

    class SIZE(ctypes.Structure):
        _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    class WNDCLASS(ctypes.Structure):
        _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", ctypes.c_void_p),
                    ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                    ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
                    ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                    ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]

    WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT,
                                 wintypes.WPARAM, wintypes.LPARAM)

    user32.CreateWindowExW.restype = wintypes.HWND
    user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                       wintypes.DWORD, ctypes.c_int, ctypes.c_int,
                                       ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                       wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
    user32.DefWindowProcW.restype = ctypes.c_ssize_t
    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASS)]
    user32.UpdateLayeredWindow.argtypes = [
        wintypes.HWND, wintypes.HDC, ctypes.POINTER(POINT), ctypes.POINTER(SIZE),
        wintypes.HDC, ctypes.POINTER(POINT), wintypes.COLORREF,
        ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.GetMessageW.restype = ctypes.c_int
    user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    _set_long = getattr(user32, "SetWindowLongPtrW", None) or user32.SetWindowLongW
    _get_long = getattr(user32, "GetWindowLongPtrW", None) or user32.GetWindowLongW
    _set_long.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
    _set_long.restype = ctypes.c_ssize_t
    _get_long.argtypes = [wintypes.HWND, ctypes.c_int]
    _get_long.restype = ctypes.c_ssize_t

    gdi32.CreateDIBSection.restype = wintypes.HANDLE
    gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT,
                                       ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
                    ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                    ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


CLASS_NAME = "BetterTroveToolsOverlay"


class OverlayWindow:
    """Owns the layered window, its thread, and the drag interaction."""

    def __init__(self, on_move=None):
        # on_move(widget_id, anchor, x_fraction, y_fraction) — fired when the
        # user finishes dragging a widget in game.
        self._on_move = on_move
        self._lock = threading.RLock()
        self._thread = None
        self._thread_id = None
        self._hwnd = None
        self._ready = threading.Event()
        self._class_atom = None
        self._wndproc_ref = None       # must outlive the window

        self._rect = (0, 0, 0, 0)      # x, y, w, h on screen
        self._frame = None             # pending render payload
        self._hit_rects = []
        self._interactive = False
        self._drag = None
        self._visible = False

    # --- lifecycle -------------------------------------------------------
    def start(self):
        if not (_IS_WINDOWS and overlay_draw.available()):
            return False
        with self._lock:
            if self._thread and self._thread.is_alive():
                return True
            self._ready.clear()
            self._thread = threading.Thread(target=self._run, name="overlay-window", daemon=True)
            self._thread.start()
        self._ready.wait(5.0)
        return self._hwnd is not None

    def stop(self):
        with self._lock:
            thread_id, thread = self._thread_id, self._thread
            self._thread = self._thread_id = None
        if thread_id:
            try:
                user32.PostThreadMessageW(thread_id, WM_APP_QUIT, 0, 0)
            except Exception:
                pass
        if thread and thread.is_alive():
            thread.join(timeout=2.0)

    @property
    def hwnd(self):
        return self._hwnd

    def _run(self):
        with self._lock:
            self._thread_id = kernel32.GetCurrentThreadId()
        try:
            self._create_window()
        finally:
            self._ready.set()
        if not self._hwnd:
            return

        msg = wintypes.MSG()
        while True:
            got = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if got in (0, -1):
                break
            if msg.message == WM_APP_QUIT:
                break
            # Both of our private messages are posted with PostThreadMessage,
            # which produces a message with no target window -- DispatchMessage
            # silently drops those, so they can never reach the WndProc. They
            # have to be handled right here in the pump.
            if msg.message == WM_APP_REDRAW:
                self._flush_frame()
                continue
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

        try:
            if self._hwnd:
                user32.DestroyWindow(self._hwnd)
        except Exception:
            pass
        self._hwnd = None

    def _create_window(self):
        hinst = kernel32.GetModuleHandleW(None)
        self._wndproc_ref = WNDPROC(self._wndproc)

        wc = WNDCLASS()
        wc.style = 0
        wc.lpfnWndProc = ctypes.cast(self._wndproc_ref, ctypes.c_void_p)
        wc.hInstance = hinst
        wc.lpszClassName = CLASS_NAME
        # A second app instance (or a restart within one process) would fail to
        # re-register; an already-registered class is fine to reuse.
        try:
            self._class_atom = user32.RegisterClassW(ctypes.byref(wc))
        except Exception:
            self._class_atom = None

        ex_style = (WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST)
        self._hwnd = user32.CreateWindowExW(
            ex_style, CLASS_NAME, "Better Trove Tools Overlay", WS_POPUP,
            0, 0, 16, 16, None, None, hinst, None,
        )

    # --- window proc -----------------------------------------------------
    def _wndproc(self, hwnd, msg, wparam, lparam):
        if msg == WM_APP_REDRAW:
            self._flush_frame()
            return 0
        if msg == WM_DESTROY:
            return 0
        if self._interactive and msg in (WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_LBUTTONUP):
            self._on_mouse(msg, lparam)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _on_mouse(self, msg, lparam):
        # Client coordinates; the window's client area is the whole game rect.
        x = ctypes.c_short(lparam & 0xFFFF).value
        y = ctypes.c_short((lparam >> 16) & 0xFFFF).value

        if msg == WM_LBUTTONDOWN:
            for widget_id, wx, wy, ww, wh in reversed(self._hit_rects):
                if wx <= x <= wx + ww and wy <= y <= wy + wh:
                    self._drag = {"id": widget_id, "dx": x - wx, "dy": y - wy,
                                  "w": ww, "h": wh}
                    user32.SetCapture(self._hwnd)
                    break
        elif msg == WM_MOUSEMOVE and self._drag:
            self._drag["x"] = x - self._drag["dx"]
            self._drag["y"] = y - self._drag["dy"]
        elif msg == WM_LBUTTONUP and self._drag:
            user32.ReleaseCapture()
            drag = self._drag
            self._drag = None
            if "x" in drag and self._on_move:
                _, _, cw, ch = self._rect
                left, top = drag["x"], drag["y"]
                anchor = ("top" if top + drag["h"] / 2 < ch / 2 else "bottom") + \
                         "-" + ("left" if left + drag["w"] / 2 < cw / 2 else "right")
                fx = left / cw if anchor.endswith("left") else (cw - left - drag["w"]) / cw
                fy = top / ch if anchor.startswith("top") else (ch - top - drag["h"]) / ch
                clamp = lambda v: max(0.0, min(0.95, v))  # noqa: E731
                try:
                    self._on_move(drag["id"], anchor, clamp(fx), clamp(fy))
                except Exception:
                    pass

    # --- public API (any thread) ------------------------------------------
    def set_interactive(self, interactive):
        """Interactive = the overlay accepts clicks; locked = they pass through.

        A layered window is already click-through wherever alpha is zero, so
        this only decides whether the *widgets* eat a click. WS_EX_TRANSPARENT
        makes even those pass through.
        """
        self._interactive = bool(interactive)
        hwnd = self._hwnd
        if not (hwnd and user32.IsWindow(hwnd)):
            return
        style = _get_long(hwnd, GWL_EXSTYLE)
        style = (style & ~WS_EX_TRANSPARENT) if interactive else (style | WS_EX_TRANSPARENT)
        _set_long(hwnd, GWL_EXSTYLE, style)

    def place(self, x, y, width, height):
        self._rect = (int(x), int(y), int(width), int(height))
        hwnd = self._hwnd
        if hwnd and user32.IsWindow(hwnd):
            user32.SetWindowPos(hwnd, HWND_TOPMOST, int(x), int(y), int(width), int(height),
                                SWP_NOACTIVATE | SWP_NOOWNERZORDER)

    def raise_topmost(self):
        hwnd = self._hwnd
        if hwnd and user32.IsWindow(hwnd):
            user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)

    def show(self):
        hwnd = self._hwnd
        if hwnd and user32.IsWindow(hwnd):
            user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
            self._visible = True

    def hide(self):
        hwnd = self._hwnd
        if hwnd and user32.IsWindow(hwnd):
            user32.ShowWindow(hwnd, SW_HIDE)
            self._visible = False

    def is_visible(self):
        return self._visible

    def update(self, widgets, *, scale=1.0, opacity=0.92, accent=(94, 198, 255)):
        """Queue a repaint. Safe from any thread; the blit runs on the window thread."""
        _, _, w, h = self._rect
        if w <= 0 or h <= 0:
            return
        with self._lock:
            self._frame = {"widgets": widgets, "scale": scale,
                           "opacity": opacity, "accent": accent}
        thread_id = self._thread_id
        if thread_id:
            user32.PostThreadMessageW(thread_id, WM_APP_REDRAW, 0, 0)

    # --- the actual blit (window thread only) -----------------------------
    def _flush_frame(self):
        with self._lock:
            frame = self._frame
            self._frame = None
        if not frame:
            return
        x, y, width, height = self._rect
        if width <= 0 or height <= 0 or not self._hwnd:
            return

        widgets = frame["widgets"]
        # While dragging, draw the grabbed widget under the cursor instead of at
        # its stored position, so the drag has live feedback.
        if self._drag and "x" in self._drag:
            widgets = [dict(w) for w in widgets]
            for widget in widgets:
                if widget.get("id") == self._drag["id"]:
                    widget["_pin"] = (self._drag["x"], self._drag["y"])
                    widget["highlight"] = True

        bitmap, hit_rects = overlay_draw.render(
            width, height, widgets,
            scale=frame["scale"], opacity=frame["opacity"], accent=frame["accent"])
        if bitmap is None:
            return
        self._hit_rects = hit_rects

        screen_dc = user32.GetDC(0)
        mem_dc = gdi32.CreateCompatibleDC(screen_dc)
        hbmp = None
        old = None
        try:
            hbmp = bitmap.GetHbitmap(overlay_draw.Color.FromArgb(0, 0, 0, 0))
            handle = hbmp.ToInt64()
            old = gdi32.SelectObject(mem_dc, handle)

            size, src, dst = SIZE(width, height), POINT(0, 0), POINT(int(x), int(y))
            blend = BLENDFUNCTION(AC_SRC_OVER, 0, 255, AC_SRC_ALPHA)
            user32.UpdateLayeredWindow(self._hwnd, screen_dc, ctypes.byref(dst),
                                       ctypes.byref(size), mem_dc, ctypes.byref(src),
                                       0, ctypes.byref(blend), ULW_ALPHA)
        finally:
            if old:
                gdi32.SelectObject(mem_dc, old)
            if hbmp is not None:
                gdi32.DeleteObject(hbmp.ToInt64())
            gdi32.DeleteDC(mem_dc)
            user32.ReleaseDC(0, screen_dc)
            bitmap.Dispose()
