//! The bits of Python's pathlib, json and OSError behaviour that show up in the file
//! manager's outputs (paths in JSON, error strings, walk order, line endings).

use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::paths::display;

/// `Path(s)`: separators normalized, `.` and repeated/trailing separators dropped, `""` is `.`.
pub fn py_path(s: &str) -> PathBuf {
    let p: PathBuf = Path::new(s).components().filter(|c| !matches!(c, Component::CurDir)).collect();
    if p.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        p
    }
}

pub fn py_type(v: &Value) -> &'static str {
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

pub fn no_attr(v: &Value, attr: &str) -> anyhow::Error {
    anyhow!("'{}' object has no attribute '{}'", py_type(v), attr)
}

/// `str(value)`, with `None` for null.
pub fn py_str(v: &Value) -> String {
    if v.is_null() {
        "None".into()
    } else {
        crate::args::to_str(v)
    }
}

/// `Path(value)` for an argument from the page.
pub fn path_arg(v: &Value) -> Result<PathBuf> {
    match v {
        Value::String(s) => Ok(py_path(s)),
        other => Err(anyhow!("argument should be a str or an os.PathLike object where __fspath__ returns a str, not '{}'", py_type(other))),
    }
}

/// `int(value)` for the numbers the page passes.
pub fn py_int(v: &Value) -> Result<i64> {
    match v {
        Value::Bool(b) => Ok(*b as i64),
        Value::Number(n) => Ok(n.as_i64().unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64)),
        Value::String(s) => s.trim().parse().map_err(|_| anyhow!("invalid literal for int() with base 10: {}", py_repr(s))),
        other => Err(anyhow!("int() argument must be a string, a bytes-like object or a real number, not '{}'", py_type(other))),
    }
}

/// `repr(str)`.
pub fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(quote);
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

/// An OSError the way Python prints it: `[Errno 2] No such file or directory: 'C:\\x'`.
pub fn io_err(err: std::io::Error, path: &Path) -> anyhow::Error {
    use std::io::ErrorKind;
    let (errno, message) = match err.kind() {
        ErrorKind::NotFound => (2, "No such file or directory"),
        ErrorKind::PermissionDenied => (13, "Permission denied"),
        ErrorKind::AlreadyExists => (17, "File exists"),
        _ => return anyhow!("{}: {}", err, py_repr(&display(path))),
    };
    anyhow!("[Errno {}] {}: {}", errno, message, py_repr(&display(path)))
}

/// `Path.as_posix()`.
pub fn as_posix(p: &Path) -> String {
    let mut out = String::new();
    for c in p.components() {
        match c {
            Component::Prefix(pre) => out.push_str(&pre.as_os_str().to_string_lossy().replace('\\', "/")),
            Component::RootDir => out.push('/'),
            Component::CurDir => {}
            other => {
                if !out.is_empty() && !out.ends_with('/') {
                    out.push('/');
                }
                out.push_str(&other.as_os_str().to_string_lossy());
            }
        }
    }
    if out.is_empty() {
        ".".into()
    } else {
        out
    }
}

/// `path.relative_to(root).as_posix()`.
pub fn rel_posix(root: &Path, path: &Path) -> String {
    as_posix(path.strip_prefix(root).unwrap_or(path))
}

/// What tkinter's dialogs returned: forward slashes on Windows.
pub fn tk_path(p: &Path) -> String {
    if cfg!(windows) {
        display(p).replace('\\', "/")
    } else {
        display(p)
    }
}

/// `root.rglob("index.tfi")` in Python 3.14's order: each directory's subfolders are probed
/// in listing order, then the walk continues from the last one pushed. Paths end in the
/// pattern's own spelling, `index.tfi`.
pub fn rglob_index(root: &Path) -> Vec<PathBuf> {
    fn probe(dir: &Path, out: &mut Vec<PathBuf>) {
        let candidate = dir.join("index.tfi");
        if std::fs::symlink_metadata(&candidate).is_ok() {
            out.push(candidate);
        }
    }
    let mut out = Vec::new();
    probe(root, &mut out);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        for entry in entries {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let path = entry.path();
                probe(&path, &mut out);
                stack.push(path);
            }
        }
    }
    out
}

/// `TFIndex.archives`: `dir.glob("*.tfa")` in listing order, each with the number from its
/// `archive<N>` stem (Python died on any other name).
pub fn archives_of(tfi: &Path) -> Result<Vec<(PathBuf, u64)>> {
    let dir = tfi.parent().unwrap_or(Path::new("."));
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let matches = if cfg!(windows) { name.to_lowercase().ends_with(".tfa") } else { name.ends_with(".tfa") };
        if matches {
            let path = entry.path();
            let id = archive_id(&path)?;
            out.push((path, id));
        }
    }
    Ok(out)
}

/// `int(re.search(r"^archive(\d+)", path.stem).group(1))`.
pub fn archive_id(path: &Path) -> Result<u64> {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let digits: String = stem.strip_prefix("archive").map(|rest| rest.chars().take_while(char::is_ascii_digit).collect()).unwrap_or_default();
    if digits.is_empty() {
        return Err(anyhow!("'NoneType' object has no attribute 'group'"));
    }
    digits.parse().map_err(|e| anyhow!("{}", e))
}

/// `st_mtime_ns`.
pub fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    match meta.modified().map(|t| t.duration_since(SystemTime::UNIX_EPOCH)) {
        Ok(Ok(d)) => d.as_nanos() as i128,
        Ok(Err(e)) => -(e.duration().as_nanos() as i128),
        Err(_) => 0,
    }
}

/// `_stat_sig`: `"<mtime_ns>:<size>"`, or `""` when the stat fails.
pub fn stat_sig(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => format!("{}:{}", mtime_ns(&meta), meta.len()),
        Err(_) => String::new(),
    }
}

/// `datetime.utcnow().isoformat() + "Z"`.
pub fn utc_iso_z() -> String {
    let now = chrono::Utc::now();
    if now.timestamp_subsec_micros() == 0 {
        now.format("%Y-%m-%dT%H:%M:%SZ").to_string()
    } else {
        now.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
    }
}

/// `bytes[offset:offset + size]` with Python's slice clamping.
pub fn py_slice(content: &[u8], offset: i64, size: i64) -> &[u8] {
    let len = content.len() as i64;
    let norm = |i: i64| if i < 0 { (i + len).max(0) } else { i.min(len) };
    let (start, stop) = (norm(offset), norm(offset + size));
    if start >= stop {
        &[]
    } else {
        &content[start as usize..stop as usize]
    }
}

/// `BinaryReader(content).seek(offset); read_bytes(size)`.
pub fn binary_read(content: &[u8], offset: i64, size: i64) -> Result<&[u8]> {
    let len = content.len() as i64;
    if offset < 0 || offset > len {
        return Err(anyhow!("BinaryReader Error: cannot seek farther than buffer length."));
    }
    if size < 0 || offset + size > len {
        return Err(anyhow!("BinaryReader Error: cannot read farther than buffer length."));
    }
    Ok(&content[offset as usize..(offset + size) as usize])
}

pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| io_err(e, path))
}

pub fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).map_err(|e| io_err(e, path))
}

pub fn create_dirs(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|e| io_err(e, path))
}

/// `open(path, "w", encoding="utf-8").write(text)`: `\r\n` line endings on Windows.
pub fn write_text(path: &Path, text: &str) -> Result<()> {
    if cfg!(windows) {
        write_file(path, text.replace('\n', "\r\n").as_bytes())
    } else {
        write_file(path, text.as_bytes())
    }
}

/// `json.load(open(path, encoding="utf-8"))`.
pub fn read_json(path: &Path) -> Result<Value> {
    let bytes = read_file(path)?;
    let text = String::from_utf8(bytes).map_err(|e| {
        let at = e.utf8_error().valid_up_to();
        anyhow!("'utf-8' codec can't decode byte 0x{:02x} in position {}: invalid start byte", e.as_bytes()[at], at)
    })?;
    serde_json::from_str(&text).map_err(|err| json_error(&text, &err))
}

/// json.JSONDecodeError's message for the common syntax errors; serde's otherwise.
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
    let byte = if serde.starts_with("EOF") {
        text.len()
    } else {
        let line_start: usize = text.split_inclusive('\n').take(err.line().saturating_sub(1)).map(str::len).sum();
        let mut byte = (line_start + err.column().saturating_sub(1)).min(text.len());
        while !text.is_char_boundary(byte) {
            byte -= 1;
        }
        byte
    };
    let pos = text[..byte].chars().count();
    let line = text[..byte].matches('\n').count() + 1;
    let column = pos - text[..byte].rfind('\n').map(|i| text[..=i].chars().count()).unwrap_or(0) + 1;
    anyhow!("{}: line {} column {} (char {})", python, line, column, pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_normalize_like_pathlib() {
        assert_eq!(display(&py_path("")), ".");
        assert_eq!(as_posix(&py_path("./a//b/./c/")), "a/b/c");
        assert_eq!(as_posix(&Path::new("ui").join("store/x.png")), "ui/store/x.png");
        assert_eq!(as_posix(&PathBuf::new().join("x.png")), "x.png");
        if cfg!(windows) {
            assert_eq!(display(&py_path("C:/a//b/./c/")), r"C:\a\b\c");
            assert_eq!(tk_path(Path::new(r"C:\a\b")), "C:/a/b");
        }
    }

    #[test]
    fn python_errors() {
        assert_eq!(py_repr(r"C:\x\a'b"), r#""C:\\x\\a'b""#);
        let err = io_err(std::io::Error::from(std::io::ErrorKind::NotFound), Path::new("a/b.tfa"));
        assert_eq!(err.to_string(), "[Errno 2] No such file or directory: 'a/b.tfa'");
        assert_eq!(archive_id(Path::new("x/archive12.tfa")).unwrap(), 12);
        assert_eq!(archive_id(Path::new("x/Archive1.tfa")).unwrap_err().to_string(), "'NoneType' object has no attribute 'group'");
    }

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

    #[test]
    fn slices_like_python() {
        let data = b"0123456789";
        assert_eq!(py_slice(data, 8, 5), b"89");
        assert_eq!(py_slice(data, 12, 5), b"");
        assert_eq!(binary_read(data, 2, 3).unwrap(), b"234");
        assert!(binary_read(data, 11, 0).unwrap_err().to_string().contains("seek"));
        assert!(binary_read(data, 8, 5).unwrap_err().to_string().contains("read"));
    }
}
