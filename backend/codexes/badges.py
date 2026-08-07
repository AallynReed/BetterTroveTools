"""Badge Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_badge import build_badges_dataset

codex = Codex("badges", "Badges", build_badges_dataset, schema_version=1)
