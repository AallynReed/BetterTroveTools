//! backend/modder_tools/blueprint_editor.py: the Blueprint Editor's local endpoints,
//! KiwiAPI's `/site/blueprint-editor/*` with `/site` swapped for `/api`. The page posts
//! `FormData` and reads the answers (and their `X-Kiwi-*` headers) as blobs; errors are
//! KiwiAPI's `{"detail": ...}` bodies.
//!
//! The engine is utils/kiwi_blueprint, a port of KiwiAPI's blueprint editor.

mod assembly;
mod binfab;
mod codec;
mod editor;
mod game_data;
mod lint;
mod materials;
mod merge;
mod model;
mod multipart;
mod pyobj;
mod pyzlib;
mod qb;
mod tmod;
mod transform;
mod util;
mod workshop;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::args::{to_str, truthy};
use crate::game::archive::resolve_game_install;
use crate::routes::{Params, Request, Response, Route};
use crate::{Args, Cmd, Dialog};

use multipart::{Form, FormError};
use pyobj::Py;
use crate::py;
use util::{Error, Kind, Result};

pub fn commands() -> Vec<Cmd> {
    vec![Cmd::std("save_blueprint_editor_file", save_blueprint_editor_file)]
}

pub fn routes() -> Vec<Route> {
    vec![
        Route::post("/api/blueprint-editor/inspect", inspect),
        Route::post("/api/blueprint-editor/flatten", flatten),
        Route::post("/api/blueprint-editor/transform", transform),
        Route::post("/api/blueprint-editor/export-qb", export_qb),
        Route::post("/api/blueprint-editor/import-qb", import_qb),
        Route::post("/api/blueprint-editor/check", check),
        Route::post("/api/blueprint-editor/save", save),
        Route::post("/api/blueprint-editor/model", open_model),
        Route::get("/api/blueprint-editor/game-model", open_game_model),
        Route::post("/api/blueprint-editor/model-save", save_model),
        Route::get("/api/blueprint-editor/search", search),
        Route::get("/api/rigs/<skeleton>/anim/<name>", rig_animation),
        Route::get("/api/rigs/<skeleton>/graph", rig_graph),
        Route::get("/api/render/brdf-map.png", brdf_map),
    ]
}

const INDEX_WAIT_SECONDS: f64 = 600.0;
const EDIT_LIST: &str = "The edit list wasn't understood.";

// --- responses ---------------------------------------------------------------------

fn json_text(body: String, status: u16) -> Response {
    Response::new(status, "application/json", body.into_bytes()).header("Cache-Control", "no-store")
}

fn json_response(payload: &Value) -> Response {
    json_text(crate::json::dumps(payload), 200)
}

fn binary(content: Vec<u8>, media: &str, headers: &[(&str, String)]) -> Response {
    let mut r = Response::new(200, media, content).header("Cache-Control", "no-store");
    for (k, v) in headers {
        r = r.header(k, v);
    }
    r
}

fn refused(status: u16, detail: impl Into<String>) -> Error {
    Error::Refused(status, detail.into())
}

/// `_route`: `_Refused` and `EditorError` become `{"detail"}` answers; anything else
/// Python let escape is bottle's 500.
fn reply(outcome: Result<Response>) -> Response {
    match outcome {
        Ok(r) => r,
        Err(Error::Value(Kind::Editor, detail)) => json_text(crate::json::dumps(&json!({ "detail": detail })), 400),
        Err(Error::Refused(status, detail)) => json_text(crate::json::dumps(&json!({ "detail": detail })), status),
        Err(Error::Http(status, message)) => Response::error(status, &message),
        Err(Error::Value(_, msg) | Error::Internal(msg)) => {
            // bottle printed the traceback to stderr.
            eprintln!("blueprint editor: unhandled error: {msg}");
            Response::error(500, "Internal Server Error")
        }
    }
}

/// `_attachment(name)`: an ASCII fallback plus the RFC 5987 UTF-8 name.
fn attachment(name: &str) -> String {
    let fallback: String = name.chars().map(|c| if (' '..='~').contains(&c) { c } else { '_' }).filter(|&c| c != '"').collect();
    let fallback = if fallback.is_empty() { "download".to_string() } else { fallback };
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{}", crate::http::quote_safe(name, "/"))
}

// --- request helpers ---------------------------------------------------------------

fn form(req: &Request) -> Result<Form<'_>> {
    multipart::parse(req).map_err(|e| match e {
        FormError::Http(status, message) => Error::Http(status, message),
        FormError::Internal => Error::internal("malformed request body"),
    })
}

/// `_name(part, default)`: the upload's base name.
fn base_name(filename: &str, default: &str) -> String {
    let name = if filename.is_empty() { default } else { filename };
    name.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string()
}

/// `_form_json(field, default, what)`.
fn form_json(form: &Form, field: &str, default: &str, what: &str) -> Result<Py> {
    pyobj::loads(&form.text(field, default)).map_err(|e| match e {
        pyobj::JsonError::Invalid => refused(400, what),
        pyobj::JsonError::TooDeep => Error::internal("maximum recursion depth exceeded"),
    })
}

/// `_base()`: the posted blueprint and its name.
fn base<'a>(form: &Form<'a>) -> Result<(&'a [u8], String)> {
    match form.upload("file") {
        Some(part) if !part.data.is_empty() => Ok((part.data, base_name(&part.filename, "blueprint"))),
        _ => Err(refused(400, "That file is empty.")),
    }
}

/// `_stack()`: the layer files and their placements.
fn stack<'a>(form: &Form<'a>) -> Result<(Vec<&'a [u8]>, Py)> {
    let layers: Vec<&[u8]> = form.uploads("layers").iter().map(|u| u.data).collect();
    if layers.is_empty() {
        return Ok((layers, Py::List(Vec::new())));
    }
    const WHAT: &str = "The layer list wasn't understood.";
    let specs = form_json(form, "stack", "[]", WHAT)?;
    if !matches!(specs, Py::List(_)) {
        return Err(refused(400, WHAT));
    }
    Ok((layers, specs))
}

/// `_anchor()`.
fn anchor(form: &Form) -> i128 {
    pyobj::int_from_str(&form.text("anchor_at", "0")).unwrap_or(0)
}

fn lower_ends_with(name: &str, suffix: &str) -> bool {
    name.to_lowercase().ends_with(suffix)
}

/// `name[:-n]` by characters.
fn drop_chars(name: &str, n: usize) -> String {
    let keep = name.chars().count().saturating_sub(n);
    name.chars().take(keep).collect()
}

// --- the game install --------------------------------------------------------------

/// `_game_path()`: the install Modder Tools has selected, else the first one detected.
fn game_path() -> Option<PathBuf> {
    let saved = crate::settings::read_settings_from_disk().get("last_game_path").filter(|v| truthy(v)).map(to_str).unwrap_or_default();
    let saved = Some(saved).filter(|s| !s.is_empty());
    [saved, None].into_iter().find_map(|candidate| resolve_game_install(candidate.as_deref()).ok())
}

fn require_game() -> Result<PathBuf> {
    game_path().ok_or_else(|| refused(404, "No Trove installation was found, so the game's models can't be read."))
}

/// `_rig_map(wait)`: without an install the map is empty, so parts are laid out unplaced.
fn rig_map(wait: bool) -> Result<Arc<game_data::RigMap>> {
    let Some(path) = game_path() else { return Ok(Arc::new(game_data::RigMap::default())) };
    let mut waited = 0.0;
    loop {
        if let Some(rig) = game_data::rig_map(&path) {
            return Ok(rig);
        }
        if let Some(e) = game_data::index_error().filter(|e| !e.is_empty()) {
            return Err(refused(500, format!("The game's models couldn't be indexed: {e}")));
        }
        if !wait || waited >= INDEX_WAIT_SECONDS {
            return Err(refused(503, "Still reading the game's models - try again in a moment."));
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
        waited += 0.25;
    }
}

// --- single blueprints -------------------------------------------------------------

fn inspect(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let (data, name) = base(&form)?;
        Ok(json_text(editor::inspect(data, &name)?.json, 200))
    })())
}

fn flatten(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let (data, _) = base(&form)?;
        let (parts, specs) = stack(&form)?;
        if parts.is_empty() {
            return Err(refused(400, "There are no layers to flatten."));
        }
        let edits = form_json(&form, "edits", "[]", EDIT_LIST)?;
        let (out, summary) = editor::composite(data, &edits, &parts, &specs, anchor(&form))?;
        Ok(binary(out, "application/octet-stream", &[("X-Kiwi-Summary", crate::json::dumps(&Value::Object(summary)))]))
    })())
}

fn transform(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let (data, _) = base(&form)?;
        let edits = form_json(&form, "edits", "[]", "The request wasn't understood.")?;
        let ops = form_json(&form, "ops", "[]", "The request wasn't understood.")?;
        let (out, summary) = editor::transform(data, &edits, &ops)?;
        Ok(binary(out, "application/octet-stream", &[("X-Kiwi-Summary", crate::json::dumps(&summary))]))
    })())
}

fn export_qb(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let (data, name) = base(&form)?;
        let edits = form_json(&form, "edits", "[]", EDIT_LIST)?;
        let stem = if lower_ends_with(&name, ".blueprint") { drop_chars(&name, ".blueprint".len()) } else { name };
        let stem: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
        let stem = if stem.is_empty() { "model".to_string() } else { stem };
        let (parts, specs) = stack(&form)?;
        let (archive, notes) = editor::export_qb(data, &edits, &parts, &specs, anchor(&form), &stem)?;
        Ok(binary(
            archive,
            "application/zip",
            &[("Content-Disposition", attachment(&format!("{stem}_qb.zip"))), ("X-Kiwi-Notes", crate::json::dumps(&json!(notes)))],
        ))
    })())
}

fn import_qb(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
        for part in form.uploads("files") {
            let name = base_name(&part.filename, "model.qb");
            if !lower_ends_with(&name, ".qb") {
                return Err(refused(400, format!("'{name}' isn't a .qb file.")));
            }
            match parts.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = part.data.to_vec(),
                None => parts.push((name, part.data.to_vec())),
            }
        }
        if parts.is_empty() {
            return Err(refused(400, "No .qb files were sent."));
        }
        if parts.len() > 4 {
            return Err(refused(400, "Send the model and up to three material maps."));
        }
        let (data, summary) = editor::import_qb(&parts)?;
        Ok(binary(data, "application/octet-stream", &[("X-Kiwi-Summary", crate::json::dumps(&summary))]))
    })())
}

fn check(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let (data, _) = base(&form)?;
        let edits = form_json(&form, "edits", "[]", EDIT_LIST)?;
        let (parts, specs) = stack(&form)?;
        let report = editor::check(data, &edits, &form.text("kind", "other"), &parts, &specs, anchor(&form))?;
        Ok(json_response(&report))
    })())
}

fn save(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let (data, mut name) = base(&form)?;
        let edits = form_json(&form, "edits", "[]", EDIT_LIST)?;
        let (parts, specs) = stack(&form)?;
        let (out, summary) = editor::composite(data, &edits, &parts, &specs, anchor(&form))?;
        if !lower_ends_with(&name, ".blueprint") {
            name.push_str(".blueprint");
        }
        let count = |k: &str| summary.get(k).map(|v| v.to_string()).unwrap_or_default();
        Ok(binary(
            out,
            "application/octet-stream",
            &[
                ("Content-Disposition", attachment(&name)),
                ("X-Kiwi-Recoloured", count("recoloured")),
                ("X-Kiwi-Rematerialised", count("rematerialised")),
                ("X-Kiwi-Ignored", count("ignored")),
            ],
        ))
    })())
}

// --- model projects ----------------------------------------------------------------

type ModelFiles = (&'static str, Vec<(String, String)>, workshop::Files, String);

/// `_model_files(use_file)`: an archive, or the loose `.blueprint` files.
fn model_files(form: &Form, use_file: bool) -> Result<ModelFiles> {
    if let Some(part) = form.upload("file").filter(|_| use_file) {
        if part.data.is_empty() {
            return Err(refused(400, "That file is empty."));
        }
        let name = base_name(&part.filename, "model");
        let (kind, props, files) = model::unpack(part.data, &name)?;
        return Ok((kind, props, files, name));
    }
    let mut loose = Vec::new();
    for p in form.uploads("files") {
        let name = base_name(&p.filename, "part.blueprint");
        if !lower_ends_with(&name, ".blueprint") {
            return Err(refused(400, format!("'{name}' isn't a .blueprint.")));
        }
        loose.push((name, p.data.to_vec()));
    }
    if loose.is_empty() {
        return Err(refused(400, "Send a .tmod or .zip, or the .blueprint files themselves."));
    }
    Ok(("files", Vec::new(), loose, "model".to_string()))
}

fn open_model(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let (kind, _props, unpacked, name) = model_files(&form, true)?;
        let blueprints = model::parts_of(&unpacked);
        if blueprints.is_empty() {
            return Err(refused(400, "There are no .blueprint files in there."));
        }
        let rig = rig_map(true)?;
        let basenames: Vec<String> = blueprints.iter().map(|&i| model::basename_of(&unpacked[i].0)).collect();
        let (mut skeleton, attach) = game_data::resolve(&rig, &basenames);
        if skeleton.as_deref().is_some_and(|s| !s.is_empty() && !assembly::has_baked_rig(s)) {
            skeleton = None;
        }
        let scales = game_data::scales_for(&rig, &attach, skeleton.as_deref());
        let parts: util::FxMap<String, f64> = scales.parts.into_iter().collect();
        let payload = model::open_project(&unpacked, skeleton.as_deref(), &attach, &name, scales.head, Some(&parts), &[("source", kind)])?;
        Ok(json_text(payload, 200))
    })())
}

fn open_game_model(req: &Request, _: &Params) -> Response {
    reply((|| {
        let prefab = py::strip(&multipart::query_text(req, "prefab").unwrap_or_default()).to_string();
        if prefab.is_empty() {
            return Err(refused(400, "Say which creature to open."));
        }
        let game = require_game()?;
        let rig = rig_map(true)?;
        let (canonical, candidates) = game_data::prefab_path(&rig, &prefab);
        let Some(canonical) = canonical else {
            return Err(match candidates.first() {
                Some(first) => refused(400, format!("'{prefab}' names {} different creatures. Use the full path: {first}", candidates.len())),
                None => refused(404, format!("The game data has no creature at '{prefab}'.")),
            });
        };
        let (skeleton, parts) = &rig.creatures[&canonical];
        // Python re-walked the blueprints tree for every part; once per request reads the same.
        let index = game_data::index_of(&game, "blueprints");
        let paths = game_data::blueprint_paths(index.as_deref());
        let mut files = Vec::new();
        for (basename, _) in parts {
            let file = format!("{basename}.blueprint");
            let path = game_data::nearest_path(paths.get(&file).map(Vec::as_slice).unwrap_or(&[]), &canonical);
            let raw = path.zip(index.as_deref()).and_then(|(p, i)| game_data::read_indexed(i, &p["blueprints/".len()..]));
            if let Some(raw) = raw.filter(|r| !r.is_empty()) {
                files.push((file, raw));
            }
        }
        if files.is_empty() {
            return Err(refused(404, "None of that creature's parts are in the game archive."));
        }
        let scales = game_data::creature_scales(&rig, &canonical);
        let part_scales: util::FxMap<String, f64> = scales.parts.into_iter().collect();
        let rig_name = assembly::has_baked_rig(skeleton).then_some(skeleton.as_str());
        let name = format!("{}.zip", game_data::prefab_stem(&canonical));
        let payload = model::open_project(&files, rig_name, parts, &name, scales.head, Some(&part_scales), &[("source", "game"), ("prefab", &canonical)])?;
        Ok(json_text(payload, 200))
    })())
}

fn save_model(req: &Request, _: &Params) -> Response {
    reply((|| {
        let form = form(req)?;
        let has_archive = form.upload("file").is_some();
        let (kind, props, unpacked, source_name) = model_files(&form, has_archive)?;
        let name = base_name(&form.text("name", ""), "");
        let name = if name.is_empty() { source_name } else { name };
        let edits = form_json(&form, "edits", "{}", EDIT_LIST)?;
        let moves = form_json(&form, "moves", "{}", EDIT_LIST)?;
        let extra_paths = form_json(&form, "paths", "[]", EDIT_LIST)?;
        let (Py::Dict(_), Py::Dict(_), Py::List(extra_paths)) = (&edits, &moves, &extra_paths) else {
            return Err(refused(400, EDIT_LIST));
        };
        let mut extra = Vec::new();
        if has_archive {
            let added = form.uploads("files");
            if extra_paths.len() != added.len() {
                return Err(refused(400, "The added parts didn't match the paths that arrived."));
            }
            for (part, want) in added.iter().zip(extra_paths) {
                let want = want.str();
                let path = if want.is_empty() { part.filename.clone() } else { want };
                extra.push((model::pack_path(&path), part.data.to_vec()));
            }
        }
        let (edited, summary) = model::apply_project(unpacked, &edits, extra, &moves)?;
        let (out, ext) = model::repack(kind, &props, &edited)?;
        let stem = strip_archive_ext(&name);
        let stem = if stem.is_empty() { "model".to_string() } else { stem };
        Ok(binary(
            out,
            "application/octet-stream",
            &[("Content-Disposition", attachment(&format!("{stem}.{ext}"))), ("X-Kiwi-Summary", crate::json::dumps(&summary))],
        ))
    })())
}

/// `re.sub(r"\.(tmod|zip)$", "", name, flags=re.I)`: `$` also matches before a final newline.
fn strip_archive_ext(name: &str) -> String {
    let (body, nl) = match name.strip_suffix('\n') {
        Some(b) => (b, "\n"),
        None => (name, ""),
    };
    let low = body.to_ascii_lowercase();
    for ext in [".tmod", ".zip"] {
        if low.ends_with(ext) {
            return format!("{}{nl}", &body[..body.len() - ext.len()]);
        }
    }
    name.to_string()
}

// --- game data ---------------------------------------------------------------------

fn search(req: &Request, _: &Params) -> Response {
    reply((|| {
        let Some(game) = game_path() else {
            return Ok(json_response(&json!({"items": [], "total": 0, "error": "No Trove installation was found."})));
        };
        let Some(rig) = game_data::rig_map(&game) else {
            let error = game_data::index_error();
            let indexing = !error.as_deref().is_some_and(|e| !e.is_empty());
            return Ok(json_response(&json!({"items": [], "total": 0, "indexing": indexing, "error": error})));
        };
        let raw_limit = multipart::query_raw(req, "limit").map(|b| py::latin1(&b)).filter(|s| !s.is_empty());
        let limit = match raw_limit {
            None => 60,
            Some(s) => pyobj::int_from_str(&s).map(|v| v.clamp(1, 200) as usize).unwrap_or(60),
        };
        let q = multipart::query_text(req, "q").unwrap_or_default();
        let kind = multipart::query_text(req, "type").unwrap_or_default();
        let (items, total) = game_data::search(&rig, &q, &kind, limit);
        let count = items.len();
        Ok(json_response(&json!({"items": items, "count": count, "total": total})))
    })())
}

fn rig_animation(_: &Request, p: &Params) -> Response {
    reply(match assembly::load_animation(&p["skeleton"], &p["name"]) {
        Some(anim) => Ok(binary(anim, "application/octet-stream", &[])),
        None => Err(refused(404, "No such rig animation")),
    })
}

fn rig_graph(_: &Request, p: &Params) -> Response {
    reply(match assembly::load_animation_graph(&p["skeleton"]) {
        Some(graph) => Ok(binary(graph, "application/json", &[])),
        None => Err(refused(404, "No such rig animation graph")),
    })
}

fn brdf_map(_: &Request, _: &Params) -> Response {
    reply((|| {
        let png = match game_path() {
            Some(game) => game_data::brdf_png(&game).map_err(Error::internal)?,
            None => None,
        };
        let png = png.ok_or_else(|| refused(404, "brdf map not available"))?;
        Ok(Response::new(200, "image/png", png.to_vec()).header("Cache-Control", "public, max-age=86400"))
    })())
}

// --- saving to disk ----------------------------------------------------------------

/// pathlib's `suffix` (3.14): leading dots don't count, a trailing one does.
fn suffix(name: &str) -> String {
    let stem = name.trim_start_matches('.');
    stem.rfind('.').map(|i| stem[i..].to_string()).unwrap_or_default()
}

/// `str(OSError)` for the failures a save can hit.
fn os_error(e: &std::io::Error, path: &str) -> String {
    let (errno, text) = match e.kind() {
        std::io::ErrorKind::NotFound => (2, "No such file or directory"),
        std::io::ErrorKind::PermissionDenied => (13, "Permission denied"),
        std::io::ErrorKind::AlreadyExists => (17, "File exists"),
        std::io::ErrorKind::IsADirectory => (21, "Is a directory"),
        std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidFilename => (22, "Invalid argument"),
        std::io::ErrorKind::StorageFull => (28, "No space left on device"),
        _ => return e.to_string(),
    };
    format!("[Errno {errno}] {text}: {}", py::repr_str_cc(path))
}

/// `save_blueprint_editor_file(filename, data_base64)`: the page's downloads, through a
/// Save As dialog (WebView2 has no download shelf).
fn save_blueprint_editor_file(a: &Args) -> anyhow::Result<Value> {
    let raw = if truthy(a.get(0)) { a.str(0) } else { "download".into() };
    let name = raw.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string();
    let name = if name.is_empty() { "download".to_string() } else { name };
    let ext = suffix(&name).to_lowercase();
    let mut dialog = Dialog::new("Save").default_name(&name);
    if !ext.is_empty() {
        dialog = dialog.filter(&format!("{} file", ext[1..].to_uppercase()), &[&ext[1..]]);
    }
    dialog = dialog.filter("All Files", &["*"]);
    let Some(path) = crate::ctx().host().save_file(dialog) else {
        return Ok(json!({"success": true, "cancelled": true}));
    };
    let data = py::b64decode(&if truthy(a.get(1)) { a.str(1) } else { String::new() }).map_err(anyhow::Error::msg)?;
    // Tk hands back forward slashes on Windows too.
    let shown = if cfg!(windows) { path.to_string_lossy().replace('\\', "/") } else { path.to_string_lossy().into_owned() };
    std::fs::write(&path, data).map_err(|e| anyhow::anyhow!(os_error(&e, &shown)))?;
    Ok(json!({"success": true, "path": shown}))
}
