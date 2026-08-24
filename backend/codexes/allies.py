"""Ally Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_ally import build_allies_dataset

# schema_version 1: the operation byte now decides what a stat record means, so a
# cache built by the old parser holds wrong values and has to be rebuilt.
codex = Codex("allies", "Allies", build_allies_dataset, schema_version=1,
              extract_subdir="allies_runtime_cache")
