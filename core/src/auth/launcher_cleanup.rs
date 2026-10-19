//! utils/legacy_launcher_cleanup.py: wipe what the removed launcher tab and in-game
//! overlay left behind (DPAPI password/ticket blobs under `TroveLauncher`, `overlay.json`).

use std::io::Write;
use std::path::Path;

use crate::paths::{get_app_data_dir, get_cache_root, get_default_app_data_dir};

/// Overwrites a secret blob with zeros before it is unlinked.
fn scrub(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    let Ok(mut file) = std::fs::OpenOptions::new().read(true).write(true).open(path) else { return };
    let _ = file.write_all(&vec![0u8; meta.len() as usize]);
    let _ = file.flush();
}

fn is_bin(name: &str) -> bool {
    if cfg!(windows) {
        name.to_lowercase().ends_with(".bin")
    } else {
        name.ends_with(".bin")
    }
}

fn purge_launcher_dir(root: &Path) -> bool {
    let folder = root.join("TroveLauncher");
    if !folder.is_dir() {
        return false;
    }
    for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
        if is_bin(&entry.file_name().to_string_lossy()) {
            scrub(&entry.path());
        }
    }
    let _ = std::fs::remove_dir_all(&folder);
    true
}

/// `legacy_launcher_cleanup.purge`. Runs at launch on a background thread.
pub fn purge_legacy_launcher_secrets() {
    let mut roots = vec![get_app_data_dir()];
    let default = get_default_app_data_dir();
    if !roots.contains(&default) {
        roots.push(default);
    }
    for root in roots {
        if purge_launcher_dir(&root) {
            println!("Removed leftover Trove launcher data from {}", root.display());
        }
    }
    let _ = std::fs::remove_file(get_cache_root().join("overlay.json"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_zeroes_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pw.bin");
        std::fs::write(&file, b"secret").unwrap();
        scrub(&file);
        assert_eq!(std::fs::read(&file).unwrap(), vec![0u8; 6]);
    }

    #[test]
    fn purges_launcher_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("TroveLauncher");
        std::fs::create_dir_all(folder.join("sub")).unwrap();
        std::fs::write(folder.join("a.BIN"), b"x").unwrap();
        std::fs::write(folder.join("sub").join("b.txt"), b"y").unwrap();
        assert!(purge_launcher_dir(dir.path()));
        assert!(!folder.exists());
        assert!(!purge_launcher_dir(dir.path()));
    }
}
