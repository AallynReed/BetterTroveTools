"""Update-path tests for the Mods Hub tab (Kiwi API).

Run with:  python -m unittest discover -s tests
"""

import hashlib
import unittest
from unittest import mock

from tests.support import Sandbox, FakeResponse, build_tmod, build_zip_mod

import backend.mod_manager.mods_hub as mods_hub


class FakeKiwi:
    """Stand-in for api.aallyn.net/v1: hash lookup, mod detail, and downloads."""

    def __init__(self):
        self.mods = {}      # ref -> {"title", "releases": [...]}
        self.artifacts = {} # download url -> bytes

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
            return FakeResponse(payload={"title": entry["title"], "releases": entry["releases"]})
        return FakeResponse(status_code=404)

    def post(self, url, **kwargs):
        if url.endswith("/mods/lookup"):
            results = {}
            for digest in (kwargs.get("json") or {}).get("hashes", []):
                ref, entry, release = self._release_by_hash(digest)
                if not ref:
                    continue
                results[digest] = {
                    "mod": {"slug": entry["slug"], "handle": entry["handle"],
                            "title": entry["title"], "page_url": f"https://trove.aallyn.net/mods/{ref}"},
                    "release": release,
                }
            return FakeResponse(payload={"results": results})
        return FakeResponse(status_code=404)

    def patch(self):
        return mock.patch.multiple("requests", get=self.get, post=self.post)


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

        with mock.patch("requests.post", side_effect=OSError("offline")):
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


if __name__ == "__main__":
    unittest.main()
