"""Style Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_style import build_styles_dataset

codex = Codex("styles", "Styles", build_styles_dataset)
