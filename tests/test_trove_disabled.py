"""Mods switched off through Trove.cfg's `[Mods] DisabledMods`, by the player in
game or by Trove when it resolves a conflict.

Run with:  python -m unittest discover -s tests
"""

import json
import unittest
from unittest import mock

from tests.support import Sandbox, build_tmod

from backend.mod_manager.mod_manager import get_installed_mods, reenable_mod, toggle_mod
from backend.mod_manager.modpacks import _rebuild_tpack
from backend.mod_manager.profiles import _profile_file, apply_profile
from utils.path import get_cache_root
from utils.registry import TroveGamePath
from utils.trove_cfg import get_trove_cfg_path, read_disabled_mods, set_mods_disabled

CFG = "[Mods]\r\nDisableAllMods = \r\nDisabledMods = {}\r\nModDirectory = mods\r\n\r\n[UI]\r\nScale = \r\n"


class CfgTestCase(unittest.TestCase):
    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)
        self.cfg = get_trove_cfg_path()
        self.cfg.parent.mkdir(parents=True, exist_ok=True)

    def write_cfg(self, text):
        self.cfg.write_bytes(text.encode("utf-8"))


class TroveCfgTests(CfgTestCase):
    def test_reads_every_key(self):
        self.write_cfg(CFG.format("Workshop-Enhanced UI-Exodave & TheSymbol|Trove-Zakros UI - Inventory-Aallyn"))

        self.assertEqual(read_disabled_mods(),
                         {"Workshop-Enhanced UI-Exodave & TheSymbol", "Trove-Zakros UI - Inventory-Aallyn"})

    def test_only_the_mods_section_counts(self):
        self.write_cfg("[UI]\r\nDisabledMods = Trove-A-x\r\n[Mods]\r\nModDirectory = mods\r\n")

        self.assertEqual(read_disabled_mods(), set())

    def test_enable_and_disable_rewrite_only_that_line(self):
        self.write_cfg(CFG.format("Trove-A-x|Trove-B-x"))

        self.assertTrue(set_mods_disabled(enable=["Trove-A-x"], disable=["Trove-C-x", "Trove-B-x"]))

        self.assertEqual(self.cfg.read_bytes().decode("utf-8"), CFG.format("Trove-B-x|Trove-C-x"))

    def test_no_change_leaves_the_file_alone(self):
        self.write_cfg(CFG.format("Trove-A-x"))

        self.assertFalse(set_mods_disabled(enable=["Trove-Z-x"], disable=["Trove-A-x"]))

    def test_last_key_out_leaves_a_blank_value(self):
        self.write_cfg(CFG.format("Trove-A-x"))

        set_mods_disabled(enable=["Trove-A-x"])

        self.assertIn("DisabledMods = \r\n", self.cfg.read_bytes().decode("utf-8"))

    def test_missing_line_is_added_under_the_section(self):
        self.write_cfg("[Mods]\r\nModDirectory = mods\r\n")

        set_mods_disabled(disable=["Trove-A-x"])

        self.assertEqual(self.cfg.read_bytes().decode("utf-8"),
                         "[Mods]\r\nDisabledMods = Trove-A-x\r\nModDirectory = mods\r\n")

    def test_missing_section_is_appended(self):
        self.write_cfg("[UI]\r\nScale = ")

        set_mods_disabled(disable=["Trove-A-x"])

        self.assertEqual(self.cfg.read_bytes().decode("utf-8"),
                         "[UI]\r\nScale = \r\n[Mods]\r\nDisabledMods = Trove-A-x\r\n")
        self.assertEqual(read_disabled_mods(), {"Trove-A-x"})


class DisabledByTroveTests(CfgTestCase):
    def installed(self):
        get_installed_mods(self.sandbox.path)
        cache = get_cache_root() / "installed_mods.json"
        return {m["name"]: m for m in json.loads(cache.read_text(encoding="utf-8"))["mods"]}

    def test_a_listed_mod_shows_as_disabled_by_trove(self):
        self.sandbox.write("Alpha.tmod", build_tmod("Alpha", author="Aallyn"))
        self.sandbox.write("Beta.tmod", build_tmod("Beta", author="Aallyn", internal="ui/beta.swf"))
        self.write_cfg(CFG.format("Trove-Alpha-Aallyn"))

        mods = self.installed()

        self.assertEqual(mods["Alpha"]["status"], "disabled")
        self.assertTrue(mods["Alpha"]["disabled_by_trove"])
        self.assertEqual(mods["Beta"]["status"], "enabled")
        self.assertFalse(mods["Beta"]["disabled_by_trove"])

    def test_a_workshop_key_does_not_match_a_local_mod(self):
        self.sandbox.write("Alpha.tmod", build_tmod("Alpha", author="Aallyn"))
        self.write_cfg(CFG.format("Workshop-Alpha-Aallyn"))

        self.assertEqual(self.installed()["Alpha"]["status"], "enabled")

    def test_conflicts_report_the_effective_state(self):
        self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))
        self.sandbox.write("Beta.tmod", build_tmod("Beta"))
        self.write_cfg(CFG.format("Trove-Beta-tester"))

        self.assertEqual(self.installed()["Alpha"]["conflicts_with"], [{"name": "Beta", "enabled": False}])

    def test_toggle_re_enables_without_renaming(self):
        path = self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))
        self.write_cfg(CFG.format("Trove-Other-x|Trove-Alpha-tester"))

        result = toggle_mod(self.sandbox.path, str(path))

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual((result["status"], result["disabled_by_trove"]), ("enabled", False))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod"])
        self.assertEqual(read_disabled_mods(), {"Trove-Other-x"})

    def test_enabling_a_renamed_mod_also_clears_its_trove_entry(self):
        path = self.sandbox.write("Alpha.tmod.disabled", build_tmod("Alpha"))
        self.write_cfg(CFG.format("Trove-Alpha-tester"))

        result = toggle_mod(self.sandbox.path, str(path))

        self.assertEqual(result["status"], "enabled")
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod"])
        self.assertEqual(read_disabled_mods(), set())

    def test_reenable_switches_off_the_mods_it_conflicts_with(self):
        alpha = self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))
        self.sandbox.write("Beta.tmod", build_tmod("Beta"))
        self.sandbox.write("Gamma.tmod", build_tmod("Gamma", internal="ui/gamma.swf"))
        self.write_cfg(CFG.format("Trove-Alpha-tester"))

        result = reenable_mod(self.sandbox.path, str(alpha))

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod", "Beta.tmod.disabled", "Gamma.tmod"])
        self.assertEqual(read_disabled_mods(), set())


class WorkshopTests(CfgTestCase):
    """Steam owns Workshop files, so they are only ever switched in Trove.cfg."""

    def setUp(self):
        super().setUp()
        self.workshop = self.sandbox.root / "workshop" / "304050"
        (self.workshop / "123").mkdir(parents=True)
        patcher = mock.patch.object(TroveGamePath, "workshop_path",
                                    new_callable=mock.PropertyMock, return_value=self.workshop)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.path = self.workshop / "123" / "Alpha.tmod"
        self.path.write_bytes(build_tmod("Alpha", author="Soles"))

    def test_disabling_lists_it_instead_of_renaming(self):
        result = toggle_mod(self.sandbox.path, str(self.path))

        self.assertEqual((result["status"], result["disabled_by_trove"]), ("disabled", True))
        self.assertTrue(self.path.exists())
        self.assertEqual(read_disabled_mods(), {"Workshop-Alpha-Soles"})

    def test_enabling_takes_it_back_off_the_list(self):
        self.write_cfg(CFG.format("Workshop-Alpha-Soles"))

        result = toggle_mod(self.sandbox.path, str(self.path))

        self.assertEqual(result["status"], "enabled")
        self.assertEqual(read_disabled_mods(), set())

    def test_reenable_lists_a_conflicting_workshop_mod(self):
        local = self.sandbox.write("Alpha.tmod", build_tmod("Alpha", author="Soles"))
        self.write_cfg(CFG.format("Trove-Alpha-Soles"))

        reenable_mod(self.sandbox.path, str(local))

        self.assertTrue(self.path.exists())
        self.assertEqual(read_disabled_mods(), {"Workshop-Alpha-Soles"})


class ProfileTests(CfgTestCase):
    def save_profile(self, *mods):
        path = _profile_file("loadout")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_rebuild_tpack(1, [], [(f"{name}.tmod", build_tmod(name, internal=f"ui/{name}.swf"))
                                                for name in mods]))

    def test_applying_takes_the_profiles_mods_off_the_list(self):
        self.save_profile("Alpha", "Beta")
        self.write_cfg(CFG.format("Trove-Alpha-tester|Workshop-Beta-tester|Trove-Other-x"))

        result = apply_profile(self.sandbox.path, "loadout")

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod", "Beta.tmod"])
        self.assertEqual(read_disabled_mods(), {"Workshop-Beta-tester", "Trove-Other-x"})


if __name__ == "__main__":
    unittest.main()
