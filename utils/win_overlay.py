"""Win32 plumbing for the in-game overlay window (Windows only).

Two jobs, both operating exclusively on windows this process owns:

  * **Window behaviour** -- make our own pywebview child window act like an
    overlay: never take focus, stay out of the taskbar and Alt-Tab, sit above the
    game, and (by default) let every mouse click fall straight through to Trove.
  * **A global hotkey** -- one ``RegisterHotKey`` on a dedicated message-loop
    thread, so the player can flip the overlay into interactive mode without
    alt-tabbing out of the game.

Nothing here reads or writes another process. Positioning uses the geometry
``utils.trove_window`` already read; the hotkey is registered against our own
thread and only ever calls back into our own code.

**Why WS_EX_TRANSPARENT and not WS_EX_LAYERED.** The usual click-through recipe
pairs the two, but that pairing is for windows that paint their own per-pixel
alpha through ``UpdateLayeredWindow``. Ours doesn't -- WebView2 composites the
page's alpha for us once pywebview sets a transparent background. Setting
WS_EX_LAYERED without a matching ``SetLayeredWindowAttributes`` /
``UpdateLayeredWindow`` call makes a window *invisible*, and calling
``SetLayeredWindowAttributes`` would replace the page's per-pixel alpha with one
uniform value -- which is the whole overlay effect gone. WS_EX_TRANSPARENT alone
gives the hit-testing half (the window answers HTTRANSPARENT and mouse messages
land on whatever is underneath), which is the only half we need.
"""
from __future__ import annotations

import sys
import threading

_IS_WINDOWS = sys.platform == "win32"

# Virtual-key codes for the names a hotkey string may use. Letters and digits
# resolve from their ASCII value, so only the named keys need a table.
_VK_NAMES = {
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
    "insert": 0x2D, "delete": 0x2E, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22, "space": 0x20, "tab": 0x09,
    "escape": 0x1B, "esc": 0x1B, "backspace": 0x08, "enter": 0x0D,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
}

_MOD_ALT = 0x0001
_MOD_CONTROL = 0x0002
_MOD_SHIFT = 0x0004
_MOD_WIN = 0x0008
# Without this the hotkey auto-repeats for as long as the key is held, which for
# a toggle means it flickers between states dozens of times per press.
_MOD_NOREPEAT = 0x4000

_MOD_NAMES = {
    "ctrl": _MOD_CONTROL, "control": _MOD_CONTROL,
    "alt": _MOD_ALT, "shift": _MOD_SHIFT,
    "win": _MOD_WIN, "super": _MOD_WIN, "meta": _MOD_WIN,
}

if _IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)

    GWL_EXSTYLE = -20
    WS_EX_TRANSPARENT = 0x00000020
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_NOACTIVATE = 0x08000000

    HWND_TOPMOST = wintypes.HWND(-1)
    SWP_NOSIZE = 0x0001
    SWP_NOMOVE = 0x0002
    SWP_NOACTIVATE = 0x0010
    SWP_SHOWWINDOW = 0x0040
    SWP_NOOWNERZORDER = 0x0200

    WM_HOTKEY = 0x0312
    WM_QUIT = 0x0012
    # Our private "stop pumping" message, posted to the hotkey thread on teardown.
    WM_APP_STOP = 0x8000 + 1

    # SetWindowLongPtrW only exists in the 64-bit user32; the 32-bit build has
    # SetWindowLongW and nothing else. Bind whichever is present so the same code
    # runs on both without truncating a 64-bit style word.
    _set_long = getattr(user32, "SetWindowLongPtrW", None) or user32.SetWindowLongW
    _get_long = getattr(user32, "GetWindowLongPtrW", None) or user32.GetWindowLongW
    _set_long.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
    _set_long.restype = ctypes.c_ssize_t
    _get_long.argtypes = [wintypes.HWND, ctypes.c_int]
    _get_long.restype = ctypes.c_ssize_t

    user32.SetWindowPos.argtypes = [
        wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, wintypes.UINT,
    ]
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
    user32.RegisterHotKey.restype = wintypes.BOOL
    user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.UnregisterHotKey.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.GetMessageW.restype = ctypes.c_int
    user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.PostThreadMessageW.restype = wintypes.BOOL

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD


# --- hotkey strings ---------------------------------------------------------


def parse_hotkey(spec):
    """``"ctrl+alt+o"`` -> ``(modifiers, virtual_key)``, or None if unparseable.

    A hotkey with no modifier is rejected on purpose: registering a bare letter
    globally would swallow that key everywhere in Windows, including inside
    Trove's own chat box.
    """
    if not spec or not isinstance(spec, str):
        return None
    parts = [p.strip().lower() for p in spec.replace(" ", "").split("+") if p.strip()]
    if len(parts) < 2:
        return None

    mods = 0
    key = None
    for part in parts:
        if part in _MOD_NAMES:
            mods |= _MOD_NAMES[part]
        elif key is None:
            key = part
        else:
            return None  # two non-modifier keys

    if not mods or not key:
        return None

    if key in _VK_NAMES:
        vk = _VK_NAMES[key]
    elif len(key) == 1 and (key.isalpha() or key.isdigit()):
        vk = ord(key.upper())
    else:
        return None
    return (mods | _MOD_NOREPEAT, vk)


def format_hotkey(spec):
    """Normalize a hotkey string for display, or '' if it doesn't parse."""
    if not parse_hotkey(spec):
        return ""
    order = ["ctrl", "alt", "shift", "win"]
    parts = [p.strip().lower() for p in str(spec).replace(" ", "").split("+") if p.strip()]
    mods = [p for p in order if any(_MOD_NAMES.get(x) == _MOD_NAMES.get(p) for x in parts if x in _MOD_NAMES)]
    key = next((p for p in parts if p not in _MOD_NAMES), "")
    return "+".join([m.capitalize() for m in mods] + [key.upper() if len(key) == 1 else key.capitalize()])


# --- our window's behaviour -------------------------------------------------


def apply_overlay_style(hwnd, click_through=True):
    """Make ``hwnd`` behave as an overlay. Returns True if the styles were set.

    Always applied: NOACTIVATE (clicking it never pulls focus off the game) and
    TOOLWINDOW (keeps it out of the taskbar and the Alt-Tab list, so the overlay
    can't be tabbed to by accident). TRANSPARENT is the click-through half and is
    the only bit that changes at runtime.
    """
    if not (_IS_WINDOWS and hwnd) or not user32.IsWindow(hwnd):
        return False
    style = _get_long(hwnd, GWL_EXSTYLE)
    style |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
    if click_through:
        style |= WS_EX_TRANSPARENT
    else:
        style &= ~WS_EX_TRANSPARENT
    _set_long(hwnd, GWL_EXSTYLE, style)
    return True


def set_click_through(hwnd, click_through):
    """Toggle just the pass-through bit, leaving the rest of the style alone."""
    if not (_IS_WINDOWS and hwnd) or not user32.IsWindow(hwnd):
        return False
    style = _get_long(hwnd, GWL_EXSTYLE)
    updated = (style | WS_EX_TRANSPARENT) if click_through else (style & ~WS_EX_TRANSPARENT)
    if updated != style:
        _set_long(hwnd, GWL_EXSTYLE, updated)
    return True


def place(hwnd, x, y, width, height, topmost=True):
    """Move/resize ``hwnd`` to a screen rect without ever activating it.

    Re-asserting HWND_TOPMOST on every placement is deliberate: launching another
    topmost window (or the game going through a mode switch) can quietly demote
    us, and a demoted overlay renders behind the game where nobody can see it.
    """
    if not (_IS_WINDOWS and hwnd) or not user32.IsWindow(hwnd):
        return False
    flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER
    insert_after = HWND_TOPMOST if topmost else wintypes.HWND(0)
    return bool(user32.SetWindowPos(hwnd, insert_after, int(x), int(y),
                                    int(width), int(height), flags))


def raise_topmost(hwnd):
    """Re-assert topmost z-order without moving or resizing."""
    if not (_IS_WINDOWS and hwnd) or not user32.IsWindow(hwnd):
        return False
    return bool(user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER))


# --- global hotkey ----------------------------------------------------------


class HotkeyListener:
    """A set of named global hotkeys on one thread. ``on_press(action)`` runs there.

    Registered with a NULL hwnd, which binds each hotkey to the calling *thread* --
    hence the dedicated thread with its own ``GetMessage`` pump. All the bindings
    share that one thread, so rebinding tears it down and starts fresh; that keeps
    registration and unregistration on the same thread, which ``UnregisterHotKey``
    requires.

    ``bind_all`` reports per-action success rather than raising. A combination
    already owned by another app is an ordinary outcome the user needs told about,
    not an error condition -- and one clashing binding must not cost them the
    others.
    """

    _BASE_ID = 0xB77  # arbitrary, process-local

    def __init__(self, on_press):
        self._on_press = on_press
        self._lock = threading.Lock()
        self._thread = None
        self._thread_id = None
        self._registered = threading.Event()
        self._results = {}   # action -> bool
        self._specs = {}     # action -> spec string

    @property
    def active(self):
        """``{action: spec}`` for the bindings that actually took."""
        with self._lock:
            return {a: s for a, s in self._specs.items() if self._results.get(a)}

    def results(self):
        with self._lock:
            return dict(self._results)

    def bind_all(self, mapping):
        """Register ``{action: "ctrl+alt+o"}``. Returns ``{action: bool}``."""
        self.stop()
        parsed = {}
        results = {}
        for action, spec in (mapping or {}).items():
            combo = parse_hotkey(spec)
            if _IS_WINDOWS and combo:
                parsed[action] = combo
            else:
                results[action] = False

        with self._lock:
            self._specs = dict(mapping or {})
            self._results = dict(results)

        if not parsed:
            return self.results()

        self._registered.clear()
        thread = threading.Thread(
            target=self._run, args=(parsed,), name="overlay-hotkeys", daemon=True
        )
        with self._lock:
            self._thread = thread
        thread.start()
        # Short wait so callers get a truthful per-action result instead of an
        # optimistic True that turns out to be a clash.
        self._registered.wait(2.0)
        return self.results()

    def stop(self):
        with self._lock:
            thread, thread_id = self._thread, self._thread_id
            self._thread = self._thread_id = None
            self._results = {}
        if thread_id:
            try:
                user32.PostThreadMessageW(thread_id, WM_APP_STOP, 0, 0)
            except Exception:
                pass
        if thread and thread.is_alive():
            thread.join(timeout=2.0)

    def _run(self, parsed):
        thread_id = kernel32.GetCurrentThreadId()
        with self._lock:
            self._thread_id = thread_id

        by_id = {}
        results = {}
        for index, (action, (mods, vk)) in enumerate(sorted(parsed.items())):
            hotkey_id = self._BASE_ID + index
            ok = bool(user32.RegisterHotKey(None, hotkey_id, mods, vk))
            results[action] = ok
            if ok:
                by_id[hotkey_id] = action

        with self._lock:
            self._results.update(results)
        self._registered.set()
        if not by_id:
            return

        try:
            msg = wintypes.MSG()
            while True:
                got = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if got in (0, -1):  # WM_QUIT, or the pump errored out
                    break
                if msg.message == WM_APP_STOP:
                    break
                if msg.message == WM_HOTKEY and msg.wParam in by_id:
                    try:
                        self._on_press(by_id[msg.wParam])
                    except Exception:
                        pass
        finally:
            for hotkey_id in by_id:
                try:
                    user32.UnregisterHotKey(None, hotkey_id)
                except Exception:
                    pass
