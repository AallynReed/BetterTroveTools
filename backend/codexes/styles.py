import asyncio
import json
import time
from pathlib import Path

import eel

from backend.codexes import codex_cache
from backend.response import resp, standardize_response
from models.trove.prefab_ally import resolve_game_install
from models.trove.prefab_style import build_styles_dataset


STYLES_CACHE_EXPIRY_SECONDS = 60 * 60 * 12
STYLES_CACHE_FILENAME = "styles_game_cache.json"
STYLES_CACHE_MANIFEST_FILENAME = "styles_game_cache_manifest.json"
_BUILD_LOCK = codex_cache.make_lock()


def _cache_root() -> Path:
    for root in codex_cache.cache_root_candidates():
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".style_cache_probe"
            probe.write_text("ok", encoding="utf-8")
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
            return root
        except Exception:
            continue
    raise RuntimeError("No writable cache directory is available for style data.")


def _styles_cache_file() -> Path:
    return _cache_root() / STYLES_CACHE_FILENAME


def _styles_cache_manifest_file() -> Path:
    return _cache_root() / STYLES_CACHE_MANIFEST_FILENAME


def _read_cached_styles() -> tuple[dict | None, dict]:
    cache_file = _styles_cache_file()
    manifest_file = _styles_cache_manifest_file()
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
    manifest_game_path = str(manifest.get("game_path", "")).strip()
    return not manifest_game_path or Path(manifest_game_path) == game_path


def _cache_is_fresh(manifest: dict, game_path: Path) -> bool:
    if not _cache_is_compatible(manifest, game_path):
        return False
    age = _cache_age_seconds(manifest)
    return age is not None and age < STYLES_CACHE_EXPIRY_SECONDS


def _write_cached_styles(data: dict, manifest: dict) -> None:
    _styles_cache_file().write_text(codex_cache.compact_dumps(data), encoding="utf-8")
    _styles_cache_manifest_file().write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _build_styles_dataset(game_path: Path) -> tuple[dict, dict]:
    data, manifest = asyncio.run(build_styles_dataset(game_path=game_path, locale="en"))
    generated_at = int(time.time())
    full_manifest = {
        **manifest,
        "generated_at": generated_at,
        "expires_at": generated_at + STYLES_CACHE_EXPIRY_SECONDS,
        "cache_file": str(_styles_cache_file()),
        "cache_expiry_seconds": STYLES_CACHE_EXPIRY_SECONDS,
    }
    return data, full_manifest


def _build_styles_from_game_files(force_refresh: bool = False, game_path_str: str = "") -> tuple[dict, dict, str]:
    game_path = resolve_game_install(game_path_str)
    return codex_cache.resolve_cached_or_build(
        read_cached=_read_cached_styles,
        is_fresh=_cache_is_fresh,
        is_compatible=_cache_is_compatible,
        build=_build_styles_dataset,
        write=_write_cached_styles,
        lock=_BUILD_LOCK,
        force_refresh=bool(force_refresh),
        game_path=game_path,
    )


@eel.expose
@standardize_response
def clear_styles_cache():
    cleared = []
    for path in (_styles_cache_file(), _styles_cache_manifest_file()):
        if path.exists():
            try:
                path.unlink()
            except Exception:
                if path == _styles_cache_manifest_file():
                    path.write_text(json.dumps({"generated_at": 0, "expires_at": 0}, indent=2), encoding="utf-8")
                else:
                    path.write_text("{}", encoding="utf-8")
            cleared.append(str(path))
    return resp(True, data={"cleared": cleared})


@eel.expose
@standardize_response
def get_styles_data(force_refresh: bool = False, game_path_str: str = ""):
    try:
        data, manifest, source = _build_styles_from_game_files(force_refresh=bool(force_refresh), game_path_str=game_path_str)
        cache_file = _styles_cache_file()
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
            message = "Styles could not be loaded because no valid Glyph Trove installation was found."
        return resp(False, error=message, code="GET_STYLES_DATA_FAILED")
