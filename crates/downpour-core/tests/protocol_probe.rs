//! Confirms which HTTP version the engine's client actually negotiates.
//!
//! Ignored by default because it needs the public internet. It exists because
//! the answer changes the whole segmentation story: reqwest multiplexes
//! concurrent requests to one origin onto a *single* TCP connection when HTTP/2
//! is negotiated, which defeats the reason for opening several connections in
//! the first place — escaping per-connection server shaping.
//!
//! Run with: cargo test -p downpour-core --test protocol_probe -- --ignored --nocapture

use std::time::Duration;

/// Every request the engine makes must be HTTP/1.1, on every real host.
///
/// If this ever reports HTTP/2 again, segmented downloading has silently
/// stopped working: the segments become streams inside one TCP connection,
/// they share the server's per-connection shaping instead of escaping it, and
/// the whole transfer is capped by hyper's 5 MiB HTTP/2 connection window.
/// Nothing user-visible breaks, downloads just quietly get slower — which is
/// exactly why it needs a test rather than a comment.
#[tokio::test]
#[ignore = "requires network access"]
async fn the_client_never_negotiates_http2() {
    let client =
        downpour_core::transfer::build_client("downpour-probe/0.1", Duration::from_secs(30))
            .unwrap();

    for url in [
        "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip",
        "https://cdn.jsdelivr.net/npm/react@19.0.0/package.json",
        "https://www.rust-lang.org/",
    ] {
        match client.get(url).header("Range", "bytes=0-0").send().await {
            Ok(r) => {
                println!("{:?}  {}  <- {url}", r.version(), r.status());
                assert_eq!(
                    r.version(),
                    reqwest::Version::HTTP_11,
                    "{url} negotiated {:?}; segmentation is defeated",
                    r.version()
                );
            }
            Err(e) => panic!("could not reach {url}: {e}"),
        }
    }

    // And prove whether several concurrent ranged requests share one connection.
    let url = "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip";
    let mut set = tokio::task::JoinSet::new();
    for i in 0..4u64 {
        let c = client.clone();
        let u = url.to_string();
        set.spawn(async move {
            let start = i * 100_000;
            let r = c
                .get(&u)
                .header("Range", format!("bytes={start}-{}", start + 99_999))
                .send()
                .await;
            let r = r.expect("concurrent ranged request failed");
            assert_eq!(r.version(), reqwest::Version::HTTP_11);
            format!("{:?} {}", r.version(), r.status())
        });
    }
    while let Some(res) = set.join_next().await {
        println!("concurrent segment -> {}", res.unwrap());
    }
}
