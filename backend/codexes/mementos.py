"""Memento Codex. Everything but the dataset builder lives in codex_cache.Codex."""
from backend.codexes.codex_cache import Codex
from models.trove.prefab_memento import build_mementos_dataset

codex = Codex("mementos", "Mementos", build_mementos_dataset)
