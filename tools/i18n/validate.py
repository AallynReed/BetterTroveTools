"""
Validate every locale file. Dependency-free (no jsonschema needed).

Checks per locale:
  - JSON parses; shape matches { meta, strings, content } with required meta fields.
  - meta.code matches the filename and the locale-code pattern; direction in ltr/rtl.
  - id integrity vs en_US: stale/unknown ids in `strings` are ERRORS; missing ids
    are reported as incompleteness.
  - interpolation-token parity: a non-empty translation must use exactly the same
    {tokens} as its English source (catches a dropped/renamed {count}).
  - HTML-tag parity: a translation must not introduce or drop HTML tags vs source.
  - junk flagger: ids/content keys that look like variable-baked paths / raw enums
    (the old auto-capture failure mode) are flagged.
  - completion: UI-only and content coverage per locale.

Exit code is non-zero if any ERROR is found (safe to wire into CI/pre-commit).

Run:  .venv\\Scripts\\python.exe tools\\i18n\\validate.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCALE_DIR = ROOT / "web" / "assets" / "locale"

CODE_RE = re.compile(r"^[a-z]{2,3}_[A-Za-z]{2,4}$")
TOKEN_RE = re.compile(r"\{(\w+)\}")
TAG_RE = re.compile(r"</?([a-zA-Z][a-zA-Z0-9]*)")
JUNK_PATH_RE = re.compile(r"[A-Za-z]:[\\/]|/Desktop/|/Users/|Last used:\s*\S")


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def tokens(s):
    return set(TOKEN_RE.findall(s)) if isinstance(s, str) else set()


def tags(s):
    return sorted(TAG_RE.findall(s)) if isinstance(s, str) else []


def flatten_plural(v):
    if isinstance(v, dict):
        return " ".join(str(x) for x in v.values())
    return v if isinstance(v, str) else ""


def is_locale_file(path: Path) -> bool:
    parts = path.stem.split("_")
    return (
        len(parts) == 2
        and 2 <= len(parts[0]) <= 3 and parts[0].islower()
        and 2 <= len(parts[1]) <= 4 and parts[1].isalpha()
    )


def looks_junky(key: str) -> bool:
    s = key.strip()
    if "." in s:  # ids are dotted and legitimate
        return False
    if JUNK_PATH_RE.search(s):
        return True
    if " " not in s and re.fullmatch(r"[A-Z][A-Z0-9_]{1,5}", s):
        return True
    return False


def main() -> int:
    en = load(LOCALE_DIR / "en_US.json")
    en_strings = en.get("strings", {})
    en_ids = set(en_strings)

    errors = 0
    warnings = 0

    for path in sorted(LOCALE_DIR.glob("*.json")):
        if not is_locale_file(path):
            continue
        loc = path.stem
        local_err = []
        local_warn = []
        try:
            data = load(path)
        except Exception as exc:
            print(f"{loc}: ERROR invalid JSON - {exc}")
            errors += 1
            continue

        meta = data.get("meta")
        strings = data.get("strings")
        content = data.get("content", {})

        # structure
        if not isinstance(meta, dict):
            local_err.append("missing/invalid `meta`")
            meta = {}
        if not isinstance(strings, dict):
            local_err.append("missing/invalid `strings`")
            strings = {}
        if not isinstance(content, dict):
            local_err.append("`content` is not an object")
            content = {}
        for field in ("code", "name", "direction", "fallback"):
            if not meta.get(field):
                local_err.append(f"meta.{field} missing")
        if meta.get("code") and not CODE_RE.match(meta["code"]):
            local_err.append(f"meta.code {meta['code']!r} invalid")
        if meta.get("code") and meta["code"] != loc:
            local_err.append(f"meta.code {meta['code']!r} != filename {loc}")
        if meta.get("direction") not in (None, "ltr", "rtl"):
            local_err.append(f"meta.direction {meta.get('direction')!r} invalid")

        # id integrity
        stale = [k for k in strings if k not in en_ids]
        if stale:
            local_err.append(f"{len(stale)} stale id(s) not in en_US (e.g. {stale[:3]})")
        missing = [k for k in en_ids if k not in strings]

        # token + tag parity (UI strings)
        token_mismatch = 0
        tag_mismatch = 0
        for cid, src in en_strings.items():
            tr = strings.get(cid, "")
            tr_flat = flatten_plural(tr)
            if not tr_flat:
                continue
            if tokens(tr_flat) != tokens(src):
                token_mismatch += 1
                if token_mismatch <= 3:
                    local_err.append(f"token mismatch [{cid}]: src{sorted(tokens(src))} tr{sorted(tokens(tr_flat))}")
            if tags(tr_flat) != tags(src):
                tag_mismatch += 1
                if tag_mismatch <= 3:
                    local_warn.append(f"tag mismatch [{cid}]: src{tags(src)} tr{tags(tr_flat)}")

        # token parity for content (source IS the key)
        for src, tr in content.items():
            if tr and tokens(tr) != tokens(src):
                token_mismatch += 1
                if token_mismatch <= 5:
                    local_err.append(f"content token mismatch [{src[:30]}]")

        # junk flagger (en_US only - it owns the canonical lists)
        if loc == "en_US":
            junk = [k for k in list(strings) if looks_junky(k)]
            junk += [k for k in list(content) if looks_junky(k)]
            if junk:
                local_warn.append(f"{len(junk)} junk-looking key(s): {junk[:5]}")

        # completion
        ui_total = len(en_ids) or 1
        ui_done = sum(1 for cid in en_ids if flatten_plural(strings.get(cid, "")))
        ctot = len(content) or 1
        cdone = sum(1 for v in content.values() if v)
        ui_pct = int(ui_done / ui_total * 100)
        c_pct = int(cdone / ctot * 100)

        errors += len(local_err)
        warnings += len(local_warn)
        status = "OK" if not local_err else "ERROR"
        print(f"{loc:8} {status:5} ui {ui_pct:3}% ({ui_done}/{len(en_ids)})  content {c_pct:3}%  "
              f"missing_ui {len(missing)}")
        for e in local_err:
            print(f"    ERROR  {e}")
        for w in local_warn:
            print(f"    warn   {w}")

    print()
    print(f"{'PASS' if errors == 0 else 'FAIL'} - {errors} error(s), {warnings} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
