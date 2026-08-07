"""Ally Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_ally import build_allies_dataset

codex = Codex("allies", "Allies", build_allies_dataset, extract_subdir="allies_runtime_cache")
