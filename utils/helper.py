import json
from pathlib import Path

from utils.path import get_cache_root


def get_storage_file():
    storage_dir = get_cache_root()
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