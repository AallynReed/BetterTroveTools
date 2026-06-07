#!/usr/bin/env python3
"""Apply a batch of translations to a locale file's strings section.

Usage:
  apply_batch.py <locale_code> <batch.json>

batch.json is a flat object: { "key": "translated value", ... }

Skips any key whose existing value is non-empty (so existing translations are
never clobbered). Skips any key whose value is missing or empty in the source
en_US.json (defensive — don't invent entries that aren't real).

Leaves the `content` section completely untouched. JSON output preserves the
existing file's indentation style (4-space) and ensures UTF-8 output.
"""
import json, sys, pathlib

LOCALE_DIR = pathlib.Path(__file__).resolve().parents[2] / 'web' / 'assets' / 'locale'

def main():
    if len(sys.argv) != 3:
        print("usage: apply_batch.py <locale_code> <batch.json>", file=sys.stderr)
        sys.exit(2)
    code, batch_path = sys.argv[1], sys.argv[2]

    src = json.loads((LOCALE_DIR / 'en_US.json').read_text(encoding='utf-8'))['strings']
    target_path = LOCALE_DIR / f'{code}.json'
    target = json.loads(target_path.read_text(encoding='utf-8'))
    target.setdefault('strings', {})

    batch = json.loads(pathlib.Path(batch_path).read_text(encoding='utf-8'))

    applied = skipped_filled = skipped_unknown = 0
    for k, v in batch.items():
        if k not in src:
            skipped_unknown += 1
            continue
        cur = target['strings'].get(k, '')
        if cur:
            skipped_filled += 1
            continue
        target['strings'][k] = v
        applied += 1

    target_path.write_text(
        json.dumps(target, ensure_ascii=False, indent=4) + '\n',
        encoding='utf-8',
    )
    print(f"{code}: applied={applied} skipped_already_filled={skipped_filled} skipped_unknown_key={skipped_unknown}")

if __name__ == '__main__':
    main()
