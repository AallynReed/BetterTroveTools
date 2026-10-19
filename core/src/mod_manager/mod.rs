//! Not ported yet.

use crate::Cmd;

pub fn commands() -> Vec<Cmd> {
    Vec::new()
}

/// Points the mods-folder watcher at `game_path` (mod_watcher.watcher.set_target).
pub fn watcher_set_target(_game_path: &str) {}

/// Reconciles mod .cfg files for `game_path` (mod_watcher.probe_configs).
pub fn probe_configs(_game_path: &str) {}

/// main.py `probe_mods_on_launch`.
pub fn probe_mods_on_launch() {}

/// main.py `auto_update_mods_on_launch`.
pub fn auto_update_mods_on_launch() {}

/// main.py `remove_taken_down_mods_task` (runs forever, hourly).
pub fn remove_taken_down_mods_task() {}
