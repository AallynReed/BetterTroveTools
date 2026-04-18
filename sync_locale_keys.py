import json
from pathlib import Path


STRINGS_DIR = Path("strings")
LOCALE_DIR = Path("web/assets/locale")
BASE_LOCALE = "en_US.json"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"), strict=False)


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")


def sort_locale_keys(locale_keys: dict[str, str]) -> dict[str, str]:
    return dict(sorted(locale_keys.items(), key=lambda item: (item[1] != "", item[0])))


def build_english_to_game_key() -> dict[str, str]:
    english_to_game_key: dict[str, str] = {}
    original_strings = load_json(STRINGS_DIR / "strings.json")

    for section in original_strings:
        if section.get("type") != "table":
            continue

        for entry in section.get("data", []):
            english_value = entry.get("value")
            game_key = entry.get("key")
            if english_value and game_key:
                english_to_game_key[english_value] = game_key

    return english_to_game_key


def sync_locale_keys() -> int:
    base_path = LOCALE_DIR / BASE_LOCALE
    base_locale = load_json(base_path)
    base_keys = list(base_locale.get("keys", {}).keys())
    english_to_game_key = build_english_to_game_key()

    updated_files = 0

    for locale_path in sorted(LOCALE_DIR.glob("*.json")):
        if locale_path.name == BASE_LOCALE:
            continue

        locale_code = locale_path.stem
        locale_data = load_json(locale_path)
        locale_keys = locale_data.setdefault("keys", {})
        locale_strings_path = STRINGS_DIR / f"strings_{locale_code}.json"
        locale_strings = load_json(locale_strings_path) if locale_strings_path.exists() else {}

        added_missing_keys = 0
        filled_from_strings = 0
        left_empty = 0

        for english_text in base_keys:
            had_key = english_text in locale_keys
            current_value = locale_keys.get(english_text, "")

            if not had_key:
                locale_keys[english_text] = ""
                current_value = ""
                added_missing_keys += 1

            if current_value not in ("", None):
                continue

            game_key = english_to_game_key.get(english_text)
            translated_entry = locale_strings.get(game_key, {}) if game_key else {}
            translated_value = translated_entry.get("value", "")

            if translated_value:
                locale_keys[english_text] = translated_value
                filled_from_strings += 1
            elif not had_key:
                left_empty += 1

        sorted_keys = sort_locale_keys(locale_keys)
        changed_order = list(sorted_keys.items()) != list(locale_keys.items())
        locale_data["keys"] = sorted_keys

        if added_missing_keys or filled_from_strings or changed_order:
            save_json(locale_path, locale_data)
            updated_files += 1

        print(
            f"{locale_path.name}: added {added_missing_keys} keys, "
            f"filled {filled_from_strings} missing translations, "
            f"left {left_empty} empty"
        )

    print(f"Updated {updated_files} locale file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(sync_locale_keys())
