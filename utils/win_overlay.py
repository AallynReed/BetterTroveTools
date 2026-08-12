"""Global hotkeys and foreground lookup for the in-game overlay (Windows only).

The overlay's window, transparency and click-through all live in
``utils/overlay_window.py`` -- a layered window with per-pixel alpha handles all
three natively. What is left here is the input side:

  * **A set of global hotkeys** -- one ``RegisterHotKey`` per binding on a
    dedicated message-loop thread, so the player can unlock or hide the overlay
    without alt-tabbing out of the game.
  * **Reading the foreground window** -- the tracker needs to know whether the
    user is actually looking at Trove, and whether a click landed on the overlay
    itself.

Nothing here reads or writes another process. The hotkeys are registered against
our own thread and only ever call back into our own code.
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

    WM_HOTKEY = 0x0312
    # Our private "stop pumping" message, posted to the hotkey thread on teardown.
    WM_APP_STOP = 0x8000 + 1

    user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
    user32.RegisterHotKey.restype = wintypes.BOOL
    user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.UnregisterHotKey.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                                   wintypes.UINT, wintypes.UINT]
    user32.GetMessageW.restype = ctypes.c_int
    user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT,
                                          wintypes.WPARAM, wintypes.LPARAM]
    user32.PostThreadMessageW.restype = wintypes.BOOL
    user32.GetForegroundWindow.restype = wintypes.HWND

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
    mods = [p for p in order if any(_MOD_NAMES.get(x) == _MOD_NAMES.get(p)
                                    for x in parts if x in _MOD_NAMES)]
    key = next((p for p in parts if p not in _MOD_NAMES), "")
    return "+".join([m.capitalize() for m in mods] + [key.upper() if len(key) == 1 else key.capitalize()])


# --- foreground -------------------------------------------------------------


def foreground_hwnd():
    """The window the user is currently interacting with, or None."""
    if not _IS_WINDOWS:
        return None
    return user32.GetForegroundWindow() or None


# --- global hotkeys ---------------------------------------------------------


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
