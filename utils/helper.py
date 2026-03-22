import json
import os
from pathlib import Path


def get_storage_file():
    appdata = Path(os.getenv("APPDATA"))
    storage_dir = appdata.joinpath("Trove", "ModManagerCache")
    storage_dir.mkdir(parents=True, exist_ok=True)
    return storage_dir.joinpath("storage.json")

def read_storage():
    file_path = get_storage_file()
    if not file_path.exists():
        return {}
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def write_storage(data):
    file_path = get_storage_file()
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)