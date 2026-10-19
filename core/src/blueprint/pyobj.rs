//! `json.loads` into Python objects (with correctly rounded floats, which serde_json's
//! default parser is not), `int()` of them, and the text `json.dumps` writes.

use std::fmt::Write as _;

use serde_json::{Map, Number, Value};

use crate::py::{float_str, repr_str_cc, strip};

/// A value as `json.loads` returns it.
#[derive(Debug, Clone, PartialEq)]
pub enum Py {
    None,
    Bool(bool),
    /// Python ints are unbounded; past i128 they saturate, which no range check can tell apart.
    Int(i128),
    Float(f64),
    Str(String),
    List(Vec<Py>),
    /// Insertion order, keys unique (a repeated key keeps its first slot and its last value).
    Dict(Vec<(String, Py)>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonError {
    /// `json.JSONDecodeError` (a `ValueError`).
    Invalid,
    /// `RecursionError`, which nothing in the editor catches.
    TooDeep,
}

const MAX_DEPTH: usize = 900;

/// `json.loads(text)`.
pub fn loads(text: &str) -> Result<Py, JsonError> {
    let mut p = Parser { s: text.as_bytes(), i: 0, depth: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.s.len() {
        return Err(JsonError::Invalid);
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    depth: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.s.get(self.i) {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &[u8]) -> bool {
        if self.s[self.i..].starts_with(lit) {
            self.i += lit.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self) -> Result<Py, JsonError> {
        match self.s.get(self.i) {
            Some(b'"') => Ok(Py::Str(self.string()?)),
            Some(b'{') => self.nested(Self::object),
            Some(b'[') => self.nested(Self::array),
            Some(b'n') if self.eat(b"null") => Ok(Py::None),
            Some(b't') if self.eat(b"true") => Ok(Py::Bool(true)),
            Some(b'f') if self.eat(b"false") => Ok(Py::Bool(false)),
            Some(b'N') if self.eat(b"NaN") => Ok(Py::Float(f64::NAN)),
            Some(b'I') if self.eat(b"Infinity") => Ok(Py::Float(f64::INFINITY)),
            Some(b'-') if self.s[self.i..].starts_with(b"-Infinity") => {
                self.i += 9;
                Ok(Py::Float(f64::NEG_INFINITY))
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(JsonError::Invalid),
        }
    }

    fn nested(&mut self, f: fn(&mut Self) -> Result<Py, JsonError>) -> Result<Py, JsonError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(JsonError::TooDeep);
        }
        let v = f(self);
        self.depth -= 1;
        v
    }

    fn number(&mut self) -> Result<Py, JsonError> {
        let start = self.i;
        let digits = |p: &mut Self| {
            let from = p.i;
            while let Some(b'0'..=b'9') = p.s.get(p.i) {
                p.i += 1;
            }
            p.i - from
        };
        if self.s[self.i] == b'-' {
            self.i += 1;
        }
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                digits(self);
            }
            _ => return Err(JsonError::Invalid),
        }
        let int_end = self.i;
        let mut is_float = false;
        if self.s.get(self.i) == Some(&b'.') {
            let save = self.i;
            self.i += 1;
            if digits(self) == 0 {
                self.i = save;
            } else {
                is_float = true;
            }
        }
        if let Some(b'e' | b'E') = self.s.get(self.i) {
            let save = self.i;
            self.i += 1;
            if let Some(b'+' | b'-') = self.s.get(self.i) {
                self.i += 1;
            }
            if digits(self) == 0 {
                self.i = save;
            } else {
                is_float = true;
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).map_err(|_| JsonError::Invalid)?;
        if is_float {
            return text.parse::<f64>().map(Py::Float).map_err(|_| JsonError::Invalid);
        }
        let text = &text[..int_end - start];
        Ok(Py::Int(text.parse::<i128>().unwrap_or(if text.starts_with('-') { i128::MIN } else { i128::MAX })))
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let h = self.s.get(self.i..self.i + 4).ok_or(JsonError::Invalid)?;
        let h = std::str::from_utf8(h).map_err(|_| JsonError::Invalid)?;
        if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(JsonError::Invalid);
        }
        self.i += 4;
        u32::from_str_radix(h, 16).map_err(|_| JsonError::Invalid)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let run = self.i;
            while let Some(&b) = self.s.get(self.i) {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.s[run..self.i]).map_err(|_| JsonError::Invalid)?);
            match self.s.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let esc = *self.s.get(self.i).ok_or(JsonError::Invalid)?;
                    self.i += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let mut c = self.hex4()?;
                            if (0xD800..0xDC00).contains(&c) && self.s[self.i..].starts_with(b"\\u") {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
                                } else {
                                    self.i = save;
                                }
                            }
                            // Python keeps a lone surrogate; a Rust string can't hold one.
                            out.push(char::from_u32(c).unwrap_or('\u{FFFD}'));
                        }
                        _ => return Err(JsonError::Invalid),
                    }
                }
                _ => return Err(JsonError::Invalid),
            }
        }
    }

    fn array(&mut self) -> Result<Py, JsonError> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Py::List(items));
        }
        loop {
            self.ws();
            items.push(self.value()?);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Py::List(items));
                }
                _ => return Err(JsonError::Invalid),
            }
        }
    }

    fn object(&mut self) -> Result<Py, JsonError> {
        self.i += 1;
        let mut items: Vec<(String, Py)> = Vec::new();
        let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        self.ws();
        if self.s.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Py::Dict(items));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return Err(JsonError::Invalid);
            }
            let key = self.string()?;
            self.ws();
            if self.s.get(self.i) != Some(&b':') {
                return Err(JsonError::Invalid);
            }
            self.i += 1;
            self.ws();
            let v = self.value()?;
            match index.get(&key) {
                Some(&at) => items[at].1 = v,
                None => {
                    index.insert(key.clone(), items.len());
                    items.push((key, v));
                }
            }
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Py::Dict(items));
                }
                _ => return Err(JsonError::Invalid),
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntError {
    /// `TypeError`: not a number or a string.
    Type,
    /// `ValueError`: a string that isn't an integer, or NaN.
    Value,
    /// `OverflowError`: an infinite float.
    Overflow,
}

impl Py {
    pub fn get(&self, key: &str) -> Option<&Py> {
        match self {
            Py::Dict(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn truthy(&self) -> bool {
        match self {
            Py::None => false,
            Py::Bool(b) => *b,
            Py::Int(i) => *i != 0,
            Py::Float(f) => *f != 0.0,
            Py::Str(s) => !s.is_empty(),
            Py::List(v) => !v.is_empty(),
            Py::Dict(v) => !v.is_empty(),
        }
    }

    /// `int(value)`.
    pub fn int(&self) -> Result<i128, IntError> {
        match self {
            Py::Bool(b) => Ok(*b as i128),
            Py::Int(i) => Ok(*i),
            Py::Float(f) if f.is_nan() => Err(IntError::Value),
            Py::Float(f) if f.is_infinite() => Err(IntError::Overflow),
            Py::Float(f) => Ok(f.trunc() as i128),
            Py::Str(s) => int_from_str(s).ok_or(IntError::Value),
            _ => Err(IntError::Type),
        }
    }

    /// `list(value)`: a list's items, a string's characters, a dict's keys. `None` is a TypeError.
    pub fn iter(&self) -> Option<Vec<Py>> {
        match self {
            Py::List(v) => Some(v.clone()),
            Py::Str(s) => Some(s.chars().map(|c| Py::Str(c.to_string())).collect()),
            Py::Dict(items) => Some(items.iter().map(|(k, _)| Py::Str(k.clone())).collect()),
            _ => None,
        }
    }

    /// `value == n` for an int `n`.
    pub fn eq_int(&self, n: i128) -> bool {
        match self {
            Py::Bool(b) => *b as i128 == n,
            Py::Int(i) => *i == n,
            Py::Float(f) => *f == n as f64,
            _ => false,
        }
    }

    /// `self == other`, where `1 == 1.0` and `True == 1`.
    pub fn py_eq(&self, other: &Py) -> bool {
        let num = |p: &Py| match p {
            Py::Bool(b) => Some(*b as i128 as f64),
            Py::Int(i) => Some(*i as f64),
            Py::Float(f) => Some(*f),
            _ => None,
        };
        match (self, other) {
            (Py::Int(a), Py::Int(b)) => a == b,
            (Py::Str(a), Py::Str(b)) => a == b,
            (Py::None, Py::None) => true,
            (Py::List(a), Py::List(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.py_eq(y)),
            (Py::Dict(a), Py::Dict(b)) => a.len() == b.len() && a.iter().all(|(k, v)| other.get(k).is_some_and(|w| v.py_eq(w))),
            _ => match (num(self), num(other)) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            },
        }
    }

    /// `str(value)`.
    pub fn str(&self) -> String {
        match self {
            Py::Str(s) => s.clone(),
            other => other.repr(),
        }
    }

    /// `repr(value)`.
    pub fn repr(&self) -> String {
        match self {
            Py::None => "None".into(),
            Py::Bool(true) => "True".into(),
            Py::Bool(false) => "False".into(),
            Py::Int(i) => i.to_string(),
            Py::Float(f) => float_str(*f),
            Py::Str(s) => repr_str_cc(s),
            Py::List(v) => format!("[{}]", v.iter().map(Py::repr).collect::<Vec<_>>().join(", ")),
            Py::Dict(items) => format!(
                "{{{}}}",
                items.iter().map(|(k, v)| format!("{}: {}", repr_str_cc(k), v.repr())).collect::<Vec<_>>().join(", ")
            ),
        }
    }

    /// The value as serde_json holds it; `None` for NaN and the infinities.
    pub fn to_value(&self) -> Option<Value> {
        Some(match self {
            Py::None => Value::Null,
            Py::Bool(b) => Value::Bool(*b),
            Py::Int(i) => match (i64::try_from(*i), u64::try_from(*i)) {
                (Ok(v), _) => Value::from(v),
                (_, Ok(v)) => Value::from(v),
                _ => Value::Number(Number::from_f64(*i as f64)?),
            },
            Py::Float(f) => Value::Number(Number::from_f64(*f)?),
            Py::Str(s) => Value::String(s.clone()),
            Py::List(v) => Value::Array(v.iter().map(Py::to_value).collect::<Option<_>>()?),
            Py::Dict(items) => {
                let mut m = Map::new();
                for (k, v) in items {
                    m.insert(k.clone(), v.to_value()?);
                }
                Value::Object(m)
            }
        })
    }
}

/// `int(text)` for a string: surrounding whitespace, a sign, digits with single underscores.
pub fn int_from_str(text: &str) -> Option<i128> {
    let t = strip(text);
    let (neg, digits) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    if digits.is_empty() || digits.starts_with('_') || digits.ends_with('_') || digits.contains("__") {
        return None;
    }
    let mut v: i128 = 0;
    for c in digits.chars() {
        if c == '_' {
            continue;
        }
        let d = c.to_digit(10)? as i128;
        v = v.saturating_mul(10).saturating_add(d);
    }
    Some(if neg { -v } else { v })
}


// --- JSON text, as `json.dumps` writes it ---------------------------------------------

/// A JSON string literal, `ensure_ascii` style.
pub fn write_str(out: &mut String, s: &str) {
    if s.bytes().all(|b| (0x20..0x7f).contains(&b) && b != b'"' && b != b'\\') {
        out.push('"');
        out.push_str(s);
        out.push('"');
    } else {
        out.push_str(&crate::json::dumps(&Value::String(s.to_owned())));
    }
}

pub fn write_value(out: &mut String, v: &Value) {
    out.push_str(&crate::json::dumps(v));
}

pub fn write_f64(out: &mut String, f: f64) {
    out.push_str(&crate::json::float_repr(f));
}

/// `[1, 2, 3]`.
pub fn write_ints<T: std::fmt::Display>(out: &mut String, items: impl IntoIterator<Item = T>) {
    out.push('[');
    let mut first = true;
    for v in items {
        if !first {
            out.push_str(", ");
        }
        first = false;
        let _ = write!(out, "{v}");
    }
    out.push(']');
}

/// `null` or `[x, y, z]`.
pub fn write_opt_ints(out: &mut String, v: Option<&[i64]>) {
    match v {
        Some(v) => write_ints(out, v.iter()),
        None => out.push_str("null"),
    }
}

/// A JSON object written field by field.
pub struct Obj<'a> {
    pub out: &'a mut String,
    empty: bool,
}

impl<'a> Obj<'a> {
    pub fn new(out: &'a mut String) -> Self {
        out.push('{');
        Obj { out, empty: true }
    }

    /// Writes the key; the caller writes the value into the returned buffer.
    pub fn key(&mut self, k: &str) -> &mut String {
        if !self.empty {
            self.out.push_str(", ");
        }
        self.empty = false;
        write_str(self.out, k);
        self.out.push_str(": ");
        self.out
    }

    pub fn value(&mut self, k: &str, v: &Value) {
        let out = self.key(k);
        write_value(out, v);
    }

    pub fn int(&mut self, k: &str, v: i64) {
        let out = self.key(k);
        let _ = write!(out, "{v}");
    }

    pub fn str(&mut self, k: &str, v: &str) {
        let out = self.key(k);
        write_str(out, v);
    }

    pub fn end(self) {
        self.out.push('}');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_like_python() {
        assert_eq!(loads(" [1, 2.5, -0, 1e2, \"a\\u00e9\"] ").unwrap(), Py::List(vec![Py::Int(1), Py::Float(2.5), Py::Int(0), Py::Float(100.0), Py::Str("aé".into())]));
        assert_eq!(loads("{\"a\": 1, \"b\": 2, \"a\": 3}").unwrap(), Py::Dict(vec![("a".into(), Py::Int(3)), ("b".into(), Py::Int(2))]));
        assert!(matches!(loads("NaN").unwrap(), Py::Float(f) if f.is_nan()));
        for bad in ["", "01", "1.", "[1,]", "{'a': 1}", "\"\t\"", "[1] x", "tru"] {
            assert_eq!(loads(bad), Err(JsonError::Invalid), "{bad}");
        }
        assert_eq!(loads("0.30000000000000004").unwrap(), Py::Float(0.30000000000000004));
    }

    #[test]
    fn python_conversions() {
        assert_eq!(Py::Str(" +1_000 ".into()).int(), Ok(1000));
        assert_eq!(Py::Str("1.0".into()).int(), Err(IntError::Value));
        assert_eq!(Py::Float(-2.7).int(), Ok(-2));
        assert_eq!(Py::None.int(), Err(IntError::Type));
        assert_eq!(Py::Dict(vec![("a".into(), Py::Int(1))]).str(), "{'a': 1}");
        assert_eq!(Py::List(vec![Py::Str("it's".into()), Py::Float(1.0)]).str(), "[\"it's\", 1.0]");
    }
}
