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
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.aallyn.xyz/twitch_streams", headers=headers, timeout=10)
            response.raise_for_status()
            eel.receive_twitch_streams({"success": True, "data": response.json()})
        except Exception as e:
            traceback.print_exc()
            eel.receive_twitch_streams({"success": False, "error": str(e)})
            
    threading.Thread(target=fetch_task, daemon=True).start()

@eel.expose
def get_trovesaurus_events():
    def fetch_task():
        try:
            headers = {"User-Agent": "BetterTroveTools/1.0"}
            response = requests.get("https://trovesaurus.com/calendar/feed", headers=headers, timeout=3)
            response.raise_for_status()
            events = response.json()
            events.sort(key=lambda x: int(x['startdate']))
            eel.receive_events_data({"success": True, "data": events})
        except Exception as e:
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
def get_merchant_schedules():
    try:
        now = datetime.now(UTC)
        
        def generate_mock_schedule(offset_days, interval_days, duration_days):
            schedule = []
            start = now + timedelta(days=offset_days)
            for i in range(8):
                s = start + timedelta(days=i * interval_days)
                e = s + timedelta(days=duration_days)
                schedule.append({
                    "start": int(s.timestamp()),
                    "end": int(e.timestamp())
                })
            return schedule

        return {
            "success": True,
            "luxion": generate_mock_schedule(2, 14, 3),
            "corruxion": generate_mock_schedule(9, 14, 3),
            "fluxion": generate_mock_schedule(4, 14, 7)
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
    
    current_rot = {}
    future_rots = []

    for i in range(8):
        current_offset = consumed + i
        s = start + timedelta(seconds=i * system_interval)
        e = s + timedelta(seconds=system_interval)
        
        _, b1_idx = divmod(current_offset, len(biome1))
        _, b2_idx = divmod(current_offset, len(biome2))
        _, b3_idx = divmod(current_offset, len(biome3))
        
        first = biome1[b1_idx]
        second = biome2[b2_idx]
        third = biome3[b3_idx]
        
        rot_data = {
            "start": int(s.timestamp()),
            "end": int(e.timestamp()),
            "biomes": [
                subbiomes.get(first, {"name": first, "final_name": first, "icon": "unknown"}),
                subbiomes.get(second, {"name": second, "final_name": second, "icon": "unknown"}),
                subbiomes.get(third, {"name": third, "final_name": third, "icon": "unknown"})
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