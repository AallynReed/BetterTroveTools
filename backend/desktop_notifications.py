"""Desktop OS notification manager for the packaged app.

A single place for the Python backend (or the frontend, via ``notify_desktop``)
to raise a native notification to the user. Delivery is pluggable through a
*sink*: the app registers one once its system-tray icon exists, so notifications
route through the tray balloon (Shell_NotifyIcon). With no sink -- a dev checkout
without pywin32, a non-Windows host, or before the window is up -- calls no-op
gracefully.

Two delivery modes:
  * ``notify(title, message)``        -- always attempt to show.
  * ``notify_once(key, title, msg)``  -- show only if ``key`` has never been
    shown before, persisted to disk so it never repeats across restarts.

``notify_once`` records a key ONLY when delivery actually succeeds, so a call
made before any sink is registered doesn't silently burn the one-time slot.

This is the desktop counterpart to the Android reminder system in
``web/js/notifications.js`` -- unrelated code paths, deliberately kept separate.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone

import eel

from backend.response import resp, standardize_response
from utils.path import get_cache_root

_STATE_FILENAME = "desktop_notifications.json"


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


class DesktopNotifier:
    def __init__(self):
        self._lock = threading.RLock()
        self._sink = None
        self._shown = None  # lazy-loaded {key: iso_timestamp}

    # --- delivery sink --------------------------------------------------
    def set_sink(self, sink):
        """Register the delivery backend. ``sink`` is ``callable(title, message)``
        that shows a native notification (e.g. the tray icon's ``notify``).
        Passing None detaches it (e.g. on shutdown)."""
        with self._lock:
            self._sink = sink

    def has_sink(self):
        with self._lock:
            return self._sink is not None

    # --- persisted shown-once state ------------------------------------
    def _state_path(self):
        return get_cache_root() / _STATE_FILENAME

    def _load_state(self):
        # Caller must hold the lock.
        if self._shown is not None:
            return self._shown
        shown = {}
        try:
            path = self._state_path()
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("shown"), dict):
                    shown = data["shown"]
        except Exception:
            shown = {}
        self._shown = shown
        return self._shown

    def _save_state(self):
        # Caller must hold the lock.
        try:
            path = self._state_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({"shown": self._shown or {}}, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    # --- public API -----------------------------------------------------
    def notify(self, title, message):
        """Attempt to show a notification now. Returns True if a sink handled it."""
        with self._lock:
            sink = self._sink
        if not sink:
            return False
        try:
            sink(str(title or ""), str(message or ""))
            return True
        except Exception:
            return False

    def has_shown(self, key):
        with self._lock:
            return key in self._load_state()

    def notify_once(self, key, title, message):
        """Show ``title``/``message`` only if ``key`` was never shown before.

        The key is persisted across restarts, and recorded only on successful
        delivery, so the one-time notification survives being requested while no
        sink is attached yet. Returns True iff it was shown this call.
        """
        if not key:
            return self.notify(title, message)
        with self._lock:
            if key in self._load_state():
                return False
        delivered = self.notify(title, message)
        if delivered:
            with self._lock:
                self._load_state()[key] = _utc_now_iso()
                self._save_state()
        return delivered

    def reset(self, key=None):
        """Forget shown-once state -- all keys, or a single ``key``. Lets a
        one-time notification fire again (e.g. a 'reset tips' style action)."""
        with self._lock:
            shown = self._load_state()
            if key is None:
                shown.clear()
            else:
                shown.pop(key, None)
            self._save_state()


# App-wide singleton. Import this (not a fresh instance) so the registered sink
# and shown-once cache are shared everywhere.
notifier = DesktopNotifier()


@eel.expose
@standardize_response
def notify_desktop(title, message, key=None, once=False):
    """Raise a desktop notification from the frontend.

    ``once=True`` with a stable ``key`` shows it at most once ever. Returns
    ``{ shown, delivered }`` -- ``shown`` is whether it was surfaced this call.
    """
    if once:
        shown = notifier.notify_once(key, title, message)
    else:
        shown = notifier.notify(title, message)
    return resp(True, data={"shown": bool(shown)}, shown=bool(shown))


@eel.expose
@standardize_response
def reset_desktop_notification(key=None):
    """Clear shown-once state so a keyed notification can fire again."""
    notifier.reset(key)
    return resp(True, data={"reset": key or "all"})
