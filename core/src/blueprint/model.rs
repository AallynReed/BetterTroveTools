//! utils/kiwi_blueprint/model.py: a whole creature (every `.blueprint` in a mod) opened,
//! placed on its rig, edited and written back into the archive it came from.

use base64::Engine as _;
use serde_json::{json, Value};

use super::assembly;
use super::codec;
use super::editor;
use super::py::{self, IntError, Obj, Py};
use super::tmod;
use super::transform;
use super::util::{Error, FxMap, Kind, Result};
use super::workshop::{self, Files};

const MAX_PARTS: usize = 48;
const PROJECT_VOXEL_CAP: usize = 300_000;
const BLUEPRINT_DIR: &str = "blueprints/";

/// `unpack`: `(kind, header, files)` of a `.tmod` or `.zip`.
pub fn unpack(data: &[u8], filename: &str) -> Result<workshop::Archive> {
    workshop::read_archive(data, filename).map_err(|e| e.into_editor(&[Kind::Workshop]))
}

/// `repack`: the edited project back into its own kind of file.
pub fn repack(kind: &str, props: &[(String, String)], files: &[(String, Vec<u8>)]) -> Result<(Vec<u8>, &'static str)> {
    if kind == "tmod" {
        return match tmod::build_tmod(1, props, files) {
            Ok(b) => Ok((b, "tmod")),
            Err(Error::Value(Kind::Tmod, m)) => Err(Error::editor(format!("That mod couldn't be rebuilt: {m}"))),
            Err(e) => Err(e),
        };
    }
    Ok((workshop::to_zip(files), "zip"))
}

fn is_blueprint(path: &str) -> bool {
    path.to_lowercase().ends_with(".blueprint")
}

/// `parts_of`: indices of the `.blueprint` files, in lowercased path order.
pub fn parts_of(files: &[(String, Vec<u8>)]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..files.len()).filter(|&i| is_blueprint(&files[i].0)).collect();
    idx.sort_by_cached_key(|&i| files[i].0.to_lowercase());
    idx
}

/// `basename_of`: `blueprints/DragonHead.blueprint` -> `dragonhead`.
pub fn basename_of(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or("");
    let keep = name.chars().count().saturating_sub(".blueprint".len());
    name.chars().take(keep).collect::<String>().to_lowercase()
}

/// `open_project`: every blueprint decoded and placed. `extra` string fields are
/// appended to the payload (the route's `source` / `prefab`).
#[allow(clippy::too_many_arguments)]
pub fn open_project(
    files: &[(String, Vec<u8>)],
    rig_name: Option<&str>,
    attach: &[(String, String)],
    name: &str,
    head_scale: f64,
    part_scales: Option<&FxMap<String, f64>>,
    extra: &[(&str, &str)],
) -> Result<String> {
    let blueprints = parts_of(files);
    if blueprints.is_empty() {
        return Err(Error::editor(
            "There are no .blueprint files in there. A model project is a mod's voxel parts - open a .tmod, a .zip or the blueprints themselves.",
        ));
    }
    if blueprints.len() > MAX_PARTS {
        return Err(Error::editor(format!(
            "That's {} models in one file, past the {MAX_PARTS} a project holds. Open the parts you want to work on instead.",
            py::thousands(blueprints.len() as i64)
        )));
    }
    let pose = rig_name.and_then(assembly::rig);
    let mut parts = String::new();
    let mut skipped = Vec::new();
    let mut total = 0;
    let mut placed = 0;
    for &i in &blueprints {
        let (path, raw) = &files[i];
        let base = path.rsplit('/').next().unwrap_or("");
        let payload = match editor::inspect(raw, base) {
            Ok(p) => p,
            Err(Error::Value(Kind::Editor, reason)) => {
                skipped.push(json!({"path": path, "reason": reason}));
                continue;
            }
            Err(e) => return Err(e),
        };
        total += payload.count;
        if total > PROJECT_VOXEL_CAP {
            return Err(Error::editor(format!(
                "This model is past the editor's {} voxel limit for a whole project. Open its parts one at a time instead.",
                py::thousands(PROJECT_VOXEL_CAP as i64)
            )));
        }
        let key = basename_of(path);
        let mut ap = attach.iter().find(|(b, _)| *b == key).map(|(_, a)| a.as_str());
        if let Some(rig) = pose {
            if !ap.is_some_and(|a| rig.has_ap(a)) {
                ap = None;
            }
        }
        let placed_ap = ap.filter(|a| !a.is_empty());
        let scale = part_scales.and_then(|s| s.get(&key).copied()).unwrap_or_else(|| placed_ap.map(|a| assembly::scale_for(a, rig_name, head_scale, 1.0)).unwrap_or(1.0));
        if placed > 0 {
            parts.push_str(", ");
        }
        placed += 1;
        let mut o = Obj::new(&mut parts);
        o.str("path", path);
        o.str("name", &payload.name);
        match ap {
            Some(a) => o.str("ap", a),
            None => o.key("ap").push_str("null"),
        }
        py::write_f64(o.key("scale"), if placed_ap.is_some() { scale } else { 1.0 });
        let out = o.key("blueprint");
        out.push('"');
        base64::engine::general_purpose::STANDARD.encode_string(raw, out);
        out.push('"');
        o.key("model").push_str(&payload.json);
        o.end();
    }
    if placed == 0 {
        return Err(Error::editor(if skipped.is_empty() { "There's nothing to edit in there." } else { "None of the blueprints in there could be opened." }));
    }
    let mut out = String::with_capacity(parts.len() + 4096);
    let mut o = Obj::new(&mut out);
    o.str("name", name);
    match pose.and(rig_name) {
        Some(r) => o.value("rig", &rig_payload(r, head_scale).unwrap_or(Value::Null)),
        None => o.key("rig").push_str("null"),
    }
    let list = o.key("parts");
    list.push('[');
    list.push_str(&parts);
    list.push(']');
    o.value("skipped", &Value::Array(skipped));
    o.int("extras", (files.len() - blueprints.len()) as i64);
    for (k, v) in extra {
        o.str(k, v);
    }
    o.end();
    Ok(out)
}

/// `rig_payload`: the whole skeleton, every socket with its scale, and the clip names.
pub fn rig_payload(rig_name: &str, head_scale: f64) -> Option<Value> {
    let rig = assembly::rig(rig_name)?;
    let scales: serde_json::Map<String, Value> =
        rig.ap_keys().map(|ap| (ap.to_string(), json!(assembly::scale_for(ap, Some(rig_name), head_scale, 1.0)))).collect();
    Some(json!({
        "name": rig_name,
        "voxel_scale": rig.voxel_scale,
        "rest": rig.rest,
        "scales": scales,
        "animations": rig.animations,
    }))
}

/// `tuple(v or ()) != (0, 0, 0)`; a truthy value that can't be iterated is a TypeError.
fn is_real_move(v: &Py) -> Result<bool> {
    if !v.truthy() {
        return Ok(true);
    }
    let items = v.iter().ok_or_else(|| Error::internal("TypeError: object is not iterable"))?;
    Ok(!(items.len() == 3 && items.iter().all(|i| i.eq_int(0))))
}

/// `_delta`: exactly three ints.
fn delta_of(v: &Py) -> Result<[i128; 3]> {
    const MSG: &str = "A part's move wasn't understood.";
    let items = v.iter().ok_or_else(|| Error::editor(MSG))?;
    let mut out = Vec::with_capacity(3);
    for item in items.iter().take(4) {
        match item.int() {
            Ok(i) => out.push(i),
            Err(IntError::Overflow) => return Err(Error::internal("cannot convert float infinity to integer")),
            Err(_) => return Err(Error::editor(MSG)),
        }
    }
    if items.len() != 3 {
        return Err(Error::editor(MSG));
    }
    Ok([out[0], out[1], out[2]])
}

/// `_moved`: one part slid along its bone.
fn moved(raw: &[u8], delta: &Py) -> Result<Vec<u8>> {
    let caught = [Kind::Transform, Kind::Blueprint];
    let decoded = codec::decode_full(raw).map_err(|e| e.into_editor(&caught))?;
    let delta = delta_of(delta)?;
    let m = transform::move_on_rig(decoded, delta).map_err(|e| e.into_editor(&caught))?;
    codec::encode_decoded(&m).map_err(|e| e.into_editor(&caught))
}

/// `apply_project(files, edits, extra, moves)`.
pub fn apply_project(files: Files, edits: &Py, extra: Files, moves: &Py) -> Result<(Files, Value)> {
    // `dict(extra)`: a repeated path keeps its first slot and its last bytes.
    let mut incoming: Vec<(String, Option<Vec<u8>>)> = Vec::new();
    for (p, d) in extra {
        match incoming.iter_mut().find(|(k, _)| *k == p) {
            Some(slot) => slot.1 = Some(d),
            None => incoming.push((p, Some(d))),
        }
    }
    let mut merged: Files = files
        .into_iter()
        .map(|(p, d)| {
            let replaced = incoming.iter_mut().find(|(k, v)| *k == p && v.is_some()).and_then(|(_, v)| v.take());
            (p, replaced.unwrap_or(d))
        })
        .collect();
    let added: Vec<(String, Vec<u8>)> = incoming.into_iter().filter_map(|(p, d)| d.map(|d| (p, d))).collect();
    let added_parts = added.len();
    merged.extend(added);

    let empty = Vec::new();
    let edit_items = match edits {
        Py::Dict(items) => items,
        _ => &empty,
    };
    let mut kept_moves: Vec<(&String, &Py)> = Vec::new();
    if let Py::Dict(items) = moves {
        for (k, v) in items {
            if is_real_move(v)? {
                kept_moves.push((k, v));
            }
        }
    }
    let known = |p: &str| merged.iter().any(|(k, _)| k == p);
    if let Some(p) = edit_items.iter().map(|(k, _)| k).chain(kept_moves.iter().map(|(k, _)| *k)).find(|p| !known(p)) {
        return Err(Error::editor(format!("'{p}' isn't a file in that mod - reopen the model and try again.")));
    }
    if parts_of(&merged).len() > MAX_PARTS {
        return Err(Error::editor(format!("That's more than the {MAX_PARTS} parts a project holds.")));
    }
    let mut counts = [0i64; 6];
    const KEYS: [&str; 5] = ["recoloured", "rematerialised", "added", "erased", "ignored"];
    let mut out = Vec::with_capacity(merged.len());
    for (path, raw) in merged {
        let entries = edit_items.iter().find(|(k, _)| *k == path).map(|(_, v)| v);
        let delta = kept_moves.iter().find(|(k, _)| **k == path).map(|(_, v)| *v);
        if !entries.is_some_and(Py::truthy) && !delta.is_some_and(Py::truthy) {
            out.push((path, raw));
            continue;
        }
        let mut data = raw;
        if let Some(entries) = entries.filter(|e| e.truthy()) {
            let (edited, part) = editor::apply_edits(&data, entries)?;
            for (i, k) in KEYS.iter().enumerate() {
                counts[i + 1] += part.get(*k).and_then(Value::as_i64).unwrap_or(0);
            }
            data = edited;
        }
        if let Some(delta) = delta.filter(|d| d.truthy()) {
            data = moved(&data, delta)?;
        }
        out.push((path, data));
        counts[0] += 1;
    }
    let summary = json!({
        "parts": counts[0],
        "added_parts": added_parts,
        "moved": kept_moves.len(),
        "recoloured": counts[1],
        "rematerialised": counts[2],
        "added": counts[3],
        "erased": counts[4],
        "ignored": counts[5],
    });
    Ok((out, summary))
}

/// `pack_path`: where a newly added part goes inside the mod.
pub fn pack_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let clean: Vec<&str> = normalized.split('/').filter(|s| !matches!(*s, "" | "." | "..")).collect();
    let mut name = if clean.is_empty() { "part.blueprint".to_string() } else { clean.join("/") };
    if !is_blueprint(&name) {
        name.push_str(".blueprint");
    }
    if name.contains('/') {
        name
    } else {
        format!("{BLUEPRINT_DIR}{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(basename_of("blueprints\\DragonHead.blueprint"), "dragonhead");
        assert_eq!(pack_path("../x/./Horn"), "x/Horn.blueprint");
        assert_eq!(pack_path("horn.Blueprint"), "blueprints/horn.Blueprint");
        assert_eq!(pack_path(""), "blueprints/part.blueprint");
    }
}
