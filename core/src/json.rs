//! Python `json.dumps` output, byte for byte, for files the Python build also reads
//! and for anything that gets hashed.

use serde_json::Value;

#[derive(Debug, Clone, Copy)]
pub struct DumpOpts {
    pub indent: Option<usize>,
    pub ensure_ascii: bool,
    /// `(", ", ": ")` by default; `(",", ":")` for compact output.
    pub compact: bool,
    pub sort_keys: bool,
}

impl Default for DumpOpts {
    fn default() -> Self {
        DumpOpts { indent: None, ensure_ascii: true, compact: false, sort_keys: false }
    }
}

/// `json.dumps(value)`.
pub fn dumps(value: &Value) -> String {
    dumps_with(value, DumpOpts::default())
}

/// `json.dumps(value, indent=n)`.
pub fn dumps_indent(value: &Value, indent: usize) -> String {
    dumps_with(value, DumpOpts { indent: Some(indent), ..Default::default() })
}

/// `json.dumps(value, indent=n, ensure_ascii=False)`.
pub fn dumps_indent_utf8(value: &Value, indent: usize) -> String {
    dumps_with(value, DumpOpts { indent: Some(indent), ensure_ascii: false, ..Default::default() })
}

pub fn dumps_with(value: &Value, opts: DumpOpts) -> String {
    let mut out = String::new();
    write_value(&mut out, value, &opts, 0);
    out
}

fn newline(out: &mut String, opts: &DumpOpts, depth: usize) {
    if let Some(n) = opts.indent {
        out.push('\n');
        for _ in 0..n * depth {
            out.push(' ');
        }
    }
}

fn write_value(out: &mut String, value: &Value, opts: &DumpOpts, depth: usize) {
    let item_sep = if opts.indent.is_some() || opts.compact { "," } else { ", " };
    let key_sep = if opts.compact { ":" } else { ": " };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(f) = n.as_f64().filter(|_| n.is_f64()) {
                out.push_str(&float_repr(f));
            } else {
                out.push_str(&n.to_string());
            }
        }
        Value::String(s) => write_str(out, s, opts.ensure_ascii),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                newline(out, opts, depth + 1);
                write_value(out, item, opts, depth + 1);
            }
            newline(out, opts, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            let mut entries: Vec<_> = map.iter().collect();
            if opts.sort_keys {
                entries.sort_by(|a, b| a.0.cmp(b.0));
            }
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                newline(out, opts, depth + 1);
                write_str(out, k, opts.ensure_ascii);
                out.push_str(key_sep);
                write_value(out, v, opts, depth + 1);
            }
            newline(out, opts, depth);
            out.push('}');
        }
    }
}

/// Python's `repr(float)`.
pub fn float_repr(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == f.trunc() && f.abs() < 1e16 {
        return format!("{:.1}", f);
    }
    let s = format!("{}", f);
    let abs = f.abs();
    if abs != 0.0 && (abs < 1e-4 || abs >= 1e16) {
        // Python switches to exponent notation here: 1e-05, 1.5e+16.
        let e = format!("{:e}", f);
        if let Some((mant, exp)) = e.split_once('e') {
            let exp: i32 = exp.parse().unwrap_or(0);
            let sign = if exp < 0 { '-' } else { '+' };
            return format!("{}e{}{:02}", mant, sign, exp.abs());
        }
    }
    s
}

fn write_str(out: &mut String, s: &str, ensure_ascii: bool) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if ensure_ascii && (c as u32) > 0x7e => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_python_defaults() {
        let v = json!({"a": [1, 2.5, "é"], "b": {}, "c": 1.0});
        assert_eq!(dumps(&v), "{\"a\": [1, 2.5, \"\\u00e9\"], \"b\": {}, \"c\": 1.0}");
        assert_eq!(dumps_indent(&json!({"a": [1]}), 4), "{\n    \"a\": [\n        1\n    ]\n}");
        assert_eq!(float_repr(1e-5), "1e-05");
        assert_eq!(float_repr(0.1), "0.1");
    }
}
