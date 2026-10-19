//! The endpoints main.py, backend/about.py and backend/locales.py exposed.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::paths::get_cache_root;
use crate::{ctx, http, Args, Cmd, Resp};

/// The repo's metadata.json, compiled in so the binary always reports its own version.
pub const METADATA_JSON: &str = include_str!("../../metadata.json");

pub fn metadata() -> Value {
    serde_json::from_str(METADATA_JSON).unwrap_or_else(|_| json!({}))
}

pub fn app_version() -> String {
    metadata().get("APP_VERSION").and_then(Value::as_str).unwrap_or("0").to_string()
}

pub fn app_name() -> String {
    metadata().get("APP_NAME").and_then(Value::as_str).unwrap_or("Better Trove Tools").to_string()
}

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::raw("get_startup_url", |_| Ok(ctx().startup_url.lock().clone().map(Value::String).unwrap_or(Value::Null))),
        Cmd::raw("get_app_metadata", |_| Ok(metadata())),
        Cmd::raw("finalize_self_update_exit", finalize_self_update_exit),
        Cmd::raw("start_self_update", start_self_update),
        Cmd::raw("clear_update_cache", |a| clear_update_cache(a.f64_or(0, 300.0))),
        Cmd::raw("get_available_languages", |_| Ok(Value::Array(available_languages(&ctx().web_path("assets/locale"))))),
        Cmd::raw("add_missing_translation_keys", add_missing_translation_keys),
        Cmd::std("get_system_info", |_| get_system_info()),
        Cmd::std("get_app_license", |_| get_app_license()),
    ]
}

// --- about.py --------------------------------------------------------------------------

fn get_system_info() -> Result<Value> {
    let data = json!({
        "os": os_name(),
        "os_release": os_release(),
        "os_version": os_version(),
        "architecture": architecture(),
        "processor": processor(),
        "dev_mode": ctx().dev_mode,
    });
    Ok(Resp::ok(data).spread().into())
}

/// `platform.system()`.
fn os_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "linux" => "Linux",
        "macos" => "Darwin",
        other => other,
    }
}

/// `platform.machine()`.
fn architecture() -> String {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "AMD64".into(),
        ("windows", "aarch64") => "ARM64".into(),
        (_, arch) => arch.into(),
    }
}

#[cfg(windows)]
fn windows_version() -> Option<(u32, u32, u32)> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").ok()?;
    let major: u32 = key.get_value("CurrentMajorVersionNumber").ok()?;
    let minor: u32 = key.get_value("CurrentMinorVersionNumber").ok()?;
    let build: String = key.get_value("CurrentBuildNumber").ok()?;
    Some((major, minor, build.parse().ok()?))
}

/// `platform.release()`: "10"/"11" on Windows, the kernel release elsewhere.
fn os_release() -> String {
    #[cfg(windows)]
    {
        return match windows_version() {
            Some((10, _, build)) if build >= 22000 => "11".into(),
            Some((major, _, _)) => major.to_string(),
            None => String::new(),
        };
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("uname").arg("-r").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }
}

/// `platform.version()`: "10.0.26200" on Windows, `uname -v` elsewhere.
fn os_version() -> String {
    #[cfg(windows)]
    {
        return windows_version().map(|(a, b, c)| format!("{}.{}.{}", a, b, c)).unwrap_or_default();
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("uname").arg("-v").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }
}

/// `platform.processor()`.
fn processor() -> String {
    #[cfg(windows)]
    {
        if let Ok(id) = std::env::var("PROCESSOR_IDENTIFIER") {
            return id;
        }
        String::new()
    }
    #[cfg(not(windows))]
    {
        std::env::consts::ARCH.to_string()
    }
}

fn get_app_license() -> Result<Value> {
    for name in ["LICENSE.md", "LICENSE", "license", "license.txt"] {
        let path = ctx().resource(name);
        if path.is_file() {
            let text = std::fs::read_to_string(path)?;
            return Ok(Resp::ok(json!({ "text": text })).with("text", text).into());
        }
    }
    let text = "License file not found.";
    Ok(Resp::new(false).data(json!({ "text": text })).error(text).code("LICENSE_NOT_FOUND").with("text", text).into())
}

// --- locales.py ------------------------------------------------------------------------

/// `<lang>_<REGION>.json` only.
pub fn is_locale_file(path: &Path) -> bool {
    let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { return false };
    let parts: Vec<&str> = stem.split('_').collect();
    parts.len() == 2
        && (2..=3).contains(&parts[0].chars().count())
        && parts[0].chars().any(|c| c.is_alphabetic())
        && parts[0].chars().all(|c| !c.is_uppercase())
        && (2..=4).contains(&parts[1].chars().count())
        && parts[1].chars().all(|c| c.is_alphabetic())
}

/// Percent of user-facing strings that carry a translation.
pub fn completion(data: &Value) -> i64 {
    let values: Vec<&Value> = match data.get("strings") {
        None | Some(Value::Null) => data.get("keys").and_then(Value::as_object).map(|m| m.values().collect()).unwrap_or_default(),
        Some(strings) => {
            let mut v: Vec<&Value> = strings.as_object().map(|m| m.values().collect()).unwrap_or_default();
            if let Some(c) = data.get("content").and_then(Value::as_object) {
                v.extend(c.values());
            }
            v
        }
    };
    if values.is_empty() {
        return 0;
    }
    let empty = values.iter().filter(|v| v.is_null() || v.as_str() == Some("")).count();
    (((values.len() - empty) as f64 / values.len() as f64) * 100.0) as i64
}

pub fn available_languages(dir: &Path) -> Vec<Value> {
    if !dir.exists() {
        return vec![json!({ "code": "en_US", "name": "English", "percent": 100 })];
    }
    let mut langs: Vec<(String, String, i64)> = Vec::new();
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|e| e == "json").unwrap_or(false)).collect())
        .unwrap_or_default();
    files.sort();
    for path in files {
        if !is_locale_file(&path) {
            continue;
        }
        let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
        let parsed = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let Some(data) = parsed else {
            eprintln!("[locales] skipping unreadable locale file {}", path.display());
            continue;
        };
        let name = data
            .get("meta")
            .and_then(|m| m.get("name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| data.get("language_name").and_then(Value::as_str).filter(|s| !s.is_empty()))
            .unwrap_or(&stem)
            .to_string();
        let percent = if stem == "en_US" { 100 } else { completion(&data) };
        langs.push((stem, name, percent));
    }
    langs.sort_by(|a, b| (a.0 != "en_US", &a.1).cmp(&(b.0 != "en_US", &b.1)));
    langs.into_iter().map(|(code, name, percent)| json!({ "code": code, "name": name, "percent": percent })).collect()
}

fn add_missing_translation_keys(args: &Args) -> Result<Value> {
    if !ctx().dev_mode {
        return Ok(json!({ "success": true, "added": 0, "skipped": "not_dev_mode" }));
    }
    let locale = args.str(0);
    let missing = args.get(1);
    if !crate::args::truthy(missing) {
        return Ok(json!({ "success": true }));
    }
    let file = ctx().web_path("assets/locale").join(format!("{}.json", locale));
    if !file.exists() {
        return Ok(json!({ "success": false, "error": "Locale file not found." }));
    }
    let run = || -> Result<Value> {
        let mut data: Value = serde_json::from_str(&std::fs::read_to_string(&file)?)?;
        let mut items = Vec::new();
        for item in missing.as_array().into_iter().flatten() {
            let (token, kind) = match item {
                Value::Object(o) => (o.get("token").map(crate::args::to_str).unwrap_or_default(), o.get("kind").and_then(Value::as_str).unwrap_or("content").to_string()),
                other => (crate::args::to_str(other), "content".to_string()),
            };
            if !token.is_empty() {
                let kind = if kind == "ui" || kind == "content" { kind } else { "content".into() };
                items.push((token, kind));
            }
        }
        let obj = data.as_object_mut().ok_or_else(|| anyhow::anyhow!("locale file is not an object"))?;
        let new_shape = ["strings", "content", "meta"].iter().any(|k| obj.contains_key(*k));
        let mut added = 0;
        if new_shape {
            for (token, kind) in &items {
                let target = if kind == "ui" { "strings" } else { "content" };
                let map = obj.entry(target).or_insert_with(|| json!({}));
                if let Some(m) = map.as_object_mut() {
                    if !m.contains_key(token) {
                        m.insert(token.clone(), json!(""));
                        added += 1;
                    }
                }
            }
        } else {
            let map = obj.entry("keys").or_insert_with(|| json!({}));
            if let Some(m) = map.as_object_mut() {
                for (token, kind) in &items {
                    if kind == "ui" {
                        continue;
                    }
                    if !m.contains_key(token) {
                        m.insert(token.clone(), json!(""));
                        added += 1;
                    }
                }
            }
        }
        if added > 0 {
            std::fs::write(&file, crate::json::dumps_indent_utf8(&data, 4))?;
        }
        Ok(json!({ "success": true, "added": added }))
    };
    Ok(run().unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() })))
}

// --- Self-update (Windows MSI) ---------------------------------------------------------

const UPDATE_ARTIFACT_SUFFIXES: [&str; 3] = ["msi", "log", "vbs"];

fn finalize_self_update_exit(args: &Args) -> Result<Value> {
    let delay = args.f64_or(0, 1.5);
    ctx().host().exit_after(delay.max(0.2));
    Ok(json!({ "success": true }))
}

fn safe_asset_name(asset_name: &str, version_tag: &str) -> String {
    let candidate = Path::new(asset_name.trim()).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if candidate.to_lowercase().ends_with(".msi") {
        return candidate;
    }
    let tag = if version_tag.is_empty() { "latest" } else { version_tag };
    let clean: String = tag.chars().map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect();
    format!("BetterTroveTools-{}.msi", clean)
}

fn build_update_script(script: &Path, msi: &Path, app: &Path, log: &Path) -> String {
    let q = |p: &Path| p.display().to_string().replace('"', "\"\"");
    let pid = std::process::id();
    [
        "On Error Resume Next".to_string(),
        "Dim shell, fso, service, processes, process, exitCode, success, scriptPath".into(),
        "Set shell = CreateObject(\"WScript.Shell\")".into(),
        "Set fso = CreateObject(\"Scripting.FileSystemObject\")".into(),
        format!("scriptPath = \"{}\"", q(script)),
        String::new(),
        "Function WaitForProcessExit(pid, maxChecks, sleepMs)".into(),
        "    Dim i, svc, procSet".into(),
        "    Set svc = GetObject(\"winmgmts:\\\\.\\root\\cimv2\")".into(),
        "    For i = 1 To maxChecks".into(),
        "        Set procSet = svc.ExecQuery(\"Select * from Win32_Process Where ProcessId = \" & pid)".into(),
        "        If procSet.Count = 0 Then".into(),
        "            WaitForProcessExit = True".into(),
        "            Exit Function".into(),
        "        End If".into(),
        "        WScript.Sleep sleepMs".into(),
        "    Next".into(),
        "    WaitForProcessExit = False".into(),
        "End Function".into(),
        String::new(),
        format!("Call WaitForProcessExit({}, 240, 500)", pid),
        format!("exitCode = shell.Run(\"msiexec.exe /i \"\"{}\"\" /passive /norestart /log \"\"{}\"\"\", 0, True)", q(msi), q(log)),
        "success = (exitCode = 0) Or (exitCode = 1641) Or (exitCode = 3010)".into(),
        String::new(),
        "If success Then".into(),
        "    WScript.Sleep 2000".into(),
        format!("    If fso.FileExists(\"{}\") Then", q(app)),
        format!("        shell.Run \"\"\"\" & \"{}\" & \"\"\"\", 1, False", q(app)),
        "    End If".into(),
        "Else".into(),
        format!("    shell.Run \"explorer.exe /select,\"\"\" & \"{}\" & \"\"\"\", 1, False", q(msi)),
        "End If".into(),
        String::new(),
        "WScript.Sleep 1000".into(),
        "If fso.FileExists(scriptPath) Then".into(),
        "    fso.DeleteFile scriptPath, True".into(),
        "End If".into(),
    ]
    .join("\n")
}

fn start_self_update(args: &Args) -> Result<Value> {
    if !cfg!(windows) {
        return Ok(json!({ "success": false, "error": "Self-update is only supported on Windows." }));
    }
    if ctx().dev_mode {
        return Ok(json!({ "success": false, "error": "Self-update is only available in the packaged app build." }));
    }
    let url = args.trimmed(0);
    let version_tag = args.str(1);
    let asset_name = args.str(2);
    let lower = url.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Ok(json!({ "success": false, "error": "A valid installer download URL is required." }));
    }
    let update_dir = get_cache_root().join("updates");
    std::fs::create_dir_all(&update_dir)?;
    let msi = update_dir.join(safe_asset_name(&asset_name, &version_tag));
    let log = update_dir.join(format!("{}.log", msi.file_stem().unwrap_or_default().to_string_lossy()));
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let script = update_dir.join(format!("apply_update_{}_{}.vbs", now, std::process::id()));

    let req = ctx().external_request(format!("Downloading app update {}", version_tag).trim(), &url);
    let download = || -> Result<()> {
        let resp = http::raise_for_status(http::send(
            http::get(&url)
                .timeout(Duration::from_secs(310))
                .set("User-Agent", "BetterTroveTools-Updater")
                .set("Accept", "application/octet-stream"),
        )?)?;
        let mut file = std::fs::File::create(&msi)?;
        std::io::copy(&mut resp.into_reader(), &mut file)?;
        Ok(())
    };
    if let Err(e) = download() {
        let _ = std::fs::remove_file(&msi);
        req.finish(false);
        return Ok(json!({ "success": false, "error": e.to_string() }));
    }
    req.finish(true);
    let exe = std::env::current_exe()?;
    std::fs::write(&script, build_update_script(&script, &msi, &exe, &log))?;
    std::process::Command::new("wscript.exe").args(["//B", "//NoLogo"]).arg(&script).current_dir(&update_dir).spawn()?;
    Ok(json!({
        "success": true,
        "data": {
            "installer_path": msi.display().to_string(),
            "helper_script": script.display().to_string(),
            "version": version_tag,
        },
    }))
}

/// Deletes leftover update artifacts older than `min_age_seconds`. Returns (files, bytes).
pub fn clear_update_cache_files(min_age_seconds: f64) -> (u64, u64) {
    let dir = get_cache_root().join("updates");
    if !dir.is_dir() {
        return (0, 0);
    }
    let cutoff = SystemTime::now() - Duration::from_secs_f64(min_age_seconds.max(0.0));
    let (mut removed, mut freed) = (0, 0);
    for entry in std::fs::read_dir(&dir).into_iter().flatten().filter_map(|e| e.ok()) {
        let path = entry.path();
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !UPDATE_ARTIFACT_SUFFIXES.contains(&ext.as_str()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || meta.modified().map(|m| m > cutoff).unwrap_or(true) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
            freed += meta.len();
        }
    }
    let _ = std::fs::remove_dir(&dir);
    (removed, freed)
}

fn clear_update_cache(min_age: f64) -> Result<Value> {
    let (removed, freed) = clear_update_cache_files(min_age);
    Ok(json!({ "success": true, "data": { "removed": removed, "freed_bytes": freed } }))
}

/// Startup safety net: drop update artifacts older than a day.
pub fn sweep_stale_update_cache() {
    clear_update_cache_files(24.0 * 60.0 * 60.0);
}

/// The settings file's `close_to_tray` (default on).
pub fn close_to_tray_enabled() -> bool {
    crate::settings::read_settings_dict().get("close_to_tray") != Some(&Value::Bool(false))
}

/// Whether rotation reminders are on (keeps the tray icon visible). Default off.
pub fn notifications_enabled() -> bool {
    matches!(crate::settings::read_settings_dict().get("notifications"), Some(Value::Object(n)) if n.get("enabled") == Some(&Value::Bool(true)))
}

/// main.py `active_game_install`: the remembered install if it still holds a Trove exe,
/// else the first valid detected one.
pub fn active_game_install() -> Option<String> {
    let settings: Map<String, Value> = crate::settings::read_settings_dict();
    if let Some(saved) = settings.get("last_game_path").and_then(Value::as_str) {
        let saved = saved.trim();
        if !saved.is_empty() && crate::game::executable::find_trove_executable(Path::new(saved)).is_some() {
            return Some(saved.to_string());
        }
    }
    crate::game::registry::get_trove_locations().into_iter().find(|g| g.is_valid()).map(|g| g.path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_files() {
        assert!(is_locale_file(Path::new("en_US.json")));
        assert!(is_locale_file(Path::new("zh_CN.json")));
        assert!(!is_locale_file(Path::new("_ui_ids.json")));
        assert!(!is_locale_file(Path::new("locale.schema.json")));
    }

    #[test]
    fn languages_match_python() {
        crate::ctx::testing::init();
        let langs = available_languages(&ctx().web_path("assets/locale"));
        assert_eq!(langs[0]["code"], "en_US");
        assert_eq!(langs.len(), 9);
    }
}
