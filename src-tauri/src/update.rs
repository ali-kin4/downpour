//! "Check for updates": one request to the GitHub releases API, and only when
//! asked.
//!
//! Deliberately manual. Nothing here runs on a timer or at launch -- an
//! unprompted request every time the app opens is precisely what someone on a
//! metered connection does not want, and an update check is not worth a
//! background poller. The About dialog calls this when the user presses the
//! button, and at no other time.
//!
//! The check is also careful to distinguish "you are up to date" from "I could
//! not find out", because reporting a rate-limited request as up to date is how
//! people miss releases for months.

use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

/// Where releases are published. `owner/repo` rather than a full URL so the API
/// and the human-readable page cannot drift apart.
const REPO: &str = "ali-kin4/downpour";

/// Long enough for a slow link, short enough that a hung request does not leave
/// the dialog spinning indefinitely.
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// The running version, so the dialog can show both sides of the comparison.
    pub current: String,
    /// The newest published version, `v` stripped. `None` when the repository
    /// has no releases yet, which is not an error.
    pub latest: Option<String>,
    pub update_available: bool,
    /// The page to send the user to: the release itself when there is one.
    pub url: String,
    /// The release's title, where it has one worth showing.
    pub name: Option<String>,
}

/// Compares two `x.y.z` versions, tolerating a leading `v` and a trailing
/// pre-release or build suffix.
///
/// String equality would be wrong in both directions: it calls 1.10.0 different
/// from 1.9.0 correctly but by luck, and the moment a tag is written `v1.2.0`
/// while the manifest says `1.2.0` it reports an update forever.
fn is_newer(latest: &str, current: &str) -> Result<bool, String> {
    let parse = |s: &str| -> Result<semver::Version, String> {
        let trimmed = s.trim().trim_start_matches(['v', 'V']);
        semver::Version::parse(trimmed).map_err(|e| format!("unreadable version {s:?}: {e}"))
    };
    Ok(parse(latest)? > parse(current)?)
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let releases_page = format!("https://github.com/{REPO}/releases");

    let client = reqwest::Client::builder()
        // GitHub rejects API requests that do not identify themselves.
        .user_agent(format!("Downpour/{current}"))
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("could not start the check: {e}"))?;

    let response = client
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases/latest"
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "update check failed");
            "Could not reach GitHub. Check your connection and try again.".to_string()
        })?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        // No releases published yet. Nothing to offer, and nothing wrong.
        return Ok(UpdateCheck {
            current,
            latest: None,
            update_available: false,
            url: releases_page,
            name: None,
        });
    }
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        // Unauthenticated calls are rate-limited per address. Say so, rather
        // than letting a throttled check read as "up to date".
        return Err(
            "GitHub is rate-limiting update checks from this connection. Try again later."
                .to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!("GitHub answered {status}."));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("could not read GitHub's answer: {e}"))?;
    let release: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("could not read GitHub's answer: {e}"))?;

    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "GitHub's answer had no release in it.".to_string())?;
    let latest = tag.trim().trim_start_matches(['v', 'V']).to_string();
    let url = release
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(&releases_page)
        .to_string();
    let name = release
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);

    let update_available = is_newer(&latest, &current)?;
    Ok(UpdateCheck {
        current,
        latest: Some(latest),
        update_available,
        url,
        name,
    })
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn a_higher_version_is_newer() {
        assert!(is_newer("1.1.0", "1.0.1").unwrap());
        assert!(is_newer("2.0.0", "1.9.9").unwrap());
        // The comparison is numeric, not lexicographic.
        assert!(is_newer("1.10.0", "1.9.0").unwrap());
    }

    #[test]
    fn the_same_version_is_not_newer() {
        assert!(!is_newer("1.0.1", "1.0.1").unwrap());
        assert!(!is_newer("1.0.0", "1.0.1").unwrap());
    }

    #[test]
    fn a_v_prefix_is_not_a_difference() {
        // The tag is written `v1.0.1`; the manifest says `1.0.1`. These are the
        // same release, and string equality would claim otherwise forever.
        assert!(!is_newer("v1.0.1", "1.0.1").unwrap());
        assert!(is_newer("v1.2.0", "1.1.9").unwrap());
    }

    #[test]
    fn a_prerelease_does_not_supersede_the_release() {
        assert!(!is_newer("1.0.1-beta.1", "1.0.1").unwrap());
        assert!(is_newer("1.1.0", "1.1.0-rc.1").unwrap());
    }

    #[test]
    fn nonsense_is_an_error_not_an_update() {
        assert!(is_newer("nightly", "1.0.1").is_err());
        assert!(is_newer("", "1.0.1").is_err());
    }
}
