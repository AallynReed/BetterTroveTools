"""Live Trove event notifications for the desktop app (SSE-driven).

Consumes the shared TroveAPI event stream (``backend.live_feed``) and raises a
native desktop notification for each in-game event the user has opted into -- at
a fine grain (e.g. "Rampage challenge" specifically, not just "challenges").

Design:
  * The socket itself lives in ``backend.live_feed``: one connection serves both
    notifications and the live UI data. This module is just a subscriber, so it
    keeps working while the window is hidden in the tray and costs nothing extra
    when notifications are off.
  * The stream sends an on-connect SNAPSHOT of the current challenge/chaos state,
    then live pushes. We announce that snapshot (so enabling an event tells you
    what's live right now) and dedupe by a per-event signature that persists
    across restarts -- so a repeated snapshot stays silent while a genuinely new
    occurrence still fires. Turning an event on replays the feed's last payload
    for it, which is what makes "tell me what's live now" work without waiting
    for the next reconnect.
  * Delivery reuses the shared DesktopNotifier (tray balloon). Turning
    notifications on also marks the notifier "active" so the tray icon stays
    visible for balloon delivery.

This REPLACES the old Android-rotation-derived desktop scheduler -- the event
taxonomy and timing now come straight from the live API.
"""
from __future__ import annotations

import json
import threading

import eel

from backend.live_feed import feed
from backend.response import resp, standardize_response
from backend.desktop_notifications import notifier as _desktop_notifier
from utils.path import get_cache_root

# Persisted per-event last-seen signatures live here (one small {key: sig} map,
# bounded to the number of event types). Persisting across restarts is what stops
# the current-state snapshot from being re-announced on every app launch.
_STATE_FILENAME = "event_notifications_state.json"

_CHALLENGE_LABEL = {
    "rampage": "Rampage",
    "racing": "Racing",
    "target": "Target",
    "collection": "Collection",
    "dungeon": "Dungeon",
}


def _biomes_text(data):
    current = data.get("current") or {}
    names = [
        (b.get("final_name") or b.get("name"))
        for b in (current.get("biomes") or [])
    ]
    return ", ".join(n for n in names if n), current.get("starts_at")


# Each handler maps a raw event payload's ``data`` to
# ``(toggle_key, signature, title, body)`` -- or None to ignore this event.
# ``toggle_key`` is the settings key the user flips; ``signature`` dedupes the
# same occurrence across snapshot/reconnect.
def _h_challenge(d):
    name = (d.get("name") or "").strip()
    ctype = d.get("type")
    if not name or not ctype:
        return None
    label = _CHALLENGE_LABEL.get(ctype, ctype.title())
    return (
        f"challenge_{ctype}",
        f"{d.get('starts_at')}:{name}",
        f"{label} Challenge",
        f"{name} is live now.",
    )


def _h_chaos(d):
    item = d.get("item") or {}
    iname = item.get("name")
    if not iname:
        return None
    return ("chaos", f"{d.get('starts_at')}:{iname}", "Chaos Chest", f"This week's item: {iname}")


def _h_corruxion(d):
    if not d.get("active"):
        return None  # announce only on arrival, not departure
    return ("corruxion", f"corruxion:{d.get('starts_at')}", "Merchant Corruxion",
            "Corruxion has arrived — spend your Dragon Coins.")


def _h_fluxion(d):
    if not d.get("active"):
        return None
    state = d.get("state") or ""
    return ("fluxion", f"fluxion:{d.get('starts_at')}:{state}", "Merchant Fluxion",
            f"Fluxion is here ({state}).".replace(" ().", "."))


def _h_longshade(d):
    text, sa = _biomes_text(d)
    return ("longshade", f"longshade:{sa}", "Shadow's Eve (d15) Rotation", text or "New biome rotation")


def _h_wild_mana(d):
    text, sa = _biomes_text(d)
    return ("wild_mana", f"wild_mana:{sa}", "Wild Mana Rotation", text or "New biome rotation")


def _h_stampy(d):
    text, sa = _biomes_text(d)
    return ("stampy", f"stampy:{sa}", "Stampy the Dragon", text or "Stampy has moved on.")


def _h_daily(d):
    # Payload shape: {"current": {name, weekday, normal_buffs:[...], ...}, "week":[...]}.
    buff = d.get("current") or {}
    name = buff.get("name")
    normal_buffs = buff.get("normal_buffs") or []
    benefit = normal_buffs[0] if normal_buffs else None
    parts = [name, benefit]
    body = " — ".join(p for p in parts if p) or "A new day in Trove has begun."
    # No reset timestamp in the payload, so key the signature off the buff name.
    # The seven daily buffs are all distinct and never repeat on consecutive days,
    # so this changes exactly once per day (fires once/day) yet stays constant
    # within a day (no re-fire on reconnect/restart).
    return ("daily_bonuses", f"daily:{name or buff.get('weekday')}", "Daily Reset", body)


def _h_activity(d):
    return ("activity", f"activity:{d.get('window_start')}", "Player Activity",
            "A fresh daily player-activity snapshot is available.")


def _h_status(d):
    overall = d.get("overall") or "unknown"
    return ("server_status", f"status:{overall}", "Trove Servers", f"Server status is now: {overall}.")


def _h_news(d):
    item = d.get("item") or {}
    title = item.get("title")
    if not title:
        return None
    return ("trove_news", f"news:{item.get('url')}", "Trove News", title)


def _h_giveaways(d):
    newest = d.get("newest") or {}
    title = newest.get("title")
    if not title:
        return None
    return ("giveaways", f"giveaway:{newest.get('id')}", "New Giveaway", title)


def _h_game_update(d):
    ver = d.get("version") or {}
    tag = ver.get("version_tag") or ver.get("ordinal")
    if not tag:
        return None
    return ("game_update", f"update:{ver.get('branch')}:{ver.get('ordinal')}",
            "Game Update", f"Trove updated to {tag}.")


_HANDLERS = {
    "challenge": _h_challenge,
    "chaos": _h_chaos,
    "corruxion": _h_corruxion,
    "fluxion": _h_fluxion,
    "longshade": _h_longshade,
    "wild_mana": _h_wild_mana,
    "stampy": _h_stampy,
    "daily_bonuses": _h_daily,
    "activity": _h_activity,
    "server_status": _h_status,
    "trove_news": _h_news,
    "giveaways": _h_giveaways,
    "game_update": _h_game_update,
}


class EventNotifier:
    def __init__(self, notifier, live_feed):
        self._notifier = notifier            # shared DesktopNotifier (delivery + tray presence)
        self._feed = live_feed               # shared SSE connection
        self._lock = threading.Lock()
        self._enabled = False
        self._events = {}                    # toggle_key -> bool
        # toggle_key -> last-seen signature; loaded from disk so already-announced
        # occurrences survive a restart and aren't re-fired from the snapshot.
        self._last_sig = self._load_state()
        self._feed.subscribe(self._on_event)

    # --- persisted seen-signature state ---------------------------------
    def _state_path(self):
        return get_cache_root() / _STATE_FILENAME

    def _load_state(self):
        try:
            path = self._state_path()
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
                sigs = data.get("last_sig") if isinstance(data, dict) else None
                if isinstance(sigs, dict):
                    return {str(k): str(v) for k, v in sigs.items()}
        except Exception:
            pass
        return {}

    def _save_state(self, sigs):
        try:
            path = self._state_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({"last_sig": sigs}, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    # --- public control -------------------------------------------------
    def apply(self, notifications):
        """Reconcile to the user's notification settings. ``notifications`` is
        the ``settings.notifications`` dict: ``{enabled, events:{key: bool}}``."""
        notifications = notifications if isinstance(notifications, dict) else {}
        events = notifications.get("events") if isinstance(notifications.get("events"), dict) else {}
        master = notifications.get("enabled") is True
        # Announce only when the master switch is on AND at least one event is
        # selected -- the stream itself runs regardless, for the live UI data.
        stream_on = master and any(bool(v) for v in events.values())
        with self._lock:
            self._enabled = stream_on
            self._events = {k: bool(v) for k, v in events.items()}

        # Tray presence follows the MASTER switch (not stream_on) so the icon --
        # and the "send test" balloon -- work as soon as notifications are turned
        # on, even before the user has ticked a specific event.
        try:
            self._notifier.set_active(master)
        except Exception:
            pass

        # Newly ticked events should announce what is live RIGHT NOW rather than
        # wait for the next push, so replay the feed's last payload for each type
        # through the same path. The signature dedupe keeps already-announced
        # occurrences silent.
        if stream_on:
            for event_type, data in self._feed.snapshot().items():
                self._on_event(event_type, data)

    def is_enabled(self):
        with self._lock:
            return self._enabled

    def _is_on(self, key):
        with self._lock:
            return self._events.get(key, False)

    # --- stream consumption ---------------------------------------------
    def _on_event(self, event_type, data):
        """Feed subscriber. Runs on the stream thread."""
        if event_type == "_status":
            return
        with self._lock:
            if not self._enabled:
                return
        self._dispatch(event_type, data)

    def _dispatch(self, event_type, data):
        handler = _HANDLERS.get(event_type)
        if not handler:
            return
        try:
            result = handler(data)
        except Exception:
            result = None
        if not result:
            return
        key, sig, title, body = result

        # Only track (and fire) events the user has opted into -- leaving disabled
        # events out of _last_sig means enabling one later still announces its
        # current state instead of being pre-suppressed by a snapshot we ignored.
        if not self._is_on(key):
            return
        with self._lock:
            prev = self._last_sig.get(key)
            if sig == prev:
                return          # same occurrence already announced (dupe/reconnect/restart)
            self._last_sig[key] = sig
            snapshot = dict(self._last_sig)
        # Persist outside the lock -- a genuinely new occurrence is now remembered
        # so restarting the app won't re-announce it.
        self._save_state(snapshot)
        try:
            self._notifier.notify(title, body)
        except Exception:
            pass


# App-wide singleton, wired to the shared tray-balloon notifier.
event_notifier = EventNotifier(_desktop_notifier, feed)


@eel.expose
@standardize_response
def apply_event_notifications(notifications):
    """Reconcile the live event stream to the user's notification settings.
    Called by the frontend on startup and whenever notification settings change.
    ``notifications`` = ``settings.notifications`` = ``{enabled, events:{...}}``."""
    event_notifier.apply(notifications or {})
    return resp(True, data={"enabled": event_notifier.is_enabled()}, enabled=event_notifier.is_enabled())
