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
import time
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
    # SetWindowDisplayAffinity: NONE is the default (the window records like any
    # other), EXCLUDEFROMCAPTURE takes it out of screen captures and shares
    # while leaving it on screen. The latter needs Windows 10 2004 or newer and
    # simply fails on anything older.
    WDA_NONE = 0x00000000
    WDA_EXCLUDEFROMCAPTURE = 0x00000011
    HWND_TOPMOST = wintypes.HWND(-1)
    SWP_NOSIZE, SWP_NOMOVE = 0x0001, 0x0002
    SWP_NOACTIVATE, SWP_NOOWNERZORDER = 0x0010, 0x0200
    SW_HIDE, SW_SHOWNOACTIVATE = 0, 4

    ULW_ALPHA = 0x00000002
    AC_SRC_OVER, AC_SRC_ALPHA = 0x00, 0x01

    WM_DESTROY = 0x0002
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE = 0x0201, 0x0202, 0x0200
    VK_CONTROL = 0x11
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
        # The last payload actually drawn. A drag has to repaint between the
        # tracker's once-a-second updates, and it can only do that if the frame
        # survives being flushed -- otherwise the widget under the cursor moves
        # in one-second lurches, which is exactly what a drag must not do.
        self._last_frame = None
        self._hit_rects = []
        self._interactive = False
        self._drag = None
        self._drag_painted = 0.0
        self._pin_hold = None          # (id, x, y) held until the tracker catches up
        self._selected = None          # last widget clicked; what the arrows move
        self._nudge = None             # (id, x, y, ts) so held arrows accumulate
        self._capture_hidden = False   # kept off screen shares when True
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
        # The window is rebuilt every time the overlay comes back, so the
        # capture setting has to be re-applied rather than assumed.
        if self._capture_hidden:
            self.set_capture_hidden(True)

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

    # How close an edge has to come before it is pulled into line. A hand-eye
    # tolerance, not a layout measurement, so it does not scale with the widget.
    SNAP_PX = 8

    def _snap_axis(self, value, size, others, extent):
        """Pull one axis into line, and say where the guide belongs.

        Returns ``(position, guide)``, guide being the canvas coordinate of the
        edge that lined up (or None). Each candidate carries the offset from the
        widget's leading edge to whichever of its edges did the aligning, so a
        right-edge match draws its line down the right-hand side rather than the
        left.
        """
        # (priority, position, guide offset). Ranked, not merely nearest: on
        # similarly-sized widgets an edge and a centre candidate land within a
        # few pixels of each other, and a centre that happens to be marginally
        # closer should not win a drag the user aimed at an edge.
        candidates = [
            (0, 0.0, 0.0),                              # canvas leading edge
            (0, extent - size, size),                   # canvas trailing edge
            (1, (extent - size) / 2.0, size / 2.0),     # canvas centre
        ]
        for pos, other_size in others:
            candidates += [
                (0, pos, 0.0),                                       # leading edges flush
                (0, pos + other_size - size, size),                  # trailing edges flush
                (0, pos + other_size, 0.0),                          # leading meets trailing
                (0, pos - size, size),                               # trailing meets leading
                (1, pos + (other_size - size) / 2.0, size / 2.0),    # centres in line
            ]
        in_range = [(rank, abs(pos - value), pos, offset)
                    for rank, pos, offset in candidates
                    if abs(pos - value) <= self.SNAP_PX]
        if not in_range:
            return value, None
        _, _, pos, offset = min(in_range)
        return pos, pos + offset

    def _snap(self, drag, left, top):
        """Align a widget against the others and the game window, live.

        Applied on every mouse-move rather than at the drop, so the widget
        visibly sticks to the line it is aligning with -- a snap you only learn
        about after letting go reads as the overlay moving things on its own.
        Returns the position plus the guide lines to draw for it.
        """
        _, _, cw, ch = self._rect
        others = [(wx, wy, ww, wh) for wid, wx, wy, ww, wh in self._hit_rects
                  if wid != drag["id"]]
        x, guide_x = self._snap_axis(left, drag["w"], [(x, w) for x, _, w, _ in others], cw)
        y, guide_y = self._snap_axis(top, drag["h"], [(y, h) for _, y, _, h in others], ch)
        guides = {"x": [guide_x] if guide_x is not None else [],
                  "y": [guide_y] if guide_y is not None else []}
        return x, y, guides

    def _on_mouse(self, msg, lparam):
        # Client coordinates; the window's client area is the whole game rect.
        x = ctypes.c_short(lparam & 0xFFFF).value
        y = ctypes.c_short((lparam >> 16) & 0xFFFF).value

        if msg == WM_LBUTTONDOWN:
            for widget_id, wx, wy, ww, wh in reversed(self._hit_rects):
                if wx <= x <= wx + ww and wy <= y <= wy + wh:
                    self._drag = {"id": widget_id, "dx": x - wx, "dy": y - wy,
                                  "w": ww, "h": wh}
                    # Clicking also selects, so the arrow keys have something to
                    # nudge once the mouse has been let go.
                    self._selected = widget_id
                    user32.SetCapture(self._hwnd)
                    self._flush_frame()
                    break
        elif msg == WM_MOUSEMOVE and self._drag:
            left = x - self._drag["dx"]
            top = y - self._drag["dy"]
            # Snap live, not on release: the widget has to visibly stick to the
            # line it is aligning with, or the correction only shows up after
            # the drag is over and reads as the overlay moving things itself.
            # Ctrl is the escape hatch, and it is read every move so it can be
            # pressed or released mid-drag.
            guides = {"x": [], "y": []}
            if not (user32.GetAsyncKeyState(VK_CONTROL) & 0x8000):
                left, top, guides = self._snap(self._drag, left, top)
            self._drag["x"], self._drag["y"] = left, top
            self._drag["guides"] = guides
            # Repaint straight away -- _wndproc is already on the window thread,
            # so this is the blit, not a request for one. Capped at ~60fps
            # because each frame is a full-window layered blit and mouse moves
            # arrive far faster than that.
            now = time.monotonic()
            if now - self._drag_painted >= 0.016:
                self._drag_painted = now
                self._flush_frame()
        elif msg == WM_LBUTTONUP and self._drag:
            user32.ReleaseCapture()
            drag = self._drag
            self._drag = None
            if "x" in drag:
                # Already snapped on the way here, so the widget lands exactly
                # where it was last drawn.
                self._commit(drag["id"], drag["x"], drag["y"], drag["w"], drag["h"])
            else:
                self._post_redraw()   # repaint without the drag highlight

    def _post_redraw(self):
        """Ask the window thread to repaint. Safe to call from any thread --
        which matters because arrow-key nudges arrive on the tracker's."""
        thread_id = self._thread_id
        if thread_id:
            user32.PostThreadMessageW(thread_id, WM_APP_REDRAW, 0, 0)

    def _commit(self, widget_id, left, top, w, h):
        """Hand a pixel position back to the tracker as anchor + fractions."""
        _, _, cw, ch = self._rect
        if not (cw and ch and self._on_move):
            return
        self._pin_hold = (widget_id, left, top)
        self._post_redraw()
        anchor = ("top" if top + h / 2 < ch / 2 else "bottom") + \
                 "-" + ("left" if left + w / 2 < cw / 2 else "right")
        fx = left / cw if anchor.endswith("left") else (cw - left - w) / cw
        fy = top / ch if anchor.startswith("top") else (ch - top - h) / ch
        clamp = lambda v: max(0.0, min(0.95, v))  # noqa: E731
        try:
            self._on_move(widget_id, anchor, clamp(fx), clamp(fy))
        except Exception:
            pass

    def nudge_selected(self, dx, dy):
        """Move the selected widget by a pixel offset (the arrow keys).

        Reads the position from where the widget was last drawn rather than
        from its stored fractions, so a nudge lands relative to what is on
        screen -- including any anti-overlap shift it was given.
        """
        widget_id = self._selected
        if not widget_id or self._drag:
            return False
        rect = next((r for r in self._hit_rects if r[0] == widget_id), None)
        if not rect:
            return False
        _, wx, wy, ww, wh = rect

        # Chain off the previous nudge rather than off the last drawn frame.
        # The arrows repeat about twenty times a second and the tracker repaints
        # roughly once a second, so reading the drawn position every time would
        # keep recomputing the same single pixel of movement and throw the rest
        # away -- which looks exactly like the arrow keys doing nothing.
        now = time.monotonic()
        if (self._nudge and self._nudge[0] == widget_id
                and now - self._nudge[3] < 0.5):
            wx, wy = self._nudge[1], self._nudge[2]

        _, _, cw, ch = self._rect
        left = max(0, min(cw - ww, wx + dx))
        top = max(0, min(ch - wh, wy + dy))
        if (left, top) == (wx, wy):
            return False
        self._nudge = (widget_id, left, top, now)
        self._commit(widget_id, left, top, ww, wh)
        return True

    def has_selection(self):
        return bool(self._selected)

    def clear_selection(self):
        self._selected = None

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

    def set_capture_hidden(self, hidden):
        """Keep the overlay off screen shares and recordings, or put it back.

        Applies to the live window and is remembered for the next one, since the
        window is destroyed and rebuilt whenever the overlay hides. Returns
        whether Windows accepted it -- pre-2004 builds have no such flag, and
        the caller would otherwise report a privacy setting that isn't in force.
        """
        self._capture_hidden = bool(hidden)
        hwnd = self._hwnd
        if not (hwnd and user32.IsWindow(hwnd)):
            return False
        affinity = WDA_EXCLUDEFROMCAPTURE if hidden else WDA_NONE
        try:
            return bool(user32.SetWindowDisplayAffinity(wintypes.HWND(hwnd), affinity))
        except Exception:
            return False

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

    def update(self, widgets, *, scale=1.0, opacity=0.92, accent=(94, 198, 255),
               ink=None, panel=None, prevent_overlap=True):
        """Queue a repaint. Safe from any thread; the blit runs on the window thread."""
        _, _, w, h = self._rect
        if w <= 0 or h <= 0:
            return
        with self._lock:
            self._frame = {"widgets": widgets, "scale": scale,
                           "opacity": opacity, "accent": accent,
                           "ink": ink, "panel": panel,
                           "prevent_overlap": prevent_overlap}
            # A fresh frame already carries the dropped position, so the hold
            # has done its job.
            self._pin_hold = None
        thread_id = self._thread_id
        if thread_id:
            user32.PostThreadMessageW(thread_id, WM_APP_REDRAW, 0, 0)

    # --- the actual blit (window thread only) -----------------------------
    def _flush_frame(self):
        with self._lock:
            frame = self._frame
            if frame:
                self._last_frame = frame
            else:
                frame = self._last_frame
            self._frame = None
        if not frame:
            return
        x, y, width, height = self._rect
        if width <= 0 or height <= 0 or not self._hwnd:
            return

        widgets = frame["widgets"]
        # While dragging, draw the grabbed widget under the cursor instead of at
        # its stored position, so the drag has live feedback. The same pin holds
        # the widget at its landing spot after the button comes up: the config
        # write is a round trip through the tracker, and without this the widget
        # would snap back to where it started for a moment first.
        pin = None
        guides = None
        if self._drag and "x" in self._drag:
            pin = (self._drag["id"], self._drag["x"], self._drag["y"])
            guides = self._drag.get("guides")
        elif self._pin_hold:
            pin = self._pin_hold
        selected = self._selected if self._interactive else None
        if pin or selected:
            widgets = [dict(w) for w in widgets]
            for widget in widgets:
                if pin and widget.get("id") == pin[0]:
                    widget["_pin"] = (pin[1], pin[2])
                    if self._drag:
                        widget["highlight"] = True
                if selected and widget.get("id") == selected:
                    widget["selected"] = True

        bitmap, hit_rects = overlay_draw.render(
            width, height, widgets,
            scale=frame["scale"], opacity=frame["opacity"], accent=frame["accent"],
            ink=frame.get("ink"), panel=frame.get("panel"),
            prevent_overlap=frame.get("prevent_overlap", True),
            guides=guides)
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
