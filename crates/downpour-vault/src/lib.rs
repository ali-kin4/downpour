//! The operating system's per-user secret protection, behind two functions.
//!
//! A download captured from a signed-in browser session carries that session:
//! its `Cookie` and `Authorization` headers. Resuming the download after a
//! restart needs them again, so they have to be written down -- and written
//! down as ordinary text in the database they would be anyone's who can read
//! the file, a backup of it, or a copy synced to the cloud.
//!
//! On Windows this is DPAPI in its current-user scope. The key is derived from
//! the user's logon credentials and held by the operating system, so nothing
//! that can decrypt a blob ever sits beside the database or in this program,
//! and a blob copied to another account or machine is useless. The blob carries
//! its own integrity check: a corrupted or altered one fails to open rather
//! than decrypting to garbage.
//!
//! This crate exists only so the engine can keep `#![forbid(unsafe_code)]`:
//! calling the system API needs `unsafe`, and it is confined to the few lines
//! below. Another platform implements the same two functions with its own
//! secure store; until one does, `protect` refuses, and the engine stores no
//! credentials at all rather than storing them in the clear.

use std::fmt;

/// Why a secret could not be protected or recovered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultError(pub String);

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for VaultError {}

/// Not a key. DPAPI mixes this into its own per-user key so that a blob made by
/// some other program for the same user does not open as one of ours, and ours
/// do not open as theirs. Knowing it decrypts nothing.
const PURPOSE: &[u8] = b"Downpour stored request credentials v1";

/// Encrypts `plain` so that only the current user, on this machine, can
/// recover it.
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, VaultError> {
    imp::protect(plain)
}

/// Recovers what [`protect`] encrypted. Fails on a blob that was altered,
/// truncated, made by another user or machine, or not made by us at all.
pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, VaultError> {
    imp::unprotect(sealed)
}

/// Whether this platform has a backend at all.
pub const SUPPORTED: bool = cfg!(windows);

#[cfg(windows)]
#[allow(unsafe_code)]
mod imp {
    use super::{VaultError, PURPOSE};
    use std::ptr;
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB, VaultError> {
        Ok(CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(data.len())
                .map_err(|_| VaultError("the data is too large to protect".into()))?,
            // The API takes a mutable pointer but only reads input blobs.
            pbData: data.as_ptr() as *mut u8,
        })
    }

    /// Copies a blob the system allocated into owned memory, then frees it.
    ///
    /// # Safety
    /// `out` must have been filled in by a successful DPAPI call.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = if out.pbData.is_null() || out.cbData == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec()
        };
        if !out.pbData.is_null() {
            LocalFree(out.pbData as _);
        }
        bytes
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, VaultError> {
        let input = blob(plain)?;
        let entropy = blob(PURPOSE)?;
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: every pointer is either null or points at a live blob that
        // outlives the call; `out` is freed by `take`.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                // Never show a prompt: this runs in the background.
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            // SAFETY: no preconditions.
            let code = unsafe { GetLastError() };
            return Err(VaultError(format!(
                "Windows could not protect the data (error {code})"
            )));
        }
        // SAFETY: the call succeeded, so `out` is a system allocation.
        Ok(unsafe { take(out) })
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, VaultError> {
        let input = blob(sealed)?;
        let entropy = blob(PURPOSE)?;
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            // SAFETY: no preconditions.
            let code = unsafe { GetLastError() };
            return Err(VaultError(format!(
                "Windows could not open the protected data (error {code})"
            )));
        }
        // SAFETY: the call succeeded, so `out` is a system allocation.
        Ok(unsafe { take(out) })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::VaultError;

    pub fn protect(_: &[u8]) -> Result<Vec<u8>, VaultError> {
        Err(VaultError(
            "no secure storage backend exists for this platform".into(),
        ))
    }

    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, VaultError> {
        Err(VaultError(
            "no secure storage backend exists for this platform".into(),
        ))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_hides_the_plaintext() {
        let secret = b"Cookie: session=hunter2-very-secret";
        let sealed = protect(secret).unwrap();
        assert!(
            !sealed.windows(7).any(|w| w == b"hunter2"),
            "the protected blob must not contain the plaintext"
        );
        assert_eq!(unprotect(&sealed).unwrap(), secret);
    }

    #[test]
    fn the_same_secret_seals_differently_each_time() {
        // DPAPI salts every blob, so equal cookies are not visibly equal.
        assert_ne!(protect(b"same").unwrap(), protect(b"same").unwrap());
    }

    #[test]
    fn a_tampered_blob_fails_rather_than_decrypting_to_garbage() {
        let mut sealed = protect(b"session=abc").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x55;
        assert!(unprotect(&sealed).is_err());
        let mid = sealed.len() / 2;
        let mut other = protect(b"session=abc").unwrap();
        other[mid] ^= 0x01;
        assert!(unprotect(&other).is_err());
    }

    #[test]
    fn rubbish_is_refused() {
        assert!(unprotect(b"not a dpapi blob at all").is_err());
        assert!(unprotect(&[]).is_err());
    }
}
