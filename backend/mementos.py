import asyncio
import json
import os
import time
from pathlib import Path

import eel

from backend.response import resp, standardize_response
from models.trove.prefab_ally import detect_first_glyph_install
from models.trove.prefab_memento import build_mementos_dataset


MEMENTOS_CACHE_EXPIRY_SECONDS = 60 * 60 * 12
MEMENTOS_CACHE_FILENAME = "mementos_game_cache.json"
MEMENTOS_CACHE_MANIFEST_FILENAME = "mementos_game_cache_manifest.json"


def _cache_root() -> Path:
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".memento_cache_probe"
            probe.write_text("ok", encoding="utf-8")
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
            return root
        except Exception:
            continue
    raise RuntimeError("No writable cache directory is available for memento data.")


def _cache_root_candidates() -> list[Path]:
    appdata = os.getenv("APPDATA")
    candidates = []
    if appdata:
        candidates.append(Path(appdata) / "Trove" / "ModManagerCache")
    candidates.append(Path(os.getcwd()) / "web" / "cache" / "mementos")
    return candidates


def _mementos_cache_file() -> Path:
    return _cache_root() / MEMENTOS_CACHE_FILENAME


def _mementos_cache_manifest_file() -> Path:
    return _cache_root() / MEMENTOS_CACHE_MANIFEST_FILENAME


def _read_cached_mementos() -> tuple[dict | None, dict]:
    cache_file = _mementos_cache_file()
    manifest_file = _mementos_cache_manifest_file()
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


def _cache_is_fresh(manifest: dict) -> bool:
    age = _cache_age_seconds(manifest)
    return age is not None and age < MEMENTOS_CACHE_EXPIRY_SECONDS


def _write_cached_mementos(data: dict, manifest: dict) -> None:
    _mementos_cache_file().write_text(json.dumps(data, indent=4), encoding="utf-8")
    _mementos_cache_manifest_file().write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _build_mementos_from_game_files(force_refresh: bool = False) -> tuple[dict, dict, str]:
    cached_data, cached_manifest = _read_cached_mementos()
    if not force_refresh and cached_data is not None and _cache_is_fresh(cached_manifest):
        return cached_data, cached_manifest, "game-cache"

    game_path = detect_first_glyph_install()
    last_error = None
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            data, manifest = asyncio.run(build_mementos_dataset(game_path=game_path, locale="en"))
            generated_at = int(time.time())
            full_manifest = {
                **manifest,
                "generated_at": generated_at,
                "expires_at": generated_at + MEMENTOS_CACHE_EXPIRY_SECONDS,
                "cache_file": str(_mementos_cache_file()),
                "cache_expiry_seconds": MEMENTOS_CACHE_EXPIRY_SECONDS,
            }
            _write_cached_mementos(data, full_manifest)
            return data, full_manifest, "game-live"
        except Exception as exc:
            last_error = exc
            continue
    raise last_error or RuntimeError("Failed to build memento data from game files.")


@eel.expose
@standardize_response
def clear_mementos_cache():
    cleared = []
    for path in (_mementos_cache_file(), _mementos_cache_manifest_file()):
        if path.exists():
            try:
                path.unlink()
            except Exception:
                if path.name.endswith(".json"):
                    if path == _mementos_cache_manifest_file():
                        path.write_text(json.dumps({"generated_at": 0, "expires_at": 0}, indent=2), encoding="utf-8")
                    else:
                        path.write_text("{}", encoding="utf-8")
            cleared.append(str(path))
    return resp(True, data={"cleared": cleared})


@eel.expose
@standardize_response
def get_mementos_data(force_refresh: bool = False):
    try:
        data, manifest, source = _build_mementos_from_game_files(force_refresh=bool(force_refresh))
        return resp(True, data=data, source=source, meta={"cache": manifest})
    except Exception as build_error:
        message = str(build_error)
        if "No valid Glyph Trove installation was detected." in message:
            message = "Mementos could not be loaded because no valid Glyph Trove installation was found."
        return resp(False, error=message, code="GET_MEMENTOS_DATA_FAILED")
