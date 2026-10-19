//! utils/kiwi_blueprint/binfab.py: which blueprint parts a creature prefab binds to which
//! sockets of which skeleton, and its identity (name key), read from the wire format.

use std::sync::OnceLock;

use regex::bytes::Regex;

use crate::py;

/// `read_uleb`: raises `IndexError` past the end and `ValueError` past 10 bytes.
fn read_uleb(data: &[u8], mut pos: usize) -> Result<(u128, usize), &'static str> {
    let (mut result, mut shift) = (0u128, 0u32);
    loop {
        let byte = *data.get(pos).ok_or("index out of range")?;
        pos += 1;
        result |= ((byte & 0x7F) as u128) << shift;
        if byte & 0x80 == 0 {
            return Ok((result, pos));
        }
        shift += 7;
        if shift > 63 {
            return Err("uleb128 too long");
        }
    }
}

/// `read_varint`: `None` when the bytes run out first.
fn read_varint(data: &[u8], offset: usize) -> Option<(u128, usize)> {
    let (mut value, mut shift, mut cursor) = (0u128, 0u32, offset);
    while cursor < data.len() && shift <= 63 {
        let byte = data[cursor];
        value |= ((byte & 0x7F) as u128) << shift;
        cursor += 1;
        if byte & 0x80 == 0 {
            return Some((value, cursor));
        }
        shift += 7;
    }
    None
}

fn add(pos: usize, n: u128) -> usize {
    (pos as u128).saturating_add(n).min(usize::MAX as u128) as usize
}

fn printable(raw: &[u8]) -> bool {
    raw.iter().all(|&b| (32..127).contains(&b))
}

fn content_start(data: &[u8]) -> usize {
    if data.len() >= 4 && data[1] == 0 {
        if let Ok((len, pos)) = read_uleb(data, 2) {
            if pos as u128 + len == data.len() as u128 {
                return pos;
            }
        }
    }
    0
}

type Block = Vec<((char, u128), Option<String>)>;

/// `_marker_blocks`. A too-long uleb inside a value escapes, as it does in Python.
fn marker_blocks(data: &[u8]) -> Result<Vec<Block>, String> {
    let mut pos = content_start(data);
    let n = data.len();
    let mut blocks: Vec<Block> = Vec::new();
    let mut cur: Option<usize> = None;
    let setdefault = |blocks: &mut Vec<Block>, cur: Option<usize>, key: (char, u128), v: Option<String>| {
        if let Some(c) = cur {
            if !blocks[c].iter().any(|(k, _)| *k == key) {
                blocks[c].push((key, v));
            }
        }
    };
    while pos < n {
        let Ok((key, p)) = read_uleb(data, pos) else { break };
        pos = p;
        let (field, wt) = (key >> 4, key & 0xF);
        match wt {
            0 | 2 => match read_uleb(data, pos) {
                Ok((value, p)) => {
                    pos = p;
                    let v = if wt == 2 { ((value >> 1) as i128 ^ -((value & 1) as i128)).to_string() } else { value.to_string() };
                    setdefault(&mut blocks, cur, ('v', field), Some(v));
                }
                Err("index out of range") => break,
                Err(e) => return Err(e.into()),
            },
            4 => pos = add(pos, 4),
            6 => pos = add(pos, 8),
            8 => {
                let (length, p) = match read_uleb(data, pos) {
                    Ok(v) => v,
                    Err("index out of range") => break,
                    Err(e) => return Err(e.into()),
                };
                if p as u128 + length > n as u128 {
                    break;
                }
                let raw = &data[p..p + length as usize];
                pos = p + length as usize;
                let text = (!raw.is_empty() && printable(raw)).then(|| py::latin1(raw));
                setdefault(&mut blocks, cur, ('s', field), text);
            }
            _ => {
                blocks.push(Vec::new());
                cur = Some(blocks.len() - 1);
            }
        }
    }
    Ok(blocks)
}

/// `decode_identity(data)["name_key"]`.
pub fn identity_name_key(data: &[u8]) -> Result<Option<String>, String> {
    let blocks = marker_blocks(data)?;
    let Some(first) = blocks.first() else { return Ok(None) };
    let s1 = |b: &Block| b.iter().find(|(k, _)| *k == ('s', 1)).and_then(|(_, v)| v.clone());
    let mut ident = first;
    if s1(first).filter(|s| !s.is_empty()).is_none() {
        if let Some(b) = blocks.iter().find(|b| s1(b).is_some_and(|s| s.starts_with('$'))) {
            ident = b;
        }
    }
    if ident.is_empty() {
        return Ok(None);
    }
    Ok(s1(ident))
}

/// `harvest_strings`: every plausible length-delimited ASCII field.
fn harvest_strings(data: &[u8]) -> Vec<(usize, u128, &str)> {
    let n = data.len();
    let mut out = Vec::new();
    for i in 0..n.saturating_sub(1) {
        let Ok((key, j)) = read_uleb(data, i) else { continue };
        if key & 0xF != 8 {
            continue;
        }
        let Ok((length, k)) = read_uleb(data, j) else { continue };
        if (2..=512).contains(&length) && k + length as usize <= n {
            let raw = &data[k..k + length as usize];
            if printable(raw) {
                out.push((i, key >> 4, std::str::from_utf8(raw).unwrap()));
            }
        }
    }
    out
}

/// `_real_fields`: the harvested strings that don't overlap one already taken.
fn real_fields(data: &[u8]) -> Vec<(usize, u128, &str)> {
    let mut out = Vec::new();
    let mut last_end = 0usize;
    let mut first = true;
    for (off, field, text) in harvest_strings(data) {
        let Ok((_, j)) = read_uleb(data, off) else { continue };
        let Ok((length, k)) = read_uleb(data, j) else { continue };
        if first || k >= last_end {
            out.push((off, field, text));
            last_end = k + length as usize;
            first = false;
        }
    }
    out
}

fn field_end(data: &[u8], off: usize) -> usize {
    let (_, j) = read_uleb(data, off).unwrap_or((0, off));
    let (length, k) = read_uleb(data, j).unwrap_or((0, j));
    k + length as usize
}

fn f32_scale(raw: &[u8]) -> f64 {
    let v = f32::from_le_bytes(raw.try_into().unwrap()) as f64;
    if v > 0.0 && v <= 16.0 {
        v
    } else {
        1.0
    }
}

/// `_mesh_scale`: the f32 field 3 right after a part's socket name, if there is one.
fn mesh_scale(data: &[u8], mut pos: usize) -> f64 {
    let mut prev = 1u128;
    for _ in 0..4 {
        let Some((key, nxt)) = read_varint(data, pos) else { break };
        let (fld, wire) = (key >> 4, key & 0xF);
        if fld <= prev {
            break;
        }
        prev = fld;
        match wire {
            4 => {
                if nxt + 4 > data.len() {
                    break;
                }
                if fld == 3 {
                    return f32_scale(&data[nxt..nxt + 4]);
                }
                pos = nxt + 4;
            }
            8 => {
                let Some((length, nxt)) = read_varint(data, nxt) else { break };
                pos = add(nxt, length);
            }
            0 => {
                let Some((_, nxt)) = read_varint(data, nxt) else { break };
                pos = nxt;
            }
            _ => break,
        }
    }
    1.0
}

/// `_head_scale`: the creature's head scale, a tagged f32 shortly after the last socket.
fn head_scale(data: &[u8], start: usize, stop: usize) -> f64 {
    let end = stop.min(start + 96).min(data.len());
    if start >= end {
        return 1.0;
    }
    data[start..end].windows(8).find(|w| w[..4] == [0x1e, 0x1e, 0x08, 0x24]).map(|w| f32_scale(&w[4..])).unwrap_or(1.0)
}

pub struct RigRefs {
    pub skeleton: String,
    /// `(blueprint basename, socket)` in the order the prefab lists them.
    pub parts: Vec<(String, String)>,
    pub scales: Vec<(String, f64)>,
    pub head_scale: f64,
}

/// `extract_rig_refs`: `None` for anything that isn't a creature.
pub fn extract_rig_refs(data: &[u8]) -> Option<RigRefs> {
    let rows = real_fields(data);
    let (mut skeleton, mut skel_off, mut gsf_off, mut next_skel_off) = (None, None, None, None);
    for &(off, _, s) in &rows {
        let base = s.rsplit('/').next().unwrap_or("").to_lowercase();
        if let Some(stem) = base.strip_suffix(".skeleton.gr2") {
            if skeleton.is_none() {
                skeleton = Some(stem.to_string());
                skel_off = Some(off);
            } else if next_skel_off.is_none() {
                next_skel_off = Some(off);
            }
        } else if gsf_off.is_none() && base.ends_with(".gsf") {
            gsf_off = Some(off);
        }
    }
    let (skeleton, skel_off) = (skeleton?, skel_off?);
    let end = [gsf_off, next_skel_off].into_iter().flatten().filter(|&o| o > skel_off).min().unwrap_or(data.len());

    let mut parts: Vec<(String, String)> = Vec::new();
    let mut scales: Vec<(String, f64)> = Vec::new();
    let mut last_ap_end = skel_off;
    for pair in rows.windows(2) {
        let ((off, field, s), (n_off, n_field, n_s)) = (pair[0], pair[1]);
        if !(skel_off < off && off < end) {
            continue;
        }
        if field == 0 && n_field == 1 && n_s.starts_with("AP_") {
            let reference = s.replace('\\', "/").to_lowercase();
            let base = reference.rsplit('/').next().unwrap_or("").to_string();
            let ap = n_s[3..].to_lowercase();
            last_ap_end = field_end(data, n_off);
            let scale = mesh_scale(data, last_ap_end);
            match parts.iter_mut().find(|(b, _)| *b == base) {
                Some(slot) => slot.1 = ap,
                None => parts.push((base.clone(), ap)),
            }
            match scales.iter_mut().find(|(b, _)| *b == base) {
                Some(slot) => slot.1 = scale,
                None => scales.push((base, scale)),
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    let stop = next_skel_off.filter(|&o| o != 0).unwrap_or(data.len());
    let head_scale = head_scale(data, last_ap_end, stop);
    scales.retain(|(_, v)| *v != 1.0);
    Some(RigRefs { skeleton, parts, scales, head_scale })
}

/// The cheap pre-check `_scan` runs before parsing a prefab.
pub fn mentions_skeleton(data: &[u8]) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\.skeleton\.gr2").unwrap()).is_match(data)
}
