//! backend/codexes (+ backend/calculators.py): the game-file codexes, and the prefab
//! decoders they are built on (models/trove/prefab_*.py, utils/prefab_binfab.py,
//! utils/binfab_reader.py, utils/binfab_decoder.py).

pub mod binfab;
pub mod binfab_decoder;
pub mod binfab_reader;
pub mod cache;
pub mod prefab_ally;
pub mod prefab_badge;
pub mod prefab_fish;
pub mod prefab_item;
pub mod prefab_memento;
pub mod prefab_mount;
pub mod prefab_recipe;
pub mod prefab_style;
pub mod py;

#[cfg(test)]
mod parity_tests;

use std::path::Path;

use anyhow::Result;

use crate::Cmd;
use cache::{BuildArgs, Codex, Dataset};

fn allies(a: &BuildArgs) -> Result<Dataset> {
    let extract_dir = a.extract_dir.clone().unwrap_or_else(|| "build/prefabs_pet".into());
    prefab_ally::build_allies_dataset(a.game_path, &extract_dir, a.locale)
}

fn badges(a: &BuildArgs) -> Result<Dataset> {
    prefab_badge::build_badges_dataset(a.game_path, a.locale)
}

fn fish(a: &BuildArgs) -> Result<Dataset> {
    prefab_fish::build_fish_dataset(a.game_path, a.locale)
}

fn items(a: &BuildArgs) -> Result<Dataset> {
    prefab_item::build_items_dataset(a.game_path, a.locale)
}

fn mementos(a: &BuildArgs) -> Result<Dataset> {
    prefab_memento::build_mementos_dataset(a.game_path, a.locale)
}

fn mounts(a: &BuildArgs) -> Result<Dataset> {
    prefab_mount::build_mounts_dataset(a.game_path, a.locale)
}

fn recipes(a: &BuildArgs) -> Result<Dataset> {
    prefab_recipe::build_recipes_dataset(a.game_path, a.locale)
}

fn styles(a: &BuildArgs) -> Result<Dataset> {
    prefab_style::build_styles_dataset(a.game_path, a.locale)
}

// schema_version 1 (allies, mounts): the operation byte decides a stat record's meaning.
pub static ALLIES: Codex = Codex::new("allies", "Allies", allies, Some(1), Some("allies_runtime_cache"));
pub static BADGES: Codex = Codex::new("badges", "Badges", badges, Some(1), None);
pub static FISH: Codex = Codex::new("fish", "Fish", fish, Some(1), None);
pub static ITEMS: Codex = Codex::new("items", "Items", items, Some(2), None);
pub static MEMENTOS: Codex = Codex::new("mementos", "Mementos", mementos, None, None);
pub static MOUNTS: Codex = Codex::new("mounts", "Mounts", mounts, Some(1), None);
pub static RECIPES: Codex = Codex::new("recipes", "Recipes", recipes, None, None);
pub static STYLES: Codex = Codex::new("styles", "Styles", styles, None, None);

pub fn codexes() -> [&'static Codex; 8] {
    [&ALLIES, &BADGES, &FISH, &ITEMS, &MEMENTOS, &MOUNTS, &RECIPES, &STYLES]
}

pub fn codex(key: &str) -> Option<&'static Codex> {
    codexes().into_iter().find(|c| c.key == key)
}

/// Builds one codex's dataset straight from an install, bypassing the cache.
pub fn build_dataset(key: &str, game_path: &Path, extract_dir: Option<&Path>) -> Result<Dataset> {
    let c = codex(key).ok_or_else(|| anyhow::anyhow!("unknown codex {}", key))?;
    (c.dataset)(&BuildArgs { game_path, locale: "en", extract_dir: extract_dir.map(Path::to_path_buf) })
}

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("get_allies_data", |a| ALLIES.get_data(a)),
        Cmd::std("clear_allies_cache", |_| ALLIES.clear_cache()),
        Cmd::std("get_badges_data", |a| BADGES.get_data(a)),
        Cmd::std("clear_badges_cache", |_| BADGES.clear_cache()),
        Cmd::std("get_fish_data", |a| FISH.get_data(a)),
        Cmd::std("clear_fish_cache", |_| FISH.clear_cache()),
        Cmd::std("get_items_data", |a| ITEMS.get_data(a)),
        Cmd::std("clear_items_cache", |_| ITEMS.clear_cache()),
        Cmd::std("get_mementos_data", |a| MEMENTOS.get_data(a)),
        Cmd::std("clear_mementos_cache", |_| MEMENTOS.clear_cache()),
        Cmd::std("get_mounts_data", |a| MOUNTS.get_data(a)),
        Cmd::std("clear_mounts_cache", |_| MOUNTS.clear_cache()),
        Cmd::std("get_recipes_data", |a| RECIPES.get_data(a)),
        Cmd::std("clear_recipes_cache", |_| RECIPES.clear_cache()),
        Cmd::std("get_styles_data", |a| STYLES.get_data(a)),
        Cmd::std("clear_styles_cache", |_| STYLES.clear_cache()),
    ]
}

/// main.py `warm_codex_caches`: builds missing or stale caches at launch (badges are
/// not part of the startup set). Skipped when no install is detected.
pub fn warm_caches() {
    if cache::resolve_install(Some("")).is_err() {
        return;
    }
    for c in [&ALLIES, &MOUNTS, &MEMENTOS, &RECIPES, &STYLES, &ITEMS, &FISH] {
        let _ = c.build(false, Some(""));
    }
}
