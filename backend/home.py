import datetime
import time
import traceback

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

@eel.expose
def get_twitch_streams():
    """Fetches live Trove Twitch streams securely from the backend to avoid CORS."""
    try:
        headers = {"User-Agent": "BetterTroveTools/1.0"}
        response = requests.get("https://trovesaurus.aallyn.xyz/twitch_streams", headers=headers, timeout=10)
        response.raise_for_status()
        return {"success": True, "data": response.json()}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def get_current_server_data():
    """Fetches the current daily/weekly buffs and merchant timings."""
    try:
        st = ServerTime()
        
        # Calculate Merchants
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
def get_trovesaurus_events():
    """Fetches the Trovesaurus calendar feed."""
    try:
        headers = {"User-Agent": "BetterTroveTools/1.0"}
        response = requests.get("https://trovesaurus.com/calendar/feed", headers=headers, timeout=10)
        response.raise_for_status()
        events = response.json()
        
        # Sort events by start date (closest first)
        events.sort(key=lambda x: int(x['startdate']))

        return {"success": True, "data": events}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}