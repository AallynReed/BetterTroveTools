import datetime
import json
import os
import traceback
from datetime import UTC, datetime, timedelta

import eel
import requests

from utils.trove.server_time import ServerTime


def format_timedelta(td):
    days = td.days
    hours = td.seconds // 3600
    minutes = (td.seconds // 60) % 60
    if days > 0:
        return f"{days}d {hours}h"
    return f"{hours}h {minutes}m"

import threading


@eel.expose
def get_twitch_streams():
    def fetch_task():
        req_id = None
        try:
            req_id = eel.add_external_request("Fetching Twitch Streams", "https://trovesaurus.aallyn.net/twitch_streams")()
        except Exception:
            pass
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.aallyn.net/twitch_streams", headers=headers, timeout=10)
            response.raise_for_status()
            if req_id:
                eel.remove_external_request(req_id, True)()
            eel.receive_twitch_streams({"success": True, "data": response.json()})
        except Exception as e:
            if req_id:
                eel.remove_external_request(req_id, False)()
            traceback.print_exc()
            eel.receive_twitch_streams({"success": False, "error": str(e)})
            
    threading.Thread(target=fetch_task, daemon=True).start()

@eel.expose
def get_youtube_videos():
    def fetch_task():
        req_id = None
        try:
            req_id = eel.add_external_request("Fetching YouTube Videos", "https://trovesaurus.aallyn.net/youtube_videos")()
        except Exception:
            pass
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.aallyn.net/youtube_videos", headers=headers, timeout=10)
            response.raise_for_status()
            if req_id:
                eel.remove_external_request(req_id, True)()
            eel.receive_youtube_videos({"success": True, "data": response.json()})
        except Exception as e:
            if req_id:
                eel.remove_external_request(req_id, False)()
            traceback.print_exc()
            eel.receive_youtube_videos({"success": False, "error": str(e)})
            
    threading.Thread(target=fetch_task, daemon=True).start()

@eel.expose
def get_trovesaurus_events():
    def fetch_task():
        req_id = None
        try:
            req_id = eel.add_external_request("Fetching Trovesaurus Events", "https://trovesaurus.com/calendar/feed")()
        except Exception:
            pass
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.com/calendar/feed", headers=headers, timeout=3)
            response.raise_for_status()
            if req_id:
                eel.remove_external_request(req_id, True)()
            events = response.json()
            events.sort(key=lambda x: int(x['startdate']))
            eel.receive_events_data({"success": True, "data": events})
        except Exception as e:
            if req_id:
                eel.remove_external_request(req_id, False)()
            traceback.print_exc()
            eel.receive_events_data({"success": False, "error": str(e)})
            
    threading.Thread(target=fetch_task, daemon=True).start()

@eel.expose
def get_current_server_data():
    try:
        st = ServerTime()
        
        lux_active = st.is_dragon(st.first_luxion)
        lux_time = st.until_end_dragon(st.first_luxion) if lux_active else st.until_next_dragon(st.first_luxion)
        
        corr_active = st.is_dragon(st.first_corruxion)
        corr_time = st.until_end_dragon(st.first_corruxion) if corr_active else st.until_next_dragon(st.first_corruxion)
        
        flux_active = st.is_fluxion()
        flux_state = "Voting" if st.is_fluxion_voting() else ("Selling" if st.is_fluxion_selling() else "Away")
        flux_time = st.until_end_fluxion() if flux_active else st.until_next_fluxion()
        
        inv_active = st.is_invasion()
        inv_time = st.until_end_invasion() if inv_active else st.until_next_invasion()

        merchants = {
            "luxion": {
                "active": lux_active,
                "time_str": format_timedelta(lux_time),
                "action": "Leaves in" if lux_active else "Arrives in"
            },
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

        return {
            "success": True,
            "daily": st.current_daily_buffs,
            "weekly": st.current_weekly_buffs,
            "merchants": merchants
        }
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
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
        resp = requests.get("https://trovesaurus.com/api/chaos-chest", headers=headers, timeout=3)
        
        if req_id:
            eel.remove_external_request(req_id, resp.status_code == 200)()
            
        if resp.status_code == 200:
            data = resp.json()
            now_ts = datetime.now(UTC).timestamp()
            if data.get("start", 0) <= now_ts <= data.get("end", 0):
                return {"success": True, "data": data, "fallback_times": fallback_times}
                
        return {"success": True, "data": None, "fallback_times": fallback_times}
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        if fallback_times:
            return {"success": True, "data": None, "fallback_times": fallback_times}
        return {"success": False, "error": str(e)}

@eel.expose
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

        return {
            "success": True,
            "luxion": generate_dragon_schedule(st.first_luxion),
            "corruxion": generate_dragon_schedule(st.first_corruxion),
            "fluxion": generate_fluxion_schedule(),
            "invasion": generate_invasion_schedule()
        }
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}


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

        base_luxion = datetime(2023, 12, 1, 11, 0, 0, tzinfo=UTC)
        base_corruxion = datetime(2023, 12, 8, 11, 0, 0, tzinfo=UTC)
        base_fluxion = datetime(2023, 12, 5, 11, 0, 0, tzinfo=UTC)

        generate_merchant_events(base_luxion, 14, 3, "luxion", "Luxion")
        generate_merchant_events(base_corruxion, 14, 3, "corruxion", "Corruxion")
        generate_fluxion_events(base_fluxion, 14)
        generate_invasion_events()

        return {"success": True, "events": events}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

system_epoch = datetime.fromtimestamp(1718708400, UTC)
system_interval = 60 * 60 * 3

@eel.expose
def get_d15_rotation():
    biomes_path = os.path.join(os.getcwd(), "web", "assets", "data", "biomes.json")
    try:
        with open(biomes_path, "r", encoding="utf-8") as f:
            subbiomes = json.load(f)
    except Exception as e:
        return {"success": False, "error": str(e)}

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

    return {
        "success": True,
        "current": current_rot,
        "rotations": rotations
    }


@eel.expose
def get_wild_mana_rotation():
    biomes_path = os.path.join(os.getcwd(), "web", "assets", "data", "biomes.json")
    try:
        with open(biomes_path, "r", encoding="utf-8") as f:
            subbiomes = json.load(f)
    except Exception as e:
        return {"success": False, "error": str(e)}

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

    return {
        "success": True,
        "current": current_rot,
        "future": future_rots
    }


@eel.expose
def get_stampy_rotation():
    biomes_path = os.path.join(os.getcwd(), "web", "assets", "data", "biomes.json")
    try:
        with open(biomes_path, "r", encoding="utf-8") as f:
            subbiomes = json.load(f)
    except Exception as e:
        return {"success": False, "error": str(e)}

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
        return {"success": False, "error": "No valid Stampy events found"}

    return {
        "success": True,
        "current": events[0],
        "future": events[1:]
    }