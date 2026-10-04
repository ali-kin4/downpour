//! Deciding whether a captured download is the new address of one that is
//! waiting for one.
//!
//! When the user asks to refresh a download's address, the app waits for them
//! to start the download again in the browser, and every capture in that time
//! is checked against the waiting downloads. The rule here decides only which
//! item a capture *belongs to*. Whether the bytes already on disk can be kept
//! is a separate question, answered afterwards by the resume rules against the
//! server's validators -- so a wrong match here can cost a restart, but it can
//! never splice two files together.
//!
//! The evidence, in the order it is required:
//!
//! - **where it came from.** The capture's address is on the same host as an
//!   address the item is known by, or it was started from the same page (its
//!   `Referer` matches the item's). Without this nothing else counts: a file
//!   of the same name and size from an unrelated site is a different file.
//! - **name** and **size.** Both matching attaches automatically. Only one of
//!   them is *ambiguous*: the caller must ask, never guess.

use crate::model::DownloadItem;

/// What a capture says about itself.
#[derive(Debug, Clone, Default)]
pub struct Candidate<'a> {
    pub url: &'a str,
    pub filename: Option<&'a str>,
    pub size: Option<u64>,
    pub referer: Option<&'a str>,
}

/// How well a capture fits one waiting download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    /// Same origin evidence, same name, same size: safe to attach unasked.
    Strong,
    /// Same origin evidence and one of name or size. Needs the user.
    Partial,
    None,
}

pub fn fit(item: &DownloadItem, c: &Candidate) -> Fit {
    if !same_source(item, c) {
        return Fit::None;
    }
    let name = c
        .filename
        .map(|n| same_name(basename(n), &item.filename))
        .unwrap_or(false);
    let size = matches!((c.size, item.total_bytes), (Some(a), Some(b)) if a == b && a > 0);
    match (name, size) {
        (true, true) => Fit::Strong,
        (true, false) | (false, true) => Fit::Partial,
        (false, false) => Fit::None,
    }
}

fn same_source(item: &DownloadItem, c: &Candidate) -> bool {
    let Some(host) = host_of(c.url) else {
        return false;
    };
    let known = [Some(item.url.as_str()), item.final_url.as_deref()];
    if known
        .iter()
        .flatten()
        .filter_map(|u| host_of(u))
        .any(|h| h == host)
    {
        return true;
    }
    let item_page = item
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("referer"))
        .map(|(_, v)| v.as_str());
    match (c.referer, item_page) {
        (Some(a), Some(b)) => page_key(a).is_some_and(|a| Some(a) == page_key(b)),
        _ => false,
    }
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(|h| h.to_ascii_lowercase())
}

/// A page address without its fragment, which never reaches the server and so
/// cannot make two visits to one page different.
fn page_key(url: &str) -> Option<String> {
    let mut u = url::Url::parse(url).ok()?;
    u.set_fragment(None);
    Some(u.to_string())
}

/// The browser may report a full path.
fn basename(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

/// Equal ignoring case and a `" (n)"` copy suffix on either side: the item may
/// have been renamed around a clash, and the browser may have done the same.
fn same_name(a: &str, b: &str) -> bool {
    let (a, b) = (strip_copy_suffix(a), strip_copy_suffix(b));
    !a.is_empty() && a.eq_ignore_ascii_case(&b)
}

fn strip_copy_suffix(name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let stem = match stem.rfind(" (") {
        Some(i)
            if stem.ends_with(')')
                && stem[i + 2..stem.len() - 1]
                    .chars()
                    .all(|c| c.is_ascii_digit())
                && stem.len() > i + 3 =>
        {
            &stem[..i]
        }
        _ => stem,
    };
    format!("{stem}{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DownloadStatus;
    use std::collections::BTreeMap;

    fn item(url: &str, name: &str, size: Option<u64>, referer: Option<&str>) -> DownloadItem {
        let mut headers = BTreeMap::new();
        if let Some(r) = referer {
            headers.insert("Referer".to_string(), r.to_string());
        }
        DownloadItem {
            id: "x".into(),
            url: url.into(),
            final_url: None,
            filename: name.into(),
            user_named: false,
            name_locked: true,
            dest_dir: Default::default(),
            headers,
            status: DownloadStatus::Paused,
            total_bytes: size,
            downloaded_bytes: 0,
            speed_bps: 0,
            eta_secs: None,
            connections: 1,
            supports_range: true,
            category: None,
            source: None,
            scheduled: false,
            error: None,
            checksum: None,
            created_at: 0,
            sequence: 0,
            started_at: None,
            completed_at: None,
            elapsed_ms: 0,
            removed_at: None,
            awaiting_address_until: None,
        }
    }

    fn cand<'a>(url: &'a str, name: &'a str, size: Option<u64>) -> Candidate<'a> {
        Candidate {
            url,
            filename: Some(name),
            size,
            referer: None,
        }
    }

    #[test]
    fn same_host_name_and_size_is_strong() {
        let i = item(
            "https://cdn.example/a?sig=old",
            "setup.exe",
            Some(500),
            None,
        );
        let c = cand("https://cdn.example/a?sig=new", "setup.exe", Some(500));
        assert_eq!(fit(&i, &c), Fit::Strong);
    }

    #[test]
    fn name_or_size_alone_is_only_partial() {
        let i = item("https://cdn.example/a", "setup.exe", Some(500), None);
        assert_eq!(
            fit(&i, &cand("https://cdn.example/b", "setup.exe", None)),
            Fit::Partial
        );
        assert_eq!(
            fit(&i, &cand("https://cdn.example/b", "other.exe", Some(500))),
            Fit::Partial
        );
    }

    #[test]
    fn nothing_counts_from_an_unrelated_source() {
        let i = item("https://cdn.example/a", "setup.exe", Some(500), None);
        let c = cand("https://elsewhere.example/a", "setup.exe", Some(500));
        assert_eq!(fit(&i, &c), Fit::None);
    }

    #[test]
    fn the_same_page_vouches_for_a_new_host() {
        // A link that hands off to a CDN on another domain: the host changed,
        // the page the user started from did not.
        let i = item(
            "https://objects.cdn-a.example/f",
            "setup.exe",
            Some(500),
            Some("https://site.example/releases#latest"),
        );
        let mut c = cand("https://objects.cdn-b.example/f", "setup.exe", Some(500));
        c.referer = Some("https://site.example/releases");
        assert_eq!(fit(&i, &c), Fit::Strong);
        c.referer = Some("https://site.example/other");
        assert_eq!(fit(&i, &c), Fit::None);
    }

    #[test]
    fn copy_suffixes_and_case_and_paths_do_not_hide_a_name() {
        let i = item("https://h.example/a", "Setup (1).EXE", Some(9), None);
        let c = cand(
            "https://h.example/a",
            r"C:\Users\me\Downloads\setup.exe",
            Some(9),
        );
        assert_eq!(fit(&i, &c), Fit::Strong);
        assert!(!same_name("a (x).zip", "a.zip"));
        assert!(!same_name("", ""));
    }

    #[test]
    fn an_unknown_or_zero_size_never_counts_as_equal() {
        let i = item("https://h.example/a", "f.bin", None, None);
        assert_eq!(
            fit(&i, &cand("https://h.example/a", "f.bin", None)),
            Fit::Partial
        );
        let i = item("https://h.example/a", "f.bin", Some(0), None);
        assert_eq!(
            fit(&i, &cand("https://h.example/a", "f.bin", Some(0))),
            Fit::Partial
        );
    }
}
