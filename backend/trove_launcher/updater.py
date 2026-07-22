"""Keep our own Trove install current via a tiny sqlite "what's on disk" DB.

The manifest "sha1" is a *custom, non-recomputable* hash - we can't verify a file
by hashing its bytes. So we treat the hash purely as an opaque change-token:

  * We record, per file, the manifest hash string that corresponds to the bytes
    currently in our folder.
  * On a later manifest, a file needs (re)downloading iff its hash string differs
    from the one we recorded, OR the file is missing on disk.
  * We compare manifest-hash vs stored-hash, NEVER a recomputed hash of the file
    (the manifest hash isn't recomputable anyway), so a locally-modified file
    never looks "changed" and is never clobbered.

We only ever add/update files - never delete (that would risk mods/configs).

ADOPT (Better Trove Tools addition): the first time we point at a pre-existing
install (empty DB), naively every file's stored-hash is unknown, so a plain sync
would re-download the entire multi-GB game even though the files are already
there. With ``adopt=True`` we instead seed the DB for any file that's already on
disk at the manifest's exact byte size, trusting it as the current version -
turning "adopt an existing Glyph/Steam install" into a near-instant no-op. The
size match is a heuristic (the hash isn't recomputable); Repair (``reset()`` +
``adopt=False``) exists to force a full re-download when that trust is misplaced.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from . import cdn


class Updater:
    def __init__(self, *, base: str, prefix: str, branch: str, game_dir: Path,
                 db_path: Path, log=print):
        self._base = base
        self._prefix = prefix
        self._branch = branch
        self._game_dir = Path(game_dir)
        self._db_path = Path(db_path)
        self._log = log
        self._db = sqlite3.connect(self._db_path)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT)"
        )
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)"
        )
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def reset(self) -> None:
        """Forget everything we think is on disk (used by Repair). The next
        update() with adopt=False then re-fetches every file in the manifest."""
        self._db.execute("DELETE FROM files")
        self._db.execute("DELETE FROM meta")
        self._db.commit()

    # -- db helpers --
    def _get_meta(self, key: str) -> str | None:
        row = self._db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def _set_meta(self, key: str, value: str) -> None:
        self._db.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def _stored_hash(self, path: str) -> str | None:
        row = self._db.execute("SELECT hash FROM files WHERE path=?", (path,)).fetchone()
        return row[0] if row else None

    def _record(self, path: str, h: str) -> None:
        self._db.execute(
            "INSERT INTO files(path,hash) VALUES(?,?) "
            "ON CONFLICT(path) DO UPDATE SET hash=excluded.hash",
            (path, h),
        )

    def current_version(self) -> str | None:
        """The version we last fully applied (None if never / mid-sync)."""
        return self._get_meta("version")

    def check(self) -> dict:
        """Fetch the pointer only — {version, content_path, up_to_date} — without
        touching the manifest or downloading. Cheap 'is there an update?' probe."""
        with cdn.CdnClient(self._base, self._prefix) as client:
            ptr = client.fetch_pointer(cdn.BRANCHES[self._branch])
        version = ptr["version"]
        return {
            "version": version,
            "content_path": ptr["content_path"],
            "up_to_date": self._get_meta("version") == version,
        }

    def update(self, *, key_file: str | None = None, retries: int = 3,
               adopt: bool = True, progress=None) -> dict:
        """Make sure our game folder holds the current build.

        Creates the folder if it's missing, then downloads whatever the manifest
        lists that we don't already have (file absent OR its recorded hash token
        differs). With ``adopt`` on, files already present at the manifest's byte
        size are seeded as current instead of re-downloaded (see module docstring).

        A per-file failure is retried then skipped (never fatal); ``version`` is
        committed only on a fully clean pass, so a partial sync resumes next run.
        ``key_file`` (e.g. "Trove_x64.exe") forces a re-check even if the DB says
        we're current — belt-and-suspenders against a deleted/incomplete folder.
        ``progress(seen, total, downloaded)`` is called as the sync advances.
        """
        self._game_dir.mkdir(parents=True, exist_ok=True)  # create it if absent
        with cdn.CdnClient(self._base, self._prefix) as client:
            ptr = client.fetch_pointer(cdn.BRANCHES[self._branch])
            version, content_path = ptr["version"], ptr["content_path"]

            key_ok = key_file is None or (self._game_dir / key_file).is_file()
            if self._get_meta("version") == version and key_ok:
                self._log(f"[update] already current: {version}")
                if progress:
                    progress(0, 0, 0)
                return {"version": version, "downloaded": 0, "unchanged": 0,
                        "failed": 0, "skipped": True}

            _, entries = client.fetch_manifest(content_path, version)
            total = len(entries)
            self._log(f"[update] syncing {version} ({total} files) -> {self._game_dir}")

            downloaded = unchanged = failed = 0
            for i, e in enumerate(entries, 1):
                path, h, size = e["path"], e["sha1"], e["size"]
                dest = self._game_dir / path
                stored = self._stored_hash(path)
                if stored == h and dest.exists():
                    unchanged += 1
                    if progress:
                        progress(i, total, downloaded)
                    continue
                # Adopt an already-present, right-sized file as current instead of
                # re-downloading it (only when we've never tracked it before).
                if adopt and stored is None and dest.exists():
                    try:
                        if dest.stat().st_size == size:
                            self._record(path, h)
                            unchanged += 1
                            if progress:
                                progress(i, total, downloaded)
                            continue
                    except OSError:
                        pass
                for attempt in range(1, retries + 1):
                    try:
                        data = client.download_file(content_path, path, h, expected_size=size)
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(data)
                        self._record(path, h)
                        downloaded += 1
                        break
                    except Exception as exc:  # noqa: BLE001
                        if attempt == retries:
                            failed += 1
                            self._log(f"[update] FAILED {path} after {retries} tries: {exc}")
                if progress:
                    progress(i, total, downloaded)
                if downloaded and downloaded % 100 == 0:
                    self._db.commit()
                    self._log(f"[update] {downloaded} downloaded / {i} of {total} seen...")

            # Only declare this version applied if NOTHING is outstanding — else
            # leave version unset so the next run resumes the missing files.
            if failed == 0:
                self._set_meta("version", version)
            self._db.commit()
            self._log(f"[update] {'done' if not failed else 'INCOMPLETE'} {version}: "
                      f"downloaded={downloaded} unchanged={unchanged} failed={failed}")
            return {"version": version, "downloaded": downloaded,
                    "unchanged": unchanged, "failed": failed, "skipped": False}


def update_game(*, base, prefix, branch, game_dir, db_path, key_file=None,
                adopt=True, progress=None, log=print) -> dict:
    """One-shot convenience wrapper (safe to call from a worker thread)."""
    up = Updater(base=base, prefix=prefix, branch=branch, game_dir=game_dir,
                 db_path=db_path, log=log)
    try:
        return up.update(key_file=key_file, adopt=adopt, progress=progress)
    finally:
        up.close()
