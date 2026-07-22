"""Glyph-free Trove launcher/updater, vendored from the TroveImposter project.

Three concerns, each in its own module:

  * ``cdn``       - Trion update-CDN client + the plaintext pointer/manifest parsers.
  * ``updater``   - keep an install current from the CDN (delta download, sqlite state).
  * ``trionauth`` - turn Glyph credentials into a launch-ready, DPAPI-cached ticket.
  * ``inject``    - hand that ticket to Trove_x64.exe exactly the way Glyph does.
  * ``launch``    - per-region auth-server strings + bring the game window forward.

These are copied (not imported) from TroveImposter so Better Trove Tools ships
self-contained; the only third-party dependency is ``requests`` (already a BTT
dep). Everything else is stdlib + ctypes. Windows only (the launch path uses the
Win32 process/handle APIs); the updater alone works cross-platform.
"""
