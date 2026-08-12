"""In-game overlay: config, live data snapshot, and the window tracker.

The overlay is a second, frameless, transparent, always-on-top pywebview window
that draws Trove reference data (server clock, daily/weekly bonuses, merchant
timers, rotations, ongoing events) directly over the running game. It is
strictly read-only with respect to Trove: it follows the game window's public
geometry and never reads, writes, hooks, or injects anything into the game.

**It only ever appears over Trove.** The tracker below shows the window when a
Trove process owns a visible foreground window and hides it the instant that
stops being true -- game closed, minimized, or alt-tabbed away from. There is no
mode in which the overlay floats over the desktop or another application.

Three pieces live here:

  * **Config** (``overlay.json`` in the cache root) -- master switch, hotkey,
    opacity/scale, and per-widget enabled/anchor/position. Kept out of
    ``settings.json`` because the widget map is bulky and changes on every drag
    in the editor, and settings.json is rewritten wholesale on every save.
  * **Snapshot** -- everything the widgets render, as absolute unix timestamps so
    the page can tick countdowns locally instead of polling. Built offline from
    ``ServerTime`` plus the bundled buff/biome JSON; the two network-backed bits
    (chaos chest item, Trovesaurus events) are fetched on a slow background
    refresh and degrade to nothing when offline.
  * **Tracker** -- a daemon thread polling the game window and driving
    show/hide/place through a host object ``main.py`` registers (the pywebview
    window lives there; importing webview here would be a circular mess).
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import UTC, datetime, timedelta

import eel

from backend.response import resp, standardize_response
from utils.path import get_cache_root
from utils.trove.server_time import ServerTime
from utils import trove_window, win_overlay

# Windows-only, and desktop-only. Every mechanism the overlay is built on is a
# Win32 one: enumerating the game's top-level window, WS_EX_TRANSPARENT
# click-through, RegisterHotKey, and a topmost frameless WebView2 child window.
# There is no equivalent path that works across X11, Wayland and the compositors
# in between, so rather than ship something half-working on Linux the whole
# feature reports unsupported there and the UI hides it. Android never sees it
# either -- there is no eel bridge in web mode, so the tab simply isn't offered.
SUPPORTED = trove_window._IS_WINDOWS

# --- widget catalog ---------------------------------------------------------

# Anchor corner + fractional offset from it. Fractions (not pixels) so a layout
# built at 1080p still lands correctly at 1440p, on an ultrawide, or after the
# player resizes a windowed game.
VALID_ANCHORS = ("top-left", "top-right", "bottom-left", "bottom-right")

# id -> shipped default. `on` is what a fresh install shows: the three the
# feature was asked for (daily bonus, weekly bonus, server clock) plus the
# notification stack, which has nowhere else to render once the user routes
# notifications into the overlay.
#
# Offsets are fractions but widget heights are in CSS pixels, so the default
# layout is spaced for the smallest window anyone plays in (1280x720). At
# larger resolutions the gaps simply widen -- which is the right way round.
WIDGET_DEFAULTS = {
    "clock":         {"on": True,  "anchor": "top-right",    "x": 0.012, "y": 0.020},
    "daily_buff":    {"on": True,  "anchor": "top-left",     "x": 0.012, "y": 0.020},
    "weekly_buff":   {"on": True,  "anchor": "top-left",     "x": 0.012, "y": 0.260},
    "notifications": {"on": True,  "anchor": "bottom-right", "x": 0.012, "y": 0.020},
    "merchants":     {"on": False, "anchor": "bottom-left",  "x": 0.012, "y": 0.020},
    "chaos_chest":   {"on": False, "anchor": "top-right",    "x": 0.012, "y": 0.180},
    "gardening":     {"on": False, "anchor": "bottom-left",  "x": 0.012, "y": 0.190},
    "rotations":     {"on": False, "anchor": "bottom-right", "x": 0.012, "y": 0.230},
    "delve":         {"on": False, "anchor": "top-right",    "x": 0.012, "y": 0.320},
    "events":        {"on": False, "anchor": "bottom-left",  "x": 0.012, "y": 0.350},
}

# Two hotkeys, because they answer two different questions mid-fight:
#   interact -- "let me click the overlay" (drag a widget, dismiss a notification)
#   mute     -- "get it off my screen right now", without hunting for the app
# Both default to Ctrl+Alt because that pair is rare in Trove's own bindings.
DEFAULT_HOTKEY = "ctrl+alt+o"
DEFAULT_MUTE_HOTKEY = "ctrl+alt+h"

CONFIG_DEFAULTS = {
    "enabled": False,
    "hotkey": DEFAULT_HOTKEY,
    "mute_hotkey": DEFAULT_MUTE_HOTKEY,
    "opacity": 0.92,
    "scale": 1.0,
    # Hide while the player is in another window. Off means the overlay stays up
    # over a non-foreground Trove -- still only over Trove, never over anything
    # else, because a non-running game hides it regardless.
    "hide_when_unfocused": True,
    # Route desktop notifications into the overlay instead of tray balloons
    # while the overlay is actually on screen.
    "notifications_in_overlay": True,
    "notification_seconds": 12,
    "widgets": {},
}

_CONFIG_FILENAME = "overlay.json"

# How often the tracker re-reads the game window. 400ms keeps a windowed-mode
# drag feeling attached without spending real CPU: the poll is three cheap
# user32 calls, and the process scan only reruns once the cached handle dies.
_POLL_SECONDS = 0.4
# Network-backed snapshot bits refresh far slower than the local math.
_NETWORK_TTL_SECONDS = 15 * 60

_TROVE_OFFSET = timedelta(hours=11)


# --- config -----------------------------------------------------------------


def _config_path():
    return get_cache_root() / _CONFIG_FILENAME


def _clamp(value, low, high, fallback):
    try:
        return min(high, max(low, float(value)))
    except (TypeError, ValueError):
        return fallback


def _normalize_widget(widget_id, raw):
    base = WIDGET_DEFAULTS[widget_id]
    raw = raw if isinstance(raw, dict) else {}
    anchor = raw.get("anchor")
    return {
        "enabled": bool(raw.get("enabled", base["on"])),
        "anchor": anchor if anchor in VALID_ANCHORS else base["anchor"],
        # Clamped to [0, 0.95] so a widget can never be dragged (or hand-edited)
        # entirely off the game window with no way to get it back.
        "x": _clamp(raw.get("x", base["x"]), 0.0, 0.95, base["x"]),
        "y": _clamp(raw.get("y", base["y"]), 0.0, 0.95, base["y"]),
        "scale": _clamp(raw.get("scale", 1.0), 0.6, 2.0, 1.0),
    }


def normalize_config(raw):
    raw = raw if isinstance(raw, dict) else {}
    hotkey = raw.get("hotkey")
    if not win_overlay.parse_hotkey(hotkey):
        hotkey = DEFAULT_HOTKEY
    mute_hotkey = raw.get("mute_hotkey")
    if not win_overlay.parse_hotkey(mute_hotkey):
        mute_hotkey = DEFAULT_MUTE_HOTKEY
    # Two actions on one combination means the second registration silently
    # loses; fall the mute key back to its default rather than ship a dead key.
    if mute_hotkey.lower().replace(" ", "") == hotkey.lower().replace(" ", ""):
        mute_hotkey = DEFAULT_MUTE_HOTKEY if hotkey != DEFAULT_MUTE_HOTKEY else DEFAULT_HOTKEY

    widgets_raw = raw.get("widgets") if isinstance(raw.get("widgets"), dict) else {}
    return {
        "enabled": raw.get("enabled") is True,
        "hotkey": hotkey,
        "mute_hotkey": mute_hotkey,
        "opacity": _clamp(raw.get("opacity", CONFIG_DEFAULTS["opacity"]), 0.2, 1.0, CONFIG_DEFAULTS["opacity"]),
        "scale": _clamp(raw.get("scale", CONFIG_DEFAULTS["scale"]), 0.6, 2.0, CONFIG_DEFAULTS["scale"]),
        "hide_when_unfocused": raw.get("hide_when_unfocused", True) is not False,
        "notifications_in_overlay": raw.get("notifications_in_overlay", True) is not False,
        "notification_seconds": int(_clamp(raw.get("notification_seconds", 12), 3, 60, 12)),
        # Unknown ids in the file are dropped; widgets added by a later version
        # appear with their shipped defaults. Both matter for forward/backward
        # compatibility across the beta releases this feature ships in.
        "widgets": {wid: _normalize_widget(wid, widgets_raw.get(wid)) for wid in WIDGET_DEFAULTS},
    }


def load_config():
    try:
        path = _config_path()
        if path.exists():
            return normalize_config(json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        pass
    return normalize_config({})


def save_config(config):
    normalized = normalize_config(config)
    try:
        path = _config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
    except Exception:
        pass
    return normalized


# --- snapshot data ----------------------------------------------------------


def _ts(dt):
    return int(dt.timestamp())


def _load_data_file(name):
    path = os.path.join(os.getcwd(), "web", "assets", "data", name)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def _next_daily_reset(now_utc):
    """Trove's day rolls at 11:00 UTC (the server-time offset)."""
    reset = now_utc.replace(hour=11, minute=0, second=0, microsecond=0)
    if reset <= now_utc:
        reset += timedelta(days=1)
    return reset


def _next_weekly_reset(now_utc):
    """Weekly bonuses roll at the first 11:00 UTC on or after Monday."""
    server_now = now_utc - _TROVE_OFFSET
    days_ahead = (7 - server_now.weekday()) % 7 or 7
    monday = (server_now + timedelta(days=days_ahead)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return monday + _TROVE_OFFSET


def _buff_payload(buff, extra_keys):
    if not isinstance(buff, dict):
        return None
    payload = {
        "name": buff.get("name"),
        "color": buff.get("color"),
        "emoji": buff.get("emoji"),
        "weekday": buff.get("weekday"),
    }
    for key in extra_keys:
        payload[key] = buff.get(key) or []
    return payload


def _merchants(st):
    corr_active = st.is_dragon(st.first_corruxion)
    flux_active = st.is_fluxion()
    inv_active = st.is_invasion()
    now = st.now

    def until(delta):
        return _ts(datetime.now(UTC) + delta)

    return {
        "corruxion": {
            "active": corr_active,
            "until": until(st.until_end_dragon(st.first_corruxion) if corr_active
                           else st.until_next_dragon(st.first_corruxion)),
        },
        "fluxion": {
            "active": flux_active,
            "state": "voting" if st.is_fluxion_voting() else ("selling" if st.is_fluxion_selling() else "away"),
            "until": until(st.until_end_fluxion() if flux_active else st.until_next_fluxion()),
        },
        "invasion": {
            "active": inv_active,
            "until": until(st.until_end_invasion() if inv_active else st.until_next_invasion()),
        },
    }


def _gardening(st, now_utc):
    base = st.first_gardening + _TROVE_OFFSET
    out = {}
    for key, span in (("two_day", 2), ("three_day", 3)):
        cycles = int((now_utc - base).total_seconds() // (span * 24 * 3600))
        cycle_start = base + timedelta(days=cycles * span)
        start = cycle_start + timedelta(days=span - 1)
        end = cycle_start + timedelta(days=span)
        out[key] = {
            "active": start <= now_utc < end,
            "start": _ts(start),
            "end": _ts(end),
        }
    return out


# Biome rotation tables, kept in step with backend/home.py. Duplicated rather
# than imported because importing home.py drags in its module-level Kiwi session
# and greenlet machinery for three lists.
_MANA_BIOMES = [
    "Neon City", "Jurassic Jungle", "Dragonfire Peaks", "Forbidden Spires",
    "Sundered Uplands", "Medieval Highlands", "Permafrost", "Cursed Vale",
    "Desert Frontier", "Fae Forest", "Candoria",
]
_STAMPY_BIOMES = [
    "Desert Frontier", "The Lost Isles", "Geode Topside", "Neon City",
    "Dragonfire Peaks", "Permafrost", "Candoria", "Cursed Vale",
    "Forbidden Spires", "Fae Forest", "Medieval Highlands", "Jurassic Jungle",
    "Sundered Uplands",
]
_MANA_EPOCH = datetime(2023, 11, 20, 11, 0, 0, tzinfo=UTC)
_STAMPY_EPOCH = datetime(2023, 9, 30, 11, 0, 0, tzinfo=UTC)
_WEEK = timedelta(weeks=1)


def _rotations(now_utc):
    mana_week = int((now_utc - _MANA_EPOCH).total_seconds() // _WEEK.total_seconds())
    mana_start = _MANA_EPOCH + mana_week * _WEEK
    wild_mana = {
        "biomes": [_MANA_BIOMES[(mana_week - offset) % len(_MANA_BIOMES)] for offset in (0, 1, 2)],
        "start": _ts(mana_start),
        "end": _ts(mana_start + _WEEK),
    }

    stampy_week = int((now_utc - _STAMPY_EPOCH).total_seconds() // _WEEK.total_seconds())
    stampy_start = _STAMPY_EPOCH + stampy_week * _WEEK
    stampy_end = stampy_start + timedelta(hours=48)
    if stampy_end <= now_utc:  # this week's visit is over; point at the next one
        stampy_week += 1
        stampy_start = _STAMPY_EPOCH + stampy_week * _WEEK
        stampy_end = stampy_start + timedelta(hours=48)
    stampy = {
        "biome": _STAMPY_BIOMES[stampy_week % len(_STAMPY_BIOMES)],
        "active": stampy_start <= now_utc < stampy_end,
        "start": _ts(stampy_start),
        "end": _ts(stampy_end),
    }
    return {"wild_mana": wild_mana, "stampy": stampy}


def _delve(now_utc):
    """Delve week id + window, matching backend/home.py's rotation base."""
    base = datetime(2025, 11, 3, tzinfo=UTC)
    server_now = now_utc - _TROVE_OFFSET
    week_id = max(1, int((server_now - base).total_seconds() // (7 * 24 * 3600)) + 1)
    start = base + timedelta(weeks=week_id - 1) + _TROVE_OFFSET
    return {"week_id": week_id, "start": _ts(start), "end": _ts(start + _WEEK)}


# Network-backed extras. Cached with a TTL and refreshed off the request path so
# a slow or absent network never delays a snapshot -- offline just means these
# two keys stay None/empty, and their widgets say so.
_network_cache = {"fetched_at": 0.0, "chaos": None, "events": []}
_network_lock = threading.Lock()


def _refresh_network_cache():
    from backend.home import KIWI_API_BASE  # local import: avoids a startup cycle

    import requests

    headers = {"User-Agent": "BetterTroveTools/1.0"}
    chaos = None
    events = []
    try:
        response = requests.get(f"{KIWI_API_BASE}/rotations/chaos-chest", headers=headers, timeout=6)
        if response.ok:
            payload = response.json()
            item = payload.get("item") if isinstance(payload, dict) else None
            if isinstance(item, dict) and item.get("name"):
                chaos = {
                    "name": item.get("name"),
                    "start": payload.get("starts_at"),
                    "end": payload.get("ends_at"),
                }
    except Exception:
        pass

    try:
        response = requests.get(f"{KIWI_API_BASE}/feeds/events", headers=headers, timeout=6)
        if response.ok:
            payload = response.json()
            items = payload.get("items", []) if isinstance(payload, dict) else (payload or [])
            now_ts = time.time()
            for item in items:
                if not isinstance(item, dict):
                    continue
                start = item.get("starts_at")
                end = item.get("ends_at")
                try:
                    start, end = int(start), int(end)
                except (TypeError, ValueError):
                    continue
                if end <= now_ts:
                    continue
                events.append({
                    "name": item.get("name") or item.get("title") or "Event",
                    "start": start,
                    "end": end,
                    "ongoing": start <= now_ts < end,
                })
            events.sort(key=lambda e: (not e["ongoing"], e["start"]))
            events = events[:6]
    except Exception:
        pass

    with _network_lock:
        _network_cache.update({"fetched_at": time.time(), "chaos": chaos, "events": events})


_network_refreshing = threading.Event()


def warm_network_cache():
    """Kick off a refresh off the request path, at most one at a time.

    Called when the overlay is enabled and again when its page mounts, so the
    chaos-chest and events widgets have data on their FIRST paint. Without this
    the first snapshot is always served from an empty cache and those two
    widgets read "needs network" for a minute before quietly filling in --
    which looks like a broken widget, not a pending fetch.
    """
    if _network_refreshing.is_set():
        return

    def run():
        _network_refreshing.set()
        try:
            _refresh_network_cache()
        finally:
            _network_refreshing.clear()

    threading.Thread(target=run, name="overlay-net", daemon=True).start()


def _network_section():
    with _network_lock:
        stale = (time.time() - _network_cache["fetched_at"]) > _NETWORK_TTL_SECONDS
        snapshot = {"chaos": _network_cache["chaos"], "events": list(_network_cache["events"])}
    if stale:
        warm_network_cache()
    return snapshot


def build_snapshot():
    """Everything the overlay page renders, as absolute unix timestamps."""
    now_utc = datetime.now(UTC)
    st = ServerTime()

    daily = _buff_payload(st.current_daily_buffs, ("normal_buffs", "premium_buffs"))
    weekly = _buff_payload(st.current_weekly_buffs, ("buffs",))
    network = _network_section()

    return {
        "now": _ts(now_utc),
        # The page renders Trove time as (local UTC now + this offset), so the
        # clock keeps ticking between snapshots with no further backend calls.
        "server_offset_seconds": int(-_TROVE_OFFSET.total_seconds()),
        "daily": dict(daily or {}, reset_at=_ts(_next_daily_reset(now_utc))),
        "weekly": dict(weekly or {}, reset_at=_ts(_next_weekly_reset(now_utc))),
        "merchants": _merchants(st),
        "gardening": _gardening(st, now_utc),
        "rotations": _rotations(now_utc),
        "delve": _delve(now_utc),
        "chaos": network["chaos"],
        "events": network["events"],
    }


# --- window tracker ---------------------------------------------------------


class OverlayHost:
    """What ``main.py`` must provide for the tracker to drive a real window.

    Kept as a duck-typed contract instead of an import so this module stays
    importable (and unit-testable) with no GUI toolkit present -- the Linux build
    imports it and simply never registers a host.
    """

    def ensure_window(self):
        """Create the overlay window if needed; return its HWND or None."""
        raise NotImplementedError

    def show(self):
        raise NotImplementedError

    def hide(self):
        raise NotImplementedError

    def destroy(self):
        raise NotImplementedError


class OverlayTracker:
    """Follows Trove's window and keeps the overlay glued to it.

    The state machine is deliberately small: every tick asks "should the overlay
    be visible right now?", and visibility is a pure function of the game's
    window state. There is no path that leaves the overlay on screen after Trove
    goes away, including a crash -- a dead handle reads as "not running".
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._host = None
        self._thread = None
        self._stop = threading.Event()
        self._config = load_config()
        self._hwnd = None            # cached Trove handle
        self._overlay_hwnd = None
        self._visible = False
        self._interactive = False    # hotkey-toggled click-through off
        # Session mute: the "get it off my screen" hotkey. Deliberately NOT
        # persisted -- a muted overlay that survives a restart just looks broken.
        # It does survive Trove restarting within one app run, because "it's in
        # my way" usually means for the rest of the play session.
        self._muted = False
        self._page_ready = False
        self._notification_seq = 0
        self._last_rect = None
        self._status = {"running": False, "visible": False, "fullscreen_risk": False,
                        "interactive": False, "muted": False, "hotkeys": {},
                        "supported": SUPPORTED}
        self._hotkey = win_overlay.HotkeyListener(self._on_hotkey)

    # -- wiring ----------------------------------------------------------
    def set_host(self, host):
        with self._lock:
            self._host = host

    @property
    def config(self):
        with self._lock:
            return dict(self._config)

    def status(self):
        with self._lock:
            return dict(self._status)

    def is_showing(self):
        with self._lock:
            return self._visible

    # -- lifecycle -------------------------------------------------------
    def apply_config(self, config):
        """Reconcile to a new config: start/stop tracking, rebind the hotkeys."""
        with self._lock:
            self._config = normalize_config(config)
            enabled = self._config["enabled"] and SUPPORTED
            hotkeys = {"interact": self._config["hotkey"], "mute": self._config["mute_hotkey"]}

        if enabled:
            results = self._hotkey.bind_all(hotkeys)
            with self._lock:
                self._status["hotkeys"] = results
            self._start()
            # Pull the network-backed widgets' data now, so they have something
            # to show the moment the overlay first appears over the game.
            warm_network_cache()
        else:
            self._hotkey.stop()
            with self._lock:
                self._status["hotkeys"] = {}
            self._stop_tracking()

        self.push_config()
        return self.config

    def adopt_config(self, config):
        """Take a new config without touching the hotkeys or the tracker thread.

        The drag path uses this: a widget moving on screen changes nothing about
        registration or tracking, and re-running ``apply_config`` for it would
        unregister and re-register both global hotkeys on every pointer release.
        """
        with self._lock:
            self._config = normalize_config(config)
        self.push_config()
        return self.config

    def _start(self):
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="overlay-tracker", daemon=True)
            self._thread.start()

    def _stop_tracking(self):
        self._stop.set()
        self._set_visible(False)

    def shutdown(self):
        self._hotkey.stop()
        self._stop.set()
        host = None
        with self._lock:
            host = self._host
            self._visible = False
        if host:
            try:
                host.destroy()
            except Exception:
                pass

    # -- hotkeys ---------------------------------------------------------
    def _on_hotkey(self, action):
        if action == "mute":
            # Works whether or not the overlay is currently drawn: the whole
            # point is a panic key, and pre-muting before a raid is legitimate.
            self.set_muted(not self._muted)
            return
        if action == "interact":
            # Only meaningful while the overlay is actually up. Otherwise it
            # would silently arm interactive mode for the next time Trove
            # launches, which is a surprise nobody asked for.
            if self.is_showing():
                self.set_interactive(not self._interactive)

    def set_muted(self, muted):
        """Hide/show the overlay without touching the persisted config."""
        with self._lock:
            self._muted = bool(muted)
            self._status["muted"] = self._muted
        if self._muted:
            self._set_visible(False)
        _push_js("overlay_set_muted", bool(muted))
        return bool(muted)

    def is_muted(self):
        with self._lock:
            return self._muted

    def set_interactive(self, interactive):
        with self._lock:
            self._interactive = bool(interactive)
            self._status["interactive"] = self._interactive
            overlay_hwnd = self._overlay_hwnd
        if overlay_hwnd:
            win_overlay.set_click_through(overlay_hwnd, not interactive)
        _push_js("overlay_set_interactive", bool(interactive))
        return bool(interactive)

    # -- the loop --------------------------------------------------------
    def _run(self):
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                # A tracker that dies leaves an orphaned overlay pinned over the
                # game with no way to dismiss it, so every tick is contained.
                pass
            self._stop.wait(_POLL_SECONDS)

    def _tick(self):
        with self._lock:
            config = dict(self._config)
            muted = self._muted
        if not config["enabled"]:
            self._set_visible(False)
            return

        info = trove_window.describe(self._hwnd)
        self._hwnd = info["hwnd"]

        with self._lock:
            self._status["running"] = info["running"]
            self._status["fullscreen_risk"] = info["fullscreen_risk"]

        should_show = bool(
            not muted
            and info["running"]
            and info["rect"]
            and not info["minimized"]
            and (info["foreground"] or not config["hide_when_unfocused"])
        )

        if not should_show:
            self._set_visible(False)
            return

        self._set_visible(True, rect=info["rect"])

    def _set_visible(self, visible, rect=None):
        with self._lock:
            host = self._host
            was_visible = self._visible

        if not visible:
            if was_visible and host:
                try:
                    host.hide()
                except Exception:
                    pass
            with self._lock:
                self._visible = False
                self._status["visible"] = False
                self._last_rect = None
                # Interactive mode is per-session: coming back to a click-eating
                # overlay you forgot you armed is the worst possible surprise
                # mid-fight.
                if self._interactive:
                    self._interactive = False
                    self._status["interactive"] = False
            return

        if not host:
            return

        overlay_hwnd = None
        try:
            overlay_hwnd = host.ensure_window()
        except Exception:
            return
        if not overlay_hwnd:
            return

        first_show = not was_visible
        with self._lock:
            new_hwnd = overlay_hwnd != self._overlay_hwnd
            self._overlay_hwnd = overlay_hwnd
            interactive = self._interactive
            last_rect = self._last_rect

        if first_show or new_hwnd:
            win_overlay.apply_overlay_style(overlay_hwnd, click_through=not interactive)

        if rect and rect != last_rect:
            win_overlay.place(overlay_hwnd, *rect)
            with self._lock:
                self._last_rect = rect
            _push_js("overlay_set_viewport", {"width": rect[2], "height": rect[3]})
        else:
            # Cheap re-assert: another topmost window (Discord, a Steam popup)
            # can push us down the z-order without changing our geometry.
            win_overlay.raise_topmost(overlay_hwnd)

        if first_show:
            try:
                host.show()
            except Exception:
                return
            with self._lock:
                self._visible = True
                self._status["visible"] = True
            self.push_config()

    # -- pushes to the overlay page --------------------------------------
    def page_ready(self):
        """The overlay page has mounted and can receive pushes."""
        with self._lock:
            self._page_ready = True
        warm_network_cache()
        self.push_config()

    def push_config(self):
        _push_js("overlay_apply_config", {"config": self.config, "status": self.status()})

    def notify(self, title, message):
        """Deliver a notification into the overlay. True if it was routed there.

        False means "not handled" and the caller (the shared DesktopNotifier)
        falls back to the tray balloon, so a disabled, muted, or not-yet-mounted
        overlay never silently eats a notification -- it goes to the tray as it
        always did.
        """
        with self._lock:
            routed = (
                self._visible
                and self._page_ready
                and not self._muted
                and self._config["notifications_in_overlay"]
            )
            seconds = self._config["notification_seconds"]
        if not routed:
            return False
        self._notification_seq += 1
        return _push_js("overlay_notification", {
            "title": str(title or ""),
            "message": str(message or ""),
            "seconds": seconds,
            "id": f"n{self._notification_seq}",
        })


def _push_js(name, payload):
    """Call an eel-exposed JS function, swallowing the "no page yet" case.

    eel broadcasts to every connected page and the client ignores names it
    hasn't exposed, so only the overlay page reacts to these -- the main window
    never sees them.
    """
    try:
        getattr(eel, name)(payload)
        return True
    except Exception:
        return False


tracker = OverlayTracker()


def start_from_settings():
    """Re-arm the overlay on app launch if the user left it enabled."""
    if not SUPPORTED:
        return
    config = load_config()
    if config["enabled"]:
        tracker.apply_config(config)


def shutdown():
    tracker.shutdown()


# --- eel surface ------------------------------------------------------------
#
# Every endpoint answers on non-Windows too, reporting supported=False, so the
# frontend can decide once and hide the whole feature instead of each call
# failing in its own way.


def _state_payload():
    return {
        "config": tracker.config,
        "status": tracker.status(),
        "supported": SUPPORTED,
    }


@eel.expose
@standardize_response
def overlay_get_config():
    """Config + catalog + live status, in one call for the editor's first paint."""
    data = dict(_state_payload(), catalog=[
        {"id": wid, "default_enabled": meta["on"]} for wid, meta in WIDGET_DEFAULTS.items()
    ], anchors=list(VALID_ANCHORS), defaults={
        "hotkey": DEFAULT_HOTKEY, "mute_hotkey": DEFAULT_MUTE_HOTKEY,
    })
    return resp(True, data=data, **data)


@eel.expose
@standardize_response
def overlay_save_config(config):
    """Persist and immediately apply a config from the editor."""
    if not SUPPORTED:
        return resp(False, error="The overlay is Windows-only.", code="OVERLAY_UNSUPPORTED")
    save_config(config)
    tracker.apply_config(load_config())
    data = _state_payload()
    return resp(True, data=data, **data)


@eel.expose
@standardize_response
def overlay_set_enabled(enabled):
    config = tracker.config
    config["enabled"] = bool(enabled)
    return overlay_save_config(config)


@eel.expose
@standardize_response
def overlay_status():
    data = _state_payload()
    return resp(True, data=data, **data)


@eel.expose
@standardize_response
def overlay_get_snapshot():
    data = build_snapshot()
    return resp(True, data=data, **data)


@eel.expose
@standardize_response
def overlay_page_ready():
    """The overlay page announces itself once mounted."""
    tracker.page_ready()
    return resp(True, data=_state_payload(), **_state_payload())


@eel.expose
@standardize_response
def overlay_set_interactive(interactive):
    """Called by the overlay page's own lock affordance and by the editor."""
    value = tracker.set_interactive(bool(interactive))
    return resp(True, data={"interactive": value}, interactive=value)


@eel.expose
@standardize_response
def overlay_set_muted(muted):
    """The hotkey's counterpart for people who'd rather click a button."""
    value = tracker.set_muted(bool(muted))
    return resp(True, data={"muted": value}, muted=value)


@eel.expose
@standardize_response
def overlay_move_widget(widget_id, anchor, x, y):
    """Persist one widget's position -- the drag handler's write path.

    Separate from ``overlay_save_config`` so a drag writes one widget instead of
    rewriting (and re-applying) the entire config, which would rebind the
    hotkeys on every pointer release.
    """
    if widget_id not in WIDGET_DEFAULTS:
        return resp(False, error="Unknown widget", code="OVERLAY_UNKNOWN_WIDGET")
    config = tracker.config
    widget = dict(config["widgets"].get(widget_id, {}))
    widget.update({"anchor": anchor, "x": x, "y": y})
    config["widgets"][widget_id] = widget
    saved = tracker.adopt_config(save_config(config))
    return resp(True, data={"config": saved}, config=saved)
