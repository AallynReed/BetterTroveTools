import eel
import requests
import json
import os


@eel.expose
def sync_allies_data():
    try:
        response = requests.get("https://trovesaurus.aallyn.xyz/allies", timeout=3)
        response.raise_for_status()
        
        file_path = os.path.join(os.getcwd(), "web", "assets", "data", "allies.json")
        
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(response.json(), f, indent=4)
        print("✅ Allies data synced successfully!")
        return {"success": True}
    except Exception as e:
        print(f"Ally sync skipped/failed: {e}")
        return {"success": False, "error": str(e)}