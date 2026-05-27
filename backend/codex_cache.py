"""Shared cache orchestration for the game-file codexes.

Every codex (allies, mounts, mementos, recipes, items, fish) builds a dataset
from the Trove game files, writes it to a JSON cache, and serves the cache on
later opens. They all want the same three behaviours, so they live here once:

  * compact JSON on disk (cache files are machine-read, never hand-edited)
  * stale-while-revalidate: a stale cache is served instantly and refreshed in
    the background, so the only blocking build is the genuine first run
  * build dedup: a per-codex lock means two concurrent opens (e.g. the Mounts
    and Dragons tabs both calling get_mounts_data) build at most once
"""
from __future__ import annotations

import json
import threading
from typing import Callable


def compact_dumps(data) -> str:
    """Serialize a cache payload as compact JSON (smaller + faster to re-read)."""
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def make_lock() -> threading.Lock:
    return threading.Lock()


def _spawn_background_refresh(lock, build, write, game_path) -> None:
    # Non-blocking: if a build/refresh already holds the lock, don't stack another.
    if not lock.acquire(blocking=False):
        return

    def worker():
        try:
            data, manifest = build(game_path)
            write(data, manifest)
        except Exception:
            pass
        finally:
            lock.release()

    threading.Thread(target=worker, daemon=True, name="codex-refresh").start()


def resolve_cached_or_build(
    *,
    read_cached: Callable[[], tuple],
    is_fresh: Callable[..., bool],
    is_compatible: Callable[..., bool],
    build: Callable,
    write: Callable,
    lock: threading.Lock,
    force_refresh: bool,
    game_path,
) -> tuple:
    """Return ``(data, manifest, source)`` for one codex.

    ``is_fresh`` means "serve as-is" (right game path, right schema, not expired).
    ``is_compatible`` means "safe to serve while we refresh" (right game path and
    schema, but possibly expired). A cache that's stale for any reason *other* than
    age — wrong install path, bumped schema — is not compatible and must rebuild
    synchronously rather than be served.

    source:
      ``game-cache``        a fresh cache was served; nothing was rebuilt
      ``game-cache-stale``  a stale-but-compatible cache was served instantly and
                            a background refresh was kicked off
      ``game-live``         built synchronously (no usable cache, or forced)
    """
    cached_data, cached_manifest = read_cached()
    if not force_refresh and cached_data is not None and is_fresh(cached_manifest, game_path):
        return cached_data, cached_manifest, "game-cache"

    # Stale-while-revalidate: only when the cache is otherwise compatible (same
    # install + schema) — serve it now and refresh in the background so a periodic
    # expiry never makes the user wait.
    if not force_refresh and cached_data is not None and is_compatible(cached_manifest, game_path):
        _spawn_background_refresh(lock, build, write, game_path)
        return cached_data, cached_manifest, "game-cache-stale"

    # No usable cache (true first run / wrong path / new schema) or an explicit
    # refresh: build now, deduped so concurrent callers don't both build.
    with lock:
        cached_data, cached_manifest = read_cached()
        if not force_refresh and cached_data is not None and is_fresh(cached_manifest, game_path):
            return cached_data, cached_manifest, "game-cache"
        data, manifest = build(game_path)
        write(data, manifest)
        return data, manifest, "game-live"
