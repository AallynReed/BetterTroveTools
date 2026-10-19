//! The `.tmod` container (also used by `.tpack`).
//!
//! ```text
//! u64 header_size | u16 version | u16 property_count
//! property_count x (uleb len, utf-8 name, uleb len, utf-8 value)
//! until header_size: u8 path_len, utf-8 path, uleb index, uleb offset, uleb size, uleb checksum
//! zlib stream of every file, each padded to 4 bytes, in stored (level 0) 32 KiB blocks,
//! ended with a sync flush instead of a final block
//! ```

use std::io::Write;

use anyhow::Result;
use flate2::{Decompress, FlushDecompress, Status};

use crate::py;
use crate::game::hash::write_uleb;

pub const READ_PAST_END: &str = "BinaryReader Error: cannot read farther than buffer length.";
pub const SEEK_PAST_END: &str = "BinaryReader Error: cannot seek farther than buffer length.";

/// An error the Python reader raised as a plain `Exception` (not an `OSError`).
#[derive(Debug)]
pub struct FormatError(pub String);

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FormatError {}

fn fail<T>(msg: &str) -> Result<T> {
    Err(FormatError(msg.to_string()).into())
}

/// `binary_reader.BinaryReader` over a byte slice.
pub struct Reader<'a> {
    pub buf: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    pub fn read_bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.pos + n > self.buf.len() {
            return fail(READ_PAST_END);
        }
        let out = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    pub fn seek(&mut self, pos: usize) -> Result<()> {
        if pos > self.buf.len() {
            return fail(SEEK_PAST_END);
        }
        self.pos = pos;
        Ok(())
    }

    pub fn read_u8(&mut self) -> Result<u8> {
        Ok(self.read_bytes(1)?[0])
    }

    pub fn read_u16(&mut self) -> Result<u16> {
        let b = self.read_bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn read_u64(&mut self) -> Result<u64> {
        let b = self.read_bytes(8)?;
        Ok(u64::from_le_bytes(b.try_into().unwrap()))
    }

    /// `utils.functions.read_leb128`: 32-bit result, at most 64 bits of input.
    pub fn read_leb(&mut self) -> Result<u32> {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let byte = self.read_u8()?;
            if shift < 64 {
                result |= ((byte & 0x7f) as u64) << shift;
            }
            if byte & 0x80 == 0 {
                return Ok((result & 0xffff_ffff) as u32);
            }
            shift += 7;
            if shift >= 64 {
                return fail("Too many bytes when decoding varint.");
            }
        }
    }

    /// The local `_local_read_leb128` of the modder tools: no length cap.
    pub fn read_leb_unbounded(&mut self) -> Result<u32> {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let byte = self.read_u8()?;
            if shift < 64 {
                result |= ((byte & 0x7f) as u64) << shift;
            }
            if byte & 0x80 == 0 {
                return Ok((result & 0xffff_ffff) as u32);
            }
            shift += 7;
        }
    }

    /// `read_str(n)`: n bytes, cut at the first NUL, strict UTF-8.
    pub fn read_str(&mut self, n: usize) -> Result<String> {
        let raw = self.read_bytes(n)?;
        let raw = raw.split(|&b| b == 0).next().unwrap_or(raw);
        py::utf8(raw).map(str::to_string).map_err(|e| FormatError(e.to_string()).into())
    }

    /// `_read_header_str`: `length` bytes, or `length` characters for headers written
    /// by builds that counted characters.
    fn read_header_str(&mut self, length: usize, char_lengths: bool) -> Result<String> {
        if !char_lengths {
            return self.read_str(length);
        }
        let mut end = self.pos;
        for _ in 0..length {
            let Some(&lead) = self.buf.get(end) else { return fail("bytearray index out of range") };
            end += match lead {
                0..=0x7f => 1,
                0x80..=0xdf => 2,
                0xe0..=0xef => 3,
                _ => 4,
            };
        }
        if end > self.buf.len() {
            return fail("header string runs past the end of the file");
        }
        self.read_str(end - self.pos)
    }
}

/// One file entry of a header, with its path exactly as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderEntry {
    pub path: String,
    pub index: u32,
    pub offset: u32,
    pub size: u32,
    pub checksum: u32,
}

/// The first `header_size` bytes, as `TroveModList` reads a header-only `.tmod`.
pub fn header_slice(raw: &[u8]) -> &[u8] {
    let mut size = [0u8; 8];
    let n = raw.len().min(8);
    size[..n].copy_from_slice(&raw[..n]);
    let size = u64::from_le_bytes(size).min(raw.len() as u64) as usize;
    &raw[..size]
}

/// Reads a header incrementally: the fixed part and properties up front, then one file
/// entry at a time (`TMod.read_bytes` reads each file's bytes before the next entry).
pub struct HeaderReader<'a> {
    r: Reader<'a>,
    char_lengths: bool,
    pub header_size: u64,
    pub version: u16,
    pub properties: Vec<(String, String)>,
}

impl<'a> HeaderReader<'a> {
    pub fn new(raw: &'a [u8]) -> Result<Self> {
        Self::with_lengths(raw, header_uses_char_lengths(raw))
    }

    fn with_lengths(raw: &'a [u8], char_lengths: bool) -> Result<Self> {
        let mut r = Reader::new(raw);
        let header_size = r.read_u64()?;
        let version = r.read_u16()?;
        let count = r.read_u16()?;
        let mut properties = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let n = r.read_leb()? as usize;
            let name = r.read_header_str(n, char_lengths)?;
            let n = r.read_leb()? as usize;
            let value = r.read_header_str(n, char_lengths)?;
            properties.push((name, value));
        }
        Ok(HeaderReader { r, char_lengths, header_size, version, properties })
    }

    /// The next file entry, or `None` once the header is consumed.
    pub fn next_entry(&mut self) -> Option<Result<HeaderEntry>> {
        if self.r.pos as u64 >= self.header_size {
            return None;
        }
        Some(self.read_entry())
    }

    fn read_entry(&mut self) -> Result<HeaderEntry> {
        let n = self.r.read_u8()? as usize;
        let path = self.r.read_header_str(n, self.char_lengths)?;
        let index = self.r.read_leb()?;
        let offset = self.r.read_leb()?;
        let size = self.r.read_leb()?;
        let checksum = self.r.read_leb()?;
        Ok(HeaderEntry { path, index, offset, size, checksum })
    }
}

fn walks(raw: &[u8], char_lengths: bool) -> bool {
    let Ok(mut h) = HeaderReader::with_lengths(raw, char_lengths) else { return false };
    while let Some(entry) = h.next_entry() {
        if entry.is_err() {
            return false;
        }
    }
    h.r.pos as u64 == h.header_size
}

/// `_header_uses_char_lengths`: only when the byte reading fails to land on
/// `header_size` and the character reading does.
pub fn header_uses_char_lengths(raw: &[u8]) -> bool {
    !walks(raw, false) && walks(raw, true)
}

/// modpacks' `_tpack_file_names`: the stored names, read with byte lengths only.
pub fn raw_file_names(raw: &[u8]) -> Result<Vec<String>> {
    let mut r = Reader::new(raw);
    let header_size = r.read_u64()?;
    r.read_u16()?;
    let count = r.read_u16()?;
    for _ in 0..count {
        let n = r.read_leb()? as usize;
        r.read_str(n)?;
        let n = r.read_leb()? as usize;
        r.read_str(n)?;
    }
    let mut names = Vec::new();
    while (r.pos as u64) < header_size {
        let n = r.read_u8()? as usize;
        names.push(r.read_str(n)?);
        for _ in 0..4 {
            r.read_leb()?;
        }
    }
    Ok(names)
}

/// `TMod.manual_decompression`: strip the zlib header, the 5-byte block headers and the
/// trailing sync marker by position.
pub fn manual_decompression(data: &[u8]) -> Vec<u8> {
    let inner = if data.len() > 12 { &data[7..data.len() - 5] } else { &[][..] };
    let chunks = inner.len() / (32768 + 5);
    let mut out = Vec::with_capacity(inner.len());
    let mut pos = 0;
    for _ in 0..chunks {
        out.extend_from_slice(&inner[pos..pos + 32768]);
        pos += 32768 + 5;
    }
    out.extend_from_slice(&inner[pos..]);
    out
}

/// `TMod.manual_compression`.
pub fn manual_compression(data: &[u8]) -> Vec<u8> {
    let mut out = b"\x78\x01\x00\x00\x80\xff\x7f".to_vec();
    for chunk in data.chunks(32768) {
        out.extend_from_slice(chunk);
        if chunk.len() == 32768 {
            out.extend_from_slice(b"\x00\x00\x80\xff\x7f");
        }
    }
    out.extend_from_slice(b"\x00\x00\x00\xff\xff");
    out
}

/// `zlib.decompressobj().decompress(data)`: everything up to the end of the stream or
/// the input, whichever comes first. Errors on a corrupt stream.
pub fn inflate(data: &[u8]) -> Result<Vec<u8>, flate2::DecompressError> {
    let mut d = Decompress::new(true);
    let mut out = Vec::with_capacity(data.len().max(64));
    loop {
        if out.capacity() - out.len() < 64 * 1024 {
            out.reserve(out.capacity().max(64 * 1024));
        }
        let before_in = d.total_in();
        let before_out = d.total_out();
        let consumed = d.total_in() as usize;
        let status = d.decompress_vec(&data[consumed..], &mut out, FlushDecompress::None)?;
        if status == Status::StreamEnd {
            break;
        }
        if d.total_in() == before_in && d.total_out() == before_out {
            break;
        }
    }
    Ok(out)
}

/// The file stream of a `.tmod`, falling back to `manual_decompression` when zlib
/// rejects it.
pub fn decompress_body(stream: &[u8]) -> Vec<u8> {
    inflate(stream).unwrap_or_else(|_| manual_decompression(stream))
}

/// What `compressobj(level=0)` + 32 KiB `compress()` calls + `flush(Z_SYNC_FLUSH)`
/// produce with the zlib-ng build CPython ships: one stored block per 32 KiB chunk,
/// then an empty stored block.
pub fn compress_stored(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + body.len() / 32768 * 5 + 16);
    out.extend_from_slice(&[0x78, 0x01]);
    for chunk in body.chunks(32768) {
        let len = chunk.len() as u16;
        out.push(0);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(&[0, 0, 0, 0xff, 0xff]);
    out
}

/// One file of a container being written: its stored path and bytes. `offset` is where
/// its padded data starts in the body.
pub struct OutFile<'a> {
    pub path: &'a str,
    pub index: u64,
    pub offset: u64,
    pub data: &'a [u8],
    pub checksum: u32,
}

/// `TroveModFile.header_format`.
pub fn entry_header(f: &OutFile) -> Result<Vec<u8>> {
    let path = f.path.as_bytes();
    if path.len() > 255 {
        anyhow::bail!("Mod internal path is too long for the .tmod format (>255 bytes): {}", f.path);
    }
    let mut out = Vec::with_capacity(path.len() + 16);
    out.push(path.len() as u8);
    out.extend_from_slice(path);
    out.extend(write_uleb(f.index));
    out.extend(write_uleb(if f.data.is_empty() { 0 } else { f.offset }));
    out.extend(write_uleb(f.data.len() as u64));
    out.extend(write_uleb(f.checksum as u64));
    Ok(out)
}

/// `len(data)` rounded up to 4.
pub fn padded_len(len: usize) -> usize {
    len.div_ceil(4) * 4
}

/// The body of `compile_tmod`: header, then the stored zlib stream.
pub fn write_container(version: u16, properties: &[(&str, &str)], files: &[OutFile]) -> Result<Vec<u8>> {
    if properties.len() > u16::MAX as usize {
        anyhow::bail!("'H' format requires 0 <= number <= 65535");
    }
    let mut header = Vec::new();
    header.extend_from_slice(&[0u8; 8]);
    header.extend_from_slice(&version.to_le_bytes());
    header.extend_from_slice(&(properties.len() as u16).to_le_bytes());
    for (name, value) in properties {
        header.extend(write_uleb(name.len() as u64));
        header.extend_from_slice(name.as_bytes());
        header.extend(write_uleb(value.len() as u64));
        header.extend_from_slice(value.as_bytes());
    }
    let mut body = Vec::with_capacity(files.iter().map(|f| padded_len(f.data.len())).sum());
    for f in files {
        body.extend_from_slice(f.data);
        body.resize(body.len() + padded_len(f.data.len()) - f.data.len(), 0);
    }
    for f in files {
        header.extend(entry_header(f)?);
    }
    let size = header.len() as u64;
    header[..8].copy_from_slice(&size.to_le_bytes());
    let mut out = header;
    out.write_all(&compress_stored(&body))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_stream_round_trips() {
        for n in [0usize, 1, 4, 32767, 32768, 32769, 65536, 100_000] {
            let body: Vec<u8> = (0..n).map(|i| (i * 7 % 251) as u8).collect();
            let z = compress_stored(&body);
            assert_eq!(inflate(&z).unwrap(), body, "inflate {n}");
            assert_eq!(z.len(), 2 + body.len() + 5 * body.len().div_ceil(32768) + 5);
        }
    }

    #[test]
    fn manual_decompression_reads_stored_blocks() {
        let body: Vec<u8> = (0..70_000).map(|i| i as u8).collect();
        assert_eq!(manual_decompression(&compress_stored(&body)), body);
    }

    #[test]
    fn reader_errors_match_binary_reader() {
        let mut r = Reader::new(b"\x80");
        assert_eq!(r.read_leb().unwrap_err().to_string(), READ_PAST_END);
        let mut r = Reader::new(b"ab");
        assert_eq!(r.seek(3).unwrap_err().to_string(), SEEK_PAST_END);
    }
}
