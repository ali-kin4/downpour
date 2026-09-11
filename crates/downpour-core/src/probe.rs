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
        if k.eq_ignore_ascii_case("range") {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            map.insert(name, value);
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
        // A 416 means the server understood the range but the file is empty.
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(RemoteInfo {
                final_url,
                size: Some(0),
                supports_range: false,
                etag: header_string(&h, ETAG),
                last_modified: header_string(&h, LAST_MODIFIED),
                content_type: header_string(&h, CONTENT_TYPE),
                suggested_filename: header_string(&h, CONTENT_DISPOSITION),
            });
        }
        return Err(Error::BadStatus { status: status.as_u16(), url: final_url });
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

fn header_string(h: &HeaderMap, name: impl reqwest::header::AsHeaderName) -> Option<String> {
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
        assert_eq!(parse_content_range_total_str("bytes 0-0/12345"), Some(12345));
        assert_eq!(parse_content_range_total_str("bytes 0-499/1000"), Some(1000));
    }

    #[test]
    fn content_range_total_rejects_unknown() {
        assert_eq!(parse_content_range_total_str("bytes 0-0/*"), None);
        assert_eq!(parse_content_range_total_str("garbage"), None);
    }

    #[test]
    fn content_range_span_parses() {
        assert_eq!(parse_content_range_span("bytes 200-1000/67589"), Some((200, 1000)));
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
    fn build_headers_skips_malformed_entries() {
        let mut m = BTreeMap::new();
        m.insert("Bad Header".to_string(), "v".to_string());
        m.insert("Referer".to_string(), "https://example.com/".to_string());
        let built = build_headers(&m);
        assert_eq!(built.len(), 1);
        assert!(built.get("referer").is_some());
    }
}
