import json
import mimetypes
import os
import sys
import tempfile
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path
from datetime import UTC
from urllib.parse import parse_qs

import eel
import requests


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
LOCALE_DIR = WEB_DIR / "assets" / "locale"


os.chdir(BASE_DIR)
sys.argv[0] = str(BASE_DIR / "web_server.py")
os.environ.setdefault("GOOGLE_API_KEY", "no")
os.environ.setdefault("GOOGLE_DEFAULT_CLIENT_ID", "no")
os.environ.setdefault("GOOGLE_DEFAULT_CLIENT_SECRET", "no")


import backend.about  # noqa: E402,F401
import backend.calculators  # noqa: E402,F401
import backend.gems_and_builds.gem_builds  # noqa: E402,F401
import backend.gems_and_builds.gem_evaluator  # noqa: E402,F401
import backend.gems_and_builds.gem_simulator  # noqa: E402,F401
import backend.gems_and_builds.star_chart  # noqa: E402,F401
import backend.home  # noqa: E402,F401

from backend.response import resp  # noqa: E402
from backend.home import RSS_NAMESPACES, _safe_strip_html, _truncate_text  # noqa: E402


DENIED_EEL_FUNCTIONS = {
    "add_missing_translation_keys",
    "browse_for_game_dir",
    "build_baseline_cache",
    "cancel_file_manager_operation",
    "clear_allies_cache",
    "clear_badges_cache",
    "clear_fish_cache",
    "clear_items_cache",
    "clear_mementos_cache",
    "clear_mounts_cache",
    "clear_recipes_cache",
    "clear_trovesaurus_cache",
    "delete_mod",
    "delete_trovesaurus_installed_mod",
    "extract_tmod",
    "finalize_self_update_exit",
    "get_allies_data",
    "get_badges_data",
    "get_detected_game_paths",
    "get_fish_data",
    "get_installed_mods",
    "get_items_data",
    "get_mementos_data",
    "get_missing_files",
    "get_mod_urls",
    "get_mounts_data",
    "get_project_files",
    "get_recipes_data",
    "get_settings",
    "get_tracking_directories",
    "get_tracking_status",
    "install_trovesaurus_mod",
    "load_entire_game_tree",
    "load_gem_storage",
    "load_mod_project",
    "load_qb_file",
    "load_tmod_for_edit",
    "open_path_in_explorer",
    "save_mod_project",
    "save_qb_file",
    "save_gem_storage",
    "save_star_chart_template",
    "save_settings",
    "delete_star_chart_template",
    "get_star_chart_templates",
    "save_tmod_in_place",
    "save_tracking_directory",
    "scan_and_extract_updates",
    "start_self_update",
    "sync_allies_data",
    "sync_mounts_data",
    "undo_delete_mod",
}


def _get_json_endpoint(url, code):
    try:
        response = requests.get(url, headers={"User-Agent": "BetterTroveTools-Web/1.0"}, timeout=10)
        response.raise_for_status()
        return resp(True, data=response.json())
    except Exception as exc:
        return resp(False, data=[], error=str(exc), code=code)


def get_youtube_videos():
    return _get_json_endpoint("https://trovesaurus.aallyn.net/youtube_videos", "YOUTUBE_FETCH_FAILED")


def get_twitch_streams():
    return _get_json_endpoint("https://trovesaurus.aallyn.net/twitch_streams", "TWITCH_FETCH_FAILED")


def get_bilibili_videos():
    return _get_json_endpoint("https://trovesaurus.aallyn.net/bilibili_videos", "BILIBILI_FETCH_FAILED")


def get_trovesaurus_events():
    result = _get_json_endpoint("https://trovesaurus.com/calendar/feed", "EVENTS_FETCH_FAILED")
    if result.get("success") and isinstance(result.get("data"), list):
        result["data"].sort(key=lambda item: int(item.get("startdate") or 0))
    return result


def get_trove_news():
    try:
        response = requests.get(
            "https://trovegame.com/feed",
            headers={"User-Agent": "BetterTroveTools-Web/1.0"},
            timeout=8,
        )
        response.raise_for_status()
        root = ET.fromstring(response.text)
        items = []

        for item in root.findall("./channel/item"):
            title = unescape((item.findtext("title") or "").strip())
            link = (item.findtext("link") or "").strip()
            author = (item.findtext("dc:creator", "", RSS_NAMESPACES) or "").strip()
            pub_date_raw = (item.findtext("pubDate") or "").strip()
            description = item.findtext("description") or ""
            media_content = item.find("media:content", RSS_NAMESPACES)
            media_thumb = item.find("media:thumbnail", RSS_NAMESPACES)
            categories = [
                unescape((category.text or "").strip())
                for category in item.findall("category")
                if (category.text or "").strip()
            ]

            published_at = pub_date_raw
            try:
                published_at = parsedate_to_datetime(pub_date_raw).astimezone(UTC).isoformat()
            except Exception:
                pass

            image = None
            if media_content is not None:
                image = media_content.attrib.get("url")
            if not image and media_thumb is not None:
                image = media_thumb.attrib.get("url")

            items.append({
                "title": title,
                "url": link,
                "author": author or "Team Trove",
                "published_at": published_at,
                "summary": _truncate_text(_safe_strip_html(unescape(description)), 220),
                "category": categories[0] if categories else "News",
                "categories": categories,
                "image": image,
            })
            if len(items) >= 20:
                break

        return resp(True, data=items)
    except Exception as exc:
        return resp(False, data=[], error=str(exc), code="NEWS_FETCH_FAILED")


eel._exposed_functions.update({
    "get_bilibili_videos": get_bilibili_videos,
    "get_trove_news": get_trove_news,
    "get_trovesaurus_events": get_trovesaurus_events,
    "get_twitch_streams": get_twitch_streams,
    "get_youtube_videos": get_youtube_videos,
})


def get_cache_root() -> Path:
    appdata = os.getenv("APPDATA")
    if appdata:
        return Path(appdata) / "Trove" / "ModManagerCache"
    return Path(tempfile.gettempdir()) / "BetterTroveToolsCache"


@eel.expose
def get_startup_url():
    return None


@eel.expose
def get_app_metadata():
    meta_path = BASE_DIR / "metadata.json"
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "APP_NAME": "Better Trove Tools",
            "APP_VERSION": "Unknown",
        }


def _is_locale_file(file_path):
    # Only <lang>_<REGION>.json; skips engine aux files (_ui_ids.json, schema).
    parts = file_path.stem.split("_")
    return (
        len(parts) == 2
        and 2 <= len(parts[0]) <= 3 and parts[0].islower()
        and 2 <= len(parts[1]) <= 4 and parts[1].isalpha()
    )


def _completion(data):
    # User-facing coverage over everything visible: UI strings + content.
    strings = data.get("strings")
    if strings is None:
        values = list(data.get("keys", {}).values())  # legacy
    else:
        values = list(strings.values()) + list(data.get("content", {}).values())
    total = len(values)
    if total == 0:
        return 0
    empty = sum(1 for value in values if value == "" or value is None)
    return int(((total - empty) / total) * 100)


@eel.expose
def get_available_languages():
    languages = []
    if not LOCALE_DIR.exists():
        return [{"code": "en_US", "name": "English", "percent": 100}]

    for file_path in LOCALE_DIR.glob("*.json"):
        if not _is_locale_file(file_path):
            continue
        try:
            data = json.loads(file_path.read_text(encoding="utf-8"))
            meta = data.get("meta") or {}
            name = meta.get("name") or data.get("language_name") or file_path.stem
            percent = 100 if file_path.stem == "en_US" else _completion(data)
            languages.append({"code": file_path.stem, "name": name, "percent": percent})
        except Exception:
            continue

    languages.sort(key=lambda item: (item["code"] != "en_US", item["name"]))
    return languages


def call_eel_function(function_name, payload):
    if function_name in DENIED_EEL_FUNCTIONS:
        return 403, {
            "success": False,
            "error": f"{function_name} is not available in hosted web mode.",
            "code": "WEB_MODE_FUNCTION_DENIED",
        }

    func = eel._exposed_functions.get(function_name)
    if not func:
        return 404, {
            "success": False,
            "error": f"Unknown compatibility function: {function_name}",
            "code": "WEB_MODE_FUNCTION_NOT_FOUND",
        }

    args = payload.get("args", [])
    kwargs = payload.get("kwargs", {})
    if not isinstance(args, list) or not isinstance(kwargs, dict):
        return 400, {
            "success": False,
            "error": "Compatibility calls require JSON args and kwargs.",
            "code": "WEB_MODE_BAD_REQUEST",
        }

    try:
        return 200, func(*args, **kwargs)
    except Exception as exc:
        return 500, {
            "success": False,
            "error": str(exc),
            "code": "WEB_MODE_FUNCTION_FAILED",
        }


def list_compat_functions():
    names = sorted(name for name in eel._exposed_functions if name not in DENIED_EEL_FUNCTIONS)
    return {"success": True, "functions": names}


def resolve_cache_file(filename):
    if ".." in filename or "/" in filename or "\\" in filename:
        return 403, None

    cache_root = get_cache_root()
    direct_path = cache_root / filename
    if direct_path.is_file():
        return 200, direct_path

    matches = list(cache_root.rglob(filename)) if cache_root.exists() else []
    if not matches:
        return 404, None
    return 200, matches[0]


def proxy_bilibili_image(query_string):
    params = parse_qs(query_string)
    url = (params.get("url") or [""])[0]
    if not url or "hdslb.com" not in url:
        return 403, b"Forbidden", "text/plain"

    try:
        headers = {
            "Referer": "https://www.bilibili.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }
        proxied = requests.get(url, headers=headers, timeout=5)
        return proxied.status_code, proxied.content, proxied.headers.get("content-type", "image/jpeg")
    except Exception as exc:
        return 500, str(exc).encode("utf-8"), "text/plain"


async def _receive_body(receive):
    chunks = []
    more_body = True
    while more_body:
        message = await receive()
        chunks.append(message.get("body", b""))
        more_body = message.get("more_body", False)
    return b"".join(chunks)


async def _send_response(send, status, body=b"", content_type="application/octet-stream", extra_headers=None):
    headers = [
        (b"content-type", content_type.encode("utf-8")),
        (b"cache-control", b"no-cache"),
    ]
    for key, value in (extra_headers or {}).items():
        headers.append((key.lower().encode("utf-8"), str(value).encode("utf-8")))
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": headers,
    })
    await send({
        "type": "http.response.body",
        "body": body if isinstance(body, bytes) else str(body).encode("utf-8"),
    })


async def _send_json(send, status, payload):
    await _send_response(
        send,
        status,
        json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        "application/json; charset=utf-8",
    )


async def _send_file(send, path):
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    await _send_response(send, 200, path.read_bytes(), content_type)


def _resolve_web_file(request_path):
    relative_path = request_path.lstrip("/") or "index.html"
    path = (WEB_DIR / relative_path).resolve()
    web_root = WEB_DIR.resolve()
    if not str(path).startswith(str(web_root)) or not path.is_file():
        return None
    return path


async def app(scope, receive, send):
    if scope["type"] != "http":
        await _send_response(send, 404, b"Unsupported scope", "text/plain")
        return

    method = scope.get("method", "GET").upper()
    path = scope.get("path", "/")
    query_string = scope.get("query_string", b"").decode("utf-8", errors="replace")

    if method == "POST" and path.startswith("/api/eel/"):
        function_name = path.removeprefix("/api/eel/")
        try:
            payload = json.loads((await _receive_body(receive)).decode("utf-8") or "{}")
        except Exception:
            payload = {}
        status, result = call_eel_function(function_name, payload)
        await _send_json(send, status, result)
        return

    if method == "GET" and path == "/api/compat/functions":
        await _send_json(send, 200, list_compat_functions())
        return

    if method == "GET" and path.startswith("/api/cache/"):
        status, cache_path = resolve_cache_file(path.removeprefix("/api/cache/"))
        if status != 200 or not cache_path:
            await _send_response(send, status, b"Cache file not found", "text/plain")
            return
        await _send_file(send, cache_path)
        return

    if method == "GET" and path == "/proxy/bilibili_image":
        status, body, content_type = proxy_bilibili_image(query_string)
        await _send_response(send, status, body, content_type)
        return

    if method == "GET" and path == "/eel.js":
        await _send_response(send, 200, "window.eel = window.eel || {};\n", "application/javascript")
        return

    if method in {"GET", "HEAD"}:
        file_path = _resolve_web_file(path)
        if file_path:
            await _send_file(send, file_path)
            return

    await _send_response(send, 404, b"Not found", "text/plain")
