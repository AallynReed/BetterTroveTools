"""
Maintenance tool: fill the `content` catalog of each locale from the Trove game
string tables (strings/strings_<locale>.json).

In the reworked i18n system every locale file is:
    { "meta": {...}, "strings": { id: translation }, "content": { source: translation } }

  - `strings` : hand-curated UI chrome (symbolic ids). This tool NEVER touches it.
  - `content` : game/data-driven labels, source-keyed. en_US.content is the
                canonical list of content sources (values empty = English). For
                every other locale we ensure those sources exist and fill any
                still-empty ones from the matching game string table.

Requires the (gitignored) strings/ directory and locale files already migrated to
the new shape (run tools/i18n/migrate_locales.py first).

Run from repo root:  .venv\\Scripts\\python.exe sync_locale_keys.py
"""
import json
from pathlib import Path

STRINGS_DIR = Path("strings")
LOCALE_DIR = Path("web/assets/locale")
BASE_LOCALE = "en_US.json"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"), strict=False)


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")


def is_locale_file(path: Path) -> bool:
    parts = path.stem.split("_")
    return (
        len(parts) == 2
        and 2 <= len(parts[0]) <= 3 and parts[0].islower()
        and 2 <= len(parts[1]) <= 4 and parts[1].isalpha()
    )


def is_new_shape(data: dict) -> bool:
    return any(k in data for k in ("strings", "content", "meta"))


def sort_content(content: dict) -> dict:
    # empty (untranslated) first, then alphabetical by source - mirrors the
    # migration ordering and surfaces what still needs translating.
    return dict(sorted(content.items(), key=lambda kv: (kv[1] != "", kv[0])))


def build_english_to_game_key() -> dict:
    english_to_game_key: dict = {}
    strings_path = STRINGS_DIR / "strings.json"
    if not strings_path.exists():
        return english_to_game_key
    for section in load_json(strings_path):
        if not isinstance(section, dict) or section.get("type") != "table":
            continue
        for entry in section.get("data", []):
            english_value = entry.get("value")
            game_key = entry.get("key")
            if english_value and game_key:
                english_to_game_key[english_value] = game_key
    return english_to_game_key


def sync_locale_keys() -> int:
    base_path = LOCALE_DIR / BASE_LOCALE
    base = load_json(base_path)
    if not is_new_shape(base):
        print("en_US.json is still the legacy shape - run tools/i18n/migrate_locales.py first.")
        return 1

    base_sources = list(base.get("content", {}).keys())
    if not STRINGS_DIR.exists():
        print(f"WARNING: {STRINGS_DIR} not found - can only add missing keys, not fill translations.")
    english_to_game_key = build_english_to_game_key()

    updated_files = 0
    for locale_path in sorted(LOCALE_DIR.glob("*.json")):
        if locale_path.name == BASE_LOCALE or not is_locale_file(locale_path):
            continue
        data = load_json(locale_path)
        if not is_new_shape(data):
            print(f"{locale_path.name}: legacy shape - skipped (migrate first).")
            continue

        content = data.setdefault("content", {})
        locale_strings_path = STRINGS_DIR / f"strings_{locale_path.stem}.json"
        locale_strings = load_json(locale_strings_path) if locale_strings_path.exists() else {}

        added = filled = 0
        for source in base_sources:
            if source not in content:
                content[source] = ""
                added += 1
            if content[source]:
                continue
            game_key = english_to_game_key.get(source)
            translated = (locale_strings.get(game_key, {}) or {}).get("value", "") if game_key else ""
            if translated:
                content[source] = translated
                filled += 1

        sorted_content = sort_content(content)
        changed = added or filled or list(sorted_content.items()) != list(content.items())
        data["content"] = sorted_content
        if changed:
            save_json(locale_path, data)
            updated_files += 1

        print(f"{locale_path.name}: added {added} content keys, filled {filled} from game strings")

    print(f"Updated {updated_files} locale file(s). `strings` (UI) left untouched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(sync_locale_keys())
