//! CPython behaviour the ported modules reproduce: `str()`/`repr()`/`int()` of JSON values,
//! str and bytes methods, number formatting, pathlib, OSError and JSONDecodeError text, and
//! text-mode file I/O.
//!
//! The ports approximated some builtins differently. Where those approximations give
//! different output, each is kept under its own name (`int` vs `int_ascii`, `repr_str` vs
//! `repr_str_ascii`, ...) so no module's answers changed when they moved here.

mod bytes;
mod fs;
mod json;
mod num;
mod path;
mod text;

pub use bytes::*;
pub use fs::*;
pub use json::*;
pub use num::*;
pub use path::*;
pub use text::*;

pub use crate::args::truthy;

use serde_json::{Map, Number, Value};

/// A Python exception's message. Converts into `anyhow::Error` and `String` with `?`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PyErr(pub String);

impl std::fmt::Display for PyErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PyErr {}

impl From<PyErr> for String {
    fn from(e: PyErr) -> String {
        e.0
    }
}

impl PartialEq<&str> for PyErr {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

fn err(msg: impl Into<String>) -> PyErr {
    PyErr(msg.into())
}

// --- types, str() and repr() ---------------------------------------------------------

/// `type(v).__name__` of the object a JSON value loads as.
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

/// `AttributeError: 'X' object has no attribute 'attr'`.
pub fn no_attr(v: &Value, attr: &str) -> anyhow::Error {
    anyhow::anyhow!("'{}' object has no attribute '{}'", type_name(v), attr)
}

fn number_str(n: &Number) -> String {
    match n.as_f64().filter(|_| n.is_f64()) {
        Some(f) => crate::json::float_repr(f),
        None => n.to_string(),
    }
}

fn repr_with(v: &Value, repr_s: fn(&str) -> String) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => number_str(n),
        Value::String(s) => repr_s(s),
        Value::Array(items) => format!("[{}]", items.iter().map(|i| repr_with(i, repr_s)).collect::<Vec<_>>().join(", ")),
        Value::Object(map) => {
            let items: Vec<String> = map.iter().map(|(k, v)| format!("{}: {}", repr_s(k), repr_with(v, repr_s))).collect();
            format!("{{{}}}", items.join(", "))
        }
    }
}

/// `repr(value)`, strings as [`repr_str`].
pub fn repr(v: &Value) -> String {
    repr_with(v, repr_str)
}

/// `repr(value)`, strings as [`repr_str_ascii`] (home).
pub fn repr_ascii(v: &Value) -> String {
    repr_with(v, repr_str_ascii)
}

/// `repr(value)`, strings as [`repr_str_latin1`] (gems).
pub fn repr_latin1(v: &Value) -> String {
    repr_with(v, repr_str_latin1)
}

/// `str(value)`: a string as is, anything else as [`repr`].
pub fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => repr(other),
    }
}

/// `str(value)`, nested strings as [`repr_str_ascii`] (home).
pub fn str_of_ascii(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => repr_ascii(other),
    }
}

/// `str(value)` approximated by [`crate::args::to_str`]: `None` for null, but floats and
/// containers print as JSON (file manager, auth).
pub fn str_loose(v: &Value) -> String {
    if v.is_null() {
        "None".into()
    } else {
        crate::args::to_str(v)
    }
}

/// [`str_loose`] with Python's float formatting (codex cache).
pub fn str_loose_pyfloat(v: &Value) -> String {
    match v {
        Value::Number(n) if n.is_f64() => crate::json::float_repr(n.as_f64().unwrap_or(0.0)),
        other => str_loose(other),
    }
}

// --- int() and float() ---------------------------------------------------------------

fn int_with(v: &Value, literal: impl Fn(&str) -> Option<i64>, quote: fn(&str) -> String) -> Result<i64, PyErr> {
    match v {
        Value::Bool(b) => Ok(*b as i64),
        Value::Number(n) => Ok(n.as_i64().unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64)),
        Value::String(s) => literal(s).ok_or_else(|| err(format!("invalid literal for int() with base 10: {}", quote(s)))),
        other => Err(err(format!("int() argument must be a string, a bytes-like object or a real number, not '{}'", type_name(other)))),
    }
}

/// `int(value)`: [`int_literal`], errors quoted with [`repr_str_latin1`] (gems).
pub fn int(v: &Value) -> Result<i64, PyErr> {
    int_with(v, int_literal, repr_str_latin1)
}

/// `int(value)`: Rust-trimmed [`int_literal_no_min`], errors quoted with [`repr_str_ascii`] (home).
pub fn int_ascii(v: &Value) -> Result<i64, PyErr> {
    int_with(v, |s| int_literal_no_min(s.trim()), repr_str_ascii)
}

/// `int(value)`: Python-stripped [`int_literal_no_min`], errors quoted with [`repr_str`].
pub fn int_lenient(v: &Value) -> Result<i64, PyErr> {
    int_with(v, |s| int_literal_no_min(strip(s)), repr_str)
}

/// `int(value)` as Rust parses it: trimmed, no underscores (file manager).
pub fn int_loose(v: &Value) -> Result<i64, PyErr> {
    int_with(v, |s| s.trim().parse().ok(), repr_str_ascii)
}

/// `int(value)` with underscores dropped unless leading, trailing or doubled (auth).
pub fn int_loose_underscores(v: &Value) -> Result<i64, PyErr> {
    let literal = |s: &str| {
        let t = s.trim();
        let n = t.replace('_', "").parse::<i64>().ok()?;
        (!t.starts_with('_') && !t.ends_with('_') && !s.contains("__")).then_some(n)
    };
    int_with(v, literal, repr_str_ascii)
}

/// `int(value)` with every underscore dropped; errors quote the raw text (codex cache).
pub fn int_strip_underscores(v: &Value) -> Result<i64, PyErr> {
    int_with(v, |s| strip(s).replace('_', "").parse().ok(), |s| format!("'{}'", s))
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

/// `int(str)` in base 10.
pub fn int_literal(s: &str) -> Option<i64> {
    let t = without_underscores(strip(s))?;
    let digits = t.strip_prefix(['+', '-']).unwrap_or(&t);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse().ok()
}

/// [`int_literal`] on already stripped text, except `-9223372036854775808` is rejected.
pub fn int_literal_no_min(t: &str) -> Option<i64> {
    let (neg, digits) = match t.as_bytes().first()? {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    if digits.is_empty() || digits.starts_with('_') || digits.ends_with('_') || digits.contains("__") {
        return None;
    }
    let clean: String = digits.chars().filter(|&c| c != '_').collect();
    if !clean.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: i64 = clean.parse().ok()?;
    Some(if neg { -n } else { n })
}

/// `float(str)`.
pub fn float_literal(s: &str) -> Option<f64> {
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

/// `float(value)`.
pub fn to_float(v: &Value) -> Result<f64, PyErr> {
    match v {
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => float_literal(s).ok_or_else(|| err(format!("could not convert string to float: {}", repr_str_latin1(s)))),
        other => Err(err(format!("float() argument must be a string or a real number, not '{}'", type_name(other)))),
    }
}

/// `isinstance(v, int)`, bools included, as an index.
pub fn as_int(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) if !n.is_f64() => n.as_i64(),
        _ => None,
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

/// `v == n` for a JSON value against an int.
pub fn eq_int(v: &Value, n: i64) -> bool {
    match v {
        Value::Bool(b) => *b as i64 == n,
        Value::Number(num) => num.as_i64().map(|i| i == n).unwrap_or_else(|| num.as_f64() == Some(n as f64)),
        _ => false,
    }
}

// --- containers ----------------------------------------------------------------------

/// `list(v)` for anything `len()`-able a JSON value can be.
pub fn items(v: &Value) -> Result<Vec<Value>, PyErr> {
    match v {
        Value::Array(a) => Ok(a.clone()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(m) => Ok(m.keys().map(|k| Value::String(k.clone())).collect()),
        other => Err(err(format!("object of type '{}' has no len()", type_name(other)))),
    }
}

/// `for x in value`: list items, dict keys, or a string's characters.
pub fn iterate(v: &Value) -> Result<Vec<Value>, PyErr> {
    items(v).map_err(|_| err(format!("'{}' object is not iterable", type_name(v))))
}

/// `value.get(...)` needs a dict.
pub fn as_dict(v: &Value) -> Result<&Map<String, Value>, PyErr> {
    v.as_object().ok_or_else(|| err(format!("'{}' object has no attribute 'get'", type_name(v))))
}

/// `(value or {})` followed by `.get`.
pub fn dict_or_empty(v: &Value) -> Result<&Map<String, Value>, PyErr> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    if !truthy(v) {
        return Ok(EMPTY.get_or_init(Map::new));
    }
    as_dict(v)
}

/// `d.get(key)`.
pub fn get<'a>(d: &'a Map<String, Value>, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    d.get(key).unwrap_or(&NULL)
}

/// `value.get(key)` on a dict, `None` on anything else.
pub fn get_any<'a>(v: &'a Value, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    v.get(key).unwrap_or(&NULL)
}

/// `value.get(key)`, raising for a non-dict receiver.
pub fn dict_get<'a>(obj: &'a Value, key: &str) -> Result<Option<&'a Value>, PyErr> {
    Ok(as_dict(obj)?.get(key))
}

/// `x[key]` on something that may not be a dict, or lack the key.
pub fn subscript<'a>(v: &'a Value, key: &str) -> Result<&'a Value, PyErr> {
    match v {
        Value::Object(map) => map.get(key).ok_or_else(|| err(repr_str_latin1(key))),
        Value::Array(_) => Err(err("list indices must be integers or slices, not str")),
        Value::String(_) => Err(err("string indices must be integers, not 'str'")),
        other => Err(err(format!("'{}' object is not subscriptable", type_name(other)))),
    }
}

/// `a or b`.
pub fn or<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if truthy(a) {
        a
    } else {
        b
    }
}

/// `value.strip()`, raising for a non-string.
pub fn strip_value(v: &Value) -> Result<String, PyErr> {
    match v {
        Value::String(s) => Ok(strip(s).to_string()),
        other => Err(err(format!("'{}' object has no attribute 'strip'", type_name(other)))),
    }
}

// --- datetime ------------------------------------------------------------------------

/// `datetime.now(UTC).isoformat()`.
pub fn isoformat_utc(now: chrono::DateTime<chrono::Utc>) -> String {
    use chrono::Timelike;
    let micros = now.nanosecond() / 1000 % 1_000_000;
    if micros == 0 {
        now.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        format!("{}.{:06}+00:00", now.format("%Y-%m-%dT%H:%M:%S"), micros)
    }
}

/// `datetime.utcnow().isoformat() + "Z"`.
pub fn utcnow_iso_z() -> String {
    let now = chrono::Utc::now();
    if now.timestamp_subsec_micros() == 0 {
        now.format("%Y-%m-%dT%H:%M:%SZ").to_string()
    } else {
        now.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn python_strings() {
        assert_eq!(str_of_ascii(&json!(null)), "None");
        assert_eq!(str_of_ascii(&json!(1.0)), "1.0");
        assert_eq!(repr_ascii(&json!({"a": [1, "b'"]})), "{'a': [1, \"b'\"]}");
        assert_eq!(int_ascii(&json!(" 12 ")).unwrap(), 12);
        assert_eq!(int_ascii(&json!(3.9)).unwrap(), 3);
        assert_eq!(int_ascii(&json!("1.5")).unwrap_err().to_string(), "invalid literal for int() with base 10: '1.5'");
    }

    #[test]
    fn reprs() {
        assert_eq!(repr_latin1(&json!({"a": [1, 2.5, null, true, "it's"]})), r#"{'a': [1, 2.5, None, True, "it's"]}"#);
        assert_eq!(repr_latin1(&json!(1e20)), "1e+20");
        assert_eq!(repr_str_latin1("say \"hi\" it's"), r#"'say "hi" it\'s'"#);
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
    fn int_flavours_differ_only_where_documented() {
        assert_eq!(int(&json!("-9223372036854775808")).unwrap(), i64::MIN);
        assert!(int_ascii(&json!("-9223372036854775808")).is_err());
        assert_eq!(int(&json!("\x1c5")).unwrap(), 5);
        assert!(int_ascii(&json!("\x1c5")).is_err());
        assert_eq!(int_lenient(&json!("\x1c5")).unwrap(), 5);
        assert!(int_loose(&json!("1_0")).is_err());
        assert_eq!(int_loose_underscores(&json!("1_0")).unwrap(), 10);
        assert_eq!(int_strip_underscores(&json!("x")).unwrap_err(), "invalid literal for int() with base 10: 'x'");
    }

    #[test]
    fn isoformat_drops_zero_micros() {
        use chrono::TimeZone;
        let t = chrono::Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        assert_eq!(isoformat_utc(t), "2026-01-02T03:04:05+00:00");
        assert_eq!(isoformat_utc(t + chrono::Duration::microseconds(120)), "2026-01-02T03:04:05.000120+00:00");
    }
}
