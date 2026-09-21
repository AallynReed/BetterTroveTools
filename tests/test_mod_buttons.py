"""The rest of the mod card's buttons: enable/disable, delete + undo, the
update lock, and the hand-off between the two mod sources.

Run with:  python -m unittest discover -s tests
"""

import hashlib
import unittest
from unittest import mock

from tests.support import Sandbox, FakeResponse, FakeTrovesaurus, build_tmod, patch_http

from backend.mod_manager.mod_manager import (
    delete_mod,
    get_installed_mods,
    perform_mod_update,
    set_mod_update_lock,
    toggle_mod,
    undo_delete_mod,
)


class CardButtonTestCase(unittest.TestCase):
    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)


class ToggleTests(CardButtonTestCase):
    def test_toggle_disables_then_re_enables_in_place(self):
        path = self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))

        off = toggle_mod(self.sandbox.path, str(path))
        self.assertTrue(off["success"], off.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod.disabled"])

        on = toggle_mod(self.sandbox.path, off["new_path"])
        self.assertTrue(on["success"], on.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod"])

    def test_toggle_reports_the_new_path_the_card_has_to_switch_to(self):
        path = self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))

        result = toggle_mod(self.sandbox.path, str(path))

        self.assertEqual(result["new_path"], str(self.sandbox.mods / "Alpha.tmod.disabled"))

    def test_toggle_does_not_change_the_file_contents(self):
        data = build_tmod("Alpha")
        path = self.sandbox.write("Alpha.tmod", data)

        result = toggle_mod(self.sandbox.path, str(path))

        self.assertEqual((self.sandbox.mods / "Alpha.tmod.disabled").read_bytes(), data)
        self.assertTrue(result["success"])

    def test_toggling_an_unknown_path_is_an_error_not_a_crash(self):
        result = toggle_mod(self.sandbox.path, str(self.sandbox.mods / "Nope.tmod"))

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "MOD_NOT_FOUND")

    def test_a_collision_is_reported_instead_of_losing_a_file(self):
        """Both names already taken -- neither file may be clobbered."""
        enabled = self.sandbox.write("Alpha.tmod", build_tmod("Alpha", payload=b"on"))
        self.sandbox.write("Alpha.tmod.disabled", build_tmod("Alpha", payload=b"off"))

        result = toggle_mod(self.sandbox.path, str(enabled))

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "TOGGLE_COLLISION")
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod", "Alpha.tmod.disabled"])


class DeleteTests(CardButtonTestCase):
    def test_delete_then_undo_restores_the_exact_file(self):
        data = build_tmod("Alpha")
        path = self.sandbox.write("Alpha.tmod", data)

        removed = delete_mod(self.sandbox.path, str(path))
        self.assertTrue(removed["success"], removed.get("error"))
        self.assertEqual(self.sandbox.filenames(), [])

        restored = undo_delete_mod(removed["undo_token"])
        self.assertTrue(restored["success"], restored.get("error"))
        self.assertEqual(path.read_bytes(), data)

    def test_undo_is_one_shot(self):
        path = self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))
        token = delete_mod(self.sandbox.path, str(path))["undo_token"]
        self.assertTrue(undo_delete_mod(token)["success"])

        again = undo_delete_mod(token)

        self.assertFalse(again["success"])
        self.assertEqual(again["code"], "UNDO_TOKEN_NOT_FOUND")

    def test_undo_refuses_to_overwrite_a_file_put_back_by_hand(self):
        path = self.sandbox.write("Alpha.tmod", build_tmod("Alpha", payload=b"old"))
        token = delete_mod(self.sandbox.path, str(path))["undo_token"]
        replacement = build_tmod("Alpha", payload=b"new")
        self.sandbox.write("Alpha.tmod", replacement)

        result = undo_delete_mod(token)

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "UNDO_CONFLICT")
        self.assertEqual(path.read_bytes(), replacement)

    def test_delete_refuses_a_path_outside_the_mods_folder(self):
        outside = self.sandbox.root / "not-a-mod.tmod"
        outside.write_bytes(build_tmod("Alpha"))

        result = delete_mod(self.sandbox.path, str(outside))

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "INVALID_PATH")
        self.assertTrue(outside.exists())

    def test_delete_removes_a_disabled_mod(self):
        path = self.sandbox.write("Alpha.tmod.disabled", build_tmod("Alpha"))

        result = delete_mod(self.sandbox.path, str(path))

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), [])


class LockTests(CardButtonTestCase):
    def test_a_lock_survives_the_mod_being_toggled(self):
        """Toggling renames the file, so a lock keyed on the full path would
        quietly come undone the moment the user switched the mod off."""
        path = self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))
        set_mod_update_lock(self.sandbox.path, str(path), True)

        new_path = toggle_mod(self.sandbox.path, str(path))["new_path"]

        get_installed_mods(self.sandbox.path)
        listed = self.installed()
        self.assertEqual([m["path"] for m in listed], [new_path])
        self.assertTrue(listed[0]["locked"])

    def test_unlocking_clears_the_flag(self):
        path = self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))
        set_mod_update_lock(self.sandbox.path, str(path), True)
        set_mod_update_lock(self.sandbox.path, str(path), False)

        get_installed_mods(self.sandbox.path)

        self.assertFalse(self.installed()[0]["locked"])

    def test_locks_are_per_install(self):
        path = self.sandbox.write("Alpha.tmod", build_tmod("Alpha"))
        set_mod_update_lock(str(self.sandbox.root / "OtherInstall"), str(path), True)

        get_installed_mods(self.sandbox.path)

        self.assertFalse(self.installed()[0]["locked"])

    def installed(self):
        import json
        from utils.path import get_cache_root
        cache = get_cache_root() / "installed_mods.json"
        return json.loads(cache.read_text(encoding="utf-8"))["mods"]


class LockedUpdateTests(unittest.TestCase):
    """A locked mod must not be updated by either source, even if the card that
    asked was stale."""

    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)
        self.api = FakeTrovesaurus()
        patcher = self.api.patch()
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_trovesaurus_update_is_refused_for_a_locked_mod(self):
        old = build_tmod("Alpha", payload=b"v1")
        new = build_tmod("Alpha", payload=b"v2")
        self.api.mod(1, "Alpha", 10, hashlib.md5(old).hexdigest())
        self.api.mod(1, "Alpha", 11, hashlib.md5(new).hexdigest())
        self.api.serve(11, new)
        path = self.sandbox.write("Alpha.tmod", old)
        self.api.link(self.sandbox.hash_of("Alpha.tmod"), 1)
        set_mod_update_lock(self.sandbox.path, str(path), True)

        result = perform_mod_update(self.sandbox.path, str(path))

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "MOD_LOCKED")
        self.assertEqual(path.read_bytes(), old)


class SourceHandoffTests(unittest.TestCase):
    """A mod the Mods Hub owns must not also be asked about on Trovesaurus --
    two sources answering for one card is how a badge ends up contradicting
    itself."""

    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)

        import backend.mod_manager.mods_hub as mods_hub
        self.mods_hub = mods_hub
        mods_hub._install_state_cache.clear()
        mods_hub._detail_cache.clear()

        from tests.test_mods_hub_updates import FakeKiwi
        self.hub = FakeKiwi()
        self.ts = FakeTrovesaurus()
        patcher = patch_http(get=self._get, post=self._post, head=lambda url, **k: FakeResponse())
        patcher.start()
        self.addCleanup(patcher.stop)

    def _route(self, url, kind, **kwargs):
        if "trovesaurus" in url:
            return getattr(self.ts, kind)(url, **kwargs)
        return getattr(self.hub, kind)(url, **kwargs)

    def _get(self, url, **kwargs):
        return self._route(url, "get", **kwargs)

    def _post(self, url, **kwargs):
        return self._route(url, "post", **kwargs)

    def test_a_hub_mod_is_left_out_of_the_trovesaurus_pass(self):
        from backend.mod_manager.mod_manager import check_mod_updates, get_mod_urls

        hub_data = build_tmod("Alpha", payload=b"v1")
        self.hub.release("aallyn/alpha", "Alpha", "main", "v1", hub_data,
                         published_at="2026-01-01T00:00:00Z")
        self.hub.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        hub_path = self.sandbox.write("Alpha.tmod", hub_data)

        # The same mod also "exists" on Trovesaurus, with a different idea of
        # what is current. The hub owns it, so Trovesaurus must not be asked.
        self.ts.mod(1, "Alpha", 10, "deadbeef")
        self.ts.link(self.sandbox.hash_of("Alpha.tmod"), 1)

        updates = check_mod_updates(self.sandbox.path, True)["data"]["updates"]
        urls = get_mod_urls(self.sandbox.path)["data"]["urls"]

        self.assertNotIn(str(hub_path), updates)
        self.assertNotIn(str(hub_path), urls)
        hub_states = self.mods_hub.get_mods_hub_install_states(self.sandbox.path, True)["data"]["states"]
        self.assertTrue(hub_states[str(hub_path)]["has_update"])

    def test_a_non_hub_mod_still_reaches_trovesaurus(self):
        from backend.mod_manager.mod_manager import check_mod_updates

        old = build_tmod("Beta", payload=b"v1")
        new = build_tmod("Beta", payload=b"v2")
        self.ts.mod(2, "Beta", 20, hashlib.md5(old).hexdigest())
        self.ts.mod(2, "Beta", 21, hashlib.md5(new).hexdigest())
        path = self.sandbox.write("Beta.tmod", old)
        self.ts.link(self.sandbox.hash_of("Beta.tmod"), 2)

        updates = check_mod_updates(self.sandbox.path, True)["data"]["updates"]

        self.assertIn(str(path), updates)


if __name__ == "__main__":
    unittest.main()
