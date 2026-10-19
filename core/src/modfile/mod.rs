//! models/trove/mod.py: Trove's `.tmod` (and `.zip`) mods.
//!
//! - [`TroveMod`] is `TMod`/`ZMod` ([`ModKind`]): read with [`TroveMod::read_tmod`] /
//!   [`TroveMod::read_zip`], built with [`TroveMod::new`] + [`TroveMod::add_file`], written
//!   with [`TroveMod::compile_tmod`]. A `.tmod` built here is byte-identical to the Python
//!   build's.
//! - [`ModFile`] is `TroveModFile` / `PartialTroveModFile`.
//! - [`TroveModList`] is a whole install's mods folder.
//! - [`format`] is the container itself (shared with `.tpack` modpacks), [`trovesaurus`]
//!   the catalog model, [`compat`] the CPython behaviour the ports lean on.

pub mod cfg;
pub mod compat;
pub mod format;
mod list;
mod model;
mod toml_out;
pub mod trovesaurus;
pub mod zipmod;

pub use list::{Blocked, ListOptions, TroveModList};
pub use model::{build_container, no_preview_image, normalize_internal_path, FileExistsError, ModFile, ModKind, NoFilesError, Property, PropertyError, TroveMod};

#[cfg(test)]
mod tests;
