"""Update-path tests for the Mod Manager and the Trovesaurus tab.

Run with:  python -m unittest discover -s tests
"""

import unittest
from pathlib import Path
from unittest import mock

import eel
import gevent

from tests.support import Sandbox, FakeTrovesaurus, build_tmod, build_zip_mod

import backend.mod_manager.mod_manager as mod_manager
import backend.mod_manager.trovesaurus as trovesaurus


class UpdateTestCase(unittest.TestCase):
    """One sandbox install + one fake Trovesaurus per test."""

    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)
        trovesaurus._local_hash_cache.clear()

        self.api = FakeTrovesaurus()
        patcher = self.api.patch()
        patcher.start()
        self.addCleanup(patcher.stop)

    def publish(self, mod_id, name, file_id, data, fmt="tmod"):
        """Register `data` as mod `mod_id`'s file `file_id` on the fake API."""
        digest = self._hash_of_bytes(data, fmt)
        self.api.mod(mod_id, name, file_id, digest, fmt=fmt)
        self.api.serve(file_id, data)
        self.api.link(digest, mod_id)
        return digest

    def publish_config(self, mod_id, name, file_id, text=b"[s]\nk=v\n"):
        """A .cfg upload: same mod, `extra` flagged, no content hash to match."""
        self.api.mod(mod_id, name, file_id, "", fmt="config", extra=1)
        self.api.serve(file_id, text)

    def _hash_of_bytes(self, data, fmt):
        """Content hash of a mod file, as the app computes it for a file on disk."""
        with Sandbox() as scratch:
            scratch.write(f"probe.{'zip' if fmt == 'zip' else 'tmod'}", data)
            return next(iter(scratch.mod_list())).hash

    def install(self, filename, data):
        return self.sandbox.write(filename, data)

    def updates(self):
        response = mod_manager.check_mod_updates(self.sandbox.path)
        self.assertTrue(response["success"], response.get("error"))
        return {Path(p).name for p in response["data"]["updates"]}


class HasUpdateTests(UpdateTestCase):
    def test_no_update_when_installed_file_is_the_published_one(self):
        data = build_tmod("Alpha")
        self.publish(1, "Alpha", 100, data)
        self.install("Alpha.tmod", data)

        self.assertEqual(self.updates(), set())

    def test_update_detected_when_a_newer_file_is_published(self):
        old = build_tmod("Alpha", payload=b"v1")
        new = build_tmod("Alpha", payload=b"v2")
        self.publish(1, "Alpha", 100, old)
        self.publish(1, "Alpha", 200, new)
        self.install("Alpha.tmod", old)

        self.assertEqual(self.updates(), {"Alpha.tmod"})

    def test_config_upload_is_not_an_update(self):
        """A .cfg posted after the mod file has a higher file id but must not
        make the mod look outdated."""
        data = build_tmod("Alpha")
        self.publish(1, "Alpha", 100, data)
        self.publish_config(1, "Alpha", 300)
        self.install("Alpha.tmod", data)

        self.assertEqual(self.updates(), set())

    def test_unknown_mod_is_never_flagged(self):
        self.install("Homemade.tmod", build_tmod("Homemade"))

        self.assertEqual(self.updates(), set())


class PerformUpdateTests(UpdateTestCase):
    def setUp(self):
        super().setUp()
        self.old = build_tmod("Alpha", payload=b"v1")
        self.new = build_tmod("Alpha", payload=b"v2")
        self.publish(1, "Alpha", 100, self.old)
        self.new_hash = self.publish(1, "Alpha", 200, self.new)

    def update(self, filename):
        response = mod_manager.perform_mod_update(
            self.sandbox.path, str(self.sandbox.mods / filename)
        )
        self.assertTrue(response["success"], response.get("error"))
        return response

    def test_enabled_mod_is_replaced_in_place(self):
        self.install("Alpha.tmod", self.old)
        self.update("Alpha.tmod")

        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod"])
        self.assertEqual(self.sandbox.hash_of("Alpha.tmod"), self.new_hash)
        self.assertEqual(self.updates(), set())

    def test_disabled_mod_stays_disabled(self):
        self.install("Alpha.tmod.disabled", self.old)
        self.update("Alpha.tmod.disabled")

        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod.disabled"])
        self.assertEqual(self.sandbox.hash_of("Alpha.tmod.disabled"), self.new_hash)

    def test_custom_filename_is_preserved(self):
        self.install("zzz my rename.tmod", self.old)
        self.update("zzz my rename.tmod")

        self.assertEqual(self.sandbox.filenames(), ["zzz my rename.tmod"])
        self.assertEqual(self.sandbox.hash_of("zzz my rename.tmod"), self.new_hash)

    def test_format_change_leaves_no_stale_copy(self):
        """A mod republished as .zip must not leave the old .tmod behind."""
        zip_bytes = build_zip_mod(payload=b"v3")
        zip_hash = self.publish(1, "Alpha", 300, zip_bytes, fmt="zip")
        self.install("Alpha.tmod", self.old)
        self.update("Alpha.tmod")

        self.assertEqual(self.sandbox.filenames(), ["Alpha.zip"])
        self.assertEqual(self.sandbox.hash_of("Alpha.zip"), zip_hash)

    def test_update_reports_missing_mod_instead_of_raising(self):
        self.install("Alpha.tmod", self.old)
        response = mod_manager.perform_mod_update(
            self.sandbox.path, str(self.sandbox.mods / "Nope.tmod")
        )
        self.assertFalse(response["success"])
        self.assertEqual(response["code"], "MOD_NOT_FOUND")


class ModUrlTests(UpdateTestCase):
    def test_installed_mods_get_their_trovesaurus_link(self):
        data = build_tmod("Alpha")
        self.publish(1, "Alpha", 100, data)
        path = self.install("Alpha.tmod", data)

        response = mod_manager.get_mod_urls(self.sandbox.path)

        self.assertTrue(response["success"], response.get("error"))
        self.assertEqual(
            response["data"]["urls"], {str(path): "https://trovesaurus.com/mod=1"}
        )

    def test_empty_mods_folder_is_not_an_error(self):
        response = mod_manager.get_mod_urls(self.sandbox.path)

        self.assertTrue(response["success"], response.get("error"))
        self.assertEqual(response["data"]["urls"], {})


class TrovesaurusTabTests(UpdateTestCase):
    """The Trovesaurus browse tab: install/update buttons and the installed +
    outdated badges shown on each card."""

    def install_from_tab(self, mod_id):
        results = []
        eel.receive_install_result = lambda payload: (lambda: results.append(payload))
        trovesaurus.install_trovesaurus_mod(self.sandbox.path, mod_id)
        for _ in range(200):
            if results:
                break
            gevent.sleep(0.01)
        self.assertTrue(results, "install never reported a result")
        return results[0]

    def test_install_writes_the_mod(self):
        data = build_tmod("Alpha")
        self.publish(1, "Alpha", 100, data)

        result = self.install_from_tab(1)

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod"])

    def test_update_replaces_a_renamed_file_instead_of_duplicating_it(self):
        """Auto-fix-names (and manual renames) mean the file on disk often isn't
        named after the Trovesaurus title. Updating must take over that file, not
        drop a second copy of the same mod next to it."""
        old = build_tmod("Alpha", payload=b"v1")
        new = build_tmod("Alpha", payload=b"v2")
        self.publish(1, "Alpha", 100, old)
        new_hash = self.publish(1, "Alpha", 200, new)
        self.install("Alpha v1 renamed.tmod", old)

        result = self.install_from_tab(1)

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha v1 renamed.tmod"])
        self.assertEqual(self.sandbox.hash_of("Alpha v1 renamed.tmod"), new_hash)

    def test_update_to_a_different_format_leaves_no_stale_copy(self):
        old = build_tmod("Alpha", payload=b"v1")
        self.publish(1, "Alpha", 100, old)
        zip_hash = self.publish(1, "Alpha", 200, build_zip_mod(payload=b"v2"), fmt="zip")
        self.install("Alpha.tmod", old)

        result = self.install_from_tab(1)

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.zip"])
        self.assertEqual(self.sandbox.hash_of("Alpha.zip"), zip_hash)

    def test_update_keeps_a_disabled_mod_disabled(self):
        old = build_tmod("Alpha", payload=b"v1")
        new = build_tmod("Alpha", payload=b"v2")
        self.publish(1, "Alpha", 100, old)
        self.publish(1, "Alpha", 200, new)
        self.install("Alpha.tmod.disabled", old)

        result = self.install_from_tab(1)

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod.disabled"])

    def test_install_never_downloads_a_config_file(self):
        data = build_tmod("Alpha")
        self.publish(1, "Alpha", 100, data)
        self.publish_config(1, "Alpha", 300)

        result = self.install_from_tab(1)

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod"])

    def test_delete_removes_the_installed_file(self):
        data = build_tmod("Alpha")
        self.publish(1, "Alpha", 100, data)
        self.install("Alpha.tmod", data)

        response = trovesaurus.delete_trovesaurus_installed_mod(self.sandbox.path, 1)

        self.assertTrue(response["success"], response.get("error"))
        self.assertEqual(self.sandbox.filenames(), [])

    def test_delete_reports_a_missing_game_path(self):
        response = trovesaurus.delete_trovesaurus_installed_mod("", 1)

        self.assertFalse(response["success"])
        self.assertEqual(response["code"], "MISSING_GAME_PATH")

    def test_badges_clear_after_the_mod_manager_updates_a_mod(self):
        """Updating from the Mod Manager overwrites the file in place, which does
        not change the mods folder's mtime -- the browse tab must still notice."""
        old = build_tmod("Alpha", payload=b"v1")
        new = build_tmod("Alpha", payload=b"v2")
        self.publish(1, "Alpha", 100, old)
        self.publish(1, "Alpha", 200, new)
        self.install("Alpha.tmod", old)

        before = trovesaurus._compute_installed_states(
            self.sandbox.path, list(self.api.mods.values())
        )
        self.assertTrue(before["1"]["needs_update"])

        mod_manager.perform_mod_update(
            self.sandbox.path, str(self.sandbox.mods / "Alpha.tmod")
        )

        after = trovesaurus._compute_installed_states(
            self.sandbox.path, list(self.api.mods.values())
        )
        self.assertFalse(after["1"]["needs_update"])

    def test_a_failed_lookup_is_not_remembered_as_nothing_installed(self):
        """Offline once shouldn't wipe the badges until the user next touches the
        mods folder -- the next call has to try again."""
        data = build_tmod("Alpha")
        self.publish(1, "Alpha", 100, data)
        self.install("Alpha.tmod", data)

        with mock.patch("requests.post", side_effect=OSError("offline")):
            self.assertEqual(
                trovesaurus._compute_installed_states(
                    self.sandbox.path, list(self.api.mods.values())
                ),
                {},
            )

        recovered = trovesaurus._compute_installed_states(
            self.sandbox.path, list(self.api.mods.values())
        )
        self.assertTrue(recovered["1"]["is_installed"])

    def test_badges_appear_when_a_new_release_lands_mid_session(self):
        """Nothing changed locally, but the catalog did. A forced refresh has to
        re-check instead of replaying the cached verdict."""
        old = build_tmod("Alpha", payload=b"v1")
        self.publish(1, "Alpha", 100, old)
        self.install("Alpha.tmod", old)

        first = trovesaurus._compute_installed_states(
            self.sandbox.path, list(self.api.mods.values())
        )
        self.assertFalse(first["1"]["needs_update"])

        self.publish(1, "Alpha", 200, build_tmod("Alpha", payload=b"v2"))

        refreshed = trovesaurus._compute_installed_states(
            self.sandbox.path, list(self.api.mods.values()), force=True
        )
        self.assertTrue(refreshed["1"]["needs_update"])


class RefreshTests(UpdateTestCase):
    def test_forced_check_sees_a_release_published_after_the_last_check(self):
        """The master mod list is cached for 15 minutes. Pressing Refresh has to
        go past that cache, otherwise a fresh release stays invisible."""
        old = build_tmod("Alpha", payload=b"v1")
        self.publish(1, "Alpha", 100, old)
        self.install("Alpha.tmod", old)

        self.assertEqual(self.updates(), set())

        self.publish(1, "Alpha", 200, build_tmod("Alpha", payload=b"v2"))

        self.assertEqual(self.updates(), set(), "cached list should be reused")

        forced = mod_manager.check_mod_updates(self.sandbox.path, force=True)
        self.assertTrue(forced["success"], forced.get("error"))
        self.assertEqual(
            {Path(p).name for p in forced["data"]["updates"]}, {"Alpha.tmod"}
        )


if __name__ == "__main__":
    unittest.main()
