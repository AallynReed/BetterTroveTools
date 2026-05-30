"""Compatibility shim for legacy calculators backend module.

Ally-related endpoints were moved to backend.codexes.allies.
"""

from backend.codexes.allies import get_allies_data, sync_allies_data
