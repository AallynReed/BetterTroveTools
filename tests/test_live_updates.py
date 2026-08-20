"""Tests for the live update paths: the mods-folder watch and the shared SSE feed.

Run with:  python -m unittest discover -s tests
"""

import unittest
from unittest import mock

import eel

from tests.support import Sandbox, build_tmod

import backend.live_feed as live_feed
import backend.event_notifications as event_notifications
import backend.mod_manager.mod_watcher as mod_watcher


class ModWatcherTestCase(unittest.TestCase):
    """The watcher is driven one tick at a time here -- the real loop just calls
    _tick() on a timer."""

    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)
        self.pushed = []
        patcher = mock.patch.object(eel, "receive_mods_changed",
                                    lambda path: self.pushed.append(path), create=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.watcher = mod_watcher.ModWatcher()

    def test_settled_change_announces_once(self):
        self.watcher.set_target(self.sandbox.path)
        self.sandbox.write("alpha.tmod", build_tmod("Alpha"))

        self.assertIsNone(self.watcher._tick(), "a first sighting must wait for the file to settle")
        self.assertEqual(self.pushed, [])

        self.assertEqual(self.watcher._tick(), self.sandbox.path)
        self.assertEqual(self.pushed, [self.sandbox.path])

        # Nothing changed since -- no repeat.
        self.assertIsNone(self.watcher._tick())
        self.assertEqual(self.pushed, [self.sandbox.path])

    def test_file_still_being_written_is_not_announced(self):
        self.watcher.set_target(self.sandbox.path)
        self.sandbox.write("growing.tmod", b"a" * 10)
        self.assertIsNone(self.watcher._tick())

        self.sandbox.write("growing.tmod", b"a" * 4096)   # still copying
        self.assertIsNone(self.watcher._tick())
        self.assertEqual(self.pushed, [])

        self.assertEqual(self.watcher._tick(), self.sandbox.path)

    def test_reverted_change_is_dropped(self):
        self.watcher.set_target(self.sandbox.path)
        target = self.sandbox.write("temp.tmod", build_tmod("Temp"))
        self.assertIsNone(self.watcher._tick())
        target.unlink()                                    # back to the baseline
        self.assertIsNone(self.watcher._tick())
        self.assertEqual(self.pushed, [])

    def test_switching_install_rebaselines(self):
        self.sandbox.write("alpha.tmod", build_tmod("Alpha"))
        self.watcher.set_target(self.sandbox.path)
        # The mod was already there when the watch started, so it is not news.
        self.assertIsNone(self.watcher._tick())
        self.assertIsNone(self.watcher._tick())
        self.assertEqual(self.pushed, [])

    def test_no_target_is_inert(self):
        self.watcher.set_target(None)
        self.assertIsNone(self.watcher._tick())


def _sse_response(body):
    """A stand-in for the streaming requests.Response the feed reads."""
    response = mock.MagicMock()
    response.__enter__.return_value = response
    response.__exit__.return_value = False
    response.iter_lines.return_value = iter(body.split("\n"))
    return response


class LiveFeedTestCase(unittest.TestCase):
    def setUp(self):
        self.feed = live_feed.LiveFeed()
        self.seen = []
        self.feed.subscribe(lambda event_type, data: self.seen.append((event_type, data)))

    def test_frames_are_parsed_and_fanned_out(self):
        body = (
            "retry: 5000\n"
            "\n"
            ": ping\n"
            "\n"
            'event: chaos\n'
            'data: {"type": "chaos", "data": {"item": {"name": "Cataew"}}}\n'
            "\n"
            'event: trove_news\n'
            'data: {"type": "trove_news", "data": {"item": {"title": "Patch"}}}\n'
            "\n"
        )
        with mock.patch.object(live_feed.requests, "get", return_value=_sse_response(body)):
            self.feed._connect_once()

        self.assertEqual(
            self.seen,
            [
                ("_status", {"connected": True}),
                ("chaos", {"item": {"name": "Cataew"}}),
                ("trove_news", {"item": {"title": "Patch"}}),
            ],
        )
        self.assertEqual(self.feed.snapshot("chaos"), {"item": {"name": "Cataew"}})
        self.assertTrue(self.feed.is_connected())

    def test_malformed_frames_are_skipped(self):
        body = (
            "event: chaos\n"
            "data: not json\n"
            "\n"
            'event: chaos\n'
            'data: {"data": "not an object"}\n'
            "\n"
        )
        with mock.patch.object(live_feed.requests, "get", return_value=_sse_response(body)):
            self.feed._connect_once()
        self.assertEqual([event for event, _ in self.seen], ["_status"])

    def test_one_failing_subscriber_does_not_starve_the_others(self):
        self.feed.subscribe(lambda event_type, data: 1 / 0)
        late = []
        self.feed.subscribe(lambda event_type, data: late.append(event_type))
        self.feed._dispatch("chaos", '{"data": {"item": {}}}')
        self.assertEqual(late, ["chaos"])


class FakeFeed:
    def __init__(self):
        self.subscribers = []
        self.last = {}

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
        self.sent.append((title, body))


class EventNotifierTestCase(unittest.TestCase):
    """The notifier no longer owns a socket -- it is a feed subscriber. Its
    announce-once semantics have to survive that."""

    def setUp(self):
        self.sandbox = Sandbox().__enter__()          # isolates the persisted state file
        self.addCleanup(self.sandbox.__exit__, None, None, None)
        self.feed = FakeFeed()
        self.notifier = FakeNotifier()
        self.subject = event_notifications.EventNotifier(self.notifier, self.feed)

    def chaos(self, starts_at, name):
        return {"starts_at": starts_at, "item": {"name": name}}

    def test_disabled_events_stay_silent(self):
        self.feed.push("chaos", self.chaos(1, "Cataew"))
        self.assertEqual(self.notifier.sent, [])

    def test_enabling_announces_current_state_then_dedupes(self):
        self.feed.push("chaos", self.chaos(1, "Cataew"))
        self.subject.apply({"enabled": True, "events": {"chaos": True}})
        self.assertEqual(len(self.notifier.sent), 1)

        self.feed.push("chaos", self.chaos(1, "Cataew"))       # reconnect snapshot
        self.assertEqual(len(self.notifier.sent), 1)

        self.feed.push("chaos", self.chaos(2, "Bomber Bill"))  # genuinely new
        self.assertEqual(len(self.notifier.sent), 2)

    def test_turning_notifications_off_silences_the_subscription(self):
        self.subject.apply({"enabled": True, "events": {"chaos": True}})
        self.subject.apply({"enabled": False, "events": {"chaos": True}})
        self.feed.push("chaos", self.chaos(3, "Third"))
        self.assertEqual(self.notifier.sent, [])


if __name__ == "__main__":
    unittest.main()
