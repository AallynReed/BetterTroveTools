"""In-game overlay: config, live data snapshot, and the window tracker.

The overlay is a frameless, per-pixel-transparent, always-on-top native window
that draws Trove reference data (server clock, daily/weekly bonuses, merchant
timers, rotations, ongoing events) directly over the running game. It is
strictly read-only with respect to Trove: it follows the game window's public
geometry and never reads, writes, hooks, or injects anything into the game.

**It only ever appears over Trove.** The tracker below shows the window when a
Trove process owns a visible foreground window and hides it the instant that
stops being true -- game closed, minimized, or alt-tabbed away from. There is no
mode in which the overlay floats over the desktop or another application.

Four pieces:

  * **Config** (``overlay.json`` in the cache root) -- master switch, hotkeys,
    opacity/scale, and per-widget enabled/anchor/position. Kept out of
    ``settings.json`` because the widget map is bulky and changes on every drag
    in the editor, and settings.json is rewritten wholesale on every save.
  * **Snapshot** -- the values the widgets render, as absolute unix timestamps.
    Built offline from ``ServerTime`` plus the bundled buff/biome JSON; the two
    network-backed bits (chaos chest item, Trovesaurus events) are fetched on a
    slow background refresh and degrade to nothing when offline. Re-read only
    every few minutes -- countdowns are recomputed from the timestamps, so the
    display stays second-accurate without touching the data.
  * **Tracker** -- a daemon thread polling the game window and driving
    show/hide/place/repaint.
  * **Rendering** -- ``backend/overlay_view`` turns the snapshot into localized
    widget lines and ``utils/overlay_draw`` paints them. This was a WebView2
    window until it proved impossible to make transparent; the reasoning and the
    measurements are recorded in ``utils/overlay_draw``'s docstring.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import UTC, datetime, timedelta

import eel

from backend import overlay_view
from backend.response import resp, standardize_response
from utils.path import get_cache_root
from utils.trove.server_time import ServerTime
from utils import overlay_draw, overlay_window, trove_window, win_overlay

# Windows-only, and desktop-only. Every mechanism the overlay is built on is a
# Win32 one: enumerating the game's top-level window, a layered window with
# per-pixel alpha, RegisterHotKey, and GDI+ drawing. There is no equivalent path
# that works across X11, Wayland and the compositors in between, so rather than
# ship something half-working on Linux the whole feature reports unsupported
# there and the UI hides it. Android never sees it either -- there is no eel
# bridge in web mode, so the tab simply isn't offered.
SUPPORTED = trove_window._IS_WINDOWS and overlay_draw.available()

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
# Offsets are fractions but widget heights are in pixels, so the default layout
# is spaced for the smallest window anyone plays in (1280x720). At larger
# resolutions the gaps simply widen -- which is the right way round.
#
# The defaults also dodge Trove's own HUD, which is what makes an overlay look
# broken out of the box: the player frame sits top-left, currencies/buffs and
# the challenge tracker top-right, the hotbar bottom-centre and chat
# bottom-left. That leaves the mid-left column and the bottom-right corner, and
# that is where the shipped widgets go.
WIDGET_DEFAULTS = {
    "clock":         {"on": True,  "anchor": "bottom-right", "x": 0.012, "y": 0.050},
    "daily_buff":    {"on": True,  "anchor": "top-left",     "x": 0.012, "y": 0.130},
    "weekly_buff":   {"on": True,  "anchor": "top-left",     "x": 0.012, "y": 0.350},
    "notifications": {"on": True,  "anchor": "bottom-right", "x": 0.012, "y": 0.220},
    "merchants":     {"on": False, "anchor": "top-left",     "x": 0.012, "y": 0.500},
    "chaos_chest":   {"on": False, "anchor": "bottom-right", "x": 0.012, "y": 0.400},
    "gardening":     {"on": False, "anchor": "top-left",     "x": 0.012, "y": 0.650},
    "rotations":     {"on": False, "anchor": "bottom-right", "x": 0.012, "y": 0.520},
    "delve":         {"on": False, "anchor": "bottom-right", "x": 0.012, "y": 0.700},
    "events":        {"on": False, "anchor": "top-right",    "x": 0.012, "y": 0.400},
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
    # Panel fill only -- text stays fully opaque, so this is genuinely "how much
    # of the game shows through the boxes". Defaults deliberately light: an
    # overlay you have to look past is worse than one you have to look at.
    "opacity": 0.55,
    "scale": 1.0,
    # Hide while the player is in another window. Off means the overlay stays up
    # over a non-foreground Trove -- still only over Trove, never over anything
    # else, because a non-running game hides it regardless.
    "hide_when_unfocused": True,
    # Hide while a game UI panel is open. Detected from cursor confinement:
    # Trove clips the cursor to a 1x1 box while it owns the camera and releases
    # it for inventory, the store, the map and chat -- so a free cursor means
    # the player is reading something the overlay would be sitting on top of.
    "hide_in_menus": True,
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
# Consecutive unfocused polls before the overlay hides. Foreground ownership
# blips for a frame during alt-tab and when the game spawns a child window; at
# 400ms a tick, three ticks is ~1.2s of genuinely being elsewhere.
_HIDE_GRACE_TICKS = 3
# The menu check rides its own, much faster poll. Reading the cursor clip is
# ~3us (one GetClipCursor), where a full window poll costs a process scan
# whenever the game handle is stale -- so the cheap signal has no reason to
# wait for the expensive one. Opening a panel now hides the overlay in about a
# tenth of a second instead of on the next 400ms tick.
_MENU_POLL_SECONDS = 0.05
# How long the cursor must stay free before it counts as "a menu is open".
# Panels animate open, briefly flashing the cursor; this rides out that flash
# while staying below what reads as a delay.
_MENU_GRACE_SECONDS = 0.1
# Repaint cadence. The only thing that changes every second is a countdown, so
# 1Hz is the ceiling on what is worth drawing over a game.
_RENDER_SECONDS = 1.0
# How often the underlying data is rebuilt. Rotations roll over on the scale of
# hours; the countdowns come from absolute timestamps in between.
_SNAPSHOT_SECONDS = 120.0
# Network-backed snapshot bits refresh far slower than the local math.
_NETWORK_TTL_SECONDS = 15 * 60

_TROVE_OFFSET = timedelta(hours=11)

# "no cursor reading passed in" -- distinct from None, which is a real reading
# meaning "the clip couldn't be read".
_UNSET = object()


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
    # Optional per-widget hotkey. "" means unbound, which is the default -- a
    # shipped binding for ten widgets would carpet the keyboard.
    hotkey = raw.get("hotkey") or ""
    if hotkey and not win_overlay.parse_hotkey(hotkey):
        hotkey = ""
    return {
        "enabled": bool(raw.get("enabled", base["on"])),
        "hotkey": hotkey,
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
        # 0 is allowed and useful: the panel disappears entirely and the text
        # floats on the game, which some players prefer. Text never fades.
        "opacity": _clamp(raw.get("opacity", CONFIG_DEFAULTS["opacity"]), 0.0, 1.0, CONFIG_DEFAULTS["opacity"]),
        "scale": _clamp(raw.get("scale", CONFIG_DEFAULTS["scale"]), 0.6, 2.0, CONFIG_DEFAULTS["scale"]),
        "hide_when_unfocused": raw.get("hide_when_unfocused", True) is not False,
        "hide_in_menus": raw.get("hide_in_menus", True) is not False,
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


def _hotkey_map(config):
    """``{action: spec}`` for every binding, with duplicates dropped.

    Two actions on one combination means the second ``RegisterHotKey`` silently
    loses, and the user gets a key that looks bound in the editor and does
    nothing. Dropping the later one instead makes the clash visible: the editor
    reads the per-action result and can say which binding didn't take.
    """
    mapping = {}
    seen = set()

    def add(action, spec):
        if not spec:
            return
        key = str(spec).lower().replace(" ", "")
        if key in seen:
            return
        seen.add(key)
        mapping[action] = spec

    add("interact", config.get("hotkey"))
    add("mute", config.get("mute_hotkey"))
    for widget_id, widget in (config.get("widgets") or {}).items():
        add(f"widget:{widget_id}", (widget or {}).get("hotkey"))
    return mapping


class OverlayTracker:
    """Follows Trove's window and keeps the native overlay glued to it.

    The state machine is deliberately small: every tick asks "should the overlay
    be visible right now?", and visibility is a pure function of the game's
    window state. There is no path that leaves the overlay on screen after Trove
    goes away, including a crash -- a dead handle reads as "not running".
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._thread = None
        self._stop = threading.Event()
        self._config = load_config()
        self._hwnd = None            # cached Trove handle
        self._window = None          # utils.overlay_window.OverlayWindow
        self._visible = False
        self._interactive = False    # hotkey-toggled: overlay accepts clicks
        # Session mute: the "get it off my screen" hotkey. Deliberately NOT
        # persisted -- a muted overlay that survives a restart just looks broken.
        # It does survive Trove restarting within one app run, because "it's in
        # my way" usually means for the rest of the play session.
        self._muted = False
        self._unfocused_ticks = 0
        self._menu_since = None      # monotonic ts the cursor came free, or None
        self._in_menu = False
        self._last_rect = None
        self._last_render = 0.0
        self._snapshot = {}
        self._snapshot_at = 0.0
        self._notifications = []     # [{title, message, expires}]
        self._status = {"running": False, "visible": False, "fullscreen_risk": False,
                        "interactive": False, "muted": False, "hotkeys": {},
                        "in_menu": False,
                        "supported": SUPPORTED}
        self._hotkey = win_overlay.HotkeyListener(self._on_hotkey)

    # -- wiring ----------------------------------------------------------
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
            hotkeys = _hotkey_map(self._config)

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

        self._request_render()
        return self.config

    def adopt_config(self, config):
        """Take a new config without touching the hotkeys or the tracker thread.

        The drag path uses this: a widget moving on screen changes nothing about
        registration or tracking, and re-running ``apply_config`` for it would
        unregister and re-register both global hotkeys on every pointer release.
        """
        with self._lock:
            self._config = normalize_config(config)
        self._request_render()
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
        with self._lock:
            window = self._window
            self._window = None
            self._visible = False
        if window:
            try:
                window.stop()
            except Exception:
                pass

    def _ensure_window(self):
        with self._lock:
            window = self._window
        if window is not None:
            return window
        if not (SUPPORTED and overlay_draw.available()):
            return None
        window = overlay_window.OverlayWindow(on_move=self._on_widget_moved)
        if not window.start():
            return None
        with self._lock:
            self._window = window
        return window

    # -- hotkeys ---------------------------------------------------------
    def _on_hotkey(self, action):
        if action.startswith("widget:"):
            self.toggle_widget(action.split(":", 1)[1])
            return
        if action == "mute":
            # Works whether or not the overlay is currently drawn: the whole
            # point is a panic key, and pre-muting before a raid is legitimate.
            self.set_muted(not self._muted)
            return
        if action == "interact":
            # Deliberately NOT gated on the overlay being visible. Unlocking is
            # also the "force it on" key: it overrides the menu auto-hide, so a
            # player who wants to actually *use* an overlay widget while a game
            # panel is open can summon it. Gating on visibility would make the
            # key do nothing in exactly that case. It still requires Trove to be
            # running, so it can never arm itself against an empty desktop.
            with self._lock:
                running = self._status["running"]
            if running:
                self.set_interactive(not self._interactive)

    def toggle_widget(self, widget_id):
        """Flip one widget on or off from its own hotkey.

        This writes the persisted `enabled` flag rather than a session override,
        so the key does the same thing as the checkbox in the editor and the two
        never disagree about what is on.
        """
        if widget_id not in WIDGET_DEFAULTS:
            return None
        config = self.config
        widget = dict(config["widgets"].get(widget_id, {}))
        widget["enabled"] = not widget.get("enabled")
        config["widgets"][widget_id] = widget
        # adopt_config, not apply_config: flipping a widget must not tear down
        # and re-register every global hotkey (including the one just pressed).
        self.adopt_config(save_config(config))
        self._render(force=True)
        return widget["enabled"]

    def set_muted(self, muted):
        """Hide/show the overlay without touching the persisted config."""
        with self._lock:
            self._muted = bool(muted)
            self._status["muted"] = self._muted
        if self._muted:
            self._set_visible(False)
        return bool(muted)

    def is_muted(self):
        with self._lock:
            return self._muted

    def set_interactive(self, interactive):
        with self._lock:
            self._interactive = bool(interactive)
            self._status["interactive"] = self._interactive
            window = self._window
        if window:
            window.set_interactive(bool(interactive))
        self._request_render()
        return bool(interactive)

    def _on_widget_moved(self, widget_id, anchor, x, y):
        """A widget was dragged in game -- persist it like the editor would."""
        if widget_id not in WIDGET_DEFAULTS:
            return
        config = self.config
        widget = dict(config["widgets"].get(widget_id, {}))
        widget.update({"anchor": anchor, "x": x, "y": y})
        config["widgets"][widget_id] = widget
        self.adopt_config(save_config(config))

    # -- the loop --------------------------------------------------------
    def _run(self):
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                # A tracker that dies leaves an orphaned overlay pinned over the
                # game with no way to dismiss it, so every tick is contained.
                pass
            self._wait_poll()

    def _wait_poll(self):
        """Sleep out the poll interval, watching the cursor at a finer grain.

        Returns early the moment the menu verdict flips, so the next full tick
        acts on it right away. Without this the overlay only learns a panel
        opened on the next 400ms window poll -- and because coming back is
        immediate, that asymmetry is exactly what reads as "slow to hide, quick
        to show".
        """
        deadline = time.monotonic() + _POLL_SECONDS
        while not self._stop.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            if self._stop.wait(min(_MENU_POLL_SECONDS, remaining)):
                return
            try:
                if self._menu_changed():
                    return
            except Exception:
                # Keep waiting out the interval rather than returning: a
                # persistent failure here would otherwise spin the loop.
                continue

    def _menu_changed(self):
        """True when the debounced menu verdict differs from the last tick's.

        Only touches the cheap signals: the config flags and the cursor clip.
        Anything that needs the window (geometry, focus) is left to _tick.
        """
        with self._lock:
            config = dict(self._config)
            visible = self._visible
            rect = self._last_rect
        if not config["enabled"] or not (visible or self._in_menu):
            return False
        before = self._in_menu   # _menu_open rewrites it, so snapshot first
        return self._menu_open(config, rect) != before

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

        focused = info["foreground"] or self._overlay_has_focus()

        in_menu = self._menu_open(config, info["rect"], info.get("mouse_captured"))

        with self._lock:
            self._status["in_menu"] = in_menu

        should_show = bool(
            not muted
            and not in_menu
            and info["running"]
            and info["rect"]
            and not info["minimized"]
            and (focused or not config["hide_when_unfocused"])
        )

        if not should_show:
            # Don't hide on the first unfocused tick. Foreground ownership blips
            # for a frame during alt-tab, when Trove opens its own child window,
            # and when a tooltip or IME appears -- hiding on each of those makes
            # the overlay strobe. Only a sustained loss of focus hides it.
            if self._visible and not focused and info["running"] and not info["minimized"]:
                self._unfocused_ticks += 1
                if self._unfocused_ticks < _HIDE_GRACE_TICKS:
                    return
            self._set_visible(False)
            return

        self._unfocused_ticks = 0
        self._set_visible(True, rect=info["rect"])

    def _menu_open(self, config, rect, captured=_UNSET):
        """Debounced "a game UI panel is open", read from cursor confinement.

        Hiding waits out _MENU_GRACE_SECONDS of continuously-free cursor so a
        single frame of release (which happens as panels animate) doesn't blink
        the overlay. Coming back is immediate, because the player closing a menu
        wants the data back at once.

        Never applies while the overlay is unlocked. That is what makes the
        interact hotkey a "force on" key: the player has said they want to use
        the overlay, and the cursor being free is the precondition for that, not
        a reason to take it away.

        Caches its verdict in ``_in_menu`` so the fast cursor poll between ticks
        can tell a genuine change from a repeat reading.
        """
        with self._lock:
            interactive = self._interactive
        if captured is _UNSET:
            captured = trove_window.mouse_captured(rect)

        # mouse_captured is None when the state can't be read; only a definite
        # False (the game released the cursor) counts as "a menu is open".
        if not config["hide_in_menus"] or interactive or captured is not False:
            self._menu_since = None
            self._in_menu = False
            return False

        now = time.monotonic()
        if self._menu_since is None:
            self._menu_since = now
        self._in_menu = (now - self._menu_since) >= _MENU_GRACE_SECONDS
        return self._in_menu

    def _overlay_has_focus(self):
        """True when the foreground window IS our overlay.

        Without this the overlay hides itself the instant you click it in
        interactive mode: the click moves foreground off Trove, the next tick
        reads "game not focused", and the thing you were dragging vanishes.
        """
        with self._lock:
            window = self._window
        if not window or not window.hwnd:
            return False
        return win_overlay.foreground_hwnd() == window.hwnd

    def _set_visible(self, visible, rect=None):
        with self._lock:
            was_visible = self._visible
            window = self._window

        if not visible:
            if was_visible and window:
                try:
                    window.hide()
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

        window = self._ensure_window()
        if not window:
            return

        first_show = not was_visible
        with self._lock:
            last_rect = self._last_rect
            interactive = self._interactive

        if rect and rect != last_rect:
            window.place(*rect)
            with self._lock:
                self._last_rect = rect
            self._render(force=True)
        else:
            # Cheap re-assert: another topmost window (Discord, a Steam popup)
            # can push us down the z-order without changing our geometry.
            window.raise_topmost()
            self._render()

        if first_show:
            window.set_interactive(interactive)
            window.show()
            with self._lock:
                self._visible = True
                self._status["visible"] = True

    # -- rendering -------------------------------------------------------
    def _request_render(self):
        """Force the next tick to repaint (config or mode changed)."""
        with self._lock:
            self._last_render = 0.0

    def _render(self, force=False):
        now = time.time()
        with self._lock:
            window = self._window
            config = dict(self._config)
            if not force and (now - self._last_render) < _RENDER_SECONDS:
                return
            self._last_render = now
        if not window:
            return

        # Snapshot data changes on rotation boundaries, not every second; the
        # countdowns are recomputed locally from its absolute timestamps.
        with self._lock:
            stale = (now - self._snapshot_at) > _SNAPSHOT_SECONDS
        if stale:
            try:
                snapshot = build_snapshot()
            except Exception:
                snapshot = {}
            with self._lock:
                if snapshot:
                    self._snapshot = snapshot
                self._snapshot_at = now

        with self._lock:
            snapshot = dict(self._snapshot)
            self._notifications = [n for n in self._notifications if n["expires"] > now]
            notifications = list(self._notifications)

        try:
            widgets = overlay_view.build_widgets(
                config, snapshot, notifications, catalog_order=list(WIDGET_DEFAULTS))
        except Exception:
            return

        with self._lock:
            interactive = self._interactive
        if interactive:
            # Unlocked mode has no other affordance -- the HUD bar went away with
            # the web renderer -- so the accent border on every panel is the only
            # signal that clicks are now being caught instead of passed through.
            for widget in widgets:
                widget["highlight"] = True

        window.update(widgets,
                      scale=config["scale"],
                      opacity=config["opacity"],
                      accent=_accent_rgb())

    def notify(self, title, message):
        """Show a notification on the overlay. True if it was routed there.

        False means "not handled" and the caller (the shared DesktopNotifier)
        falls back to the tray balloon, so a disabled or muted overlay never
        silently eats a notification.
        """
        with self._lock:
            routed = (self._visible and not self._muted
                      and self._config["notifications_in_overlay"]
                      and self._config["widgets"].get("notifications", {}).get("enabled"))
            seconds = self._config["notification_seconds"]
            if routed:
                self._notifications.append({
                    "title": str(title or ""),
                    "message": str(message or ""),
                    "expires": time.time() + seconds,
                })
                # Keep the stack short; a burst of events must not cover the game.
                self._notifications = self._notifications[-3:]
        if routed:
            self._render(force=True)
        return bool(routed)


def _accent_rgb():
    """The user's accent, for the one place the overlay uses it."""
    try:
        settings = json.loads((get_cache_root() / "settings.json").read_text(encoding="utf-8"))
        parsed = overlay_draw.parse_hex(settings.get("accent_color"))
        if parsed:
            return parsed
    except Exception:
        pass
    return (94, 198, 255)


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
def overlay_set_interactive(interactive):
    """Toggle click-through from the editor (the hotkey does the same thing)."""
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
