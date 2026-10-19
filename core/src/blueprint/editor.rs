//! utils/kiwi_blueprint/editor.py: inspect a blueprint, apply the page's edits, flatten
//! layer stacks, and the output paths (save, checks, `.qb` export) built on them.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

use super::codec::{self, Decoded, Voxel};
use super::lint;
use super::materials;
use super::merge;
use super::py::{self, IntError, Obj, Py};
use super::qb;
use super::transform as bp_transform;
use super::util::{fx_map, Cell, Error, FxBuild, FxMap, Kind, Result};
use super::workshop;

pub const EDITOR_VOXEL_CAP: usize = 150_000;
const MAX_BLUEPRINT_BYTES: usize = 4 * 1024 * 1024;
const MAX_QB_BYTES: usize = 48 * 1024 * 1024;
const MAX_ADDED_VOXELS: usize = 20_000;
const COORD_LIMIT: i128 = 4096;
const MAX_LAYERS: usize = 8;

/// `int(v)` where TypeError/ValueError become `msg` and OverflowError escapes.
fn int_or(v: &Py, msg: &str) -> Result<i128> {
    match v.int() {
        Ok(i) => Ok(i),
        Err(IntError::Overflow) => Err(Error::internal("cannot convert float infinity to integer")),
        Err(_) => Err(Error::editor(msg)),
    }
}

fn decode_or_raise(raw: &[u8]) -> Result<Decoded> {
    if raw.len() > MAX_BLUEPRINT_BYTES {
        return Err(Error::editor("That file is too large to be a Trove blueprint."));
    }
    if codec::is_empty_blueprint(raw) {
        return Err(Error::editor("This blueprint is an empty placeholder - there's nothing to edit."));
    }
    codec::decode_full(raw).map_err(|e| e.into_editor(&[Kind::Blueprint]))
}

/// The editor payload: its name and voxel count, and the whole thing as JSON text.
pub struct Inspected {
    pub name: String,
    pub count: usize,
    pub json: String,
}

fn statics_json() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| {
        let mut out = String::new();
        out.push_str("\"creation_types\": ");
        py::write_value(&mut out, &json!(lint::creation_types().collect::<Vec<_>>()));
        out.push_str(", \"transforms\": ");
        py::write_value(&mut out, &Value::Array(bp_transform::OPERATIONS.iter().map(|(op, label)| json!({"op": op, "label": label})).collect()));
        out.push_str(", \"align_modes\": ");
        py::write_value(&mut out, &Value::Array(merge::ALIGN_MODES.iter().map(|(mode, label)| json!({"mode": mode, "label": label})).collect()));
        out
    })
}

/// `inspect(raw, name=...)`.
pub fn inspect(raw: &[u8], name: &str) -> Result<Inspected> {
    let decoded = decode_or_raise(raw)?;
    let voxels = &decoded.voxels;
    let n = voxels.len();
    if n > EDITOR_VOXEL_CAP {
        return Err(Error::editor(format!(
            "This model has {} voxels, past the editor's {} limit. It can still be viewed in 3D.",
            py::thousands(n as i64),
            py::thousands(EDITOR_VOXEL_CAP as i64)
        )));
    }
    let mut rgb = Vec::with_capacity(n);
    let mut kind = Vec::with_capacity(n);
    let mut level = Vec::with_capacity(n);
    let mut spec = Vec::with_capacity(n);
    let (mut procedural, mut placeholders, mut locked) = (0usize, 0usize, 0usize);
    let mut seen: Vec<((u16, u8), usize)> = Vec::new();
    let mut seen_at: FxMap<(u16, u8), usize> = fx_map(64);
    for v in voxels {
        let (r, g, b, k, lv, sp) = materials::material_for(v.r, v.g, v.b, v.w, v.t);
        rgb.push((r as u32) << 16 | (g as u32) << 8 | b as u32);
        kind.push(k);
        level.push(lv);
        spec.push(sp);
        if !materials::is_editable(v.t) {
            locked += 1;
        }
        if v.t == materials::PLACEHOLDER_TYPE {
            placeholders += 1;
        }
        if materials::is_procedural(v.t, v.r, v.g, v.b) {
            procedural += 1;
        }
        match seen_at.get(&(v.t, v.w)) {
            Some(&i) => seen[i].1 += 1,
            None => {
                seen_at.insert((v.t, v.w), seen.len());
                seen.push(((v.t, v.w), 1));
            }
        }
    }
    seen.sort_by_key(|s| std::cmp::Reverse(s.1));

    let mut out = String::with_capacity(n * 48 + 8192);
    let mut o = Obj::new(&mut out);
    o.str("name", name);
    o.int("count", n as i64);
    py::write_ints(o.key("size"), decoded.size);
    o.int("version", decoded.version as i64);
    py::write_opt_ints(o.key("attachment"), codec::attachment_point(&decoded).as_ref().map(|a| &a[..]));
    py::write_ints(o.key("origin"), if decoded.version == 5 { decoded.pos } else { decoded.offset });
    o.out.push_str(", ");
    o.out.push_str(statics_json());
    py::write_ints(o.key("x"), voxels.iter().map(|v| v.x));
    py::write_ints(o.key("y"), voxels.iter().map(|v| v.y));
    py::write_ints(o.key("z"), voxels.iter().map(|v| v.z));
    py::write_ints(o.key("rgb"), &rgb);
    py::write_ints(o.key("kind"), &kind);
    py::write_ints(o.key("level"), &level);
    py::write_ints(o.key("spec"), &spec);
    py::write_ints(o.key("type"), voxels.iter().map(|v| v.t));
    py::write_ints(o.key("w"), voxels.iter().map(|v| v.w));
    py::write_ints(o.key("edit"), voxels.iter().map(|v| materials::is_editable(v.t) as u8));
    py::write_ints(o.key("paint"), voxels.iter().map(|v| !materials::is_procedural(v.t, v.r, v.g, v.b) as u8));
    let materials_list: Vec<Value> = seen
        .iter()
        .map(|&((t, w), count)| json!({"type": t, "w": w, "count": count, "label": materials::describe(t, w as i64), "editable": materials::is_editable(t)}))
        .collect();
    o.value("materials", &Value::Array(materials_list));
    o.value(
        "stats",
        &json!({"voxels": n, "locked": locked, "procedural": procedural, "placeholders": placeholders, "entities": codec::entity_count(&decoded.entity_blob)}),
    );
    o.key("palette").push_str(materials::palette_json());
    o.end();
    Ok(Inspected { name: name.to_string(), count: n, json: out })
}

#[derive(Default, Clone, Copy)]
struct Change {
    material: Option<(u16, u8)>,
    rgb: Option<u32>,
}

struct Add {
    cell: Cell,
    rgb: u32,
    t: u16,
    w: u8,
}

/// `_material_of`: both of `type` and `w`, or the edit is refused.
fn material_of(entry: &Py) -> Result<(u16, u8)> {
    const MSG: &str = "A material edit needs both a type and a w.";
    let t = int_or(entry.get("type").ok_or_else(|| Error::editor(MSG))?, MSG)?;
    let w = int_or(entry.get("w").ok_or_else(|| Error::editor(MSG))?, MSG)?;
    materials::validate_material(t, w).map_err(Error::editor)
}

/// `_colour_of`. A missing `rgb` is a KeyError Python doesn't catch.
fn colour_of(entry: &Py) -> Result<u32> {
    const MSG: &str = "An edit has an invalid colour.";
    let packed = int_or(entry.get("rgb").ok_or_else(|| Error::internal("KeyError: 'rgb'"))?, MSG)?;
    if !(0..=0xFF_FFFF).contains(&packed) {
        return Err(Error::editor(MSG));
    }
    Ok(packed as u32)
}

type Edits = (FxMap<usize, Change>, HashSet<usize, FxBuild>, Vec<Add>);

/// `_coerce_edits`.
fn coerce_edits(edits: &Py, total: usize) -> Result<Edits> {
    let Py::List(entries) = edits else { return Err(Error::editor("The edit list wasn't understood.")) };
    if entries.len() > total + MAX_ADDED_VOXELS {
        return Err(Error::editor("That's more edits than one save should carry."));
    }
    let mut changes: FxMap<usize, Change> = fx_map(entries.len());
    let mut deletes: HashSet<usize, FxBuild> = HashSet::with_hasher(FxBuild::default());
    let mut adds = Vec::new();
    for entry in entries {
        if !matches!(entry, Py::Dict(_)) {
            return Err(Error::editor("The edit list wasn't understood."));
        }
        if let Some(coords) = entry.get("add") {
            let coords = match coords {
                Py::List(c) if c.len() == 3 => c,
                _ => return Err(Error::editor("A new voxel needs an x, y and z.")),
            };
            let mut xyz = [0i128; 3];
            for (slot, c) in xyz.iter_mut().zip(coords) {
                *slot = int_or(c, "A new voxel has invalid coordinates.")?;
            }
            if xyz.iter().any(|c| !(-COORD_LIMIT..=COORD_LIMIT).contains(c)) {
                return Err(Error::editor("A new voxel is outside the buildable area."));
            }
            let (t, w) = material_of(entry)?;
            let rgb = colour_of(entry)?;
            adds.push(Add { cell: (xyz[0] as i64, xyz[1] as i64, xyz[2] as i64), rgb, t, w });
            if adds.len() > MAX_ADDED_VOXELS {
                return Err(Error::editor(format!("That's more than {} new voxels in one save.", py::thousands(MAX_ADDED_VOXELS as i64))));
            }
            continue;
        }
        const MISSING: &str = "An edit is missing its voxel index.";
        let idx = int_or(entry.get("i").ok_or_else(|| Error::editor(MISSING))?, MISSING)?;
        if !(0..total as i128).contains(&idx) {
            return Err(Error::editor("An edit points outside the blueprint."));
        }
        let idx = idx as usize;
        if entry.get("del").is_some_and(Py::truthy) {
            deletes.insert(idx);
            continue;
        }
        let mut change = Change::default();
        if entry.contains("type") || entry.contains("w") {
            change.material = Some(material_of(entry)?);
        }
        if entry.contains("rgb") {
            change.rgb = Some(colour_of(entry)?);
        }
        if change.material.is_some() || change.rgb.is_some() {
            let slot = changes.entry(idx).or_default();
            slot.material = change.material.or(slot.material);
            slot.rgb = change.rgb.or(slot.rgb);
        }
    }
    Ok((changes, deletes, adds))
}

/// `(size, pos, offset, entity_blob)`.
type Frame = ([i64; 3], [i64; 3], [i64; 3], Vec<u8>);

/// `_reframe`: fit the box around voxels that may now sit outside it, keeping the
/// attachment point and the placed decos where they were relative to the model.
fn reframe(voxels: &mut [Voxel], decoded: &Decoded) -> Result<Frame> {
    let min = |f: fn(&Voxel) -> i64| voxels.iter().map(f).min().unwrap().min(0);
    let max = |f: fn(&Voxel) -> i64| voxels.iter().map(f).max().unwrap();
    let mn = [min(|v| v.x), min(|v| v.y), min(|v| v.z)];
    let [sx, sy, sz] = decoded.size;
    let size = [sx.max(max(|v| v.x) + 1) - mn[0], sy.max(max(|v| v.y) + 1) - mn[1], sz.max(max(|v| v.z) + 1) - mn[2]];
    let shift = [-mn[0], -mn[1], -mn[2]];
    let mut entity_blob = decoded.entity_blob.clone();
    let mut attach = codec::attachment_point(decoded);
    if shift != [0, 0, 0] {
        for v in voxels.iter_mut() {
            v.x += shift[0];
            v.y += shift[1];
            v.z += shift[2];
        }
        attach = attach.map(|a| [a[0] + shift[0], a[1] + shift[1], a[2] + shift[2]]);
        entity_blob = bp_transform::translate_entities(&entity_blob, shift)?;
    }
    let half = |v: i64| -v.div_euclid(2);
    let pos = match attach {
        Some([x, y, z]) => [-x, -y, -z],
        None if decoded.version == 5 => [half(size[0]), decoded.pos[1], half(size[2])],
        None => [half(size[0]), half(size[1]), half(size[2])],
    };
    let offset = if matches!(decoded.version, 3 | 4) { [half(size[0]), half(size[1]), half(size[2])] } else { decoded.offset };
    Ok((size, pos, offset, entity_blob))
}

pub type Summary = Map<String, Value>;

fn summary_of(v: Value) -> Summary {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// `apply_edits(raw, edits)`.
pub fn apply_edits(raw: &[u8], edits: &Py) -> Result<(Vec<u8>, Summary)> {
    let decoded = decode_or_raise(raw)?;
    let (changes, deletes, adds) = coerce_edits(edits, decoded.voxels.len())?;
    let mut out: Vec<Voxel> = Vec::with_capacity(decoded.voxels.len() + adds.len());
    let (mut recoloured, mut rematerialised, mut ignored) = (0, 0, 0);
    for (i, v) in decoded.voxels.iter().enumerate() {
        if deletes.contains(&i) {
            continue;
        }
        let Some(change) = changes.get(&i) else {
            out.push(*v);
            continue;
        };
        let mut nv = *v;
        if let Some((t, w)) = change.material {
            // Refused on the ORIGINAL type: placeholders and terrain keep what they had.
            if !materials::is_editable(v.t) {
                ignored += 1;
            } else {
                nv.t = t;
                nv.w = w;
                rematerialised += 1;
            }
        }
        if let Some(packed) = change.rgb {
            if materials::is_procedural(v.t, v.r, v.g, v.b) {
                ignored += 1;
            } else {
                nv.r = (packed >> 16) as u8;
                nv.g = (packed >> 8) as u8;
                nv.b = packed as u8;
                recoloured += 1;
            }
        }
        out.push(nv);
    }
    if !adds.is_empty() {
        let mut occupied: FxMap<Cell, usize> = fx_map(out.len() + adds.len());
        for (i, v) in out.iter().enumerate() {
            occupied.insert((v.x, v.y, v.z), i);
        }
        for a in &adds {
            let nv = Voxel { x: a.cell.0, y: a.cell.1, z: a.cell.2, r: (a.rgb >> 16) as u8, g: (a.rgb >> 8) as u8, b: a.rgb as u8, w: a.w, t: a.t };
            match occupied.get(&a.cell) {
                Some(&i) => out[i] = nv,
                None => {
                    occupied.insert(a.cell, out.len());
                    out.push(nv);
                }
            }
        }
    }
    if out.is_empty() {
        return Err(Error::editor("That would erase the whole model - a blueprint needs at least one voxel."));
    }
    if out.len() > EDITOR_VOXEL_CAP {
        return Err(Error::editor(format!("That would take the model past the editor's {} voxel limit.", py::thousands(EDITOR_VOXEL_CAP as i64))));
    }
    let (size, pos, offset, entity_blob) = if !adds.is_empty() || !deletes.is_empty() {
        reframe(&mut out, &decoded)?
    } else {
        (decoded.size, decoded.pos, decoded.offset, decoded.entity_blob.clone())
    };
    let data = codec::encode(&out, decoded.version, Some(pos), &entity_blob, offset, Some(size)).map_err(|e| e.into_editor(&[Kind::Blueprint, Kind::Transform]))?;
    let summary = json!({
        "voxels": out.len(),
        "recoloured": recoloured,
        "rematerialised": rematerialised,
        "added": adds.len(),
        "erased": deletes.len(),
        "size": size,
        "ignored": ignored,
        "version": decoded.version,
        "bytes": data.len(),
    });
    Ok((data, summary_of(summary)))
}

/// `_layer_specs`: each layer's `(mode, offset, edits)`.
fn layer_specs(specs: &Py, count: usize) -> Result<Vec<(String, [i64; 3], Py)>> {
    let specs = match specs {
        Py::List(v) if v.len() == count => v,
        _ => return Err(Error::editor("The layer list didn't match the files that arrived.")),
    };
    if count > MAX_LAYERS {
        return Err(Error::editor(format!("That's more than {MAX_LAYERS} layers in one stack.")));
    }
    const BAD_OFFSET: &str = "A layer has an invalid offset.";
    let mut out = Vec::with_capacity(count);
    for spec in specs {
        if !matches!(spec, Py::Dict(_)) {
            return Err(Error::editor("A layer's placement wasn't understood."));
        }
        let mode = spec.get("mode").filter(|m| m.truthy()).map(Py::str).unwrap_or_else(|| "attachment".into());
        let off: Vec<i128> = match spec.get("offset").filter(|o| o.truthy()) {
            None => vec![0, 0, 0],
            Some(o) => o.iter().ok_or_else(|| Error::editor(BAD_OFFSET))?.iter().map(|v| int_or(v, BAD_OFFSET)).collect::<Result<_>>()?,
        };
        if off.len() != 3 || off.iter().any(|v| !(-COORD_LIMIT..=COORD_LIMIT).contains(v)) {
            return Err(Error::editor(BAD_OFFSET));
        }
        let edits = spec.get("edits").filter(|e| e.truthy()).cloned().unwrap_or(Py::List(Vec::new()));
        out.push((mode, [off[0] as i64, off[1] as i64, off[2] as i64], edits));
    }
    Ok(out)
}

/// `{**a, **b}`.
fn merged(mut a: Summary, b: Summary) -> Summary {
    for (k, v) in b {
        a.insert(k, v);
    }
    a
}

/// `composite`: the model as it would be output, edits applied then the stack flattened.
pub fn composite(raw: &[u8], edits: &Py, layers: &[&[u8]], specs: &Py, anchor_at: i128) -> Result<(Vec<u8>, Summary)> {
    let (edited, mut summary) = apply_edits(raw, edits)?;
    if layers.is_empty() {
        summary.insert("layers".into(), json!(0));
        return Ok((edited, summary));
    }
    let placements = layer_specs(specs, layers.len())?;
    if !(0..=layers.len() as i128).contains(&anchor_at) {
        return Err(Error::editor("The anchor layer isn't in the stack."));
    }
    let anchor = anchor_at as usize;
    let caught = [Kind::Merge, Kind::Blueprint];
    let mut stack = Vec::with_capacity(layers.len() + 1);
    for (data, (mode, off, layer_edits)) in layers.iter().zip(placements) {
        let painted = if layer_edits.truthy() { apply_edits(data, &layer_edits)?.0 } else { data.to_vec() };
        stack.push((decode_or_raise(&painted)?, mode, off));
    }
    stack.insert(anchor, (codec::decode_full(&edited).map_err(|e| e.into_editor(&caught))?, "corner".to_string(), [0, 0, 0]));
    let (flat, msum) = merge::flatten(&stack, anchor).map_err(|e| e.into_editor(&caught))?;
    let data = codec::encode_decoded(&flat).map_err(|e| e.into_editor(&caught))?;
    Ok((data, merged(summary, msum)))
}

/// `transform(raw, edits, ops)`: bake the edits, then turn or mirror the result.
pub fn transform(raw: &[u8], edits: &Py, ops: &Py) -> Result<(Vec<u8>, Value)> {
    let (edited, _) = composite(raw, edits, &[], &Py::List(Vec::new()), 0)?;
    let decoded = codec::decode_full(&edited)?;
    let caught = [Kind::Transform, Kind::Blueprint];
    let moved = bp_transform::apply(&decoded, ops).map_err(|e| e.into_editor(&caught))?;
    let data = codec::encode_decoded(&moved).map_err(|e| e.into_editor(&caught))?;
    let applied: Vec<Value> = match ops {
        Py::List(v) => v.iter().map(|o| o.to_value().unwrap_or(Value::Null)).collect(),
        _ => Vec::new(),
    };
    Ok((
        data,
        json!({
            "applied": applied,
            "size_before": decoded.size,
            "size_after": moved.size,
            "attachment": codec::attachment_point(&moved),
            "entities": codec::entity_count(&moved.entity_blob),
        }),
    ))
}

/// `export_qb`: the edited model's four authoring `.qb` files, zipped, and the notes.
pub fn export_qb(raw: &[u8], edits: &Py, layers: &[&[u8]], specs: &Py, anchor_at: i128, stem: &str) -> Result<(Vec<u8>, Vec<String>)> {
    let (edited, _) = composite(raw, edits, layers, specs, anchor_at)?;
    let caught = [Kind::Qb, Kind::Blueprint];
    let decoded = codec::decode_full(&edited).map_err(|e| e.into_editor(&caught))?;
    let built = qb::from_blueprint(&decoded, stem).map_err(|e| e.into_editor(&caught))?;
    Ok((workshop::to_zip(&built.files), built.notes))
}

/// `import_qb(files)`.
pub fn import_qb(files: &[(String, Vec<u8>)]) -> Result<(Vec<u8>, Value)> {
    if files.iter().map(|f| f.1.len()).sum::<usize>() > MAX_QB_BYTES {
        return Err(Error::editor("Those .qb files are too large to compile."));
    }
    qb::to_blueprint(files).map_err(|e| e.into_editor(&[Kind::Qb, Kind::Blueprint]))
}

/// `check`: the Trove Creations checks against the model as it would be saved.
pub fn check(raw: &[u8], edits: &Py, kind: &str, layers: &[&[u8]], specs: &Py, anchor_at: i128) -> Result<Value> {
    let (edited, _) = composite(raw, edits, layers, specs, anchor_at)?;
    Ok(lint::check(&codec::decode_full(&edited)?, kind))
}
