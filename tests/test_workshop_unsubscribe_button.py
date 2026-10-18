"""The Mod Manager's Unsubscribe button for Steam Workshop mods.

Run with:  python -m unittest discover -s tests
"""

import unittest
from unittest import mock

from tests.support import Sandbox, build_tmod

import backend.modder_tools.steam_workshop as steam_workshop
from backend.mod_manager.mod_manager import unsubscribe_workshop_mod


class UnsubscribeButtonTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)
        library = self.sandbox.root / "library" / "steamapps"
        self.game = library / "common" / "Trove" / "Games" / "Trove" / "Live"
        (self.game / "mods").mkdir(parents=True)
        self.item = library / "workshop" / "content" / "304050" / "3816274470"
        self.item.mkdir(parents=True)
        self.mod = self.item / "Quwastee Cursor.tmod"
        self.mod.write_bytes(build_tmod("Quwastee Cursor"))

    def press(self, path=None):
        return unsubscribe_workshop_mod(str(self.game), str(path or self.mod))

    def test_unsubscribes_the_item_and_removes_its_folder(self):
        with mock.patch.object(steam_workshop, "unsubscribe_item", return_value=True) as unsubscribe:
            response = self.press()

        self.assertTrue(response["success"], response)
        unsubscribe.assert_called_once_with("3816274470")
        self.assertFalse(self.item.exists())

    def test_steam_closed_is_its_own_code_and_keeps_the_mod(self):
        error = steam_workshop.SteamError("Steam is not running. Start Steam, sign in, and try again.")
        with mock.patch.object(steam_workshop, "unsubscribe_item", side_effect=error):
            response = self.press()

        self.assertEqual(response["code"], "STEAM_UNAVAILABLE")
        self.assertTrue(self.mod.exists())

    def test_steam_saying_no_keeps_the_mod(self):
        with mock.patch.object(steam_workshop, "unsubscribe_item", return_value=False):
            response = self.press()

        self.assertEqual(response["code"], "UNSUBSCRIBE_REFUSED")
        self.assertTrue(self.mod.exists())

    def test_a_local_mod_is_refused_without_asking_steam(self):
        local = self.game / "mods" / "Alpha.tmod"
        local.write_bytes(build_tmod("Alpha"))
        with mock.patch.object(steam_workshop, "unsubscribe_item") as unsubscribe:
            response = self.press(local)

        self.assertEqual(response["code"], "NOT_WORKSHOP")
        unsubscribe.assert_not_called()
        self.assertTrue(local.exists())


if __name__ == "__main__":
    unittest.main()
