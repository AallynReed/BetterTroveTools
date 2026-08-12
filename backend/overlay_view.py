"""Turn an overlay snapshot into drawable widgets, in the user's language.

The overlay is drawn natively (see ``utils/overlay_draw``), so it cannot use the
frontend i18n engine. This module is the Python-side equivalent: it reads the
same shipped locale files and resolves the same ids, so a string translated for
the app is automatically translated on the overlay.

Resolution mirrors ``web/js/i18n.js``: a token is looked up first as a symbolic
id in ``strings``, then as source text in ``content`` (which is how data-driven
names like "Gathering Day" get translated), and falls back to the English text
from ``_ui_ids.json`` and finally to the token itself.
"""
from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime

_LOCALE_DIR = ("web", "assets", "locale")

_cache = {"code": None, "strings": {}, "content": {}, "english": {}, "loaded_at": 0.0}
_CACHE_TTL = 30.0


def _locale_path(name):
    return os.path.join(os.getcwd(), *_LOCALE_DIR, name)


def _read_json(name):
    try:
        with open(_locale_path(name), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def _load(code):
    """Load (and cache) the catalogs for ``code``, with an English fallback."""
    now = time.time()
    if _cache["code"] == code and (now - _cache["loaded_at"]) < _CACHE_TTL:
        return

    english = _read_json("_ui_ids.json").get("en", {})
    data = _read_json(f"{code}.json") if code else {}
    if not data:
        data = _read_json("en_US.json")

    _cache.update({
        "code": code,
        "strings": data.get("strings", {}) or {},
        # Legacy-shape locale files keep everything under `keys`.
        "content": (data.get("content") or data.get("keys") or {}),
        "english": english,
        "loaded_at": now,
    })


def _current_locale():
    try:
        from utils.path import get_cache_root
        settings = json.loads((get_cache_root() / "settings.json").read_text(encoding="utf-8"))
        code = settings.get("locale")
        return code if isinstance(code, str) and code else "en_US"
    except Exception:
        return "en_US"


def translator():
    """Return a ``t(token)`` bound to the user's current language."""
    _load(_current_locale())
    strings, content, english = _cache["strings"], _cache["content"], _cache["english"]

    def t(token):
        if token is None:
            return ""
        token = str(token)
        value = strings.get(token)
        if value:
            return value if isinstance(value, str) else str(value)
        # Data-driven text (buff names, biome names) arrives as English source.
        value = content.get(token)
        if value:
            return value if isinstance(value, str) else str(value)
        return english.get(token, token)

    return t


# --- countdown formatting ---------------------------------------------------


def _fmt_until(target, now_ts, t):
    """Coarse countdown: days+hours, hours+minutes, then minutes+seconds."""
    if not target:
        return "--"
    secs = int(target - now_ts)
    if secs <= 0:
        return t("overlay.now")
    days, secs = divmod(secs, 86400)
    hours, secs = divmod(secs, 3600)
    mins, secs = divmod(secs, 60)
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {mins:02d}m"
    return f"{mins}m {secs:02d}s"


def _urgency(target, now_ts):
    if not target:
        return "muted"
    left = target - now_ts
    if left <= 0:
        return "live"
    return "soon" if left <= 30 * 60 else "muted"


# --- widget builders --------------------------------------------------------
#
# Each returns a list of "lines". A line is
#   {text, role, right, right_state, color, state, bar}
# where role picks the type token (eyebrow/label/body/title/hero) and `right` is
# a right-aligned countdown.


def _clock_lines(snap, t):
    offset = snap.get("server_offset_seconds", 0)
    now = datetime.fromtimestamp(time.time() + offset, UTC)
    return [
        {"text": t("overlay.w_clock").upper(), "role": "eyebrow"},
        {"text": now.strftime("%H:%M:%S"), "role": "hero"},
        {"text": now.strftime("%a, %b %d"), "role": "label"},
    ]


def _buff_lines(buff, buff_key, title_token, t, now_ts):
    lines = [{"text": t(title_token).upper(), "role": "eyebrow"}]
    if not buff or not buff.get("name"):
        lines.append({"text": t("overlay.no_data"), "role": "label"})
        return lines
    # No emoji: GDI+ has no colour-emoji path and draws them as tofu boxes. The
    # buff's own colour is already carried by the bar beside the title.
    lines.append({
        "text": t(buff["name"]),
        "role": "title",
        "bar": buff.get("color"),
    })
    for entry in (buff.get(buff_key) or [])[:4]:
        lines.append({"text": t(entry), "role": "label"})
    reset = buff.get("reset_at")
    if reset:
        lines.append({"text": t("overlay.resets_in"), "role": "label",
                      "right": _fmt_until(reset, now_ts, t),
                      "right_state": _urgency(reset, now_ts)})
    return lines


def _merchant_lines(snap, t, now_ts):
    merchants = snap.get("merchants") or {}
    lines = [{"text": t("overlay.w_merchants").upper(), "role": "eyebrow"}]
    flux = merchants.get("fluxion") or {}
    state = flux.get("state")
    flux_label = ("overlay.fluxion_voting" if state == "voting"
                  else "overlay.fluxion_selling" if state == "selling"
                  else "overlay.fluxion")
    for key, label in (("corruxion", "overlay.corruxion"),
                       ("fluxion", flux_label),
                       ("invasion", "overlay.luxion_trials")):
        entry = merchants.get(key) or {}
        until = entry.get("until")
        lines.append({
            "text": t(label), "role": "body",
            "right": _fmt_until(until, now_ts, t),
            "right_state": "live" if entry.get("active") else _urgency(until, now_ts),
        })
    return lines


def _chaos_lines(snap, t, now_ts):
    lines = [{"text": t("overlay.w_chaos_chest").upper(), "role": "eyebrow"}]
    chaos = snap.get("chaos")
    if not chaos:
        lines.append({"text": t("overlay.needs_network"), "role": "label"})
        return lines
    lines.append({"text": t(chaos.get("name")), "role": "title"})
    lines.append({"text": t("overlay.ends_in"), "role": "label",
                  "right": _fmt_until(chaos.get("end"), now_ts, t),
                  "right_state": _urgency(chaos.get("end"), now_ts)})
    return lines


def _gardening_lines(snap, t, now_ts):
    garden = snap.get("gardening") or {}
    lines = [{"text": t("overlay.w_gardening").upper(), "role": "eyebrow"}]
    for key, label in (("two_day", "overlay.plants_2day"), ("three_day", "overlay.plants_3day")):
        entry = garden.get(key) or {}
        target = entry.get("end") if entry.get("active") else entry.get("start")
        lines.append({"text": t(label), "role": "body",
                      "right": _fmt_until(target, now_ts, t),
                      "right_state": "live" if entry.get("active") else _urgency(target, now_ts)})
    return lines


def _rotation_lines(snap, t, now_ts):
    rotations = snap.get("rotations") or {}
    lines = [{"text": t("overlay.w_rotations").upper(), "role": "eyebrow"},
             {"text": t("overlay.wild_mana"), "role": "label"}]
    for biome in (rotations.get("wild_mana") or {}).get("biomes", [])[:3]:
        lines.append({"text": t(biome), "role": "body"})
    stampy = rotations.get("stampy") or {}
    if stampy:
        target = stampy.get("end") if stampy.get("active") else stampy.get("start")
        lines.append({"text": f"{t('overlay.stampy')} · {t(stampy.get('biome'))}",
                      "role": "body",
                      "right": _fmt_until(target, now_ts, t),
                      "right_state": "live" if stampy.get("active") else _urgency(target, now_ts)})
    return lines


def _delve_lines(snap, t, now_ts):
    delve = snap.get("delve") or {}
    lines = [{"text": t("overlay.w_delve").upper(), "role": "eyebrow"}]
    if delve:
        lines.append({"text": f"{t('overlay.delve_week')} {delve.get('week_id')}", "role": "title"})
        lines.append({"text": t("overlay.resets_in"), "role": "label",
                      "right": _fmt_until(delve.get("end"), now_ts, t),
                      "right_state": _urgency(delve.get("end"), now_ts)})
    return lines


def _event_lines(snap, t, now_ts):
    lines = [{"text": t("overlay.w_events").upper(), "role": "eyebrow"}]
    events = snap.get("events") or []
    if not events:
        lines.append({"text": t("overlay.no_events"), "role": "label"})
        return lines
    for event in events[:4]:
        target = event.get("end") if event.get("ongoing") else event.get("start")
        lines.append({"text": t(event.get("name")), "role": "body",
                      "right": _fmt_until(target, now_ts, t),
                      "right_state": "live" if event.get("ongoing") else _urgency(target, now_ts)})
    return lines


def _notification_lines(notes, t, now_ts):
    lines = [{"text": t("overlay.w_notifications").upper(), "role": "eyebrow"}]
    for note in notes:
        lines.append({"text": note.get("title", ""), "role": "title"})
        message = note.get("message") or ""
        # One wrap at a sensible width; the renderer does not reflow text, and a
        # long notification would otherwise run off the panel.
        for chunk in _wrap(message, 42)[:3]:
            lines.append({"text": chunk, "role": "label"})
    return lines


def _wrap(text, width):
    words, lines, current = str(text or "").split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


_BUILDERS = {
    "clock": lambda snap, t, now: _clock_lines(snap, t),
    "daily_buff": lambda snap, t, now: _buff_lines(snap.get("daily"), "normal_buffs",
                                                   "overlay.w_daily_buff", t, now),
    "weekly_buff": lambda snap, t, now: _buff_lines(snap.get("weekly"), "buffs",
                                                    "overlay.w_weekly_buff", t, now),
    "merchants": _merchant_lines,
    "chaos_chest": _chaos_lines,
    "gardening": _gardening_lines,
    "rotations": _rotation_lines,
    "delve": _delve_lines,
    "events": _event_lines,
}


def build_widgets(config, snapshot, notifications=(), *, catalog_order=()):
    """Config + snapshot -> the widget list ``utils.overlay_draw`` renders."""
    t = translator()
    now_ts = time.time()
    widgets_cfg = config.get("widgets") or {}
    order = list(catalog_order) or list(widgets_cfg)

    out = []
    for widget_id in order:
        cfg = widgets_cfg.get(widget_id)
        if not cfg or not cfg.get("enabled"):
            continue

        if widget_id == "notifications":
            # The stack only exists while something is in it.
            if not notifications:
                continue
            lines = _notification_lines(notifications, t, now_ts)
        else:
            builder = _BUILDERS.get(widget_id)
            if not builder:
                continue
            try:
                lines = builder(snapshot, t, now_ts)
            except Exception:
                continue

        out.append({
            "id": widget_id,
            "anchor": cfg.get("anchor", "top-left"),
            "x": cfg.get("x", 0.012),
            "y": cfg.get("y", 0.02),
            "scale": cfg.get("scale", 1.0),
            "highlight": widget_id == "notifications",
            "lines": lines,
        })
    return out
