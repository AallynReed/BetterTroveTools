# Translating Better Trove Tools

Thank you for helping translate Better Trove Tools! The interface can be localized
into any language, and contributions are welcome via pull request.

## Where the files live

All locale files are in [`web/assets/locale/`](web/assets/locale/), one JSON file
per language named `<code>.json` (e.g. `de_DE.json`, `ja_JP.json`). `en_US.json`
is the source of truth.

## File format

```jsonc
{
    "$schema": "./locale.schema.json",
    "meta": {
        "code": "de_DE",            // BCP-style code, must match the filename
        "name": "Deutsch",          // the language's name in its own language (endonym)
        "englishName": "German",
        "direction": "ltr",         // "ltr" or "rtl"
        "fallback": "en_US",        // used for any string you leave untranslated
        "maintainers": ["@you"],
        "updated": "2026-05-29"
    },
    "strings": {                    // <-- TRANSLATE THIS
        "nav.home": "Startseite",
        "common.save": "Speichern",
        "home.welcome_back": "Willkommen zurück, {name}!"
    },
    "content": {                    // <-- DO NOT hand-edit (auto-generated)
        "Radiant Dawn": "Strahlender Morgen"
    }
}
```

There are two catalogs:

- **`strings`** — the hand-curated **UI text** (menus, buttons, labels, dialogs),
  keyed by a stable **symbolic id** like `nav.home` or `settings.appearance`. **This
  is what you translate.** The id never changes even if the English wording does,
  so your translations don't silently break.
- **`content`** — game/data text (item names, descriptions, stat labels) that is
  generated automatically from Trove's game string tables by a maintainer script.
  **Don't edit `content` by hand** — changes there will be overwritten.

The English text for each id is in `en_US.json` — open it side by side to see what
each id means.

## Rules

1. **Only translate the *values* in `strings`.** Never change the ids (the keys).
2. **Keep `{tokens}` exactly as-is.** `"{count}"`, `"{name}"`, `"{version}"` etc. are
   replaced with live values at runtime. `"{count} days"` → `"{count} Tage"`. You may
   reorder them, but every token in the English **must** appear in your translation.
3. **Keep HTML tags and entities intact.** If the English has `<b>…</b>` or
   `<code>…</code>`, keep the same tags. Don't translate text inside `<code>` tags,
   brand names ("Trove", "Better Trove Tools", "Glyph", "Trovesaurus"), or file
   extensions (`.tmod`, `.tfi`).
4. **Leave a value as `""`** to keep the English (the `fallback`). Partial
   translations are fine and ship safely.
5. **Plurals** (optional): a value may be an object instead of a string:
   ```json
   "home.days_ago": { "one": "vor {count} Tag", "other": "vor {count} Tagen" }
   ```
   Use the plural categories your language needs (`one`, `few`, `many`, `other`, …);
   the app picks the right one with `Intl.PluralRules`.

## Adding a new language

From the repo root:

```bash
.venv\Scripts\python.exe tools\i18n\new_language.py <code> "<Endonym>" "<English name>" [--rtl]
# e.g.
.venv\Scripts\python.exe tools\i18n\new_language.py it_IT "Italiano" "Italian"
```

This creates `web/assets/locale/it_IT.json` with every UI id ready to translate.

## Before you submit

Run the validator — it must pass:

```bash
.venv\Scripts\python.exe tools\i18n\validate.py
```

It checks JSON validity, that your ids match `en_US`, that `{tokens}` and HTML tags
line up with the English, and reports your completion percentage. Then open a pull
request. Thank you! 🎉
