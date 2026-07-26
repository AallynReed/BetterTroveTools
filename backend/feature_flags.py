"""Backend feature flags.

These mirror the `window.BTT_*` flags declared near the top of `web/js/main.js`.
The frontend flag gates the UI; the one here gates the eel surface sitting
behind it. Both sides have to agree, so flip them together.
"""

# Mods Hub — the first-party mod/modpack hub on trove.aallyn.net. Off: mods come
# from Trovesaurus only. While this is False `main.py` skips importing
# `backend.mod_manager.mods_hub`, `.modpacks` and `.profiles`, so none of their
# `@eel.expose`d endpoints are registered and nothing calls out to the hub.
# Mirrors `window.BTT_ENABLE_MODS_HUB`.
MODS_HUB_ENABLED = False
