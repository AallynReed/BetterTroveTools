//! The slice of pydantic v2 (lax mode) the gem models use: coercions and the
//! `ValidationError` text the page shows when one fails.

use serde_json::{Map, Value};

use super::py::{parse_float_literal, parse_int_literal, repr, strip, type_name};

const PYDANTIC_DOCS: &str = "https://errors.pydantic.dev/2.12/v/";

/// One failed check: pydantic's message and error type.
pub struct Fail {
    msg: String,
    kind: &'static str,
}

fn fail(msg: impl Into<String>, kind: &'static str) -> Fail {
    Fail { msg: msg.into(), kind }
}

struct Item {
    loc: String,
    msg: String,
    kind: &'static str,
    input: String,
    input_type: &'static str,
}

/// Collects the errors of one model validation, like `ValidationError`.
pub struct Errors {
    model: &'static str,
    items: Vec<Item>,
}

impl Errors {
    pub fn new(model: &'static str) -> Self {
        Errors { model, items: Vec::new() }
    }

    pub fn push(&mut self, loc: &str, f: Fail, input: &Value) {
        let mut input_repr = repr(input);
        let chars: Vec<char> = input_repr.chars().collect();
        if chars.len() > 50 {
            input_repr = format!("{}...{}", chars[..25].iter().collect::<String>(), chars[chars.len() - 24..].iter().collect::<String>());
        }
        self.items.push(Item { loc: loc.to_string(), msg: f.msg, kind: f.kind, input: input_repr, input_type: type_name(input) });
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// `str(ValidationError)`.
    pub fn message(&self) -> String {
        let n = self.items.len();
        let mut out = format!("{} validation error{} for {}", n, if n == 1 { "" } else { "s" }, self.model);
        for it in &self.items {
            out.push_str(&format!(
                "\n{}\n  {} [type={}, input_value={}, input_type={}]\n    For further information visit {}{}",
                it.loc, it.msg, it.kind, it.input, it.input_type, PYDANTIC_DOCS, it.kind
            ));
        }
        out
    }

    /// Validates field `key` of `obj`: `default` when absent (or "Field required").
    pub fn field<T>(
        &mut self,
        obj: &Map<String, Value>,
        prefix: &str,
        key: &str,
        default: Option<fn() -> T>,
        check: impl FnOnce(&mut Self, &str, &Value) -> Result<T, Fail>,
    ) -> Option<T> {
        let loc = if prefix.is_empty() { key.to_string() } else { format!("{prefix}.{key}") };
        match obj.get(key) {
            None => match default {
                Some(d) => Some(d()),
                None => {
                    self.push(&loc, fail("Field required", "missing"), &Value::Object(obj.clone()));
                    None
                }
            },
            Some(v) => match check(self, &loc, v) {
                Ok(t) => Some(t),
                Err(f) => {
                    self.push(&loc, f, v);
                    None
                }
            },
        }
    }
}

/// `int` in lax mode.
pub fn int(v: &Value) -> Result<i64, Fail> {
    match v {
        Value::Bool(b) => Ok(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return Ok(i);
            }
            let f = n.as_f64().unwrap_or(f64::NAN);
            if !f.is_finite() {
                Err(fail("Input should be a finite number", "finite_number"))
            } else if f.fract() != 0.0 {
                Err(fail("Input should be a valid integer, got a number with a fractional part", "int_from_float"))
            } else if f.abs() >= 9.223372036854776e18 {
                Err(fail("Unable to parse input string as an integer, exceeded maximum size", "int_parsing_size"))
            } else {
                Ok(f as i64)
            }
        }
        Value::String(s) => {
            let t = strip(s);
            let whole = t.find('.').filter(|&dot| !t[dot + 1..].is_empty() && t[dot + 1..].chars().all(|c| c == '0')).map(|dot| &t[..dot]);
            parse_int_literal(whole.unwrap_or(t))
                .ok_or_else(|| fail("Input should be a valid integer, unable to parse string as an integer", "int_parsing"))
        }
        _ => Err(fail("Input should be a valid integer", "int_type")),
    }
}

/// `float` in lax mode.
pub fn float(v: &Value) -> Result<f64, Fail> {
    match v {
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => {
            parse_float_literal(s).ok_or_else(|| fail("Input should be a valid number, unable to parse string as a number", "float_parsing"))
        }
        _ => Err(fail("Input should be a valid number", "float_type")),
    }
}

/// `bool` in lax mode.
pub fn boolean(v: &Value) -> Result<bool, Fail> {
    let unparsable = || fail("Input should be a valid boolean, unable to interpret input", "bool_parsing");
    match v {
        Value::Bool(b) => Ok(*b),
        Value::Number(n) => match n.as_f64() {
            Some(0.0) => Ok(false),
            Some(1.0) => Ok(true),
            _ => Err(unparsable()),
        },
        Value::String(s) => match s.to_lowercase().as_str() {
            "0" | "off" | "f" | "false" | "n" | "no" => Ok(false),
            "1" | "on" | "t" | "true" | "y" | "yes" => Ok(true),
            _ => Err(unparsable()),
        },
        _ => Err(fail("Input should be a valid boolean", "bool_type")),
    }
}

pub fn string(v: &Value) -> Result<String, Fail> {
    v.as_str().map(str::to_string).ok_or_else(|| fail("Input should be a valid string", "string_type"))
}

/// "Input should be 1, 2 or 3".
fn expected(options: &[String]) -> String {
    match options.split_last() {
        None => "Input should be".into(),
        Some((last, [])) => format!("Input should be {last}"),
        Some((last, rest)) => format!("Input should be {} or {}", rest.join(", "), last),
    }
}

/// An `IntEnum` field: anything lax `int` accepts, if it names a member.
pub fn int_enum(v: &Value, values: &[i64]) -> Result<i64, Fail> {
    match int(v) {
        Ok(i) if values.contains(&i) => Ok(i),
        _ => Err(fail(expected(&values.iter().map(|v| v.to_string()).collect::<Vec<_>>()), "enum")),
    }
}

/// A str-valued `Enum` field: the value must match exactly. Returns its index.
pub fn str_enum(v: &Value, values: &[&str]) -> Result<usize, Fail> {
    v.as_str()
        .and_then(|s| values.iter().position(|x| *x == s))
        .ok_or_else(|| fail(expected(&values.iter().map(|v| format!("'{v}'")).collect::<Vec<_>>()), "enum"))
}

pub fn list(v: &Value) -> Result<&Vec<Value>, Fail> {
    v.as_array().ok_or_else(|| fail("Input should be a valid list", "list_type"))
}

pub fn model<'a>(v: &'a Value, name: &str) -> Result<&'a Map<String, Value>, Fail> {
    v.as_object().ok_or_else(|| fail(format!("Input should be a valid dictionary or instance of {name}"), "model_type"))
}

/// `Model(**v)` with `v` not a dict.
pub fn not_a_mapping(qualname: &str, v: &Value) -> String {
    format!("{qualname}() argument after ** must be a mapping, not {}", type_name(v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_format() {
        let mut e = Errors::new("BuildConfig");
        e.push("light", int(&json!("x".repeat(100))).err().unwrap(), &json!("x".repeat(100)));
        assert_eq!(
            e.message(),
            "1 validation error for BuildConfig\nlight\n  Input should be a valid integer, unable to parse string as an integer [type=int_parsing, input_value='xxxxxxxxxxxxxxxxxxxxxxxx...xxxxxxxxxxxxxxxxxxxxxxx', input_type=str]\n    For further information visit https://errors.pydantic.dev/2.12/v/int_parsing"
        );
    }

    #[test]
    fn lax_coercions() {
        assert_eq!(int(&json!("7.0")).ok(), Some(7));
        assert_eq!(int(&json!("1_000")).ok(), Some(1000));
        assert!(int(&json!("7.5")).is_err());
        assert_eq!(int_enum(&json!("01"), &[1, 2, 3]).ok(), Some(1));
        assert!(int_enum(&json!(false), &[1, 2, 3]).is_err());
        assert!(boolean(&json!("TRUE ")).is_err());
        assert_eq!(boolean(&json!("Yes")).ok(), Some(true));
    }
}
