"""Shared implementation for the game-file codexes.

Every codex (allies, badges, fish, items, mementos, mounts, recipes, styles)
builds a dataset from the Trove game files, writes it to a JSON cache and serves
that cache on later opens. Only the dataset builder and a handful of names
actually differ between them, so one `Codex` here generates the whole surface:
cache paths, freshness rules, and the `get_<key>_data` / `clear_<key>_cache`
eel endpoints. A codex module is then just its builder plus a Codex(...) call.

Behaviours they all share:

  * compact JSON on disk (cache files are machine-read, never hand-edited)
  * stale-while-revalidate: a stale cache is served instantly and refreshed in
    the background, so the only blocking build is the genuine first run
  * build dedup: a per-codex lock means two concurrent opens (e.g. the Mounts
    and Dragons tabs both calling get_mounts_data) build at most once
"""
from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import time
from pathlib import Path

import eel

from backend.response import resp, standardize_response
from models.trove.prefab_ally import resolve_game_install
from utils.path import get_cache_root

CACHE_EXPIRY_SECONDS = 60 * 60 * 12

# Raised by resolve_game_install; recognised so each codex can turn it into its
# own user-facing wording instead of leaking the internal message.
NO_INSTALL_ERROR = "No valid Glyph Trove installation was detected."

# key -> Codex, populated as the codex modules are imported. main.py walks this
# to warm caches at startup.
REGISTRY: dict[str, "Codex"] = {}


class Codex:
    """One game-file codex, registered with eel on construction.

    ``dataset`` is the async ``build_<key>_dataset(game_path=..., locale=...)``
    from models/trove. ``schema_version`` is set only by codexes that have had a
    breaking cache-shape change: when present it's written into the manifest and
    a mismatch forces a synchronous rebuild. ``extract_subdir`` is for builders
    that need a scratch directory (allies).
    """

    def __init__(self, key, label, dataset, *, schema_version=None,
                 extract_subdir=None):
        self.key = key
        self.label = label
        self.dataset = dataset
        self.schema_version = schema_version
        self.extract_subdir = extract_subdir
        self.lock = threading.Lock()
        self._register()
        REGISTRY[key] = self

    # --- cache location ---------------------------------------------------

    def _root(self) -> Path:
        """First writable cache directory: per-user app cache, OS temp dir as a
        fallback so codexes keep working when the primary isn't writable."""
        candidates = [
            get_cache_root() / "codexes_cache",
            Path(tempfile.gettempdir()) / "BetterTroveToolsCache" / "codexes_cache",
        ]
        for root in candidates:
            try:
                root.mkdir(parents=True, exist_ok=True)
                probe = root / f".{self.key}_cache_probe"
                probe.write_text("ok", encoding="utf-8")
                try:
                    probe.unlink(missing_ok=True)
                except Exception:
                    pass
                return root
            except Exception:
                continue
        raise RuntimeError(f"No writable cache directory is available for {self.key} data.")

    def _cache_file(self) -> Path:
        return self._root() / f"{self.key}_game_cache.json"

    def _manifest_file(self) -> Path:
        return self._root() / f"{self.key}_game_cache_manifest.json"

    # --- cache read/write -------------------------------------------------

    def _read(self) -> tuple[dict | None, dict]:
        manifest_file = self._manifest_file()
        manifest = {}
        if manifest_file.exists():
            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            except Exception:
                manifest = {}
        cache_file = self._cache_file()
        if not cache_file.exists():
            return None, manifest
        try:
            return json.loads(cache_file.read_text(encoding="utf-8")), manifest
        except Exception:
            return None, manifest

    def _write(self, data: dict, manifest: dict) -> None:
        payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        self._cache_file().write_text(payload, encoding="utf-8")
        self._manifest_file().write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # --- freshness --------------------------------------------------------

    def _age(self, manifest: dict) -> int | None:
        generated_at = manifest.get("generated_at")
        if not isinstance(generated_at, (int, float)):
            return None
        return max(0, int(time.time() - generated_at))

    def _compatible(self, manifest: dict, game_path: Path) -> bool:
        """Safe to serve while we refresh: right install, right schema."""
        if self.schema_version is not None:
            if int(manifest.get("cache_schema_version", 0) or 0) != self.schema_version:
                return False
        manifest_game_path = str(manifest.get("game_path", "")).strip()
        return not manifest_game_path or Path(manifest_game_path) == game_path

    def _fresh(self, manifest: dict, game_path: Path) -> bool:
        """Serve as-is: compatible and not expired."""
        if not self._compatible(manifest, game_path):
            return False
        age = self._age(manifest)
        return age is not None and age < CACHE_EXPIRY_SECONDS

    # --- building ---------------------------------------------------------

    def _build(self, game_path: Path) -> tuple[dict, dict]:
        kwargs = {"game_path": game_path, "locale": "en"}
        if self.extract_subdir:
            kwargs["extract_dir"] = self._root() / self.extract_subdir
        data, manifest = asyncio.run(self.dataset(**kwargs))
        generated_at = int(time.time())
        full_manifest = {
            **manifest,
            "generated_at": generated_at,
            "expires_at": generated_at + CACHE_EXPIRY_SECONDS,
            "cache_file": str(self._cache_file()),
            "cache_expiry_seconds": CACHE_EXPIRY_SECONDS,
        }
        if self.schema_version is not None:
            full_manifest["cache_schema_version"] = self.schema_version
        return data, full_manifest

    def _refresh_in_background(self, game_path: Path) -> None:
        # Non-blocking: if a build/refresh already holds the lock, don't stack another.
        if not self.lock.acquire(blocking=False):
            return

        def worker():
            try:
                self._write(*self._build(game_path))
            except Exception:
                pass
            finally:
                self.lock.release()

        threading.Thread(target=worker, daemon=True, name=f"codex-refresh-{self.key}").start()

    def build(self, force_refresh: bool = False, game_path_str: str = "") -> tuple[dict, dict, str]:
        """Return ``(data, manifest, source)``.

        source:
          ``game-cache``        a fresh cache was served; nothing was rebuilt
          ``game-cache-stale``  a stale-but-compatible cache was served instantly
                                and a background refresh was kicked off
          ``game-live``         built synchronously (no usable cache, or forced)
        """
        game_path = resolve_game_install(game_path_str)
        force_refresh = bool(force_refresh)

        data, manifest = self._read()
        if not force_refresh and data is not None:
            if self._fresh(manifest, game_path):
                return data, manifest, "game-cache"
            # Stale-while-revalidate, but only while the cache is otherwise
            # compatible. Stale for any reason *other* than age -- wrong install
            # path, bumped schema -- must rebuild synchronously rather than be
            # served.
            if self._compatible(manifest, game_path):
                self._refresh_in_background(game_path)
                return data, manifest, "game-cache-stale"

        # No usable cache (true first run / wrong path / new schema) or an
        # explicit refresh: build now, deduped so concurrent callers don't both.
        with self.lock:
            data, manifest = self._read()
            if not force_refresh and data is not None and self._fresh(manifest, game_path):
                return data, manifest, "game-cache"
            data, manifest = self._build(game_path)
            self._write(data, manifest)
            return data, manifest, "game-live"

    # --- eel surface ------------------------------------------------------

    def _register(self) -> None:
        key, label = self.key, self.label

        @standardize_response
        def get_data(force_refresh: bool = False, game_path_str: str = ""):
            try:
                _data, manifest, source = self.build(force_refresh, game_path_str)
            except Exception as build_error:
                message = str(build_error)
                if NO_INSTALL_ERROR in message:
                    message = f"{label} could not be loaded because no valid Glyph Trove installation was found."
                return resp(False, error=message, code=f"GET_{key.upper()}_DATA_FAILED")
            # The payload itself is served from /api/cache/<file> rather than
            # pushed over the eel bridge -- the caches run to tens of MB.
            cache_file = self._cache_file()
            cache_url = f"/api/cache/{cache_file.name}" if cache_file.exists() else ""
            return resp(
                True,
                data={},
                source=source,
                cache_file=cache_url,
                meta={"cache": {**manifest, "cache_url": cache_url}},
            )

        @standardize_response
        def clear_cache():
            cleared = []
            for path in (self._cache_file(), self._manifest_file()):
                if not path.exists():
                    continue
                try:
                    path.unlink()
                except Exception:
                    # Undeletable (locked on Windows): blank it instead, so the
                    # next read misses and rebuilds.
                    blank = {"generated_at": 0, "expires_at": 0} if path == self._manifest_file() else {}
                    path.write_text(json.dumps(blank, indent=2), encoding="utf-8")
                cleared.append(str(path))
            return resp(True, data={"cleared": cleared})

        self.get_data = eel.expose(f"get_{key}_data")(get_data)
        self.clear_cache = eel.expose(f"clear_{key}_cache")(clear_cache)
