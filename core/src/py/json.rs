//! `json.loads` failures worded like `json.JSONDecodeError`.

use std::path::Path;

use anyhow::{anyhow, Result};
use serde_json::Value;

/// json.JSONDecodeError's message for the common syntax errors, with Python's line, column
/// and char position; serde's own message otherwise.
pub fn json_error(text: &str, err: &serde_json::Error) -> anyhow::Error {
    const KINDS: [(&str, &str); 7] = [
        ("key must be a string", "Expecting property name enclosed in double quotes"),
        ("expected `:`", "Expecting ':' delimiter"),
        ("expected `,` or `}`", "Expecting ',' delimiter"),
        ("expected `,` or `]`", "Expecting ',' delimiter"),
        ("trailing characters", "Extra data"),
        ("expected value", "Expecting value"),
        ("EOF while parsing a value", "Expecting value"),
    ];
    let message = err.to_string();
    let Some((serde, python)) = KINDS.iter().find(|(serde, _)| message.starts_with(serde)) else { return anyhow!(message) };
    let mut byte = if serde.starts_with("EOF") {
        text.len()
    } else {
        let line_start: usize = text.split_inclusive('\n').take(err.line().saturating_sub(1)).map(str::len).sum();
        (line_start + err.column().saturating_sub(1)).min(text.len())
    };
    while !text.is_char_boundary(byte) {
        byte -= 1;
    }
    let pos = text[..byte].chars().count();
    let line = text[..byte].matches('\n').count() + 1;
    let column = pos - text[..byte].rfind('\n').map(|i| text[..=i].chars().count()).unwrap_or(0) + 1;
    anyhow!("{}: line {} column {} (char {})", python, line, column, pos)
}

/// `response.json()`: a leading BOM skipped, errors as [`json_error`].
pub fn loads_bytes(bytes: &[u8]) -> Result<Value> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    serde_json::from_slice(bytes).map_err(|err| json_error(&String::from_utf8_lossy(bytes), &err))
}

/// A shorter `JSONDecodeError`-shaped message: only an early EOF is reworded, without the
/// char position (modfile, modder tools, mod manager).
pub fn json_error_short(e: &serde_json::Error) -> String {
    let what = match e.classify() {
        serde_json::error::Category::Eof => "Expecting value",
        _ => {
            let text = e.to_string();
            return text.rsplit_once(" at line").map(|(t, _)| t.to_string()).unwrap_or(text);
        }
    };
    format!("{}: line {} column {}", what, e.line(), e.column())
}

/// `json.loads(path.read_text(encoding="utf-8"))`, errors as [`json_error_short`].
pub fn read_json(path: &Path) -> Result<Value> {
    let text = super::read_text(path)?;
    serde_json::from_str(&text).map_err(|e| anyhow!(json_error_short(&e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_errors_like_python() {
        let cases = [
            ("{bad", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"),
            ("{\"a\" 1}", "Expecting ':' delimiter: line 1 column 6 (char 5)"),
            ("{\"a\": 1 \"b\"}", "Expecting ',' delimiter: line 1 column 9 (char 8)"),
            ("[1] x", "Extra data: line 1 column 5 (char 4)"),
            ("{\"a\": }", "Expecting value: line 1 column 7 (char 6)"),
            ("", "Expecting value: line 1 column 1 (char 0)"),
            ("  ", "Expecting value: line 1 column 3 (char 2)"),
            ("\n\n  <html>", "Expecting value: line 3 column 3 (char 4)"),
            ("{\"\u{e9}\": 1,\n \"b\" 2}", "Expecting ':' delimiter: line 2 column 6 (char 14)"),
        ];
        for (text, expected) in cases {
            let err = serde_json::from_str::<Value>(text).unwrap_err();
            assert_eq!(json_error(text, &err).to_string(), expected, "{text:?}");
        }
    }
}
