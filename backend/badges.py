import asyncio
import json
import os
import tempfile
import time
from pathlib import Path

import eel

from backend import codex_cache
from backend.response import resp, standardize_response
from models.trove.prefab_ally import resolve_game_install
from models.trove.prefab_badge import build_badges_dataset


BADGES_CACHE_EXPIRY_SECONDS = 60 * 60 * 12
BADGES_CACHE_FILENAME = "badges_game_cache.json"
BADGES_CACHE_MANIFEST_FILENAME = "badges_game_cache_manifest.json"
BADGES_CACHE_SCHEMA_VERSION = 1
_BUILD_LOCK = codex_cache.make_lock()


def _cache_root_candidates() -> list[Path]:
    appdata = os.getenv("APPDATA")
    candidates = []
    if appdata:
        candidates.append(Path(appdata) / "Trove" / "ModManagerCache" / "codexes_cache")
    candidates.append(Path(tempfile.gettempdir()) / "BetterTroveToolsCache" / "codexes_cache")
    return candidates


def _cache_root() -> Path:
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".badges_cache_probe"
            probe.write_text("ok", encoding="utf-8")
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
            return root
        except Exception:
            continue
    raise RuntimeError("No writable cache directory is available for badge data.")


def _badges_cache_file() -> Path:
    return _cache_root() / BADGES_CACHE_FILENAME


def _badges_cache_manifest_file() -> Path:
    return _cache_root() / BADGES_CACHE_MANIFEST_FILENAME


def _read_cached_badges() -> tuple[dict | None, dict]:
    cache_file = _badges_cache_file()
    manifest_file = _badges_cache_manifest_file()
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
    if int(manifest.get("cache_schema_version", 0) or 0) != BADGES_CACHE_SCHEMA_VERSION:
        return False
    manifest_game_path = str(manifest.get("game_path", "")).strip()
    return not manifest_game_path or Path(manifest_game_path) == game_path


def _cache_is_fresh(manifest: dict, game_path: Path) -> bool:
    if not _cache_is_compatible(manifest, game_path):
        return False
    age = _cache_age_seconds(manifest)
    return age is not None and age < BADGES_CACHE_EXPIRY_SECONDS


def _write_cached_badges(data: dict, manifest: dict) -> None:
    _badges_cache_file().write_text(codex_cache.compact_dumps(data), encoding="utf-8")
    _badges_cache_manifest_file().write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _build_badges_dataset(game_path: Path) -> tuple[dict, dict]:
    data, manifest = asyncio.run(build_badges_dataset(game_path=game_path, locale="en"))
    generated_at = int(time.time())
    full_manifest = {
        **manifest,
        "cache_schema_version": BADGES_CACHE_SCHEMA_VERSION,
        "generated_at": generated_at,
        "expires_at": generated_at + BADGES_CACHE_EXPIRY_SECONDS,
        "cache_file": str(_badges_cache_file()),
        "cache_expiry_seconds": BADGES_CACHE_EXPIRY_SECONDS,
    }
    return data, full_manifest


def _build_badges_from_game_files(force_refresh: bool = False, game_path_str: str = "") -> tuple[dict, dict, str]:
    game_path = resolve_game_install(game_path_str)
    return codex_cache.resolve_cached_or_build(
        read_cached=_read_cached_badges,
        is_fresh=_cache_is_fresh,
        is_compatible=_cache_is_compatible,
        build=_build_badges_dataset,
        write=_write_cached_badges,
        lock=_BUILD_LOCK,
        force_refresh=bool(force_refresh),
        game_path=game_path,
    )


@eel.expose
@standardize_response
def clear_badges_cache():
    cleared = []
    for path in (_badges_cache_file(), _badges_cache_manifest_file()):
        if path.exists():
            try:
                path.unlink()
            except Exception:
                if path == _badges_cache_manifest_file():
                    path.write_text(json.dumps({"generated_at": 0, "expires_at": 0}, indent=2), encoding="utf-8")
                else:
                    path.write_text("{}", encoding="utf-8")
            cleared.append(str(path))
    return resp(True, data={"cleared": cleared})


@eel.expose
@standardize_response
def get_badges_data(force_refresh: bool = False, game_path_str: str = ""):
    try:
        data, manifest, source = _build_badges_from_game_files(force_refresh=bool(force_refresh), game_path_str=game_path_str)
        cache_file = _badges_cache_file()
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
            message = "Badges could not be loaded because no valid Glyph Trove installation was found."
        return resp(False, error=message, code="GET_BADGES_DATA_FAILED")
