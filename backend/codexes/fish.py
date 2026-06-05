import asyncio
import json
import os
import tempfile
import time
from pathlib import Path

import eel

from backend.codexes import codex_cache
from backend.response import resp, standardize_response
from models.trove.prefab_ally import resolve_game_install
from models.trove.prefab_fish import build_fish_dataset


FISH_CACHE_EXPIRY_SECONDS = 60 * 60 * 12
FISH_CACHE_FILENAME = "fish_game_cache.json"
FISH_CACHE_MANIFEST_FILENAME = "fish_game_cache_manifest.json"
FISH_CACHE_SCHEMA_VERSION = 1
_BUILD_LOCK = codex_cache.make_lock()


def _cache_root_candidates() -> list[Path]:
    return codex_cache.cache_root_candidates()


def _cache_root() -> Path:
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".fish_cache_probe"
            probe.write_text("ok", encoding="utf-8")
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
            return root
        except Exception:
            continue
    raise RuntimeError("No writable cache directory is available for fish data.")


def _fish_cache_file() -> Path:
    return _cache_root() / FISH_CACHE_FILENAME


def _fish_cache_manifest_file() -> Path:
    return _cache_root() / FISH_CACHE_MANIFEST_FILENAME


def _read_cached_fish() -> tuple[dict | None, dict]:
    cache_file = _fish_cache_file()
    manifest_file = _fish_cache_manifest_file()
    manifest = {}
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        except Exception:
            manifest = {}
    if not cache_file.exists():
        return None, manifest
    try:
        return json.loads(cache_file.read_text(encoding="utf-8")), manifest
    except Exception:
        return None, manifest


def _cache_age_seconds(manifest: dict) -> int | None:
    generated_at = manifest.get("generated_at")
    if not isinstance(generated_at, (int, float)):
        return None
    return max(0, int(time.time() - generated_at))


def _cache_is_compatible(manifest: dict, game_path: Path) -> bool:
    if int(manifest.get("cache_schema_version", 0) or 0) != FISH_CACHE_SCHEMA_VERSION:
        return False
    manifest_game_path = str(manifest.get("game_path", "")).strip()
    return not manifest_game_path or Path(manifest_game_path) == game_path


def _cache_is_fresh(manifest: dict, game_path: Path) -> bool:
    if not _cache_is_compatible(manifest, game_path):
        return False
    age = _cache_age_seconds(manifest)
    return age is not None and age < FISH_CACHE_EXPIRY_SECONDS


def _write_cached_fish(data: dict, manifest: dict) -> None:
    _fish_cache_file().write_text(codex_cache.compact_dumps(data), encoding="utf-8")
    _fish_cache_manifest_file().write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _build_fish_dataset(game_path: Path) -> tuple[dict, dict]:
    data, manifest = asyncio.run(build_fish_dataset(game_path=game_path, locale="en"))
    generated_at = int(time.time())
    full_manifest = {
        **manifest,
        "cache_schema_version": FISH_CACHE_SCHEMA_VERSION,
        "generated_at": generated_at,
        "expires_at": generated_at + FISH_CACHE_EXPIRY_SECONDS,
        "cache_file": str(_fish_cache_file()),
        "cache_expiry_seconds": FISH_CACHE_EXPIRY_SECONDS,
    }
    return data, full_manifest


def _build_fish_from_game_files(force_refresh: bool = False, game_path_str: str = "") -> tuple[dict, dict, str]:
    game_path = resolve_game_install(game_path_str)
    return codex_cache.resolve_cached_or_build(
        read_cached=_read_cached_fish,
        is_fresh=_cache_is_fresh,
        is_compatible=_cache_is_compatible,
        build=_build_fish_dataset,
        write=_write_cached_fish,
        lock=_BUILD_LOCK,
        force_refresh=bool(force_refresh),
        game_path=game_path,
    )


@eel.expose
@standardize_response
def clear_fish_cache():
    cleared = []
    for path in (_fish_cache_file(), _fish_cache_manifest_file()):
        if path.exists():
            try:
                path.unlink()
            except Exception:
                if path == _fish_cache_manifest_file():
                    path.write_text(json.dumps({"generated_at": 0, "expires_at": 0}, indent=2), encoding="utf-8")
                else:
                    path.write_text("{}", encoding="utf-8")
            cleared.append(str(path))
    return resp(True, data={"cleared": cleared})


@eel.expose
@standardize_response
def get_fish_data(force_refresh: bool = False, game_path_str: str = ""):
    try:
        data, manifest, source = _build_fish_from_game_files(force_refresh=bool(force_refresh), game_path_str=game_path_str)
        cache_file = _fish_cache_file()
        cache_url = f"/api/cache/{cache_file.name}" if cache_file.exists() else ""
        return resp(
            True,
            data={},
            source=source,
            cache_file=cache_url,
            meta={"cache": {**manifest, "cache_url": cache_url}},
        )
    except Exception as build_error:
        message = str(build_error)
        if "No valid Glyph Trove installation was detected." in message:
            message = "Fish could not be loaded because no valid Glyph Trove installation was found."
        return resp(False, error=message, code="GET_FISH_DATA_FAILED")
