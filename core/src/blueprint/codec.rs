//! utils/kiwi_blueprint/codec.py: Trove's `.blueprint` (kiwib) format, both ways.
//!
//! v3/v4: `kiwib`, u32 version, uleb count, then per voxel zigzag x/y/z, u16 type and
//! B, G, R, w bytes, then the entity section verbatim. v5: the body after the 9-byte
//! header is one zlib stream: i32 pos[3], size[3], count, start, deltas[count-1],
//! u16 types[count], u32 colours[count] (`w<<24 | r<<16 | g<<8 | b`), entity section.

use super::pyzlib;
use super::util::{Error, Kind, Result};

pub const MAGIC: &[u8; 5] = b"kiwib";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Voxel {
    pub x: i64,
    pub y: i64,
    pub z: i64,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub w: u8,
    pub t: u16,
}

/// `DecodedBlueprint`.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub version: u32,
    pub size: [i64; 3],
    pub pos: [i64; 3],
    pub voxels: Vec<Voxel>,
    pub entity_blob: Vec<u8>,
    /// The signed min corner v3/v4 stored.
    pub offset: [i64; 3],
}

fn err(msg: impl Into<String>) -> Error {
    Error::value(Kind::Blueprint, msg)
}

pub fn read_uleb128(data: &[u8], mut pos: usize) -> Result<(u32, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let byte = *data.get(pos).ok_or_else(|| err("Truncated LEB128 value."))?;
        pos += 1;
        result |= ((byte & 0x7F) as u64).wrapping_shl(shift);
        if byte & 0x80 == 0 {
            return Ok((result as u32, pos));
        }
        shift += 7;
        if shift >= 64 {
            return Err(err("LEB128 value too large."));
        }
    }
}

pub fn write_uleb128(out: &mut Vec<u8>, value: i128) {
    let mut v = (value & 0xFFFF_FFFF) as u32;
    loop {
        let byte = (v & 0x7F) as u8;
        v >>= 7;
        if v != 0 {
            out.push(byte | 0x80);
        } else {
            out.push(byte);
            return;
        }
    }
}

pub fn read_svarint(data: &[u8], pos: usize) -> Result<(i64, usize)> {
    let (raw, pos) = read_uleb128(data, pos)?;
    Ok((((raw >> 1) as i64) ^ -((raw & 1) as i64), pos))
}

pub fn write_svarint(out: &mut Vec<u8>, value: i64) {
    let v = value as i128;
    write_uleb128(out, ((v << 1) ^ (v >> 31)) & 0xFFFF_FFFF);
}

pub fn blueprint_version(data: &[u8]) -> Option<u32> {
    if data.len() < 9 || &data[..5] != MAGIC {
        return None;
    }
    Some(u32::from_le_bytes(data[5..9].try_into().unwrap()))
}

pub fn inflate_v5(data: &[u8]) -> Result<Vec<u8>> {
    pyzlib::decompressobj(&data[9..], 15).map(|i| i.data).map_err(|e| err(format!("Failed to inflate v5 blueprint: {e}")))
}

fn i32_at(b: &[u8], at: usize) -> i64 {
    i32::from_le_bytes(b[at..at + 4].try_into().unwrap()) as i64
}

/// True for placeholders with no voxels and for anything undecodable.
pub fn is_empty_blueprint(data: &[u8]) -> bool {
    match blueprint_version(data) {
        Some(3 | 4) => !matches!(read_uleb128(data, 9), Ok((count, _)) if count != 0),
        Some(5) => match inflate_v5(data) {
            Ok(body) => body.len() < 28 || i32_at(&body, 24) <= 0,
            Err(_) => true,
        },
        _ => true,
    }
}

fn decode_v34(data: &[u8], version: u32) -> Result<Decoded> {
    let (count, mut pos) = read_uleb128(data, 9)?;
    let mut raw = Vec::with_capacity((count as usize).min(data.len() / 9 + 1));
    for _ in 0..count {
        let (x, p) = read_svarint(data, pos)?;
        let (y, p) = read_svarint(data, p)?;
        let (z, p) = read_svarint(data, p)?;
        if p + 6 > data.len() {
            return Err(err("v3/v4 voxel record is truncated."));
        }
        let t = u16::from_le_bytes([data[p], data[p + 1]]);
        raw.push(Voxel { x, y, z, b: data[p + 2], g: data[p + 3], r: data[p + 4], w: data[p + 5], t });
        pos = p + 6;
    }
    if raw.is_empty() {
        return Err(err("Blueprint contains no voxels (empty placeholder)."));
    }
    let entity_blob = data[pos..].to_vec();
    let (mut mn, mut mx) = ([i64::MAX; 3], [i64::MIN; 3]);
    for v in &raw {
        for (i, c) in [v.x, v.y, v.z].into_iter().enumerate() {
            mn[i] = mn[i].min(c);
            mx[i] = mx[i].max(c);
        }
    }
    let size = [mx[0] - mn[0] + 1, mx[1] - mn[1] + 1, mx[2] - mn[2] + 1];
    for v in &mut raw {
        v.x -= mn[0];
        v.y -= mn[1];
        v.z -= mn[2];
    }
    // No stored origin: Trove centres the box.
    let pos = [-size[0].div_euclid(2), -size[1].div_euclid(2), -size[2].div_euclid(2)];
    Ok(Decoded { version, size, pos, voxels: raw, entity_blob, offset: mn })
}

fn decode_v5(data: &[u8]) -> Result<Decoded> {
    let body = inflate_v5(data)?;
    if body.len() < 32 {
        return Err(err("v5 blueprint payload is too small."));
    }
    let h: Vec<i64> = (0..8).map(|i| i32_at(&body, i * 4)).collect();
    let (pos, size, count, start) = ([h[0], h[1], h[2]], [h[3], h[4], h[5]], h[6], h[7]);
    if count <= 0 || size.iter().any(|&s| s <= 0) {
        return Err(err("v5 blueprint is empty or has invalid bounds."));
    }
    let count = count as usize;
    let need = 32 + 4 * (count - 1) + 2 * count + 4 * count;
    if body.len() < need {
        // struct.error, which nothing catches.
        return Err(Error::internal("unpack_from requires a buffer of at least the declared voxel table"));
    }
    let (types_at, colours_at) = (32 + 4 * (count - 1), 32 + 4 * (count - 1) + 2 * count);
    let plane = size[0] * size[2];
    let mut voxels = Vec::with_capacity(count);
    let mut l = start;
    for i in 0..count {
        if i > 0 {
            l += i32_at(&body, 32 + 4 * (i - 1));
        }
        let t = u16::from_le_bytes([body[types_at + 2 * i], body[types_at + 2 * i + 1]]);
        let c = u32::from_le_bytes(body[colours_at + 4 * i..colours_at + 4 * i + 4].try_into().unwrap());
        let rem = l.rem_euclid(plane);
        voxels.push(Voxel {
            x: rem.rem_euclid(size[0]),
            y: l.div_euclid(plane),
            z: rem.div_euclid(size[0]),
            r: (c >> 16) as u8,
            g: (c >> 8) as u8,
            b: c as u8,
            w: (c >> 24) as u8,
            t,
        });
    }
    Ok(Decoded { version: 5, size, pos, voxels, entity_blob: body[need..].to_vec(), offset: [0, 0, 0] })
}

/// `decode_full`.
pub fn decode_full(data: &[u8]) -> Result<Decoded> {
    match blueprint_version(data) {
        None => Err(err("Not a Trove blueprint (missing 'kiwib' magic).")),
        Some(v @ (3 | 4)) => decode_v34(data, v),
        Some(5) => decode_v5(data),
        Some(v) => Err(err(format!("Unsupported kiwib blueprint version: {v}."))),
    }
}

/// Where the model attaches to a hand or a head: world zero in the voxel frame. v5 only.
pub fn attachment_point(d: &Decoded) -> Option<[i64; 3]> {
    (d.version == 5).then(|| [-d.pos[0], -d.pos[1], -d.pos[2]])
}

/// One placed object: its model-local position and its opaque sub-message.
pub type EntityRecord = (i64, i64, i64, Vec<u8>);

/// `read_entity_records`: `None` when the section can't be read exactly.
pub fn read_entity_records(blob: &[u8]) -> Option<(Vec<EntityRecord>, Vec<u8>)> {
    if blob.len() < 4 {
        return Some((Vec::new(), Vec::new()));
    }
    let count = u32::from_le_bytes(blob[..4].try_into().unwrap());
    let mut records = Vec::new();
    let mut i = 4;
    for _ in 0..count {
        let (x, p) = read_svarint(blob, i).ok()?;
        let (y, p) = read_svarint(blob, p).ok()?;
        let (z, p) = read_svarint(blob, p).ok()?;
        let (len, p) = read_uleb128(blob, p).ok()?;
        let end = p.checked_add(len as usize).filter(|&e| e <= blob.len())?;
        records.push((x, y, z, blob[p..end].to_vec()));
        i = end;
    }
    Some((records, blob[i..].to_vec()))
}

pub fn write_entity_records(records: &[EntityRecord], tail: &[u8]) -> Vec<u8> {
    let mut out = (records.len() as u32).to_le_bytes().to_vec();
    for (x, y, z, sub) in records {
        write_svarint(&mut out, *x);
        write_svarint(&mut out, *y);
        write_svarint(&mut out, *z);
        write_uleb128(&mut out, sub.len() as i128);
        out.extend_from_slice(sub);
    }
    out.extend_from_slice(tail);
    out
}

/// `parse_entity_section(blob)["count"]`: the declared count, exact or not.
pub fn entity_count(blob: &[u8]) -> u32 {
    if blob.len() < 4 {
        0
    } else {
        u32::from_le_bytes(blob[..4].try_into().unwrap())
    }
}

/// `encode`: byte-identical to the original when nothing was edited.
pub fn encode(voxels: &[Voxel], version: u32, pos: Option<[i64; 3]>, entity_blob: &[u8], offset: [i64; 3], size: Option<[i64; 3]>) -> Result<Vec<u8>> {
    if voxels.is_empty() {
        return Err(err("Cannot encode a blueprint with no voxels."));
    }
    if !matches!(version, 3..=5) {
        return Err(err(format!("Unsupported encode version: {version}.")));
    }
    let (mut mx, mut mn) = ([i64::MIN; 3], i64::MAX);
    for v in voxels {
        mx[0] = mx[0].max(v.x);
        mx[1] = mx[1].max(v.y);
        mx[2] = mx[2].max(v.z);
        mn = mn.min(v.x).min(v.y).min(v.z);
    }
    let size = size.unwrap_or([mx[0] + 1, mx[1] + 1, mx[2] + 1]);
    if mx[0] >= size[0] || mx[1] >= size[1] || mx[2] >= size[2] || mn < 0 {
        return Err(err("A voxel lies outside the blueprint's bounding box."));
    }
    if version != 5 {
        return Ok(encode_v34(voxels, version, entity_blob, offset));
    }
    encode_v5(voxels, size, pos, if entity_blob.is_empty() { &[0, 0, 0, 0] } else { entity_blob })
}

fn encode_v34(voxels: &[Voxel], version: u32, entity_blob: &[u8], offset: [i64; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(13 + voxels.len() * 10 + entity_blob.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&version.to_le_bytes());
    write_uleb128(&mut out, voxels.len() as i128);
    for v in voxels {
        write_svarint(&mut out, offset[0] + v.x);
        write_svarint(&mut out, offset[1] + v.y);
        write_svarint(&mut out, offset[2] + v.z);
        out.extend_from_slice(&v.t.to_le_bytes());
        out.extend_from_slice(&[v.b, v.g, v.r, v.w]);
    }
    out.extend_from_slice(entity_blob);
    out
}

/// `struct.pack("<i", v)`, which raises (uncaught) outside i32.
fn pack_i32(out: &mut Vec<u8>, v: i128) -> Result<()> {
    let v = i32::try_from(v).map_err(|_| Error::internal("argument out of range"))?;
    out.extend_from_slice(&v.to_le_bytes());
    Ok(())
}

fn encode_v5(voxels: &[Voxel], size: [i64; 3], pos: Option<[i64; 3]>, entity_blob: &[u8]) -> Result<Vec<u8>> {
    let [sx, sy, sz] = size;
    let pos = pos.unwrap_or([-sx.div_euclid(2), 0, -sz.div_euclid(2)]);
    let (sx, sz) = (sx as i128, sz as i128);
    let plane = sx * sz;
    let mut cells: Vec<(i128, usize)> = voxels.iter().enumerate().map(|(i, v)| (v.x as i128 + v.z as i128 * sx + v.y as i128 * plane, i)).collect();
    cells.sort_by_key(|c| c.0);
    // A dict keyed by index: the last voxel at a cell wins.
    let mut order: Vec<(i128, usize)> = Vec::with_capacity(cells.len());
    for c in cells {
        match order.last_mut() {
            Some(last) if last.0 == c.0 => *last = c,
            _ => order.push(c),
        }
    }
    let n = order.len();
    let mut payload = Vec::with_capacity(32 + n * 10 + entity_blob.len());
    for v in [pos[0] as i128, pos[1] as i128, pos[2] as i128, sx, sy as i128, sz, n as i128, order[0].0] {
        pack_i32(&mut payload, v)?;
    }
    for w in order.windows(2) {
        pack_i32(&mut payload, w[1].0 - w[0].0)?;
    }
    for &(_, i) in &order {
        payload.extend_from_slice(&voxels[i].t.to_le_bytes());
    }
    for &(_, i) in &order {
        let v = &voxels[i];
        let c = v.b as u32 | (v.g as u32) << 8 | (v.r as u32) << 16 | (v.w as u32) << 24;
        payload.extend_from_slice(&c.to_le_bytes());
    }
    payload.extend_from_slice(entity_blob);
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&5u32.to_le_bytes());
    out.extend_from_slice(&pyzlib::compress(&payload, 9));
    Ok(out)
}

/// Re-encodes a decoded blueprint with its own frame.
pub fn encode_decoded(d: &Decoded) -> Result<Vec<u8>> {
    encode(&d.voxels, d.version, Some(d.pos), &d.entity_blob, d.offset, Some(d.size))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vox(x: i64, y: i64, z: i64) -> Voxel {
        Voxel { x, y, z, r: 200, g: 10, b: 30, w: 0, t: 21 }
    }

    #[test]
    fn v5_round_trip() {
        let voxels = vec![vox(0, 0, 0), vox(1, 0, 0), vox(1, 2, 1)];
        let data = encode(&voxels, 5, Some([-1, 0, -1]), &[], [0, 0, 0], None).unwrap();
        let d = decode_full(&data).unwrap();
        assert_eq!(d.size, [2, 3, 2]);
        assert_eq!(d.pos, [-1, 0, -1]);
        assert_eq!(d.voxels, voxels);
        assert_eq!(d.entity_blob, vec![0, 0, 0, 0]);
        assert_eq!(attachment_point(&d), Some([1, 0, 1]));
        assert_eq!(encode_decoded(&d).unwrap(), data);
    }

    #[test]
    fn v34_round_trip_is_byte_identical() {
        let mut data = MAGIC.to_vec();
        data.extend_from_slice(&4u32.to_le_bytes());
        write_uleb128(&mut data, 2);
        for (x, y, z) in [(-3i64, 0i64, 5i64), (-2, 1, 5)] {
            write_svarint(&mut data, x);
            write_svarint(&mut data, y);
            write_svarint(&mut data, z);
            data.extend_from_slice(&[21, 0, 1, 2, 3, 0]);
        }
        data.extend_from_slice(&[0, 0, 0, 0]);
        let d = decode_full(&data).unwrap();
        assert_eq!(d.offset, [-3, 0, 5]);
        assert_eq!(d.size, [2, 2, 1]);
        assert_eq!(encode_decoded(&d).unwrap(), data);
        assert!(!is_empty_blueprint(&data));
    }

    #[test]
    fn entity_records_round_trip() {
        let recs = vec![(1, -2, 3, b"prefabs/x".to_vec())];
        let blob = write_entity_records(&recs, b"tail");
        assert_eq!(read_entity_records(&blob), Some((recs, b"tail".to_vec())));
        assert_eq!(read_entity_records(&[1, 0, 0, 0, 0x80]), None);
    }
}
