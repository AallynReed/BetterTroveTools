//! Repairs a Trove install from Trion's patch CDN: every file the current build lists that
//! is missing or the wrong size is downloaded again. A deep check also compares each file's
//! MD5 with the one the CDN reports, which costs a request per file.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use md5::{Digest, Md5};
use parking_lot::Mutex;
use rayon::prelude::*;
use serde_json::{json, Value};

use crate::{http, Args, Cmd, Resp};

const CDN: &str = "https://trove-update.dyn.triongames.com/kiwi-live-client-patch";
/// BTT keeps its own devtool.bat (see `executable::ensure_devtool`).
const SKIP: [&str; 1] = ["devtool.bat"];
const WORKERS: usize = 8;
const ATTEMPTS: usize = 3;

static BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("repair_game_install", start),
        Cmd::std("cancel_game_repair", |_| {
            CANCEL.store(true, Ordering::SeqCst);
            Ok(Resp::ok(Value::Null).into())
        }),
    ]
}

#[derive(Debug, PartialEq)]
pub struct Entry {
    pub path: String,
    pub sha1: String,
    pub size: u64,
}

/// `version|content/<path>|...` → (version, content path).
pub fn parse_pointer(text: &str) -> Result<(String, String)> {
    let mut fields = text.trim().split('|').map(str::trim);
    match (fields.next(), fields.next()) {
        (Some(version), Some(path)) if !version.is_empty() && !path.is_empty() => {
            Ok((version.to_string(), path.strip_prefix("content/").unwrap_or(path).to_string()))
        }
        _ => bail!("The update server sent a malformed version pointer."),
    }
}

/// `version <tag>`, then one `path:sha1:size` line per file. Paths come back with `/` and
/// any that would leave the install folder are dropped.
pub fn parse_manifest(text: &str) -> Result<(String, Vec<Entry>)> {
    let mut lines = text.lines();
    let version = lines
        .next()
        .and_then(|l| l.strip_prefix("version "))
        .map(|v| v.trim().to_string())
        .ok_or_else(|| anyhow!("The update server sent a malformed manifest."))?;
    let entries = lines
        .filter_map(|line| {
            let mut parts = line.trim().rsplitn(3, ':');
            let size = parts.next()?.parse().ok()?;
            let sha1 = parts.next()?.to_string();
            let path = parts.next()?.replace('\\', "/");
            is_relative(&path).then_some(Entry { path, sha1, size })
        })
        .collect();
    Ok((version, entries))
}

fn is_relative(path: &str) -> bool {
    !path.is_empty() && !path.contains(':') && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)))
}

/// PTS installs live in a folder named PTS; everything else is Live.
pub fn pointer_file(game_dir: &Path) -> &'static str {
    let pts = game_dir.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("pts"));
    if pts {
        "kiwi-pts.txt"
    } else {
        "kiwi-live-us.txt"
    }
}

fn looks_like_install(dir: &Path) -> bool {
    ["Trove_x64.exe", "Trove.exe", "Trove.cfg", "blueprints"].iter().any(|n| dir.join(n).exists())
}

/// Windows refuses write access to a running executable.
fn game_running(game_dir: &Path) -> bool {
    cfg!(windows)
        && ["Trove_x64.exe", "Trove.exe"].iter().any(|name| {
            matches!(std::fs::OpenOptions::new().write(true).open(game_dir.join(name)), Err(e) if e.raw_os_error() == Some(32))
        })
}

fn start(a: &Args) -> Result<Value> {
    let game_dir = PathBuf::from(a.trimmed(0));
    let deep = a.bool_or(1, false);
    if !game_dir.is_dir() || !looks_like_install(&game_dir) {
        return Ok(Resp::fail("That folder is not a Trove install.", "NOT_AN_INSTALL").into());
    }
    if game_running(&game_dir) {
        return Ok(Resp::fail("Close Trove before repairing it.", "GAME_RUNNING").into());
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return Ok(Resp::fail("A repair is already running.", "BUSY").into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("game-repair".into()).spawn(move || {
        let summary = repair(&game_dir, deep).unwrap_or_else(|e| json!({ "error": e.to_string() }));
        super::registry::invalidate_trove_locations_cache();
        BUSY.store(false, Ordering::SeqCst);
        emit("done", summary);
    });
    if let Err(e) = spawned {
        BUSY.store(false, Ordering::SeqCst);
        return Err(e.into());
    }
    Ok(Resp::ok(json!({ "started": true })).into())
}

fn emit(stage: &str, fields: Value) {
    let mut payload = json!({ "stage": stage });
    if let (Value::Object(p), Value::Object(f)) = (&mut payload, fields) {
        p.extend(f);
    }
    if let Some(c) = crate::ctx::try_ctx() {
        c.js("receive_game_repair_progress", vec![payload]);
    }
}

fn repair(game_dir: &Path, deep: bool) -> Result<Value> {
    emit("checking", json!({}));
    let (version, content) = parse_pointer(&fetch_text("Trove build version", &format!("{}/public/{}", CDN, pointer_file(game_dir)))?)?;
    let (_, entries) = parse_manifest(&fetch_text("Trove file manifest", &format!("{}/content/{}/{}.manifest", CDN, content, version))?)?;
    let entries: Vec<Entry> = entries.into_iter().filter(|e| !SKIP.contains(&e.path.as_str())).collect();
    if entries.is_empty() {
        bail!("The update server sent an empty manifest.");
    }

    let total = entries.len();
    let (checked, repaired) = (AtomicUsize::new(0), AtomicUsize::new(0));
    let failures = Mutex::new(Vec::new());
    let last_emit = Mutex::new(Instant::now());
    let pool = rayon::ThreadPoolBuilder::new().num_threads(WORKERS).build()?;
    let logged = crate::ctx::try_ctx().map(|c| c.external_request("Trove game files", &format!("{}/content/{}/recovery/", CDN, content)));
    pool.install(|| {
        entries.par_iter().for_each(|entry| {
            if CANCEL.load(Ordering::SeqCst) {
                return;
            }
            match fix(game_dir, &content, entry, deep) {
                Ok(true) => {
                    repaired.fetch_add(1, Ordering::SeqCst);
                }
                Ok(false) => {}
                Err(e) => failures.lock().push(format!("{}: {}", entry.path, e)),
            }
            let done = checked.fetch_add(1, Ordering::SeqCst) + 1;
            let mut last = last_emit.lock();
            if done == total || last.elapsed() >= Duration::from_millis(150) {
                *last = Instant::now();
                let failed = failures.lock().len();
                emit("progress", json!({ "checked": done, "total": total, "repaired": repaired.load(Ordering::SeqCst), "failed": failed }));
            }
        })
    });

    let failures = failures.into_inner();
    if let Some(req) = logged {
        req.finish(failures.is_empty());
    }
    Ok(json!({
        "version": version,
        "total": total,
        "checked": checked.into_inner(),
        "repaired": repaired.into_inner(),
        "failed": failures.len(),
        "errors": failures.iter().take(5).collect::<Vec<_>>(),
        "cancelled": CANCEL.load(Ordering::SeqCst),
    }))
}

fn fetch_text(label: &str, url: &str) -> Result<String> {
    let logged = crate::ctx::try_ctx().map(|c| c.external_request(label, url));
    let text = retry(|| http::read_text(http::raise_for_status(http::send(http::get(url).timeout(Duration::from_secs(60)))?)?))?;
    if let Some(req) = logged {
        req.finish(true);
    }
    Ok(text)
}

fn retry<T>(mut f: impl FnMut() -> Result<T>) -> Result<T> {
    let mut attempt = 1;
    loop {
        match f() {
            Err(_) if attempt < ATTEMPTS && !CANCEL.load(Ordering::SeqCst) => attempt += 1,
            result => return result,
        }
    }
}

/// Downloads `entry` again when it is missing, the wrong size or (deep) the wrong content.
/// True when the file was replaced.
fn fix(game_dir: &Path, content: &str, entry: &Entry, deep: bool) -> Result<bool> {
    let dest = game_dir.join(&entry.path);
    let url = format!("{}/content/{}/recovery/{}?sha1={}", CDN, content, http::quote_safe(&entry.path, "/"), entry.sha1);
    if std::fs::metadata(&dest).is_ok_and(|m| m.is_file() && m.len() == entry.size) {
        if !deep {
            return Ok(false);
        }
        let head = retry(|| http::raise_for_status(http::send(http::request("HEAD", &url).timeout(Duration::from_secs(60)))?))?;
        match md5_header(&head) {
            Some(expected) if expected != file_md5(&dest)? => {}
            _ => return Ok(false),
        }
    }
    retry(|| download(&url, &dest, entry.size))?;
    Ok(true)
}

fn md5_header(resp: &http::Response) -> Option<String> {
    let value = resp.header("x-amz-meta-md5")?.trim().to_ascii_lowercase();
    (value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())).then_some(value)
}

fn file_md5(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buf[..n]);
    }
}

/// Streams the file to a temp file beside `dest`, checks its size and MD5, then swaps it in.
fn download(url: &str, dest: &Path, size: u64) -> Result<()> {
    let resp = http::raise_for_status(http::send(http::get(url).timeout(Duration::from_secs(600)))?)?;
    let expected = md5_header(&resp);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp_name = dest.file_name().ok_or_else(|| anyhow!("bad path"))?.to_os_string();
    tmp_name.push(".btt-repair");
    let tmp = dest.with_file_name(tmp_name);
    let written = (|| -> Result<()> {
        let mut reader = resp.into_reader().take(size + 1);
        let mut file = std::fs::File::create(&tmp)?;
        let mut hasher = Md5::new();
        let mut buf = vec![0u8; 1 << 16];
        let mut len = 0u64;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n])?;
            len += n as u64;
        }
        if len != size {
            bail!("downloaded {} bytes, expected {}", len, size);
        }
        if expected.is_some_and(|md5| md5 != hex::encode(hasher.finalize())) {
            bail!("downloaded file failed its checksum");
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, dest)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pointer() {
        let text = "STABLE-103-457-A-339204|content/pc-live|Oct 20 15:30, STABLE|http://x/motd.html|kiwi_Patch|*\n";
        assert_eq!(parse_pointer(text).unwrap(), ("STABLE-103-457-A-339204".into(), "pc-live".into()));
        assert!(parse_pointer("only-one-field").is_err());
        assert!(parse_pointer("|content/pc-live").is_err());
    }

    #[test]
    fn parses_manifest_and_drops_escaping_paths() {
        let text = "version V1\r\nTrove.cfg:aa:1304\r\nblueprints\\x\\archive0.tfa:bb:42\r\n\r\nbad line\r\n..\\evil.dll:cc:1\r\nC:\\evil.dll:dd:1\r\n/abs:ee:1\r\nsize:ff:notanumber\r\n";
        let (version, entries) = parse_manifest(text).unwrap();
        assert_eq!(version, "V1");
        assert_eq!(
            entries,
            vec![
                Entry { path: "Trove.cfg".into(), sha1: "aa".into(), size: 1304 },
                Entry { path: "blueprints/x/archive0.tfa".into(), sha1: "bb".into(), size: 42 },
            ]
        );
        assert!(parse_manifest("Trove.cfg:aa:1").is_err());
    }

    #[test]
    fn picks_branch_from_folder() {
        assert_eq!(pointer_file(Path::new(r"C:\Glyph\Games\Trove\PTS")), "kiwi-pts.txt");
        assert_eq!(pointer_file(Path::new(r"C:\Glyph\Games\Trove\Live")), "kiwi-live-us.txt");
        assert_eq!(pointer_file(Path::new("/steam/common/Trove/Games/Trove/Live")), "kiwi-live-us.txt");
    }
}
