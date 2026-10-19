//! utils/kiwi_blueprint/qb.py: Qubicle Binary with Trove's material maps (`_a`, `_s`,
//! `_t`), both ways. The X mirror between the blueprint and Qubicle frames lives here.

use serde_json::{json, Value};

use super::codec::{self, Decoded, Voxel};
use super::materials::{self, Class};
use crate::py;
use super::util::{Cell, Error, Kind, OrderedMap, Result};

const QB_VERSION: u32 = 257;
const CODEFLAG: u32 = 2;
const NEXTSLICEFLAG: u32 = 6;
const MAGENTA: [u8; 3] = [255, 0, 255];
const WHITE: [u8; 3] = [255, 255, 255];
const MAX_MAPPED_SPECULAR: u8 = 4;
const VALID_ALPHA: [u8; 9] = [16, 48, 80, 112, 144, 176, 208, 240, 255];
/// A matrix past this many cells is a .qb Python would choke on too.
const MAX_CELLS: usize = 64_000_000;

const TYPES: [(u16, [u8; 3]); 5] = [(21, [255, 255, 255]), (18, [128, 128, 128]), (54, [64, 64, 64]), (55, [255, 0, 0]), (56, [255, 255, 0])];
const SPECULAR: [[u8; 3]; 5] = [[128, 0, 0], [0, 128, 0], [0, 0, 128], [128, 128, 0], [128, 0, 128]];

/// `TYPE_TO_INDEX`.
pub fn type_index(t: u16) -> Option<usize> {
    TYPES.iter().position(|e| e.0 == t)
}

/// `TYPE_MAP_RGB[index]`.
pub fn type_rgb(index: usize) -> (u8, u8, u8) {
    let c = TYPES[index].1;
    (c[0], c[1], c[2])
}

/// `SPECULAR_MAP_RGB.get(w)`.
pub fn specular_rgb(w: i64) -> Option<(u8, u8, u8)> {
    usize::try_from(w).ok().and_then(|w| SPECULAR.get(w)).map(|c| (c[0], c[1], c[2]))
}

fn err(msg: impl Into<String>) -> Error {
    Error::value(Kind::Qb, msg)
}

fn truncated() -> Error {
    err("That .qb is truncated.")
}

pub struct Matrix {
    pub size: [i64; 3],
    pub pos: [i64; 3],
    pub cells: OrderedMap<Cell, [u8; 3]>,
}

fn u32_at(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(d[at..at + 4].try_into().unwrap())
}

/// `read_qb`: both body encodings and both colour orders.
pub fn read_qb(data: &[u8]) -> Result<Vec<Matrix>> {
    if data.len() < 24 {
        return Err(err("That file is too short to be a .qb."));
    }
    let head: Vec<u32> = (0..6).map(|i| u32_at(data, i * 4)).collect();
    let (colour_format, z_orientation, compression, count) = (head[1], head[2], head[3], head[5]);
    if count == 0 || count > 512 {
        return Err(err("That .qb declares an implausible number of matrices."));
    }
    let mut out = Vec::new();
    let mut off = 24usize;
    for _ in 0..count {
        if off >= data.len() {
            return Err(truncated());
        }
        off += 1 + data[off] as usize;
        // struct.unpack_from on a short buffer: struct.error, uncaught.
        let fields = data.get(off..off + 24).ok_or_else(|| Error::internal("unpack_from requires a buffer of at least 24 bytes"))?;
        let size = [u32_at(fields, 0) as i64, u32_at(fields, 4) as i64, u32_at(fields, 8) as i64];
        let pos: [i64; 3] = std::array::from_fn(|i| i32::from_le_bytes(fields[12 + i * 4..16 + i * 4].try_into().unwrap()) as i64);
        off += 24;
        let [sx, sy, sz] = size;
        if (sx as i128) * (sy as i128) * (sz as i128) > MAX_CELLS as i128 {
            return Err(err("That .qb declares an implausibly large matrix."));
        }
        let mut cells = OrderedMap::with_capacity(1024);
        if compression == 0 {
            let need = (4 * sx * sy * sz) as usize;
            if off + need > data.len() {
                return Err(truncated());
            }
            for z in 0..sz {
                for y in 0..sy {
                    let base = off + 4 * (z * sy * sx + y * sx) as usize;
                    for x in 0..sx {
                        let i = base + 4 * x as usize;
                        if data[i + 3] > 0 {
                            cells.insert((x, y, z), [data[i], data[i + 1], data[i + 2]]);
                        }
                    }
                }
            }
            off += need;
        } else {
            off = read_rle(data, off, size, &mut cells)?;
        }
        if colour_format == 1 {
            for item in cells.items.iter_mut() {
                item.1.swap(0, 2);
            }
        }
        if z_orientation == 0 {
            let mut flipped = OrderedMap::with_capacity(cells.len());
            for &((x, y, z), v) in cells.iter() {
                flipped.insert((x, y, sz - 1 - z), v);
            }
            cells = flipped;
        }
        out.push(Matrix { size, pos, cells });
    }
    Ok(out)
}

fn read_rle(data: &[u8], mut off: usize, size: [i64; 3], cells: &mut OrderedMap<Cell, [u8; 3]>) -> Result<usize> {
    let [sx, _, sz] = size;
    let put = |index: i64, z: i64, rgb: [u8; 3], cells: &mut OrderedMap<Cell, [u8; 3]>| -> Result<()> {
        if sx == 0 {
            return Err(Error::internal("integer modulo by zero"));
        }
        cells.insert((index % sx, index / sx, z), rgb);
        if cells.len() > MAX_CELLS {
            return Err(Error::internal("MemoryError"));
        }
        Ok(())
    };
    for z in 0..sz {
        let mut index: i64 = 0;
        loop {
            if off + 4 > data.len() {
                return Err(truncated());
            }
            let chunk = u32_at(data, off);
            off += 4;
            if chunk == NEXTSLICEFLAG {
                break;
            }
            if chunk == CODEFLAG {
                if off + 8 > data.len() {
                    return Err(truncated());
                }
                let run = u32_at(data, off) as i64;
                let (rgb, a) = ([data[off + 4], data[off + 5], data[off + 6]], data[off + 7]);
                off += 8;
                if a > 0 {
                    for _ in 0..run {
                        put(index, z, rgb, cells)?;
                        index += 1;
                    }
                } else {
                    index += run;
                }
            } else {
                let b = chunk.to_le_bytes();
                if b[3] > 0 {
                    put(index, z, [b[0], b[1], b[2]], cells)?;
                }
                index += 1;
            }
        }
    }
    Ok(off)
}

/// `(cells, size, first matrix's pos)`.
type Grid = (OrderedMap<Cell, [u8; 3]>, [i64; 3], [i64; 3]);

/// `_merge`: every matrix flattened into one grid.
fn merge(mut matrices: Vec<Matrix>) -> Result<Grid> {
    if matrices.len() == 1 {
        let m = matrices.pop().unwrap();
        return Ok((m.cells, m.size, m.pos));
    }
    let mn: [i64; 3] = std::array::from_fn(|i| matrices.iter().map(|m| m.pos[i]).min().unwrap());
    let mut cells = OrderedMap::with_capacity(matrices.iter().map(|m| m.cells.len()).sum());
    for m in &matrices {
        let o: [i64; 3] = std::array::from_fn(|i| m.pos[i] - mn[i]);
        for &((x, y, z), v) in m.cells.iter() {
            cells.insert((x + o[0], y + o[1], z + o[2]), v);
        }
    }
    if cells.is_empty() {
        return Err(Error::internal("max() iterable argument is empty"));
    }
    let size: [i64; 3] = [
        cells.iter().map(|c| c.0 .0).max().unwrap() + 1,
        cells.iter().map(|c| c.0 .1).max().unwrap() + 1,
        cells.iter().map(|c| c.0 .2).max().unwrap() + 1,
    ];
    Ok((cells, size, matrices[0].pos))
}

/// `write_qb`: one RLE matrix. Runs are found over the occupied cells in scan order
/// rather than by visiting every cell of the box, with the same result.
pub fn write_qb(cells: &[(Cell, [u8; 3])], size: [i64; 3], name: &str, pos: [i64; 3]) -> Result<Vec<u8>> {
    let [sx, sy, sz] = size;
    let mut out = Vec::new();
    for v in [QB_VERSION, 0, 1, 1, 0, 1] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    let stem: Vec<u8> = name.chars().map(|c| if (c as u32) < 256 { c as u32 as u8 } else { b'?' }).take(255).collect();
    out.push(stem.len() as u8);
    out.extend_from_slice(&stem);
    for v in size {
        let v = u32::try_from(v).map_err(|_| Error::internal("argument out of range"))?;
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in pos {
        let v = i32::try_from(v).map_err(|_| Error::internal("argument out of range"))?;
        out.extend_from_slice(&v.to_le_bytes());
    }

    let mut inside: Vec<(i64, i64, [u8; 3])> =
        cells.iter().filter(|((x, y, z), _)| (0..sx).contains(x) && (0..sy).contains(y) && (0..sz).contains(z)).map(|&((x, y, z), v)| (z, y * sx + x, v)).collect();
    inside.sort_unstable_by_key(|c| (c.0, c.1));
    let plane = sx * sy;
    let mut next = 0;
    for z in 0..sz {
        let mut run = Run { out: &mut out, val: None, len: 0 };
        let mut at = 0;
        while next < inside.len() && inside[next].0 == z {
            let (_, p, v) = inside[next];
            run.push(None, p - at)?;
            run.push(Some(v), 1)?;
            at = p + 1;
            next += 1;
        }
        run.push(None, plane - at)?;
        run.flush()?;
        out.extend_from_slice(&NEXTSLICEFLAG.to_le_bytes());
    }
    Ok(out)
}

/// A run of equal cells in scan order, written when a different one starts.
struct Run<'a> {
    out: &'a mut Vec<u8>,
    val: Option<[u8; 3]>,
    len: i64,
}

impl Run<'_> {
    fn push(&mut self, val: Option<[u8; 3]>, len: i64) -> Result<()> {
        if len == 0 {
            return Ok(());
        }
        if val == self.val {
            self.len += len;
        } else {
            self.flush()?;
            (self.val, self.len) = (val, len);
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        if self.len == 0 {
            return Ok(());
        }
        if self.len > 1 {
            let len = u32::try_from(self.len).map_err(|_| Error::internal("argument out of range"))?;
            self.out.extend_from_slice(&CODEFLAG.to_le_bytes());
            self.out.extend_from_slice(&len.to_le_bytes());
        }
        match self.val {
            Some(c) => self.out.extend_from_slice(&[c[0], c[1], c[2], 255]),
            None => self.out.extend_from_slice(&[0, 0, 0, 0]),
        }
        self.len = 0;
        Ok(())
    }
}

/// `from_blueprint`'s answer.
pub struct Export {
    pub files: Vec<(String, Vec<u8>)>,
    pub notes: Vec<String>,
}

fn plural(n: usize) -> &'static str {
    if n != 1 {
        "s"
    } else {
        ""
    }
}

/// `from_blueprint`: the four authoring `.qb` files for a decoded blueprint.
pub fn from_blueprint(decoded: &Decoded, stem: &str) -> Result<Export> {
    let attach = codec::attachment_point(decoded);
    let [mut sx, mut sy, mut sz] = decoded.size;
    let (mut mnx, mut mny, mut mnz) = (0, 0, 0);
    if let Some([ax, ay, az]) = attach {
        (mnx, mny, mnz) = (ax.min(0), ay.min(0), az.min(0));
        sx = sx.max(ax + 1) - mnx;
        sy = sy.max(ay + 1) - mny;
        sz = sz.max(az + 1) - mnz;
    }
    let qx = |x: i64| sx - 1 - (x - mnx);
    // One grid of [base, alpha, specular, type] colours: the four maps share every key.
    let mut grid: OrderedMap<Cell, [[u8; 3]; 4]> = OrderedMap::with_capacity(decoded.voxels.len());
    let mut dropped_spec = 0usize;
    let mut unmapped: Vec<(u16, usize)> = Vec::new();
    for v in &decoded.voxels {
        let key = (qx(v.x), v.y - mny, v.z - mnz);
        let mut rgb = [v.r, v.g, v.b];
        if materials::is_procedural(v.t, v.r, v.g, v.b) {
            let (r, g, b, ..) = materials::material_for(v.r, v.g, v.b, v.w, v.t);
            rgb = [r, g, b];
        }
        let index = type_index(v.t).unwrap_or_else(|| {
            match unmapped.iter_mut().find(|u| u.0 == v.t) {
                Some(u) => u.1 += 1,
                None => unmapped.push((v.t, 1)),
            }
            0
        });
        let (a, s) = if materials::material_class(v.t) == Class::Glass {
            let level = materials::alpha_for_w(v.w as i64) as u8;
            ([level; 3], SPECULAR[0])
        } else if v.w > MAX_MAPPED_SPECULAR {
            dropped_spec += 1;
            (WHITE, SPECULAR[0])
        } else {
            (WHITE, SPECULAR[v.w as usize])
        };
        grid.insert(key, [rgb, a, s, TYPES[index].1]);
    }
    let pos = match attach {
        Some([ax, ay, az]) => {
            let akey = (qx(ax), ay - mny, az - mnz);
            grid.insert(akey, [MAGENTA; 4]);
            [-akey.0, -akey.1, -akey.2]
        }
        None => [0, 0, 0],
    };
    let size = [sx, sy, sz];
    let mut files = Vec::with_capacity(4);
    for (i, suffix) in ["", "_a", "_s", "_t"].iter().enumerate() {
        let cells: Vec<(Cell, [u8; 3])> = grid.iter().map(|(k, v)| (*k, v[i])).collect();
        let name = format!("{stem}{suffix}");
        files.push((format!("{name}.qb"), write_qb(&cells, size, &name, pos)?));
    }

    let mut notes = Vec::new();
    if attach.is_some() {
        notes.push(format!("The attachment point is written as a magenta voxel at ({}, {}, {}) in all four files.", -pos[0], -pos[1], -pos[2]));
    } else if decoded.version != 5 {
        notes.push(format!(
            "This is a v{} blueprint, which stores no attachment point, so none was written. Add a magenta (255, 0, 255) voxel where the model should be held before compiling it back.",
            decoded.version
        ));
    }
    if dropped_spec > 0 {
        notes.push(format!(
            "{} solid voxel{} use a specular finish beyond the five the material maps can express, and were written as rough. Re-importing this .qb will not bring them back.",
            py::thousands(dropped_spec as i64),
            plural(dropped_spec)
        ));
    }
    if !unmapped.is_empty() {
        let total: usize = unmapped.iter().map(|u| u.1).sum();
        let mut types: Vec<u16> = unmapped.iter().map(|u| u.0).collect();
        types.sort_unstable();
        let names: Vec<String> = types.iter().take(3).map(|&t| materials::describe(t, 0)).collect();
        notes.push(format!(
            "{} voxel{} use materials the game keeps to itself ({}) and were written as plain solid. The .blueprint you exported from still has them.",
            py::thousands(total as i64),
            plural(total),
            names.join(", ")
        ));
    }
    Ok(Export { files, notes })
}

/// `_classify`: base / a / s / t by the name's suffix.
fn classify(files: &[(String, Vec<u8>)]) -> Result<[Option<&[u8]>; 4]> {
    let mut out: [Option<&[u8]>; 4] = [None; 4];
    for (name, data) in files {
        let stem = name.rsplit('/').next().unwrap_or("");
        let stem = if stem.to_lowercase().ends_with(".qb") { &stem[..stem.len() - 3] } else { stem };
        let low = stem.to_lowercase();
        let slot = if low.ends_with("_a") {
            1
        } else if low.ends_with("_s") {
            2
        } else if low.ends_with("_t") {
            3
        } else {
            0
        };
        if slot != 0 || out[0].is_none() {
            out[slot] = Some(data);
        }
    }
    if out[0].is_none() {
        return Err(err("No base .qb was found - the model file must not end in _a, _s or _t."));
    }
    Ok(out)
}

/// `to_blueprint`: compile a `.qb` and its maps into a v5 blueprint plus a summary.
pub fn to_blueprint(files: &[(String, Vec<u8>)]) -> Result<(Vec<u8>, Value)> {
    let parts = classify(files)?;
    let base_mats = read_qb(parts[0].unwrap())?;
    let single = base_mats.len() == 1;
    let (cells, size, base_pos) = merge(base_mats)?;
    if cells.is_empty() {
        return Err(err("That .qb has no visible voxels."));
    }
    let mut maps: [Option<OrderedMap<Cell, [u8; 3]>>; 3] = [None, None, None];
    for (i, key) in ["a", "s", "t"].iter().enumerate() {
        if let Some(data) = parts[i + 1] {
            let (m_cells, m_size, _) = merge(read_qb(data)?)?;
            if m_size != size {
                return Err(err(format!(
                    "The {} map is {}x{}x{} but the model is {}x{}x{}. Material maps have to match the model exactly.",
                    key.to_uppercase(),
                    m_size[0],
                    m_size[1],
                    m_size[2],
                    size[0],
                    size[1],
                    size[2]
                )));
            }
            maps[i] = Some(m_cells);
        }
    }
    let lookup = |i: usize, c: &Cell| maps[i].as_ref().and_then(|m| m.get(c)).copied();

    let mut attach = cells.iter().find(|(_, rgb)| *rgb == MAGENTA).map(|(c, _)| *c);
    let from_marker = attach.is_some();
    if attach.is_none() && single {
        let [dx, dy, dz] = base_pos;
        if dx <= 0 && dy <= 0 && dz <= 0 && (dx != 0 || dy != 0 || dz != 0) && -dx < size[0] && -dy < size[1] && -dz < size[2] {
            attach = Some((-dx, -dy, -dz));
        }
    }
    let filled_marker = attach.and_then(|(x, y, z)| {
        [(x + 1, y, z), (x - 1, y, z), (x, y + 1, z), (x, y - 1, z), (x, y, z + 1), (x, y, z - 1)].into_iter().find(|c| cells.get(c).is_some_and(|rgb| *rgb != MAGENTA))
    });

    let mut sorted: Vec<&(Cell, [u8; 3])> = cells.iter().collect();
    sorted.sort_unstable_by_key(|((x, y, z), _)| (*z, *y, *x));
    let mut voxels = Vec::with_capacity(sorted.len());
    let (mut unknown_alpha, mut unknown_type, mut unknown_spec) = (0, 0, 0);
    for &&(cell, mut rgb) in &sorted {
        let mut src = cell;
        if rgb == MAGENTA {
            match filled_marker {
                Some(donor) if Some(cell) == attach => {
                    rgb = *cells.get(&donor).unwrap();
                    src = donor;
                }
                _ => continue,
            }
        }
        let index = match lookup(2, &src) {
            None | Some(MAGENTA) => 0,
            Some(t) => TYPES.iter().position(|e| e.1 == t).unwrap_or_else(|| {
                unknown_type += 1;
                0
            }),
        };
        let t = TYPES[index].0;
        let w = if materials::material_class(t) == Class::Glass {
            match lookup(0, &src) {
                None | Some(MAGENTA) => 0,
                Some(a) if a[0] == a[1] && a[1] == a[2] && VALID_ALPHA.contains(&a[0]) => {
                    if a[0] == 255 {
                        0
                    } else {
                        ((a[0] as i64 - 16).div_euclid(32)).clamp(0, 7) as u8
                    }
                }
                Some(_) => {
                    unknown_alpha += 1;
                    3
                }
            }
        } else {
            match lookup(1, &src) {
                None | Some(MAGENTA) | Some(WHITE) => 0,
                Some(s) => SPECULAR.iter().position(|e| *e == s).map(|w| w as u8).unwrap_or_else(|| {
                    unknown_spec += 1;
                    0
                }),
            }
        };
        voxels.push(Voxel { x: cell.0, y: cell.1, z: cell.2, r: rgb[0], g: rgb[1], b: rgb[2], w, t });
    }
    if voxels.is_empty() {
        return Err(err("That .qb is only an attachment point - there's no model to compile."));
    }
    let mn = [voxels.iter().map(|v| v.x).min().unwrap(), voxels.iter().map(|v| v.y).min().unwrap(), voxels.iter().map(|v| v.z).min().unwrap()];
    let mx = [voxels.iter().map(|v| v.x).max().unwrap(), voxels.iter().map(|v| v.y).max().unwrap(), voxels.iter().map(|v| v.z).max().unwrap()];
    let tight = [mx[0] - mn[0] + 1, mx[1] - mn[1] + 1, mx[2] - mn[2] + 1];
    for v in &mut voxels {
        v.x = tight[0] - 1 - (v.x - mn[0]);
        v.y -= mn[1];
        v.z -= mn[2];
    }
    let pos = match attach {
        Some((ax, ay, az)) => [-(tight[0] - 1 - (ax - mn[0])), -(ay - mn[1]), -(az - mn[2])],
        None => [-tight[0].div_euclid(2), 0, -tight[2].div_euclid(2)],
    };
    let data = codec::encode(&voxels, 5, Some(pos), &[0, 0, 0, 0], [0, 0, 0], Some(tight))?;
    let mut map_names: Vec<&str> = ["a", "s", "t"].iter().zip(&maps).filter(|(_, m)| m.is_some()).map(|(k, _)| *k).collect();
    map_names.sort_unstable();
    let summary = json!({
        "voxels": voxels.len(),
        "size": tight,
        "attachment": attach.map(|(x, y, z)| json!([x - mn[0], y - mn[1], z - mn[2]])),
        "attachment_source": if from_marker { json!("marker") } else if attach.is_some() { json!("offset") } else { Value::Null },
        "maps": map_names,
        "unknown_type": unknown_type,
        "unknown_alpha": unknown_alpha,
        "unknown_specular": unknown_spec,
    });
    Ok((data, summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qb_round_trip_through_a_blueprint() {
        let voxels = vec![
            Voxel { x: 0, y: 0, z: 0, r: 200, g: 10, b: 30, w: 1, t: 21 },
            Voxel { x: 1, y: 0, z: 0, r: 20, g: 100, b: 30, w: 3, t: 18 },
            Voxel { x: 1, y: 1, z: 2, r: 9, g: 9, b: 9, w: 0, t: 55 },
        ];
        let bp = codec::encode(&voxels, 5, Some([-5, 0, -5]), &[], [0, 0, 0], None).unwrap();
        let export = from_blueprint(&codec::decode_full(&bp).unwrap(), "m").unwrap();
        assert_eq!(export.files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["m.qb", "m_a.qb", "m_s.qb", "m_t.qb"]);
        let (back, summary) = to_blueprint(&export.files).unwrap();
        assert_eq!(summary["attachment_source"], "marker");
        let d = codec::decode_full(&back).unwrap();
        assert_eq!(d.voxels.len(), 3);
        assert_eq!(d.pos, [-5, 0, -5]);
        assert_eq!(d.voxels, voxels);
    }
}
