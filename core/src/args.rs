//! Positional arguments of an eel call, read with Python's loose conversions.

use serde::de::DeserializeOwned;
use serde_json::Value;

static NULL: Value = Value::Null;

#[derive(Debug, Clone, Default)]
pub struct Args(Vec<Value>);

impl Args {
    pub fn new(values: Vec<Value>) -> Self {
        Args(values)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The argument at `i`, or `null` when the page passed fewer.
    pub fn get(&self, i: usize) -> &Value {
        self.0.get(i).unwrap_or(&NULL)
    }

    /// True when the argument is missing or `null` (Python's default kicks in).
    pub fn is_none(&self, i: usize) -> bool {
        self.get(i).is_null()
    }

    /// `str(value or "")`.
    pub fn str(&self, i: usize) -> String {
        to_str(self.get(i))
    }

    /// `str(value or "").strip()`.
    pub fn trimmed(&self, i: usize) -> String {
        self.str(i).trim().to_string()
    }

    /// The string at `i` when it is present and not null.
    pub fn opt_str(&self, i: usize) -> Option<String> {
        match self.get(i) {
            Value::Null => None,
            v => Some(to_str(v)),
        }
    }

    pub fn str_or(&self, i: usize, default: &str) -> String {
        self.opt_str(i).unwrap_or_else(|| default.to_string())
    }

    /// Python truthiness of the argument, or `default` when missing/null.
    pub fn bool_or(&self, i: usize, default: bool) -> bool {
        match self.get(i) {
            Value::Null => default,
            v => truthy(v),
        }
    }

    pub fn f64_or(&self, i: usize, default: f64) -> f64 {
        to_f64(self.get(i)).unwrap_or(default)
    }

    pub fn i64_or(&self, i: usize, default: i64) -> i64 {
        to_i64(self.get(i)).unwrap_or(default)
    }

    /// Deserializes the argument at `i`.
    pub fn parse<T: DeserializeOwned>(&self, i: usize) -> anyhow::Result<T> {
        Ok(serde_json::from_value(self.get(i).clone())?)
    }

    pub fn into_vec(self) -> Vec<Value> {
        self.0
    }
}

/// Python `str()` of a JSON value, with `None`/`null` as "".
pub fn to_str(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        other => other.to_string(),
    }
}

/// Python truthiness.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `float(value)`, accepting numeric strings.
pub fn to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// `int(value)`, accepting numeric strings and truncating floats.
pub fn to_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => {
            let s = s.trim();
            s.parse::<i64>().ok()
        }
        Value::Bool(b) => Some(*b as i64),
        _ => None,
    }
}
