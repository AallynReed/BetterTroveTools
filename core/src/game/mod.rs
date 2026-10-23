//! Reading the user's Trove install: finding it, its executable, its archives, and the
//! game's own Trove.cfg.

pub mod archive;
pub mod executable;
pub mod hash;
pub mod registry;
pub mod repair;
pub mod trove_cfg;
pub mod vdf;

/// models/trove/directory.py: the top-level folders that hold `index.tfi` archives.
pub const DIRECTORIES: [&str; 11] = [
    "audio",
    "blueprints",
    "fonts",
    "languages",
    "models",
    "movies",
    "particles",
    "prefabs",
    "shadersunified",
    "textures",
    "ui",
];

/// utils/platform_open.py: reveal a path in the platform file manager.
pub fn open_in_file_manager(target: &std::path::Path, select_file: bool) -> std::io::Result<()> {
    use std::process::Command;
    let open_target = if target.is_file() { target.parent().unwrap_or(target) } else { target };
    if cfg!(windows) {
        if select_file && target.is_file() {
            let mut arg = std::ffi::OsString::from("/select,");
            arg.push(target.as_os_str());
            Command::new("explorer").arg(arg).spawn()?;
        } else {
            Command::new("explorer").arg(open_target).spawn()?;
        }
    } else if cfg!(target_os = "macos") {
        if select_file && target.is_file() {
            Command::new("open").arg("-R").arg(target).spawn()?;
        } else {
            Command::new("open").arg(open_target).spawn()?;
        }
    } else {
        Command::new("xdg-open").arg(open_target).spawn()?;
    }
    Ok(())
}
