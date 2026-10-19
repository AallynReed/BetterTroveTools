//! OSError text and the `open()`/`os`/`shutil` calls the ports reproduce, text mode included.

use std::borrow::Cow;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{anyhow, Result};

use super::{display, repr_str, repr_str_ascii, same_path, utf8};

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

/// [`errno_error`] knowing only not-found, permission and exists; anything else is Rust's
/// own text. Paths quoted with [`repr_str_ascii`] (file manager).
pub fn errno_error_basic(err: io::Error, path: &Path) -> anyhow::Error {
    use std::io::ErrorKind;
    let (errno, message) = match err.kind() {
        ErrorKind::NotFound => (2, "No such file or directory"),
        ErrorKind::PermissionDenied => (13, "Permission denied"),
        ErrorKind::AlreadyExists => (17, "File exists"),
        _ => return anyhow!("{}: {}", err, repr_str_ascii(&display(path))),
    };
    anyhow!("[Errno {}] {}: {}", errno, message, repr_str_ascii(&display(path)))
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

/// `st_mtime_ns`.
pub fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    match meta.modified().map(|t| t.duration_since(SystemTime::UNIX_EPOCH)) {
        Ok(Ok(d)) => d.as_nanos() as i128,
        Ok(Err(e)) => -(e.duration().as_nanos() as i128),
        Err(_) => 0,
    }
}

// --- file I/O -------------------------------------------------------------------------

/// What a text-mode write puts on disk: `\n` becomes `\r\n` on Windows.
pub fn text_mode(text: &str) -> Cow<'_, str> {
    if cfg!(windows) {
        Cow::Owned(text.replace('\n', "\r\n"))
    } else {
        Cow::Borrowed(text)
    }
}

pub fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| errno_error(e, path))
}

pub fn write_bytes(path: &Path, data: &[u8]) -> Result<()> {
    std::fs::write(path, data).map_err(|e| errno_error(e, path))
}

/// `Path.write_text(text, encoding="utf-8")`.
pub fn write_text(path: &Path, text: &str) -> Result<()> {
    write_bytes(path, text_mode(text).as_bytes())
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
    Ok(universal_newlines(utf8(&bytes)?.to_string()))
}

/// `Path.read_text(encoding="utf-8-sig", errors="replace")`.
pub fn read_text_lossy_sig(path: &Path) -> Result<String> {
    let bytes = read_bytes(path)?;
    Ok(universal_newlines(super::decode_lossy_sig(&bytes)))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_errno_text() {
        let err = errno_error_basic(io::Error::from(io::ErrorKind::NotFound), Path::new("a/b.tfa"));
        assert_eq!(err.to_string(), "[Errno 2] No such file or directory: 'a/b.tfa'");
    }

    #[test]
    fn text_mode_line_endings() {
        assert_eq!(text_mode("a\nb"), if cfg!(windows) { "a\r\nb" } else { "a\nb" });
    }
}
