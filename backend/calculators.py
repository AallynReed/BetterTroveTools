"""Compatibility shim for legacy calculators backend module.

Ally-related endpoints were moved to backend.codexes.allies.
"""

import backend.codexes.allies  # noqa: F401  (registers the eel endpoints)
