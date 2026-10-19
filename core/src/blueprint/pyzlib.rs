//! zlib and zipfile the way CPython 3.14 drives them, so every compressed byte comes out
//! the same: zlib-rs 0.5.2 is zlib-ng 2.2.4's algorithm, and the output buffers are fed
//! in CPython's block sizes, which decides where level-0 (stored) blocks split.

use std::ffi::CStr;

use zlib_rs::c_api::z_stream;
use zlib_rs::deflate::{self, DeflateConfig, DeflateStream};
use zlib_rs::inflate::{self, InflateConfig, InflateStream};
use zlib_rs::{DeflateFlush, InflateFlush, ReturnCode};

use super::py;

const KB: usize = 1024;
const MB: usize = 1024 * KB;
/// pycore_blocks_output_buffer.h: each call's output grows through these.
const BLOCKS: [usize; 17] =
    [32 * KB, 64 * KB, 256 * KB, MB, 4 * MB, 8 * MB, 16 * MB, 16 * MB, 32 * MB, 32 * MB, 32 * MB, 32 * MB, 64 * MB, 64 * MB, 128 * MB, 128 * MB, 256 * MB];

/// `zlib.compressobj(level, DEFLATED, window_bits)`.
pub struct Compressor {
    strm: Box<z_stream>,
}

impl Compressor {
    pub fn new(level: i32, window_bits: i32) -> Self {
        let mut strm = Box::new(z_stream::default());
        let rc = deflate::init(&mut strm, DeflateConfig { level, window_bits, ..DeflateConfig::default() });
        assert_eq!(rc, ReturnCode::Ok, "deflateInit2 failed");
        Compressor { strm }
    }

    /// One `.compress(data)` (`NoFlush`) or `.flush(mode)` call, appended to `out`.
    pub fn call(&mut self, input: &[u8], flush: DeflateFlush, out: &mut Vec<u8>) {
        let s = &mut *self.strm;
        s.next_in = input.as_ptr();
        s.avail_in = u32::try_from(input.len()).expect("input over 4 GiB");
        for &size in BLOCKS.iter().chain(std::iter::repeat(&BLOCKS[BLOCKS.len() - 1])) {
            out.reserve(size);
            let start = out.len();
            s.next_out = out.spare_capacity_mut().as_mut_ptr().cast();
            s.avail_out = size as u32;
            // SAFETY: the stream was initialised by deflate::init and is still live.
            let stream = unsafe { DeflateStream::from_stream_mut(s) }.expect("deflate stream");
            deflate::deflate(stream, flush);
            let written = size - s.avail_out as usize;
            // SAFETY: deflate wrote exactly `written` bytes into the spare capacity.
            unsafe { out.set_len(start + written) };
            if s.avail_out != 0 {
                break;
            }
        }
        s.next_in = std::ptr::null();
        s.next_out = std::ptr::null_mut();
    }
}

impl Drop for Compressor {
    fn drop(&mut self) {
        // SAFETY: as in `call`.
        if let Some(stream) = unsafe { DeflateStream::from_stream_mut(&mut *self.strm) } {
            let _ = deflate::end(stream);
        }
    }
}

/// `zlib.compress(data, level)`.
pub fn compress(data: &[u8], level: i32) -> Vec<u8> {
    let mut out = Vec::new();
    Compressor::new(level, 15).call(data, DeflateFlush::Finish, &mut out);
    out
}

/// What `decompressobj().decompress(data)` produced and whether the stream ended.
pub struct Inflated {
    pub data: Vec<u8>,
    pub ended: bool,
}

/// `d = zlib.decompressobj(wbits); d.decompress(data) + d.flush()`: a truncated stream
/// yields what it has, bytes after the end are ignored, a corrupt one is the `zlib.error`
/// text Python raises.
pub fn decompressobj(data: &[u8], window_bits: i32) -> Result<Inflated, String> {
    let mut strm = Box::new(z_stream::default());
    if inflate::init(&mut strm, InflateConfig { window_bits }) != ReturnCode::Ok {
        return Err("Error -2 while creating decompression object".into());
    }
    strm.next_in = data.as_ptr();
    strm.avail_in = u32::try_from(data.len()).map_err(|_| "input over 4 GiB".to_string())?;
    let mut out: Vec<u8> = Vec::with_capacity((data.len() * 4).clamp(64, 256 * MB));
    let result = loop {
        if out.capacity() - out.len() < 16 * KB {
            out.reserve(out.capacity().max(64 * KB));
        }
        let start = out.len();
        let room = out.capacity() - start;
        strm.next_out = out.spare_capacity_mut().as_mut_ptr().cast();
        strm.avail_out = room.min(u32::MAX as usize) as u32;
        // SAFETY: the stream was initialised by inflate::init and is still live.
        let rc = match unsafe { InflateStream::from_stream_mut(&mut *strm) } {
            Some(stream) => unsafe { inflate::inflate(stream, InflateFlush::SyncFlush) },
            None => ReturnCode::StreamError,
        };
        let written = room.min(u32::MAX as usize) - strm.avail_out as usize;
        // SAFETY: inflate wrote exactly `written` bytes into the spare capacity.
        unsafe { out.set_len(start + written) };
        match rc {
            ReturnCode::StreamEnd => break Ok(true),
            ReturnCode::Ok | ReturnCode::BufError => {
                if strm.avail_out != 0 {
                    break Ok(false);
                }
            }
            err => {
                let code = err as i32;
                let msg = if strm.msg.is_null() {
                    match err {
                        ReturnCode::BufError => Some("incomplete or truncated stream".to_string()),
                        ReturnCode::StreamError => Some("inconsistent stream state".to_string()),
                        ReturnCode::DataError => Some("invalid input data".to_string()),
                        _ => None,
                    }
                } else {
                    // SAFETY: zlib messages are static NUL-terminated strings.
                    Some(unsafe { CStr::from_ptr(strm.msg) }.to_string_lossy().into_owned())
                };
                break Err(match msg {
                    Some(m) => format!("Error {code} while decompressing data: {m}"),
                    None => format!("Error {code} while decompressing data"),
                });
            }
        }
    };
    // SAFETY: as above; `end` frees the state.
    if let Some(stream) = unsafe { InflateStream::from_stream_mut(&mut *strm) } {
        inflate::end(stream);
    }
    result.map(|ended| Inflated { data: out, ended })
}

pub fn crc32(data: &[u8]) -> u32 {
    zlib_rs::crc32(0, data)
}

// --- zipfile -----------------------------------------------------------------------

/// The local time a `ZipInfo` is stamped with: `(year, month, day, hour, minute, second)`.
pub type ZipTime = (i32, u32, u32, u32, u32, u32);

/// `time.localtime(SOURCE_DATE_EPOCH or time.time())[:6]`, as `ZipInfo._for_archive` does.
pub fn zip_now() -> ZipTime {
    use chrono::{Datelike, Local, TimeZone, Timelike};
    let now = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .filter(|v| !v.is_empty())
        .and_then(|v| py::int_from_str(&v))
        .and_then(|secs| Local.timestamp_opt(secs as i64, 0).single())
        .unwrap_or_else(Local::now);
    (now.year(), now.month(), now.day(), now.hour(), now.minute(), now.second())
}

/// `_sanitize_filename`.
fn sanitize_filename(name: &str) -> String {
    let name = name.split('\0').next().unwrap_or("");
    if cfg!(windows) {
        name.replace('\\', "/")
    } else {
        name.to_string()
    }
}

/// `workshop.to_zip`: `ZipFile(buf, "w", ZIP_DEFLATED)` + `writestr` per file.
pub fn to_zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    to_zip_with(files.iter().map(|(p, d)| (p.as_str(), d.as_slice())), zip_now)
}

pub fn to_zip_with<'a>(files: impl IntoIterator<Item = (&'a str, &'a [u8])>, mut clock: impl FnMut() -> ZipTime) -> Vec<u8> {
    const CREATE_SYSTEM: u8 = if cfg!(windows) { 0 } else { 3 };
    const EXTERNAL_ATTR: u32 = 0o600 << 16;
    struct Entry {
        name: Vec<u8>,
        flags: u16,
        time: u16,
        date: u16,
        crc: u32,
        csize: u32,
        size: u32,
        offset: u32,
    }
    let mut out = Vec::new();
    let mut entries = Vec::new();
    for (path, data) in files {
        let filename = sanitize_filename(path);
        let (y, mo, d, h, mi, s) = clock();
        let date = ((((y - 1980) as u32) << 9) | (mo << 5) | d) as u16;
        let time = ((h << 11) | (mi << 5) | (s / 2)) as u16;
        let flags: u16 = if filename.is_ascii() { 0 } else { 0x800 };
        let mut deflated = Vec::new();
        let mut c = Compressor::new(-1, -15);
        c.call(data, DeflateFlush::NoFlush, &mut deflated);
        c.call(&[], DeflateFlush::Finish, &mut deflated);
        let e = Entry {
            name: filename.into_bytes(),
            flags,
            time,
            date,
            crc: crc32(data),
            csize: deflated.len() as u32,
            size: data.len() as u32,
            offset: out.len() as u32,
        };
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&[20, 0]);
        for v in [e.flags, 8, e.time, e.date] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in [e.crc, e.csize, e.size] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&e.name);
        out.extend_from_slice(&deflated);
        entries.push(e);
    }
    let start_dir = out.len();
    for e in &entries {
        out.extend_from_slice(b"PK\x01\x02");
        out.extend_from_slice(&[20, CREATE_SYSTEM, 20, 0]);
        for v in [e.flags, 8, e.time, e.date] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in [e.crc, e.csize, e.size] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in [e.name.len() as u16, 0, 0, 0, 0] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&EXTERNAL_ATTR.to_le_bytes());
        out.extend_from_slice(&e.offset.to_le_bytes());
        out.extend_from_slice(&e.name);
    }
    let size_dir = out.len() - start_dir;
    out.extend_from_slice(b"PK\x05\x06");
    for v in [0u16, 0, entries.len() as u16, entries.len() as u16] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&(size_dir as u32).to_le_bytes());
    out.extend_from_slice(&(start_dir as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// One member of an archive as `ZipFile.infolist()` describes it.
#[derive(Debug, Clone)]
pub struct ZipMember {
    pub filename: String,
    orig_filename: String,
    pub file_size: u64,
    compress_size: u64,
    compress_type: u16,
    flag_bits: u16,
    crc: u32,
    external_attr: u32,
    header_offset: u64,
    end_offset: u64,
}

impl ZipMember {
    pub fn is_dir(&self) -> bool {
        self.filename.ends_with('/') || (cfg!(windows) && self.filename.ends_with('\\'))
    }
}

/// How reading an archive failed.
#[derive(Debug)]
pub enum ZipError {
    /// `BadZipFile`, `RuntimeError` or `OSError`: the reader turns these into a message.
    Caught(String),
    /// Anything else Python raises here (`zlib.error`, `EOFError`, `NotImplementedError`...).
    Uncaught(String),
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

const CP437_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";

fn cp437(b: &[u8]) -> String {
    b.iter().map(|&c| if c < 0x80 { c as char } else { CP437_HIGH.chars().nth(c as usize - 0x80).unwrap() }).collect()
}

fn decode_name(raw: &[u8], flags: u16) -> Result<String, ZipError> {
    if flags & 0x800 != 0 {
        py::utf8(raw).map(str::to_string).map_err(ZipError::Uncaught)
    } else {
        Ok(cp437(raw))
    }
}

/// `_EndRecData` + `_EndRecData64`: `(size_cd, offset_cd, location)` of the central directory.
fn end_record(data: &[u8]) -> Result<Option<(u64, u64, u64)>, ZipError> {
    let n = data.len();
    if n < 22 {
        return Ok(None);
    }
    let tail = &data[n - 22..];
    let (rec, location) = if tail.starts_with(b"PK\x05\x06") && tail[20..] == [0, 0] {
        (tail, n - 22)
    } else {
        let from = n.saturating_sub(65535 + 22);
        let window = &data[from..];
        let Some(start) = window.windows(4).rposition(|w| w == b"PK\x05\x06") else { return Ok(None) };
        if window.len() - start < 22 {
            return Ok(None);
        }
        (&window[start..start + 22], from + start)
    };
    let mut size_cd = u32_at(rec, 12) as u64;
    let mut offset_cd = u32_at(rec, 16) as u64;
    let mut location = location as u64;
    // Zip64 locator just before the end record.
    if location >= 20 {
        let loc = &data[location as usize - 20..location as usize];
        if loc.starts_with(b"PK\x06\x07") {
            let (diskno, reloff, disks) = (u32_at(loc, 4), u64_at(loc, 8), u32_at(loc, 16));
            if diskno != 0 || disks > 1 {
                return Err(ZipError::Caught("zipfiles that span multiple disks are not supported".into()));
            }
            let offset = location as i128 - 20 - 56;
            if reloff as i128 > offset {
                return Err(ZipError::Caught("Corrupt zip64 end of central directory locator".into()));
            }
            // An OSError in here is reported as "not a zip file" by `_RealGetContents`.
            let read56 = |at: u64| data.get(at as usize..at as usize + 56).ok_or_else(|| ZipError::Caught("File is not a zip file".into()));
            let mut extrasz = offset - reloff as i128;
            let mut rec64 = read56(reloff)?;
            if !rec64.starts_with(b"PK\x06\x06") && reloff as i128 != offset {
                extrasz = 0;
                rec64 = read56(offset as u64)?;
            }
            if !rec64.starts_with(b"PK\x06\x06") {
                return Err(ZipError::Caught("Zip64 end of central directory record not found".into()));
            }
            let (sz, dirsize, diroffset) = (u64_at(rec64, 4), u64_at(rec64, 40), u64_at(rec64, 48));
            if diroffset as i128 + dirsize as i128 != reloff as i128 || sz as i128 + 12 != 56 + extrasz {
                return Err(ZipError::Caught("Corrupt zip64 end of central directory record".into()));
            }
            size_cd = dirsize;
            offset_cd = diroffset;
            location = (offset - extrasz) as u64;
        }
    }
    Ok(Some((size_cd, offset_cd, location)))
}

/// `ZipFile(BytesIO(data)).infolist()`.
pub fn zip_members(data: &[u8]) -> Result<Vec<ZipMember>, ZipError> {
    let not_zip = || ZipError::Caught("File is not a zip file".into());
    let (size_cd, offset_cd, location) = end_record(data)?.ok_or_else(not_zip)?;
    let concat = location as i128 - size_cd as i128 - offset_cd as i128;
    let start_dir = offset_cd as i128 + concat;
    if start_dir < 0 {
        return Err(ZipError::Caught("Bad offset for central directory".into()));
    }
    let start = (start_dir as usize).min(data.len());
    let cd = &data[start..(start + size_cd as usize).min(data.len())];
    let mut members = Vec::new();
    let (mut total, mut pos) = (0u64, 0usize);
    while total < size_cd {
        let Some(head) = cd.get(pos..pos + 46) else {
            return Err(ZipError::Caught("Truncated central directory".into()));
        };
        if !head.starts_with(b"PK\x01\x02") {
            return Err(ZipError::Caught("Bad magic number for central directory".into()));
        }
        let flags = u16_at(head, 8);
        let (name_len, extra_len, comment_len) = (u16_at(head, 28) as usize, u16_at(head, 30) as usize, u16_at(head, 32) as usize);
        let take = |from: usize, len: usize| &cd[from.min(cd.len())..(from + len).min(cd.len())];
        let raw_name = take(pos + 46, name_len);
        let orig_filename = decode_name(raw_name, flags)?;
        let extract_version = head[6];
        if extract_version > 63 {
            return Err(ZipError::Uncaught(format!("zip file version {:.1}", extract_version as f64 / 10.0)));
        }
        let mut m = ZipMember {
            filename: sanitize_filename(&orig_filename),
            orig_filename,
            file_size: u32_at(head, 24) as u64,
            compress_size: u32_at(head, 20) as u64,
            compress_type: u16_at(head, 10),
            flag_bits: flags,
            crc: u32_at(head, 16),
            external_attr: u32_at(head, 38),
            header_offset: u32_at(head, 42) as u64,
            end_offset: 0,
        };
        decode_extra(&mut m, take(pos + 46 + name_len, extra_len), crc32(raw_name))?;
        m.header_offset = (m.header_offset as i128 + concat).max(0) as u64;
        members.push(m);
        let step = 46 + name_len + extra_len + comment_len;
        total += step as u64;
        pos += step;
    }
    let mut order: Vec<usize> = (0..members.len()).collect();
    order.sort_by_key(|&i| members[i].header_offset);
    let mut end = start_dir as u64;
    for &i in order.iter().rev() {
        members[i].end_offset = end;
        end = members[i].header_offset;
    }
    Ok(members)
}

/// `ZipInfo._decodeExtra`.
fn decode_extra(m: &mut ZipMember, mut extra: &[u8], name_crc: u32) -> Result<(), ZipError> {
    while extra.len() >= 4 {
        let (tp, ln) = (u16_at(extra, 0), u16_at(extra, 2) as usize);
        if ln + 4 > extra.len() {
            return Err(ZipError::Caught(format!("Corrupt extra field {tp:04x} (size={ln})")));
        }
        let mut body = &extra[4..ln + 4];
        if tp == 0x0001 {
            let mut next = |field: &str| -> Result<u64, ZipError> {
                let v = body.get(..8).ok_or_else(|| ZipError::Caught(format!("Corrupt zip64 extra field. {field} not found.")))?;
                body = &body[8..];
                Ok(u64::from_le_bytes(v.try_into().unwrap()))
            };
            if m.file_size == 0xFFFF_FFFF {
                m.file_size = next("File size")?;
            }
            if m.compress_size == 0xFFFF_FFFF {
                m.compress_size = next("Compress size")?;
            }
            if m.header_offset == 0xFFFF_FFFF {
                m.header_offset = next("Header offset")?;
            }
        } else if tp == 0x7075 {
            if body.len() < 5 {
                return Err(ZipError::Caught("Corrupt unicode path extra field (0x7075)".into()));
            }
            if body[0] == 1 && u32_at(body, 1) == name_crc {
                let name = py::utf8(&body[5..])
                    .map_err(|_| ZipError::Caught("Corrupt unicode path extra field (0x7075): invalid utf-8 bytes".into()))?;
                if !name.is_empty() {
                    m.filename = sanitize_filename(name);
                }
            }
        }
        extra = &extra[ln + 4..];
    }
    Ok(())
}

/// `zf.read(info)`.
pub fn zip_read(data: &[u8], m: &ZipMember) -> Result<Vec<u8>, ZipError> {
    let at = m.header_offset as usize;
    let Some(head) = data.get(at..at + 30) else {
        return Err(ZipError::Caught("Truncated file header".into()));
    };
    if !head.starts_with(b"PK\x03\x04") {
        return Err(ZipError::Caught("Bad magic number for file header".into()));
    }
    let (name_len, extra_len) = (u16_at(head, 26) as usize, u16_at(head, 28) as usize);
    let raw_name = &data[(at + 30).min(data.len())..(at + 30 + name_len).min(data.len())];
    if m.flag_bits & 0x20 != 0 {
        return Err(ZipError::Uncaught("compressed patched data (flag bit 5)".into()));
    }
    if m.flag_bits & 0x40 != 0 {
        return Err(ZipError::Uncaught("strong encryption (flag bit 6)".into()));
    }
    if decode_name(raw_name, u16_at(head, 6))? != m.orig_filename {
        return Err(ZipError::Caught(format!(
            "File name in directory {} and header {} differ.",
            py::repr_str(&m.orig_filename),
            py::repr_bytes(raw_name)
        )));
    }
    let start = at + 30 + name_len + extra_len;
    if start as u64 + m.compress_size > m.end_offset && m.end_offset != m.header_offset {
        return Err(ZipError::Caught(format!("Overlapped entries: {} (possible zip bomb)", py::repr_str(&m.orig_filename))));
    }
    if m.flag_bits & 0x1 != 0 {
        return Err(ZipError::Caught(format!("File {} is encrypted, password required for extraction", zipinfo_repr(m))));
    }
    if !matches!(m.compress_type, 0 | 8) {
        return Err(ZipError::Uncaught(match m.compress_type {
            12 | 14 | 93 => format!("compression type {} isn't available here", m.compress_type),
            _ => "That compression method is not supported".into(),
        }));
    }
    let end = start as u64 + m.compress_size;
    let truncated = end > data.len() as u64;
    let avail = &data[start.min(data.len())..(end.min(data.len() as u64)) as usize];
    let want = m.file_size as usize;
    let (mut content, ended) = if m.compress_type == 0 {
        (avail.to_vec(), !truncated)
    } else {
        let inflated = decompressobj(avail, -15).map_err(ZipError::Uncaught)?;
        let ended = inflated.ended || !truncated;
        (inflated.data, ended)
    };
    if !ended && content.len() < want {
        return Err(ZipError::Uncaught("EOFError".into()));
    }
    content.truncate(want);
    if crc32(&content) != m.crc {
        return Err(ZipError::Caught(format!("Bad CRC-32 for file {}", py::repr_str(&m.filename))));
    }
    Ok(content)
}

/// `repr(ZipInfo)`, which is what an encrypted member's error names.
fn zipinfo_repr(m: &ZipMember) -> String {
    let mut out = format!("<ZipInfo filename={}", py::repr_str(&m.filename));
    if m.compress_type != 0 {
        let name = match m.compress_type {
            1 => "shrink",
            2..=5 => "reduce",
            6 | 10 => "implode",
            7 => "tokenize",
            8 => "deflate",
            9 => "deflate64",
            12 => "bzip2",
            14 => "lzma",
            18 => "terse",
            19 => "lz77",
            93 => "zstd",
            97 => "wavpack",
            98 => "ppmd",
            _ => "",
        };
        if name.is_empty() {
            out.push_str(&format!(" compress_type={}", m.compress_type));
        } else {
            out.push_str(&format!(" compress_type={name}"));
        }
    }
    let (hi, lo) = (m.external_attr >> 16, m.external_attr & 0xFFFF);
    if hi != 0 {
        out.push_str(&format!(" filemode={}", py::repr_str(&filemode(hi))));
    }
    if lo != 0 {
        out.push_str(&format!(" external_attr={lo:#x}"));
    }
    let dir = m.is_dir();
    if !dir || m.file_size != 0 {
        out.push_str(&format!(" file_size={}", m.file_size));
    }
    if (!dir || m.compress_size != 0) && (m.compress_type != 0 || m.file_size != m.compress_size) {
        out.push_str(&format!(" compress_size={}", m.compress_size));
    }
    out.push('>');
    out
}

/// `stat.filemode`.
fn filemode(mode: u32) -> String {
    let kinds: [(u32, char); 7] = [(0o120000, 'l'), (0o140000, 's'), (0o100000, '-'), (0o060000, 'b'), (0o040000, 'd'), (0o020000, 'c'), (0o010000, 'p')];
    let mut out = String::new();
    out.push(kinds.iter().find(|(bit, _)| mode & bit == *bit).map(|k| k.1).unwrap_or('?'));
    let table: [&[(u32, char)]; 9] = [
        &[(0o400, 'r')],
        &[(0o200, 'w')],
        &[(0o100 | 0o4000, 's'), (0o4000, 'S'), (0o100, 'x')],
        &[(0o040, 'r')],
        &[(0o020, 'w')],
        &[(0o010 | 0o2000, 's'), (0o2000, 'S'), (0o010, 'x')],
        &[(0o004, 'r')],
        &[(0o002, 'w')],
        &[(0o001 | 0o1000, 't'), (0o1000, 'T'), (0o001, 'x')],
    ];
    for options in table {
        out.push(options.iter().find(|(bit, _)| mode & bit == *bit).map(|o| o.1).unwrap_or('-'));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_round_trip() {
        let files = [("a/b.txt".to_string(), b"hello hello hello".to_vec()), ("é.bin".to_string(), vec![0u8; 5000])];
        let zip = to_zip_with(files.iter().map(|(p, d)| (p.as_str(), d.as_slice())), || (2026, 10, 19, 12, 30, 41));
        let members = zip_members(&zip).unwrap();
        assert_eq!(members.len(), 2);
        assert_eq!(members[1].filename, "é.bin");
        assert_eq!(zip_read(&zip, &members[0]).unwrap(), b"hello hello hello");
        assert_eq!(zip_read(&zip, &members[1]).unwrap(), vec![0u8; 5000]);
        assert!(matches!(zip_members(b"not a zip"), Err(ZipError::Caught(m)) if m == "File is not a zip file"));
    }

    #[test]
    fn inflate_errors_read_like_python() {
        let err = decompressobj(b"\x00\x01garbage", 15).err().unwrap();
        assert_eq!(err, "Error -3 while decompressing data: incorrect header check");
        let data = compress(b"abcabcabc", 9);
        let half = decompressobj(&data[..data.len() - 6], 15).unwrap();
        assert!(!half.ended);
        assert_eq!(decompressobj(&[data.as_slice(), b"trailing"].concat(), 15).unwrap().data, b"abcabcabc");
    }

    #[test]
    fn filemode_matches_stat() {
        assert_eq!(filemode(0o100600), "-rw-------");
        assert_eq!(filemode(0o40775), "drwxrwxr-x");
    }
}
