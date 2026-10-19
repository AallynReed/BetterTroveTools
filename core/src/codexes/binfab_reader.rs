//! utils/binfab_reader.py: the `.binfab` wire format read as the game's reflection
//! serializer writes it.
//!
//! Each field is a uleb128 key (`field = key >> 4`, `wt = key & 0xF`): wt 0 unsigned
//! varint, 2 zig-zag varint, 4 fixed32, 6 fixed64, 8 length-prefixed (ascii string or
//! nested message), anything else a schema-framed composite marker.

use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use crate::py;

/// The errors Python let escape (`ValueError` from an over-long varint, `RecursionError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReaderError {
    UlebTooLong,
    TooDeep,
}

impl std::fmt::Display for ReaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ReaderError::UlebTooLong => "uleb128 too long",
            ReaderError::TooDeep => "maximum recursion depth exceeded",
        })
    }
}

impl std::error::Error for ReaderError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Uleb {
    /// Ran off the end of the buffer (Python's `IndexError`).
    End,
    TooLong,
}

/// Reads a uleb128 (up to 10 bytes, like Python's unbounded int).
pub fn read_uleb(data: &[u8], mut pos: usize) -> Result<(u128, usize), Uleb> {
    let mut result: u128 = 0;
    let mut shift = 0u32;
    loop {
        let byte = *data.get(pos).ok_or(Uleb::End)?;
        pos += 1;
        result |= ((byte & 0x7F) as u128) << shift;
        if byte & 0x80 == 0 {
            return Ok((result, pos));
        }
        shift += 7;
        if shift > 63 {
            return Err(Uleb::TooLong);
        }
    }
}

pub fn unzig(value: u128) -> i128 {
    ((value >> 1) as i128) ^ -((value & 1) as i128)
}

fn field_of(key: u128) -> u64 {
    u64::try_from(key >> 4).unwrap_or(u64::MAX)
}

fn le_u64(raw: &[u8]) -> u64 {
    raw.iter().rev().fold(0u64, |acc, &b| (acc << 8) | b as u64)
}

fn f32_of(raw: &[u8]) -> Option<f64> {
    let bytes: [u8; 4] = raw.try_into().ok()?;
    Some(f32::from_le_bytes(bytes) as f64)
}

/// A float as Python's json would print it; NaN/Infinity become strings.
pub fn float_value(f: f64) -> Value {
    if f.is_nan() {
        Value::String("NaN".into())
    } else if f.is_infinite() {
        Value::String(if f > 0.0 { "Infinity" } else { "-Infinity" }.into())
    } else {
        json!(f)
    }
}

/// An integer of up to 128 bits as JSON (exact while it fits in 64 bits).
pub fn int_value(v: i128) -> Value {
    if let Ok(u) = u64::try_from(v) {
        json!(u)
    } else if let Ok(i) = i64::try_from(v) {
        json!(i)
    } else {
        json!(v as f64)
    }
}

/// Offset of the field stream after the `<fmt> 00 <uleb len>` header, else 0.
pub fn content_start(data: &[u8]) -> usize {
    if data.len() >= 4 && data[1] == 0 {
        if let Ok((length, pos)) = read_uleb(data, 2) {
            if pos as u128 + length == data.len() as u128 {
                return pos;
            }
        }
    }
    0
}

#[derive(Debug, Clone, PartialEq)]
pub enum FlatValue {
    Uint(u128),
    Sint(i128),
    Fixed32 { u32: u32, f32: Option<f64> },
    Fixed64 { u64: u64 },
    Bytes { len: u128, text: Option<String> },
    Marker,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlatField {
    pub off: usize,
    pub field: u64,
    pub wt: u8,
    pub value: FlatValue,
}

impl FlatField {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("off".into(), json!(self.off));
        m.insert("field".into(), json!(self.field));
        m.insert("wt".into(), json!(self.wt));
        match &self.value {
            FlatValue::Uint(v) => {
                m.insert("value".into(), int_value(*v as i128));
            }
            FlatValue::Sint(v) => {
                m.insert("value".into(), int_value(*v));
            }
            FlatValue::Fixed32 { u32, f32 } => {
                m.insert("u32".into(), json!(u32));
                m.insert("f32".into(), f32.map(float_value).unwrap_or(Value::Null));
            }
            FlatValue::Fixed64 { u64 } => {
                m.insert("u64".into(), json!(u64));
            }
            FlatValue::Bytes { len, text } => {
                m.insert("len".into(), int_value(*len as i128));
                m.insert("str".into(), json!(text));
            }
            FlatValue::Marker => {
                m.insert("marker".into(), json!(true));
            }
        }
        Value::Object(m)
    }
}

/// The leading flat field run, up to the 2nd composite marker or the first anomaly.
pub fn parse_flat(data: &[u8], start: Option<usize>) -> Result<(Vec<FlatField>, usize), ReaderError> {
    let mut pos = start.unwrap_or_else(|| content_start(data));
    let n = data.len();
    let mut fields = Vec::new();
    let mut markers = 0;
    while pos < n {
        let off = pos;
        let Ok((key, p)) = read_uleb(data, pos) else { break };
        pos = p;
        let (field, wt) = (field_of(key), (key & 0xF) as u8);
        let value = match wt {
            0 | 2 => match read_uleb(data, pos) {
                Ok((v, p)) => {
                    pos = p;
                    if wt == 0 {
                        FlatValue::Uint(v)
                    } else {
                        FlatValue::Sint(unzig(v))
                    }
                }
                Err(Uleb::End) => break,
                Err(Uleb::TooLong) => return Err(ReaderError::UlebTooLong),
            },
            4 => {
                let raw = py::slice(data, pos, pos + 4);
                pos += 4;
                FlatValue::Fixed32 { u32: le_u64(raw) as u32, f32: f32_of(raw) }
            }
            6 => {
                let raw = py::slice(data, pos, pos + 8);
                pos += 8;
                FlatValue::Fixed64 { u64: le_u64(raw) }
            }
            8 => {
                let (length, p) = match read_uleb(data, pos) {
                    Ok(v) => v,
                    Err(Uleb::End) => break,
                    Err(Uleb::TooLong) => return Err(ReaderError::UlebTooLong),
                };
                pos = p;
                if pos as u128 + length > n as u128 {
                    break;
                }
                let raw = &data[pos..pos + length as usize];
                pos += length as usize;
                let text = (!raw.is_empty() && py::printable(raw)).then(|| py::latin1(raw));
                FlatValue::Bytes { len: length, text }
            }
            _ => {
                fields.push(FlatField { off, field, wt, value: FlatValue::Marker });
                markers += 1;
                if markers > 1 {
                    break;
                }
                continue;
            }
        };
        fields.push(FlatField { off, field, wt, value });
    }
    Ok((fields, pos))
}

#[derive(Debug, Clone, PartialEq)]
pub enum MsgValue {
    Varint { value: u128, zz: i128 },
    Signed { value: i128, raw: u128 },
    Fixed32 { u32: u32, f32: Option<f64> },
    Fixed64 { u64: u64, hex: String },
    Str(String),
    Msg(Vec<MsgField>),
    Marker,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MsgField {
    pub field: u64,
    pub wt: u8,
    pub value: MsgValue,
}

impl MsgField {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("field".into(), json!(self.field));
        m.insert("wt".into(), json!(self.wt));
        match &self.value {
            MsgValue::Varint { value, zz } => {
                m.insert("value".into(), int_value(*value as i128));
                m.insert("zz".into(), int_value(*zz));
            }
            MsgValue::Signed { value, raw } => {
                m.insert("value".into(), int_value(*value));
                m.insert("raw".into(), int_value(*raw as i128));
            }
            MsgValue::Fixed32 { u32, f32 } => {
                m.insert("u32".into(), json!(u32));
                m.insert("f32".into(), f32.map(float_value).unwrap_or(Value::Null));
            }
            MsgValue::Fixed64 { u64, hex } => {
                m.insert("u64".into(), json!(u64));
                m.insert("hex".into(), json!(hex));
            }
            MsgValue::Str(s) => {
                m.insert("str".into(), json!(s));
            }
            MsgValue::Msg(children) => {
                m.insert("msg".into(), Value::Array(children.iter().map(MsgField::to_value).collect()));
            }
            MsgValue::Marker => {
                m.insert("marker".into(), json!(true));
            }
        }
        Value::Object(m)
    }
}

const MAX_DEPTH: usize = 900;

/// Recursive parse: non-ascii `wt 8` payloads are nested messages, and their exact
/// length keeps the parent in sync whatever the child holds.
pub fn parse_message(data: &[u8], start: Option<usize>, end: Option<usize>) -> Result<Vec<MsgField>, ReaderError> {
    let start = start.unwrap_or_else(|| content_start(data));
    parse_message_at(data, start, end.unwrap_or(data.len()), 0)
}

fn parse_message_at(data: &[u8], start: usize, end: usize, depth: usize) -> Result<Vec<MsgField>, ReaderError> {
    if depth > MAX_DEPTH {
        return Err(ReaderError::TooDeep);
    }
    let mut out = Vec::new();
    let mut pos = start;
    while pos < end {
        let Ok((key, p)) = read_uleb(data, pos) else { break };
        pos = p;
        let (field, wt) = (field_of(key), (key & 0xF) as u8);
        let value = match wt {
            0 | 2 => match read_uleb(data, pos) {
                Ok((v, p)) => {
                    pos = p;
                    if wt == 0 {
                        MsgValue::Varint { value: v, zz: unzig(v) }
                    } else {
                        MsgValue::Signed { value: unzig(v), raw: v }
                    }
                }
                Err(Uleb::End) => break,
                Err(Uleb::TooLong) => return Err(ReaderError::UlebTooLong),
            },
            4 => {
                let raw = py::slice(data, pos, pos + 4);
                pos += 4;
                MsgValue::Fixed32 { u32: le_u64(raw) as u32, f32: f32_of(raw) }
            }
            6 => {
                let raw = py::slice(data, pos, pos + 8);
                pos += 8;
                MsgValue::Fixed64 { u64: le_u64(raw), hex: hex::encode(raw) }
            }
            8 => {
                let (ln, p) = match read_uleb(data, pos) {
                    Ok(v) => v,
                    Err(Uleb::End) => break,
                    Err(Uleb::TooLong) => return Err(ReaderError::UlebTooLong),
                };
                pos = p;
                if pos as u128 + ln > end as u128 {
                    break;
                }
                let ln = ln as usize;
                let raw = &data[pos..pos + ln];
                let child = pos;
                pos += ln;
                if ln >= 1 && py::printable(raw) {
                    MsgValue::Str(py::latin1(raw))
                } else {
                    MsgValue::Msg(parse_message_at(data, child, child + ln, depth + 1)?)
                }
            }
            _ => MsgValue::Marker,
        };
        out.push(MsgField { field, wt, value });
    }
    Ok(out)
}

/// Depth-first walk of a [`parse_message`] tree as `("f0.f1.f5", field)`.
pub fn iter_fields(msg: &[MsgField]) -> Vec<(String, &MsgField)> {
    fn walk<'a>(msg: &'a [MsgField], path: &str, out: &mut Vec<(String, &'a MsgField)>) {
        for f in msg {
            let p = if path.is_empty() { format!("f{}", f.field) } else { format!("{}.f{}", path, f.field) };
            out.push((p.clone(), f));
            if let MsgValue::Msg(children) = &f.value {
                walk(children, &p, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(msg, "", &mut out);
    out
}

/// The identity/metadata component every entity prefab opens with.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    /// f1: the localization name key.
    pub name_key: Option<String>,
    /// f2: the display category ("Pets and Mounts", "Items", ...).
    pub category: Option<String>,
    /// f5: the localization description key.
    pub desc_key: Option<String>,
    /// f14 == 2.
    pub tradable: Option<bool>,
    pub flags: IndexMap<u64, i128>,
}

impl Identity {
    pub fn to_value(&self) -> Value {
        let flags: Map<String, Value> = self.flags.iter().map(|(k, v)| (k.to_string(), int_value(*v))).collect();
        json!({
            "name_key": self.name_key,
            "category": self.category,
            "desc_key": self.desc_key,
            "tradable": self.tradable,
            "flags": flags,
        })
    }
}

/// `None` when the prefab has no identity component (recipes, tables, locale files).
pub fn decode_identity(data: &[u8]) -> Result<Option<Identity>, ReaderError> {
    let (fields, _) = parse_flat(data, None)?;
    let mut markers = 0;
    let mut strings: IndexMap<u64, Option<String>> = IndexMap::new();
    let mut values: IndexMap<u64, i128> = IndexMap::new();
    for f in &fields {
        if f.value == FlatValue::Marker {
            markers += 1;
            if markers > 1 {
                break;
            }
            continue;
        }
        if markers != 1 {
            continue;
        }
        match &f.value {
            FlatValue::Bytes { text, .. } => {
                strings.entry(f.field).or_insert_with(|| text.clone());
            }
            FlatValue::Uint(v) => {
                values.entry(f.field).or_insert(*v as i128);
            }
            FlatValue::Sint(v) => {
                values.entry(f.field).or_insert(*v);
            }
            _ => {}
        }
    }
    if strings.is_empty() && values.is_empty() {
        return Ok(None);
    }
    let get = |n: u64| strings.get(&n).cloned().flatten();
    Ok(Some(Identity {
        name_key: get(1),
        category: get(2),
        desc_key: get(5),
        tradable: values.get(&14).map(|&v| v == 2),
        flags: values,
    }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionGroup {
    pub id: String,
    pub name_key: String,
    pub members: Vec<String>,
}

impl CollectionGroup {
    pub fn to_value(&self) -> Value {
        json!({"id": self.id, "name_key": self.name_key, "members": self.members})
    }
}

/// A `collections/collection_*` table as its category groups.
pub fn parse_collection_table(data: &[u8]) -> Vec<CollectionGroup> {
    let mut groups: Vec<CollectionGroup> = Vec::new();
    let mut prev_bare = String::new();
    for (_, _, s) in harvest_strings(data, 2, 512) {
        if s.starts_with("$CollectionName") {
            let id = if prev_bare.is_empty() { s.strip_prefix("$CollectionName_").unwrap_or(&s).to_string() } else { prev_bare.clone() };
            groups.push(CollectionGroup { id, name_key: s, members: Vec::new() });
        } else if s.starts_with("collections/") {
            if let Some(g) = groups.last_mut() {
                g.members.push(s);
            }
        } else if !s.contains('/') && !s.starts_with('$') {
            prev_bare = s;
        }
    }
    groups
}

/// Lowercased member path to category id.
pub fn collection_category_map(data: &[u8]) -> IndexMap<String, String> {
    let mut out = IndexMap::new();
    for g in parse_collection_table(data) {
        for m in &g.members {
            out.entry(m.replace('\\', "/").to_lowercase()).or_insert_with(|| g.id.clone());
        }
    }
    out
}

/// Every `<key wt8> <uleb len> <printable bytes>` anywhere, as `(offset, field, text)`.
pub fn harvest_strings(data: &[u8], min_len: usize, max_len: usize) -> Vec<(usize, u64, String)> {
    let mut out = Vec::new();
    let n = data.len();
    for i in 0..n.saturating_sub(1) {
        // The key's wire type sits in its first byte's low nibble.
        if data[i] & 0x0F != 8 {
            continue;
        }
        let Ok((key, j)) = read_uleb(data, i) else { continue };
        let Ok((length, k)) = read_uleb(data, j) else { continue };
        if (min_len as u128) <= length && length <= max_len as u128 && k + length as usize <= n {
            let raw = &data[k..k + length as usize];
            if py::printable(raw) {
                out.push((i, field_of(key), py::latin1(raw)));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints() {
        assert_eq!(read_uleb(&[0xAC, 0x02], 0), Ok((300, 2)));
        assert_eq!(read_uleb(&[0x80], 0), Err(Uleb::End));
        assert_eq!(read_uleb(&[0xFF; 11], 0), Err(Uleb::TooLong));
        assert_eq!(unzig(3), -2);
        assert_eq!(unzig(4), 2);
    }

    #[test]
    fn identity_reads_first_component() {
        // marker, f1 "$k_name", f2 "Items", f14 = 2, marker, f1 "ignored"
        let mut d = vec![0x0E, 0x18, 7];
        d.extend(b"$k_name");
        d.extend([0x28, 5]);
        d.extend(b"Items");
        d.extend([0xE0, 0x01, 2, 0x0E, 0x18, 3]);
        d.extend(b"abc");
        let id = decode_identity(&d).unwrap().unwrap();
        assert_eq!(id.name_key.as_deref(), Some("$k_name"));
        assert_eq!(id.category.as_deref(), Some("Items"));
        assert_eq!(id.tradable, Some(true));
    }
}
