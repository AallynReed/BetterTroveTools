"""Compatibility shim for legacy calculators backend module.

Ally-related endpoints were moved to backend.allies.
"""

from backend.allies import get_allies_data, sync_allies_data
