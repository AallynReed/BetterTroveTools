import asyncio
import json
import os
import time
from pathlib import Path

import eel

from backend.response import resp, standardize_response
from generate_allies_from_prefabs import (
    build_allies_dataset,
    default_allies_json_path,
    detect_first_glyph_install,
)


ALLIES_CACHE_EXPIRY_SECONDS = 60 * 60 * 12
ALLIES_CACHE_FILENAME = "allies_game_cache.json"
ALLIES_CACHE_MANIFEST_FILENAME = "allies_game_cache_manifest.json"


def _allies_file_path():
    return os.path.join(os.getcwd(), "web", "assets", "data", "allies.json")


def _read_allies_file():
    file_path = _allies_file_path()
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _cache_root() -> Path:
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".ally_cache_probe"
            probe.write_text("ok", encoding="utf-8")
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
            return root
        except Exception:
            continue
    raise RuntimeError("No writable cache directory is available for ally data.")


def _cache_root_candidates() -> list[Path]:
    appdata = os.getenv("APPDATA")
    candidates = []
    if appdata:
        candidates.append(Path(appdata) / "Trove" / "ModManagerCache")
    candidates.append(Path(os.getcwd()) / "web" / "cache" / "allies")
    return candidates


def _allies_cache_file() -> Path:
    return _cache_root() / ALLIES_CACHE_FILENAME


def _allies_cache_manifest_file() -> Path:
    return _cache_root() / ALLIES_CACHE_MANIFEST_FILENAME


def _read_cached_allies() -> tuple[dict | None, dict]:
    cache_file = _allies_cache_file()
    manifest_file = _allies_cache_manifest_file()
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
    return age is not None and age < ALLIES_CACHE_EXPIRY_SECONDS


def _write_cached_allies(data: dict, manifest: dict) -> None:
    _allies_cache_file().write_text(json.dumps(data, indent=4), encoding="utf-8")
    _allies_cache_manifest_file().write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _build_allies_from_game_files(force_refresh: bool = False) -> tuple[dict, dict, str]:
    cached_data, cached_manifest = _read_cached_allies()
    if not force_refresh and cached_data is not None and _cache_is_fresh(cached_manifest):
        return cached_data, cached_manifest, "game-cache"

    game_path = detect_first_glyph_install()

    last_error = None
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            extract_dir = root / "allies_runtime_cache"
            data, manifest = asyncio.run(
                build_allies_dataset(
                    game_path=game_path,
                    allies_json_path=default_allies_json_path(),
                    extract_dir=extract_dir,
                    locale="en",
                )
            )
            generated_at = int(time.time())
            full_manifest = {
                **manifest,
                "generated_at": generated_at,
                "expires_at": generated_at + ALLIES_CACHE_EXPIRY_SECONDS,
                "cache_file": str(_allies_cache_file()),
                "cache_expiry_seconds": ALLIES_CACHE_EXPIRY_SECONDS,
            }
            _write_cached_allies(data, full_manifest)
            return data, full_manifest, "game-live"
        except Exception as exc:
            last_error = exc
            continue

    raise last_error or RuntimeError("Failed to build ally data from game files.")


@eel.expose
@standardize_response
def get_allies_cache_status():
    cached_data, manifest = _read_cached_allies()
    return resp(
        True,
        data={
            "exists": cached_data is not None,
            "fresh": cached_data is not None and _cache_is_fresh(manifest),
            "age_seconds": _cache_age_seconds(manifest),
            "expiry_seconds": ALLIES_CACHE_EXPIRY_SECONDS,
            "manifest": manifest,
        },
    )


@eel.expose
@standardize_response
def clear_allies_cache():
    cleared = []
    for path in (_allies_cache_file(), _allies_cache_manifest_file()):
        if path.exists():
            try:
                path.unlink()
            except Exception:
                if path.name.endswith(".json"):
                    if path == _allies_cache_manifest_file():
                        path.write_text(json.dumps({"generated_at": 0, "expires_at": 0}, indent=2), encoding="utf-8")
                    else:
                        path.write_text("{}", encoding="utf-8")
            cleared.append(str(path))
    return resp(True, data={"cleared": cleared})


@eel.expose
@standardize_response
def get_allies_data(force_refresh: bool = False):
    try:
        data, manifest, source = _build_allies_from_game_files(force_refresh=bool(force_refresh))
        return resp(True, data=data, source=source, meta={"cache": manifest})
    except Exception as build_error:
        try:
            fallback = _read_allies_file()
            return resp(
                True,
                data=fallback,
                source="baseline-json",
                warning=str(build_error),
                meta={"cache": {"error": str(build_error)}},
            )
        except Exception as file_error:
            return resp(
                False,
                error=f"Game-file build failed ({build_error}) and allies.json fallback failed ({file_error})",
                code="GET_ALLIES_DATA_FAILED",
            )


@eel.expose
@standardize_response
def sync_allies_data():
    data, manifest, source = _build_allies_from_game_files(force_refresh=True)
    return resp(True, data={"source": source, "cache": manifest})
