"""Fish Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_fish import build_fish_dataset

codex = Codex("fish", "Fish", build_fish_dataset, schema_version=1)
