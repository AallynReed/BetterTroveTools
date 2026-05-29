"""
Scaffold a new locale file from en_US.

Creates web/assets/locale/<code>.json with:
  - meta (code/name/englishName/direction/fallback/maintainers/updated)
  - strings : every UI id from en_US, value "" (untranslated)
  - content : {} (filled later by sync_locale_keys.py from the game tables)

Usage:
  .venv\\Scripts\\python.exe tools\\i18n\\new_language.py <code> <endonym> <englishName> [--rtl]

Example:
  .venv\\Scripts\\python.exe tools\\i18n\\new_language.py it_IT Italiano Italian
  .venv\\Scripts\\python.exe tools\\i18n\\new_language.py ar_SA "العربية" Arabic --rtl
"""
from __future__ import annotations

import datetime
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCALE_DIR = ROOT / "web" / "assets" / "locale"
CODE_RE = re.compile(r"^[a-z]{2,3}_[A-Za-z]{2,4}$")


def main(argv) -> int:
    args = [a for a in argv if a != "--rtl"]
    rtl = "--rtl" in argv
    if len(args) != 3:
        print(__doc__)
        return 2
    code, endonym, english_name = args
    if not CODE_RE.match(code):
        print(f"ERROR: code {code!r} must look like 'xx_XX' (e.g. it_IT).")
        return 2

    dest = LOCALE_DIR / f"{code}.json"
    if dest.exists():
        print(f"ERROR: {dest} already exists.")
        return 2

    en = json.loads((LOCALE_DIR / "en_US.json").read_text(encoding="utf-8"))
    strings = {cid: "" for cid in en.get("strings", {})}

    data = {
        "$schema": "./locale.schema.json",
        "meta": {
            "code": code,
            "name": endonym,
            "englishName": english_name,
            "direction": "rtl" if rtl else "ltr",
            "fallback": "en_US",
            "maintainers": [],
            "updated": datetime.date.today().isoformat(),
        },
        "strings": strings,
        "content": {},
    }
    dest.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")
    print(f"Created {dest} with {len(strings)} UI strings to translate.")
    print("Next:")
    print(f"  1. Translate the values in `strings` (leave anything inside <code> tags and {{tokens}} intact).")
    print(f"  2. (maintainer) run sync_locale_keys.py to fill `content` from the game tables.")
    print(f"  3. run tools/i18n/validate.py to check your file.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
