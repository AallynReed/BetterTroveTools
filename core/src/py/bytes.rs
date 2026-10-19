//! `bytes` methods, decoding with CPython's error text, and binascii's lenient base64.

use std::fmt::Write as _;

use super::{err, PyErr};

/// `bytes.decode("latin-1")`.
pub fn latin1(raw: &[u8]) -> String {
    raw.iter().map(|&b| b as char).collect()
}

/// `bytes.decode("ascii", errors="ignore")`.
pub fn ascii_ignore(raw: &[u8]) -> String {
    raw.iter().filter(|b| b.is_ascii()).map(|&b| b as char).collect()
}

/// `bytes.decode("utf-8", errors="ignore")`.
pub fn utf8_ignore(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.utf8_chunks().map(|c| c.valid()).collect(),
    }
}

/// `bytes.decode("utf-8")`, failing with the `UnicodeDecodeError` text Python gives.
pub fn utf8(b: &[u8]) -> Result<&str, PyErr> {
    std::str::from_utf8(b).map_err(|e| {
        let at = e.valid_up_to();
        let (end, reason) = match e.error_len() {
            None => (b.len(), "unexpected end of data"),
            Some(1) if !matches!(b[at], 0xC2..=0xF4) => (at + 1, "invalid start byte"),
            Some(n) => (at + n, "invalid continuation byte"),
        };
        if end - at == 1 {
            err(format!("'utf-8' codec can't decode byte 0x{:02x} in position {at}: {reason}", b[at]))
        } else {
            err(format!("'utf-8' codec can't decode bytes in position {at}-{}: {reason}", end - 1))
        }
    })
}

/// `bytes.decode("utf-8-sig", errors="replace")`.
pub fn decode_lossy_sig(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// True for bytes 32..127 (the `all(32 <= b < 127 ...)` checks).
pub fn printable(raw: &[u8]) -> bool {
    raw.iter().all(|&b| (32..127).contains(&b))
}

/// `haystack.find(needle, start)`.
pub fn find(haystack: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if start > haystack.len() {
        return None;
    }
    if needle.is_empty() {
        return Some(start);
    }
    let (first, rest) = (needle[0], &needle[1..]);
    let last_start = haystack.len().checked_sub(needle.len())?;
    let mut i = start;
    while i <= last_start {
        let off = haystack[i..=last_start].iter().position(|&b| b == first)?;
        i += off;
        if &haystack[i + 1..i + needle.len()] == rest {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// `haystack.rfind(needle)`.
pub fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).rev().find(|&i| haystack[i..].starts_with(needle))
}

/// `needle in haystack`.
pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle, 0).is_some()
}

/// `data[start:end]` with Python's clamping.
pub fn slice(data: &[u8], start: usize, end: usize) -> &[u8] {
    let end = end.min(data.len());
    &data[start.min(end)..end]
}

/// `data[start:stop]` with negative indices counted from the end.
pub fn slice_signed(data: &[u8], start: i64, stop: i64) -> &[u8] {
    let len = data.len() as i64;
    let norm = |i: i64| if i < 0 { (i + len).max(0) } else { i.min(len) };
    let (start, stop) = (norm(start), norm(stop));
    if start >= stop {
        &[]
    } else {
        &data[start as usize..stop as usize]
    }
}

/// `hex().upper()`.
pub fn hex_upper(raw: &[u8]) -> String {
    hex::encode_upper(raw)
}

/// `repr(bytes)`.
pub fn repr_bytes(b: &[u8]) -> String {
    let quote = if b.contains(&b'\'') && !b.contains(&b'"') { '"' } else { '\'' };
    let mut out = String::from("b");
    out.push(quote);
    for &c in b {
        match c {
            b'\\' => out.push_str("\\\\"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            c if c as char == quote => {
                out.push('\\');
                out.push(c as char);
            }
            0x20..=0x7e => out.push(c as char),
            c => {
                let _ = write!(out, "\\x{c:02x}");
            }
        }
    }
    out.push(quote);
    out
}

/// `binascii.a2b_base64(data, strict_mode=False)`: skips junk, stops at a complete pad.
pub fn a2b_base64(data: &[u8]) -> Result<Vec<u8>, PyErr> {
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
        1 => Err(err(format!(
            "Invalid base64-encoded string: number of data characters ({}) cannot be 1 more than a multiple of 4",
            out.len() / 3 * 4 + 1
        ))),
        _ => Err(err("Incorrect padding")),
    }
}

/// `base64.b64decode(text)`: [`a2b_base64`] after str's ASCII check.
pub fn b64decode(text: &str) -> Result<Vec<u8>, PyErr> {
    if !text.is_ascii() {
        return Err(err("string argument should contain only ASCII characters"));
    }
    a2b_base64(text.as_bytes())
}

/// `base64.b64encode(data).decode()`.
pub fn b64encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_search() {
        assert_eq!(find(b"abcabc", b"ca", 0), Some(2));
        assert_eq!(find(b"abcabc", b"abc", 1), Some(3));
        assert_eq!(find(b"abc", b"", 2), Some(2));
        assert_eq!(find(b"abc", b"d", 0), None);
        assert_eq!(rfind(b"_UIx_UI", b"_UI"), Some(4));
        assert_eq!(utf8_ignore(b"a\xffb\xe2\x82"), "ab");
    }

    #[test]
    fn slices_like_python() {
        assert_eq!(slice_signed(b"0123456789", 8, 13), b"89");
        assert_eq!(slice_signed(b"0123456789", 12, 17), b"");
        assert_eq!(slice(b"0123", 3, 9), b"3");
    }

    #[test]
    fn utf8_errors_match_cpython() {
        let msg = |b: &[u8]| utf8(b).unwrap_err().to_string();
        assert_eq!(msg(b"ab\xff"), "'utf-8' codec can't decode byte 0xff in position 2: invalid start byte");
        assert_eq!(msg(b"\xe4\xb8"), "'utf-8' codec can't decode bytes in position 0-1: unexpected end of data");
        assert_eq!(msg(b"\xe4A"), "'utf-8' codec can't decode byte 0xe4 in position 0: invalid continuation byte");
        assert_eq!(msg(b"\xe4\xb8A"), "'utf-8' codec can't decode bytes in position 0-1: invalid continuation byte");
    }

    #[test]
    fn lenient_base64() {
        assert_eq!(a2b_base64(b"QQ==QQ==").unwrap(), b"A");
        assert_eq!(a2b_base64(b"Q!Q=!=").unwrap(), b"A");
        assert_eq!(a2b_base64(b"QUJD").unwrap(), b"ABC");
        assert_eq!(a2b_base64(b"QUJ").unwrap_err(), "Incorrect padding");
        assert!(a2b_base64(b"QUJDR").unwrap_err().0.contains("(5)"));
        assert_eq!(a2b_base64(b"aGVsbG8=").unwrap(), b"hello");
        assert_eq!(a2b_base64(b"ab=c=d").unwrap(), b"i\xb7");
        assert_eq!(a2b_base64(b"aGV\nsbG8").unwrap_err(), "Incorrect padding");
        assert_eq!(b64decode("aGk=").unwrap(), b"hi");
        assert_eq!(b64decode("a").unwrap_err(), "Invalid base64-encoded string: number of data characters (1) cannot be 1 more than a multiple of 4");
        assert!(b64decode("aé").is_err());
    }
}
