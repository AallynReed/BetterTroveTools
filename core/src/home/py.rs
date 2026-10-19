//! Python semantics the home maths and payload handling depend on.

use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};

use crate::args::truthy;

/// Python's float `divmod(a, b)` (CPython `float_divmod`).
pub fn divmod(a: f64, b: f64) -> (f64, f64) {
    let mut m = a % b;
    let mut div = (a - m) / b;
    if m != 0.0 {
        if (b < 0.0) != (m < 0.0) {
            m += b;
            div -= 1.0;
        }
    } else {
        m = 0.0_f64.copysign(b);
    }
    let floordiv = if div != 0.0 {
        let f = div.floor();
        if div - f > 0.5 {
            f + 1.0
        } else {
            f
        }
    } else {
        0.0_f64.copysign(a / b)
    };
    (floordiv, m)
}

/// `a // b` for floats.
pub fn floordiv(a: f64, b: f64) -> f64 {
    divmod(a, b).0
}

/// `a % b` for floats.
pub fn rem(a: f64, b: f64) -> f64 {
    divmod(a, b).1
}

/// `timedelta(seconds=x)` in microseconds, rounded the way CPython's `delta_new` does.
pub fn seconds_to_us(x: f64) -> i64 {
    let whole = x.trunc();
    let frac = x - whole;
    let mut us = whole as i64 * 1_000_000;
    if frac == 0.0 {
        return us;
    }
    let scaled = frac * 1e6;
    let scaled_whole = scaled.trunc();
    let leftover = scaled - scaled_whole;
    us += scaled_whole as i64;
    if leftover != 0.0 {
        let mut rounded = leftover.round();
        if (rounded - leftover).abs() == 0.5 {
            let odd = (us & 1) as f64;
            rounded = 2.0 * ((leftover + odd) * 0.5).round() - odd;
        }
        us += rounded as i64;
    }
    us
}

/// Python's type name for a JSON value, as error messages print it.
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

/// `str(value)`.
pub fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => repr(other),
    }
}

/// `repr(value)`.
pub fn repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => match n.as_f64().filter(|_| n.is_f64()) {
            Some(f) => crate::json::float_repr(f),
            None => n.to_string(),
        },
        Value::String(s) => repr_str(s),
        Value::Array(items) => format!("[{}]", items.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(map) => {
            let items: Vec<String> = map.iter().map(|(k, v)| format!("{}: {}", repr_str(k), repr(v))).collect();
            format!("{{{}}}", items.join(", "))
        }
    }
}

/// `repr(str)`: single quotes unless the text holds a `'` and no `"`.
pub fn repr_str(s: &str) -> String {
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
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// `str.title()`.
pub fn title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_cased = false;
    for c in s.chars() {
        if prev_cased {
            out.extend(c.to_lowercase());
        } else {
            out.extend(c.to_uppercase());
        }
        prev_cased = c.is_lowercase() || c.is_uppercase();
    }
    out
}

/// `int(value)`.
pub fn int(v: &Value) -> Result<i64> {
    match v {
        Value::Bool(b) => Ok(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return Ok(i);
            }
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_nan() {
                bail!("cannot convert float NaN to integer");
            }
            if f.is_infinite() {
                bail!("cannot convert float infinity to integer");
            }
            Ok(f.trunc() as i64)
        }
        Value::String(s) => parse_int(s).ok_or_else(|| anyhow!("invalid literal for int() with base 10: {}", repr_str(s))),
        other => bail!("int() argument must be a string, a bytes-like object or a real number, not '{}'", type_name(other)),
    }
}

fn parse_int(s: &str) -> Option<i64> {
    let t = s.trim();
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

/// `isinstance(v, int)`, bools included, as an index.
pub fn as_int(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) if !n.is_f64() => n.as_i64(),
        _ => None,
    }
}

/// `for x in value`: list items, dict keys, or a string's characters.
pub fn iterate(v: &Value) -> Result<Vec<Value>> {
    match v {
        Value::Array(items) => Ok(items.clone()),
        Value::Object(map) => Ok(map.keys().map(|k| Value::String(k.clone())).collect()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        other => bail!("'{}' object is not iterable", type_name(other)),
    }
}

/// `value.get(...)` needs a dict.
pub fn as_dict(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object().ok_or_else(|| anyhow!("'{}' object has no attribute 'get'", type_name(v)))
}

static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();

/// `(value or {})` followed by `.get`.
pub fn dict_or_empty(v: &Value) -> Result<&Map<String, Value>> {
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

/// `a or b`.
pub fn or<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if truthy(a) {
        a
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn float_division_matches_python() {
        assert_eq!(divmod(7.5, 2.0), (3.0, 1.5));
        assert_eq!(divmod(-7.5, 2.0), (-4.0, 0.5));
        assert_eq!(rem(-1.0, 4.0), 3.0);
        assert_eq!(floordiv(-0.5, 604800.0), -1.0);
    }

    #[test]
    fn timedelta_seconds_rounding() {
        assert_eq!(seconds_to_us(1.5), 1_500_000);
        assert_eq!(seconds_to_us(0.0000005), 0);
        assert_eq!(seconds_to_us(0.0000015), 2);
        assert_eq!(seconds_to_us(1234.567891), 1_234_567_891);
        assert_eq!(seconds_to_us(0.0000025), 2);
        assert_eq!(seconds_to_us(10799.9999995), 10_799_999_999);
    }

    #[test]
    fn python_strings() {
        assert_eq!(str_of(&json!(null)), "None");
        assert_eq!(str_of(&json!(1.0)), "1.0");
        assert_eq!(repr(&json!({"a": [1, "b'"]})), "{'a': [1, \"b'\"]}");
        assert_eq!(title("rampage"), "Rampage");
        assert_eq!(title("boss_rush 2x"), "Boss_Rush 2X");
        assert_eq!(int(&json!(" 12 ")).unwrap(), 12);
        assert_eq!(int(&json!(3.9)).unwrap(), 3);
        assert_eq!(int(&json!("1.5")).unwrap_err().to_string(), "invalid literal for int() with base 10: '1.5'");
    }
}
