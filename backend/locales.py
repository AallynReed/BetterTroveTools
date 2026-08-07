"""The shipped locale catalogue, read the same way by both servers.

`main.py` exposes `get_available_languages` over eel. This was split out when
the retired hosted-web server carried a second copy of it; the directory stays
a parameter so the reader holds no opinion about where the catalogue lives.
"""
from __future__ import annotations

import json
from pathlib import Path

# Served when the locale directory is missing entirely: English always exists as
# the built-in fallback, so the picker should never come back empty.
_EN_ONLY = [{"code": "en_US", "name": "English", "percent": 100}]


def is_locale_file(file_path: Path) -> bool:
    """True for `<lang>_<REGION>.json` only. Skips the engine's aux files
    (`_ui_ids.json`, `locale.schema.json`) that share the directory."""
    parts = file_path.stem.split("_")
    return (
        len(parts) == 2
        and 2 <= len(parts[0]) <= 3 and parts[0].islower()
        and 2 <= len(parts[1]) <= 4 and parts[1].isalpha()
    )


def completion(data: dict) -> int:
    """Percent of user-facing strings that carry a translation -- UI chrome plus
    content. (The contributor-facing validator reports UI-only separately.)"""
    strings = data.get("strings")
    if strings is None:
        values = list(data.get("keys", {}).values())  # legacy { language_name, keys }
    else:
        values = list(strings.values()) + list(data.get("content", {}).values())
    total = len(values)
    if total == 0:
        return 0
    empty = sum(1 for value in values if value == "" or value is None)
    return int(((total - empty) / total) * 100)


def available_languages(locale_dir: Path) -> list[dict]:
    """Every shipped locale as `{code, name, percent}`, English first then by
    name. A locale file that won't parse is skipped with a warning rather than
    taking the whole picker down."""
    if not locale_dir.exists():
        return list(_EN_ONLY)

    languages = []
    for file_path in locale_dir.glob("*.json"):
        if not is_locale_file(file_path):
            continue
        try:
            data = json.loads(file_path.read_text(encoding="utf-8"))
            meta = data.get("meta") or {}
            name = meta.get("name") or data.get("language_name") or file_path.stem
            percent = 100 if file_path.stem == "en_US" else completion(data)
            languages.append({"code": file_path.stem, "name": name, "percent": percent})
        except Exception as e:
            # Plain ASCII on purpose: this used to carry a warning emoji, which
            # raised UnicodeEncodeError on a cp1252 console -- so the handler for
            # a bad locale file crashed the whole language list instead of
            # skipping that one file.
            print(f"[locales] skipping unreadable locale file {file_path}: {e}")

    languages.sort(key=lambda item: (item["code"] != "en_US", item["name"]))
    return languages
