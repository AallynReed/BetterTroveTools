"""Item Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_item import build_items_dataset

codex = Codex("items", "Items", build_items_dataset, schema_version=2)
