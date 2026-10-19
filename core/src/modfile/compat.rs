//! The bits of CPython behaviour the ported code leans on: pathlib's parsing, `str()` and
//! `repr()` of values, `strip`/`splitlines`, text-mode file I/O and the wording of the
//! exceptions the Python version reported back to the page.

use std::io;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde_json::Value;

// --- pathlib ------------------------------------------------------------------------

#[cfg(windows)]
const SEP: char = '\\';
#[cfg(not(windows))]
const SEP: char = '/';

/// `ntpath.splitroot` on a path whose separators are already `\`.
fn win_splitroot(p: &str) -> (String, String, String) {
    let b = p.as_bytes();
    if b.first() == Some(&b'\\') {
        if b.get(1) == Some(&b'\\') {
            let start = if p.len() >= 8 && p[..8].eq_ignore_ascii_case("\\\\?\\UNC\\") { 8 } else { 2 };
            let Some(i1) = p[start..].find('\\').map(|i| i + start) else { return (p.into(), String::new(), String::new()) };
            let Some(i2) = p[i1 + 1..].find('\\').map(|i| i + i1 + 1) else { return (p.into(), String::new(), String::new()) };
            return (p[..i2].into(), p[i2..i2 + 1].into(), p[i2 + 1..].into());
        }
        return (String::new(), p[..1].into(), p[1..].into());
    }
    let mut chars = p.char_indices();
    if let (Some(_), Some((i, ':'))) = (chars.next(), chars.next()) {
        let drive_end = i + 1;
        if p[drive_end..].starts_with('\\') {
            return (p[..drive_end].into(), "\\".into(), p[drive_end + 1..].into());
        }
        return (p[..drive_end].into(), String::new(), p[drive_end..].into());
    }
    (String::new(), String::new(), p.into())
}

/// `PureWindowsPath._parse_path`: (drive, root, parts).
fn win_parse(path: &str) -> (String, String, Vec<String>) {
    if path.is_empty() {
        return (String::new(), String::new(), Vec::new());
    }
    let path = path.replace('/', "\\");
    let (drv, mut root, rel) = win_splitroot(&path);
    if root.is_empty() && drv.starts_with('\\') && !drv.ends_with('\\') {
        let n = drv.split('\\').count();
        let third = drv.split('\\').nth(2).unwrap_or("");
        if (n == 4 && third != "?" && third != ".") || n == 6 {
            root = "\\".into();
        }
    }
    let parts = rel.split('\\').filter(|x| !x.is_empty() && *x != ".").map(String::from).collect();
    (drv, root, parts)
}

/// `PurePosixPath._parse_path`.
fn posix_parse(path: &str) -> (String, String, Vec<String>) {
    let root = if path.starts_with("//") && !path.starts_with("///") {
        "//"
    } else if path.starts_with('/') {
        "/"
    } else {
        ""
    };
    let parts = path.split('/').filter(|x| !x.is_empty() && *x != ".").map(String::from).collect();
    (String::new(), root.into(), parts)
}

fn parse(path: &str) -> (String, String, Vec<String>) {
    if cfg!(windows) {
        win_parse(path)
    } else {
        posix_parse(path)
    }
}

/// `str(Path(path))`.
pub fn path_str(path: &str) -> String {
    let (drv, root, mut parts) = parse(path);
    let sep = SEP.to_string();
    if !drv.is_empty() || !root.is_empty() {
        return format!("{}{}{}", drv, root, parts.join(&sep));
    }
    if cfg!(windows) {
        if let Some(first) = parts.first() {
            if !win_splitroot(first).0.is_empty() {
                parts.insert(0, ".".into());
            }
        }
    }
    let s = parts.join(&sep);
    if s.is_empty() {
        ".".into()
    } else {
        s
    }
}

/// `Path(path)`: the string normalized the way pathlib does.
pub fn py_path(path: &str) -> PathBuf {
    PathBuf::from(path_str(path))
}

/// `Path(path).as_posix()`.
pub fn as_posix(path: &str) -> String {
    let s = path_str(path);
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s
    }
}

/// `Path(path).parts`, without the anchor.
pub fn path_parts(path: &str) -> Vec<String> {
    parse(path).2
}

/// `PurePosixPath(path).parts`, anchor (`/` or `//`) first, on every platform.
pub fn posix_parts(path: &str) -> Vec<String> {
    let (_, root, parts) = posix_parse(path);
    let mut out = Vec::with_capacity(parts.len() + 1);
    if !root.is_empty() {
        out.push(root);
    }
    out.extend(parts);
    out
}

/// `os.path.join(a, b)`, which pathlib's `/` uses.
pub fn join_str(a: &str, b: &str) -> String {
    if !cfg!(windows) {
        if b.starts_with('/') || a.is_empty() {
            return b.to_string();
        }
        return if a.ends_with('/') { format!("{}{}", a, b) } else { format!("{}/{}", a, b) };
    }
    let (a, b) = (a.replace('/', "\\"), b.replace('/', "\\"));
    let (mut drive, mut root, mut path) = win_splitroot(&a);
    let (p_drive, p_root, p_path) = win_splitroot(&b);
    if !p_root.is_empty() {
        if !p_drive.is_empty() || drive.is_empty() {
            drive = p_drive;
        }
        return format!("{}{}{}", drive, p_root, p_path);
    }
    if !p_drive.is_empty() && p_drive != drive {
        if p_drive.to_lowercase() != drive.to_lowercase() {
            return format!("{}{}{}", p_drive, p_root, p_path);
        }
        drive = p_drive;
    }
    if !path.is_empty() && !path.ends_with('\\') {
        path.push('\\');
    }
    path.push_str(&p_path);
    if !path.is_empty() && root.is_empty() && !drive.is_empty() && !drive.ends_with(':') {
        root = "\\".into();
    }
    format!("{}{}{}", drive, root, path)
}

/// `Path(a) / b`.
pub fn join(a: &Path, b: &str) -> PathBuf {
    py_path(&join_str(&display(a), b))
}

/// `Path(child).relative_to(base).parts`, or `None` when it is not under `base`
/// (case-insensitive on Windows).
pub fn relative_parts(child: &Path, base: &Path) -> Option<Vec<String>> {
    let (cd, cr, cp) = parse(&display(child));
    let (bd, br, bp) = parse(&display(base));
    let fold = |s: &str| if cfg!(windows) { s.to_lowercase() } else { s.to_string() };
    if fold(&format!("{}{}", cd, cr)) != fold(&format!("{}{}", bd, br)) || bp.len() > cp.len() {
        return None;
    }
    if bp.iter().zip(&cp).any(|(b, c)| fold(b) != fold(c)) {
        return None;
    }
    Some(cp[bp.len()..].to_vec())
}

/// `Path(path).name`.
pub fn name_of(path: &str) -> String {
    parse(path).2.pop().unwrap_or_default()
}

/// `Path(path).suffix` (3.14: a trailing dot counts).
pub fn suffix_of(path: &str) -> String {
    let name = name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[i..].to_string(),
        _ => String::new(),
    }
}

/// `Path(path).stem`.
pub fn stem_of(path: &str) -> String {
    let name = name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name,
    }
}

/// `Path.name` of a real path.
pub fn file_name(path: &Path) -> String {
    name_of(&path.to_string_lossy())
}

/// `Path.stem` of a real path.
pub fn file_stem(path: &Path) -> String {
    stem_of(&path.to_string_lossy())
}

/// `Path.suffix` of a real path.
pub fn file_suffix(path: &Path) -> String {
    suffix_of(&path.to_string_lossy())
}

/// `str(path)`.
pub fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// pathlib equality: case-insensitive on Windows.
pub fn same_path(a: &Path, b: &Path) -> bool {
    let (a, b) = (path_str(&a.to_string_lossy()), path_str(&b.to_string_lossy()));
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

/// `Path.resolve()` (non-strict): the longest existing prefix canonicalized, the rest
/// appended lexically.
pub fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut tail = Vec::new();
    let mut cur = absolute.as_path();
    loop {
        if let Some(c) = crate::game::registry::dunce_canonical(cur) {
            let mut out = c;
            for part in tail.iter().rev() {
                if *part == ".." {
                    out.pop();
                } else {
                    out.push(part);
                }
            }
            return out;
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_string_lossy().into_owned());
                cur = parent;
            }
            _ => return absolute,
        }
    }
}

/// `child in parent.parents or child == parent`, with pathlib's case rules.
pub fn is_within(child: &Path, parent: &Path) -> bool {
    let norm = |p: &Path| {
        let s = path_str(&p.to_string_lossy());
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    let (c, p) = (PathBuf::from(norm(child)), PathBuf::from(norm(parent)));
    c.starts_with(&p)
}

// --- str ----------------------------------------------------------------------------

/// `str.isspace()` for one character.
pub fn is_py_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// `str.strip()`.
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_py_space)
}

/// `str.lstrip()`.
pub fn lstrip(s: &str) -> &str {
    s.trim_start_matches(is_py_space)
}

/// `str.splitlines()`.
pub fn splitlines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut iter = s.char_indices().peekable();
    while let Some((i, c)) = iter.next() {
        let is_break = matches!(c, '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if !is_break {
            continue;
        }
        out.push(&s[start..i]);
        let mut end = i + c.len_utf8();
        if c == '\r' {
            if let Some((_, '\n')) = iter.peek() {
                iter.next();
                end += 1;
            }
        }
        start = end;
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// `len(s)` in code points.
pub fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// `s[:n]` in code points.
pub fn char_prefix(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The Python type name of a JSON value.
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

/// `str(value)` (unlike `Args::str`, `None` is `"None"`).
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => match n.as_f64().filter(|_| n.is_f64()) {
            Some(f) => crate::json::float_repr(f),
            None => n.to_string(),
        },
        other => py_repr(other),
    }
}

/// `repr()` of a JSON value.
pub fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => repr_str(s),
        Value::Array(items) => format!("[{}]", items.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(map) => format!("{{{}}}", map.iter().map(|(k, v)| format!("{}: {}", repr_str(k), py_repr(v))).collect::<Vec<_>>().join(", ")),
        other => py_str(other),
    }
}

/// Python truthiness.
pub fn truthy(v: &Value) -> bool {
    crate::args::truthy(v)
}

/// An approximation of `str.isprintable()` for one character.
pub(crate) fn is_printable(c: char) -> bool {
    let u = c as u32;
    if u < 0x20 || u == 0x7f {
        return false;
    }
    if u < 0x7f {
        return true;
    }
    !matches!(u,
        0x80..=0xa0 | 0xad | 0x600..=0x605 | 0x61c | 0x6dd | 0x70f | 0x1680 | 0x180e | 0x2000..=0x200f
        | 0x2028..=0x202f | 0x205f..=0x2064 | 0x2066..=0x206f | 0x3000 | 0xd800..=0xf8ff | 0xfeff
        | 0xfff9..=0xfffb | 0xe0001 | 0xe0020..=0xe007f | 0xf0000..=0x10ffff)
}

/// `repr(str)`.
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
            c if is_printable(c) => out.push(c),
            c if (c as u32) < 0x100 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if (c as u32) < 0x10000 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push_str(&format!("\\U{:08x}", c as u32)),
        }
    }
    out.push(quote);
    out
}

/// `int(value)` with Python's errors.
pub fn py_int(v: &Value) -> Result<i64> {
    match v {
        Value::Bool(b) => Ok(*b as i64),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.trunc() as i64)).ok_or_else(|| anyhow!("cannot convert to int")),
        Value::String(s) => parse_int_literal(s).ok_or_else(|| anyhow!("invalid literal for int() with base 10: {}", repr_str(s))),
        other => Err(anyhow!("int() argument must be a string, a bytes-like object or a real number, not '{}'", type_name(other))),
    }
}

fn parse_int_literal(s: &str) -> Option<i64> {
    let t = strip(s);
    let (neg, digits) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    if digits.is_empty() || digits.starts_with('_') || digits.ends_with('_') || digits.contains("__") {
        return None;
    }
    let clean: String = digits.chars().filter(|&c| c != '_').collect();
    if !clean.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let value: i64 = clean.parse().ok()?;
    Some(if neg { -value } else { value })
}

/// `value.strip()` where Python would raise for a non-string.
pub fn strip_value(v: &Value) -> Result<String> {
    match v {
        Value::String(s) => Ok(strip(s).to_string()),
        other => Err(anyhow!("'{}' object has no attribute 'strip'", type_name(other))),
    }
}

/// `dict.get(key, default)` on a JSON object; Python raised for a non-dict receiver.
pub fn get<'a>(obj: &'a Value, key: &str) -> Result<Option<&'a Value>> {
    match obj {
        Value::Object(map) => Ok(map.get(key)),
        other => Err(anyhow!("'{}' object has no attribute 'get'", type_name(other))),
    }
}

/// Iterating a JSON value the way a `for` loop would.
pub fn iterate(v: &Value) -> Result<Vec<Value>> {
    match v {
        Value::Array(items) => Ok(items.clone()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(map) => Ok(map.keys().map(|k| Value::String(k.clone())).collect()),
        other => Err(anyhow!("'{}' object is not iterable", type_name(other))),
    }
}

/// `Path(value)`: Python raised for anything but a string.
pub fn path_arg(v: &Value) -> Result<PathBuf> {
    match v {
        Value::String(s) => Ok(py_path(s)),
        other => Err(anyhow!("argument should be a str or an os.PathLike object where __fspath__ returns a str, not '{}'", type_name(other))),
    }
}

/// `datetime.now(UTC).isoformat()`.
pub fn utc_isoformat(now: chrono::DateTime<chrono::Utc>) -> String {
    use chrono::Timelike;
    let micros = now.nanosecond() / 1000 % 1_000_000;
    if micros == 0 {
        now.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        format!("{}.{:06}+00:00", now.format("%Y-%m-%dT%H:%M:%S"), micros)
    }
}

// --- bytes --------------------------------------------------------------------------

/// `bytes.decode("utf-8")`, with CPython's error message.
pub fn decode_utf8(bytes: &[u8]) -> Result<String> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(e) => {
            let start = e.valid_up_to();
            let (end, reason) = match e.error_len() {
                None => (bytes.len(), "unexpected end of data"),
                Some(n) => {
                    let lead = bytes[start];
                    let invalid_start = (0x80..=0xc1).contains(&lead) || lead >= 0xf5;
                    (start + n, if invalid_start { "invalid start byte" } else { "invalid continuation byte" })
                }
            };
            if end - start == 1 {
                Err(anyhow!("'utf-8' codec can't decode byte 0x{:02x} in position {}: {}", bytes[start], start, reason))
            } else {
                Err(anyhow!("'utf-8' codec can't decode bytes in position {}-{}: {}", start, end - 1, reason))
            }
        }
    }
}

/// `base64.b64decode(s)` (non-validating: stray characters are skipped).
pub fn b64decode(s: &str) -> Result<Vec<u8>> {
    fn value(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut quad_pos, mut pads, mut left, mut data_chars) = (0u8, 0u8, 0u32, 0usize);
    for &c in s.as_bytes() {
        if c == b'=' {
            if quad_pos >= 2 {
                pads += 1;
                if quad_pos + pads >= 4 {
                    return Ok(out);
                }
            }
            continue;
        }
        let Some(v) = value(c) else { continue };
        pads = 0;
        data_chars += 1;
        match quad_pos {
            0 => {
                left = v as u32;
                quad_pos = 1;
            }
            1 => {
                out.push(((left << 2) | (v as u32 >> 4)) as u8);
                left = (v & 0x0f) as u32;
                quad_pos = 2;
            }
            2 => {
                out.push(((left << 4) | (v as u32 >> 2)) as u8);
                left = (v & 0x03) as u32;
                quad_pos = 3;
            }
            _ => {
                out.push(((left << 6) | v as u32) as u8);
                quad_pos = 0;
            }
        }
    }
    match quad_pos {
        0 => Ok(out),
        1 => Err(anyhow!("Invalid base64-encoded string: number of data characters ({}) cannot be 1 more than a multiple of 4", data_chars)),
        _ => Err(anyhow!("Incorrect padding")),
    }
}

pub fn b64encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

// --- OSError --------------------------------------------------------------------------

fn win_message(code: i32) -> String {
    let text = io::Error::from_raw_os_error(code).to_string();
    let text = text.rsplit_once(" (os error").map(|(t, _)| t.to_string()).unwrap_or(text);
    text.trim_end_matches(|c: char| c <= ' ' || c == '.').to_string()
}

fn errno_of(err: &io::Error) -> (i32, &'static str) {
    if cfg!(windows) {
        match err.raw_os_error() {
            Some(2) | Some(3) | Some(15) | Some(161) | Some(206) => (2, "No such file or directory"),
            Some(80) | Some(183) => (17, "File exists"),
            Some(5) | Some(19) | Some(32) | Some(33) => (13, "Permission denied"),
            Some(123) => (22, "Invalid argument"),
            _ => (5, "Input/output error"),
        }
    } else {
        match err.kind() {
            io::ErrorKind::NotFound => (2, "No such file or directory"),
            io::ErrorKind::PermissionDenied => (13, "Permission denied"),
            io::ErrorKind::AlreadyExists => (17, "File exists"),
            _ => (err.raw_os_error().unwrap_or(5), "Input/output error"),
        }
    }
}

/// An OSError from a C-runtime call (`open()`, `read_bytes`, `write_text`):
/// `[Errno 2] No such file or directory: 'path'`.
pub fn errno_error(err: io::Error, path: &Path) -> anyhow::Error {
    let (errno, text) = errno_of(&err);
    let text = if cfg!(windows) { text.to_string() } else { strerror(&err).unwrap_or_else(|| text.to_string()) };
    let msg = format!("[Errno {}] {}: {}", errno, text, repr_str(&display(path)));
    anyhow::Error::new(PyOsError { kind: err.kind(), msg })
}

#[cfg(not(windows))]
fn strerror(err: &io::Error) -> Option<String> {
    let text = err.to_string();
    text.rsplit_once(" (os error").map(|(t, _)| t.to_string())
}

#[cfg(windows)]
fn strerror(_: &io::Error) -> Option<String> {
    None
}

/// An OSError from a Win32 call (`os.rename`, `os.mkdir`, `os.unlink`):
/// `[WinError 2] The system cannot find the file specified: 'a' -> 'b'`. Elsewhere the
/// errno form.
pub fn os_error(err: io::Error, path: &Path, dst: Option<&Path>) -> anyhow::Error {
    let code = err.raw_os_error();
    let (Some(code), true) = (code, cfg!(windows)) else {
        return errno_error(err, path);
    };
    let mut msg = format!("[WinError {}] {}: {}", code, win_message(code), repr_str(&display(path)));
    if let Some(dst) = dst {
        msg.push_str(&format!(" -> {}", repr_str(&display(dst))));
    }
    anyhow::Error::new(PyOsError { kind: err.kind(), msg })
}

/// A Python `OSError`: callers that caught `OSError` check for this.
#[derive(Debug)]
pub struct PyOsError {
    pub kind: io::ErrorKind,
    pub msg: String,
}

impl std::fmt::Display for PyOsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for PyOsError {}

/// True when `err` is what Python raised as an `OSError`.
pub fn is_os_error(err: &anyhow::Error) -> bool {
    err.chain().any(|e| e.is::<PyOsError>() || e.is::<io::Error>())
}

// --- file I/O -------------------------------------------------------------------------

pub fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| errno_error(e, path))
}

pub fn write_bytes(path: &Path, data: &[u8]) -> Result<()> {
    std::fs::write(path, data).map_err(|e| errno_error(e, path))
}

/// `Path.write_text(text, encoding="utf-8")`: text mode, so `\n` is written as the
/// platform line ending.
pub fn write_text(path: &Path, text: &str) -> Result<()> {
    if cfg!(windows) {
        write_bytes(path, text.replace('\n', "\r\n").as_bytes())
    } else {
        write_bytes(path, text.as_bytes())
    }
}

fn universal_newlines(text: String) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text
    }
}

/// `Path.read_text(encoding="utf-8")`.
pub fn read_text(path: &Path) -> Result<String> {
    let bytes = read_bytes(path)?;
    Ok(universal_newlines(decode_utf8(&bytes)?))
}

/// `Path.read_text(encoding="utf-8-sig", errors="replace")`.
pub fn read_text_lossy_sig(path: &Path) -> Result<String> {
    let bytes = read_bytes(path)?;
    Ok(universal_newlines(decode_lossy_sig(&bytes)))
}

/// `bytes.decode("utf-8-sig", errors="replace")`.
pub fn decode_lossy_sig(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// `json.loads(path.read_text(encoding="utf-8"))`.
pub fn read_json(path: &Path) -> Result<Value> {
    let text = read_text(path)?;
    serde_json::from_str(&text).map_err(|e| anyhow!(json_error(&e)))
}

/// A `JSONDecodeError`-shaped message for a serde error.
pub fn json_error(e: &serde_json::Error) -> String {
    let what = match e.classify() {
        serde_json::error::Category::Eof => "Expecting value",
        _ => {
            let text = e.to_string();
            return text.rsplit_once(" at line").map(|(t, _)| t.to_string()).unwrap_or(text);
        }
    };
    format!("{}: line {} column {}", what, e.line(), e.column())
}

/// `Path.mkdir(parents=True, exist_ok=True)`.
pub fn mkdir_all(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|e| os_error(e, path, None))
}

/// `os.rename(src, dst)`: unlike `fs::rename` on Windows, never replaces `dst`.
pub fn rename(src: &Path, dst: &Path) -> Result<()> {
    if cfg!(windows) && dst.exists() && !same_path(src, dst) {
        return Err(os_error(io::Error::from_raw_os_error(183), src, Some(dst)));
    }
    std::fs::rename(src, dst).map_err(|e| os_error(e, src, Some(dst)))
}

/// `os.unlink(path)`.
pub fn unlink(path: &Path) -> Result<()> {
    std::fs::remove_file(path).map_err(|e| os_error(e, path, None))
}

/// `shutil.copy2(src, dst)`: contents plus timestamps and permissions.
pub fn copy2(src: &Path, dst: &Path) -> Result<PathBuf> {
    let dst = if dst.is_dir() { dst.join(src.file_name().unwrap_or_default()) } else { dst.to_path_buf() };
    std::fs::copy(src, &dst).map_err(|e| errno_error(e, if src.exists() { &dst } else { src }))?;
    if let Ok(meta) = std::fs::metadata(src) {
        let mut times = std::fs::FileTimes::new();
        if let Ok(t) = meta.modified() {
            times = times.set_modified(t);
        }
        if let Ok(t) = meta.accessed() {
            times = times.set_accessed(t);
        }
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&dst) {
            let _ = f.set_times(times);
        }
    }
    Ok(dst)
}

/// `shutil.move(src, dst)`.
pub fn shutil_move(src: &Path, dst: &Path) -> Result<PathBuf> {
    let mut real_dst = dst.to_path_buf();
    if dst.is_dir() {
        real_dst = dst.join(src.file_name().unwrap_or_default());
        if real_dst.exists() {
            return Err(anyhow!("Destination path '{}' already exists", display(&real_dst)));
        }
    }
    if std::fs::rename(src, &real_dst).is_err() {
        if src.is_dir() {
            copy_tree(src, &real_dst)?;
            std::fs::remove_dir_all(src).map_err(|e| os_error(e, src, None))?;
        } else {
            copy2(src, &real_dst)?;
            unlink(src)?;
        }
    }
    Ok(real_dst)
}

fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
        let rel = entry.path().strip_prefix(src).unwrap_or(entry.path());
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            mkdir_all(&target)?;
        } else {
            copy2(entry.path(), &target)?;
        }
    }
    Ok(())
}

// --- glob ----------------------------------------------------------------------------

/// `Path.rglob("*")` in CPython 3.14's order, lazily: a directory's entries come when
/// it is reached through its parent, and directories are expanded last-in first-out.
pub struct Rglob {
    pending: std::collections::VecDeque<PathBuf>,
    listing: Vec<PathBuf>,
    stack: Vec<PathBuf>,
    started: Option<PathBuf>,
}

impl Rglob {
    pub fn new(root: &Path) -> Self {
        Rglob { pending: Default::default(), listing: Vec::new(), stack: Vec::new(), started: Some(root.to_path_buf()) }
    }
}

fn scandir(dir: &Path) -> Option<Vec<std::fs::DirEntry>> {
    std::fs::read_dir(dir).ok().map(|rd| rd.filter_map(|e| e.ok()).collect())
}

fn entry_is_dir(entry: &std::fs::DirEntry) -> bool {
    entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
}

impl Iterator for Rglob {
    type Item = PathBuf;

    fn next(&mut self) -> Option<PathBuf> {
        loop {
            if let Some(p) = self.pending.pop_front() {
                return Some(p);
            }
            if let Some(root) = self.started.take() {
                if let Some(entries) = scandir(&root) {
                    self.pending.extend(entries.iter().map(|e| root.join(e.file_name())));
                }
                self.stack.push(root);
                continue;
            }
            if let Some(dir) = self.listing.pop() {
                if let Some(entries) = scandir(&dir) {
                    self.pending.extend(entries.iter().map(|e| dir.join(e.file_name())));
                }
                continue;
            }
            let dir = self.stack.pop()?;
            if let Some(entries) = scandir(&dir) {
                let dirs: Vec<PathBuf> = entries.iter().filter(|e| entry_is_dir(e)).map(|e| dir.join(e.file_name())).collect();
                for d in dirs.iter().rev() {
                    self.listing.push(d.clone());
                }
                self.stack.extend(dirs);
            }
        }
    }
}

/// `Path.rglob("index.tfi")` in CPython 3.14's order.
pub fn rglob_named(root: &Path, name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let check = |dir: &Path, out: &mut Vec<PathBuf>| {
        let candidate = dir.join(name);
        if std::fs::symlink_metadata(&candidate).is_ok() {
            out.push(candidate);
        }
    };
    check(root, &mut out);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Some(entries) = scandir(&dir) else { continue };
        for entry in entries {
            if entry_is_dir(&entry) {
                let p = dir.join(entry.file_name());
                check(&p, &mut out);
                stack.push(p);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_paths_match_pathlib() {
        let cases = [
            ("", ".", "", "", ""),
            ("a.", "a.", "a.", ".", "a"),
            (".a", ".a", ".a", "", ".a"),
            ("x.tmod.disabled", "x.tmod.disabled", "x.tmod.disabled", ".disabled", "x.tmod"),
            ("ui//x/./y/", "ui\\x\\y", "y", "", "y"),
            ("./C:foo", ".\\C:foo", "C:foo", "", "C:foo"),
            ("C:foo", "C:foo", "foo", "", "foo"),
            ("C:/a/", "C:\\a", "a", "", "a"),
            ("//srv/share/x", "\\\\srv\\share\\x", "x", "", "x"),
            ("//srv", "\\\\srv", "", "", ""),
            ("//srv/share", "\\\\srv\\share\\", "", "", ""),
            ("\\\\?\\UNC\\a\\b\\c", "\\\\?\\UNC\\a\\b\\c", "c", "", "c"),
            ("//./x/y", "\\\\.\\x\\y", "y", "", "y"),
            ("/a/b", "\\a\\b", "b", "", "b"),
            ("C:", "C:", "", "", ""),
        ];
        for (input, s, name, suffix, stem) in cases {
            assert_eq!(path_str(input), s, "str of {input:?}");
            assert_eq!(name_of(input), name, "name of {input:?}");
            assert_eq!(suffix_of(input), suffix, "suffix of {input:?}");
            assert_eq!(stem_of(input), stem, "stem of {input:?}");
        }
    }

    #[test]
    fn b64_matches_binascii() {
        assert_eq!(b64decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64decode("ab=c=d").unwrap(), b"i\xb7");
        assert_eq!(b64decode("abc").unwrap_err().to_string(), "Incorrect padding");
        assert!(b64decode("a").unwrap_err().to_string().contains("(1) cannot be 1 more"));
        assert_eq!(b64decode("aGV\nsbG8").unwrap_err().to_string(), "Incorrect padding");
    }

    #[test]
    fn utf8_errors_match_cpython() {
        let msg = |b: &[u8]| decode_utf8(b).unwrap_err().to_string();
        assert_eq!(msg(b"ab\xff"), "'utf-8' codec can't decode byte 0xff in position 2: invalid start byte");
        assert_eq!(msg(b"\xe4\xb8"), "'utf-8' codec can't decode bytes in position 0-1: unexpected end of data");
        assert_eq!(msg(b"\xe4A"), "'utf-8' codec can't decode byte 0xe4 in position 0: invalid continuation byte");
        assert_eq!(msg(b"\xe4\xb8A"), "'utf-8' codec can't decode bytes in position 0-1: invalid continuation byte");
    }

    #[test]
    fn splitlines_and_strip() {
        assert_eq!(splitlines("a\r\nb\rc\n\nd\x0be"), vec!["a", "b", "c", "", "d", "e"]);
        assert_eq!(strip("\x1c a \u{3000}"), "a");
        assert_eq!(repr_str("C:\\x'y"), "\"C:\\\\x'y\"");
        assert_eq!(repr_str("a\u{0}b"), "'a\\x00b'");
    }

    #[test]
    fn isoformat_drops_zero_micros() {
        use chrono::TimeZone;
        let t = chrono::Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        assert_eq!(utc_isoformat(t), "2026-01-02T03:04:05+00:00");
        assert_eq!(utc_isoformat(t + chrono::Duration::microseconds(120)), "2026-01-02T03:04:05.000120+00:00");
    }
}
