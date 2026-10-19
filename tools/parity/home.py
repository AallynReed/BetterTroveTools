"""Golden fixtures and live checks for the home port (core/src/home).

Run from the repo root with the project venv:

    python tools/parity/home.py                 # rewrite core/tests/fixtures/home/*.json
    python tools/parity/home.py --sweep N OUT   # N more random rotation cases, for BTT_HOME_SWEEP
    python tools/parity/home.py --live OUT      # live API answers, for BTT_HOME_LIVE
    python tools/parity/home.py --dump NOW_US   # every rotation endpoint's JSON at one instant

Everything that writes runs under a throwaway APPDATA.
"""
import contextlib
import hashlib
import io
import json
import os
import random
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

_SANDBOX = tempfile.mkdtemp(prefix="btt-home-parity-")
for _key in ("APPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"):
    os.environ[_key] = _SANDBOX
os.environ.pop("BTT_DATA_DIR", None)

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

import datetime as _dt  # noqa: E402
from datetime import UTC, timedelta  # noqa: E402

import bottle  # noqa: E402
import eel  # noqa: E402
import gevent  # noqa: E402
import requests  # noqa: E402

import backend.event_notifications as event_notifications  # noqa: E402
import backend.home as home  # noqa: E402
import backend.live_feed as live_feed  # noqa: E402
import utils.trove.server_time as server_time  # noqa: E402
from utils import image_proxy  # noqa: E402

FIXTURES = ROOT / "core" / "tests" / "fixtures" / "home"
EPOCH = _dt.datetime(1970, 1, 1, tzinfo=UTC)
S, H = 10**6, 3600 * 10**6
D, W = 24 * H, 7 * 24 * H


class Frozen(_dt.datetime):
    current = None

    @classmethod
    def now(cls, tz=None):
        return cls.current


home.datetime = Frozen
server_time.datetime = Frozen


def freeze(now_us):
    Frozen.current = EPOCH + timedelta(microseconds=now_us)


def us(dt):
    return (dt - EPOCH) // timedelta(microseconds=1)


def utc(*args):
    return us(_dt.datetime(*args, tzinfo=UTC))


def short_hash(value):
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()[:12]


def quiet(fn, *args, **kwargs):
    with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
        return fn(*args, **kwargs)


def error_text(fn, *args):
    try:
        return {"out": quiet(fn, *args)}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def fake_response(status, payload, url="https://api.aallyn.net/v1/x"):
    response = requests.models.Response()
    response.status_code = status
    response._content = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    response.url = url
    response.reason = {200: "OK", 404: "Not Found", 500: "Internal Server Error"}.get(status, "")
    response.encoding = "utf-8"
    return response


def _compact(value):
    return json.dumps(value, separators=(",", ":"))


def write(name, data):
    """One line per top-level entry: small, and still diffable."""
    if isinstance(data, dict):
        body = "{\n" + ",\n".join(f"{json.dumps(k)}:{_list_lines(v)}" for k, v in data.items()) + "\n}\n"
    else:
        body = _list_lines(data) + "\n"
    FIXTURES.mkdir(parents=True, exist_ok=True)
    (FIXTURES / name).write_text(body, encoding="utf-8", newline="\n")
    print(f"wrote {name}: {(FIXTURES / name).stat().st_size} bytes")


def _list_lines(value):
    if isinstance(value, list) and value:
        return "[\n" + ",\n".join(_compact(v) for v in value) + "\n]"
    if isinstance(value, dict) and value and all(isinstance(v, dict) for v in value.values()):
        return "{\n" + ",\n".join(f"{json.dumps(k)}:{_compact(v)}" for k, v in value.items()) + "\n}"
    return _compact(value)


# --- rotations ----------------------------------------------------------------------

def _offline_get(*_a, **_k):
    raise requests.ConnectionError("offline")


ROTATIONS = {
    "get_current_server_data": home.get_current_server_data,
    "get_merchant_schedules": home.get_merchant_schedules,
    "get_yearly_calendar_data": home.get_yearly_calendar_data,
    "get_gardening_rotation": home.get_gardening_rotation,
    "get_d15_rotation": home.get_d15_rotation,
    "get_wild_mana_rotation": home.get_wild_mana_rotation,
    "get_stampy_rotation": home.get_stampy_rotation,
    "get_delve_status": home.get_delve_status,
    "chaos_fallback": lambda: home.get_chaos_chest_data()["fallback_times"],
}


def rotation_outputs(now_us):
    freeze(now_us)
    with mock.patch.object(requests, "get", _offline_get):
        return {name: quiet(fn) for name, fn in ROTATIONS.items()}


def edge_instants():
    st = server_time.ServerTime()
    out = []

    def around(t):
        out.extend([t - 1, t, t + 1])

    for day in ((2026, 10, 19), (2026, 10, 24), (2026, 10, 25), (2027, 2, 28)):
        around(utc(*day, 0))
        around(utc(*day, 11))
    for k in (60, 68, 69, 80):
        base = us(st.first_corruxion) + 11 * H + k * 14 * D
        around(base)
        around(base + 3 * D)
    for k in (160, 169, 170, 171, 200):
        base = us(st.first_fluxion) + 11 * H + k * W
        around(base)
        around(base + 3 * D)
    for c in (-1, 0, 1, 5, 186, 187, 190, 200):
        base = us(st.first_invasion) + 11 * H + c * 27 * H
        around(base)
        around(base + 3 * H)
    for k in (0, 6820, 6830):
        around(us(home.system_epoch) + k * 3 * H)
    for k in (0, 514, 515):
        around(us(st.first_gardening) + 11 * H + k * D)
    for k in (158, 159):
        base = utc(2023, 9, 30, 11) + k * W
        around(base)
        around(base + 48 * H)
    for k in (151, 152):
        around(utc(2023, 11, 20, 11) + k * W)
    for k in (-1, 0, 49, 50):
        around(us(home.DELVE_ROTATION_BASE) + 11 * H + k * W)
    return out


def random_instants(count, seed):
    rng = random.Random(seed)
    lo, hi = utc(2023, 1, 1), utc(2028, 1, 1)
    return [rng.randrange(lo, hi) for _ in range(count)]


def rotation_cases(instants):
    cases = []
    for now_us in instants:
        outputs = rotation_outputs(now_us)
        cases.append([now_us, ",".join(short_hash(outputs[name]) for name in ROTATIONS)])
    return {"endpoints": list(ROTATIONS), "cases": cases}


# --- payload transforms -------------------------------------------------------------

DEPTHS = [
    {
        "id": "d1", "depth": 101, "biome": "Neon City", "zone": "Lab", "objective": "kill", "objectiveText": "Kill 20",
        "killType": "any", "killAmount": 20, "killString": "20 enemies", "isVaultFloor": 1, "submittedBy": "kiwi",
        "boss": {"n": "Boss", "b": ["fire"]},
        "enemies": [{"n": "Bot", "b": ["ice"], "c": 3}, {"n": "Drone"}, "junk", {"b": None, "c": None}],
        "roomDetails": [{"e": 0}, {"e": 1}, "skip", {"e": 3}, {"e": 9}, {"e": -1}, {"e": True}, {"e": 1.0}, {"e": "0"}, {}],
    },
    {"id": "d2"},
    {"enemies": None},
    {"enemies": "ab", "roomDetails": {"x": 1}},
    {"boss": "nope"},
    {"boss": None, "isVaultFloor": "", "roomDetails": [{"e": False}], "enemies": [{"n": None, "b": 0, "c": 0}]},
    ["not", "a", "dict"],
    "text",
    None,
]

DELVE_PAYLOADS = [
    {"depths": [DEPTHS[0], DEPTHS[1]]},
    {"depths": [DEPTHS[1], "bad"]},
    {"depths": [{"enemies": None}]},
    {"data": {"depths": [DEPTHS[1]]}},
    {"data": {"depths": "nope"}},
    {"depths": {"a": 1}},
    {"depths": []},
    [],
    "x",
    None,
    {"other": 1},
]

FEED_PAYLOADS = [
    {"items": [
        {"login": "a", "channel": "A", "viewers": 3, "thumbnail": "t", "title": "T", "url": "u", "game": "Trove",
         "started_at": "2026-10-19T10:00:00Z", "event_id": 7, "starts_at": 1792400000, "ends_at": 1792500000, "extra": [1]},
        {"event_id": 8, "starts_at": "1792300000", "id": "keep-position", "name": "B"},
        {"event_id": 9, "starts_at": None},
    ]},
    {"items": None},
    {"other": 1},
    [{"login": "bare", "starts_at": 5.9}],
    [],
    {"items": [{"starts_at": "1.5"}]},
    {"items": ["str"]},
    {"items": [[1]]},
    {"items": "ab"},
    {"items": 5},
    {"items": {"k": 1}},
    None,
    0,
    "text",
    {"items": [{"starts_at": True}, {"starts_at": [1]}]},
    {"estimate": 1200, "estimate_24h": 5000, "estimate_7d": 9000, "duration_hours": 1, "span_24h_hours": 24,
     "span_7d_hours": 168, "window_end": 1792400000, "computed_at": "now", "methodology": "m", "by_board": [1, 2]},
]

CHAOS_PAYLOADS = [
    (200, {"starts_at": 1791889200, "ends_at": 1792494000, "item": {"name": "Loom", "identifier": "A\\B", "blueprint": "2026/Mounts/X.Blueprint", "image_url": "https://x"}}),
    (200, {"starts_at": "1791889200", "ends_at": 1792494000.7, "item": {"name": "Loom", "identifier": None, "blueprint": None}}),
    (200, {"starts_at": None, "ends_at": 1, "item": {"name": "Loom"}}),
    (200, {"starts_at": 1, "ends_at": 2, "item": {"name": None}}),
    (200, {"starts_at": "x", "ends_at": 2, "item": {"name": "Loom"}}),
    (200, {"starts_at": [1], "ends_at": 2, "item": {"name": "Loom"}}),
    (200, {"starts_at": True, "ends_at": 2, "item": {"name": "Loom", "blueprint": 5}}),
    (200, {"item": "nope"}),
    (200, [1, 2]),
    (200, None),
    (404, {"starts_at": 1, "ends_at": 2, "item": {"name": "Loom"}}),
    (500, {}),
]


class Harness:
    """Fake eel bridge plus a scripted requests.get, for the feed greenlets."""

    def __init__(self, respond):
        self.respond = respond
        self.requests = []
        self.external = []
        self.received = []

    def get(self, url, headers=None, timeout=None, **_):
        self.requests.append({"url": url, "headers": headers, "timeout": timeout})
        return self.respond(url)

    def run(self, endpoint):
        patches = [
            mock.patch.object(requests, "get", self.get),
            mock.patch.object(eel, "add_external_request", lambda label, url: (self.external.append([label, url]) or (lambda: "rid")), create=True),
            mock.patch.object(eel, "remove_external_request", lambda rid, ok: (lambda: None), create=True),
        ]
        for feed in FEEDS:
            name = feed["receive"]
            patches.append(mock.patch.object(eel, name, lambda payload, name=name: self.received.append([name, payload]), create=True))
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            before = set(home._HOME_FETCH_TASKS)
            result = getattr(home, endpoint)()
            tasks = [t for t in home._HOME_FETCH_TASKS if t not in before]
            gevent.joinall(tasks, timeout=60)
        return result


FEEDS = [
    {"endpoint": "get_twitch_streams", "receive": "receive_twitch_streams"},
    {"endpoint": "get_youtube_videos", "receive": "receive_youtube_videos"},
    {"endpoint": "get_bilibili_videos", "receive": "receive_bilibili_videos"},
    {"endpoint": "get_trovesaurus_events", "receive": "receive_events_data"},
    {"endpoint": "get_trove_news", "receive": "receive_trove_news"},
    {"endpoint": "get_giveaways", "receive": "receive_giveaways"},
    {"endpoint": "get_upcoming_giveaways", "receive": "receive_upcoming_giveaways"},
    {"endpoint": "get_ended_giveaways", "receive": "receive_ended_giveaways"},
    {"endpoint": "get_player_activity", "receive": "receive_player_activity"},
]


def feed_fixtures():
    """Per endpoint: what it requested, and what `receive_*` got for each payload."""
    feeds = {}
    for feed in FEEDS:
        received = []
        for i, payload in enumerate(FEED_PAYLOADS):
            harness = Harness(lambda url, payload=payload: fake_response(200, payload, url))
            result = harness.run(feed["endpoint"])
            if i == 0:
                req = harness.requests[0]
                meta = {
                    "label": harness.external[0][0], "url": harness.external[0][1], "request_url": req["url"],
                    "headers": req["headers"], "timeout": req["timeout"], "receive": harness.received[0][0], "returns": result,
                }
            received.append(harness.received[0][1])
        feeds[feed["endpoint"]] = {**meta, "received": received}
    return feeds


def chaos_fixtures():
    out = []
    now_us = utc(2026, 10, 19, 14, 30)
    freeze(now_us)
    for status, payload in CHAOS_PAYLOADS:
        harness = Harness(lambda url, s=status, p=payload: fake_response(s, p, url))
        with mock.patch.object(requests, "get", harness.get):
            result = quiet(home.get_chaos_chest_data)
        out.append({"now_us": now_us, "status": status, "payload": payload, "out": result})
    return out


def week_fixtures():
    out = []
    freeze(utc(2026, 10, 19, 14, 30))
    for week_id, current in ((50, 51), (51, 51)):
        for payload in DELVE_PAYLOADS:
            home._DELVE_WEEK_CACHE.clear()
            with mock.patch.object(home._DELVE_HTTP, "get", lambda url, **_k: fake_response(200, payload, url)):
                case = error_text(home._fetch_delve_week, week_id, current)
            out.append({"week_id": week_id, "current": current, "payload": payload, **case})
    home._DELVE_WEEK_CACHE.clear()
    return out


def transform_fixtures():
    return {
        "delve_depth": [{"in": d, **error_text(home._normalize_delve_depth, d)} for d in DEPTHS],
        "delve_payload": [{"in": p, "out": home._extract_delve_payload(p)} for p in DELVE_PAYLOADS],
        "delve_week": week_fixtures(),
        "feed_payloads": FEED_PAYLOADS,
        "feeds": feed_fixtures(),
        "chaos": chaos_fixtures(),
    }


# --- event notifications ------------------------------------------------------------

HANDLER_PAYLOADS = {
    "challenge": [
        {"starts_at": 1792418400, "name": "RAMPAGE ALERT!", "type": "rampage"},
        {"starts_at": None, "name": "  Spaced  ", "type": "boss_rush"},
        {"starts_at": 1.0, "name": "X", "type": "dungeon"},
        {"name": "", "type": "rampage"},
        {"name": "X"},
        {"name": 5, "type": "rampage"},
        {"name": "X", "type": 5},
        {"name": "X", "type": "mixed CASE-word"},
    ],
    "chaos": [
        {"starts_at": 1791889200, "item": {"name": "Thread-spinner Loom"}},
        {"item": None},
        {"item": "str"},
        {"item": {"name": 7}},
        {},
    ],
    "corruxion": [{"active": True, "starts_at": 5}, {"active": False}, {"active": 1}],
    "fluxion": [{"active": True, "starts_at": 5, "state": "Voting"}, {"active": True, "state": None}, {"active": False}, {"active": True, "state": 3}],
    "longshade": [
        {"current": {"starts_at": 1792418400, "biomes": [{"name": "Frozen Wastes", "final_name": "Permafrost"}, {"name": "Data Spires", "final_name": ""}, {"name": None}]}},
        {"current": {"biomes": []}},
        {"current": None},
        {"current": {"biomes": [{"final_name": 5}]}},
        {"current": {"biomes": ["x"]}},
        {"current": {"biomes": {"a": 1}}},
    ],
    "wild_mana": [{"current": {"starts_at": 1, "biomes": [{"final_name": "Fae Forest"}]}}, {}],
    "stampy": [{"current": {"starts_at": 2, "biomes": [{"name": "Candoria"}]}}, {"current": {}}],
    "daily_bonuses": [
        {"current": {"name": "Delve Day", "weekday": "Monday", "normal_buffs": ["Double Crystal Drops", "x"]}},
        {"current": {"weekday": "Monday"}},
        {"current": {"name": "N", "normal_buffs": "abc"}},
        {"current": {"name": "N", "normal_buffs": {"a": 1}}},
        {"current": {"name": "N", "normal_buffs": [5]}},
        {"current": {"name": "N", "normal_buffs": [""]}},
        {},
    ],
    "activity": [{"window_start": 1792407600}, {}],
    "server_status": [{"overall": "online"}, {"overall": ""}, {}],
    "trove_news": [{"item": {"title": "Community Letter", "url": "https://trovegame.com/a"}}, {"item": {"title": ""}}, {"item": {"title": 5}}],
    "giveaways": [{"newest": {"id": "6ad2", "title": "The Streamer Dream"}}, {"newest": None}, {"newest": {"title": "T"}}],
    "game_update": [
        {"version": {"branch": "live-us", "ordinal": 14, "version_tag": "STABLE-103"}},
        {"version": {"ordinal": 15}},
        {"version": {}},
        {"version": {"version_tag": "", "ordinal": 0}},
    ],
    "unknown": [{"x": 1}],
}


def run_handler(event_type, data):
    handler = event_notifications._HANDLERS.get(event_type)
    if not handler:
        return None
    try:
        result = handler(data)
    except Exception:  # noqa: BLE001
        return None
    if not result:
        return None
    key, sig, title, body = result
    # What DesktopNotifier.notify hands its sink.
    return [key, sig, str(title or ""), str(body or "")]


class FakeFeed:
    def __init__(self):
        self.subscribers, self.last = [], {}

    def subscribe(self, callback):
        self.subscribers.append(callback)

    def snapshot(self, event_type=None):
        return dict(self.last)

    def push(self, event_type, data):
        self.last[event_type] = data
        for callback in self.subscribers:
            callback(event_type, data)


class FakeNotifier:
    def __init__(self):
        self.sent = []

    def set_active(self, active):
        pass

    def notify(self, title, body):
        self.sent.append([str(title or ""), str(body or "")])


def chaos_event(starts_at, name):
    return {"starts_at": starts_at, "item": {"name": name}}


SCENARIOS = [
    {"initial": None, "steps": [
        ["push", "chaos", chaos_event(1, "Cataew")],
        ["apply", {"enabled": True, "events": {"chaos": True, "stampy": 0}}],
        ["push", "chaos", chaos_event(1, "Cataew")],
        ["push", "chaos", chaos_event(2, "Bomber Bill")],
        ["push", "_status", {"connected": True}],
        ["push", "stampy", {"current": {"starts_at": 9, "biomes": [{"name": "Candoria"}]}}],
        ["apply", {"enabled": True, "events": {"chaos": True, "stampy": "yes"}}],
        ["push", "corruxion", {"active": True, "starts_at": 3}],
    ]},
    {"initial": {"last_sig": {"chaos": "1:Cataew", "num": 5, "none": None, "flt": 1.5, "lst": [1, "a"]}}, "steps": [
        ["push", "chaos", chaos_event(1, "Cataew")],
        ["apply", {"enabled": True, "events": {"chaos": True, "daily_bonuses": True}}],
        ["push", "daily_bonuses", {"current": {"name": "Delve Day", "normal_buffs": ["Double Crystal Drops"]}}],
        ["push", "chaos", chaos_event(1, "Cataew")],
        ["apply", {"enabled": False, "events": {"chaos": True}}],
        ["push", "chaos", chaos_event(3, "Third")],
        ["apply", {"enabled": True, "events": {}}],
        ["push", "chaos", chaos_event(4, "Fourth")],
        ["apply", "not a dict"],
        ["apply", {"enabled": "true", "events": {"chaos": True}}],
        ["push", "chaos", chaos_event(5, "Fifth")],
    ]},
    {"initial": "broken", "steps": [
        ["apply", {"enabled": True, "events": {"game_update": True, "trove_news": 1, "challenge_rampage": True}}],
        ["push", "game_update", {"version": {"branch": "live-us", "ordinal": 14, "version_tag": "STABLE"}}],
        ["push", "trove_news", {"item": {"title": "News", "url": None}}],
        ["push", "challenge", {"starts_at": 1, "name": "Go", "type": "rampage"}],
        ["push", "challenge", {"starts_at": 1, "name": "Go", "type": "racing"}],
    ]},
]


def run_scenario(scenario):
    state_file = Path(_SANDBOX) / "Trove" / "ModManagerCache" / "event_notifications_state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    if scenario["initial"] is None:
        state_file.unlink(missing_ok=True)
    elif isinstance(scenario["initial"], str):
        state_file.write_text(scenario["initial"], encoding="utf-8")
    else:
        state_file.write_text(json.dumps(scenario["initial"]), encoding="utf-8")
    feed, notifier = FakeFeed(), FakeNotifier()
    subject = event_notifications.EventNotifier(notifier, feed)
    enabled = []
    for step in scenario["steps"]:
        if step[0] == "apply":
            subject.apply(step[1])
            enabled.append(subject.is_enabled())
        else:
            feed.push(step[1], step[2])
    # Text mode writes CRLF on Windows; the Rust build writes LF.
    state = state_file.read_bytes().decode("utf-8").replace("\r\n", "\n") if state_file.exists() else None
    return {**scenario, "sent": notifier.sent, "enabled": enabled, "state": state}


def notification_fixtures():
    handlers = [{"type": t, "data": d, "out": run_handler(t, d)} for t, ds in HANDLER_PAYLOADS.items() for d in ds]
    return {"handlers": handlers, "scenarios": [run_scenario(s) for s in SCENARIOS]}


# --- image proxy and SSE ------------------------------------------------------------

PROXY_URLS = [
    "https://i0.hdslb.com/bfs/archive/abc.jpg",
    "http://i1.hdslb.com/bfs/a.png?x=1&y=2#frag",
    "HTTPS://I2.HDSLB.COM./bfs/a.webp",
    "https://hdslb.com:8443/x?",
    "https://user:pw@s1.hdslb.com/x",
    "https://s2.hdslb.com@evil.example/x",
    "https://evil.example/?hdslb.com",
    "https://hdslb.com.evil.example/x",
    "https://archive.biliimg.com",
    "  \t https://i0.hdslb.com/a\n.jpg",
    "ftp://i0.hdslb.com/a.jpg",
    "//i0.hdslb.com/a.jpg",
    "https:/i0.hdslb.com/a.jpg",
    "https://[::1]/a.jpg",
    "https://i0.hdslb.com]/a.jpg",
    "https://a[b]@i0.hdslb.com/a.jpg",
    "https://i0.hdslb.com/a b.jpg?q=a b",
    "javascript:alert(1)",
    "1https://i0.hdslb.com/x",
    "",
    None,
]

PROXY_QUERIES = [
    "url=https%3A%2F%2Fi0.hdslb.com%2Fa.jpg",
    "url=a&url=https%3A%2F%2Fi0.hdslb.com%2Fb.jpg",
    "x=1&url=https://i0.hdslb.com/a+b.jpg",
    "url",
    "",
    "&&url=%zz&",
]


def proxy_fixtures():
    queries = []
    for q in PROXY_QUERIES:
        req = bottle.BaseRequest({"QUERY_STRING": q})
        queries.append({"query": q, "url": req.query.get("url")})
    return {"urls": [{"url": u, "out": image_proxy.resolve_image_url(u)} for u in PROXY_URLS], "queries": queries}


def sse_frame(event_type, data, sep="\n"):
    return f"event: {event_type}{sep}data: {json.dumps({'type': event_type, 'data': data, 'ts': 1})}{sep}{sep}"


SSE_BODIES = [
    "retry: 5000\n\n: ping\n\n"
    + sse_frame("challenge", {"starts_at": 1792418400, "name": "RAMPAGE ALERT!", "type": "rampage", "emoji": "\U0001f3f9"})
    + sse_frame("longshade", {"current": {"starts_at": 1, "biomes": [{"name": f"Biome {i}", "final_name": "x" * 40} for i in range(30)]}})
    + ": ping\n\n"
    + "id: 7\nevent:chaos\ndata:{\"data\": {\"item\": {\"name\": \"Loom\"}}}\n\n"
    + "event: multi\ndata: {\"data\":\ndata:  {\"a\": 1}}\n\n"
    + "data: {\"data\": {\"orphan\": true}}\n\n"
    + "event: empty\n\n"
    + "event: bad\ndata: [1, 2]\n\n"
    + "event:  spaced  \ndata: {\"data\": {\"s\": 1}}\n\n"
    + sse_frame("chaos", {"item": {"name": "Second"}})
    + "event: unterminated\ndata: {\"data\": {}}",
    sse_frame("trove_news", {"item": {"title": "CRLF"}}, sep="\r\n") + "event: lonecr\rdata: {\"data\": {\"cr\": 1}}\r\r",
]


def run_sse(body):
    feed = live_feed.LiveFeed()
    seen = []
    feed.subscribe(lambda t, d: seen.append([t, d]))
    response = fake_response(200, body.encode("utf-8"))
    response.raw = io.BytesIO(body.encode("utf-8"))
    response._content = False
    response._content_consumed = False
    response.headers["content-type"] = "text/event-stream; charset=utf-8"
    with mock.patch.object(live_feed.requests, "get", return_value=response):
        feed._connect_once()
    return {"body": body, "events": seen, "snapshot": feed.snapshot()}


# --- live ---------------------------------------------------------------------------

def live(out_path):
    result = {"feeds": {}}
    for feed in FEEDS:
        harness = Harness(lambda url: _real_get(url))
        harness.run(feed["endpoint"])
        result["feeds"][feed["endpoint"]] = harness.received[0][1] if harness.received else None
    freeze(us(_dt.datetime.now(UTC)))
    with mock.patch.object(eel, "add_external_request", lambda *a: (lambda: None), create=True):
        result["chaos"] = quiet(home.get_chaos_chest_data)
        home._DELVE_WEEK_CACHE.clear()
        result["delve"] = quiet(home.get_delve_rotation)
    result["chaos_now_us"] = us(Frozen.current)

    bilibili = result["feeds"]["get_bilibili_videos"]
    thumbs = [v.get("thumbnail_url") for v in (bilibili.get("data") or []) if isinstance(v, dict) and v.get("thumbnail_url")]
    probes = thumbs[:2] + ["https://i0.hdslb.com/bfs/archive/does-not-exist-btt.jpg", "https://evil.example/x.jpg"]
    result["proxy"] = []
    for url in probes:
        status, body, ctype = image_proxy.fetch_image(url)
        result["proxy"].append({"url": url, "status": status, "sha256": hashlib.sha256(body).hexdigest(), "content_type": ctype})

    try:
        requests.get(home.KIWI_API_BASE + "/feeds/does-not-exist", timeout=10).raise_for_status()
        result["http_error"] = None
    except Exception as exc:  # noqa: BLE001
        result["http_error"] = str(exc)

    feed = live_feed.LiveFeed()
    statuses = []
    feed.subscribe(lambda t, d: statuses.append(d) if t == "_status" else None)
    threading.Thread(target=feed._connect_once, daemon=True).start()
    time.sleep(8)
    result["sse"] = {"connected": feed.is_connected(), "snapshot": feed.snapshot(), "statuses": statuses}

    Path(out_path).write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"wrote {out_path}")


_real_requests_get = requests.get


def _real_get(url, **kwargs):
    return _real_requests_get(url, headers={"User-Agent": "BetterTroveTools/1.0"}, timeout=15)


def main(argv):
    if argv[:1] == ["--sweep"]:
        count, out = int(argv[1]), argv[2]
        Path(out).write_text(json.dumps(rotation_cases(random_instants(count, seed=int(time.time())))), encoding="utf-8")
        print(f"wrote {count} cases to {out}")
        return
    if argv[:1] == ["--live"]:
        live(argv[1])
        return
    if argv[:1] == ["--dump"]:
        print(json.dumps(rotation_outputs(int(argv[1])), indent=1))
        return
    write("rotations.json", rotation_cases(edge_instants() + random_instants(60, seed=1234)))
    write("transforms.json", transform_fixtures())
    write("event_notifications.json", notification_fixtures())
    write("image_proxy.json", proxy_fixtures())
    write("sse.json", [run_sse(b) for b in SSE_BODIES])


if __name__ == "__main__":
    main(sys.argv[1:])
