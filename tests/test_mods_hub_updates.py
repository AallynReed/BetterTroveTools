"""Update-path tests for the Mods Hub tab (Kiwi API).

Run with:  python -m unittest discover -s tests
"""

import copy
import hashlib
import unittest
from unittest import mock

from tests.support import Sandbox, FakeResponse, build_tmod, build_zip_mod, patch_http

import backend.mod_manager.mods_hub as mods_hub


class FakeKiwi:
    """Stand-in for api.aallyn.net/v1: hash lookup, mod detail, and downloads."""

    def __init__(self):
        self.mods = {}      # ref -> {"title", "releases": [...]}
        self.artifacts = {} # download url -> bytes
        self.include_releases = True  # False = an older hub with no include_releases

    def release(self, ref, title, branch, tag, data, fmt="tmod", published_at="2026-01-01T00:00:00Z"):
        url = f"https://cdn.example/{ref}/{branch}/{tag}"
        entry = self.mods.setdefault(ref, {"title": title, "handle": ref.split("/")[0],
                                           "slug": ref.split("/")[-1], "releases": []})
        entry["releases"].append({
            "branch": branch,
            "tag": tag,
            "title": tag,
            "format": fmt,
            "filename": f"{title}.{fmt}",
            "sha256": hashlib.sha256(data).hexdigest(),
            "published_at": published_at,
            "download_url": url,
            "size": len(data),
        })
        self.artifacts[url] = data
        return entry["releases"][-1]

    def _release_by_hash(self, digest):
        for ref, entry in self.mods.items():
            for release in entry["releases"]:
                if release["sha256"] == digest:
                    return ref, entry, release
        return None, None, None

    def get(self, url, **kwargs):
        if url in self.artifacts:
            return FakeResponse(content=self.artifacts[url])
        if "/mods/" in url:
            ref = url.split("/mods/", 1)[1]
            entry = self.mods.get(ref)
            if entry is None:
                return FakeResponse(status_code=404)
            # Deep-copied on purpose: handing out the live list would let a
            # cached detail quietly grow a release published after it was cached,
            # which is exactly the staleness these tests need to be able to see.
            return FakeResponse(payload=copy.deepcopy(
                {"title": entry["title"], "handle": entry["handle"],
                 "slug": entry["slug"], "releases": entry["releases"]}))
        return FakeResponse(status_code=404)

    def post(self, url, **kwargs):
        if url.endswith("/mods/lookup"):
            body = kwargs.get("json") or {}
            results = {}
            for digest in body.get("hashes", []):
                ref, entry, release = self._release_by_hash(digest)
                if not ref:
                    continue
                mod = {"slug": entry["slug"], "handle": entry["handle"],
                       "title": entry["title"], "page_url": f"https://trove.aallyn.net/mods/{ref}"}
                # The live hub answers `include_releases` with the LATEST release
                # per branch, not the whole history -- which is all the outdated
                # check needs. `self.include_releases = False` plays an older hub
                # that ignores the flag, so the per-ref detail fallback runs.
                if body.get("include_releases") and self.include_releases:
                    mod["releases"] = self._latest_per_branch(entry)
                results[digest] = {"mod": mod, "release": release}
            return FakeResponse(payload=copy.deepcopy({"results": results}))
        return FakeResponse(status_code=404)

    def _latest_per_branch(self, entry):
        newest = {}
        for release in entry["releases"]:
            branch = release.get("branch")
            if branch not in newest or release["published_at"] > newest[branch]["published_at"]:
                newest[branch] = release
        return sorted(newest.values(), key=lambda r: r["published_at"], reverse=True)

    def patch(self):
        return patch_http(get=self.get, post=self.post)


class ModsHubTestCase(unittest.TestCase):
    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.addCleanup(self.sandbox.__exit__, None, None, None)
        mods_hub._install_state_cache.clear()
        mods_hub._detail_cache.clear()

        self.api = FakeKiwi()
        patcher = self.api.patch()
        patcher.start()
        self.addCleanup(patcher.stop)

    def states(self, force=False):
        response = mods_hub.get_mods_hub_install_states(self.sandbox.path, force)
        self.assertTrue(response["success"], response.get("error"))
        return response["data"]["states"]


class InstallStateTests(ModsHubTestCase):
    def test_installed_mod_is_recognised_with_its_branch(self):
        data = build_tmod("Alpha")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", data)
        path = self.sandbox.write("Alpha.tmod", data)

        state = self.states()[str(path)]

        self.assertEqual(state["ref"], "aallyn/alpha")
        self.assertEqual(state["branch"], "main")
        self.assertFalse(state["has_update"])

    def test_newer_release_on_the_same_branch_is_an_update(self):
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        path = self.sandbox.write("Alpha.tmod", old)

        self.assertTrue(self.states()[str(path)]["has_update"])

    def test_newer_release_on_another_variant_is_not_an_update(self):
        installed = build_tmod("Alpha", payload=b"lite")
        self.api.release("aallyn/alpha", "Alpha", "lite", "v1", installed, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "full", "v9",
                         build_tmod("Alpha", payload=b"full"), published_at="2026-03-01T00:00:00Z")
        path = self.sandbox.write("Alpha.tmod", installed)

        self.assertFalse(self.states()[str(path)]["has_update"])

    def test_state_follows_a_file_replaced_in_place(self):
        """Overwriting a mod file doesn't change the mods folder's mtime, so a
        cache keyed on that would keep reporting the old release."""
        old = build_tmod("Alpha", payload=b"v1")
        new = build_tmod("Alpha", payload=b"v2")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2", new, published_at="2026-02-01T00:00:00Z")
        path = self.sandbox.write("Alpha.tmod", old)

        self.assertTrue(self.states()[str(path)]["has_update"])

        path.write_bytes(new)

        self.assertFalse(self.states()[str(path)]["has_update"])

    def test_forced_refresh_sees_a_release_published_mid_session(self):
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        path = self.sandbox.write("Alpha.tmod", old)

        self.assertFalse(self.states()[str(path)]["has_update"])

        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")

        self.assertFalse(self.states()[str(path)]["has_update"], "cache should be reused")
        self.assertTrue(self.states(force=True)[str(path)]["has_update"])

    def test_a_failed_lookup_is_not_remembered_as_no_hub_mods(self):
        """Offline once shouldn't hide every hub mod until the user next touches
        the mods folder -- the next call has to try again."""
        data = build_tmod("Alpha")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", data)
        path = self.sandbox.write("Alpha.tmod", data)

        with patch_http(post=mock.Mock(side_effect=OSError("offline"))):
            self.assertEqual(self.states(), {})

        self.assertIn(str(path), self.states())


class HubUpdateTests(ModsHubTestCase):
    def install(self, ref, branch=None):
        response = mods_hub.install_mods_hub_mod_sync(self.sandbox.path, ref, branch)
        self.assertTrue(response["success"], response.get("error"))
        return response

    def test_update_replaces_the_previous_file(self):
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        self.sandbox.write("Alpha renamed by hand.tmod", old)

        self.install("aallyn/alpha")

        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod"])
        self.assertFalse(next(iter(self.states().values()))["has_update"])

    def test_variant_switch_leaves_one_file(self):
        lite = build_tmod("Alpha", payload=b"lite")
        self.api.release("aallyn/alpha", "Alpha", "lite", "v1", lite, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "full", "v1",
                         build_zip_mod(payload=b"full"), fmt="zip", published_at="2026-01-02T00:00:00Z")
        self.sandbox.write("Alpha.tmod", lite)

        self.install("aallyn/alpha", branch="full")

        self.assertEqual(self.sandbox.filenames(), ["Alpha.zip"])
        self.assertEqual(next(iter(self.states().values()))["branch"], "full")

    def test_update_clears_the_flag_without_a_forced_refresh(self):
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        self.sandbox.write("Alpha.tmod", old)
        self.assertTrue(next(iter(self.states().values()))["has_update"])

        self.install("aallyn/alpha")

        self.assertFalse(next(iter(self.states().values()))["has_update"])


class HubUpdateEdgeCaseTests(ModsHubTestCase):
    """The paths behind "I clicked Update and it still says there's an update"."""

    def install(self, ref, branch=None):
        return mods_hub.install_mods_hub_mod_sync(self.sandbox.path, ref, branch)

    def only_state(self):
        states = self.states()
        self.assertEqual(len(states), 1, states)
        return next(iter(states.values()))

    def test_update_keeps_a_disabled_mod_disabled(self):
        """A mod the user turned off must stay off after an update -- otherwise
        updating silently re-enables it in game."""
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        self.sandbox.write("Alpha.tmod.disabled", old)

        self.assertTrue(self.install("aallyn/alpha")["success"])

        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod.disabled"])

    def test_update_of_a_disabled_mod_clears_the_flag(self):
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        self.sandbox.write("Alpha.tmod.disabled", old)

        self.assertTrue(self.install("aallyn/alpha")["success"])

        self.assertFalse(self.only_state()["has_update"])

    def test_a_stale_second_copy_does_not_keep_the_update_flag_set(self):
        """Two copies of the same mod (a hand-made backup, or a leftover
        `.disabled`) must not make Update look like it did nothing: the flag
        has to follow the newest copy, not whichever the hub listed first."""
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        self.sandbox.write("Alpha.tmod", old)
        self.sandbox.write("Alpha backup.tmod", old)

        self.assertTrue(self.install("aallyn/alpha")["success"])

        states = self.states()
        self.assertFalse(any(s["has_update"] for s in states.values()), states)

    def test_update_installs_a_release_published_since_the_detail_was_cached(self):
        """The mod detail is cached for five minutes. A refresh sees the new
        release through /lookup, so the Update button must not then download the
        release that was newest when the detail was cached."""
        v1 = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", v1, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        self.sandbox.write("Alpha.tmod", v1)

        # Opening the variant picker (or a previous install) caches the detail.
        mods_hub.get_mods_hub_variants("aallyn/alpha")

        v3 = build_tmod("Alpha", payload=b"v3")
        self.api.release("aallyn/alpha", "Alpha", "main", "v3", v3, published_at="2026-03-01T00:00:00Z")
        self.assertTrue(self.states(force=True)[str(self.sandbox.mods / "Alpha.tmod")]["has_update"])

        self.assertTrue(self.install("aallyn/alpha", "main")["success"])

        self.assertEqual((self.sandbox.mods / "Alpha.tmod").read_bytes(), v3)
        self.assertFalse(self.only_state()["has_update"])

    def test_a_locked_mod_is_not_updated(self):
        """The lock is a user pin the backend enforces for Trovesaurus mods; a
        hub mod must not be updatable around it either."""
        from backend.mod_manager.mod_manager import set_mod_update_lock

        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        path = self.sandbox.write("Alpha.tmod", old)
        set_mod_update_lock(self.sandbox.path, str(path), True)

        result = self.install("aallyn/alpha")

        self.assertFalse(result["success"], result)
        self.assertEqual(path.read_bytes(), old)

    def test_an_older_hub_without_include_releases_still_updates(self):
        self.api.include_releases = False
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        self.sandbox.write("Alpha.tmod", old)
        self.assertTrue(self.only_state()["has_update"])

        self.assertTrue(self.install("aallyn/alpha")["success"])

        self.assertFalse(self.only_state()["has_update"])

    def test_a_failed_download_leaves_the_installed_file_alone(self):
        old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", old, published_at="2026-01-01T00:00:00Z")
        new = self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                               build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        path = self.sandbox.write("Alpha.tmod", old)
        self.api.artifacts.pop(new["download_url"])

        result = self.install("aallyn/alpha")

        self.assertFalse(result["success"], result)
        self.assertEqual(path.read_bytes(), old)
        self.assertEqual(self.sandbox.filenames(), ["Alpha.tmod"])

    def test_delete_removes_a_disabled_hub_mod(self):
        data = build_tmod("Alpha")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", data)
        self.sandbox.write("Alpha.tmod.disabled", data)

        result = mods_hub.delete_mods_hub_installed_mod(self.sandbox.path, "aallyn/alpha")

        self.assertTrue(result["success"], result.get("error"))
        self.assertEqual(self.sandbox.filenames(), [])


class AutoUpdateTests(ModsHubTestCase):
    """The launch-time auto-updater, which drives both sources at once."""

    def test_hub_mods_are_updated_and_locked_ones_skipped(self):
        from backend.mod_manager.mod_manager import auto_update_unlocked_mods, set_mod_update_lock

        a_old = build_tmod("Alpha", payload=b"v1")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", a_old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2",
                         build_tmod("Alpha", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        self.sandbox.write("Alpha.tmod", a_old)

        b_old = build_tmod("Beta", payload=b"v1")
        self.api.release("aallyn/beta", "Beta", "main", "v1", b_old, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/beta", "Beta", "main", "v2",
                         build_tmod("Beta", payload=b"v2"), published_at="2026-02-01T00:00:00Z")
        beta = self.sandbox.write("Beta.tmod", b_old)
        set_mod_update_lock(self.sandbox.path, str(beta), True)

        updated, failed = auto_update_unlocked_mods(self.sandbox.path)

        self.assertEqual(updated, ["Alpha"])
        self.assertEqual(failed, [])
        self.assertEqual(beta.read_bytes(), b_old)


class DuplicateCopyTests(ModsHubTestCase):
    """Users keep spare copies of a mod -- a hand-made backup, or an old build
    parked as `.disabled`. Several local files then resolve to one hub mod, and
    which of them the state follows must not come down to folder order."""

    def install(self, ref, branch=None):
        return mods_hub.install_mods_hub_mod_sync(self.sandbox.path, ref, branch)

    def three_releases(self):
        v1 = build_tmod("Alpha", payload=b"v1")
        v2 = build_tmod("Alpha", payload=b"v2")
        v3 = build_tmod("Alpha", payload=b"v3")
        self.api.release("aallyn/alpha", "Alpha", "main", "v1", v1, published_at="2026-01-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v2", v2, published_at="2026-02-01T00:00:00Z")
        self.api.release("aallyn/alpha", "Alpha", "main", "v3", v3, published_at="2026-03-01T00:00:00Z")
        return v1, v2, v3

    def test_the_newest_of_two_enabled_copies_is_the_one_reported(self):
        v1, v2, _ = self.three_releases()
        self.sandbox.write("Alpha spare copy.tmod", v1)   # sorts first in the folder
        self.sandbox.write("Alpha.tmod", v2)

        states = self.states()

        self.assertEqual(len(states), 1, states)
        self.assertEqual(next(iter(states)), str(self.sandbox.mods / "Alpha.tmod"))

    def test_update_with_a_stale_spare_copy_clears_the_flag(self):
        """The reported symptom: Update runs, and the badge is still there."""
        v1, v2, v3 = self.three_releases()
        self.sandbox.write("Alpha spare copy.tmod", v1)
        self.sandbox.write("Alpha.tmod", v2)

        self.assertTrue(self.install("aallyn/alpha", "main")["success"])

        self.assertEqual((self.sandbox.mods / "Alpha.tmod").read_bytes(), v3)
        states = self.states()
        self.assertFalse(any(s["has_update"] for s in states.values()), states)

    def test_an_enabled_copy_wins_over_a_newer_disabled_one(self):
        """The game loads the enabled file, so that is the one whose version the
        update state has to be about."""
        v1, v2, _ = self.three_releases()
        self.sandbox.write("Alpha.tmod", v1)
        self.sandbox.write("Alpha.tmod.disabled", v2)

        states = self.states()

        self.assertEqual(len(states), 1, states)
        path, state = next(iter(states.items()))
        self.assertEqual(path, str(self.sandbox.mods / "Alpha.tmod"))
        self.assertTrue(state["has_update"])


if __name__ == "__main__":
    unittest.main()
