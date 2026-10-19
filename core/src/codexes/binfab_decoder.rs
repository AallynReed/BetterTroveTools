//! utils/binfab_decoder.py: a length-framed token tree of a `.binfab` (the CLI
//! inspector's view, where wt 0xE carries a length).

use serde_json::{json, Map, Value};

use super::binfab_reader::{float_value, int_value};
use super::py;

pub const TYPE_VARINT: u8 = 0x0;
pub const TYPE_FIXED32: u8 = 0x4;
pub const TYPE_FIXED64: u8 = 0x6;
pub const TYPE_BYTES: u8 = 0x8;
pub const TYPE_CONTAINER: u8 = 0xE;

pub fn type_name(wire_type: u8) -> String {
    match wire_type {
        TYPE_VARINT => "varint".into(),
        TYPE_FIXED32 => "fixed32".into(),
        TYPE_FIXED64 => "fixed64".into(),
        TYPE_BYTES => "bytes".into(),
        TYPE_CONTAINER => "container".into(),
        other => format!("unknown_{:X}", other),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Payload {
    Varint(u128),
    Fixed32 { u32: u32, i32: i32, hex: String, f32: Option<f64> },
    Fixed64 { u64: u64, i64: i64, hex: String },
    Bytes { length: usize, hex: String, ascii: Option<String> },
    Container { length: usize },
}

impl Payload {
    pub fn to_value(&self) -> Value {
        match self {
            Payload::Varint(v) => int_value(*v as i128),
            Payload::Fixed32 { u32, i32, hex, f32 } => {
                let mut m = Map::new();
                m.insert("u32".into(), json!(u32));
                m.insert("i32".into(), json!(i32));
                m.insert("hex".into(), json!(hex));
                if let Some(f) = f32 {
                    m.insert("f32".into(), float_value(*f));
                }
                Value::Object(m)
            }
            Payload::Fixed64 { u64, i64, hex } => json!({"u64": u64, "i64": i64, "hex": hex}),
            Payload::Bytes { length, hex, ascii } => {
                let mut m = Map::new();
                m.insert("length".into(), json!(length));
                m.insert("hex".into(), json!(hex));
                if let Some(a) = ascii {
                    m.insert("ascii".into(), json!(a));
                }
                Value::Object(m)
            }
            Payload::Container { length } => json!({ "length": length }),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub offset: usize,
    pub tag_value: u128,
    pub field_id: u128,
    pub wire_type: u8,
    pub payload: Payload,
    pub raw_hex: String,
    pub children: Option<Vec<Token>>,
}

impl Token {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("offset".into(), json!(self.offset));
        m.insert("tag_value".into(), int_value(self.tag_value as i128));
        m.insert("tag_hex".into(), json!(format!("0x{:X}", self.tag_value)));
        m.insert("field_id".into(), int_value(self.field_id as i128));
        m.insert("wire_type".into(), json!(self.wire_type));
        m.insert("wire_type_name".into(), json!(type_name(self.wire_type)));
        m.insert("payload".into(), self.payload.to_value());
        m.insert("raw_hex".into(), json!(self.raw_hex));
        if let Some(children) = &self.children {
            m.insert("children".into(), Value::Array(children.iter().map(Token::to_value).collect()));
        }
        Value::Object(m)
    }
}

/// `(value, next)`, or `None` past the end or after 10 bytes.
fn read_varint(data: &[u8], offset: usize) -> Option<(u128, usize)> {
    let mut value: u128 = 0;
    let mut shift = 0u32;
    let mut cursor = offset;
    while cursor < data.len() {
        let byte = data[cursor];
        value |= ((byte & 0x7F) as u128) << shift;
        cursor += 1;
        if byte < 0x80 {
            return Some((value, cursor));
        }
        shift += 7;
        if shift > 63 {
            break;
        }
    }
    None
}

pub fn parse_tokens(data: &[u8], start: usize, end: Option<usize>) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut cursor = start;
    let limit = end.map_or(data.len(), |e| e.min(data.len()));
    while cursor < limit {
        let Some((tag_value, tag_end)) = read_varint(data, cursor) else { break };
        if tag_end <= cursor {
            break;
        }
        let field_id = tag_value >> 4;
        let wire_type = (tag_value & 0xF) as u8;
        let token = |payload, raw: &[u8], children| Token { offset: cursor, tag_value, field_id, wire_type, payload, raw_hex: py::hex_upper(raw), children };
        let (tok, next) = match wire_type {
            TYPE_VARINT => {
                let Some((value, next)) = read_varint(data, tag_end) else { break };
                if next > limit {
                    break;
                }
                (token(Payload::Varint(value), &data[tag_end..next], None), next)
            }
            TYPE_FIXED32 | TYPE_FIXED64 => {
                let width = if wire_type == TYPE_FIXED32 { 4 } else { 8 };
                let next = tag_end + width;
                if next > limit {
                    break;
                }
                let raw = &data[tag_end..next];
                let hex = py::hex_upper(raw);
                let payload = if width == 4 {
                    let b: [u8; 4] = raw.try_into().unwrap();
                    let f = f32::from_le_bytes(b) as f64;
                    Payload::Fixed32 { u32: u32::from_le_bytes(b), i32: i32::from_le_bytes(b), hex, f32: f.is_finite().then_some(f) }
                } else {
                    let b: [u8; 8] = raw.try_into().unwrap();
                    Payload::Fixed64 { u64: u64::from_le_bytes(b), i64: i64::from_le_bytes(b), hex }
                };
                (token(payload, raw, None), next)
            }
            TYPE_BYTES | TYPE_CONTAINER => {
                let Some((size, size_end)) = read_varint(data, tag_end) else { break };
                if size_end as u128 + size > limit as u128 {
                    break;
                }
                let next = size_end + size as usize;
                let raw = &data[size_end..next];
                if wire_type == TYPE_BYTES {
                    let ascii = py::printable(raw).then(|| py::latin1(raw));
                    (token(Payload::Bytes { length: raw.len(), hex: py::hex_upper(raw), ascii }, raw, None), next)
                } else {
                    let children = parse_tokens(data, size_end, Some(next));
                    (token(Payload::Container { length: size as usize }, raw, Some(children)), next)
                }
            }
            _ => break,
        };
        tokens.push(tok);
        cursor = next;
    }
    tokens
}

pub fn analyze_binfab(data: &[u8], source_name: &str) -> Value {
    let tokens = parse_tokens(data, 0, None);
    json!({
        "file": source_name,
        "size": data.len(),
        "tokens": tokens.iter().map(Token::to_value).collect::<Vec<_>>(),
    })
}

/// Python `repr()` of a printable ASCII string.
fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(quote);
    for c in s.chars() {
        if c == '\\' || c == quote {
            out.push('\\');
        }
        out.push(c);
    }
    out.push(quote);
    out
}

fn format_payload(payload: &Payload) -> String {
    match payload {
        Payload::Varint(v) => v.to_string(),
        Payload::Bytes { ascii: Some(a), .. } => py_repr(a),
        Payload::Bytes { length, .. } | Payload::Container { length } => format!("length={}", length),
        Payload::Fixed32 { f32: Some(f), hex, .. } => format!("f32={} hex={}", crate::json::float_repr(*f), hex),
        Payload::Fixed64 { u64, hex, .. } => format!("u64={} hex={}", u64, hex),
        other => crate::json::dumps(&other.to_value()),
    }
}

/// The inspector's text rendering (`format_analysis`).
pub fn format_analysis(data: &[u8], source_name: &str, max_tokens: usize) -> String {
    let tokens = parse_tokens(data, 0, None);
    let file = if source_name.is_empty() { "<memory>" } else { source_name };
    let mut lines = vec![format!("File: {}", file), format!("Size: {} bytes", data.len()), format!("Top-level tokens: {}", tokens.len()), String::new(), "Token tree:".into()];
    fn walk(lines: &mut Vec<String>, tokens: &[Token], depth: usize, max: usize, count: &mut usize) {
        let indent = "  ".repeat(depth);
        for t in tokens {
            if *count >= max {
                return;
            }
            lines.push(format!(
                "{}0x{:04X} tag={:<6} field={:<4} type={:<9} {}",
                indent,
                t.offset,
                format!("0x{:X}", t.tag_value),
                t.field_id,
                type_name(t.wire_type),
                format_payload(&t.payload)
            ));
            *count += 1;
            if let Some(children) = t.children.as_deref().filter(|c| !c.is_empty()) {
                walk(lines, children, depth + 1, max, count);
            }
            if *count >= max {
                return;
            }
        }
    }
    let mut count = 0;
    walk(&mut lines, &tokens, 1, max_tokens, &mut count);
    if count >= max_tokens {
        lines.push("  ... token output truncated".into());
    }
    lines.join("\n")
}
