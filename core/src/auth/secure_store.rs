//! utils/secure_store.py: the signed-in account's tokens, encrypted with DPAPI under the
//! current user in `ModManagerCache/account.bin`. Elsewhere nothing is persisted.

use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::paths::get_cache_root;

const STORE_NAME: &str = "account.bin";
#[cfg_attr(not(windows), allow(dead_code))]
const ENTROPY: &[u8] = b"BetterTroveTools.site_auth.v1";
#[cfg_attr(not(windows), allow(dead_code))]
const DESCRIPTION: &str = "BTT site account";

fn store_path() -> PathBuf {
    get_cache_root().join(STORE_NAME)
}

pub fn is_available() -> bool {
    cfg!(windows)
}

/// Encrypts and writes the tokens. `Ok(false)` without DPAPI (nothing is written).
pub fn save_tokens(tokens: &Map<String, Value>) -> anyhow::Result<bool> {
    #[cfg(windows)]
    {
        let raw = crate::json::dumps(&Value::Object(tokens.clone()));
        let blob = dpapi::protect(raw.as_bytes())?;
        let path = store_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, blob)?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = tokens;
        Ok(false)
    }
}

/// The stored tokens, or `None`. An unreadable file (tampered, another user or machine)
/// is deleted so it isn't retried.
pub fn load_tokens() -> Option<Map<String, Value>> {
    if !is_available() {
        return None;
    }
    let path = store_path();
    if !path.exists() {
        return None;
    }
    let parsed = std::fs::read(&path).ok().and_then(|blob| unprotect(&blob)).and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
    match parsed {
        Some(Value::Object(map)) => Some(map),
        Some(_) => None,
        None => {
            clear_tokens();
            None
        }
    }
}

pub fn clear_tokens() {
    let _ = std::fs::remove_file(store_path());
}

#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    dpapi::unprotect(blob)
}

#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
pub(super) mod dpapi {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    use super::{DESCRIPTION, ENTROPY};

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    /// Copies out a buffer DPAPI allocated, then frees it.
    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() {
            return Vec::new();
        }
        let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as _) };
        bytes
    }

    /// `win32crypt.CryptProtectData(data, DESCRIPTION, ENTROPY, None, None, 0)`.
    pub fn protect(data: &[u8]) -> std::io::Result<Vec<u8>> {
        let description: Vec<u16> = DESCRIPTION.encode_utf16().chain(std::iter::once(0)).collect();
        let (input, entropy) = (blob(data), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        let ok = unsafe { CryptProtectData(&input, description.as_ptr(), &entropy, null(), null(), 0, &mut out) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(take(out))
    }

    /// `win32crypt.CryptUnprotectData(blob, ENTROPY, None, None, 0)[1]`.
    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let (input, entropy) = (blob(data), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        let ok = unsafe { CryptUnprotectData(&input, null_mut(), &entropy, null(), null(), 0, &mut out) };
        if ok == 0 {
            return None;
        }
        Some(take(out))
    }
}
