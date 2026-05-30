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
from models.trove.prefab_mount import build_mounts_dataset


MOUNTS_CACHE_EXPIRY_SECONDS = 60 * 60 * 12
MOUNTS_CACHE_FILENAME = "mounts_game_cache.json"
MOUNTS_CACHE_MANIFEST_FILENAME = "mounts_game_cache_manifest.json"
_BUILD_LOCK = codex_cache.make_lock()


def _cache_root() -> Path:
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".mount_cache_probe"
            probe.write_text("ok", encoding="utf-8")
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
            return root
        except Exception:
            continue
    raise RuntimeError("No writable cache directory is available for mount data.")


def _cache_root_candidates() -> list[Path]:
    appdata = os.getenv("APPDATA")
    candidates = []
    if appdata:
        candidates.append(Path(appdata) / "Trove" / "ModManagerCache" / "codexes_cache")
    candidates.append(Path(tempfile.gettempdir()) / "BetterTroveToolsCache" / "codexes_cache")
    return candidates


def _mounts_cache_file() -> Path:
    return _cache_root() / MOUNTS_CACHE_FILENAME


def _mounts_cache_manifest_file() -> Path:
    return _cache_root() / MOUNTS_CACHE_MANIFEST_FILENAME


def _read_cached_mounts() -> tuple[dict | None, dict]:
    cache_file = _mounts_cache_file()
    manifest_file = _mounts_cache_manifest_file()
    manifest = {}
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        except Exception:
            manifest = {}
    if not cache_file.exists():
        return None, manifest
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        return data, manifest
    except Exception:
        return None, manifest


def _cache_age_seconds(manifest: dict) -> int | None:
    generated_at = manifest.get("generated_at")
    if not isinstance(generated_at, (int, float)):
        return None
    return max(0, int(time.time() - generated_at))


def _cache_is_compatible(manifest: dict, game_path: Path) -> bool:
    manifest_game_path = str(manifest.get("game_path", "")).strip()
    return not manifest_game_path or Path(manifest_game_path) == game_path


def _cache_is_fresh(manifest: dict, game_path: Path) -> bool:
    if not _cache_is_compatible(manifest, game_path):
        return False
    age = _cache_age_seconds(manifest)
    return age is not None and age < MOUNTS_CACHE_EXPIRY_SECONDS


def _write_cached_mounts(data: dict, manifest: dict) -> None:
    _mounts_cache_file().write_text(codex_cache.compact_dumps(data), encoding="utf-8")
    _mounts_cache_manifest_file().write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _build_mounts_dataset(game_path: Path) -> tuple[dict, dict]:
    data, manifest = asyncio.run(build_mounts_dataset(game_path=game_path, locale="en"))
    generated_at = int(time.time())
    full_manifest = {
        **manifest,
        "generated_at": generated_at,
        "expires_at": generated_at + MOUNTS_CACHE_EXPIRY_SECONDS,
        "cache_file": str(_mounts_cache_file()),
        "cache_expiry_seconds": MOUNTS_CACHE_EXPIRY_SECONDS,
    }
    return data, full_manifest


def _build_mounts_from_game_files(force_refresh: bool = False, game_path_str: str = "") -> tuple[dict, dict, str]:
    game_path = resolve_game_install(game_path_str)
    return codex_cache.resolve_cached_or_build(
        read_cached=_read_cached_mounts,
        is_fresh=_cache_is_fresh,
        is_compatible=_cache_is_compatible,
        build=_build_mounts_dataset,
        write=_write_cached_mounts,
        lock=_BUILD_LOCK,
        force_refresh=bool(force_refresh),
        game_path=game_path,
    )


@eel.expose
@standardize_response
def get_mounts_cache_status(game_path_str: str = ""):
    cached_data, manifest = _read_cached_mounts()
    try:
        game_path = resolve_game_install(game_path_str)
        is_fresh = cached_data is not None and _cache_is_fresh(manifest, game_path)
    except Exception:
        is_fresh = False
    return resp(
        True,
        data={
            "exists": cached_data is not None,
            "fresh": is_fresh,
            "age_seconds": _cache_age_seconds(manifest),
            "expiry_seconds": MOUNTS_CACHE_EXPIRY_SECONDS,
            "manifest": manifest,
        },
    )


@eel.expose
@standardize_response
def clear_mounts_cache():
    cleared = []
    for path in (_mounts_cache_file(), _mounts_cache_manifest_file()):
        if path.exists():
            try:
                path.unlink()
            except Exception:
                if path.name.endswith(".json"):
                    if path == _mounts_cache_manifest_file():
                        path.write_text(json.dumps({"generated_at": 0, "expires_at": 0}, indent=2), encoding="utf-8")
                    else:
                        path.write_text("{}", encoding="utf-8")
            cleared.append(str(path))
    return resp(True, data={"cleared": cleared})


@eel.expose
@standardize_response
def get_mounts_data(force_refresh: bool = False, game_path_str: str = ""):
    try:
        data, manifest, source = _build_mounts_from_game_files(force_refresh=bool(force_refresh), game_path_str=game_path_str)
        cache_file = _mounts_cache_file()
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
            message = "Mounts could not be loaded because no valid Glyph Trove installation was found."
        return resp(
            False,
            error=message,
            code="GET_MOUNTS_DATA_FAILED",
        )


@eel.expose
@standardize_response
def sync_mounts_data(game_path_str: str = ""):
    data, manifest, source = _build_mounts_from_game_files(force_refresh=True, game_path_str=game_path_str)
    return resp(True, data={"source": source, "cache": manifest})
