"""Recipe Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_recipe import build_recipes_dataset

codex = Codex("recipes", "Recipes", build_recipes_dataset)
