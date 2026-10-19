//! Reading `.zip` mods the way CPython's `zipfile` does: the same end-of-directory
//! search, the same name decoding and sanitizing, the same checks and messages.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{anyhow, bail, Result};

use crate::py::repr_str;

const EOCD_SIZE: usize = 22;
const EOCD_SIG: &[u8] = b"PK\x05\x06";
const EOCD64_LOCATOR_SIZE: u64 = 20;
const EOCD64_SIZE: u64 = 56;
const CD_SIZE: usize = 46;
const LOCAL_SIZE: usize = 30;
const MAX_COMMENT: u64 = 65535;

/// A `BadZipFile`.
#[derive(Debug)]
pub struct BadZipFile(pub String);

impl std::fmt::Display for BadZipFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BadZipFile {}

fn bad<T>(msg: impl Into<String>) -> Result<T> {
    Err(BadZipFile(msg.into()).into())
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

struct EndRecord {
    disk_number: u64,
    disk_start: u64,
    entries_total: u64,
    size: u64,
    offset: u64,
    location: u64,
    zip64: bool,
}

fn read_at<R: Read + Seek>(f: &mut R, at: u64, n: usize) -> std::io::Result<Vec<u8>> {
    f.seek(SeekFrom::Start(at))?;
    let mut buf = Vec::with_capacity(n);
    f.take(n as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

/// `_EndRecData`, `_EndRecData64` included. `Ok(None)` where Python returned `None`.
fn end_record<R: Read + Seek>(f: &mut R) -> Result<Option<EndRecord>> {
    let filesize = f.seek(SeekFrom::End(0))?;
    if filesize < EOCD_SIZE as u64 {
        return Ok(None);
    }
    let data = read_at(f, filesize - EOCD_SIZE as u64, EOCD_SIZE)?;
    let (rec, location) = if data.len() == EOCD_SIZE && &data[..4] == EOCD_SIG && data[20..] == [0, 0] {
        (data, filesize - EOCD_SIZE as u64)
    } else {
        let start = filesize.saturating_sub(MAX_COMMENT + EOCD_SIZE as u64);
        let data = read_at(f, start, (MAX_COMMENT as usize) + EOCD_SIZE)?;
        let Some(pos) = data.windows(4).rposition(|w| w == EOCD_SIG) else { return Ok(None) };
        let rec = data[pos..].iter().take(EOCD_SIZE).copied().collect::<Vec<_>>();
        if rec.len() != EOCD_SIZE {
            return Ok(None);
        }
        (rec, start + pos as u64)
    };
    let mut end = EndRecord {
        disk_number: u16_at(&rec, 4) as u64,
        disk_start: u16_at(&rec, 6) as u64,
        entries_total: u16_at(&rec, 10) as u64,
        size: u32_at(&rec, 12) as u64,
        offset: u32_at(&rec, 16) as u64,
        location,
        zip64: false,
    };
    if location < EOCD64_LOCATOR_SIZE {
        return Ok(Some(end));
    }
    let locator_at = location - EOCD64_LOCATOR_SIZE;
    let loc = read_at(f, locator_at, EOCD64_LOCATOR_SIZE as usize)?;
    if loc.len() != EOCD64_LOCATOR_SIZE as usize {
        bail!("Unknown I/O error");
    }
    if &loc[..4] != b"PK\x06\x07" {
        return Ok(Some(end));
    }
    let (diskno, reloff, disks) = (u32_at(&loc, 4), u64_at(&loc, 8), u32_at(&loc, 16));
    if diskno != 0 || disks > 1 {
        return bad("zipfiles that span multiple disks are not supported");
    }
    let Some(offset) = locator_at.checked_sub(EOCD64_SIZE) else { return bad("Corrupt zip64 end of central directory locator") };
    if reloff > offset {
        return bad("Corrupt zip64 end of central directory locator");
    }
    let mut extrasz = offset - reloff;
    let mut data = read_at(f, reloff, EOCD64_SIZE as usize)?;
    if data.len() != EOCD64_SIZE as usize {
        bail!("Unknown I/O error");
    }
    if !data.starts_with(b"PK\x06\x06") && reloff != offset {
        extrasz = 0;
        data = read_at(f, offset, EOCD64_SIZE as usize)?;
        if data.len() != EOCD64_SIZE as usize {
            bail!("Unknown I/O error");
        }
    }
    if !data.starts_with(b"PK\x06\x06") {
        return bad("Zip64 end of central directory record not found");
    }
    let sz = u64_at(&data, 4);
    let (dirsize, diroffset) = (u64_at(&data, 40), u64_at(&data, 48));
    if diroffset + dirsize != reloff || sz + 12 != EOCD64_SIZE + extrasz {
        return bad("Corrupt zip64 end of central directory record");
    }
    end.disk_number = u32_at(&data, 16) as u64;
    end.disk_start = u32_at(&data, 20) as u64;
    end.entries_total = u64_at(&data, 32);
    end.size = dirsize;
    end.offset = diroffset;
    end.location = offset - extrasz;
    end.zip64 = true;
    Ok(Some(end))
}

/// `zipfile.is_zipfile(path)`.
pub fn is_zipfile(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut check = || -> Result<bool> {
        let Some(end) = end_record(&mut f)? else { return Ok(false) };
        if end.entries_total == 0 && end.size == 0 && end.offset == 0 {
            return Ok(true);
        }
        if end.disk_number == end.disk_start {
            let concat = end.location as i128 - end.size as i128 - end.offset as i128;
            let at = (end.offset as i128 + concat).max(0) as u64;
            if end.size >= CD_SIZE as u64 {
                let data = read_at(&mut f, at, CD_SIZE)?;
                if data.len() == CD_SIZE && &data[..4] == b"PK\x01\x02" {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    };
    check().unwrap_or(false)
}

const CP437_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";

fn cp437(bytes: &[u8]) -> String {
    let high: Vec<char> = CP437_HIGH.chars().collect();
    bytes.iter().map(|&b| if b < 0x80 { b as char } else { high[(b - 0x80) as usize] }).collect()
}

fn decode_name(raw: &[u8], utf8: bool) -> Result<String> {
    if utf8 {
        Ok(crate::py::utf8(raw)?.to_string())
    } else {
        Ok(cp437(raw))
    }
}

/// `_sanitize_filename`.
fn sanitize(name: &str) -> String {
    let name = name.split('\0').next().unwrap_or("");
    if cfg!(windows) {
        name.replace('\\', "/")
    } else {
        name.to_string()
    }
}

#[derive(Debug, Clone)]
struct Entry {
    filename: String,
    orig_filename: String,
    flag_bits: u16,
    compress_type: u16,
    crc: u32,
    compress_size: u64,
    file_size: u64,
    header_offset: u64,
    end_offset: u64,
}

fn decode_extra(e: &mut Entry, extra: &[u8], name_crc: u32) -> Result<()> {
    let mut extra = extra;
    while extra.len() >= 4 {
        let (tp, ln) = (u16_at(extra, 0), u16_at(extra, 2) as usize);
        if ln + 4 > extra.len() {
            return bad(format!("Corrupt extra field {:04x} (size={})", tp, ln));
        }
        let data = &extra[4..ln + 4];
        if tp == 0x0001 {
            let mut d = data;
            let mut take = |field: &str| -> Result<u64> {
                if d.len() < 8 {
                    return bad(format!("Corrupt zip64 extra field. {} not found.", field));
                }
                let v = u64_at(d, 0);
                d = &d[8..];
                Ok(v)
            };
            if e.file_size == 0xffff_ffff_ffff_ffff || e.file_size == 0xffff_ffff {
                e.file_size = take("File size")?;
            }
            if e.compress_size == 0xffff_ffff {
                e.compress_size = take("Compress size")?;
            }
            if e.header_offset == 0xffff_ffff {
                e.header_offset = take("Header offset")?;
            }
        } else if tp == 0x7075 {
            if data.len() < 5 {
                return bad("Corrupt unicode path extra field (0x7075)");
            }
            if data[0] == 1 && u32_at(data, 1) == name_crc {
                let name = std::str::from_utf8(&data[5..]).map_err(|_| BadZipFile("Corrupt unicode path extra field (0x7075): invalid utf-8 bytes".into()))?;
                if !name.is_empty() {
                    e.filename = sanitize(name);
                }
            }
        }
        extra = &extra[ln + 4..];
    }
    Ok(())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(data);
    crc.sum()
}

/// An open archive over an in-memory buffer (`zipfile.ZipFile(BytesIO(data))`).
pub struct ZipArchive<'a> {
    data: &'a [u8],
    entries: Vec<Entry>,
}

impl<'a> ZipArchive<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self> {
        let mut cur = std::io::Cursor::new(data);
        let end = match end_record(&mut cur) {
            Ok(Some(end)) => end,
            Ok(None) => return bad("File is not a zip file"),
            Err(e) if e.is::<BadZipFile>() => return Err(e),
            Err(_) => return bad("File is not a zip file"),
        };
        let mut concat = end.location as i128 - end.size as i128 - end.offset as i128;
        if end.zip64 {
            concat -= (EOCD64_SIZE + EOCD64_LOCATOR_SIZE) as i128;
        }
        let start_dir = end.offset as i128 + concat;
        if start_dir < 0 {
            return bad("Bad offset for central directory");
        }
        let start_dir = start_dir as usize;
        let cd = &data[start_dir.min(data.len())..(start_dir as u64 + end.size).min(data.len() as u64) as usize];
        let mut entries = Vec::new();
        let (mut total, mut pos) = (0u64, 0usize);
        while total < end.size {
            if pos + CD_SIZE > cd.len() {
                return bad("Truncated central directory");
            }
            let c = &cd[pos..pos + CD_SIZE];
            if &c[..4] != b"PK\x01\x02" {
                return bad("Bad magic number for central directory");
            }
            let (name_len, extra_len, comment_len) = (u16_at(c, 28) as usize, u16_at(c, 30) as usize, u16_at(c, 32) as usize);
            let field = |from: usize, len: usize| &cd[from.min(cd.len())..(from + len).min(cd.len())];
            let raw_name = field(pos + CD_SIZE, name_len);
            let extra = field(pos + CD_SIZE + name_len, extra_len);
            let flag_bits = u16_at(c, 8);
            let orig = decode_name(raw_name, flag_bits & 0x800 != 0)?;
            let extract_version = c[6];
            if extract_version > 63 {
                return Err(anyhow!("zip file version {:.1}", extract_version as f64 / 10.0));
            }
            let mut e = Entry {
                filename: sanitize(&orig),
                orig_filename: sanitize(&orig),
                flag_bits,
                compress_type: u16_at(c, 10),
                crc: u32_at(c, 16),
                compress_size: u32_at(c, 20) as u64,
                file_size: u32_at(c, 24) as u64,
                header_offset: u32_at(c, 42) as u64,
                end_offset: 0,
            };
            decode_extra(&mut e, extra, crc32(raw_name))?;
            e.header_offset = (e.header_offset as i128 + concat).max(0) as u64;
            entries.push(e);
            let len = CD_SIZE + name_len + extra_len + comment_len;
            total += len as u64;
            pos += len;
        }
        let mut order: Vec<usize> = (0..entries.len()).collect();
        order.sort_by_key(|&i| entries[i].header_offset);
        let mut end_offset = start_dir as u64;
        for &i in order.iter().rev() {
            entries[i].end_offset = end_offset;
            end_offset = entries[i].header_offset;
        }
        Ok(ZipArchive { data, entries })
    }

    /// `namelist()`.
    pub fn names(&self) -> Vec<String> {
        self.entries.iter().map(|e| e.filename.clone()).collect()
    }

    /// `read(name)`: the last entry with that name, like `NameToInfo`.
    pub fn read(&self, name: &str) -> Result<Vec<u8>> {
        let Some(e) = self.entries.iter().rev().find(|e| e.filename == name) else {
            bail!("There is no item named {} in the archive", repr_str(name));
        };
        let at = e.header_offset as usize;
        if at + LOCAL_SIZE > self.data.len() {
            return bad("Truncated file header");
        }
        let h = &self.data[at..at + LOCAL_SIZE];
        if &h[..4] != b"PK\x03\x04" {
            return bad("Bad magic number for file header");
        }
        let (name_len, extra_len) = (u16_at(h, 26) as usize, u16_at(h, 28) as usize);
        let name_end = (at + LOCAL_SIZE + name_len).min(self.data.len());
        let fname = &self.data[at + LOCAL_SIZE..name_end];
        if e.flag_bits & 0x20 != 0 {
            bail!("compressed patched data (flag bit 5)");
        }
        if e.flag_bits & 0x40 != 0 {
            bail!("strong encryption (flag bit 6)");
        }
        let fname_str = decode_name(fname, u16_at(h, 6) & 0x800 != 0)?;
        if fname_str != e.orig_filename {
            return bad(format!("File name in directory {} and header {} differ.", repr_str(&e.orig_filename), bytes_repr(fname)));
        }
        let data_start = name_end + extra_len;
        if data_start as u64 + e.compress_size > e.end_offset && e.end_offset != e.header_offset {
            return bad(format!("Overlapped entries: {} (possible zip bomb)", repr_str(&e.orig_filename)));
        }
        if e.flag_bits & 0x1 != 0 {
            bail!("File {} is encrypted, password required for extraction", repr_str(name));
        }
        let start = data_start.min(self.data.len());
        let end = (data_start as u64 + e.compress_size).min(self.data.len() as u64) as usize;
        let raw = &self.data[start..end];
        let mut out = match e.compress_type {
            0 => raw.to_vec(),
            8 => {
                let mut out = Vec::with_capacity(e.file_size as usize);
                flate2::read::DeflateDecoder::new(raw).read_to_end(&mut out).map_err(|err| anyhow!("Error -3 while decompressing data: {}", err))?;
                out
            }
            _ => bail!("That compression method is not supported"),
        };
        out.truncate(e.file_size as usize);
        if crc32(&out) != e.crc {
            return bad(format!("Bad CRC-32 for file {}", repr_str(name)));
        }
        Ok(out)
    }
}

fn bytes_repr(b: &[u8]) -> String {
    let mut s = String::from("b'");
    for &c in b {
        match c {
            b'\\' => s.push_str("\\\\"),
            b'\'' => s.push_str("\\'"),
            0x20..=0x7e => s.push(c as char),
            b'\n' => s.push_str("\\n"),
            b'\r' => s.push_str("\\r"),
            b'\t' => s.push_str("\\t"),
            _ => s.push_str(&format!("\\x{:02x}", c)),
        }
    }
    s.push('\'');
    s
}

/// `ZipFile(buf, "w", ZIP_DEFLATED)` + `writestr` per file. The deflate stream comes from
/// miniz rather than zlib-ng, so it is valid but not byte-identical to CPython's.
pub fn write_zip(files: &[(&str, &[u8])]) -> Result<Vec<u8>> {
    use std::io::Write;
    let mut out = std::io::Cursor::new(Vec::new());
    {
        use chrono::{Datelike, Timelike};
        let mut zip = zip::ZipWriter::new(&mut out);
        let now = chrono::Local::now();
        let time = zip::DateTime::from_date_and_time(now.year() as u16, now.month() as u8, now.day() as u8, now.hour() as u8, now.minute() as u8, now.second() as u8)
            .unwrap_or_default();
        for (name, data) in files {
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).last_modified_time(time);
            zip.start_file(*name, options)?;
            zip.write_all(data)?;
        }
        zip.finish()?;
    }
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_it_writes() {
        let bytes = write_zip(&[("ui/a.swf", b"abc"), ("b.txt", b"")]).unwrap();
        let z = ZipArchive::new(&bytes).unwrap();
        assert_eq!(z.names(), vec!["ui/a.swf", "b.txt"]);
        assert_eq!(z.read("ui/a.swf").unwrap(), b"abc");
        assert_eq!(ZipArchive::new(b"notzip").err().unwrap().to_string(), "File is not a zip file");
    }

    #[test]
    fn cp437_table_is_complete() {
        assert_eq!(CP437_HIGH.chars().count(), 128);
        assert_eq!(cp437(b"\x80\xe1\xff"), "Çß\u{a0}");
    }
}
