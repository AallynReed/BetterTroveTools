import eel
import requests
import json
import os
from backend.response import resp, standardize_response


@eel.expose
@standardize_response
def sync_allies_data():
    req_id = None
    try:
        req_id = eel.add_external_request("Fetching Allies Data", "https://trovesaurus.aallyn.net/allies")()
    except Exception:
        pass
        
    try:
        response = requests.get("https://trovesaurus.aallyn.net/allies", timeout=3)
        response.raise_for_status()
        
        if req_id:
            eel.remove_external_request(req_id, True)()
            
        file_path = os.path.join(os.getcwd(), "web", "assets", "data", "allies.json")
        
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(response.json(), f, indent=4)
        print("✅ Allies data synced successfully!")
        return resp(True)
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Ally sync skipped/failed: {e}")
        return resp(False, error=str(e), code="SYNC_ALLIES_FAILED")