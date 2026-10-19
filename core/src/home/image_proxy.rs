//! utils/image_proxy.py and main.py's `/proxy/bilibili_image`: Bilibili thumbnails need a
//! Bilibili Referer, so they are fetched here. The outbound URL is rebuilt from the
//! allowlist below; only the caller's path and query survive.

use std::sync::OnceLock;
use std::time::Duration;

use crate::http;
use crate::routes::{parse_query, Params, Request, Response};

const ALLOWED_HOSTS: [&str; 7] = ["hdslb.com", "i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com", "s1.hdslb.com", "s2.hdslb.com", "archive.biliimg.com"];

/// Upstream type → the type we serve. SVG is absent on purpose: it scripts.
const IMAGE_TYPES: [(&str, &str); 7] = [
    ("image/jpeg", "image/jpeg"),
    ("image/jpg", "image/jpeg"),
    ("image/png", "image/png"),
    ("image/gif", "image/gif"),
    ("image/webp", "image/webp"),
    ("image/avif", "image/avif"),
    ("image/bmp", "image/bmp"),
];

const MAX_BYTES: u64 = 16 * 1024 * 1024;

const RESPONSE_HEADERS: [(&str, &str); 3] = [
    ("Cache-Control", "max-age=86400"),
    ("X-Content-Type-Options", "nosniff"),
    ("Content-Security-Policy", "default-src 'none'; sandbox"),
];

/// `urlsplit(url)` → (scheme, netloc, path, query), or `None` where Python raised.
fn urlsplit(url: &str) -> Option<(String, String, String, String)> {
    let url: String = url.trim_start_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\r' | '\n')).collect();
    let mut rest = url.as_str();
    let mut scheme = String::new();
    if let Some(i) = rest.find(':') {
        let candidate = &rest[..i];
        let first_ok = candidate.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
        if first_ok && candidate.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
            scheme = candidate.to_ascii_lowercase();
            rest = &rest[i + 1..];
        }
    }
    let mut netloc = String::new();
    if let Some(after) = rest.strip_prefix("//") {
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        netloc = after[..end].to_string();
        rest = &after[end..];
        // Python either raises on brackets or ends up with a bracketed IP: never allowed.
        if netloc.contains(['[', ']']) {
            return None;
        }
    }
    let rest = rest.split_once('#').map_or(rest, |(before, _)| before);
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    Some((scheme, netloc, path.to_string(), query.to_string()))
}

/// Rebuilds `url` from trusted parts, or `None` if it isn't a Bilibili CDN image URL.
pub fn resolve_image_url(url: Option<&str>) -> Option<String> {
    let (scheme, netloc, path, query) = urlsplit(url.filter(|u| !u.is_empty())?)?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    // Userinfo is dropped, so "hdslb.com@evil.example" is evil.example.
    let hostinfo = netloc.rsplit_once('@').map_or(netloc.as_str(), |(_, h)| h);
    let host = hostinfo.split(':').next().unwrap_or("").to_lowercase();
    let host = host.trim_end_matches('.');
    let safe_host = ALLOWED_HOSTS.iter().find(|h| **h == host)?;
    let mut out = format!("https://{}{}", safe_host, path);
    if !query.is_empty() {
        out.push('?');
        out.push_str(&query);
    }
    Some(out)
}

/// Redirects are not followed: a 302 would be a free hop off the allowlist.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(5)).timeout_read(Duration::from_secs(5)).build()
    })
}

/// (status, body, content type). Never surfaces upstream error text.
pub fn fetch_image(url: Option<&str>) -> (u16, Vec<u8>, &'static str) {
    let Some(safe_url) = resolve_image_url(url) else {
        return (403, b"Forbidden".to_vec(), "text/plain");
    };
    let req = agent()
        .get(&safe_url)
        .set("Referer", "https://www.bilibili.com/")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    let failed = || (502, b"Image fetch failed".to_vec(), "text/plain");
    let Ok(resp) = http::send(req) else { return failed() };
    if resp.status() != 200 {
        return (502, b"Upstream image unavailable".to_vec(), "text/plain");
    }
    let raw_type = resp.header("content-type").unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase();
    let Some(&(_, content_type)) = IMAGE_TYPES.iter().find(|(t, _)| *t == raw_type) else {
        return (502, b"Upstream response is not an image".to_vec(), "text/plain");
    };
    let Ok(body) = http::read_bytes(resp, MAX_BYTES + 1) else { return failed() };
    if body.len() as u64 > MAX_BYTES {
        return (502, b"Upstream image too large".to_vec(), "text/plain");
    }
    (200, body, content_type)
}

/// bottle's `request.query.get('url')`: the last value of a repeated key.
pub fn query_url(query: &str) -> Option<String> {
    parse_query(query).into_iter().rev().find(|(k, _)| k == "url").map(|(_, v)| v)
}

pub fn proxy_bilibili_image(req: &Request, _: &Params) -> Response {
    let (status, body, content_type) = fetch_image(query_url(&req.query).as_deref());
    if status != 200 {
        return Response::error(status, &String::from_utf8_lossy(&body));
    }
    RESPONSE_HEADERS.iter().fold(Response::bytes(body, content_type), |r, (k, v)| r.header(k, v))
}
