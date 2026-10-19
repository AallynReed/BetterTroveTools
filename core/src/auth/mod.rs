//! backend/auth.py: "Sign in with Discord" through the system browser and a `btt://`
//! deep link, then the signed-in site endpoints the Account view and Modder Tools use.
//!
//! The site hands out a short-lived access token and a single-use refresh token that
//! rotates on every refresh; both are kept encrypted (see [`secure_store`]).

mod launcher_cleanup;
mod secure_store;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::args::{to_str, truthy};
use crate::{http, Args, Cmd, Dialog, Resp, KIWI_API_BASE};

pub use launcher_cleanup::purge_legacy_launcher_secrets;

const USER_AGENT: &str = "BetterTroveTools/1.0";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Release `.tmod`s and banner images can be a few MB.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Owner-view reads (drafts, owner-only fields) live on the site proxy, not the data API.
const SITE_BASE: &str = "https://trove.aallyn.net/site";

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("site_auth_begin_login", |_| begin_login()),
        Cmd::std("site_auth_complete", |a| complete(a.get(0))),
        Cmd::std("site_auth_me", |_| me()),
        Cmd::std("site_auth_logout", |_| logout()),
        Cmd::std("site_mods_list", |_| manage("GET", "/mods/hub/me/projects", "Loading your mods", Body::None)),
        Cmd::std("site_modpacks_list", |_| manage("GET", "/modpacks/hub/me/projects", "Loading your modpacks", Body::None)),
        Cmd::std("site_mod_create", |a| manage("POST", "/mods/hub/projects", "Creating mod", create_body(a))),
        Cmd::std("site_modpack_create", |a| manage("POST", "/modpacks/hub/projects", "Creating modpack", create_body(a))),
        Cmd::std("site_mod_update", |a| manage("PATCH", &project("/mods/hub", a, ""), "Updating mod", json_or(a.get(2), json!({})))),
        Cmd::std("site_modpack_update", |a| {
            manage("PATCH", &project("/modpacks/hub", a, ""), "Updating modpack", json_or(a.get(2), json!({})))
        }),
        Cmd::std("site_mod_delete", |a| manage("DELETE", &project("/mods/hub", a, ""), "Deleting mod", Body::None)),
        Cmd::std("site_modpack_delete", |a| manage("DELETE", &project("/modpacks/hub", a, ""), "Deleting modpack", Body::None)),
        Cmd::std("site_mod_detail", |a| manage_site(&project("/mods", a, ""), "Loading mod")),
        Cmd::std("site_modpack_detail", |a| manage_site(&project("/modpacks", a, ""), "Loading modpack")),
        Cmd::std("site_mod_releases", |a| manage_site(&project("/mods", a, "/releases"), "Loading releases")),
        Cmd::std("site_mod_release_upload", release_upload),
        Cmd::std("site_mod_release_update", |a| {
            manage("PATCH", &format!("/mods/hub/releases/{}", seg(a, 0)), "Updating release", json_or(a.get(1), json!({})))
        }),
        Cmd::std("site_mod_release_delete", |a| manage("DELETE", &format!("/mods/hub/releases/{}", seg(a, 0)), "Deleting release", Body::None)),
        Cmd::std("site_mod_banner_upload", |a| banner_upload("/mods/hub", a)),
        Cmd::std("site_modpack_banner_upload", |a| banner_upload("/modpacks/hub", a)),
        Cmd::std("site_mod_collaborator_add", |a| {
            manage("POST", &project("/mods/hub", a, "/collaborators"), "Adding collaborator", Body::Json(json!({ "username": a.get(2) })))
        }),
        Cmd::std("site_mod_collaborator_remove", |a| {
            let path = project("/mods/hub", a, &format!("/collaborators/{}", seg(a, 2)));
            manage("DELETE", &path, "Removing collaborator", Body::None)
        }),
        Cmd::std("site_modpack_collaborator_add", |a| {
            manage("POST", &project("/modpacks/hub", a, "/collaborators"), "Adding collaborator", Body::Json(json!({ "username": a.get(2) })))
        }),
        Cmd::std("site_modpack_collaborator_remove", |a| {
            let path = project("/modpacks/hub", a, &format!("/collaborators/{}", seg(a, 2)));
            manage("DELETE", &path, "Removing collaborator", Body::None)
        }),
        Cmd::std("site_modpack_variant_create", |a| {
            let mut body = json!({ "name": a.get(2) });
            if truthy(a.get(3)) {
                body["copy_from"] = a.get(3).clone();
            }
            manage("POST", &project("/modpacks/hub", a, "/variants"), "Creating variant", Body::Json(body))
        }),
        Cmd::std("site_modpack_variant_update", |a| {
            let path = project("/modpacks/hub", a, &format!("/variants/{}", seg(a, 2)));
            manage("PATCH", &path, "Renaming variant", Body::Json(json!({ "label": a.get(3) })))
        }),
        Cmd::std("site_modpack_variant_delete", |a| {
            manage("DELETE", &project("/modpacks/hub", a, &format!("/variants/{}", seg(a, 2))), "Deleting variant", Body::None)
        }),
        Cmd::std("site_modpack_set_entries", |a| {
            let path = project("/modpacks/hub", a, &format!("/variants/{}/entries", seg(a, 2)));
            let entries = if truthy(a.get(3)) { a.get(3).clone() } else { json!([]) };
            manage("PUT", &path, "Saving mod list", Body::Json(json!({ "entries": entries })))
        }),
        Cmd::std("site_hub_search", hub_search),
        Cmd::std("site_mod_branches", |a| manage("GET", &project("/mods/hub", a, "/branches"), "Loading variants", Body::None)),
        Cmd::std("site_giveaway_enter", |a| manage("POST", &format!("/giveaways/{}/enter", seg(a, 0)), "Entering giveaway", Body::None)),
        Cmd::std("site_giveaway_mine", |_| manage("GET", "/giveaways/mine", "Loading your giveaways", Body::None)),
    ]
}

// --- Python value semantics -----------------------------------------------------------

/// `str(value)`, with `None` for null (what an f-string prints).
fn py_str(v: &Value) -> String {
    if v.is_null() {
        "None".into()
    } else {
        to_str(v)
    }
}

fn py_type(v: &Value) -> &'static str {
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

fn no_attr(v: &Value, attr: &str) -> anyhow::Error {
    anyhow!("'{}' object has no attribute '{}'", py_type(v), attr)
}

/// `int(value)`.
fn py_int(v: &Value) -> Result<i64> {
    match v {
        Value::Bool(b) => Ok(*b as i64),
        Value::Number(n) => Ok(n.as_i64().unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64)),
        Value::String(s) => {
            let digits = s.trim().replace('_', "");
            match digits.parse::<i64>() {
                Ok(n) if !s.trim().starts_with('_') && !s.trim().ends_with('_') && !s.contains("__") => Ok(n),
                _ => Err(anyhow!("invalid literal for int() with base 10: {}", py_repr(s))),
            }
        }
        other => Err(anyhow!("int() argument must be a string, a bytes-like object or a real number, not '{}'", py_type(other))),
    }
}

fn py_repr(s: &str) -> String {
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

/// `response.json()`, with json.JSONDecodeError's message for the common syntax errors.
fn json_loads(bytes: &[u8]) -> Result<Value> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    serde_json::from_slice(bytes).map_err(|err| {
        const KINDS: [(&str, &str); 7] = [
            ("key must be a string", "Expecting property name enclosed in double quotes"),
            ("expected `:`", "Expecting ':' delimiter"),
            ("expected `,` or `}`", "Expecting ',' delimiter"),
            ("expected `,` or `]`", "Expecting ',' delimiter"),
            ("trailing characters", "Extra data"),
            ("expected value", "Expecting value"),
            ("EOF while parsing a value", "Expecting value"),
        ];
        let text = String::from_utf8_lossy(bytes);
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
    })
}

// --- Token state ----------------------------------------------------------------------

/// In-memory mirror of the stored tokens and the last `/me` snapshot.
struct State {
    tokens: Option<Map<String, Value>>,
    user: Option<Value>,
    loaded: bool,
}

static STATE: Mutex<State> = Mutex::new(State { tokens: None, user: None, loaded: false });

/// A truthy token, loading the encrypted store on first use (`_ensure_loaded`).
fn token(key: &str) -> Option<Value> {
    let mut state = STATE.lock();
    if !state.loaded {
        state.tokens = secure_store::load_tokens();
        state.loaded = true;
    }
    state.tokens.as_ref()?.get(key).filter(|v| truthy(v)).cloned()
}

/// Persists a fresh pair from an exchange or a refresh rotation (`_set_tokens`).
fn set_tokens(data: &Value) -> Result<()> {
    let obj = data.as_object().ok_or_else(|| no_attr(data, "get"))?;
    let mut tokens = Map::new();
    for key in ["access_token", "refresh_token"] {
        tokens.insert(key.into(), obj.get(key).cloned().unwrap_or(Value::Null));
    }
    STATE.lock().tokens = Some(tokens.clone());
    secure_store::save_tokens(&tokens)?;
    Ok(())
}

fn clear() {
    {
        let mut state = STATE.lock();
        state.tokens = None;
        state.user = None;
    }
    secure_store::clear_tokens();
}

fn api_base() -> String {
    #[cfg(test)]
    if let Some((api, _)) = tests::BASES.lock().clone() {
        return api;
    }
    KIWI_API_BASE.to_string()
}

fn site_base() -> String {
    #[cfg(test)]
    if let Some((_, site)) = tests::BASES.lock().clone() {
        return site;
    }
    SITE_BASE.to_string()
}

// --- HTTP -----------------------------------------------------------------------------

struct Upload {
    name: String,
    bytes: Vec<u8>,
    mime: String,
}

enum Body {
    None,
    Json(Value),
    /// requests' `data=` fields followed by one `files={"file": ...}` part.
    Multipart(Vec<(&'static str, String)>, Upload),
}

struct Reply {
    status: u16,
    body: Vec<u8>,
}

impl Reply {
    /// `response.ok`.
    fn ok(&self) -> bool {
        self.status < 400
    }

    fn json(&self) -> Result<Value> {
        json_loads(&self.body)
    }
}

/// `urllib3.encode_multipart_formdata` for the fields then the file.
fn multipart(fields: &[(&str, String)], file: &Upload) -> (String, Vec<u8>) {
    use rand::RngCore;
    let mut raw = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut raw);
    let boundary = hex::encode(raw);
    let param = |name: &str, value: &str| format!("{}=\"{}\"", name, value.replace('\n', "%0A").replace('\r', "%0D").replace('"', "%22"));
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend(format!("--{}\r\nContent-Disposition: form-data; {}\r\n\r\n", boundary, param("name", name)).into_bytes());
        body.extend(value.as_bytes());
        body.extend(b"\r\n");
    }
    body.extend(
        format!(
            "--{}\r\nContent-Disposition: form-data; {}; {}\r\nContent-Type: {}\r\n\r\n",
            boundary,
            param("name", "file"),
            param("filename", &file.name),
            file.mime
        )
        .into_bytes(),
    );
    body.extend(&file.bytes);
    body.extend(format!("\r\n--{}--\r\n", boundary).into_bytes());
    (format!("multipart/form-data; boundary={}", boundary), body)
}

const UNRESERVED: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/// `requests.utils.unquote_unreserved`; `None` on a bad escape (requests' `InvalidURL`).
fn unquote_unreserved(uri: &str) -> Option<String> {
    let mut parts = uri.split('%');
    let mut out = parts.next().unwrap_or_default().to_string();
    for part in parts {
        match part.get(0..2).filter(|h| h.chars().all(|c| c.is_ascii_alphanumeric())) {
            Some(h) => {
                let c = u8::from_str_radix(h, 16).ok()? as char;
                if UNRESERVED.contains(c) {
                    out.push(c);
                    out.push_str(&part[2..]);
                } else {
                    out.push('%');
                    out.push_str(part);
                }
            }
            None => {
                out.push('%');
                out.push_str(part);
            }
        }
    }
    Some(out)
}

/// `requests.utils.requote_uri`: what requests does to every URL before sending it.
fn requote_uri(uri: &str) -> String {
    match unquote_unreserved(uri) {
        Some(u) => http::quote_safe(&u, "!#$%&'()*+,/:;=?@[]~"),
        None => http::quote_safe(uri, "!#$&'()*+,/:;=?@[]~"),
    }
}

/// One request the way `requests` sent it. `Err` is a transport failure (`RequestException`).
fn send(method: &str, url: &str, bearer: Option<&str>, body: &Body, timeout: Duration) -> std::result::Result<Reply, String> {
    let mut req = http::request(method, &requote_uri(url)).set("User-Agent", USER_AGENT).timeout(timeout);
    if let Some(token) = bearer {
        req = req.set("Authorization", &format!("Bearer {}", token));
    }
    let sent = match body {
        Body::None if matches!(method, "GET" | "HEAD") => http::send(req),
        // requests sends `Content-Length: 0` for a bodiless POST/PATCH/PUT/DELETE.
        Body::None => http::send_bytes(req, &[]),
        Body::Json(value) => http::send_bytes(req.set("Content-Type", "application/json"), crate::json::dumps(value).as_bytes()),
        Body::Multipart(fields, file) => {
            let (content_type, bytes) = multipart(fields, file);
            http::send_bytes(req.set("Content-Type", &content_type), &bytes)
        }
    };
    let resp = sent.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = http::read_bytes(resp, 256 * 1024 * 1024).map_err(|e| e.to_string())?;
    Ok(Reply { status, body })
}

/// Rotates the refresh token for a new pair. The old one is dead once this returns.
fn refresh() -> Result<bool> {
    let Some(refresh_token) = token("refresh_token") else { return Ok(false) };
    let url = format!("{}/site-auth/refresh", api_base());
    let log = crate::ctx().external_request("Refreshing account session", &url);
    let reply = match send("POST", &url, None, &Body::Json(json!({ "refresh_token": refresh_token })), TIMEOUT) {
        Ok(r) => r,
        Err(_) => {
            log.finish(false);
            return Ok(false);
        }
    };
    log.finish(reply.ok());
    if !reply.ok() {
        return Ok(false);
    }
    match reply.json() {
        Ok(data) => {
            set_tokens(&data)?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

fn current_access() -> String {
    STATE.lock().tokens.as_ref().and_then(|t| t.get("access_token")).map(py_str).unwrap_or_else(|| "None".into())
}

/// `_authed_request`: the bearer call, refreshed once on a 401. `None` when signed out or
/// the request failed in transit.
fn authed_request(method: &str, url: &str, body: &Body, timeout: Duration, label: &str) -> Result<Option<Reply>> {
    let Some(access) = token("access_token") else { return Ok(None) };
    let log = crate::ctx().external_request(label, url);
    let Ok(mut reply) = send(method, url, Some(&py_str(&access)), body, timeout) else {
        log.finish(false);
        return Ok(None);
    };
    if reply.status == 401 && refresh()? {
        match send(method, url, Some(&current_access()), body, timeout) {
            Ok(r) => reply = r,
            Err(_) => {
                log.finish(false);
                return Ok(None);
            }
        }
    }
    log.finish(reply.ok());
    Ok(Some(reply))
}

/// The current site user (cached), or `None` when signed out or the session is gone.
fn fetch_me() -> Result<Option<Value>> {
    let url = format!("{}/site-auth/me", api_base());
    let Some(reply) = authed_request("GET", &url, &Body::None, TIMEOUT, "Loading your account")? else { return Ok(None) };
    if reply.status == 401 {
        clear();
        return Ok(None);
    }
    if !reply.ok() {
        return Ok(STATE.lock().user.clone());
    }
    let user = Some(reply.json()?).filter(|u| !u.is_null());
    STATE.lock().user = user.clone();
    Ok(user)
}

// --- Sign-in --------------------------------------------------------------------------

fn begin_login() -> Result<Value> {
    let url = format!("{}/site-auth/oauth/discord/start?client=app", api_base());
    open_browser(&url);
    Ok(Resp::ok(json!({ "opened": true })).into())
}

#[cfg(not(test))]
fn open_browser(url: &str) {
    let _ = open::that_detached(url);
}

#[cfg(test)]
fn open_browser(url: &str) {
    tests::OPENED.lock().push(url.to_string());
}

/// Swaps the one-time deep-link code for site tokens, then loads `/me`.
fn complete(code: &Value) -> Result<Value> {
    if !truthy(code) {
        return Ok(Resp::fail("Missing sign-in code", "MISSING_CODE").into());
    }
    let url = format!("{}/site-auth/oauth/exchange", api_base());
    let log = crate::ctx().external_request("Completing sign-in", &url);
    let reply = match send("POST", &url, None, &Body::Json(json!({ "code": code })), TIMEOUT) {
        Ok(r) => {
            log.finish(r.ok());
            r
        }
        Err(e) => {
            log.finish(false);
            return Ok(Resp::fail(e, "EXCHANGE_FAILED").into());
        }
    };
    if !reply.ok() {
        return Ok(Resp::fail("Sign-in code was invalid or expired", "EXCHANGE_REJECTED").into());
    }
    set_tokens(&reply.json()?)?;
    let Some(user) = fetch_me()? else {
        clear();
        return Ok(Resp::fail("Signed in but couldn't load your account", "ME_FAILED").into());
    };
    Ok(Resp::ok(json!({ "authenticated": true, "user": user })).into())
}

fn me() -> Result<Value> {
    if token("access_token").is_none() {
        return Ok(Resp::ok(json!({ "authenticated": false, "user": null })).into());
    }
    let user = fetch_me()?;
    Ok(Resp::ok(json!({ "authenticated": user.is_some(), "user": user })).into())
}

/// Revokes this device's refresh token (best effort) and wipes the local tokens.
fn logout() -> Result<Value> {
    if let Some(refresh_token) = token("refresh_token") {
        let url = format!("{}/site-auth/logout", api_base());
        let _ = send("POST", &url, None, &Body::Json(json!({ "refresh_token": refresh_token })), TIMEOUT);
    }
    clear();
    Ok(Resp::ok(json!({ "authenticated": false, "user": null })).into())
}

// --- Manage my mods / modpacks --------------------------------------------------------

/// The `{handle}/{slug}` project path, as the f-string printed it.
fn project(prefix: &str, a: &Args, suffix: &str) -> String {
    format!("{}/projects/{}/{}{}", prefix, seg(a, 0), seg(a, 1), suffix)
}

fn seg(a: &Args, i: usize) -> String {
    py_str(a.get(i))
}

/// `json=value or default`.
fn json_or(value: &Value, default: Value) -> Body {
    Body::Json(if truthy(value) { value.clone() } else { default })
}

/// `(title, visibility="draft")`.
fn create_body(a: &Args) -> Body {
    let visibility = if a.len() > 1 { a.get(1).clone() } else { json!("draft") };
    Body::Json(json!({ "title": a.get(0), "visibility": visibility }))
}

/// A failed envelope whose `error` is whatever the server sent as its detail.
fn fail_with(error: Value, code: &str) -> Value {
    json!({ "success": false, "code": code, "data": {}, "error": error, "meta": {} })
}

fn not_signed_in() -> Value {
    Resp::fail("You need to sign in first.", "NOT_AUTHENTICATED").into()
}

/// `_manage_call`: an authed request folded into the envelope, with the server's own
/// error detail and `HTTP_<status>` code on failure.
fn manage_call(method: &str, url: &str, label: &str, body: Body, timeout: Duration) -> Result<Value> {
    if token("access_token").is_none() {
        return Ok(not_signed_in());
    }
    let Some(reply) = authed_request(method, url, &body, timeout, label)? else {
        return Ok(Resp::fail("Couldn't reach the server.", "REQUEST_FAILED").into());
    };
    if reply.status == 204 {
        return Ok(Resp::ok(json!({ "ok": true })).into());
    }
    let parsed = reply.json().ok().filter(|v| !v.is_null());
    if !reply.ok() {
        let detail = parsed
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|o| [o.get("detail"), o.get("error")].into_iter().flatten().find(|v| truthy(v)).cloned());
        let error = detail.unwrap_or_else(|| json!(format!("Request failed ({}).", reply.status)));
        return Ok(fail_with(error, &format!("HTTP_{}", reply.status)));
    }
    Ok(Resp::ok(parsed.unwrap_or_else(|| json!({ "ok": true }))).into())
}

fn manage(method: &str, path: &str, label: &str, body: Body) -> Result<Value> {
    manage_call(method, &format!("{}{}", api_base(), path), label, body, TIMEOUT)
}

fn manage_site(path: &str, label: &str) -> Result<Value> {
    manage_call("GET", &format!("{}{}", site_base(), path), label, Body::None, TIMEOUT)
}

fn hub_search(a: &Args) -> Result<Value> {
    let raw = a.get(0);
    let q = if truthy(raw) { raw.as_str().ok_or_else(|| no_attr(raw, "strip"))?.trim().to_string() } else { String::new() };
    let limit = if a.len() > 1 { py_int(a.get(1))? } else { 20 };
    let path = if q.is_empty() {
        format!("/mods?sort=downloads&limit={}", limit)
    } else {
        format!("/mods?q={}&sort=downloads&limit={}", http::quote_safe(&q, "/"), limit)
    };
    manage("GET", &path, "Searching mods", Body::None)
}

// --- Uploads --------------------------------------------------------------------------

#[cfg(not(test))]
fn pick_file(dialog: Dialog) -> Option<PathBuf> {
    crate::ctx().host().pick_file(dialog)
}

#[cfg(test)]
fn pick_file(_: Dialog) -> Option<PathBuf> {
    tests::PICK.lock().clone()
}

/// The picked file and its bytes, or `None` when cancelled, unreadable or empty.
fn pick_upload(title: &str, kind: &str, extensions: &[&str]) -> Option<(PathBuf, Vec<u8>)> {
    let path = pick_file(Dialog::new(title).filter(kind, extensions).filter("All files", &["*"]))?;
    let bytes = std::fs::read(&path).ok()?;
    (!bytes.is_empty()).then_some((path, bytes))
}

/// `mimetypes.guess_type(path)[0] or default`. On Windows the registry's `Content Type`
/// wins, as it does for Python.
fn guess_mime(path: &Path, default: &str) -> String {
    let Some(ext) = path.extension().map(|e| format!(".{}", e.to_string_lossy())) else { return default.into() };
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CLASSES_ROOT;
        let key = winreg::RegKey::predef(HKEY_CLASSES_ROOT).open_subkey(&ext);
        if let Ok(mime) = key.and_then(|k| k.get_value::<String, _>("Content Type")) {
            if !mime.is_empty() {
                return mime;
            }
        }
    }
    let builtin = match ext.to_lowercase().as_str() {
        ".zip" => "application/zip",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".json" => "application/json",
        ".txt" => "text/plain",
        _ => default,
    };
    builtin.into()
}

fn upload_part(path: &Path, bytes: Vec<u8>, default_mime: &str) -> Upload {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Upload { name, mime: guess_mime(path, default_mime), bytes }
}

/// Picks a `.tmod`/`.zip` and uploads it as a new release with the UI's tag/title/
/// changelog/status/branch.
fn release_upload(a: &Args) -> Result<Value> {
    if token("access_token").is_none() {
        return Ok(not_signed_in());
    }
    let meta = if truthy(a.get(2)) { a.get(2).clone() } else { json!({}) };
    let meta = meta.as_object().ok_or_else(|| no_attr(&meta, "get"))?;
    let tag = meta.get("tag").filter(|v| truthy(v)).cloned().unwrap_or_else(|| json!(""));
    let tag = tag.as_str().ok_or_else(|| no_attr(&tag, "strip"))?.trim().to_string();
    if tag.is_empty() {
        return Ok(Resp::fail("A version tag is required.", "MISSING_TAG").into());
    }
    let Some((path, bytes)) = pick_upload("Select a .tmod or .zip release", "Trove mod / archive", &["tmod", "zip"]) else {
        return Ok(Resp::ok(json!({ "cancelled": true })).into());
    };
    let field = |key: &str, default: &str| meta.get(key).filter(|v| truthy(v)).map(py_str).unwrap_or_else(|| default.to_string());
    let fields = vec![
        ("tag", tag),
        ("title", field("title", "")),
        ("changelog", field("changelog", "")),
        ("status", field("status", "published")),
        ("branch", field("branch", "")),
    ];
    let url = format!("{}{}", api_base(), project("/mods/hub", a, "/releases/upload"));
    let file = upload_part(&path, bytes, "application/octet-stream");
    manage_call("POST", &url, "Uploading release", Body::Multipart(fields, file), UPLOAD_TIMEOUT)
}

fn banner_upload(prefix: &str, a: &Args) -> Result<Value> {
    if token("access_token").is_none() {
        return Ok(not_signed_in());
    }
    let Some((path, bytes)) = pick_upload("Select a banner image", "Images", &["png", "jpg", "jpeg", "webp", "gif"]) else {
        return Ok(Resp::ok(json!({ "cancelled": true })).into());
    };
    let url = format!("{}{}", api_base(), project(prefix, a, "/banner"));
    let file = upload_part(&path, bytes, "image/png");
    manage_call("POST", &url, "Uploading banner", Body::Multipart(Vec::new(), file), UPLOAD_TIMEOUT)
}
