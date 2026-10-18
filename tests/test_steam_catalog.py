"""The Mod Manager's Steam tab: Workshop list and subscribing.

Run with:  python -m unittest discover -s tests
"""

import unittest
from unittest import mock

from tests.support import FakeResponse, Sandbox, patch_http

import backend.mod_manager.steam_catalog as steam_catalog
import backend.modder_tools.steam_workshop as steam_workshop

CATALOG = {"items": [
    {"published_file_id": "111", "title": "Alpha", "creator": "76561198000000001", "subscriptions": 9},
    {"published_file_id": "222", "title": "Beta", "creator": "76561198000000002", "subscriptions": 3},
], "fetched_at": "2026-10-18T09:00:00Z"}


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)
        steam_catalog._cache.update(at=0.0, data=None)
        library = self.sandbox.root / "library" / "steamapps"
        self.game = library / "common" / "Trove" / "Games" / "Trove" / "Live"
        (self.game / "mods").mkdir(parents=True)
        (library / "workshop" / "content" / "304050" / "222").mkdir(parents=True)

    def test_items_installed_here_are_marked(self):
        with patch_http(get=lambda url, **kw: FakeResponse(payload=CATALOG)):
            response = steam_catalog.get_steam_workshop_catalog(str(self.game))

        self.assertTrue(response["success"], response)
        marks = {i["published_file_id"]: i["installed"] for i in response["data"]["items"]}
        self.assertEqual(marks, {"111": False, "222": True})

    def test_a_glyph_install_marks_nothing_installed(self):
        with patch_http(get=lambda url, **kw: FakeResponse(payload=CATALOG)):
            response = steam_catalog.get_steam_workshop_catalog(self.sandbox.path)

        self.assertFalse(any(i["installed"] for i in response["data"]["items"]))

    def test_a_failed_fetch_serves_the_last_good_list(self):
        with patch_http(get=lambda url, **kw: FakeResponse(payload=CATALOG)):
            steam_catalog.get_steam_workshop_catalog(str(self.game))
        with patch_http(get=lambda url, **kw: FakeResponse(status_code=503)):
            response = steam_catalog.get_steam_workshop_catalog(str(self.game), True)

        self.assertEqual(len(response["data"]["items"]), 2)

    def test_no_list_ever_is_its_own_code(self):
        with patch_http(get=lambda url, **kw: FakeResponse(status_code=503)):
            response = steam_catalog.get_steam_workshop_catalog(str(self.game))

        self.assertEqual(response["code"], "CATALOG_UNAVAILABLE")


class SubscribeTests(unittest.TestCase):
    def test_subscribes_through_steam(self):
        with mock.patch.object(steam_workshop, "subscribe_item", return_value=True) as subscribe:
            response = steam_catalog.subscribe_workshop_item("3816274470")

        self.assertTrue(response["success"], response)
        subscribe.assert_called_once_with("3816274470")

    def test_steam_closed_is_its_own_code(self):
        error = steam_workshop.SteamError("Steam is not running. Start Steam, sign in, and try again.")
        with mock.patch.object(steam_workshop, "subscribe_item", side_effect=error):
            self.assertEqual(steam_catalog.subscribe_workshop_item("1")["code"], "STEAM_UNAVAILABLE")

    def test_steam_saying_no_is_reported(self):
        with mock.patch.object(steam_workshop, "subscribe_item", return_value=False):
            self.assertEqual(steam_catalog.subscribe_workshop_item("1")["code"], "SUBSCRIBE_REFUSED")

    def test_a_non_numeric_id_never_reaches_steam(self):
        with mock.patch.object(steam_workshop, "subscribe_item") as subscribe:
            self.assertEqual(steam_catalog.subscribe_workshop_item("../x")["code"], "INVALID_ID")
        subscribe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
