//! utils/helper.py: the shared `storage.json` key/value file in the cache root.

use serde_json::{Map, Value};

use crate::paths::get_cache_root;

pub fn get_storage_file() -> std::path::PathBuf {
    let dir = get_cache_root();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("storage.json")
}

/// The whole file, or `{}` when missing or unreadable.
pub fn read_storage() -> Value {
    std::fs::read_to_string(get_storage_file())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// Rewrites the file (`json.dump(data, f, indent=4)`).
pub fn write_storage(data: &Value) -> anyhow::Result<()> {
    std::fs::write(get_storage_file(), crate::json::dumps_indent(data, 4))?;
    Ok(())
}
