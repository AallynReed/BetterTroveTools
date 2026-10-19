//! pathlib: parsing, `str(Path)`, joins and parts, plus `rglob` order and tkinter's
//! dialog paths.
//!
//! [`path_str`] is the full `ntpath.splitroot` port. [`path_str_simple`] (codexes),
//! [`path_str_flat`] (blueprint) and [`path_from_components`] (file manager) are older
//! approximations that agree with it on drive and relative paths but print some UNC and
//! drive-relative forms differently.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::{err, type_name, PyErr};

pub use crate::paths::display;

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
    let root = posix_root(path);
    let parts = path.split('/').filter(|x| !x.is_empty() && *x != ".").map(String::from).collect();
    (String::new(), root.into(), parts)
}

fn posix_root(path: &str) -> &'static str {
    if path.starts_with("//") && !path.starts_with("///") {
        "//"
    } else if path.starts_with('/') {
        "/"
    } else {
        ""
    }
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

/// `Path(value)`: Python raised for anything but a string.
pub fn path_arg(v: &Value) -> Result<PathBuf, PyErr> {
    path_arg_with(v, py_path)
}

fn path_arg_with(v: &Value, make: fn(&str) -> PathBuf) -> Result<PathBuf, PyErr> {
    match v {
        Value::String(s) => Ok(make(s)),
        other => Err(err(format!("argument should be a str or an os.PathLike object where __fspath__ returns a str, not '{}'", type_name(other)))),
    }
}

// --- older approximations --------------------------------------------------------------

/// `str(path)` with a simplified root split: like [`path_str`] except a bare `\\server`
/// keeps a trailing `\\` and `./C:x` loses its `.` (codexes).
pub fn path_str_simple(path: &Path) -> String {
    normalize_simple(&path.to_string_lossy())
}

/// [`path_str_simple`] of a string.
pub fn normalize_simple(raw: &str) -> String {
    if cfg!(windows) {
        let s = raw.replace('/', "\\");
        let (prefix, rest) = split_windows_root_simple(&s);
        let parts: Vec<&str> = rest.split('\\').filter(|p| !p.is_empty() && *p != ".").collect();
        let joined = format!("{}{}", prefix, parts.join("\\"));
        if joined.is_empty() {
            ".".into()
        } else {
            joined
        }
    } else {
        let parts: Vec<&str> = raw.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
        let joined = format!("{}{}", posix_root(raw), parts.join("/"));
        if joined.is_empty() {
            ".".into()
        } else {
            joined
        }
    }
}

/// Drive and root of a backslashed Windows path, e.g. `C:\`, `\\server\share\`, `\`.
fn split_windows_root_simple(s: &str) -> (String, &str) {
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

/// `Path(a) == Path(b)` through [`normalize_simple`].
pub fn same_path_simple(a: &str, b: &str) -> bool {
    let (a, b) = (normalize_simple(a), normalize_simple(b));
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

/// `str(path)` where a UNC root is just the leading `\\` (`\\srv\share` gets no trailing
/// separator) and any second-byte `:` makes a drive (blueprint).
pub fn path_str_flat(p: &Path) -> String {
    let raw = p.to_string_lossy();
    let out = if cfg!(windows) {
        let s = raw.replace('/', "\\");
        let (drive, rest) = if s.len() >= 2 && s.as_bytes()[1] == b':' { s.split_at(2) } else { ("", s.as_str()) };
        let parts: Vec<&str> = rest.split('\\').filter(|c| !c.is_empty() && *c != ".").collect();
        if drive.is_empty() && rest.starts_with("\\\\") {
            format!("\\\\{}", parts.join("\\"))
        } else {
            format!("{drive}{}{}", if rest.starts_with('\\') { "\\" } else { "" }, parts.join("\\"))
        }
    } else {
        let parts: Vec<&str> = raw.split('/').filter(|c| !c.is_empty() && *c != ".").collect();
        format!("{}{}", posix_root(&raw), parts.join("/"))
    };
    if out.is_empty() {
        ".".into()
    } else {
        out
    }
}

/// `Path(p).name` for a game-relative path with either separator, on every platform.
pub fn name_any_sep(path: &str) -> &str {
    path.rsplit(['/', '\\']).find(|p| !p.is_empty() && *p != ".").unwrap_or("")
}

/// `Path(p).stem` for a game-relative path (a trailing dot is a suffix, a dot-only stem
/// is not, so `..` stays `..` unlike [`stem_of`]).
pub fn stem_any_sep(path: &str) -> &str {
    let name = name_any_sep(path);
    if let Some(i) = name.rfind('.') {
        let stem = &name[..i];
        if !stem.trim_start_matches('.').is_empty() {
            return stem;
        }
    }
    name
}

/// `Path(s)` through std's component parser: separators normalized, `.` and repeated or
/// trailing separators dropped, `""` is `.` (file manager).
pub fn path_from_components(s: &str) -> PathBuf {
    let p: PathBuf = Path::new(s).components().filter(|c| !matches!(c, Component::CurDir)).collect();
    if p.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        p
    }
}

/// [`path_arg`] through [`path_from_components`].
pub fn path_arg_components(v: &Value) -> Result<PathBuf, PyErr> {
    path_arg_with(v, path_from_components)
}

/// `Path.as_posix()` through std's components.
pub fn as_posix_components(p: &Path) -> String {
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
    as_posix_components(path.strip_prefix(root).unwrap_or(path))
}

/// What tkinter's dialogs returned: forward slashes on Windows too.
pub fn tk_path(p: &Path) -> String {
    if cfg!(windows) {
        display(p).replace('\\', "/")
    } else {
        display(p)
    }
}

// --- glob ----------------------------------------------------------------------------

fn scandir(dir: &Path) -> Option<Vec<std::fs::DirEntry>> {
    std::fs::read_dir(dir).ok().map(|rd| rd.filter_map(|e| e.ok()).collect())
}

fn entry_is_dir(entry: &std::fs::DirEntry) -> bool {
    entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
}

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

/// `Path.rglob(name)` for a literal file name, in CPython 3.14's order: each directory's
/// subfolders are probed in listing order, then the walk continues from the last one pushed.
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
    #[cfg(windows)]
    fn simple_windows_paths() {
        assert_eq!(normalize_simple(r"C:\a\\b\.\c\..\d\"), r"C:\a\b\c\..\d");
        assert_eq!(normalize_simple("C:/Program Files (x86)//Glyph/./x/"), r"C:\Program Files (x86)\Glyph\x");
        assert_eq!(normalize_simple("C:"), "C:");
        assert_eq!(normalize_simple("C:/"), "C:\\");
        assert_eq!(normalize_simple("//server/share/x/"), r"\\server\share\x");
        assert!(same_path_simple("C:/a/B", r"c:\A\b\"));
        assert_eq!(path_str_flat(Path::new("C:/Games//Trove/Live/")), "C:\\Games\\Trove\\Live");
        assert_eq!(path_str_flat(Path::new("C:\\")), "C:\\");
    }

    #[test]
    fn any_separator_parts() {
        assert_eq!(stem_any_sep("a/b.c.d"), "b.c");
        assert_eq!(stem_any_sep("foo."), "foo");
        assert_eq!(stem_any_sep(".foo"), ".foo");
        assert_eq!(stem_any_sep("foo.."), "foo.");
        assert_eq!(stem_any_sep(".."), "..");
        assert_eq!(name_any_sep("x.y/"), "x.y");
        assert_eq!(stem_any_sep("a\\b.binfab"), "b");
    }

    #[test]
    fn component_paths() {
        assert_eq!(display(&path_from_components("")), ".");
        assert_eq!(as_posix_components(&path_from_components("./a//b/./c/")), "a/b/c");
        assert_eq!(as_posix_components(&Path::new("ui").join("store/x.png")), "ui/store/x.png");
        assert_eq!(as_posix_components(&PathBuf::new().join("x.png")), "x.png");
        if cfg!(windows) {
            assert_eq!(display(&path_from_components("C:/a//b/./c/")), r"C:\a\b\c");
            assert_eq!(tk_path(Path::new(r"C:\a\b")), "C:/a/b");
        }
    }
}
