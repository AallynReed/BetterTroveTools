import asyncio
import json
import os
import time
from pathlib import Path

import eel

from backend.response import resp, standardize_response
from models.trove.prefab_ally import resolve_game_install
from models.trove.prefab_recipe import build_recipes_dataset


RECIPES_CACHE_EXPIRY_SECONDS = 60 * 60 * 12
RECIPES_CACHE_FILENAME = "recipes_game_cache.json"
RECIPES_CACHE_MANIFEST_FILENAME = "recipes_game_cache_manifest.json"


def _cache_root() -> Path:
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".recipe_cache_probe"
            probe.write_text("ok", encoding="utf-8")
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
            return root
        except Exception:
            continue
    raise RuntimeError("No writable cache directory is available for recipe data.")


def _cache_root_candidates() -> list[Path]:
    appdata = os.getenv("APPDATA")
    candidates = []
    if appdata:
        candidates.append(Path(appdata) / "Trove" / "ModManagerCache")
    candidates.append(Path(os.getcwd()) / "web" / "cache" / "recipes")
    return candidates


def _recipes_cache_file() -> Path:
    return _cache_root() / RECIPES_CACHE_FILENAME


def _recipes_cache_manifest_file() -> Path:
    return _cache_root() / RECIPES_CACHE_MANIFEST_FILENAME


def _read_cached_recipes() -> tuple[dict | None, dict]:
    cache_file = _recipes_cache_file()
    manifest_file = _recipes_cache_manifest_file()
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


def _cache_is_fresh(manifest: dict, game_path: Path) -> bool:
    manifest_game_path = str(manifest.get("game_path", "")).strip()
    if manifest_game_path and Path(manifest_game_path) != game_path:
        return False
    age = _cache_age_seconds(manifest)
    return age is not None and age < RECIPES_CACHE_EXPIRY_SECONDS


def _write_cached_recipes(data: dict, manifest: dict) -> None:
    _recipes_cache_file().write_text(json.dumps(data, indent=4), encoding="utf-8")
    _recipes_cache_manifest_file().write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _build_recipes_from_game_files(force_refresh: bool = False, game_path_str: str = "") -> tuple[dict, dict, str]:
    game_path = resolve_game_install(game_path_str)
    cached_data, cached_manifest = _read_cached_recipes()
    if not force_refresh and cached_data is not None and _cache_is_fresh(cached_manifest, game_path):
        return cached_data, cached_manifest, "game-cache"
    last_error = None
    for root in _cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            data, manifest = asyncio.run(build_recipes_dataset(game_path=game_path, locale="en"))
            generated_at = int(time.time())
            full_manifest = {
                **manifest,
                "generated_at": generated_at,
                "expires_at": generated_at + RECIPES_CACHE_EXPIRY_SECONDS,
                "cache_file": str(_recipes_cache_file()),
                "cache_expiry_seconds": RECIPES_CACHE_EXPIRY_SECONDS,
            }
            _write_cached_recipes(data, full_manifest)
            return data, full_manifest, "game-live"
        except Exception as exc:
            last_error = exc
            continue
    raise last_error or RuntimeError("Failed to build recipe data from game files.")


@eel.expose
@standardize_response
def clear_recipes_cache():
    cleared = []
    for path in (_recipes_cache_file(), _recipes_cache_manifest_file()):
        if path.exists():
            try:
                path.unlink()
            except Exception:
                if path.name.endswith(".json"):
                    if path == _recipes_cache_manifest_file():
                        path.write_text(json.dumps({"generated_at": 0, "expires_at": 0}, indent=2), encoding="utf-8")
                    else:
                        path.write_text("{}", encoding="utf-8")
            cleared.append(str(path))
    return resp(True, data={"cleared": cleared})


@eel.expose
@standardize_response
def get_recipes_data(force_refresh: bool = False, game_path_str: str = ""):
    try:
        data, manifest, source = _build_recipes_from_game_files(force_refresh=bool(force_refresh), game_path_str=game_path_str)
        cache_file = _recipes_cache_file()
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
            message = "Recipes could not be loaded because no valid Glyph Trove installation was found."
        return resp(False, error=message, code="GET_RECIPES_DATA_FAILED")
