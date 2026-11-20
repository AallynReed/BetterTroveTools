//! backend/modder_tools: the Modder Tools tab (modder_tools.py) and Steam Workshop
//! publishing (steam_workshop.py). The File Manager and Blueprint Editor live elsewhere.

use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{DateTime, Utc};

use crate::Cmd;

mod build_source;
pub mod steam_workshop;
mod tools;

#[cfg(test)]
mod tests;

/// A fixed clock for parity tests (`i64::MIN` = the real one).
static FIXED_NOW: AtomicI64 = AtomicI64::new(i64::MIN);

fn now_utc() -> DateTime<Utc> {
    match FIXED_NOW.load(Ordering::SeqCst) {
        i64::MIN => Utc::now(),
        micros => DateTime::from_timestamp_micros(micros).unwrap_or_else(Utc::now),
    }
}

pub fn commands() -> Vec<Cmd> {
    use steam_workshop as sw;
    vec![
        Cmd::std("cancel_modder_tools_operation", tools::cancel_modder_tools_operation),
        Cmd::std("ask_mod_source_directory", tools::ask_mod_source_directory),
        Cmd::std("ask_tmod_file", tools::ask_tmod_file),
        Cmd::std("ask_import_file", tools::ask_import_file),
        Cmd::std("ask_extract_destination", tools::ask_extract_destination),
        Cmd::std("ask_preview_file", tools::ask_preview_file),
        Cmd::std("ask_config_file", tools::ask_config_file),
        Cmd::std("ask_add_files", tools::ask_add_files),
        Cmd::std("extract_tmod", tools::extract_tmod),
        Cmd::std("extract_edit_files", tools::extract_edit_files),
        Cmd::std("load_tmod_for_edit", tools::load_tmod_for_edit),
        Cmd::std("detect_override_files", tools::detect_override_files),
        Cmd::std("auto_structure_workspace", tools::auto_structure_workspace),
        Cmd::std("get_missing_files", tools::get_missing_files),
        Cmd::std("build_tmod", tools::build_tmod),
        Cmd::raw("ask_build_source_directory", build_source::ask_build_source_directory),
        Cmd::raw("ask_build_files", build_source::ask_build_files),
        Cmd::std("scan_build_source", build_source::scan_build_source),
        Cmd::std("resolve_build_files", build_source::resolve_build_files),
        Cmd::std("move_build_file", build_source::move_build_file),
        Cmd::std("copy_into_build_source", build_source::copy_into_build_source),
        Cmd::std("watch_build_source", build_source::watch_build_source),
        Cmd::raw("ask_tmod_save_path", build_source::ask_tmod_save_path),
        Cmd::std("check_game_paths", build_source::check_game_paths),
        Cmd::std("find_mod_conflicts", build_source::find_mod_conflicts),
        Cmd::std("remove_built_tmod", build_source::remove_built_tmod),
        Cmd::std("save_tmod_in_place", tools::save_tmod_in_place),
        Cmd::std("steam_workshop_status", sw::steam_workshop_status),
        Cmd::std("steam_workshop_connect", sw::steam_workshop_connect),
        Cmd::std("steam_workshop_disconnect", sw::steam_workshop_disconnect),
        Cmd::std("steam_workshop_read_tmod", sw::steam_workshop_read_tmod),
        Cmd::std("steam_workshop_list_items", sw::steam_workshop_list_items),
        Cmd::std("steam_workshop_set_visibility", sw::steam_workshop_set_visibility),
        Cmd::std("steam_workshop_publish", sw::steam_workshop_publish),
    ]
}
