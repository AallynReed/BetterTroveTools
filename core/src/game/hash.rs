//! utils/functions.py: Trove's checksum and LEB128 varints.

const FNV_OFFSET: u32 = 2166136261;
const FNV_PRIME: u32 = 16777619;

/// A signed C `char` widened to uint32.
fn sign_extend(b: u8) -> u32 {
    b as i8 as i32 as u32
}

/// Trove's FNV-1a variant: full words little-endian, the 1-3 byte tail big-endian and
/// sign-extended.
pub fn calculate_hash(data: &[u8]) -> u32 {
    let mut h = FNV_OFFSET;
    let full = data.len() & !3;
    for chunk in data[..full].chunks_exact(4) {
        let word = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        h = FNV_PRIME.wrapping_mul(h ^ word);
    }
    let tail = &data[full..];
    let val = match tail.len() {
        1 => sign_extend(tail[0]),
        2 => (sign_extend(tail[0]) << 8) | sign_extend(tail[1]),
        3 => {
            let v1 = sign_extend(tail[0]) << 8;
            let v1 = (sign_extend(tail[1]) | v1) << 8;
            v1 | sign_extend(tail[2])
        }
        _ => return h,
    };
    FNV_PRIME.wrapping_mul(h ^ val)
}

/// Reads a uleb128 at `pos`, masked to 32 bits. Returns `(value, next_pos)`.
pub fn read_uleb(data: &[u8], mut pos: usize) -> anyhow::Result<(u32, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let byte = *data.get(pos).ok_or_else(|| anyhow::anyhow!("unexpected end of data in varint"))?;
        pos += 1;
        if shift < 64 {
            result |= ((byte & 0x7F) as u64) << shift;
        }
        if byte & 0x80 == 0 {
            return Ok(((result & 0xFFFF_FFFF) as u32, pos));
        }
        shift += 7;
        if shift >= 64 {
            anyhow::bail!("Too many bytes when decoding varint.");
        }
    }
}

pub fn write_uleb(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while value >= 0x80 {
        out.push(((value & 0x7F) | 0x80) as u8);
        value >>= 7;
    }
    out.push((value & 0x7F) as u8);
    out
}

/// `random_id(k)`: k distinct characters from ascii letters + digits.
pub fn random_id(k: usize) -> String {
    use rand::seq::SliceRandom;
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    ALPHABET.choose_multiple(&mut rng, k.min(ALPHABET.len())).map(|&b| b as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_known_values() {
        // Values from utils.functions.calculate_hash.
        assert_eq!(calculate_hash(b""), 2166136261);
        assert_eq!(calculate_hash(b"abcd"), 3967774508);
        assert_eq!(calculate_hash(b"abcde\xff"), 2254699561);
        assert_eq!(calculate_hash(b"prefabs/items/test.binfab"), 4101874600);
        assert_eq!(calculate_hash(&[0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff]), 2948466838);
    }

    #[test]
    fn leb_roundtrip() {
        for v in [0u64, 1, 127, 128, 300, 0xFFFF_FFFF] {
            let enc = write_uleb(v);
            assert_eq!(read_uleb(&enc, 0).unwrap(), (v as u32, enc.len()));
        }
    }
}
