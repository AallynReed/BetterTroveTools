//! utils/kiwi_blueprint/merge.py: flatten a stack of blueprints into one. The topmost
//! layer with a voxel at a cell wins it; the anchor layer defines the frame.

use serde_json::{json, Map, Value};

use super::codec::{self, Decoded, Voxel};
use super::py;
use super::util::{Cell, Error, Kind, OrderedMap, Result};

pub const ALIGN_MODES: [(&str, &str); 3] = [
    ("attachment", "Line up the attachment points"),
    ("centre", "Line up the centres"),
    ("corner", "Line up the corners"),
];

const MAX_MERGED_VOXELS: usize = 150_000;

fn err(msg: impl Into<String>) -> Error {
    Error::value(Kind::Merge, msg)
}

/// `align_offset`: where the incoming model's (0,0,0) lands in the base grid.
fn align_offset(base: &Decoded, over: &Decoded, mode: &str) -> Result<[i64; 3]> {
    match mode {
        "corner" => Ok([0, 0, 0]),
        "centre" => Ok(std::array::from_fn(|i| py::round((base.size[i] - 1) as f64 / 2.0 - (over.size[i] - 1) as f64 / 2.0))),
        _ => match (codec::attachment_point(base), codec::attachment_point(over)) {
            (Some(a), Some(b)) => Ok([a[0] - b[0], a[1] - b[1], a[2] - b[2]]),
            _ => Err(err(
                "Lining up the attachment points needs both models to have one, and at least one of these doesn't (older v3/v4 blueprints don't store one). Line up the centres or the corners instead.",
            )),
        },
    }
}

/// `flatten(docs, anchor)`: `docs` is `(decoded, mode, offset)` bottom to top.
pub fn flatten(docs: &[(Decoded, String, [i64; 3])], anchor: usize) -> Result<(Decoded, Map<String, Value>)> {
    if docs.is_empty() {
        return Err(err("There's nothing to flatten."));
    }
    if anchor >= docs.len() {
        return Err(err("The anchor layer isn't in the stack."));
    }
    let base = &docs[anchor].0;
    if base.voxels.is_empty() {
        return Err(err("The anchor blueprint needs at least one voxel."));
    }
    let total: usize = docs.iter().map(|d| d.0.voxels.len()).sum();
    if total > MAX_MERGED_VOXELS {
        return Err(err(format!("Together those are more than {} voxels, past what the editor can hold.", py::thousands(MAX_MERGED_VOXELS as i64))));
    }

    let mut placements = Vec::with_capacity(docs.len());
    let mut cells: OrderedMap<Cell, Voxel> = OrderedMap::with_capacity(total);
    let mut hidden = 0;
    for (i, (decoded, mode, offset)) in docs.iter().enumerate() {
        if decoded.voxels.is_empty() {
            return Err(err("A layer has no voxels."));
        }
        let t = if i == anchor {
            [0, 0, 0]
        } else {
            if !ALIGN_MODES.iter().any(|m| m.0 == mode) {
                return Err(err(format!("Unknown alignment: {mode}.")));
            }
            let a = align_offset(base, decoded, mode)?;
            [a[0] + offset[0], a[1] + offset[1], a[2] + offset[2]]
        };
        placements.push(t);
        for v in &decoded.voxels {
            let key = (v.x + t[0], v.y + t[1], v.z + t[2]);
            if cells.insert(key, Voxel { x: key.0, y: key.1, z: key.2, ..*v }) {
                hidden += 1;
            }
        }
    }
    let mn = [
        cells.iter().map(|c| c.0 .0).min().unwrap().min(0),
        cells.iter().map(|c| c.0 .1).min().unwrap().min(0),
        cells.iter().map(|c| c.0 .2).min().unwrap().min(0),
    ];
    let shift = [-mn[0], -mn[1], -mn[2]];
    let mut voxels: Vec<Voxel> = cells.items.into_iter().map(|(_, v)| Voxel { x: v.x + shift[0], y: v.y + shift[1], z: v.z + shift[2], ..v }).collect();
    voxels.sort_by_key(|v| (v.y, v.z, v.x));
    let size = [
        (voxels.iter().map(|v| v.x).max().unwrap() + 1).max(base.size[0] + shift[0]),
        (voxels.iter().map(|v| v.y).max().unwrap() + 1).max(base.size[1] + shift[1]),
        (voxels.iter().map(|v| v.z).max().unwrap() + 1).max(base.size[2] + shift[2]),
    ];
    let (entity_blob, note) = merge_entities(anchor, docs, &placements, shift);

    let attach = codec::attachment_point(base).map(|a| [a[0] + shift[0], a[1] + shift[1], a[2] + shift[2]]);
    let half = |v: i64| -v.div_euclid(2);
    let pos = match attach {
        Some([x, y, z]) => [-x, -y, -z],
        None if base.version == 5 => [half(size[0]), base.pos[1], half(size[2])],
        None => [half(size[0]), half(size[1]), half(size[2])],
    };
    let offset = if matches!(base.version, 3 | 4) { [half(size[0]), half(size[1]), half(size[2])] } else { base.offset };
    let count = voxels.len();
    let merged = Decoded { version: base.version, size, pos, voxels, entity_blob, offset };
    let summary = json!({
        "voxels": count,
        "from_base": base.voxels.len(),
        "from_layers": total - base.voxels.len(),
        "layers": docs.len() - 1,
        "anchor": anchor,
        "hidden": hidden,
        "placed_at": placements,
        "size": size,
        "attachment": attach,
        "entities": note,
    });
    let Value::Object(summary) = summary else { unreachable!() };
    Ok((merged, summary))
}

/// `_merge_entities`: every layer's placed objects, moved into the flattened grid.
fn merge_entities(anchor: usize, docs: &[(Decoded, String, [i64; 3])], placements: &[[i64; 3]], shift: [i64; 3]) -> (Vec<u8>, String) {
    let anchor_blob = &docs[anchor].0.entity_blob;
    let reads: Option<Vec<_>> = docs.iter().map(|d| codec::read_entity_records(&d.0.entity_blob)).collect();
    let Some(reads) = reads else {
        return (anchor_blob.clone(), "the placed objects couldn't be read on one of the models, so only the anchor's were kept".into());
    };
    let tail = &reads[anchor].1;
    let mut out = Vec::new();
    let mut carried = 0;
    for (i, ((recs, _), t)) in reads.iter().zip(placements).enumerate() {
        if i != anchor {
            carried += recs.len();
        }
        out.extend(recs.iter().map(|(x, y, z, sub)| (x + t[0] + shift[0], y + t[1] + shift[1], z + t[2] + shift[2], sub.clone())));
    }
    if out.is_empty() {
        return (anchor_blob.clone(), String::new());
    }
    let note = if carried > 0 { format!("{carried} placed object{} came across too", if carried != 1 { "s" } else { "" }) } else { String::new() };
    (codec::write_entity_records(&out, tail), note)
}
