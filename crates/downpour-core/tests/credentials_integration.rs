//! Request credentials at rest: what a browser session captured with a
//! download leaves on disk, and for how long.
//!
//! Every test here asserts on the bytes of the database file or on what the
//! store hands back, not on the engine's in-memory list: the bug these guard
//! against is a session cookie readable by anyone who can read `downpour.db`.

#![allow(clippy::field_reassign_with_default)]

mod common;

use common::{payload, sha256, wait_for, TempDir};
use downpour_core::credentials::{SystemVault, Vault};
use downpour_core::model::{DownloadSpec, DownloadStatus, EngineEvent, StartMode};
use downpour_core::settings::Settings;
use downpour_core::store::Store;
use downpour_core::Engine;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const COOKIE: &str = "session=Zq8v-cookie-that-must-not-leak";
const BEARER: &str = "Bearer tok-that-must-not-leak-41f";

/// The real platform protection where there is one. Elsewhere a stand-in that
/// at least transforms the bytes, so the assertions on the file still mean
/// something.
fn vault() -> Arc<dyn Vault> {
    if cfg!(windows) {
        Arc::new(SystemVault)
    } else {
        Arc::new(Xor)
    }
}

struct Xor;
impl Vault for Xor {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.iter().map(|b| b ^ 0xa5).collect())
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        Ok(sealed.iter().map(|b| b ^ 0xa5).collect())
    }
}

fn session() -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    h.insert("Cookie".to_string(), COOKIE.to_string());
    h.insert("Authorization".to_string(), BEARER.to_string());
    h.insert(
        "Referer".to_string(),
        "https://site.example/files".to_string(),
    );
    h
}

fn spec(url: &str, dir: &Path, mode: StartMode) -> DownloadSpec {
    DownloadSpec {
        media: None,
        url: url.to_string(),
        headers: session().into(),
        filename: Some("gated.bin".to_string()),
        dest_dir: dir.to_path_buf(),
        connections: Some(2),
        category: None,
        start_mode: mode,
        checksum: None,
        source: Some("extension".into()),
    }
}

fn open_engine(db: &Path, settings: Option<Settings>) -> Engine {
    let store = Store::open_with_vault(db, vault()).unwrap();
    if let Some(s) = settings {
        store.save_settings(&s).unwrap();
    }
    Engine::with_store(store).unwrap()
}

/// Everything SQLite has on disk for `db`: the file and its write-ahead log.
fn bytes_on_disk(db: &Path) -> Vec<u8> {
    let mut all = std::fs::read(db).unwrap_or_default();
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    all.extend(std::fs::read(&wal).unwrap_or_default());
    all
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

/// The raw `headers` and `sealed_headers` columns of one row.
fn raw_row(db: &Path, id: &str) -> (String, Option<Vec<u8>>) {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.query_row(
        "SELECT headers, sealed_headers FROM downloads WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

async fn settle(engine: &Engine, id: &str, status: DownloadStatus, secs: u64) {
    let e = engine.clone();
    let i = id.to_string();
    assert!(
        wait_for(Duration::from_secs(secs), move || {
            e.get(&i).map(|x| x.status) == Some(status)
        })
        .await,
        "never reached {status:?}: {:?}",
        engine.get(id)
    );
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_captured_cookie_never_reaches_the_database_file_in_the_clear() {
    let dir = TempDir::new();
    let db = dir.join("downpour.db");
    let engine = open_engine(&db, None);
    let id = engine
        .add(spec(
            "https://site.example/gated.bin",
            dir.path(),
            StartMode::AddOnly,
        ))
        .unwrap();
    engine.shutdown().await;

    let disk = bytes_on_disk(&db);
    for secret in [COOKIE, BEARER, "Zq8v", "tok-that-must"] {
        assert!(!contains(&disk, secret), "{secret} is on disk in the clear");
    }
    // Kept, though -- sealed -- because this download has not run yet.
    let (headers, sealed) = raw_row(&db, &id);
    assert!(sealed.is_some(), "a resumable download keeps its session");
    assert!(!headers.contains("Cookie") && !headers.contains("Authorization"));
    assert!(
        headers.contains("Referer"),
        "harmless headers stay readable"
    );
}

#[tokio::test]
async fn a_resumable_downloads_session_survives_a_restart_and_still_works() {
    let data = payload(4 * 1024 * 1024);
    let server = common::start(data.clone()).await;
    server.state.require_cookie(COOKIE).await;
    let dir = TempDir::new();
    let db = dir.join("downpour.db");

    let mut settings = Settings::default();
    settings.speed_limit_bps = 1024 * 1024;
    let engine = open_engine(&db, Some(settings));
    let id = engine
        .add(spec(&server.url("/file"), dir.path(), StartMode::Start))
        .unwrap();
    let e = engine.clone();
    let i = id.clone();
    assert!(
        wait_for(Duration::from_secs(20), move || {
            e.get(&i).map(|x| x.downloaded_bytes).unwrap_or(0) > 512 * 1024
        })
        .await,
        "never got going: {:?}",
        engine.get(&id)
    );
    engine.pause(&id).unwrap();
    settle(&engine, &id, DownloadStatus::Paused, 10).await;
    engine.shutdown().await;
    drop(engine);

    // "Restart": a new store and engine over the same file.
    let reopened = Store::open_with_vault(&db, vault()).unwrap();
    let item = reopened
        .load_active()
        .unwrap()
        .into_iter()
        .find(|i| i.id == id)
        .unwrap();
    assert_eq!(item.headers.get("Cookie").map(String::as_str), Some(COOKIE));
    assert_eq!(
        item.headers.get("Authorization").map(String::as_str),
        Some(BEARER)
    );
    let mut settings = Settings::default();
    settings.speed_limit_bps = 0;
    reopened.save_settings(&settings).unwrap();
    let engine = Engine::with_store(reopened).unwrap();

    server.state.reset_counters();
    engine.start(&id).unwrap();
    settle(&engine, &id, DownloadStatus::Completed, 30).await;

    // The server refuses anything without the cookie, so finishing at all
    // proves it was sent; resuming rather than refetching proves the partial
    // file was kept with it.
    assert!(server.state.credentialed_count() > 0);
    assert!(server.state.bytes_served() < data.len(), "it started over");
    let done = engine.get(&id).unwrap();
    assert_eq!(
        sha256(&std::fs::read(done.target_path()).unwrap()),
        sha256(&data)
    );
}

#[tokio::test]
async fn a_completed_download_forgets_the_session_that_fetched_it() {
    let server = common::start(payload(256 * 1024)).await;
    server.state.require_cookie(COOKIE).await;
    let dir = TempDir::new();
    let db = dir.join("downpour.db");
    let engine = open_engine(&db, None);
    let id = engine
        .add(spec(&server.url("/file"), dir.path(), StartMode::Start))
        .unwrap();
    settle(&engine, &id, DownloadStatus::Completed, 20).await;
    engine.shutdown().await;

    let (headers, sealed) = raw_row(&db, &id);
    assert!(
        sealed.is_none(),
        "a finished download still holds a session"
    );
    assert!(!headers.contains("Cookie"));
    assert!(!engine.get(&id).unwrap().headers.contains_key("Cookie"));
    let reloaded = Store::open_with_vault(&db, vault())
        .unwrap()
        .load_active()
        .unwrap();
    assert!(!reloaded[0].headers.contains_key("Cookie"));
    assert_eq!(
        reloaded[0].headers.get("Referer").map(String::as_str),
        Some("https://site.example/files"),
        "what the download was is still on record"
    );
}

#[tokio::test]
async fn a_removed_download_leaves_no_session_in_the_history() {
    let dir = TempDir::new();
    let db = dir.join("downpour.db");
    let engine = open_engine(&db, None);
    let paused = engine
        .add(spec(
            "https://site.example/a.bin",
            dir.path(),
            StartMode::AddOnly,
        ))
        .unwrap();
    let cleared = engine
        .add(spec(
            "https://site.example/b.bin",
            dir.path(),
            StartMode::AddOnly,
        ))
        .unwrap();
    assert!(raw_row(&db, &paused).1.is_some());

    engine.remove(&paused, false).unwrap();
    engine.cancel(&cleared).unwrap();
    engine.clear_finished().unwrap();
    engine.shutdown().await;

    for id in [&paused, &cleared] {
        let (headers, sealed) = raw_row(&db, id);
        assert!(sealed.is_none(), "the history keeps a session for {id}");
        assert!(!headers.contains("Cookie"));
    }
    let history = engine.history().unwrap();
    assert_eq!(history.len(), 2);
    assert!(history.iter().all(|i| !i.headers.has_secrets()));

    // Restoring brings the record back, not the session.
    let restored = engine.restore(&paused).unwrap();
    assert!(!restored.headers.has_secrets());
    assert!(raw_row(&db, &paused).1.is_none());
}

/// The `downloads` table as v1.5.3 left it (schema v2): credentials in the
/// plain `headers` column. A fixture of history; never sync it forward.
const V2_SCHEMA: &str = r#"
    CREATE TABLE downloads (
        id                TEXT PRIMARY KEY,
        url               TEXT NOT NULL,
        final_url         TEXT,
        filename          TEXT NOT NULL,
        user_named        INTEGER NOT NULL DEFAULT 0,
        name_locked       INTEGER NOT NULL DEFAULT 0,
        dest_dir          TEXT NOT NULL,
        headers           TEXT NOT NULL DEFAULT '{}',
        status            TEXT NOT NULL,
        total_bytes       INTEGER,
        downloaded_bytes  INTEGER NOT NULL DEFAULT 0,
        connections       INTEGER NOT NULL DEFAULT 1,
        supports_range    INTEGER NOT NULL DEFAULT 0,
        category          TEXT,
        source            TEXT,
        scheduled         INTEGER NOT NULL DEFAULT 0,
        error             TEXT,
        checksum          TEXT,
        created_at        INTEGER NOT NULL,
        sequence          INTEGER NOT NULL DEFAULT 0,
        started_at        INTEGER,
        completed_at      INTEGER,
        elapsed_ms        INTEGER NOT NULL DEFAULT 0,
        removed_at        INTEGER
    );
    CREATE INDEX idx_downloads_status  ON downloads(status);
    CREATE INDEX idx_downloads_created ON downloads(created_at DESC);
    CREATE INDEX idx_downloads_seq     ON downloads(sequence);
    CREATE INDEX idx_downloads_removed ON downloads(removed_at);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 2;
"#;

fn insert_v2_row(conn: &rusqlite::Connection, id: &str, status: &str, removed_at: Option<i64>) {
    let headers = serde_json::to_string(&session()).unwrap();
    conn.execute(
        "INSERT INTO downloads (id, url, filename, dest_dir, headers, status, created_at, sequence, removed_at)
         VALUES (?1, 'https://site.example/f.bin', ?1, 'C:/dl', ?2, ?3, 1, 1, ?4)",
        rusqlite::params![id, headers, status, removed_at],
    )
    .unwrap();
}

fn v2_database(db: &Path) {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(V2_SCHEMA).unwrap();
    insert_v2_row(&conn, "paused", "paused", None);
    insert_v2_row(&conn, "failed", "failed", None);
    insert_v2_row(&conn, "completed", "completed", None);
    insert_v2_row(&conn, "removed", "paused", Some(5));
    // Plenty of rows so freed pages are a real thing, not an empty file.
    for n in 0..200 {
        insert_v2_row(&conn, &format!("old-{n}"), "completed", None);
    }
}

#[tokio::test]
async fn upgrading_a_1_5_database_seals_or_purges_every_plaintext_session() {
    let dir = TempDir::new();
    let db = dir.join("downpour.db");
    v2_database(&db);
    assert!(
        contains(&bytes_on_disk(&db), COOKIE),
        "the fixture has the leak"
    );

    let store = Store::open_with_vault(&db, vault()).unwrap();
    let active = store.load_active().unwrap();
    let get = |id: &str| active.iter().find(|i| i.id == id).unwrap().clone();

    // Downloads that can still resume keep their session, sealed.
    for id in ["paused", "failed"] {
        let item = get(id);
        assert_eq!(item.headers.get("Cookie").map(String::as_str), Some(COOKIE));
        assert_eq!(
            item.headers.get("Referer").map(String::as_str),
            Some("https://site.example/files")
        );
        assert!(raw_row(&db, id).1.is_some());
    }
    // Finished and removed ones do not.
    assert!(!get("completed").headers.has_secrets());
    assert!(raw_row(&db, "completed").1.is_none());
    let history = store.load_removed().unwrap();
    assert!(!history[0].headers.has_secrets());
    assert!(raw_row(&db, "removed").1.is_none());

    // And no copy is left anywhere in the file or its log.
    drop(store);
    let disk = bytes_on_disk(&db);
    for secret in [COOKIE, BEARER, "Zq8v", "tok-that-must"] {
        assert!(
            !contains(&disk, secret),
            "{secret} survived the migration on disk"
        );
    }
}

#[tokio::test]
async fn a_downgrade_and_upgrade_puts_the_session_away_again() {
    let dir = TempDir::new();
    let db = dir.join("downpour.db");
    v2_database(&db);
    drop(Store::open_with_vault(&db, vault()).unwrap());

    // What v1.5.3 does on its next launch: stamps its own schema version and
    // writes headers back in the clear.
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "UPDATE downloads SET headers = ?1 WHERE id = 'paused'",
            [serde_json::to_string(&session()).unwrap()],
        )
        .unwrap();
    }

    // Must open (no "duplicate column"), and must re-seal.
    let store = Store::open_with_vault(&db, vault()).unwrap();
    let item = store
        .load_active()
        .unwrap()
        .into_iter()
        .find(|i| i.id == "paused")
        .unwrap();
    assert_eq!(item.headers.get("Cookie").map(String::as_str), Some(COOKIE));
    drop(store);
    assert!(!contains(&bytes_on_disk(&db), COOKIE));
}

#[tokio::test]
async fn a_pasted_address_on_another_site_gets_none_of_the_old_session() {
    let dir = TempDir::new();
    let engine = open_engine(&dir.join("downpour.db"), None);
    let id = engine
        .add(spec(
            "https://site.example/a.bin",
            dir.path(),
            StartMode::AddOnly,
        ))
        .unwrap();

    // Same site, new signature: the session is what makes it work.
    engine
        .refresh_address(&id, "https://site.example/a.bin?sig=2", None)
        .unwrap();
    assert!(engine.get(&id).unwrap().headers.has_secrets());

    // A mirror the user pasted is not the site they signed in to.
    engine
        .refresh_address(&id, "https://mirror.example.net/a.bin", None)
        .unwrap();
    let item = engine.get(&id).unwrap();
    assert!(!item.headers.has_secrets(), "{:?}", item.headers);
    assert!(item.headers.contains_key("Referer"));
}

#[tokio::test]
async fn a_session_an_older_version_left_on_a_finished_row_is_cleared() {
    let dir = TempDir::new();
    let db = dir.join("downpour.db");
    v2_database(&db);
    drop(Store::open_with_vault(&db, vault()).unwrap());
    assert!(raw_row(&db, "paused").1.is_some());

    // v1.5.3 finishes the download: it rewrites the status and stamps its own
    // schema version, and never looks at the sealed column.
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "UPDATE downloads SET status = 'completed' WHERE id = 'paused'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE downloads SET removed_at = 9 WHERE id = 'failed'",
            [],
        )
        .unwrap();
    }

    let store = Store::open_with_vault(&db, vault()).unwrap();
    for id in ["paused", "failed"] {
        assert!(raw_row(&db, id).1.is_none(), "{id} kept its session");
    }
    assert!(store
        .load_active()
        .unwrap()
        .iter()
        .all(|i| !i.headers.has_secrets()));
    assert!(store
        .load_removed()
        .unwrap()
        .iter()
        .all(|i| !i.headers.has_secrets()));
}

#[tokio::test]
async fn corrupt_sealed_credentials_load_as_none_rather_than_as_garbage() {
    let dir = TempDir::new();
    let db = dir.join("downpour.db");
    let engine = open_engine(&db, None);
    let id = engine
        .add(spec(
            "https://site.example/a.bin",
            dir.path(),
            StartMode::AddOnly,
        ))
        .unwrap();
    engine.shutdown().await;
    drop(engine);

    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        let (_, sealed) = raw_row(&db, &id);
        let mut sealed = sealed.unwrap();
        let mid = sealed.len() / 2;
        sealed[mid] ^= 0x40;
        conn.execute(
            "UPDATE downloads SET sealed_headers = ?2 WHERE id = ?1",
            rusqlite::params![id, sealed],
        )
        .unwrap();
    }

    let store = Store::open_with_vault(&db, vault()).unwrap();
    let item = store.load_active().unwrap().pop().unwrap();
    assert!(!item.headers.has_secrets(), "{:?}", item.headers);
    // Only the readable headers remain -- nothing invented from the blob.
    assert_eq!(item.headers.keys().collect::<Vec<_>>(), ["Referer"]);

    // Plain rubbish in the column is no different.
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute(
            "UPDATE downloads SET sealed_headers = x'00ff00ff' WHERE id = ?1",
            [&id],
        )
        .unwrap();
    let item = store.load_active().unwrap().pop().unwrap();
    assert!(!item.headers.has_secrets());
}

#[tokio::test]
async fn nothing_the_window_or_a_log_sees_carries_the_session() {
    let dir = TempDir::new();
    let engine = open_engine(&dir.join("downpour.db"), None);
    let mut events = engine.subscribe();
    let id = engine
        .add(spec(
            "https://site.example/a.bin",
            dir.path(),
            StartMode::AddOnly,
        ))
        .unwrap();
    let item = engine.get(&id).unwrap();
    assert!(item.headers.has_secrets(), "the engine itself keeps them");

    // The list as the window receives it, the event that announced it, and the
    // item as a log line or a panic message would print it.
    let event = loop {
        if let Ok(e @ EngineEvent::Added { .. }) = events.try_recv() {
            break e;
        }
    };
    let surfaces = [
        serde_json::to_string(&engine.list()).unwrap(),
        serde_json::to_string(&event).unwrap(),
        format!("{item:?}"),
        format!("{event:?}"),
    ];
    for text in &surfaces {
        for secret in [COOKIE, BEARER, "Zq8v", "tok-that-must"] {
            assert!(!text.contains(secret), "{secret} leaked into: {text}");
        }
    }
    assert!(surfaces[0].contains("site.example/files"));
}
