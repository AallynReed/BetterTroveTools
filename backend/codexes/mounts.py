"""Mount Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_mount import build_mounts_dataset

# schema_version 1: see allies - the stat parser changed, so old caches are stale.
codex = Codex("mounts", "Mounts", build_mounts_dataset, schema_version=1)
