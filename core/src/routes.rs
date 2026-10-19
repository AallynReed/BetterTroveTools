//! The plain-HTTP surface bottle used to serve next to eel (`/api/cache/...`, the image
//! proxy, the Blueprint Editor's `/api/...`). The shell serves these on its own URI scheme;
//! the page's bridge rewrites `fetch("/api/...")` to it.

use std::collections::HashMap;

use serde_json::Value;

use crate::paths::get_cache_root;

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub method: String,
    /// Path without the query string, e.g. `/api/cache/installed_mods.json`.
    pub path: String,
    /// The raw query string (no leading `?`).
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// A query parameter, percent-decoded. The last one wins when repeated, as in bottle.
    pub fn query_param(&self, name: &str) -> Option<String> {
        parse_query(&self.query).into_iter().rev().find(|(k, _)| k == name).map(|(_, v)| v)
    }
}

/// `application/x-www-form-urlencoded` pairs, decoded.
pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(&k.replace('+', " ")), percent_decode(&v.replace('+', " ")))
        })
        .collect()
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Response { status, headers: vec![("Content-Type".into(), content_type.into())], body }
    }

    /// `json.dumps(payload)` with `Cache-Control: no-store`.
    pub fn json(payload: &Value, status: u16) -> Self {
        Response::new(status, "application/json", crate::json::dumps(payload).into_bytes()).header("Cache-Control", "no-store")
    }

    pub fn bytes(body: Vec<u8>, content_type: &str) -> Self {
        Response::new(200, content_type, body)
    }

    /// bottle.HTTPError(status, message).
    pub fn error(status: u16, message: &str) -> Self {
        Response::new(status, "text/plain; charset=utf-8", message.as_bytes().to_vec())
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
        self.headers.push((name.into(), value.into()));
        self
    }
}

/// `<name>` captures from the route pattern.
pub type Params = HashMap<String, String>;
pub type RouteFn = fn(&Request, &Params) -> Response;

pub struct Route {
    pub method: &'static str,
    /// bottle syntax: `/api/rigs/<skeleton>/graph`.
    pub pattern: &'static str,
    pub handler: RouteFn,
}

impl Route {
    pub const fn get(pattern: &'static str, handler: RouteFn) -> Self {
        Route { method: "GET", pattern, handler }
    }

    pub const fn post(pattern: &'static str, handler: RouteFn) -> Self {
        Route { method: "POST", pattern, handler }
    }

    fn matches(&self, path: &str) -> Option<Params> {
        let pat: Vec<&str> = self.pattern.trim_matches('/').split('/').collect();
        let got: Vec<&str> = path.trim_matches('/').split('/').collect();
        if pat.len() != got.len() {
            return None;
        }
        let mut params = Params::new();
        for (p, g) in pat.iter().zip(&got) {
            if let Some(name) = p.strip_prefix('<').and_then(|p| p.strip_suffix('>')) {
                if g.is_empty() {
                    return None;
                }
                params.insert(name.to_string(), percent_decode(g));
            } else if p != g {
                return None;
            }
        }
        Some(params)
    }
}

pub fn routes() -> Vec<Route> {
    #[allow(unused_mut)]
    let mut all = vec![Route::get("/api/cache/<filename>", serve_cache)];
    #[cfg(feature = "home")]
    all.extend(crate::home::routes());
    #[cfg(feature = "blueprint")]
    all.extend(crate::blueprint::routes());
    all
}

/// Dispatches one request. Unknown paths are 404s.
pub fn handle(req: &Request) -> Response {
    static ROUTES: std::sync::OnceLock<Vec<Route>> = std::sync::OnceLock::new();
    let routes = ROUTES.get_or_init(routes);
    if req.method.eq_ignore_ascii_case("OPTIONS") {
        return Response::new(204, "text/plain", Vec::new());
    }
    for route in routes {
        if !route.method.eq_ignore_ascii_case(&req.method) && !(route.method == "GET" && req.method.eq_ignore_ascii_case("HEAD")) {
            continue;
        }
        if let Some(params) = route.matches(&req.path) {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (route.handler)(req, &params)));
            return outcome.unwrap_or_else(|_| Response::error(500, "Internal Server Error"));
        }
    }
    Response::error(404, "Not found")
}

/// `bottle.static_file`'s content-type guess.
pub fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" | "log" | "cfg" => "text/plain; charset=UTF-8",
        "html" => "text/html; charset=UTF-8",
        "js" => "application/javascript",
        "css" => "text/css",
        _ => "application/octet-stream",
    }
}

/// main.py `serve_cache`: a file in the cache root, else the first match anywhere below it.
fn serve_cache(_req: &Request, params: &Params) -> Response {
    let filename = &params["filename"];
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Response::error(403, "Forbidden");
    }
    let root = get_cache_root();
    let direct = root.join(filename);
    let path = if direct.is_file() {
        Some(direct)
    } else {
        walkdir::WalkDir::new(&root).into_iter().filter_map(|e| e.ok()).find(|e| e.file_type().is_file() && e.file_name().to_string_lossy() == filename.as_str()).map(|e| e.into_path())
    };
    match path.and_then(|p| std::fs::read(&p).ok()) {
        Some(body) => Response::bytes(body, guess_mime(filename)).header("Cache-Control", "no-cache, no-store, must-revalidate"),
        None => Response::error(404, "Cache file not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_params() {
        let r = Route::get("/api/rigs/<skeleton>/anim/<name>", |_, _| Response::error(200, ""));
        let p = r.matches("/api/rigs/biped/anim/run%20fast").unwrap();
        assert_eq!(p["skeleton"], "biped");
        assert_eq!(p["name"], "run fast");
        assert!(r.matches("/api/rigs/biped/graph").is_none());
    }

    #[test]
    fn query_decoding() {
        let q = parse_query("url=https%3A%2F%2Fi0.hdslb.com%2Fa.jpg&x=a+b");
        assert_eq!(q[0].1, "https://i0.hdslb.com/a.jpg");
        assert_eq!(q[1].1, "a b");
    }
}
