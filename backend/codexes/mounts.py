"""Mount Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_mount import build_mounts_dataset

codex = Codex("mounts", "Mounts", build_mounts_dataset)
