"""
Regenerate web/assets/locale/_ui_ids.json from en_US.json.

Run this after adding/renaming ids in en_US `strings`. It derives the engine's
id<->English maps directly from the source-of-truth catalog (en_US.json), so it
is self-contained.

  byNorm : normalized-English -> id   (legacy English -> id resolution)
  en     : id -> English source       (English fallback)

Run:  .venv\\Scripts\\python.exe tools\\i18n\\build_ui_ids.py
"""
from __future__ import annotations

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCALE_DIR = ROOT / "web" / "assets" / "locale"


def norm(s: str) -> str:
    return html.unescape(s).strip()


def flatten(v):
    if isinstance(v, dict):
        return v.get("other") or v.get("one") or next(iter(v.values()), "")
    return v


def main() -> int:
    en = json.loads((LOCALE_DIR / "en_US.json").read_text(encoding="utf-8"))
    strings = en.get("strings", {})

    by_norm, en_map = {}, {}
    for cid, value in strings.items():
        english = flatten(value)
        en_map[cid] = english
        if english:
            by_norm.setdefault(norm(english), cid)

    out = {"byNorm": by_norm, "en": en_map}
    (LOCALE_DIR / "_ui_ids.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote _ui_ids.json: {len(en_map)} ids, {len(by_norm)} english->id entries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
