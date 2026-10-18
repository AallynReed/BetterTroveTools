"""Workshop unsubscribe used by the Mods Hub takedown.

Run with:  python -m unittest discover -s tests
"""

import unittest
from unittest import mock

import backend.modder_tools.steam_workshop as steam_workshop


class FakeSession:
    def __init__(self, connected=False, refuse=False, results=None):
        self.connected = connected
        self.refuse = refuse
        self.results = results or {}
        self.calls = []

    def connect(self):
        self.calls.append("connect")
        if self.refuse:
            raise steam_workshop.SteamError("Steam is not running.")
        self.connected = True

    def unsubscribe(self, item_id):
        self.calls.append(item_id)
        outcome = self.results.get(item_id, True)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def disconnect(self):
        self.calls.append("disconnect")
        self.connected = False


class UnsubscribeItemsTests(unittest.TestCase):
    def run_with(self, session, ids):
        with mock.patch.object(steam_workshop, "_SESSION", session):
            return steam_workshop.unsubscribe_items(ids)

    def test_each_item_is_unsubscribed_and_the_session_closed(self):
        session = FakeSession()

        done = self.run_with(session, ["111", "222"])

        self.assertEqual(done, ["111", "222"])
        self.assertEqual(session.calls, ["connect", 111, 222, "disconnect"])

    def test_a_refused_item_is_skipped_and_the_rest_still_go(self):
        session = FakeSession(results={111: False, 222: steam_workshop.SteamError("Timed out")})

        done = self.run_with(session, ["111", "222", "333"])

        self.assertEqual(done, ["333"])

    def test_steam_not_running_unsubscribes_nothing_and_raises_nothing(self):
        session = FakeSession(refuse=True)

        self.assertEqual(self.run_with(session, ["111"]), [])
        self.assertNotIn(111, session.calls)

    def test_a_session_already_open_is_left_open(self):
        session = FakeSession(connected=True)

        self.run_with(session, ["111"])

        self.assertNotIn("disconnect", session.calls)
        self.assertTrue(session.connected)


if __name__ == "__main__":
    unittest.main()
