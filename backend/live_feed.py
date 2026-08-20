"""One Server-Sent Events connection to the TroveAPI, fanned out in-process.

The app already consumed this stream for desktop notifications; it now opens at
launch and feeds the UI as well. Views fetch once when they mount and then let
the stream tell them what actually changed, instead of re-polling on a timer.

Design:
  * A single background thread holds one long-lived streaming GET and parses the
    ``event:``/``data:`` frames. Running in Python (not a WebView timer) keeps it
    alive while the window is hidden in the tray, and costs one socket rather
    than one request per feed per tick.
  * Subscribers are plain callables ``(event_type, data) -> None`` invoked on the
    stream thread. Each is isolated: one raising doesn't starve the others.
  * The server opens every connection with a SNAPSHOT of current state, so a
    subscriber that attaches late -- or one that reconnects -- gets the whole
    picture within a few seconds without asking for it. Consumers that must not
    act twice on the same occurrence dedupe themselves (see
    ``event_notifications``); consumers that just mirror state don't care.
"""
from __future__ import annotations

import json
import threading
import time

import eel
import requests

from backend.home import KIWI_API_BASE
from backend.response import resp, standardize_response

STREAM_URL = f"{KIWI_API_BASE}/events/stream"

# Reconnect backoff after the stream drops.
_RECONNECT_SECONDS = 5.0
# Read timeout: the server sends a ``: ping`` keep-alive ~every 20s, so a longer
# gap means the socket is dead and we should reconnect.
_READ_TIMEOUT = 45.0


class LiveFeed:
    def __init__(self):
        self._subscribers = []
        self._lock = threading.Lock()
        self._thread = None
        self._connected = False
        self._last = {}          # event_type -> most recent data payload

    # --- public API -----------------------------------------------------
    def subscribe(self, callback):
        """Register ``callback(event_type, data)``. Safe to call before start."""
        with self._lock:
            self._subscribers.append(callback)

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="live-feed", daemon=True)
        self._thread.start()

    def is_connected(self):
        with self._lock:
            return self._connected

    def snapshot(self, event_type=None):
        """Last payload seen per event type -- lets a consumer that starts late
        read current state without waiting for the next push."""
        with self._lock:
            if event_type is not None:
                return self._last.get(event_type)
            return dict(self._last)

    # --- stream thread --------------------------------------------------
    def _run(self):
        while True:
            try:
                self._connect_once()
            except Exception:
                pass
            self._set_connected(False)
            time.sleep(_RECONNECT_SECONDS)

    def _connect_once(self):
        headers = {"Accept": "text/event-stream", "User-Agent": "BetterTroveTools"}
        with requests.get(STREAM_URL, stream=True, timeout=(10, _READ_TIMEOUT), headers=headers) as response:
            response.raise_for_status()
            self._set_connected(True)
            event_type = None
            data_lines = []
            for raw in response.iter_lines(decode_unicode=True):
                if raw is None:
                    continue
                line = raw.rstrip("\r")
                if line == "":
                    if event_type and data_lines:
                        self._dispatch(event_type, "\n".join(data_lines))
                    event_type, data_lines = None, []
                    continue
                if line.startswith(":"):
                    continue  # keep-alive comment
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
                # ignore other fields (retry:, id:)

    def _set_connected(self, connected):
        with self._lock:
            if self._connected == connected:
                return
            self._connected = connected
            subscribers = list(self._subscribers)
        for callback in subscribers:
            try:
                callback("_status", {"connected": connected})
            except Exception:
                pass

    def _dispatch(self, event_type, data_str):
        try:
            payload = json.loads(data_str)
        except (ValueError, TypeError):
            return
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            return
        with self._lock:
            self._last[event_type] = data
            subscribers = list(self._subscribers)
        for callback in subscribers:
            try:
                callback(event_type, data)
            except Exception:
                pass


feed = LiveFeed()


def _forward_to_ui(event_type, data):
    """Hand every frame to the frontend. Fire-and-forget: with no window open
    (or none yet) eel has nowhere to send it, which is fine -- the next
    connection gets a fresh snapshot."""
    try:
        eel.receive_live_event(event_type, data)
    except Exception:
        pass


feed.subscribe(_forward_to_ui)


@eel.expose
@standardize_response
def get_live_feed_status():
    """Whether the live stream is currently up, plus the last payload seen for
    each event type. The frontend uses this on view mount: connected means it can
    stop polling, and the snapshot spares it a round of fetches."""
    connected = feed.is_connected()
    data = {"connected": connected, "events": feed.snapshot()}
    return resp(True, data=data, **data)
