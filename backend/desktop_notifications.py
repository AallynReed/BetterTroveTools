"""Desktop OS notification manager for the packaged app.

A single place for the Python backend (or the frontend, via the exposed eel
functions) to raise a native notification to the user. Delivery is pluggable
through a *sink*: the app registers one once its system-tray icon exists, so
notifications route through the tray balloon (Shell_NotifyIcon). With no sink --
a dev checkout without pywin32, a non-Windows host, or before the window is up --
calls no-op gracefully.

Three capabilities:

  * ``notify`` / ``notify_once`` -- one-off notifications (once = persisted,
    shown at most a single time ever).

  * a lightweight **scheduler** -- the frontend computes the deterministic Trove
    rotation reminders (all the calendar math lives in web_mode.js /
    notifications.js) and hands us a flat list of {id, title, body, at}. A
    background thread fires each when due. Timing runs in Python on purpose:
    the WebView2 window keeps running while hidden in the tray, but its JS
    timers get throttled hard when hidden, so a Python thread is the reliable
    clock. Firing stops only when the process exits (app fully quit), which is
    exactly the "notifies while open or in the tray" contract.

  * **tray presence** -- while reminders are enabled the tray icon must stay
    visible so balloons can show even when the main window is open; the app
    registers a handler we call when the active state flips.

This is the desktop counterpart to the Android reminder system in
``web/js/notifications.js`` -- unrelated code paths, deliberately kept separate.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone

import eel

from backend.response import resp, standardize_response
from utils.path import get_cache_root

_STATE_FILENAME = "desktop_notifications.json"

# How often the scheduler thread wakes to check for due reminders.
_POLL_SECONDS = 15.0
# Don't fire a reminder that came due more than this long ago -- covers the
# machine sleeping through an event, where a late "starts in 5m" ping is just
# noise. Normal firing latency is at most one poll interval.
_STALE_GRACE_SECONDS = 150.0


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


class DesktopNotifier:
    def __init__(self):
        self._lock = threading.RLock()
        self._sink = None
        self._shown = None  # lazy-loaded {key: iso_timestamp} for notify_once

        # Scheduler state.
        self._sched_lock = threading.Lock()
        self._scheduled = {}   # id -> {"at": float, "title": str, "body": str}
        self._fired = set()    # ids already fired this process run
        self._sched_thread = None
        self._stop = threading.Event()

        # Tray presence handler: callable(active: bool) the app registers to
        # show/hide the persistent tray icon when reminders turn on/off.
        self._active_handler = None

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

    def set_active_handler(self, handler):
        """Register ``callable(active: bool)`` invoked when reminders are
        enabled/disabled, so the app can keep the tray icon visible for as long
        as balloons need to be deliverable."""
        self._active_handler = handler

    def set_active(self, active):
        handler = self._active_handler
        if handler:
            try:
                handler(bool(active))
            except Exception:
                pass

    # --- persisted shown-once state ------------------------------------
    def _state_path(self):
        return get_cache_root() / _STATE_FILENAME

    def _load_state(self):
        # Caller must hold self._lock.
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
        # Caller must hold self._lock.
        try:
            path = self._state_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({"shown": self._shown or {}}, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    # --- one-off notifications -----------------------------------------
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

    # --- scheduled reminders -------------------------------------------
    def schedule(self, items):
        """Replace the pending reminder set.

        ``items`` is an iterable of dicts ``{id, title, body, at}`` where ``at``
        is an epoch-seconds fire time. The frontend recomputes and re-sends the
        whole list (already excluding past events), so this is a full replace,
        not a merge. Ids that dropped out of the list are also forgotten from the
        fired set so a genuinely new event reusing an id can fire again. Returns
        the count accepted.
        """
        cleaned = {}
        for it in items or []:
            try:
                nid = str(it["id"])
                at = float(it["at"])
            except (KeyError, TypeError, ValueError):
                continue
            cleaned[nid] = {
                "at": at,
                "title": str(it.get("title") or ""),
                "body": str(it.get("body") or ""),
            }
        with self._sched_lock:
            self._scheduled = cleaned
            self._fired &= set(cleaned.keys())
            self._ensure_thread()
        return len(cleaned)

    def clear_schedule(self):
        with self._sched_lock:
            self._scheduled = {}
            self._fired.clear()

    def _ensure_thread(self):
        # Caller must hold self._sched_lock.
        if self._sched_thread and self._sched_thread.is_alive():
            return
        self._stop.clear()
        self._sched_thread = threading.Thread(
            target=self._run_scheduler, name="desktop-notify-sched", daemon=True
        )
        self._sched_thread.start()

    def _run_scheduler(self):
        # Wakes every poll interval; _stop.wait doubles as the sleep + exit.
        while not self._stop.wait(_POLL_SECONDS):
            try:
                self._fire_due()
            except Exception:
                pass

    def _fire_due(self):
        now = time.time()
        due = []
        with self._sched_lock:
            for nid, it in self._scheduled.items():
                if nid in self._fired:
                    continue
                if now - _STALE_GRACE_SECONDS <= it["at"] <= now:
                    due.append((nid, dict(it)))
        # Deliver outside the lock; fire soonest-first for tidy ordering.
        for nid, it in sorted(due, key=lambda p: p[1]["at"]):
            if self.notify(it["title"], it["body"]):
                with self._sched_lock:
                    self._fired.add(nid)


# App-wide singleton. Import this (not a fresh instance) so the registered sink,
# scheduler and shown-once cache are shared everywhere.
notifier = DesktopNotifier()


# ---- eel surface -------------------------------------------------------
@eel.expose
@standardize_response
def desktop_notifications_available():
    """Whether native desktop notifications can actually be delivered here
    (a tray sink is registered -- i.e. Windows packaged build). The frontend
    uses this to decide whether to offer the Notifications settings tab."""
    return resp(True, data={"available": notifier.has_sink()}, available=notifier.has_sink())


@eel.expose
@standardize_response
def notify_desktop(title, message, key=None, once=False):
    """Raise a desktop notification from the frontend.

    ``once=True`` with a stable ``key`` shows it at most once ever. Returns
    ``{ shown }`` -- whether it was surfaced this call.
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


@eel.expose
@standardize_response
def schedule_desktop_notifications(notifications, active=True):
    """Replace the scheduled reminder set and set the active (tray-presence)
    state. Called by the frontend scheduler on startup, on settings change, and
    on a rolling refresh. ``notifications`` is a list of {id, title, body, at}.
    """
    notifier.set_active(bool(active))
    count = notifier.schedule(notifications or [])
    return resp(True, data={"scheduled": count}, scheduled=count)
