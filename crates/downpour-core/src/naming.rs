//! Filename derivation and sanitisation.
//!
//! Getting this wrong is the difference between a download landing as
//! `report.pdf` and landing as `download?id=4471&token=...`, so the precedence
//! is explicit: `Content-Disposition` beats the URL path, which beats a
//! fallback. Everything is then sanitised for Windows, which has the strictest
//! rules of the platforms we target.

use percent_encoding::percent_decode_str;

/// Characters Windows forbids in a filename, plus the path separators.
const FORBIDDEN: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Device names Windows reserves regardless of extension. `CON.txt` is as
/// invalid as `CON`.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Leaves room for the `.dpart` / `.dpmeta` suffixes inside the 255-byte limit
/// that every filesystem we care about enforces per path component.
const MAX_STEM_BYTES: usize = 200;

/// Makes an arbitrary string safe to use as a single path component.
///
/// Returns `None` when nothing usable survives, so callers fall back rather
/// than creating a file named `_`.
pub fn sanitize(name: &str) -> Option<String> {
    // Reject anything that tries to escape the destination directory. A server
    // is free to suggest `../../autoexec.bat`; we are not free to honour it.
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);

    let mut out: String = name
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if FORBIDDEN.contains(&c) { '_' } else { c })
        .collect();

    // Windows silently strips trailing dots and spaces, which turns
    // `file.txt.` into `file.txt` behind our back; do it ourselves so the name
    // we record is the name on disk.
    out = out.trim().trim_end_matches(['.', ' ']).trim().to_string();

    if out.is_empty() || out == "." || out == ".." {
        return None;
    }

    // Split once so we can length-limit the stem without destroying the
    // extension, which is what the OS uses to pick an icon and a handler.
    let (stem, ext) = match out.rsplit_once('.') {
        // A leading dot means the whole thing is the stem (`.gitignore`).
        Some((s, e)) if !s.is_empty() && e.len() <= 16 => (s.to_string(), Some(e.to_string())),
        _ => (out.clone(), None),
    };

    let stem_upper = stem.to_ascii_uppercase();
    let stem = if RESERVED.contains(&stem_upper.as_str()) {
        format!("{stem}_")
    } else {
        stem
    };

    let stem = truncate_bytes(&stem, MAX_STEM_BYTES);

    Some(match ext {
        Some(e) => format!("{stem}.{e}"),
        None => stem,
    })
}

/// Truncates on a char boundary so we never produce invalid UTF-8.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].trim_end().to_string()
}

/// Extracts a filename from a `Content-Disposition` header value.
///
/// Prefers the RFC 5987 `filename*` form, which carries an explicit charset and
/// is the only one that round-trips non-ASCII names correctly.
pub fn from_content_disposition(value: &str) -> Option<String> {
    // filename*=UTF-8''Na%C3%AFve%20file.pdf
    if let Some(idx) = find_param(value, "filename*") {
        let raw = &value[idx..];
        let raw = raw.split(';').next().unwrap_or(raw).trim();
        // charset'language'percent-encoded-value
        let encoded = match raw.splitn(3, '\'').nth(2) {
            Some(v) => v,
            None => raw,
        };
        let decoded = percent_decode_str(encoded).decode_utf8_lossy().to_string();
        if let Some(clean) = sanitize(&decoded) {
            return Some(clean);
        }
    }

    if let Some(idx) = find_param(value, "filename") {
        let raw = value[idx..].trim();
        let raw = if let Some(rest) = raw.strip_prefix('"') {
            rest.split('"').next().unwrap_or(rest)
        } else {
            raw.split(';').next().unwrap_or(raw).trim()
        };
        return sanitize(raw);
    }

    None
}

/// Finds the byte offset just past `name=` in a header value, matching the
/// parameter name case-insensitively and only at a parameter boundary, so
/// `filename` does not match inside `xfilename`.
fn find_param(value: &str, name: &str) -> Option<usize> {
    let lower = value.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(name) {
        let at = from + rel;
        let before_ok = at == 0
            || matches!(lower.as_bytes()[at - 1], b';' | b' ' | b'\t');
        let after = at + name.len();
        // `filename` must not match the `filename` prefix of `filename*`.
        let after_ok = lower[after..].starts_with('=')
            || lower[after..].trim_start().starts_with('=');
        if before_ok && after_ok {
            let eq = lower[after..].find('=')? + after;
            return Some(eq + 1);
        }
        from = at + name.len();
    }
    None
}

/// Derives a filename from a URL path, ignoring the query string.
pub fn from_url(url: &url::Url) -> Option<String> {
    let last = url.path_segments()?.filter(|s| !s.is_empty()).next_back()?;
    let decoded = percent_decode_str(last).decode_utf8_lossy().to_string();
    sanitize(&decoded)
}

/// The full precedence chain, with a guaranteed result.
pub fn derive(
    explicit: Option<&str>,
    content_disposition: Option<&str>,
    url: &url::Url,
    content_type: Option<&str>,
) -> String {
    explicit
        .and_then(sanitize)
        .or_else(|| content_disposition.and_then(from_content_disposition))
        .or_else(|| from_url(url))
        .unwrap_or_else(|| {
            let ext = content_type.and_then(extension_for_mime).unwrap_or("bin");
            format!("download.{ext}")
        })
}

fn extension_for_mime(ct: &str) -> Option<&'static str> {
    let base = ct.split(';').next()?.trim().to_ascii_lowercase();
    Some(match base.as_str() {
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/x-7z-compressed" => "7z",
        "application/x-rar-compressed" | "application/vnd.rar" => "rar",
        "application/gzip" | "application/x-gzip" => "gz",
        "application/x-msdownload" | "application/vnd.microsoft.portable-executable" => "exe",
        "application/x-msi" => "msi",
        "application/json" => "json",
        "text/plain" => "txt",
        "text/html" => "html",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/x-matroska" => "mkv",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/flac" => "flac",
        "audio/ogg" => "ogg",
        _ => return None,
    })
}

/// Finds a free filename in `dir` by appending ` (1)`, ` (2)` and so on before
/// the extension, the same convention Explorer and browsers use.
pub fn deduplicate(dir: &std::path::Path, name: &str) -> String {
    if !dir.join(name).exists() && !dir.join(format!("{name}.dpart")).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, Some(e)),
        _ => (name, None),
    };
    for n in 1..10_000 {
        let candidate = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        if !dir.join(&candidate).exists() && !dir.join(format!("{candidate}.dpart")).exists() {
            return candidate;
        }
    }
    // Astronomically unlikely; a timestamp beats failing the download.
    format!("{stem}-{}", uuid::Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_forbidden_characters() {
        assert_eq!(sanitize("a<b>c:d\"e|f?g*h").unwrap(), "a_b_c_d_e_f_g_h");
    }

    #[test]
    fn sanitize_strips_directory_traversal() {
        assert_eq!(sanitize("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(sanitize("..\\..\\windows\\system32\\cmd.exe").unwrap(), "cmd.exe");
        assert_eq!(sanitize(".."), None);
    }

    #[test]
    fn sanitize_strips_trailing_dots_and_spaces() {
        assert_eq!(sanitize("file.txt.  ").unwrap(), "file.txt");
        assert_eq!(sanitize("  spaced  ").unwrap(), "spaced");
    }

    #[test]
    fn sanitize_escapes_reserved_device_names() {
        assert_eq!(sanitize("CON").unwrap(), "CON_");
        assert_eq!(sanitize("con.txt").unwrap(), "con_.txt");
        assert_eq!(sanitize("COM1.log").unwrap(), "COM1_.log");
        assert_eq!(sanitize("console.log").unwrap(), "console.log", "only exact matches");
    }

    #[test]
    fn sanitize_rejects_empty_results() {
        assert_eq!(sanitize(""), None);
        assert_eq!(sanitize("   "), None);
        assert_eq!(sanitize("..."), None);
    }

    #[test]
    fn sanitize_keeps_extension_when_truncating() {
        let long = "x".repeat(500);
        let out = sanitize(&format!("{long}.tar.gz")).unwrap();
        assert!(out.ends_with(".gz"));
        assert!(out.len() <= MAX_STEM_BYTES + 8);
    }

    #[test]
    fn sanitize_preserves_unicode() {
        assert_eq!(sanitize("naïve — файл.pdf").unwrap(), "naïve — файл.pdf");
    }

    #[test]
    fn content_disposition_quoted_filename() {
        assert_eq!(
            from_content_disposition("attachment; filename=\"annual report.pdf\"").unwrap(),
            "annual report.pdf"
        );
    }

    #[test]
    fn content_disposition_unquoted_filename() {
        assert_eq!(
            from_content_disposition("attachment; filename=setup.exe").unwrap(),
            "setup.exe"
        );
    }

    #[test]
    fn content_disposition_prefers_rfc5987_form() {
        let v = "attachment; filename=\"naive.pdf\"; filename*=UTF-8''na%C3%AFve.pdf";
        assert_eq!(from_content_disposition(v).unwrap(), "naïve.pdf");
    }

    #[test]
    fn content_disposition_ignores_path_in_filename() {
        assert_eq!(
            from_content_disposition("attachment; filename=\"../../evil.sh\"").unwrap(),
            "evil.sh"
        );
    }

    #[test]
    fn content_disposition_without_filename_yields_none() {
        assert_eq!(from_content_disposition("inline"), None);
        assert_eq!(from_content_disposition("attachment"), None);
    }

    #[test]
    fn url_filename_ignores_query_string() {
        let u = url::Url::parse("https://example.com/files/report.pdf?token=abc&x=1").unwrap();
        assert_eq!(from_url(&u).unwrap(), "report.pdf");
    }

    #[test]
    fn url_filename_percent_decodes() {
        let u = url::Url::parse("https://example.com/my%20file%20(1).zip").unwrap();
        assert_eq!(from_url(&u).unwrap(), "my file (1).zip");
    }

    #[test]
    fn url_with_no_path_yields_none() {
        let u = url::Url::parse("https://example.com/").unwrap();
        assert_eq!(from_url(&u), None);
    }

    #[test]
    fn derive_follows_precedence() {
        let u = url::Url::parse("https://example.com/from-url.bin").unwrap();
        assert_eq!(
            derive(Some("explicit.txt"), Some("attachment; filename=cd.txt"), &u, None),
            "explicit.txt"
        );
        assert_eq!(
            derive(None, Some("attachment; filename=cd.txt"), &u, None),
            "cd.txt"
        );
        assert_eq!(derive(None, None, &u, None), "from-url.bin");
    }

    #[test]
    fn derive_falls_back_to_mime_extension() {
        let u = url::Url::parse("https://example.com/").unwrap();
        assert_eq!(derive(None, None, &u, Some("application/pdf")), "download.pdf");
        assert_eq!(derive(None, None, &u, Some("video/mp4; charset=x")), "download.mp4");
        assert_eq!(derive(None, None, &u, None), "download.bin");
    }

    #[test]
    fn deduplicate_returns_original_when_free() {
        let dir = std::env::temp_dir().join(format!("dp-dedup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(deduplicate(&dir, "a.txt"), "a.txt");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deduplicate_increments_past_existing_files_and_parts() {
        let dir = std::env::temp_dir().join(format!("dp-dedup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        assert_eq!(deduplicate(&dir, "a.txt"), "a (1).txt");
        // An in-flight download also reserves its name.
        std::fs::write(dir.join("a (1).txt.dpart"), b"x").unwrap();
        assert_eq!(deduplicate(&dir, "a.txt"), "a (2).txt");
        std::fs::remove_dir_all(&dir).ok();
    }
}
