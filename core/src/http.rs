//! utils/http.py: one pooled HTTP agent for every outbound call.
//!
//! Unlike `ureq`'s default, [`send`] treats any HTTP status as a response (like
//! `requests`); only transport failures are errors. Call `raise_for_status` to reject
//! non-2xx the way `response.raise_for_status()` did.

use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;

pub use ureq::{Request, Response};

pub fn user_agent() -> String {
    format!("BetterTroveTools/{}", crate::app::app_version())
}

/// The shared agent. Keeps connections alive, so only the first call to a host pays for TLS.
pub fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .max_idle_connections_per_host(16)
            .timeout_connect(Duration::from_secs(15))
            .user_agent(&user_agent())
            .build()
    })
}

pub fn get(url: &str) -> Request {
    agent().get(url)
}

pub fn post(url: &str) -> Request {
    agent().post(url)
}

pub fn request(method: &str, url: &str) -> Request {
    agent().request(method, url)
}

fn unwrap_status(result: std::result::Result<Response, ureq::Error>) -> Result<Response> {
    match result {
        Ok(r) => Ok(r),
        Err(ureq::Error::Status(_, r)) => Ok(r),
        Err(e) => Err(anyhow!(e.to_string())),
    }
}

/// Sends with no body. Non-2xx statuses are returned, not raised.
pub fn send(req: Request) -> Result<Response> {
    unwrap_status(req.call())
}

/// Sends a JSON body.
pub fn send_json(req: Request, body: &Value) -> Result<Response> {
    unwrap_status(req.send_json(body.clone()))
}

/// Sends a urlencoded form.
pub fn send_form(req: Request, form: &[(&str, &str)]) -> Result<Response> {
    unwrap_status(req.send_form(form))
}

/// Sends raw bytes.
pub fn send_bytes(req: Request, body: &[u8]) -> Result<Response> {
    unwrap_status(req.send_bytes(body))
}

/// `response.raise_for_status()`, with requests' wording ("404 Client Error: ...").
pub fn raise_for_status(resp: Response) -> Result<Response> {
    let status = resp.status();
    let kind = match status {
        400..=499 => "Client",
        500..=599 => "Server",
        _ => return Ok(resp),
    };
    Err(anyhow!("{} {} Error: {} for url: {}", status, kind, resp.status_text(), resp.get_url()))
}

pub fn is_ok(resp: &Response) -> bool {
    (200..300).contains(&resp.status())
}

/// The whole body as bytes (no size cap beyond `limit`).
pub fn read_bytes(resp: Response, limit: u64) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    resp.into_reader().take(limit).read_to_end(&mut buf)?;
    Ok(buf)
}

pub fn read_text(resp: Response) -> Result<String> {
    let bytes = read_bytes(resp, 256 * 1024 * 1024)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn read_json(resp: Response) -> Result<Value> {
    let bytes = read_bytes(resp, 256 * 1024 * 1024)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// GET → raise_for_status → JSON, with a timeout.
pub fn get_json(url: &str, timeout: Duration) -> Result<Value> {
    read_json(raise_for_status(send(get(url).timeout(timeout))?)?)
}

/// `urllib.parse.quote(s, safe="")`.
pub fn quote(s: &str) -> String {
    quote_safe(s, "")
}

/// `urllib.parse.quote(s, safe=safe)` (letters, digits and `_.-~` are always safe).
pub fn quote_safe(s: &str, safe: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || "_.-~".contains(c) || safe.contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// `urllib.parse.urlencode(pairs)` (quote_plus semantics).
pub fn urlencode(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", quote_plus(k), quote_plus(v)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn quote_plus(s: &str) -> String {
    quote_safe(s, " ").replace(' ', "+")
}
