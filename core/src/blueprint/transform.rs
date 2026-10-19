//! utils/kiwi_blueprint/transform.py: quarter turns and mirrors, which have to carry the
//! bounding box, the attachment point and the placed decos along with the voxels.

use super::codec::{self, Decoded};
use super::py::Py;
use super::util::{Error, Kind, Result};

pub const OPERATIONS: [(&str, &str); 6] = [
    ("rotate_x", "Rotate on X"),
    ("rotate_y", "Rotate on Y"),
    ("rotate_z", "Rotate on Z"),
    ("mirror_x", "Flip left-right"),
    ("mirror_y", "Flip upside-down"),
    ("mirror_z", "Flip front-back"),
];

const MAX_MOVE: i128 = 512;

fn err(msg: impl Into<String>) -> Error {
    Error::value(Kind::Transform, msg)
}

type Point = (i64, i64, i64);

/// `_mapper`: the point function (total, so it also moves an attachment point outside
/// the box) and the new size.
fn mapper(op: &str, size: [i64; 3]) -> (impl Fn(i64, i64, i64) -> Point, [i64; 3]) {
    let [sx, sy, sz] = size;
    let which = OPERATIONS.iter().position(|o| o.0 == op).unwrap_or(5);
    let f = move |x: i64, y: i64, z: i64| match which {
        0 => (x, z, (sy - 1) - y),
        1 => (z, y, (sx - 1) - x),
        2 => (y, (sx - 1) - x, z),
        3 => ((sx - 1) - x, y, z),
        4 => (x, (sy - 1) - y, z),
        _ => (x, y, (sz - 1) - z),
    };
    let new = match which {
        0 => [sx, sz, sy],
        1 => [sz, sy, sx],
        2 => [sy, sx, sz],
        _ => size,
    };
    (f, new)
}

/// `_rewrite_entities`: every placed object moved by `point`, sub-messages verbatim.
fn rewrite_entities(blob: &[u8], point: impl Fn(i64, i64, i64) -> Point) -> Result<Vec<u8>> {
    if blob.len() < 4 {
        return Ok(blob.to_vec());
    }
    let (records, tail) = codec::read_entity_records(blob)
        .ok_or_else(|| err("This model has placed objects whose data can't be read, so it can't be moved without leaving them behind."))?;
    if records.is_empty() {
        return Ok(blob.to_vec());
    }
    let moved: Vec<_> = records
        .into_iter()
        .map(|(x, y, z, sub)| {
            let (x, y, z) = point(x, y, z);
            (x, y, z, sub)
        })
        .collect();
    Ok(codec::write_entity_records(&moved, &tail))
}

/// `translate_entities`.
pub fn translate_entities(blob: &[u8], shift: [i64; 3]) -> Result<Vec<u8>> {
    if shift == [0, 0, 0] {
        return Ok(blob.to_vec());
    }
    rewrite_entities(blob, |x, y, z| (x + shift[0], y + shift[1], z + shift[2]))
}

/// `move_on_rig`: slide the model along the bone that holds it, i.e. move its origin.
pub fn move_on_rig(mut decoded: Decoded, delta: [i128; 3]) -> Result<Decoded> {
    if delta.iter().any(|d| !(-MAX_MOVE..=MAX_MOVE).contains(d)) {
        return Err(err("That's further than a part can be moved on its rig."));
    }
    // v5 keeps the origin in its header; v3/v4 write their coordinates around the min corner.
    let frame = if decoded.version == 5 { &mut decoded.pos } else { &mut decoded.offset };
    for (c, d) in frame.iter_mut().zip(delta) {
        *c += d as i64;
    }
    Ok(decoded)
}

/// `apply(decoded, ops)`.
pub fn apply(decoded: &Decoded, ops: &Py) -> Result<Decoded> {
    let ops = match ops {
        Py::List(v) if !v.is_empty() => v,
        _ => return Err(err("No transform was given.")),
    };
    if ops.len() > 16 {
        return Err(err("That's more transforms than one step should carry."));
    }
    let mut voxels = decoded.voxels.clone();
    let mut size = decoded.size;
    let mut attach = codec::attachment_point(decoded);
    let mut entity_blob = decoded.entity_blob.clone();
    for op in ops {
        let name = match op {
            Py::Str(s) if OPERATIONS.iter().any(|o| o.0 == s) => s.as_str(),
            other => return Err(err(format!("Unknown transform: {}.", other.str()))),
        };
        let (point, new_size) = mapper(name, size);
        size = new_size;
        for v in &mut voxels {
            (v.x, v.y, v.z) = point(v.x, v.y, v.z);
        }
        if let Some([x, y, z]) = attach {
            let (x, y, z) = point(x, y, z);
            attach = Some([x, y, z]);
        }
        entity_blob = rewrite_entities(&entity_blob, &point)?;
    }
    let half = |v: i64| -v.div_euclid(2);
    let pos = match attach {
        Some([x, y, z]) => [-x, -y, -z],
        None if decoded.version == 5 => [half(size[0]), decoded.pos[1], half(size[2])],
        None => [half(size[0]), half(size[1]), half(size[2])],
    };
    let offset = if matches!(decoded.version, 3 | 4) { [half(size[0]), half(size[1]), half(size[2])] } else { decoded.offset };
    Ok(Decoded { version: decoded.version, size, pos, voxels, entity_blob, offset })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_follow_the_axes() {
        for (op, want) in [("rotate_x", [2, 4, 3]), ("rotate_y", [4, 3, 2]), ("rotate_z", [3, 2, 4]), ("mirror_x", [2, 3, 4]), ("mirror_y", [2, 3, 4]), ("mirror_z", [2, 3, 4])] {
            assert_eq!(mapper(op, [2, 3, 4]).1, want, "{op}");
        }
    }
}
