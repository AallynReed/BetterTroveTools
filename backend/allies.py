import json
import os

import eel
import requests

from backend.response import resp, standardize_response


ALLIES_REMOTE_URL = "https://trovesaurus.aallyn.net/allies"


def _allies_file_path():
    return os.path.join(os.getcwd(), "web", "assets", "data", "allies.json")


def _read_allies_file():
    file_path = _allies_file_path()
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_allies_file(data):
    file_path = _allies_file_path()
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


@eel.expose
@standardize_response
def get_allies_data():
    req_id = None
    try:
        req_id = eel.add_external_request("Fetching Allies Data", ALLIES_REMOTE_URL)()
    except Exception:
        pass

    try:
        response = requests.get(ALLIES_REMOTE_URL, timeout=5)
        response.raise_for_status()
        data = response.json()
        _write_allies_file(data)
        if req_id:
            eel.remove_external_request(req_id, True)()
        return resp(True, data=data, source="remote")
    except Exception as remote_error:
        if req_id:
            eel.remove_external_request(req_id, False)()
        try:
            cached = _read_allies_file()
            return resp(True, data=cached, source="local", warning=str(remote_error))
        except Exception as file_error:
            return resp(
                False,
                error=f"Remote fetch failed ({remote_error}) and local fallback failed ({file_error})",
                code="GET_ALLIES_DATA_FAILED",
            )


@eel.expose
@standardize_response
def sync_allies_data():
    req_id = None
    try:
        req_id = eel.add_external_request("Fetching Allies Data", ALLIES_REMOTE_URL)()
    except Exception:
        pass

    try:
        response = requests.get(ALLIES_REMOTE_URL, timeout=3)
        response.raise_for_status()
        data = response.json()

        if req_id:
            eel.remove_external_request(req_id, True)()

        _write_allies_file(data)
        print("Allies data synced successfully.")
        return resp(True)
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Ally sync skipped/failed: {e}")
        return resp(False, error=str(e), code="SYNC_ALLIES_FAILED")
