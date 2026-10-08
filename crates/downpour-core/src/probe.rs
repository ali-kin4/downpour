//! Resource probing: size, range support, validators and filename.
//!
//! The load-bearing decision here is **never trusting `Accept-Ranges`**. Plenty
//! of servers, CDNs and reverse proxies advertise `Accept-Ranges: bytes` and
//! then return `200 OK` with the entire body when you actually send a `Range`
//! header. A segmented downloader that believes the advertisement writes the
//! whole file into every segment slot and produces a corrupt result that passes
//! every length check. So we probe with a real one-byte range request and
//! believe only the response status.

use crate::error::{Error, Result};
use crate::model::RemoteInfo;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, ETAG, LAST_MODIFIED, RANGE,
};
use reqwest::{Client, StatusCode};
use std::collections::BTreeMap;

/// Builds a `HeaderMap` from the download's user-supplied headers, skipping any
/// that are malformed rather than failing the whole download.
pub fn build_headers(headers: &BTreeMap<String, String>) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        // `Range` is ours to control; a stale one from a captured request would
        // silently truncate every segment.
        //
        // `Accept-Encoding` is dropped for a subtler reason: headers captured
        // from a browser routinely ask for `gzip, br, zstd`, and a compressed
        // response makes the byte offsets a ranged download is built on
        // meaningless. We would also be advertising codecs this client was not
        // built with, whose bytes it could not decode at all.
        if k.eq_ignore_ascii_case("range") || k.eq_ignore_ascii_case("accept-encoding") {
            continue;
        }
        if let (Ok(name), Ok(mut value)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            // Marked so the HTTP stack masks it in its own debug output, which
            // a user chasing a bug can switch on with `DOWNPOUR_LOG`.
            value.set_sensitive(crate::credentials::is_sensitive(k));
            map.insert(name, value);
        }
    }
    map
}

/// The caller's headers as they may be sent to `remote.final_url`.
///
/// The probe follows redirects inside reqwest, which drops credentials when a
/// hop changes host. Every request after it goes straight to the final URL,
/// though, with headers rebuilt from what the caller supplied -- so the same
/// rule has to be applied again here, or the strip on the probe is undone on
/// the very next request.
pub fn headers_for(headers: &BTreeMap<String, String>, remote: &RemoteInfo) -> HeaderMap {
    let mut map = build_headers(headers);
    if !remote.credentials_follow() {
        // Every header the engine treats as a credential, not just the
        // standard four: a site's own `X-Api-Key` is as much a session.
        let names: Vec<_> = map
            .keys()
            .filter(|k| crate::credentials::is_sensitive(k.as_str()))
            .cloned()
            .collect();
        for name in names {
            map.remove(name);
        }
    }
    map
}

/// Interrogates the resource with a single ranged GET.
///
/// One request yields everything we need: status tells us whether ranges are
/// really honoured, `Content-Range` gives the true total size even when
/// `Content-Length` is 1, and the rest of the headers give validators and a
/// filename.
pub async fn probe(
    client: &Client,
    url: &str,
    headers: &BTreeMap<String, String>,
) -> Result<RemoteInfo> {
    let parsed = url::Url::parse(url).map_err(|e| Error::InvalidUrl(format!("{url}: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Error::InvalidUrl(format!(
            "unsupported scheme `{}`",
            parsed.scheme()
        )));
    }

    let mut req_headers = build_headers(headers);
    req_headers.insert(RANGE, HeaderValue::from_static("bytes=0-0"));

    let response = client
        .get(parsed.clone())
        .headers(req_headers)
        .send()
        .await?;

    let status = response.status();
    let final_url = response.url().to_string();
    let h = response.headers().clone();

    // Drop the body immediately; at most one byte, and we do not want the
    // connection held open while we think.
    drop(response);

    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        // A 416 to `bytes=0-0` usually means the file is empty, but only
        // `Content-Range: bytes */0` says so. `bytes */N` is a server stating
        // the file is N bytes and declining to serve a part of it -- recording
        // that as empty fails the download on its own length check. Without
        // the header the size is unknown. Every case is one plain stream.
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(RemoteInfo {
                requested_url: url.to_string(),
                final_url,
                size: parse_content_range_total(&h),
                supports_range: false,
                etag: header_string(&h, ETAG),
                last_modified: header_string(&h, LAST_MODIFIED),
                content_type: header_string(&h, CONTENT_TYPE),
                suggested_filename: header_string(&h, CONTENT_DISPOSITION),
            });
        }
        return Err(Error::BadStatus {
            status: status.as_u16(),
            url: final_url,
        });
    }

    // 206 is the only proof of real range support.
    let supports_range = status == StatusCode::PARTIAL_CONTENT;

    let size = if supports_range {
        // `Content-Range: bytes 0-0/1234` — the part after the slash is truth.
        parse_content_range_total(&h)
    } else {
        // Plain 200: the body is the whole file, so Content-Length is the size.
        // Absent (chunked transfer) means unknown size, which forces a single
        // stream with no progress bar rather than a wrong one.
        header_string(&h, CONTENT_LENGTH).and_then(|v| v.parse::<u64>().ok())
    };

    // A server that advertises ranges but returned 200 is the liar case. We
    // record the truth (`supports_range: false`) and log it, because it is the
    // single most common cause of corrupt segmented downloads elsewhere.
    if !supports_range && header_string(&h, ACCEPT_RANGES).as_deref() == Some("bytes") {
        tracing::warn!(
            url = %final_url,
            "server advertises Accept-Ranges: bytes but returned 200 to a ranged request; \
             falling back to a single connection"
        );
    }

    Ok(RemoteInfo {
        requested_url: url.to_string(),
        final_url,
        size,
        // A zero-length or unknown-length file gains nothing from segmentation.
        supports_range: supports_range && size.map(|s| s > 0).unwrap_or(false),
        etag: header_string(&h, ETAG),
        last_modified: header_string(&h, LAST_MODIFIED),
        content_type: header_string(&h, CONTENT_TYPE),
        suggested_filename: header_string(&h, CONTENT_DISPOSITION),
    })
}

pub fn header_string(h: &HeaderMap, name: impl reqwest::header::AsHeaderName) -> Option<String> {
    h.get(name)?.to_str().ok().map(|s| s.trim().to_string())
}

/// Extracts the total from `Content-Range: bytes 0-0/12345`.
/// Returns `None` for `*` totals, which mean "the server will not say".
pub fn parse_content_range_total(h: &HeaderMap) -> Option<u64> {
    let raw = h.get(CONTENT_RANGE)?.to_str().ok()?;
    parse_content_range_total_str(raw)
}

pub fn parse_content_range_total_str(raw: &str) -> Option<u64> {
    let total = raw.rsplit('/').next()?.trim();
    if total == "*" {
        return None;
    }
    total.parse::<u64>().ok()
}

/// Extracts `(start, end)` from `Content-Range: bytes 200-1000/67589`.
///
/// Used to verify that a segment response covers the range we actually asked
/// for; a server that silently shifts the window would otherwise scatter bytes
/// at the wrong offsets.
pub fn parse_content_range_span(raw: &str) -> Option<(u64, u64)> {
    let after_unit = raw.trim().strip_prefix("bytes")?.trim();
    let span = after_unit.split('/').next()?.trim();
    let (start, end) = span.split_once('-')?;
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_total_parses() {
        assert_eq!(
            parse_content_range_total_str("bytes 0-0/12345"),
            Some(12345)
        );
        assert_eq!(
            parse_content_range_total_str("bytes 0-499/1000"),
            Some(1000)
        );
    }

    #[test]
    fn content_range_total_rejects_unknown() {
        assert_eq!(parse_content_range_total_str("bytes 0-0/*"), None);
        assert_eq!(parse_content_range_total_str("garbage"), None);
    }

    #[test]
    fn content_range_span_parses() {
        assert_eq!(
            parse_content_range_span("bytes 200-1000/67589"),
            Some((200, 1000))
        );
        assert_eq!(parse_content_range_span("bytes 0-0/1"), Some((0, 0)));
    }

    #[test]
    fn content_range_span_rejects_malformed() {
        assert_eq!(parse_content_range_span("items 0-1/2"), None);
        assert_eq!(parse_content_range_span("bytes */1234"), None);
    }

    #[test]
    fn build_headers_drops_caller_supplied_range() {
        let mut m = BTreeMap::new();
        m.insert("Range".to_string(), "bytes=500-".to_string());
        m.insert("Cookie".to_string(), "session=abc".to_string());
        let built = build_headers(&m);
        assert!(built.get(RANGE).is_none(), "caller Range must not survive");
        assert_eq!(built.get("cookie").unwrap(), "session=abc");
    }

    #[test]
    fn build_headers_drops_caller_supplied_accept_encoding() {
        // Browser-captured headers routinely carry this, and a compressed body
        // breaks the byte arithmetic every ranged download depends on.
        let mut m = BTreeMap::new();
        m.insert("accept-encoding".to_string(), "gzip, br, zstd".to_string());
        m.insert("Cookie".to_string(), "a=b".to_string());
        let built = build_headers(&m);
        assert!(built.get("accept-encoding").is_none());
        assert_eq!(built.len(), 1);
    }

    #[test]
    fn credentials_go_only_where_they_were_captured_for() {
        let mut caller = BTreeMap::new();
        caller.insert("Cookie".to_string(), "session=abc".to_string());
        caller.insert("Authorization".to_string(), "Bearer abc".to_string());
        caller.insert("Referer".to_string(), "https://site.example/".to_string());
        let remote = |from: &str, to: &str| RemoteInfo {
            requested_url: from.into(),
            final_url: to.into(),
            ..Default::default()
        };
        let kept = |r: RemoteInfo| {
            let h = headers_for(&caller, &r);
            assert!(h.get("referer").is_some(), "only credentials are dropped");
            h.get("cookie").is_some() && h.get("authorization").is_some()
        };

        assert!(kept(remote(
            "https://site.example/a",
            "https://site.example/b"
        )));
        assert!(kept(remote(
            "https://site.example/a",
            "https://site.example:443/b"
        )));
        assert!(!kept(remote(
            "https://site.example/a",
            "https://cdn.example/b"
        )));
        assert!(!kept(remote(
            "https://site.example/a",
            "https://site.example:8443/b"
        )));
        // A downgrade would put the session on the wire in clear.
        assert!(!kept(remote(
            "https://site.example/a",
            "http://site.example/b"
        )));
        // Nothing recorded, as in a sidecar older than the field: not proof.
        assert!(!kept(remote("", "https://site.example/b")));
    }

    #[test]
    fn a_sites_own_credential_headers_stay_behind_too() {
        let mut caller = BTreeMap::new();
        caller.insert("X-Api-Key".to_string(), "k-123".to_string());
        caller.insert("X-Auth-Token".to_string(), "t-456".to_string());
        caller.insert("Referer".to_string(), "https://site.example/".to_string());
        let elsewhere = RemoteInfo {
            requested_url: "https://site.example/a".into(),
            final_url: "https://cdn.example/a".into(),
            ..Default::default()
        };
        let h = headers_for(&caller, &elsewhere);
        assert!(h.get("x-api-key").is_none() && h.get("x-auth-token").is_none());
        assert!(h.get("referer").is_some());
    }

    #[test]
    fn build_headers_skips_malformed_entries() {
        let mut m = BTreeMap::new();
        m.insert("Bad Header".to_string(), "v".to_string());
        m.insert("Referer".to_string(), "https://example.com/".to_string());
        let built = build_headers(&m);
        assert_eq!(built.len(), 1);
        assert!(built.get("referer").is_some());
    }
}
