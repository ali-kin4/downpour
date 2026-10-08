//! The request credentials a download carries, and how they are kept.
//!
//! A download captured from the browser arrives with the browser's session:
//! `Cookie`, `Authorization`, sometimes a bespoke token header. Those are the
//! difference between the file and a login page, and a resume after a restart
//! needs them again -- but they are also the user's signed-in session, good for
//! far more than one file. So three rules hold everywhere in the engine:
//!
//! - **They are never stored in the clear.** The database keeps them only
//!   sealed by the operating system's per-user protection (see [`Vault`]);
//!   where there is none, they are not kept at all.
//! - **They are kept only while they can still be used.** A finished,
//!   cancelled or removed download cannot be resumed, so its credentials go.
//!   What remains in the list and the history is what the file was, not the
//!   session that fetched it.
//! - **They do not travel further than the transfer.** [`RequestHeaders`]
//!   leaves them out when serialised -- which is how every download reaches
//!   the window -- and masks them in `Debug`, which is how one reaches a log.
//!
//! Which headers count is decided by [`is_sensitive`], deliberately broad: a
//! harmless header mistaken for a secret costs a resume after a restart, a
//! secret mistaken for a harmless header costs the user's account.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::ops::{Deref, DerefMut};

/// Whether a request header carries authentication material.
pub fn is_sensitive(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    if matches!(
        n.as_str(),
        "cookie" | "cookie2" | "authorization" | "proxy-authorization"
    ) {
        return true;
    }
    // Sites invent their own: `X-Auth-Token`, `X-Api-Key`, `X-CSRF-Token`,
    // `X-Amz-Security-Token`, `X-Session-Id`. None of the headers a download
    // legitimately needs in the clear -- `Referer`, `User-Agent`, `Accept` --
    // contains any of these.
    const MARKERS: [&str; 10] = [
        "auth", "token", "secret", "password", "passwd", "session", "api-key", "apikey", "csrf",
        "xsrf",
    ];
    MARKERS.iter().any(|m| n.contains(m))
}

/// A download's request headers.
///
/// Behaves as the map it wraps, so the transfer code is unchanged, but it is
/// careful about where it goes: serialising it writes only the headers that are
/// not [sensitive](is_sensitive), and its `Debug` masks their values. Reading
/// one in (from the extension, the add dialog, a test) takes everything.
#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct RequestHeaders(BTreeMap<String, String>);

impl RequestHeaders {
    pub fn new() -> Self {
        Self::default()
    }

    /// The headers that may be shown and stored as they are.
    pub fn public(&self) -> BTreeMap<String, String> {
        self.0
            .iter()
            .filter(|(k, _)| !is_sensitive(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// The credentials alone.
    pub fn secrets(&self) -> BTreeMap<String, String> {
        self.0
            .iter()
            .filter(|(k, _)| is_sensitive(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn has_secrets(&self) -> bool {
        self.0.keys().any(|k| is_sensitive(k))
    }

    /// Forgets the credentials, keeping everything else.
    pub fn drop_secrets(&mut self) {
        self.0.retain(|k, _| !is_sensitive(k));
    }

    pub fn into_inner(self) -> BTreeMap<String, String> {
        self.0
    }
}

impl From<BTreeMap<String, String>> for RequestHeaders {
    fn from(map: BTreeMap<String, String>) -> Self {
        Self(map)
    }
}

impl Deref for RequestHeaders {
    type Target = BTreeMap<String, String>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for RequestHeaders {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Serialize for RequestHeaders {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.public().serialize(s)
    }
}

impl fmt::Debug for RequestHeaders {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map()
            .entries(self.0.iter().map(|(k, v)| {
                let shown: &dyn fmt::Debug = if is_sensitive(k) { &Redacted } else { v };
                (k, shown)
            }))
            .finish()
    }
}

struct Redacted;

impl fmt::Debug for Redacted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/// Somewhere credentials can be sealed so that only this user can open them.
///
/// The engine never encrypts anything itself and holds no key: it hands the
/// bytes to the platform. A backend must authenticate what it seals -- a blob
/// that was altered has to fail to open, not open to something else.
pub trait Vault: Send + Sync {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String>;
}

/// The operating system's per-user protection: DPAPI on Windows. Elsewhere it
/// refuses, and credentials are then simply not stored.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemVault;

impl Vault for SystemVault {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        downpour_vault::protect(plain).map_err(|e| e.to_string())
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        downpour_vault::unprotect(sealed).map_err(|e| e.to_string())
    }
}

/// Seals a download's credentials for storage. `None` when there are none, or
/// when they cannot be sealed -- in which case they are not stored: a download
/// that needs signing in again is recoverable, a session left readable on disk
/// is not.
pub fn seal(vault: &dyn Vault, headers: &RequestHeaders) -> Option<Vec<u8>> {
    let secrets = headers.secrets();
    if secrets.is_empty() {
        return None;
    }
    let plain = serde_json::to_vec(&secrets).ok()?;
    match vault.seal(&plain) {
        Ok(sealed) => Some(sealed),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "could not protect a download's credentials; they will not be kept past this session"
            );
            None
        }
    }
}

/// Opens what [`seal`] stored. Anything that does not open cleanly into
/// well-formed credential headers yields nothing, never a partial or garbled
/// header: a request that goes out without a cookie fails visibly, one that
/// goes out with garbage in it fails confusingly or worse.
pub fn unseal(vault: &dyn Vault, sealed: &[u8]) -> BTreeMap<String, String> {
    let fail = |why: &str| {
        tracing::warn!(
            reason = why,
            "a download's stored credentials could not be read; it will need them again"
        );
        BTreeMap::new()
    };
    let plain = match vault.open(sealed) {
        Ok(p) => p,
        Err(_) => return fail("they could not be unsealed"),
    };
    let map: BTreeMap<String, String> = match serde_json::from_slice(&plain) {
        Ok(m) => m,
        Err(_) => return fail("they were not in the expected form"),
    };
    let well_formed = map.iter().all(|(k, v)| {
        is_sensitive(k)
            && reqwest::header::HeaderName::from_bytes(k.as_bytes()).is_ok()
            && reqwest::header::HeaderValue::from_str(v).is_ok()
    });
    if !well_formed {
        return fail("they held something other than credential headers");
    }
    map
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// Masks the value of any credential header written out in `text`, whether as
/// `Cookie: ...`, `"Cookie": "..."` or `cookie=...`.
///
/// A last line of defence for text about to leave the machine -- a log tail
/// pasted into a bug report. Nothing in the engine logs a credential; this is
/// for whatever else might.
pub fn redact(text: &str) -> String {
    const NAMES: [&str; 3] = ["proxy-authorization", "authorization", "cookie"];
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        let Some(name) = NAMES.iter().find(|n| lower[i..].starts_with(*n)) else {
            i += 1;
            continue;
        };
        // `set-cookie` is a response header, but a logged one is still a session.
        let mut j = i + name.len();
        // A longer word that merely begins with the name (`cookies`) is not it.
        if j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-') {
            i = j;
            continue;
        }
        let skip = |j: &mut usize, set: &[u8]| {
            while *j < bytes.len() && set.contains(&bytes[*j]) {
                *j += 1;
            }
        };
        skip(&mut j, b"\"' \t");
        if j >= bytes.len() || !matches!(bytes[j], b':' | b'=') {
            i += name.len();
            continue;
        }
        j += 1;
        skip(&mut j, b" \t");
        let quoted = j < bytes.len() && matches!(bytes[j], b'"' | b'\'');
        if quoted {
            j += 1;
        }
        let start = j;
        while j < bytes.len() && bytes[j] != b'\n' && bytes[j] != b'\r' {
            if quoted && matches!(bytes[j], b'"' | b'\'') && bytes[j - 1] != b'\\' {
                break;
            }
            j += 1;
        }
        if j > start {
            out.push_str(&text[copied..start]);
            out.push_str("<redacted>");
            copied = j;
        }
        i = j.max(i + 1);
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> RequestHeaders {
        let mut h = RequestHeaders::new();
        h.insert("Cookie".into(), "session=s3cr3t".into());
        h.insert("Authorization".into(), "Bearer t0k3n".into());
        h.insert("X-Auth-Token".into(), "abc123xyz".into());
        h.insert("Referer".into(), "https://site.example/page".into());
        h.insert("User-Agent".into(), "Mozilla/5.0".into());
        h
    }

    #[test]
    fn classifies_the_headers_that_carry_a_session() {
        for name in [
            "Cookie",
            "cookie",
            "Authorization",
            "Proxy-Authorization",
            "X-Auth-Token",
            "X-Api-Key",
            "X-CSRF-Token",
            "X-Amz-Security-Token",
            "X-Session-Id",
        ] {
            assert!(is_sensitive(name), "{name} carries a session");
        }
        for name in [
            "Referer",
            "User-Agent",
            "Accept",
            "Accept-Language",
            "Origin",
            "Range",
        ] {
            assert!(!is_sensitive(name), "{name} is needed in the clear");
        }
    }

    #[test]
    fn serialising_leaves_the_credentials_out() {
        let json = serde_json::to_string(&captured()).unwrap();
        for secret in ["s3cr3t", "t0k3n", "abc123xyz", "Cookie", "Authorization"] {
            assert!(!json.contains(secret), "{secret} leaked into {json}");
        }
        assert!(json.contains("Referer") && json.contains("Mozilla"));
    }

    #[test]
    fn reading_in_keeps_everything() {
        let h: RequestHeaders =
            serde_json::from_str(r#"{"Cookie":"a=b","Referer":"https://x/"}"#).unwrap();
        assert_eq!(h.get("Cookie").map(String::as_str), Some("a=b"));
    }

    #[test]
    fn debug_masks_the_values() {
        let shown = format!("{:?}", captured());
        for secret in ["s3cr3t", "t0k3n", "abc123xyz"] {
            assert!(!shown.contains(secret), "{secret} leaked into {shown}");
        }
        assert!(shown.contains("Cookie") && shown.contains("<redacted>"));
        assert!(shown.contains("https://site.example/page"));
    }

    #[test]
    fn drop_secrets_keeps_the_rest() {
        let mut h = captured();
        h.drop_secrets();
        assert!(!h.has_secrets());
        assert_eq!(h.len(), 2);
    }

    /// Reverses the bytes and appends a checksum: enough to tell sealed from
    /// plain and to notice tampering, without needing the real platform store.
    struct Mirror;
    impl Vault for Mirror {
        fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
            let mut v: Vec<u8> = plain.iter().rev().map(|b| b ^ 0x5a).collect();
            v.push(plain.iter().fold(0u8, |a, b| a.wrapping_add(*b)));
            Ok(v)
        }
        fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
            let (sum, body) = sealed.split_last().ok_or("empty")?;
            let plain: Vec<u8> = body.iter().rev().map(|b| b ^ 0x5a).collect();
            if plain.iter().fold(0u8, |a, b| a.wrapping_add(*b)) != *sum {
                return Err("tampered".into());
            }
            Ok(plain)
        }
    }

    struct Refuses;
    impl Vault for Refuses {
        fn seal(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("no".into())
        }
        fn open(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("no".into())
        }
    }

    #[test]
    fn seal_round_trips_only_the_credentials() {
        let sealed = seal(&Mirror, &captured()).unwrap();
        let back = unseal(&Mirror, &sealed);
        assert_eq!(back, captured().secrets());
        assert!(!back.contains_key("Referer"));
    }

    #[test]
    fn nothing_to_seal_stores_nothing() {
        let mut h = captured();
        h.drop_secrets();
        assert!(seal(&Mirror, &h).is_none());
    }

    #[test]
    fn a_vault_that_refuses_means_nothing_is_stored() {
        assert!(seal(&Refuses, &captured()).is_none());
    }

    #[test]
    fn corrupt_material_yields_no_headers_at_all() {
        let mut sealed = seal(&Mirror, &captured()).unwrap();
        sealed[3] ^= 0xff;
        assert!(unseal(&Mirror, &sealed).is_empty());
        assert!(unseal(&Mirror, b"").is_empty());
        // Opens fine, but is not a header map.
        let junk = Mirror.seal(b"\x00\x01 not json").unwrap();
        assert!(unseal(&Mirror, &junk).is_empty());
        // A header map, but not of credentials -- or with a value that could
        // smuggle a second header into the request.
        let wrong = Mirror.seal(br#"{"Host":"evil.example"}"#).unwrap();
        assert!(unseal(&Mirror, &wrong).is_empty());
        let split = Mirror
            .seal(b"{\"Cookie\":\"a=b\\r\\nHost: evil\"}")
            .unwrap();
        assert!(unseal(&Mirror, &split).is_empty());
    }

    #[test]
    fn redact_masks_credential_values_in_free_text() {
        let text = "GET /f\nCookie: session=s3cr3t; other=1\nReferer: https://x/\n\
                    headers={\"Authorization\": \"Bearer t0k3n\", \"Accept\": \"*/*\"}\n\
                    proxy-authorization=Basic Zm9vOmJhcg==\n\
                    3 cookies were set";
        let out = redact(text);
        for secret in ["s3cr3t", "other=1", "t0k3n", "Zm9vOmJhcg"] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
        assert!(out.contains("Referer: https://x/"));
        assert!(out.contains("\"Accept\": \"*/*\""));
        assert!(out.contains("3 cookies were set"));
    }
}
