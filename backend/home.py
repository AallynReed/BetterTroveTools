import datetime
import json
import os
import re
import traceback
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from html import unescape
from xml.etree import ElementTree as ET

import eel
import requests
from backend.response import resp, standardize_response

from utils.trove.server_time import ServerTime


def format_timedelta(td):
    days = td.days
    hours = td.seconds // 3600
    minutes = (td.seconds // 60) % 60
    if days > 0:
        return f"{days}d {hours}h"
    return f"{hours}h {minutes}m"

import gevent


RSS_NAMESPACES = {
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "media": "http://search.yahoo.com/mrss/",
}


_HOME_FETCH_GENERATION = 0
_HOME_FETCH_TASKS = set()
_DELVE_WEEK_CACHE = {}
_DELVE_HTTP = requests.Session()
_DELVE_HTTP.trust_env = False

DELVE_ROTATION_BASE = datetime(2025, 11, 3, tzinfo=UTC)
DELVE_ROTATION_URL = "https://trovesaurus.aallyn.net/delve_rotations/{week_id}"
DELVE_CACHE_TTL_SECONDS = 30 * 60


def _home_generation() -> int:
    return _HOME_FETCH_GENERATION


def _track_home_task(task):
    _HOME_FETCH_TASKS.add(task)

    def _cleanup(_task):
        _HOME_FETCH_TASKS.discard(_task)

    task.link(_cleanup)
    return task


def _spawn_home_fetch(fetcher):
    generation = _home_generation()

    def wrapped():
        try:
            fetcher(generation)
        except gevent.GreenletExit:
            raise

    return _track_home_task(gevent.spawn(wrapped))


def _home_fetch_is_active(generation: int) -> bool:
    return generation == _HOME_FETCH_GENERATION


def _finish_external_request(req_id, success):
    if not req_id:
        return
    try:
        eel.remove_external_request(req_id, success)()
    except Exception:
        pass


def _get_current_delve_week_id(now=None):
    current = now or datetime.now(UTC)
    elapsed = current - DELVE_ROTATION_BASE
    return max(1, int(elapsed.total_seconds() // (7 * 24 * 60 * 60)) + 1)


def _get_delve_week_window(week_id: int):
    start = DELVE_ROTATION_BASE + timedelta(weeks=max(0, week_id - 1))
    end = start + timedelta(weeks=1)
    return start, end


def _normalize_delve_enemy(enemy):
    if not isinstance(enemy, dict):
        return {"name": "Unknown", "bans": [], "count": 0}
    return {
        "name": enemy.get("n", "Unknown"),
        "bans": enemy.get("b") or [],
        "count": enemy.get("c", 0),
    }


def _normalize_delve_depth(depth):
    enemies = [_normalize_delve_enemy(enemy) for enemy in depth.get("enemies", [])]
    rooms = []
    for room_index, room in enumerate(depth.get("roomDetails", []), start=1):
        if not isinstance(room, dict):
            continue
        enemy_index = room.get("e")
        enemy = enemies[enemy_index] if isinstance(enemy_index, int) and 0 <= enemy_index < len(enemies) else None
        rooms.append({
            "room": room_index,
            "enemyIndex": enemy_index,
            "enemy": enemy,
        })

    boss = depth.get("boss") or {}
    return {
        "id": depth.get("id"),
        "depth": depth.get("depth"),
        "biome": depth.get("biome"),
        "zone": depth.get("zone"),
        "boss": {
            "name": boss.get("n", "Unknown"),
            "bans": boss.get("b") or [],
        },
        "objective": depth.get("objective"),
        "objectiveText": depth.get("objectiveText"),
        "killType": depth.get("killType"),
        "killAmount": depth.get("killAmount"),
        "killString": depth.get("killString"),
        "isVaultFloor": bool(depth.get("isVaultFloor")),
        "submittedBy": depth.get("submittedBy"),
        "enemies": enemies,
        "rooms": rooms,
    }


def _extract_delve_payload(payload):
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("depths"), list):
        return data
    return payload


def _fetch_delve_week(week_id: int, current_week_id: int | None = None):
    current_week_id = current_week_id or _get_current_delve_week_id()
    if week_id < 1 or week_id > current_week_id:
        return None

    cached = _DELVE_WEEK_CACHE.get(week_id)
    now_ts = datetime.now(UTC).timestamp()
    if cached and cached["data"].get("depthCount", 0) > 0 and (now_ts - cached["fetched_at"]) < DELVE_CACHE_TTL_SECONDS:
        return cached["data"]

    start, end = _get_delve_week_window(week_id)
    try:
        response = _DELVE_HTTP.get(
            DELVE_ROTATION_URL.format(week_id=week_id),
            timeout=15,
            headers={"User-Agent": "BetterTroveTools/1.0"},
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        payload = _extract_delve_payload(response.json())
    except Exception:
        if cached:
            return cached["data"]
        raise

    week_data = {
        "weekId": week_id,
        "isCurrent": week_id == current_week_id,
        "start": int(start.timestamp()),
        "end": int(end.timestamp()),
        "depths": [_normalize_delve_depth(depth) for depth in payload.get("depths", [])],
    }
    week_data["depthCount"] = len(week_data["depths"])
    week_data["hasData"] = week_data["depthCount"] > 0

    _DELVE_WEEK_CACHE[week_id] = {
        "fetched_at": now_ts,
        "data": week_data,
    }
    return week_data


@eel.expose
@standardize_response
def cancel_home_fetches():
    global _HOME_FETCH_GENERATION
    _HOME_FETCH_GENERATION += 1
    for task in list(_HOME_FETCH_TASKS):
        try:
            task.kill(block=False)
        except Exception:
            pass
    _HOME_FETCH_TASKS.clear()
    return resp(True, data={"cancelled": True})


def _strip_html(value):
    if not value:
        return ""
    if "<" not in value:
        return value.strip()
    stripped = re.sub(r"<br\s*/?>", " ", value, flags=re.IGNORECASE)
    stripped = re.sub(r"<[^>]+>", " ", stripped)
    return " ".join(unescape(stripped).split()).strip()


def _safe_strip_html(value):
    try:
        return _strip_html(value)
    except Exception:
        return " ".join(
            unescape(value or "")
            .replace("<br>", " ")
            .replace("<br/>", " ")
            .replace("<br />", " ")
            .split()
        ).strip()


def _truncate_text(value, limit=220):
    if len(value) <= limit:
        return value
    truncated = value[:limit].rsplit(" ", 1)[0].strip()
    return f"{truncated}..."


@eel.expose
@standardize_response
def get_twitch_streams():
    def fetch_task(generation):
        req_id = None
        try:
            req_id = eel.add_external_request("Fetching Twitch Streams", "https://trovesaurus.aallyn.net/twitch_streams")()
        except Exception:
            pass
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.aallyn.net/twitch_streams", headers=headers, timeout=10)
            response.raise_for_status()
            if not _home_fetch_is_active(generation):
                _finish_external_request(req_id, False)
                return
            _finish_external_request(req_id, True)
            data = response.json()
            eel.receive_twitch_streams(resp(True, data=data))
        except gevent.GreenletExit:
            _finish_external_request(req_id, False)
            raise
        except Exception as e:
            _finish_external_request(req_id, False)
            traceback.print_exc()
            if _home_fetch_is_active(generation):
                eel.receive_twitch_streams(resp(False, error=str(e), code="TWITCH_FETCH_FAILED"))
            
    _spawn_home_fetch(fetch_task)

@eel.expose
@standardize_response
def get_youtube_videos():
    def fetch_task(generation):
        req_id = None
        try:
            req_id = eel.add_external_request("Fetching YouTube Videos", "https://trovesaurus.aallyn.net/youtube_videos")()
        except Exception:
            pass
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.aallyn.net/youtube_videos", headers=headers, timeout=10)
            response.raise_for_status()
            if not _home_fetch_is_active(generation):
                _finish_external_request(req_id, False)
                return
            _finish_external_request(req_id, True)
            data = response.json()
            eel.receive_youtube_videos(resp(True, data=data))
        except gevent.GreenletExit:
            _finish_external_request(req_id, False)
            raise
        except Exception as e:
            _finish_external_request(req_id, False)
            traceback.print_exc()
            if _home_fetch_is_active(generation):
                eel.receive_youtube_videos(resp(False, error=str(e), code="YOUTUBE_FETCH_FAILED"))
            
    _spawn_home_fetch(fetch_task)

@eel.expose
@standardize_response
def get_bilibili_videos():
    def fetch_task(generation):
        req_id = None
        try:
            req_id = eel.add_external_request("Fetching BiliBili Videos", "https://trovesaurus.aallyn.net/bilibili_videos")()
        except Exception:
            pass
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.aallyn.net/bilibili_videos", headers=headers, timeout=10)
            response.raise_for_status()
            if not _home_fetch_is_active(generation):
                _finish_external_request(req_id, False)
                return
            _finish_external_request(req_id, True)
            data = response.json()
            eel.receive_bilibili_videos(resp(True, data=data))
        except gevent.GreenletExit:
            _finish_external_request(req_id, False)
            raise
        except Exception as e:
            _finish_external_request(req_id, False)
            traceback.print_exc()
            if _home_fetch_is_active(generation):
                eel.receive_bilibili_videos(resp(False, error=str(e), code="BILIBILI_FETCH_FAILED"))
            
    _spawn_home_fetch(fetch_task)

@eel.expose
@standardize_response
def get_trovesaurus_events():
    def fetch_task(generation):
        req_id = None
        try:
            req_id = eel.add_external_request("Fetching Trovesaurus Events", "https://trovesaurus.com/calendar/feed")()
        except Exception:
            pass
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.com/calendar/feed", headers=headers, timeout=3)
            response.raise_for_status()
            if not _home_fetch_is_active(generation):
                _finish_external_request(req_id, False)
                return
            _finish_external_request(req_id, True)
            events = response.json()
            events.sort(key=lambda x: int(x['startdate']))
            eel.receive_events_data(resp(True, data=events))
        except gevent.GreenletExit:
            _finish_external_request(req_id, False)
            raise
        except Exception as e:
            _finish_external_request(req_id, False)
            traceback.print_exc()
            if _home_fetch_is_active(generation):
                eel.receive_events_data(resp(False, error=str(e), code="EVENTS_FETCH_FAILED"))
            
    _spawn_home_fetch(fetch_task)


@eel.expose
@standardize_response
def get_trove_news():
    def fetch_task(generation):
        req_id = None
        try:
            req_id = eel.add_external_request("Fetching Trove News", "https://trovegame.com/feed")()
        except Exception:
            pass
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovegame.com/feed", headers=headers, timeout=8)
            response.raise_for_status()
            if not _home_fetch_is_active(generation):
                _finish_external_request(req_id, False)
                return
            _finish_external_request(req_id, True)

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
                categories = [unescape((cat.text or "").strip()) for cat in item.findall("category") if (cat.text or "").strip()]

                published_at = pub_date_raw
                try:
                    published_at = parsedate_to_datetime(pub_date_raw).astimezone(UTC).isoformat()
                except Exception:
                    pass

                summary = _safe_strip_html(unescape(description))
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
                    "summary": _truncate_text(summary, 220),
                    "category": categories[0] if categories else "News",
                    "categories": categories,
                    "image": image,
                })

                if len(items) >= 20:
                    break

            eel.receive_trove_news(resp(True, data=items))
        except gevent.GreenletExit:
            _finish_external_request(req_id, False)
            raise
        except Exception as e:
            _finish_external_request(req_id, False)
            traceback.print_exc()
            if _home_fetch_is_active(generation):
                eel.receive_trove_news(resp(False, error=str(e), code="NEWS_FETCH_FAILED"))

    _spawn_home_fetch(fetch_task)

@eel.expose
@standardize_response
def get_current_server_data():
    try:
        st = ServerTime()
        
        corr_active = st.is_dragon(st.first_corruxion)
        corr_time = st.until_end_dragon(st.first_corruxion) if corr_active else st.until_next_dragon(st.first_corruxion)
        
        flux_active = st.is_fluxion()
        flux_state = "Voting" if st.is_fluxion_voting() else ("Selling" if st.is_fluxion_selling() else "Away")
        flux_time = st.until_end_fluxion() if flux_active else st.until_next_fluxion()
        
        inv_active = st.is_invasion()
        inv_time = st.until_end_invasion() if inv_active else st.until_next_invasion()

        merchants = {
            "corruxion": {
                "active": corr_active,
                "time_str": format_timedelta(corr_time),
                "action": "Leaves in" if corr_active else "Arrives in"
            },
            "fluxion": {
                "active": flux_active,
                "state": flux_state,
                "time_str": format_timedelta(flux_time),
                "action": "Ends in" if flux_active else "Starts in"
            },
            "invasion": {
                "active": inv_active,
                "time_str": format_timedelta(inv_time),
                "action": "Ends in" if inv_active else "Starts in"
            }
        }

        data = {
            "daily": st.current_daily_buffs,
            "weekly": st.current_weekly_buffs,
            "merchants": merchants,
        }
        return resp(True, data=data, **data)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="CURRENT_SERVER_DATA_FAILED")

@eel.expose
@standardize_response
def get_chaos_chest_data():
    fallback_times = None
    try:
        from utils.trove.server_time import ServerTime
        st = ServerTime()
        now = datetime.now(UTC)
        
        real_base = st.first_fluxion + timedelta(hours=11)
        diff = (now - real_base).total_seconds()
        intervals = int(diff // (7 * 24 * 3600))
        
        curr_s = real_base + timedelta(days=intervals * 7)
        curr_e = curr_s + timedelta(days=7)
        
        fallback_times = {
            "start": int(curr_s.timestamp()),
            "end": int(curr_e.timestamp())
        }
    except Exception:
        pass

    req_id = None
    try:
        req_id = eel.add_external_request("Fetching Chaos Chest Data", "https://trovesaurus.com/api/chaos-chest")()
    except Exception:
        pass

    try:
        headers = {"User-Agent": "BetterTroveTools/1.0"}
        response = requests.get("https://trovesaurus.com/api/chaos-chest", headers=headers, timeout=3)
        
        if req_id:
            eel.remove_external_request(req_id, response.status_code == 200)()

        if response.status_code == 200:
            payload = response.json()

            # Defensive normalization in case the endpoint shape changes.
            if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
                payload = payload["data"]
            elif isinstance(payload, list):
                payload = payload[0] if payload else {}

            if isinstance(payload, dict):
                name = payload.get("name")
                start = payload.get("start")
                end = payload.get("end")
                identifier = payload.get("identifier")
                blueprint = payload.get("blueprint")

                if isinstance(blueprint, str):
                    blueprint = blueprint.lower()
                if isinstance(identifier, str):
                    identifier = identifier.replace("\\", "/")

                normalized = {
                    "name": name,
                    "start": int(start) if start is not None else None,
                    "end": int(end) if end is not None else None,
                    "identifier": identifier,
                    "blueprint": blueprint,
                }

                required = ("name", "start", "end", "identifier", "blueprint")
                if all(normalized.get(k) is not None for k in required):
                    return resp(True, data=normalized, fallback_times=fallback_times)

        return resp(True, data=None, fallback_times=fallback_times)
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        if fallback_times:
            return resp(True, data=None, fallback_times=fallback_times)
        return resp(False, error=str(e), code="CHAOS_CHEST_FETCH_FAILED")

@eel.expose
@standardize_response
def get_merchant_schedules():
    try:
        from utils.trove.server_time import ServerTime
        st = ServerTime()
        now = datetime.now(UTC)
        
        def generate_dragon_schedule(base_date):
            schedule = []
            real_base = base_date + timedelta(hours=11)
            diff = (now - real_base).total_seconds()
            intervals = int(diff // (14 * 24 * 3600))
            s = real_base + timedelta(days=intervals * 14)
            if s + timedelta(days=3) < now:
                s += timedelta(days=14)
            for i in range(8):
                curr_s = s + timedelta(days=i * 14)
                curr_e = curr_s + timedelta(days=3)
                schedule.append({
                    "start": int(curr_s.timestamp()),
                    "end": int(curr_e.timestamp())
                })
            return schedule

        def generate_fluxion_schedule():
            schedule = []
            real_base = st.first_fluxion + timedelta(hours=11)
            diff = (now - real_base).total_seconds()
            intervals = int(diff // (7 * 24 * 3600))
            s = real_base + timedelta(days=intervals * 7)
            if s + timedelta(days=3) < now:
                s += timedelta(days=7)
                intervals += 1
            for i in range(8):
                curr_s = s + timedelta(days=i * 7)
                curr_e = curr_s + timedelta(days=3)
                phase = (intervals + i) % 2
                schedule.append({
                    "start": int(curr_s.timestamp()),
                    "end": int(curr_e.timestamp()),
                    "name": "Voting" if phase == 0 else "Selling"
                })
            return schedule

        def generate_invasion_schedule():
            schedule = []
            completed, _ = st._get_current_invasion_cycle()
            check_cycle = completed
            while len(schedule) < 8:
                inv_start = st.first_invasion + check_cycle * st.invasion_interval
                if st._is_invasion_week(inv_start):
                    inv_end = inv_start + st.invasion_duration
                    if inv_end > st.now:
                        real_s = inv_start + timedelta(hours=11)
                        real_e = inv_end + timedelta(hours=11)
                        schedule.append({
                            "start": int(real_s.timestamp()),
                            "end": int(real_e.timestamp())
                        })
                check_cycle += 1
            return schedule

        data = {
            "corruxion": generate_dragon_schedule(st.first_corruxion),
            "fluxion": generate_fluxion_schedule(),
            "invasion": generate_invasion_schedule(),
        }
        return resp(True, data=data, **data)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="MERCHANT_SCHEDULES_FAILED")


biome1 = [
    "Sundered Uplands", "Cerise Sandsea", "Deep Forest", "Alkali Flats", 
    "Dead of Winter", "Sundered Uplands", "Firefly Party", "Desert of Secrets", 
    "Weathered Wastelands", "Frozen Wastes", "Frigga's Fjord", "Abandoned Boneyard"
]
biome2 = [
    "Cursed Vale", "Hollow Dunes", "Bewitching Wood", "Primal Preserve", 
    "Hollow Dunes", "Ancient Heights", "Viking Burial Grounds", "Spellbound Thicket", 
    "Saurian Swamp", "Restless Range", "Uncanny Valley"
]
biome3 = [
    "Sugar Steppes", "Volcanic Fields", "The Lost Isles", "Luminopolis", 
    "The Lost Isles", "Blazing Emberlands", "Cocoa Craters", "Data Spires", 
    "The Lost Isles", "Cupcake Canyon", "Dragon's Teeth", "Luminopolis", 
    "The Lost Isles", "Data Spires"
]

@eel.expose
@standardize_response
def get_yearly_calendar_data():
    try:
        now = datetime.now(UTC)
        start_date = now - timedelta(days=365)
        end_date = now + timedelta(days=365)
        
        events = []

        try:
            st = ServerTime()
            current_weekly = st.current_weekly_buffs
            weekly_buffs_path = os.path.join(os.getcwd(), "web", "assets", "data", "weekly_buffs.json")
            
            with open(weekly_buffs_path, "r", encoding="utf-8") as f:
                weekly_buffs_data = json.load(f)
                
            weekly_keys = sorted(weekly_buffs_data.keys(), key=lambda x: int(x))
            current_index = next((int(k) for k in weekly_keys if weekly_buffs_data[k].get("name") == current_weekly.get("name")), 0)
                    
            days_since_monday = now.weekday()
            current_week_start = now.replace(hour=11, minute=0, second=0, microsecond=0) - timedelta(days=days_since_monday)
            if now < current_week_start:
                current_week_start -= timedelta(days=7)
                
            for w_offset in range(-55, 55):
                s_week = current_week_start + timedelta(weeks=w_offset)
                e_week = s_week + timedelta(weeks=1)
                
                if e_week > start_date and s_week < end_date:
                    buff_idx = (current_index + w_offset) % len(weekly_keys)
                    buff = weekly_buffs_data[weekly_keys[buff_idx]]
                    events.append({
                        "type": "weekly_buff", "start": int(s_week.timestamp()), "end": int(e_week.timestamp()), 
                        "name": buff.get("name", "Weekly Buff"), "color": buff.get("color", "fbc02d")
                    })
        except Exception as e:
            traceback.print_exc()
        
        biomes_path = os.path.join(os.getcwd(), "web", "assets", "data", "biomes.json")
        try:
            with open(biomes_path, "r", encoding="utf-8") as f:
                subbiomes = json.load(f)
        except Exception:
            subbiomes = {}

        icon_map = {}
        for key, val in subbiomes.items():
            parent_biome = val.get("biome")
            if parent_biome and parent_biome not in icon_map:
                icon_map[parent_biome] = val.get("icon", "unknown")

        fallback_map = {
            "Neon City": "neon", "Jurassic Jungle": "dinosaur", "Dragonfire Peaks": "dragon",
            "Forbidden Spires": "spires", "Sundered Uplands": "giantland", "Medieval Highlands": "forest",
            "Permafrost": "tundra", "Cursed Vale": "undead", "Desert Frontier": "frontier",
            "Fae Forest": "fae", "Candoria": "candy", "Geode Topside": "dunes", "The Lost Isles": "pirate"
        }
        
        stampy_biomes = ['Desert Frontier', 'The Lost Isles', 'Geode Topside', 'Neon City', 'Dragonfire Peaks', 'Permafrost', 'Candoria', 'Cursed Vale', 'Forbidden Spires', 'Fae Forest', 'Medieval Highlands', 'Jurassic Jungle', 'Sundered Uplands']
        base_stampy = datetime(2023, 9, 30, 11, 0, 0, tzinfo=UTC) 
        diff = (start_date - base_stampy).total_seconds()
        weeks_stampy = int(diff // (7 * 24 * 3600))
        s = base_stampy + timedelta(weeks=weeks_stampy)
        while s < end_date:
            e = s + timedelta(hours=48)
            if e > start_date:
                b = stampy_biomes[weeks_stampy % len(stampy_biomes)]
                icon = icon_map.get(b, fallback_map.get(b, "unknown"))
                events.append({"type": "stampy", "start": int(s.timestamp()), "end": int(e.timestamp()), "name": "Stampy", "icons": [icon], "biome_names": [b]})
            s += timedelta(weeks=1)
            weeks_stampy += 1
            
        mana_biomes = ["Neon City", "Jurassic Jungle", "Dragonfire Peaks", "Forbidden Spires", "Sundered Uplands", "Medieval Highlands", "Permafrost", "Cursed Vale", "Desert Frontier", "Fae Forest", "Candoria"]
        base_mana = datetime(2023, 11, 20, 11, 0, 0, tzinfo=UTC)
        diff = (start_date - base_mana).total_seconds()
        weeks_mana = int(diff // (7 * 24 * 3600))
        s = base_mana + timedelta(weeks=weeks_mana)
        while s < end_date:
            e = s + timedelta(days=7)
            if e > start_date:
                b0 = mana_biomes[weeks_mana % len(mana_biomes)]
                b1 = mana_biomes[(weeks_mana - 1) % len(mana_biomes)]
                b2 = mana_biomes[(weeks_mana - 2) % len(mana_biomes)]
                icon0 = icon_map.get(b0, fallback_map.get(b0, "unknown"))
                icon1 = icon_map.get(b1, fallback_map.get(b1, "unknown"))
                icon2 = icon_map.get(b2, fallback_map.get(b2, "unknown"))
                events.append({"type": "mana", "start": int(s.timestamp()), "end": int(e.timestamp()), "name": "Wild Mana", "icons": [icon0, icon1, icon2], "biome_names": [b0, b1, b2]})
            s += timedelta(weeks=1)
            weeks_mana += 1
            
        def generate_merchant_events(base_date, interval_days, duration_days, m_type, name):
            diff = (start_date - base_date).total_seconds()
            intervals = int(diff // (interval_days * 24 * 3600))
            s = base_date + timedelta(days=intervals * interval_days)
            while s < end_date:
                e = s + timedelta(days=duration_days)
                if e > start_date:
                    events.append({"type": m_type, "start": int(s.timestamp()), "end": int(e.timestamp()), "name": name})
                s += timedelta(days=interval_days)
                
        def generate_fluxion_events(base_date, interval_days):
            diff = (start_date - base_date).total_seconds()
            intervals = int(diff // (interval_days * 24 * 3600))
            s = base_date + timedelta(days=intervals * interval_days)
            while s < end_date:
                s_vote = s
                e_vote = s_vote + timedelta(days=3)
                
                s_sell = s + timedelta(days=7)
                e_sell = s_sell + timedelta(days=3)
                
                if e_vote > start_date:
                    events.append({"type": "fluxion", "start": int(s_vote.timestamp()), "end": int(e_vote.timestamp()), "name": "Fluxion (Voting)", "color": "5ca8cc"})
                if e_sell > start_date and s_sell < end_date:
                    events.append({"type": "fluxion", "start": int(s_sell.timestamp()), "end": int(e_sell.timestamp()), "name": "Fluxion (Selling)", "color": "02679e"})
                s += timedelta(days=interval_days)
                
        def generate_gardening_events():
            st_temp = ServerTime()
            base_gardening = st_temp.first_gardening + timedelta(hours=11)
            
            diff_2 = (start_date - base_gardening).total_seconds()
            cycles_2 = int(diff_2 // (2 * 24 * 3600))
            s_2 = base_gardening + timedelta(days=cycles_2 * 2)
            while s_2 < end_date:
                h_start = s_2 + timedelta(days=1)
                h_end = s_2 + timedelta(days=2)
                if h_end > start_date and h_start < end_date:
                    events.append({"type": "gardening_2", "start": int(h_start.timestamp()), "end": int(h_end.timestamp()), "name": "2-day plants", "color": "8bc34a"})
                s_2 += timedelta(days=2)
                
            diff_3 = (start_date - base_gardening).total_seconds()
            cycles_3 = int(diff_3 // (3 * 24 * 3600))
            s_3 = base_gardening + timedelta(days=cycles_3 * 3)
            while s_3 < end_date:
                h_start = s_3 + timedelta(days=2)
                h_end = s_3 + timedelta(days=3)
                if h_end > start_date and h_start < end_date:
                    events.append({"type": "gardening_3", "start": int(h_start.timestamp()), "end": int(h_end.timestamp()), "name": "3-day plants", "color": "4caf50"})
                s_3 += timedelta(days=3)
                
        def generate_invasion_events():
            st_temp = ServerTime()
            trove_start_date = start_date - timedelta(hours=11)
            trove_end_date = end_date - timedelta(hours=11)
            diff = (trove_start_date - st_temp.first_invasion).total_seconds()
            check_cycle = int(diff // st_temp.invasion_interval.total_seconds())
            s = st_temp.first_invasion + check_cycle * st_temp.invasion_interval
            while s < trove_end_date:
                e = s + st_temp.invasion_duration
                if e > trove_start_date and st_temp._is_invasion_week(s):
                    real_s = s + timedelta(hours=11)
                    real_e = e + timedelta(hours=11)
                    events.append({"type": "invasion", "start": int(real_s.timestamp()), "end": int(real_e.timestamp()), "name": "Luxion's Fast Trials"})
                s += st_temp.invasion_interval
                check_cycle += 1

        base_corruxion = datetime(2023, 12, 8, 11, 0, 0, tzinfo=UTC)
        base_fluxion = datetime(2023, 12, 5, 11, 0, 0, tzinfo=UTC)

        generate_merchant_events(base_corruxion, 14, 3, "corruxion", "Corruxion")
        generate_fluxion_events(base_fluxion, 14)
        generate_gardening_events()
        generate_invasion_events()

        return resp(True, data={"events": events}, events=events)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="YEARLY_CALENDAR_FAILED")

@eel.expose
@standardize_response
def get_gardening_rotation():
    try:
        from utils.trove.server_time import ServerTime
        st = ServerTime()
        now = datetime.now(UTC)
        
        base_date = st.first_gardening + timedelta(hours=11)
        rotations = []
        
        now_ts = now.timestamp()
        diff_2 = (now - base_date).total_seconds()
        cycles_2 = int(diff_2 // (2 * 24 * 3600))
        current_2_s = base_date + timedelta(days=cycles_2 * 2)
        h2_start = current_2_s + timedelta(days=1)
        h2_end = current_2_s + timedelta(days=2)
        
        two_day = {
            "name": "2-day plants",
            "active": h2_start.timestamp() <= now_ts < h2_end.timestamp(),
            "start": int(h2_start.timestamp()),
            "end": int(h2_end.timestamp())
        }
        
        diff_3 = (now - base_date).total_seconds()
        cycles_3 = int(diff_3 // (3 * 24 * 3600))
        current_3_s = base_date + timedelta(days=cycles_3 * 3)
        h3_start = current_3_s + timedelta(days=2)
        h3_end = current_3_s + timedelta(days=3)
        
        three_day = {
            "name": "3-day plants",
            "active": h3_start.timestamp() <= now_ts < h3_end.timestamp(),
            "start": int(h3_start.timestamp()),
            "end": int(h3_end.timestamp())
        }
        
        future_events = []
        for i in range(0, 8):
            s = current_2_s + timedelta(days=i * 2)
            h_start = s + timedelta(days=1)
            h_end = s + timedelta(days=2)
            if h_start.timestamp() > now_ts:
                future_events.append({"name": "2-day plants", "start": int(h_start.timestamp()), "end": int(h_end.timestamp())})
                
            s = current_3_s + timedelta(days=i * 3)
            h_start = s + timedelta(days=2)
            h_end = s + timedelta(days=3)
            if h_start.timestamp() > now_ts:
                future_events.append({"name": "3-day plants", "start": int(h_start.timestamp()), "end": int(h_end.timestamp())})
                
        future_events.sort(key=lambda x: x["start"])
        
        data = {
            "two_day": two_day,
            "three_day": three_day,
            "future": future_events[:10],
        }
        return resp(True, data=data, **data)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GARDENING_ROTATION_FAILED")

system_epoch = datetime.fromtimestamp(1718708400, UTC)
system_interval = 60 * 60 * 3

@eel.expose
@standardize_response
def get_d15_rotation():
    biomes_path = os.path.join(os.getcwd(), "web", "assets", "data", "biomes.json")
    try:
        with open(biomes_path, "r", encoding="utf-8") as f:
            subbiomes = json.load(f)
    except Exception as e:
        return resp(False, error=str(e), code="D15_ROTATION_BIOMES_FAILED")

    now = datetime.now(UTC)
    elapsed = (now - system_epoch).total_seconds()
    consumed = int(elapsed // system_interval)
    
    start = now - timedelta(seconds=elapsed % system_interval)

    rotations = []
    for i in range(-8, 56):
        current_offset = consumed + i
        s = start + timedelta(seconds=i * system_interval)
        e = s + timedelta(seconds=system_interval)
        
        _, b1_idx = divmod(current_offset, len(biome1))
        _, b2_idx = divmod(current_offset, len(biome2))
        _, b3_idx = divmod(current_offset, len(biome3))

        rot_data = {
            "start": int(s.timestamp()),
            "end": int(e.timestamp()),
            "biomes": [
                subbiomes.get(biome1[b1_idx], {"name": biome1[b1_idx], "final_name": biome1[b1_idx], "icon": "unknown"}),
                subbiomes.get(biome2[b2_idx], {"name": biome2[b2_idx], "final_name": biome2[b2_idx], "icon": "unknown"}),
                subbiomes.get(biome3[b3_idx], {"name": biome3[b3_idx], "final_name": biome3[b3_idx], "icon": "unknown"})
            ]
        }
        rotations.append(rot_data)

    now_ts = now.timestamp()
    current_rot = next((rot for rot in rotations if rot['start'] <= now_ts < rot['end']), None)

    data = {
        "current": current_rot,
        "rotations": rotations,
    }
    return resp(True, data=data, **data)


@eel.expose
@standardize_response
def get_wild_mana_rotation():
    biomes_path = os.path.join(os.getcwd(), "web", "assets", "data", "biomes.json")
    try:
        with open(biomes_path, "r", encoding="utf-8") as f:
            subbiomes = json.load(f)
    except Exception as e:
        return resp(False, error=str(e), code="WILD_MANA_BIOMES_FAILED")

    icon_map = {}
    for key, val in subbiomes.items():
        parent_biome = val.get("biome")
        if parent_biome and parent_biome not in icon_map:
            icon_map[parent_biome] = val.get("icon", "unknown")

    fallback_map = {
        "Neon City": "neon", "Jurassic Jungle": "dinosaur", "Dragonfire Peaks": "dragon",
        "Forbidden Spires": "spires", "Sundered Uplands": "giantland", "Medieval Highlands": "forest",
        "Permafrost": "tundra", "Cursed Vale": "undead", "Desert Frontier": "frontier",
        "Fae Forest": "fae", "Candoria": "candy"
    }

    biomes = [
        "Neon City", "Jurassic Jungle", "Dragonfire Peaks", "Forbidden Spires", 
        "Sundered Uplands", "Medieval Highlands", "Permafrost", "Cursed Vale", 
        "Desert Frontier", "Fae Forest", "Candoria"
    ]

    start_date = datetime(2023, 11, 20, 11, 0, 0, tzinfo=UTC)
    now = datetime.now(UTC)
    
    elapsed = (now - start_date).total_seconds()
    week_seconds = 7 * 24 * 60 * 60
    
    weeks_since_start = int(elapsed // week_seconds)
    
    current_rot = {}
    future_rots = []

    for i in range(8):
        w = weeks_since_start + i
        s = start_date + timedelta(seconds=w * week_seconds)
        e = s + timedelta(seconds=week_seconds)
        
        i0 = w % len(biomes)
        i1 = (w - 1) % len(biomes)
        i2 = (w - 2) % len(biomes)
        
        b0, b1, b2 = biomes[i0], biomes[i1], biomes[i2]
        
        rot_data = {
            "start": int(s.timestamp()),
            "end": int(e.timestamp()),
            "biomes": [
                {"name": b0, "final_name": b0, "icon": icon_map.get(b0, fallback_map.get(b0, "unknown"))},
                {"name": b1, "final_name": b1, "icon": icon_map.get(b1, fallback_map.get(b1, "unknown"))},
                {"name": b2, "final_name": b2, "icon": icon_map.get(b2, fallback_map.get(b2, "unknown"))}
            ]
        }
        
        if i == 0:
            current_rot = rot_data
        else:
            future_rots.append(rot_data)

    data = {
        "current": current_rot,
        "future": future_rots,
    }
    return resp(True, data=data, **data)


@eel.expose
@standardize_response
def get_delve_status():
    try:
        current_week_id = _get_current_delve_week_id()
        start, end = _get_delve_week_window(current_week_id)
        data = {
            "currentWeekId": current_week_id,
            "start": int(start.timestamp()),
            "end": int(end.timestamp()),
        }
        return resp(True, data=data, **data)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="DELVE_STATUS_FAILED")


@eel.expose
@standardize_response
def get_delve_rotation():
    try:
        current_week_id = _get_current_delve_week_id()
        weeks = []
        for week_id in range(current_week_id, 0, -1):
            week_data = _fetch_delve_week(week_id, current_week_id=current_week_id)
            if week_data is not None and week_data.get("hasData"):
                weeks.append(week_data)

        if not weeks:
            return resp(False, error="No delve data found", code="DELVE_ROTATION_NOT_FOUND")

        data = {
            "currentWeekId": current_week_id,
            "current": next((week for week in weeks if week.get("isCurrent")), weeks[0]),
            "weeks": weeks,
        }
        return resp(True, data=data, **data)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="DELVE_ROTATION_FAILED")


@eel.expose
@standardize_response
def get_stampy_rotation():
    biomes_path = os.path.join(os.getcwd(), "web", "assets", "data", "biomes.json")
    try:
        with open(biomes_path, "r", encoding="utf-8") as f:
            subbiomes = json.load(f)
    except Exception as e:
        return resp(False, error=str(e), code="STAMPY_BIOMES_FAILED")

    icon_map = {}
    for key, val in subbiomes.items():
        parent_biome = val.get("biome")
        if parent_biome and parent_biome not in icon_map:
            icon_map[parent_biome] = val.get("icon", "unknown")

    fallback_map = {
        "Neon City": "neon", "Jurassic Jungle": "dinosaur", "Dragonfire Peaks": "dragon",
        "Forbidden Spires": "spires", "Sundered Uplands": "giantland", "Medieval Highlands": "forest",
        "Permafrost": "tundra", "Cursed Vale": "undead", "Desert Frontier": "frontier",
        "Fae Forest": "fae", "Candoria": "candy", "Geode Topside": "dunes", "The Lost Isles": "pirate"
    }

    biomes = [
        'Desert Frontier', 'The Lost Isles', 'Geode Topside', 'Neon City', 'Dragonfire Peaks',
        'Permafrost', 'Candoria', 'Cursed Vale', 'Forbidden Spires', 'Fae Forest', 
        'Medieval Highlands', 'Jurassic Jungle', 'Sundered Uplands'
    ]

    base_date = datetime(2023, 9, 30, 11, 0, 0, tzinfo=UTC)
    now = datetime.now(UTC)
    
    weeks_offset = int((now - base_date).total_seconds() // (7 * 24 * 3600))
    
    events = []
    for w in range(weeks_offset - 1, weeks_offset + 10):
        s = base_date + timedelta(weeks=w)
        e = s + timedelta(hours=48) 
        
        if e > now:
            b = biomes[w % len(biomes)]
            events.append({
                "start": int(s.timestamp()),
                "end": int(e.timestamp()),
                "biomes": [{"name": b, "final_name": b, "icon": icon_map.get(b, fallback_map.get(b, "unknown"))}]
            })
            if len(events) == 8: 
                break
                
    if not events:
        return resp(False, error="No valid Stampy events found", code="STAMPY_EVENTS_NOT_FOUND")

    data = {
        "current": events[0],
        "future": events[1:],
    }
    return resp(True, data=data, **data)
