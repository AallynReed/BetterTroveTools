//! A request body the way bottle 0.13 reads it into `request.forms` / `request.files`:
//! the same line-based multipart parser (boundaries only on whole lines, the CRLF before
//! one dropped), the same header tokenizer, the same errors. File parts borrow from the
//! request body rather than copying it.

use crate::routes::{percent_decode, Request};

use super::pyobj;
use crate::py;

/// bottle's `MEMFILE_MAX`, which the editor raises to 256 MiB.
const MEM_LIMIT: usize = 256 * 1024 * 1024;
const DISK_LIMIT: usize = 1 << 30;

pub struct Upload<'a> {
    pub filename: String,
    pub data: &'a [u8],
}

#[derive(Default)]
pub struct Form<'a> {
    /// Form fields: `None` values are ones `getunicode` can't decode.
    fields: Vec<(Option<String>, Option<String>)>,
    files: Vec<(Option<String>, Upload<'a>)>,
}

#[derive(Debug)]
pub enum FormError {
    /// A `bottle.HTTPError`: status and message.
    Http(u16, String),
    /// Something bottle doesn't catch, so a 500.
    Internal,
}

fn multipart_error(msg: &str) -> FormError {
    FormError::Http(400, format!("MultipartError: {msg}"))
}

impl<'a> Form<'a> {
    /// `_upload(field)`: the last file sent under `field`, if it has a filename.
    pub fn upload(&self, field: &str) -> Option<&Upload<'a>> {
        self.files.iter().rev().find(|(n, _)| n.as_deref() == Some(field)).map(|(_, u)| u).filter(|u| !u.filename.is_empty())
    }

    /// `_uploads(field)`: every file sent under `field` that has a filename, in order.
    pub fn uploads(&self, field: &str) -> Vec<&Upload<'a>> {
        self.files.iter().filter(|(n, u)| n.as_deref() == Some(field) && !u.filename.is_empty()).map(|(_, u)| u).collect()
    }

    /// `request.forms.getunicode(field)`.
    pub fn get(&self, field: &str) -> Option<&str> {
        self.fields.iter().rev().find(|(n, _)| n.as_deref() == Some(field)).and_then(|(_, v)| v.as_deref())
    }

    /// `request.forms.getunicode(field, default=default) or default`.
    pub fn text(&self, field: &str, default: &str) -> String {
        match self.get(field) {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => default.to_string(),
        }
    }
}

/// `[(value, {option: value})]`.
pub type HeaderValues = Vec<(String, Vec<(String, String)>)>;

/// `_parse_http_header(h)`: options lowercased, the last one of a name wins.
pub fn parse_http_header(h: &str) -> Result<HeaderValues, FormError> {
    fn set(attrs: &mut Vec<(String, String)>, k: String, v: String) {
        match attrs.iter_mut().find(|(n, _)| *n == k) {
            Some(slot) => slot.1 = v,
            None => attrs.push((k, v)),
        }
    }
    let mut values: Vec<(String, Vec<(String, String)>)> = Vec::new();
    if !h.contains('"') {
        for value in h.split(',') {
            let mut parts = value.split(';');
            values.push((py::strip(parts.next().unwrap_or("")).to_string(), Vec::new()));
            for attr in parts {
                let (name, v) = attr.split_once('=').ok_or(FormError::Internal)?;
                let attrs = &mut values.last_mut().unwrap().1;
                set(attrs, py::strip(name).to_lowercase(), py::strip(v).to_string());
            }
        }
        return Ok(values);
    }
    let (mut lop, mut key): (Option<char>, Option<String>) = (Some(','), None);
    for (quoted, plain, tok) in hsplit(h) {
        let value = if plain.is_empty() { quoted.replace("\\\"", "\"") } else { py::strip(&plain).to_string() };
        match lop {
            Some(',') => values.push((value, Vec::new())),
            Some(';') => {
                if tok == Some('=') {
                    key = Some(value);
                } else if let Some(last) = values.last_mut() {
                    set(&mut last.1, py::strip(&value).to_lowercase(), String::new());
                }
            }
            Some('=') if key.as_deref().is_some_and(|k| !k.is_empty()) => {
                let k = key.take().unwrap();
                if let Some(last) = values.last_mut() {
                    set(&mut last.1, py::strip(&k).to_lowercase(), value);
                }
            }
            _ => {}
        }
        lop = tok;
    }
    Ok(values)
}

/// bottle's `_hsplit` regex: `(?:"((?:[^"\\]|\\.)*)"|([^;,=]+))([;,=]?)`, findall-style.
fn hsplit(h: &str) -> Vec<(String, String, Option<char>)> {
    let s: Vec<char> = h.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        let mut matched = None;
        if s[i] == '"' {
            let mut j = i + 1;
            while j < s.len() {
                match s[j] {
                    '"' => break,
                    '\\' if j + 1 < s.len() && s[j + 1] != '\n' => j += 2,
                    '\\' => {
                        j = s.len();
                        break;
                    }
                    _ => j += 1,
                }
            }
            if j < s.len() {
                matched = Some((s[i + 1..j].iter().collect::<String>(), String::new(), j + 1));
            }
        }
        if matched.is_none() && !matches!(s[i], ';' | ',' | '=') {
            let mut j = i;
            while j < s.len() && !matches!(s[j], ';' | ',' | '=') {
                j += 1;
            }
            matched = Some((String::new(), s[i..j].iter().collect(), j));
        }
        match matched {
            Some((q, p, mut end)) => {
                let tok = s.get(end).copied().filter(|c| matches!(c, ';' | ',' | '='));
                if tok.is_some() {
                    end += 1;
                }
                out.push((q, p, tok));
                i = end;
            }
            None => i += 1,
        }
    }
    out
}

fn decode(raw: &[u8], charset: &str) -> Result<String, FormError> {
    match charset.to_ascii_lowercase().replace('_', "-").as_str() {
        "utf8" | "utf-8" | "u8" | "utf" => py::utf8(raw).map(str::to_string).map_err(|_| FormError::Internal),
        "latin1" | "latin-1" | "iso-8859-1" | "iso8859-1" | "l1" | "8859" => Ok(py::latin1(raw)),
        "ascii" | "us-ascii" if raw.is_ascii() => Ok(py::latin1(raw)),
        _ => Err(FormError::Internal),
    }
}

/// `request.POST`, split into forms and files.
pub fn parse(req: &Request) -> Result<Form<'_>, FormError> {
    let header = req.header("content-type").unwrap_or("");
    let (content_type, options) = parse_http_header(header)?.into_iter().next().ok_or(FormError::Internal)?;
    let option = |k: &str| options.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    if !content_type.starts_with("multipart/") {
        if req.body.len() > MEM_LIMIT {
            return Err(FormError::Http(413, "Request entity too large".into()));
        }
        // Latin-1 then `getunicode`'s UTF-8 recode: percent-decode to bytes, decode strictly.
        let body = py::latin1(&req.body);
        let mut form = Form::default();
        for pair in body.split('&').filter(|p| !p.is_empty()) {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let unquote = |s: &str| -> Vec<u8> {
                let bytes: Vec<u8> = s.replace('+', " ").chars().map(|c| c as u32 as u8).collect();
                percent_decode_bytes(&bytes)
            };
            let key = py::latin1(&unquote(k));
            let value = std::str::from_utf8(&unquote(v)).ok().map(str::to_string);
            form.fields.push((Some(key), value));
        }
        return Ok(form);
    }
    let charset = option("charset").unwrap_or_else(|| "utf8".into());
    let boundary = option("boundary").filter(|b| !b.is_empty()).ok_or_else(|| multipart_error("Invalid content type header, missing boundary"))?;
    if 65536 - 6 < boundary.len() {
        return Err(multipart_error("Boundary does not fit into buffer_size."));
    }
    parse_multipart(&req.body, boundary.as_bytes(), &charset)
}

fn percent_decode_bytes(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// CRLF-terminated lines of `body`: `(start, end, has_crlf)`.
struct Lines<'a> {
    body: &'a [u8],
    pos: usize,
}

impl Iterator for Lines<'_> {
    type Item = (usize, usize, bool);

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.body.len() {
            return None;
        }
        let start = self.pos;
        let rest = &self.body[start..];
        let mut i = 0;
        while let Some(off) = rest[i..].iter().position(|&b| b == b'\r') {
            let at = i + off;
            if rest.get(at + 1) == Some(&b'\n') {
                self.pos = start + at + 2;
                return Some((start, start + at, true));
            }
            i = at + 1;
        }
        self.pos = self.body.len();
        Some((start, self.body.len(), false))
    }
}

struct Part {
    headers: Vec<(String, String)>,
    in_body: bool,
    name: Option<String>,
    filename: Option<String>,
    charset: String,
    content_length: i64,
    body: Option<(usize, usize)>,
    size: usize,
}

impl Part {
    fn new(charset: &str) -> Self {
        Part { headers: Vec::new(), in_body: false, name: None, filename: None, charset: charset.into(), content_length: -1, body: None, size: 0 }
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().rev().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    fn buffered(&self) -> bool {
        self.in_body && self.size <= MEM_LIMIT
    }

    fn finish_header(&mut self) -> Result<(), FormError> {
        self.in_body = true;
        let disposition = self.header("Content-Disposition").filter(|v| !v.is_empty()).map(str::to_string);
        let disposition = disposition.ok_or_else(|| multipart_error("Content-Disposition header is missing."))?;
        let (_, options) = parse_http_header(&disposition)?.into_iter().next().ok_or(FormError::Internal)?;
        let opt = |k: &str| options.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        self.name = opt("name");
        if let Some(mut f) = opt("filename") {
            let chars: Vec<char> = f.chars().collect();
            if chars.get(1..3) == Some(&[':', '\\']) || f.starts_with("\\\\") {
                f = f.rsplit('\\').next().unwrap_or("").to_string();
            }
            self.filename = Some(f);
        }
        if let Some(ct) = self.header("Content-Type").filter(|v| !v.is_empty()).map(str::to_string) {
            let (_, options) = parse_http_header(&ct)?.into_iter().next().ok_or(FormError::Internal)?;
            if let Some((_, cs)) = options.iter().find(|(n, _)| n == "charset").filter(|(_, v)| !v.is_empty()) {
                self.charset = cs.clone();
            }
        }
        if let Some(cl) = self.header("Content-Length") {
            self.content_length = pyobj::int_from_str(cl).ok_or(FormError::Internal)? as i64;
        }
        Ok(())
    }
}

fn parse_multipart<'a>(body: &'a [u8], boundary: &[u8], charset: &str) -> Result<Form<'a>, FormError> {
    let separator = [b"--", boundary].concat();
    let terminator = [separator.as_slice(), b"--"].concat();
    let mut lines = Lines { body, pos: 0 };
    let line_of = |(s, e, _): (usize, usize, bool)| &body[s..e];

    let first = loop {
        match lines.next() {
            None => return Err(multipart_error("Stream does not contain boundary")),
            Some(l) if line_of(l) == separator.as_slice() || line_of(l) == terminator.as_slice() => break line_of(l),
            Some(_) => {}
        }
    };
    let mut form = Form::default();
    if first == terminator.as_slice() {
        if lines.next().is_some() {
            return Err(multipart_error("Found data after empty multipart stream"));
        }
        return Ok(form);
    }

    let (mut mem_used, mut disk_used) = (0usize, 0usize);
    let mut is_tail = false;
    let mut last = first;
    let mut part = Part::new(charset);
    let mut terminated = false;
    for l in lines.by_ref() {
        let (start, end, nl) = l;
        let line = &body[start..end];
        last = line;
        if !is_tail && (line == separator.as_slice() || line == terminator.as_slice()) {
            if !part.in_body {
                return Err(multipart_error("Incomplete part: Header section not closed."));
            }
            let buffered = part.buffered();
            if buffered {
                mem_used += part.size;
            } else {
                disk_used += part.size;
            }
            let data = part.body.map(|(s, e)| &body[s..e]).unwrap_or(&[]);
            match part.filename.as_deref() {
                Some(f) if !f.is_empty() => form.files.push((part.name.clone(), Upload { filename: f.to_string(), data })),
                _ if buffered => form.fields.push((part.name.clone(), Some(decode(data, &part.charset)?))),
                _ => form.files.push((part.name.clone(), Upload { filename: String::new(), data })),
            }
            if line == terminator.as_slice() {
                terminated = true;
                break;
            }
            part = Part::new(charset);
            continue;
        }
        is_tail = !nl;
        if part.in_body {
            if line.is_empty() && !nl {
                continue;
            }
            let s = part.body.map_or(start, |(s, _)| s);
            part.body = Some((s, end));
            part.size = end - s;
            if part.content_length > 0 && part.size as i64 > part.content_length {
                return Err(multipart_error("Size of body exceeds Content-Length header."));
            }
        } else {
            let text = decode(line, &part.charset)?;
            if !nl {
                return Err(multipart_error("Unexpected end of line in header."));
            }
            if py::strip(&text).is_empty() {
                part.finish_header()?;
            } else if text.starts_with([' ', '\t']) && !part.headers.is_empty() {
                let last_header = part.headers.last_mut().unwrap();
                last_header.1.push_str(py::strip(&text));
            } else {
                let (name, value) = text.split_once(':').ok_or_else(|| multipart_error("Syntax error in header: No colon."))?;
                part.headers.push((py::strip(name).to_string(), py::strip(value).to_string()));
            }
        }
        if part.buffered() {
            if part.size + mem_used > MEM_LIMIT {
                return Err(multipart_error("Memory limit reached."));
            }
        } else if part.size + disk_used > DISK_LIMIT {
            return Err(multipart_error("Disk limit reached."));
        }
    }
    if !terminated && last != terminator.as_slice() {
        return Err(multipart_error("Unexpected end of multipart stream."));
    }
    Ok(form)
}

/// `request.query.getunicode(name)`: percent-decoded, then strict UTF-8, else `None`.
pub fn query_text(req: &Request, name: &str) -> Option<String> {
    query_raw(req, name).and_then(|b| String::from_utf8(b).ok())
}

/// `request.query.get(name)` as bytes (bottle hands back the Latin-1 text of these).
pub fn query_raw(req: &Request, name: &str) -> Option<Vec<u8>> {
    let mut found = None;
    for pair in req.query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode(&k.replace('+', " ")) == name {
            found = Some(percent_decode_bytes(v.replace('+', " ").as_bytes()));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(body: &[u8], ct: &str) -> Request {
        Request { method: "POST".into(), headers: vec![("Content-Type".into(), ct.into())], body: body.to_vec(), ..Default::default() }
    }

    #[test]
    fn multipart_fields_and_files() {
        let body = b"--XX\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.blueprint\"\r\nContent-Type: application/octet-stream\r\n\r\nab\r\ncd\r\n--XX\r\nContent-Disposition: form-data; name=\"edits\"\r\n\r\n[1, 2]\r\n--XX\r\nContent-Disposition: form-data; name=\"edits\"\r\n\r\n[3]\r\n--XX--\r\n";
        let r = req(body, "multipart/form-data; boundary=XX");
        let form = parse(&r).unwrap();
        assert_eq!(form.upload("file").unwrap().data, b"ab\r\ncd");
        assert_eq!(form.upload("file").unwrap().filename, "a.blueprint");
        assert_eq!(form.get("edits"), Some("[3]"));
        assert_eq!(form.text("missing", "x"), "x");
        assert!(form.upload("edits").is_none());
    }

    #[test]
    fn multipart_errors() {
        let r = req(b"--XX\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nv\r\n", "multipart/form-data; boundary=XX");
        assert!(matches!(parse(&r), Err(FormError::Http(400, m)) if m == "MultipartError: Unexpected end of multipart stream."));
        let r = req(b"x", "multipart/form-data");
        assert!(matches!(parse(&r), Err(FormError::Http(400, m)) if m.ends_with("missing boundary")));
    }

    #[test]
    fn header_tokenizer() {
        let v = parse_http_header("form-data; name=\"a;b\"; filename=\"c\\\"d.qb\"").unwrap();
        assert_eq!(v[0].0, "form-data");
        assert_eq!(v[0].1, vec![("name".to_string(), "a;b".to_string()), ("filename".to_string(), "c\"d.qb".to_string())]);
    }

    #[test]
    fn urlencoded_body() {
        let r = req(b"name=caf%C3%A9&bad=%FF&x", "application/x-www-form-urlencoded");
        let form = parse(&r).unwrap();
        assert_eq!(form.get("name"), Some("café"));
        assert_eq!(form.get("bad"), None);
        assert_eq!(form.text("x", "d"), "d");
    }
}
