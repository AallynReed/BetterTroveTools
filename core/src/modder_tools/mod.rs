//! backend/modder_tools: the Modder Tools tab (modder_tools.py) and Steam Workshop
//! publishing (steam_workshop.py). The File Manager and Blueprint Editor live elsewhere.

use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{DateTime, Utc};

use crate::Cmd;

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
        Cmd::std("load_tmod_for_edit", tools::load_tmod_for_edit),
        Cmd::std("detect_override_files", tools::detect_override_files),
        Cmd::std("auto_structure_workspace", tools::auto_structure_workspace),
        Cmd::std("get_missing_files", tools::get_missing_files),
        Cmd::std("build_tmod", tools::build_tmod),
        Cmd::std("save_tmod_in_place", tools::save_tmod_in_place),
        Cmd::std("load_mod_project", tools::load_mod_project),
        Cmd::std("save_mod_project", tools::save_mod_project),
        Cmd::std("create_project_version", tools::create_project_version),
        Cmd::std("get_project_files", tools::get_project_files),
        Cmd::std("auto_structure_project_version", tools::auto_structure_project_version),
        Cmd::std("place_project_overrides", tools::place_project_overrides),
        Cmd::std("remove_project_overrides", tools::remove_project_overrides),
        Cmd::std("undo_remove_project_overrides", tools::undo_remove_project_overrides),
        Cmd::std("compile_project", tools::compile_project),
        Cmd::std("steam_workshop_status", sw::steam_workshop_status),
        Cmd::std("steam_workshop_connect", sw::steam_workshop_connect),
        Cmd::std("steam_workshop_disconnect", sw::steam_workshop_disconnect),
        Cmd::std("steam_workshop_read_tmod", sw::steam_workshop_read_tmod),
        Cmd::std("steam_workshop_list_items", sw::steam_workshop_list_items),
        Cmd::std("steam_workshop_set_visibility", sw::steam_workshop_set_visibility),
        Cmd::std("steam_workshop_publish", sw::steam_workshop_publish),
    ]
}
