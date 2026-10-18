"""Steam Workshop half of the Kiwi API blocklist.

Run with:  python -m unittest discover -s tests
"""

import unittest

from tests.support import FakeResponse, patch_http

import backend.mod_manager.blocklist as blocklist


class WorkshopListTests(unittest.TestCase):
    def test_items_and_authors_come_back_as_strings(self):
        payload = {"authors": [], "mods": [], "hashes": [],
                   "workshop_items": [3821965391], "workshop_authors": ["76561198357878692"]}
        with patch_http(get=lambda url, **kw: FakeResponse(payload=payload)):
            self.assertEqual(blocklist.workshop(), ({"3821965391"}, {"76561198357878692"}))

    def test_an_older_api_without_the_fields_lists_nothing(self):
        with patch_http(get=lambda url, **kw: FakeResponse(payload={"authors": [], "mods": [], "hashes": []})):
            self.assertEqual(blocklist.workshop(), (set(), set()))

    def test_no_answer_lists_nothing(self):
        with patch_http(get=lambda url, **kw: FakeResponse(status_code=503)):
            self.assertEqual(blocklist.workshop(), (set(), set()))


class WorkshopCreatorTests(unittest.TestCase):
    def test_creators_are_read_per_item(self):
        sent = {}

        def post(url, data=None, **kw):
            sent.update(data)
            return FakeResponse(payload={"response": {"publishedfiledetails": [
                {"publishedfileid": "111", "creator": "76561198357878692"},
                {"publishedfileid": "222", "result": 9},
            ]}})

        with patch_http(post=post):
            creators = blocklist.workshop_creators(["111", "222"])

        self.assertEqual(creators, {"111": "76561198357878692"})
        self.assertEqual(sent["itemcount"], 2)
        self.assertEqual(sent["publishedfileids[1]"], "222")

    def test_steam_not_answering_gives_nothing(self):
        def post(url, **kw):
            raise OSError("offline")

        with patch_http(post=post):
            self.assertEqual(blocklist.workshop_creators(["111"]), {})

    def test_nothing_installed_asks_steam_nothing(self):
        def post(url, **kw):
            raise AssertionError("asked Steam")

        with patch_http(post=post):
            self.assertEqual(blocklist.workshop_creators([]), {})


if __name__ == "__main__":
    unittest.main()
