//! The bits of Python semantics the gem maths leans on: `int` vs `float` results,
//! `round`, `repr`, `int()`/`float()`, enum lookups and binascii's lenient base64.

use std::ops::{Add, Mul, Neg, Sub};

use serde_json::{Map, Value};

/// A Python number. `int` and `float` serialise differently, so the type rides along.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Num {
    Int(i64),
    Float(f64),
}

pub use Num::{Float, Int};

impl Num {
    pub fn f(self) -> f64 {
        match self {
            Int(i) => i as f64,
            Float(f) => f,
        }
    }

    /// A JSON number (or bool, which Python treats as an int).
    pub fn from_json(v: &Value) -> Option<Num> {
        match v {
            Value::Number(n) => Some(n.as_i64().map(Int).unwrap_or_else(|| Float(n.as_f64().unwrap_or(f64::NAN)))),
            Value::Bool(b) => Some(Int(*b as i64)),
            _ => None,
        }
    }

    pub fn json(self) -> Value {
        match self {
            Int(i) => Value::from(i),
            Float(f) => float(f),
        }
    }

    /// `a / b`: always a float.
    pub fn div(self, o: Num) -> Num {
        Float(self.f() / o.f())
    }

    /// `round(x, digits)`: an int stays an int.
    pub fn round(self, digits: i32) -> Num {
        match self {
            Int(i) => Int(i),
            Float(f) => Float(round_to(f, digits)),
        }
    }

    pub fn type_name(self) -> &'static str {
        match self {
            Int(_) => "int",
            Float(_) => "float",
        }
    }
}

fn int_op(a: i64, b: i64, op: fn(i64, i64) -> Option<i64>, fop: fn(f64, f64) -> f64) -> Num {
    op(a, b).map(Int).unwrap_or_else(|| Float(fop(a as f64, b as f64)))
}

impl Add for Num {
    type Output = Num;
    fn add(self, o: Num) -> Num {
        match (self, o) {
            (Int(a), Int(b)) => int_op(a, b, i64::checked_add, |x, y| x + y),
            _ => Float(self.f() + o.f()),
        }
    }
}

impl Sub for Num {
    type Output = Num;
    fn sub(self, o: Num) -> Num {
        match (self, o) {
            (Int(a), Int(b)) => int_op(a, b, i64::checked_sub, |x, y| x - y),
            _ => Float(self.f() - o.f()),
        }
    }
}

impl Mul for Num {
    type Output = Num;
    fn mul(self, o: Num) -> Num {
        match (self, o) {
            (Int(a), Int(b)) => int_op(a, b, i64::checked_mul, |x, y| x * y),
            _ => Float(self.f() * o.f()),
        }
    }
}

impl Neg for Num {
    type Output = Num;
    fn neg(self) -> Num {
        match self {
            Int(i) => Int(-i),
            Float(f) => Float(-f),
        }
    }
}

impl From<i64> for Num {
    fn from(i: i64) -> Num {
        Int(i)
    }
}

impl From<f64> for Num {
    fn from(f: f64) -> Num {
        Float(f)
    }
}

/// A float JSON value (`null` for NaN/inf, which JSON cannot carry).
pub fn float(f: f64) -> Value {
    serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

/// `round(x, digits)` for a float: correctly rounded, ties to even.
pub fn round_to(x: f64, digits: i32) -> f64 {
    if !x.is_finite() || digits > 323 {
        return x;
    }
    if digits < 0 {
        let p = 10f64.powi(-digits);
        return (x / p).round_ties_even() * p;
    }
    format!("{:.*}", digits as usize, x).parse().unwrap_or(x)
}

/// `round(x)`: ties to even, as an int.
pub fn round_int(x: f64) -> Result<i64, String> {
    if x.is_nan() {
        return Err("cannot convert float NaN to integer".into());
    }
    if x.is_infinite() {
        return Err("cannot convert float infinity to integer".into());
    }
    Ok(x.round_ties_even() as i64)
}

/// Python's `type(v).__name__` for a JSON value.
pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `repr(v)` of the Python object a JSON value loads as.
pub fn repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => match n.as_f64().filter(|_| n.is_f64()) {
            Some(f) => float_repr(f),
            None => n.to_string(),
        },
        Value::String(s) => str_repr(s),
        Value::Array(items) => format!("[{}]", items.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(map) => {
            let parts: Vec<String> = map.iter().map(|(k, v)| format!("{}: {}", str_repr(k), repr(v))).collect();
            format!("{{{}}}", parts.join(", "))
        }
    }
}

pub fn float_repr(f: f64) -> String {
    if f.is_nan() {
        "nan".into()
    } else if f.is_infinite() {
        if f > 0.0 { "inf".into() } else { "-inf".into() }
    } else {
        crate::json::float_repr(f)
    }
}

/// `repr(s)` for a str.
pub fn str_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || (0x7f..=0xa0).contains(&(c as u32)) || c as u32 == 0xad => {
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// `str.strip()`: Python counts \x1c-\x1f as whitespace too.
pub fn strip(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c))
}

/// Digits with single underscores between them, as `int()`/`float()` accept.
fn without_underscores(s: &str) -> Option<String> {
    if !s.contains('_') {
        return Some(s.to_string());
    }
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c == '_' {
            let ok = i > 0 && i + 1 < chars.len() && chars[i - 1].is_ascii_digit() && chars[i + 1].is_ascii_digit();
            if !ok {
                return None;
            }
        }
    }
    Some(s.replace('_', ""))
}

/// Parses an integer literal the way `int(str)` does (base 10).
pub fn parse_int_literal(s: &str) -> Option<i64> {
    let t = without_underscores(strip(s))?;
    let digits = t.strip_prefix(['+', '-']).unwrap_or(&t);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse().ok()
}

/// Parses a float literal the way `float(str)` does.
pub fn parse_float_literal(s: &str) -> Option<f64> {
    let t = without_underscores(strip(s))?;
    let body = t.strip_prefix(['+', '-']).unwrap_or(&t);
    let lower = body.to_ascii_lowercase();
    if matches!(lower.as_str(), "inf" | "infinity" | "nan") {
        return t.parse().ok();
    }
    if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) {
        return None;
    }
    t.parse().ok()
}

/// `int(v)`.
pub fn int(v: &Value) -> Result<i64, String> {
    match v {
        Value::Bool(b) => Ok(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Ok(i),
            None => {
                let f = n.as_f64().unwrap_or(f64::NAN);
                if f.is_nan() {
                    Err("cannot convert float NaN to integer".into())
                } else if f.is_infinite() {
                    Err("cannot convert float infinity to integer".into())
                } else {
                    Ok(f.trunc() as i64)
                }
            }
        },
        Value::String(s) => parse_int_literal(s).ok_or_else(|| format!("invalid literal for int() with base 10: {}", str_repr(s))),
        other => Err(format!("int() argument must be a string, a bytes-like object or a real number, not '{}'", type_name(other))),
    }
}

/// `float(v)`.
pub fn to_float(v: &Value) -> Result<f64, String> {
    match v {
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => parse_float_literal(s).ok_or_else(|| format!("could not convert string to float: {}", str_repr(s))),
        other => Err(format!("float() argument must be a string or a real number, not '{}'", type_name(other))),
    }
}

/// The value `SomeIntEnum(v)` looks up: ints, bools and integral floats hash alike.
pub fn enum_key(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0).map(|f| f as i64)),
        _ => None,
    }
}

/// `v == n` in Python, for a JSON value against an int.
pub fn eq_int(v: &Value, n: i64) -> bool {
    match v {
        Value::Bool(b) => *b as i64 == n,
        Value::Number(num) => num.as_i64().map(|i| i == n).unwrap_or_else(|| num.as_f64() == Some(n as f64)),
        _ => false,
    }
}

/// `x.get` on something that may not be a dict.
pub fn as_dict(v: &Value) -> Result<&Map<String, Value>, String> {
    v.as_object().ok_or_else(|| format!("'{}' object has no attribute 'get'", type_name(v)))
}

/// `x[key]` on something that may not be a dict, or lack the key.
pub fn subscript<'a>(v: &'a Value, key: &str) -> Result<&'a Value, String> {
    match v {
        Value::Object(map) => map.get(key).ok_or_else(|| str_repr(key)),
        Value::Array(_) => Err("list indices must be integers or slices, not str".into()),
        Value::String(_) => Err("string indices must be integers, not 'str'".into()),
        other => Err(format!("'{}' object is not subscriptable", type_name(other))),
    }
}

/// `list(v)` for anything `len()`-able a JSON value can be.
pub fn items(v: &Value) -> Result<Vec<Value>, String> {
    match v {
        Value::Array(a) => Ok(a.clone()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(m) => Ok(m.keys().map(|k| Value::String(k.clone())).collect()),
        other => Err(format!("object of type '{}' has no len()", type_name(other))),
    }
}

/// Iterating something that may not be iterable.
pub fn iterate(v: &Value) -> Result<Vec<Value>, String> {
    items(v).map_err(|_| format!("'{}' object is not iterable", type_name(v)))
}

/// `binascii.a2b_base64(data, strict_mode=False)`: skips junk, stops at a complete pad.
pub fn a2b_base64(data: &[u8]) -> Result<Vec<u8>, String> {
    fn decode(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(data.len() / 4 * 3);
    let (mut quad_pos, mut left, mut pads) = (0u8, 0u8, 0usize);
    for &c in data {
        if c == b'=' {
            if quad_pos >= 2 {
                pads += 1;
                if quad_pos as usize + pads >= 4 {
                    return Ok(out);
                }
            }
            continue;
        }
        let Some(v) = decode(c) else { continue };
        pads = 0;
        match quad_pos {
            0 => {
                quad_pos = 1;
                left = v;
            }
            1 => {
                quad_pos = 2;
                out.push((left << 2) | (v >> 4));
                left = v & 0x0f;
            }
            2 => {
                quad_pos = 3;
                out.push((left << 4) | (v >> 2));
                left = v & 0x03;
            }
            _ => {
                quad_pos = 0;
                out.push((left << 6) | v);
                left = 0;
            }
        }
    }
    match quad_pos {
        0 => Ok(out),
        1 => Err(format!(
            "Invalid base64-encoded string: number of data characters ({}) cannot be 1 more than a multiple of 4",
            out.len() / 3 * 4 + 1
        )),
        _ => Err("Incorrect padding".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rounding_matches_python() {
        assert_eq!(round_to(2.675, 2), 2.67);
        assert_eq!(round_to(0.125, 2), 0.12);
        assert_eq!(round_to(0.375, 2), 0.38);
        assert_eq!(round_to(2.5, 0), 2.0);
        assert_eq!(round_int(2.5).unwrap(), 2);
        assert_eq!(round_int(3.5).unwrap(), 4);
        assert!(round_to(-0.001, 2).is_sign_negative());
    }

    #[test]
    fn reprs() {
        assert_eq!(repr(&json!({"a": [1, 2.5, null, true, "it's"]})), r#"{'a': [1, 2.5, None, True, "it's"]}"#);
        assert_eq!(repr(&json!(1e20)), "1e+20");
        assert_eq!(str_repr("say \"hi\" it's"), r#"'say "hi" it\'s'"#);
    }

    #[test]
    fn conversions() {
        assert_eq!(int(&json!(" 1_000 ")).unwrap(), 1000);
        assert_eq!(int(&json!(3.9)).unwrap(), 3);
        assert_eq!(int(&json!("x")).unwrap_err(), "invalid literal for int() with base 10: 'x'");
        assert_eq!(int(&json!(null)).unwrap_err(), "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'");
        assert_eq!(to_float(&json!(" 2.5 ")).unwrap(), 2.5);
        assert!(to_float(&json!("1e")).is_err());
    }

    #[test]
    fn lenient_base64() {
        assert_eq!(a2b_base64(b"QQ==QQ==").unwrap(), b"A");
        assert_eq!(a2b_base64(b"Q!Q=!=").unwrap(), b"A");
        assert_eq!(a2b_base64(b"QUJD").unwrap(), b"ABC");
        assert_eq!(a2b_base64(b"QUJ").unwrap_err(), "Incorrect padding");
        assert!(a2b_base64(b"QUJDR").unwrap_err().contains("(5)"));
    }
}
