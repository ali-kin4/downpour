//! # downpour-core
//!
//! The headless download engine behind [Downpour](https://github.com/ali-kin4/downpour).
//!
//! It is deliberately independent of the desktop shell: the Tauri app, the CLI
//! and the test suite all drive the same [`Engine`]. That separation is what
//! lets the hard parts — segmentation, resume, scheduling — be tested against a
//! real HTTP server without a window ever opening.
//!
//! ## Design commitments
//!
//! - **Never trust `Accept-Ranges`.** Range support is proven by a `206`
//!   response to a real ranged request, never by an advertisement. See [`probe`].
//! - **Never stitch across versions.** A resume is refused unless the remote
//!   validators still match. See [`resume`].
//! - **Keep every connection busy.** Finished workers steal from the largest
//!   outstanding segment instead of retiring. See [`transfer`].

#![forbid(unsafe_code)]
#![warn(clippy::all)]

pub mod error;
pub mod model;
pub mod naming;
pub mod probe;
pub mod resume;
pub mod scheduler;
pub mod settings;
pub mod speed;
pub mod store;
pub mod throttle;
pub mod transfer;

mod engine;

pub use engine::{Engine, EngineConfig, QueueStats};
pub use error::{Error, Result};
pub use model::{
    DownloadId, DownloadItem, DownloadSpec, DownloadStatus, EngineEvent, RemoteInfo, Segment,
    StartMode,
};
pub use scheduler::{DaySet, LocalMoment, Schedule, ScheduleWindow, Weekday};
pub use settings::Settings;
pub use throttle::RateLimiter;

/// Extracts every plausible HTTP(S) URL from a blob of text.
///
/// This is what turns "I have 20 links in my clipboard" and "here is a .txt of
/// links" into a batch, so it is forgiving: it accepts one-per-line, comma or
/// whitespace separated, and links embedded in prose, then deduplicates while
/// preserving the order the user wrote them in.
pub fn extract_urls(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for raw in text.split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '"' || c == '\'')
    {
        let candidate = raw.trim();
        if candidate.len() < 8 {
            continue;
        }
        let lower = candidate.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            continue;
        }
        // Trailing punctuation is nearly always prose, not part of the URL.
        // Brackets are kept only when balanced, because Wikipedia-style URLs
        // legitimately contain them.
        let cleaned = trim_trailing_punctuation(candidate);
        if url::Url::parse(cleaned).is_err() {
            continue;
        }
        if seen.insert(cleaned.to_string()) {
            out.push(cleaned.to_string());
        }
    }
    out
}

fn trim_trailing_punctuation(s: &str) -> &str {
    let mut end = s.len();
    let bytes = s.as_bytes();
    while end > 0 {
        let c = bytes[end - 1] as char;
        let strip = match c {
            '.' | ',' | ';' | ':' | '!' | '?' | '>' | '"' | '\'' => true,
            ')' => s[..end].matches('(').count() < s[..end].matches(')').count(),
            ']' => s[..end].matches('[').count() < s[..end].matches(']').count(),
            _ => false,
        };
        if strip {
            end -= 1;
        } else {
            break;
        }
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_one_url_per_line() {
        let text = "https://a.com/1.zip\nhttps://b.com/2.zip\nhttps://c.com/3.zip";
        assert_eq!(extract_urls(text).len(), 3);
    }

    #[test]
    fn extracts_from_mixed_separators() {
        let text = "https://a.com/1.zip, https://b.com/2.zip;https://c.com/3.zip";
        let urls = extract_urls(text);
        assert_eq!(urls.len(), 3);
        assert_eq!(urls[0], "https://a.com/1.zip");
    }

    #[test]
    fn extracts_urls_embedded_in_prose() {
        let text = "Grab it from https://example.com/setup.exe, then run it.";
        assert_eq!(extract_urls(text), vec!["https://example.com/setup.exe"]);
    }

    #[test]
    fn strips_trailing_sentence_punctuation() {
        assert_eq!(
            extract_urls("See https://example.com/a.zip."),
            vec!["https://example.com/a.zip"]
        );
        assert_eq!(
            extract_urls("Really? https://example.com/a.zip?"),
            vec!["https://example.com/a.zip"]
        );
    }

    #[test]
    fn keeps_balanced_parentheses_inside_a_url() {
        let u = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
        assert_eq!(extract_urls(u), vec![u]);
    }

    #[test]
    fn strips_an_unbalanced_closing_parenthesis() {
        assert_eq!(
            extract_urls("(see https://example.com/a.zip)"),
            vec!["https://example.com/a.zip"]
        );
    }

    #[test]
    fn deduplicates_but_preserves_order() {
        let text = "https://b.com/2.zip https://a.com/1.zip https://b.com/2.zip";
        assert_eq!(
            extract_urls(text),
            vec!["https://b.com/2.zip", "https://a.com/1.zip"]
        );
    }

    #[test]
    fn ignores_non_http_schemes_and_bare_words() {
        let text = "ftp://x.com/a magnet:?xt=urn:btih:abc file:///c:/x.txt hello world";
        assert!(extract_urls(text).is_empty());
    }

    #[test]
    fn ignores_malformed_urls() {
        assert!(extract_urls("https://").is_empty());
        assert!(extract_urls("http:// spaced.com").is_empty());
    }

    #[test]
    fn handles_query_strings_and_fragments() {
        let u = "https://example.com/file.bin?token=a1b2&x=1#frag";
        assert_eq!(extract_urls(u), vec![u]);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(extract_urls("").is_empty());
        assert!(extract_urls("   \n\t ").is_empty());
    }
}
