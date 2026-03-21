import eel
import requests
import json
import os


@eel.expose
def sync_allies_data():
    """
    Attempts to fetch the latest allies data.
    If it responds within 3 seconds, it overwrites the local allies.json.
    If it fails or times out, it silently passes and the app uses the existing local file.
    """
    try:
        response = requests.get("https://trovesaurus.aallyn.xyz/allies", timeout=3)
        response.raise_for_status()
        
        # Define the path to the local allies.json
        file_path = os.path.join(os.getcwd(), "web", "assets", "data", "allies.json")
        
        # Overwrite the local file with the fresh data
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(response.json(), f, indent=4)
        print("✅ Allies data synced successfully!")
        return {"success": True}
    except Exception as e:
        # Silently fail on timeout or error
        print(f"Ally sync skipped/failed: {e}")
        return {"success": False, "error": str(e)}