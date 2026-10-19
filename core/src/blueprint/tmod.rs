//! utils/kiwi_blueprint/tmod.py (+ mod_categories.py): read and build `.tmod` files.
//!
//! `[u64 header_size][u16 version][u16 prop_count]`, the properties (uleb length +
//! UTF-8, twice each), the file table (u8 path length, path, uleb index/offset/size/
//! checksum), then a level-0 zlib stream of the 4-byte-padded contents.

use zlib_rs::DeflateFlush;

use crate::game::hash::{calculate_hash, write_uleb};

use crate::py;
use super::pyzlib::{self, Compressor};
use super::util::{Error, Kind, Result};

const CHUNK: usize = 32768;
const KIWI_MOD_LOADER: &str = "KiwiAPI";

/// Category bits in order (mod_categories.py): `1 << index`.
const CATEGORIES: [&str; 19] = [
    "Allies", "Banners", "Boats and Sails", "Cosmetics", "Costumes", "Dragons", "Fishing", "GUI", "Helmets", "Language", "Mag Riders", "Mounts", "NPCs", "Wings", "Automation",
    "Optimization", "Reskin", "Waypoint", "Radar",
];

fn err(msg: impl Into<String>) -> Error {
    Error::value(Kind::Tmod, msg)
}

/// `flags_from_tags`.
fn flags_from_tags<'a>(tags: impl Iterator<Item = &'a str>) -> u64 {
    tags.map(|t| py::strip(t).to_lowercase()).filter_map(|t| CATEGORIES.iter().position(|c| c.to_lowercase() == t)).fold(0, |acc, i| acc | 1 << i)
}

struct Entry {
    path: String,
    offset: u32,
    size: u32,
    checksum: u32,
}

pub struct Tmod {
    pub properties: Vec<(String, String)>,
    pub files: Vec<(String, Vec<u8>)>,
}

/// troveio `read_leb128`, failing with Python's exception text.
fn read_leb(buf: &[u8], mut pos: usize) -> std::result::Result<(u32, usize), String> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let byte = *buf.get(pos).ok_or("index out of range")?;
        pos += 1;
        result |= ((byte & 0x7F) as u64).wrapping_shl(shift);
        if byte & 0x80 == 0 {
            return Ok((result as u32, pos));
        }
        shift += 7;
        if shift >= 64 {
            return Err("varint too long".into());
        }
    }
}

/// `_utf8_char_span`.
fn char_span(data: &[u8], pos: usize, chars: u32) -> std::result::Result<usize, String> {
    let mut end = pos;
    for _ in 0..chars {
        let lead = *data.get(end).ok_or("index out of range")?;
        end += match lead {
            0..=0x7F => 1,
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return Err("not a UTF-8 lead byte".into()),
        };
    }
    if end > data.len() {
        return Err("header string runs past the end of the file".into());
    }
    Ok(end - pos)
}

type Header = (Vec<(String, String)>, Vec<Entry>, usize);

/// `_parse_header`, reading lengths as bytes or (BTT's quirk) as characters.
fn parse_header(data: &[u8], header_size: usize, prop_count: u16, char_lengths: bool) -> std::result::Result<Header, String> {
    let read_string = |pos: usize, declared: u32| -> std::result::Result<(String, usize), String> {
        let span = if char_lengths { char_span(data, pos, declared)? } else { declared as usize };
        let slice = &data[pos.min(data.len())..(pos + span).min(data.len())];
        Ok((py::utf8(slice)?.to_string(), pos + span))
    };
    let mut pos = 12;
    let mut properties: Vec<(String, String)> = Vec::new();
    for _ in 0..prop_count {
        let (n, p) = read_leb(data, pos)?;
        let (name, p) = read_string(p, n)?;
        let (n, p) = read_leb(data, p)?;
        let (value, p) = read_string(p, n)?;
        pos = p;
        match properties.iter_mut().find(|(k, _)| *k == name) {
            Some(slot) => slot.1 = value,
            None => properties.push((name, value)),
        }
    }
    let mut entries = Vec::new();
    while pos < header_size {
        let (path, p) = read_string(pos + 1, data[pos] as u32)?;
        let (_index, p) = read_leb(data, p)?;
        let (offset, p) = read_leb(data, p)?;
        let (size, p) = read_leb(data, p)?;
        let (checksum, p) = read_leb(data, p)?;
        pos = p;
        entries.push(Entry { path, offset, size, checksum });
    }
    Ok((properties, entries, pos))
}

fn slice_of<'a>(stream: &'a [u8], e: &Entry) -> &'a [u8] {
    let start = (e.offset as usize).min(stream.len());
    let end = (e.offset as usize + e.size as usize).min(stream.len());
    &stream[start..end.max(start)]
}

/// `_verify_stream`: a few non-empty files hashing right is conclusive.
fn verify_stream(stream: &[u8], entries: &[Entry]) -> bool {
    let mut checked = 0;
    for e in entries.iter().filter(|e| e.size != 0) {
        let end = e.offset as usize + e.size as usize;
        if end > stream.len() || calculate_hash(&stream[e.offset as usize..end]) != e.checksum {
            return false;
        }
        checked += 1;
        if checked >= 4 {
            return true;
        }
    }
    true
}

/// `_manual_decompress`: strip Trove's stored-block framing.
fn manual_decompress(data: &[u8]) -> Vec<u8> {
    let stop = data.len().saturating_sub(5);
    let buf = if stop > 7 { &data[7..stop] } else { &[][..] };
    let mut out = Vec::with_capacity(buf.len());
    let mut pos = 0;
    for _ in 0..buf.len() / (CHUNK + 5) {
        out.extend_from_slice(&buf[pos..pos + CHUNK]);
        pos += CHUNK + 5;
    }
    out.extend_from_slice(&buf[pos..]);
    out
}

/// `_decompress_file_stream`: zlib first, the manual de-framer when zlib's bytes don't check out.
fn decompress_file_stream(compressed: &[u8], entries: &[Entry]) -> Vec<u8> {
    let primary = pyzlib::decompressobj(compressed, 15).ok().map(|i| i.data);
    if let Some(p) = &primary {
        if verify_stream(p, entries) {
            return primary.unwrap();
        }
    }
    let manual = manual_decompress(compressed);
    if verify_stream(&manual, entries) {
        return manual;
    }
    primary.unwrap_or(manual)
}

/// `read_tmod(data)`: the properties and the packed files.
pub fn read_tmod(data: &[u8]) -> Result<Tmod> {
    if data.len() < 12 {
        return Err(err("file too small to be a .tmod"));
    }
    let header_size = u64::from_le_bytes(data[..8].try_into().unwrap());
    let prop_count = u16::from_le_bytes([data[10], data[11]]);
    if !(12..=data.len() as u64).contains(&header_size) {
        return Err(err("declared header size is outside the file"));
    }
    let header_size = header_size as usize;
    let attempt = |chars: bool| parse_header(data, header_size, prop_count, chars).ok().filter(|h| h.2 == header_size);
    let (properties, entries, _) = match attempt(false).or_else(|| attempt(true)) {
        Some(h) => h,
        // Neither reading holds: the strict one's own error, else the size mismatch.
        None => {
            return Err(match parse_header(data, header_size, prop_count, false) {
                Err(e) => err(format!("malformed .tmod file: {e}")),
                Ok(_) => err("the file table does not end where the declared header size says"),
            })
        }
    };
    let stream = decompress_file_stream(&data[header_size..], &entries);
    let files = entries.iter().map(|e| (e.path.clone(), slice_of(&stream, e).to_vec())).collect();
    Ok(Tmod { properties, files })
}

/// `build_tmod(version, properties, files)`.
pub fn build_tmod(version: u16, properties: &[(String, String)], files: &[(String, Vec<u8>)]) -> Result<Vec<u8>> {
    if files.is_empty() {
        return Err(err("a .tmod needs at least one file"));
    }
    let mut props: Vec<(String, String)> = properties.to_vec();
    let set = |props: &mut Vec<(String, String)>, k: &str, v: String| match props.iter_mut().find(|(n, _)| n == k) {
        Some(slot) => slot.1 = v,
        None => props.push((k.to_string(), v)),
    };
    set(&mut props, "modLoader", KIWI_MOD_LOADER.to_string());
    let tags = props.iter().find(|(k, _)| k == "tags").map(|(_, v)| v.clone()).filter(|t| !t.is_empty());
    if let Some(tags) = tags.filter(|_| !props.iter().any(|(k, _)| k == "flags")) {
        let flags = flags_from_tags(tags.split(','));
        if flags != 0 {
            set(&mut props, "flags", flags.to_string());
        }
    }

    let mut stream: Vec<u8> = Vec::with_capacity(files.iter().map(|f| f.1.len() + 3).sum());
    let mut table = Vec::new();
    for (raw_path, content) in files {
        let mut path = raw_path.replace('\\', "/").trim_start_matches('/').to_string();
        if !path.to_lowercase().ends_with(".cfg") {
            path = path.to_lowercase();
        }
        if path.len() > 255 {
            return Err(err(format!("internal path too long for the .tmod format (>255 bytes): {path}")));
        }
        let size = content.len();
        table.push(path.len() as u8);
        table.extend_from_slice(path.as_bytes());
        table.extend(write_uleb(0));
        table.extend(write_uleb(if size > 0 { stream.len() as u64 } else { 0 }));
        table.extend(write_uleb(size as u64));
        table.extend(write_uleb(calculate_hash(content) as u64));
        stream.extend_from_slice(content);
        stream.resize(stream.len() + (4 - size % 4) % 4, 0);
    }
    let mut compressed = Vec::with_capacity(stream.len() + stream.len() / CHUNK * 5 + 16);
    let mut c = Compressor::new(0, 15);
    for chunk in stream.chunks(CHUNK) {
        c.call(chunk, DeflateFlush::NoFlush, &mut compressed);
    }
    c.call(&[], DeflateFlush::SyncFlush, &mut compressed);

    let mut header = vec![0u8; 8];
    header.extend_from_slice(&version.to_le_bytes());
    header.extend_from_slice(&(props.len() as u16).to_le_bytes());
    for (k, v) in &props {
        header.extend(write_uleb(k.len() as u64));
        header.extend_from_slice(k.as_bytes());
        header.extend(write_uleb(v.len() as u64));
        header.extend_from_slice(v.as_bytes());
    }
    header.extend_from_slice(&table);
    let size = header.len() as u64;
    header[..8].copy_from_slice(&size.to_le_bytes());
    header.extend_from_slice(&compressed);
    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_then_read() {
        let props = vec![("title".to_string(), "Café".to_string()), ("tags".to_string(), "Mounts, wings".to_string())];
        let files = vec![("Blueprints\\A.blueprint".to_string(), b"abc".to_vec()), ("x.CFG".to_string(), vec![7; 70000])];
        let built = build_tmod(1, &props, &files).unwrap();
        let read = read_tmod(&built).unwrap();
        assert_eq!(read.properties[2], ("modLoader".to_string(), "KiwiAPI".to_string()));
        assert_eq!(read.properties[3], ("flags".to_string(), (2048 | 8192).to_string()));
        assert_eq!(read.files[0], ("blueprints/a.blueprint".to_string(), b"abc".to_vec()));
        assert_eq!(read.files[1].0, "x.CFG");
        assert_eq!(read.files[1].1.len(), 70000);
        assert!(matches!(read_tmod(&built[..20]), Err(Error::Value(Kind::Tmod, m)) if m == "declared header size is outside the file"));
    }
}
