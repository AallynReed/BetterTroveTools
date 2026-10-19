//! The bits of Python string, bytes and path behaviour the codex builders lean on.

use std::path::Path;

/// `str.isspace()`: Rust's whitespace plus the ASCII separators 0x1C-0x1F.
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// `str.strip()`.
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `str.split()`.
pub fn split_ws(s: &str) -> impl Iterator<Item = &str> {
    s.split(is_space).filter(|p| !p.is_empty())
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

/// `str.isalnum()`-ish test for one character of a `\w` class.
pub fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `Path(p).name` for a game-relative path (either separator).
pub fn name(path: &str) -> &str {
    path.rsplit(['/', '\\']).find(|p| !p.is_empty() && *p != ".").unwrap_or("")
}

/// `Path(p).stem` (Python 3.14: a trailing dot is a suffix, a dot-only stem is not).
pub fn stem(path: &str) -> &str {
    let name = name(path);
    if let Some(i) = name.rfind('.') {
        let stem = &name[..i];
        if !stem.trim_start_matches('.').is_empty() {
            return stem;
        }
    }
    name
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

/// `bytes.decode("latin1")`.
pub fn latin1(raw: &[u8]) -> String {
    raw.iter().map(|&b| b as char).collect()
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

pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle, 0).is_some()
}

/// `data[start:end]` with Python's clamping.
pub fn slice(data: &[u8], start: usize, end: usize) -> &[u8] {
    let end = end.min(data.len());
    &data[start.min(end)..end]
}

/// `hex().upper()`.
pub fn hex_upper(raw: &[u8]) -> String {
    hex::encode_upper(raw)
}

/// `str(int(value))` for a finite float.
pub fn int_str(value: f64) -> String {
    let t = value.trunc();
    if t == 0.0 {
        return "0".into();
    }
    if t.abs() < 9.0e15 {
        return (t as i64).to_string();
    }
    format!("{:.0}", t)
}

/// `round(value, ndigits)`: the float nearest the correctly rounded decimal.
pub fn round_to(value: f64, ndigits: usize) -> f64 {
    format!("{:.*}", ndigits, value).parse().unwrap_or(value)
}

/// `str(path)` the way pathlib prints it: native separators, no `.` parts, no doubled
/// or trailing separator.
pub fn path_str(path: &Path) -> String {
    normalize_path(&path.to_string_lossy())
}

pub fn normalize_path(raw: &str) -> String {
    if cfg!(windows) {
        let s = raw.replace('/', "\\");
        let (prefix, rest) = split_windows_root(&s);
        let parts: Vec<&str> = rest.split('\\').filter(|p| !p.is_empty() && *p != ".").collect();
        let joined = format!("{}{}", prefix, parts.join("\\"));
        if joined.is_empty() {
            ".".into()
        } else {
            joined
        }
    } else {
        let lead = if raw.starts_with("//") && !raw.starts_with("///") {
            "//"
        } else if raw.starts_with('/') {
            "/"
        } else {
            ""
        };
        let parts: Vec<&str> = raw.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
        let joined = format!("{}{}", lead, parts.join("/"));
        if joined.is_empty() {
            ".".into()
        } else {
            joined
        }
    }
}

/// Drive and root of a backslashed Windows path, e.g. `C:\`, `\\server\share\`, `\`.
fn split_windows_root(s: &str) -> (String, &str) {
    let b = s.as_bytes();
    if let Some(unc) = s.strip_prefix("\\\\") {
        let mut parts = unc.splitn(3, '\\');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        return (format!("\\\\{}\\{}\\", server, share), rest);
    }
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        let drive = &s[..2];
        let rest = &s[2..];
        if let Some(r) = rest.strip_prefix('\\') {
            return (format!("{}\\", drive), r);
        }
        return (drive.to_string(), rest);
    }
    if let Some(r) = s.strip_prefix('\\') {
        return ("\\".into(), r);
    }
    (String::new(), s)
}

/// `Path(a) == Path(b)`: case-insensitive on Windows.
pub fn same_path(a: &str, b: &str) -> bool {
    let (a, b) = (normalize_path(a), normalize_path(b));
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_parts() {
        assert_eq!(stem("a/b.c.d"), "b.c");
        assert_eq!(stem("foo."), "foo");
        assert_eq!(stem(".foo"), ".foo");
        assert_eq!(stem("foo.."), "foo.");
        assert_eq!(stem(".."), "..");
        assert_eq!(name("x.y/"), "x.y");
        assert_eq!(stem("a\\b.binfab"), "b");
    }

    #[test]
    fn titles_like_python() {
        assert_eq!(title("a1b c_d it's"), "A1B C_D It'S");
        assert_eq!(title("HELLO wORLD"), "Hello World");
    }

    #[test]
    #[cfg(windows)]
    fn windows_paths() {
        assert_eq!(normalize_path(r"C:\a\\b\.\c\..\d\"), r"C:\a\b\c\..\d");
        assert_eq!(normalize_path("C:/Program Files (x86)//Glyph/./x/"), r"C:\Program Files (x86)\Glyph\x");
        assert_eq!(normalize_path("C:"), "C:");
        assert_eq!(normalize_path("C:/"), "C:\\");
        assert_eq!(normalize_path("//server/share/x/"), r"\\server\share\x");
        assert!(same_path("C:/a/B", r"c:\A\b\"));
    }

    #[test]
    fn number_formats() {
        assert_eq!(int_str(-0.4), "0");
        assert_eq!(int_str(1e23), "99999999999999991611392");
        assert_eq!(format!("{:.1}", -0.04), "-0.0");
        assert_eq!(format!("{:.1}", 0.25), "0.2");
        assert_eq!(format!("{:.0}", 2.5), "2");
        assert_eq!(round_to(2.0005, 3), 2.001);
        assert_eq!(round_to(0.1235, 3), 0.123);
    }

    #[test]
    fn byte_search() {
        assert_eq!(find(b"abcabc", b"ca", 0), Some(2));
        assert_eq!(find(b"abcabc", b"abc", 1), Some(3));
        assert_eq!(find(b"abc", b"", 2), Some(2));
        assert_eq!(find(b"abc", b"d", 0), None);
        assert_eq!(rfind(b"_UIx_UI", b"_UI"), Some(4));
        assert_eq!(utf8_ignore(b"a\xffb\xe2\x82"), "ab");
    }
}
