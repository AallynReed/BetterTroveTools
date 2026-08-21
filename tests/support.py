"""Shared scaffolding for the mod-update tests.

Everything here keeps the tests offline and off the real machine: a fake eel so
the backend's progress callbacks are no-ops, a temp %APPDATA% so caches never
touch the user's install, synthetic .tmod/.zip bytes built with the project's
own compiler (so hashes are real), and a URL-routed stand-in for requests.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import eel  # noqa: E402

# eel's JS bridge isn't running under test; every backend call site goes through
# these three, so stubbing them once keeps the modules importable and silent.
eel.add_external_request = lambda *a, **k: (lambda: None)
eel.remove_external_request = lambda *a, **k: (lambda: None)

from models.trove.mod import TMod, TroveModFile, TroveModList  # noqa: E402
from utils.registry import TroveGamePath  # noqa: E402
from utils.path import refresh_data_dir_override  # noqa: E402


def build_tmod(name, author="tester", payload=b"payload", internal="ui/test.swf"):
    """Bytes of a valid .tmod, built by the app's own compiler."""
    mod = TMod()
    mod.name = name
    mod.author = author
    mod_file = TroveModFile(Path(internal), payload)
    mod_file.index = 0
    mod.files = [mod_file]
    return mod.compile_tmod()


def build_zip_mod(payload=b"payload", internal="ui/test.swf"):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(internal, payload)
    return buffer.getvalue()


class Sandbox:
    """A throwaway Trove install (just a `mods` folder) plus an isolated cache
    root, so nothing under test can reach the real game or %APPDATA%."""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="btt-modtest-"))
        self.game = self.root / "Live"
        self.mods = self.game / "mods"
        self.mods.mkdir(parents=True)
        self._appdata = self.root / "appdata"
        self._appdata.mkdir()
        self._saved_env = {}

    def __enter__(self):
        # XDG_CONFIG_HOME too: that's where the data-dir override pointer file
        # lives, and a real one on the dev machine would drag tests out of here.
        for key, value in (("APPDATA", str(self._appdata)),
                           ("XDG_DATA_HOME", str(self._appdata)),
                           ("XDG_CONFIG_HOME", str(self._appdata))):
            self._saved_env[key] = os.environ.get(key)
            os.environ[key] = value
        self._saved_env["BTT_DATA_DIR"] = os.environ.pop("BTT_DATA_DIR", None)
        refresh_data_dir_override()
        return self

    def __exit__(self, *exc):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        refresh_data_dir_override()
        shutil.rmtree(self.root, ignore_errors=True)
        return False

    @property
    def path(self):
        return str(self.game)

    def write(self, filename, data):
        target = self.mods / filename
        target.write_bytes(data)
        return target

    def filenames(self):
        return sorted(p.name for p in self.mods.iterdir())

    def mod_list(self):
        return TroveModList(path=TroveGamePath(self.game), partial=True)

    def hash_of(self, filename):
        """The content hash the app (and Trovesaurus) identifies a file by."""
        target = self.mods / filename
        for mod in self.mod_list():
            if mod.mod_path == target:
                return mod.hash
        raise AssertionError(f"{filename} not found in {self.filenames()}")


class FakeResponse:
    def __init__(self, payload=None, content=b"", status_code=200):
        self.status_code = status_code
        self._payload = payload
        self.content = content

    def json(self):
        if self._payload is None:
            return json.loads(self.content.decode("utf-8"))
        return self._payload


class FakeTrovesaurus:
    """Routes requests.* by URL. `mods` maps mod id -> mod dict in the shape
    /api/mods-all returns; `hashes` maps content hash -> mod id; `files` maps
    file id -> the bytes downloadfile.php should serve."""

    def __init__(self, mods=None, hashes=None, files=None):
        self.mods = mods or {}
        self.hashes = hashes or {}
        self.files = files or {}
        self.calls = []

    def mod(self, mod_id, name, file_id, file_hash, fmt="tmod", extra=0,
            author="tester"):
        entry = self.mods.setdefault(str(mod_id), {
            "id": str(mod_id),
            "name": name,
            "type": "GUI",
            "date": "1660744903",
            "totaldownloads": "1",
            "image": "",
            "notes": "",
            "likes": "0",
            "obsolete": "0",
            "author": {"ID": "1", "Username": author},
            "downloads": [],
        })
        entry["downloads"].append({
            "modid": str(mod_id),
            "fileid": str(file_id),
            "version": str(file_id),
            "date": "1716397853",
            "downloads": "1",
            "changes": "",
            "format": fmt,
            "extra": str(extra),
            "hash": file_hash,
        })
        return entry

    def serve(self, file_id, data):
        self.files[str(file_id)] = data

    def link(self, file_hash, mod_id):
        self.hashes[file_hash] = int(mod_id)

    # -- request routing ---------------------------------------------------
    def get(self, url, **kwargs):
        self.calls.append(("GET", url))
        if "mods-all" in url:
            return FakeResponse(payload=list(self.mods.values()))
        if "mods-hot" in url:
            return FakeResponse(payload=[])
        if "downloadfile.php" in url:
            file_id = url.split("fileid=")[-1]
            data = self.files.get(str(file_id))
            if data is None:
                return FakeResponse(status_code=404)
            return FakeResponse(content=data)
        return FakeResponse(status_code=404)

    def post(self, url, **kwargs):
        self.calls.append(("POST", url))
        if "mods-hashes-to-mods" in url:
            wanted = (kwargs.get("data") or {}).get("hashes", "").split(",")
            return FakeResponse(payload={
                h: self.hashes[h] for h in wanted if h in self.hashes
            })
        return FakeResponse(status_code=404)

    def head(self, url, **kwargs):
        self.calls.append(("HEAD", url))
        return FakeResponse()

    def patch(self):
        """Patch requests at the module level -- every backend module does a
        plain `import requests`, so they all see these."""
        return mock.patch.multiple(
            "requests", get=self.get, post=self.post, head=self.head
        )
