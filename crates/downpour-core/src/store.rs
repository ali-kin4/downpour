//! SQLite persistence for the download list and settings.
//!
//! The queue has to survive a crash, a reboot and a Windows update at 3am
//! mid-window, so it lives in a real database rather than a JSON file rewritten
//! on every tick. Writes are small and infrequent (status transitions, not
//! progress), so a single connection behind a mutex is more than fast enough
//! and avoids a pool's complexity.

use crate::error::{Error, Result};
use crate::model::{DownloadItem, DownloadStatus};
use crate::settings::Settings;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Incremented for every schema change; `migrate` applies each step in order.
const SCHEMA_VERSION: i64 = 1;

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Store")
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| Error::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let conn = Connection::open(path)?;
        Self::configure(&conn)?;
        let store = Self { conn: Arc::new(Mutex::new(conn)) };
        store.migrate()?;
        Ok(store)
    }

    /// In-memory store, used by the test suite.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure(&conn)?;
        let store = Self { conn: Arc::new(Mutex::new(conn)) };
        store.migrate()?;
        Ok(store)
    }

    fn configure(conn: &Connection) -> Result<()> {
        // WAL keeps a reader (the UI listing downloads) from blocking a writer
        // (a worker recording a status change).
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock();
        let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;

        if current < 1 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS downloads (
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
                    elapsed_secs      INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_downloads_status  ON downloads(status);
                CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_downloads_seq     ON downloads(sequence);

                CREATE TABLE IF NOT EXISTS kv (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                "#,
            )?;
        }

        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    }

    // -- Downloads ---------------------------------------------------------

    pub fn upsert(&self, item: &DownloadItem) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO downloads (
                id, url, final_url, filename, user_named, name_locked,
                dest_dir, headers, status,
                total_bytes, downloaded_bytes, connections, supports_range,
                category, source, scheduled, error, checksum,
                created_at, sequence, started_at, completed_at, elapsed_secs
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
            )
            ON CONFLICT(id) DO UPDATE SET
                url = excluded.url,
                final_url = excluded.final_url,
                filename = excluded.filename,
                user_named = excluded.user_named,
                name_locked = excluded.name_locked,
                dest_dir = excluded.dest_dir,
                headers = excluded.headers,
                status = excluded.status,
                total_bytes = excluded.total_bytes,
                downloaded_bytes = excluded.downloaded_bytes,
                connections = excluded.connections,
                supports_range = excluded.supports_range,
                category = excluded.category,
                source = excluded.source,
                scheduled = excluded.scheduled,
                error = excluded.error,
                checksum = excluded.checksum,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                elapsed_secs = excluded.elapsed_secs
            "#,
            params![
                item.id,
                item.url,
                item.final_url,
                item.filename,
                item.user_named as i64,
                item.name_locked as i64,
                item.dest_dir.to_string_lossy(),
                serde_json::to_string(&item.headers)?,
                status_str(item.status),
                item.total_bytes.map(|v| v as i64),
                item.downloaded_bytes as i64,
                item.connections as i64,
                item.supports_range as i64,
                item.category,
                item.source,
                item.scheduled as i64,
                item.error,
                item.checksum,
                item.created_at,
                item.sequence,
                item.started_at,
                item.completed_at,
                item.elapsed_secs as i64,
            ],
        )?;
        Ok(())
    }

    pub fn load_all(&self) -> Result<Vec<DownloadItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, url, final_url, filename, user_named, name_locked,
                   dest_dir, headers, status,
                   total_bytes, downloaded_bytes, connections, supports_range,
                   category, source, scheduled, error, checksum,
                   created_at, sequence, started_at, completed_at, elapsed_secs
            FROM downloads
            ORDER BY sequence ASC, created_at ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let dest: String = row.get(6)?;
            let headers_raw: String = row.get(7)?;
            let status_raw: String = row.get(8)?;
            Ok(DownloadItem {
                id: row.get(0)?,
                url: row.get(1)?,
                final_url: row.get(2)?,
                filename: row.get(3)?,
                user_named: row.get::<_, i64>(4)? != 0,
                name_locked: row.get::<_, i64>(5)? != 0,
                dest_dir: PathBuf::from(dest),
                headers: serde_json::from_str::<BTreeMap<String, String>>(&headers_raw)
                    .unwrap_or_default(),
                // A status we do not recognise (a downgrade, a hand-edited row)
                // becomes Paused rather than poisoning the whole load.
                status: parse_status(&status_raw).unwrap_or(DownloadStatus::Paused),
                total_bytes: row.get::<_, Option<i64>>(9)?.map(|v| v as u64),
                downloaded_bytes: row.get::<_, i64>(10)? as u64,
                speed_bps: 0,
                eta_secs: None,
                connections: row.get::<_, i64>(11)? as u8,
                supports_range: row.get::<_, i64>(12)? != 0,
                category: row.get(13)?,
                source: row.get(14)?,
                scheduled: row.get::<_, i64>(15)? != 0,
                error: row.get(16)?,
                checksum: row.get(17)?,
                created_at: row.get(18)?,
                sequence: row.get(19)?,
                started_at: row.get(20)?,
                completed_at: row.get(21)?,
                elapsed_secs: row.get::<_, i64>(22)? as u64,
            })
        })?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Removes finished rows and returns the ids that went, so the caller can
    /// emit a `Removed` event for each without re-querying.
    pub fn delete_by_status(&self, statuses: &[DownloadStatus]) -> Result<Vec<String>> {
        if statuses.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock();
        let placeholders = vec!["?"; statuses.len()].join(",");
        let names: Vec<String> = statuses.iter().map(|s| status_str(*s).to_string()).collect();

        let sql = format!("SELECT id FROM downloads WHERE status IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let ids: Vec<String> = stmt
            .query_map(rusqlite::params_from_iter(names.iter()), |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);

        let sql = format!("DELETE FROM downloads WHERE status IN ({placeholders})");
        conn.execute(&sql, rusqlite::params_from_iter(names.iter()))?;
        Ok(ids)
    }

    // -- Settings ----------------------------------------------------------

    pub fn load_settings(&self) -> Result<Settings> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = 'settings'", [], |r| r.get(0))
            .optional()?;
        drop(conn);

        let mut settings = match raw {
            // A settings blob that fails to parse must not stop the app from
            // starting; falling back to defaults is recoverable, refusing to
            // launch is not.
            Some(json) => serde_json::from_str::<Settings>(&json).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "settings were unreadable; using defaults");
                Settings::default()
            }),
            None => Settings::default(),
        };
        settings.normalise();
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        let json = serde_json::to_string(settings)?;
        self.conn.lock().execute(
            "INSERT INTO kv (key, value) VALUES ('settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![json],
        )?;
        Ok(())
    }
}

fn status_str(s: DownloadStatus) -> &'static str {
    match s {
        DownloadStatus::Idle => "idle",
        DownloadStatus::Queued => "queued",
        DownloadStatus::Scheduled => "scheduled",
        DownloadStatus::Probing => "probing",
        DownloadStatus::Running => "running",
        DownloadStatus::Paused => "paused",
        DownloadStatus::Completed => "completed",
        DownloadStatus::Failed => "failed",
        DownloadStatus::Cancelled => "cancelled",
    }
}

fn parse_status(s: &str) -> Option<DownloadStatus> {
    Some(match s {
        "idle" => DownloadStatus::Idle,
        "queued" => DownloadStatus::Queued,
        "scheduled" => DownloadStatus::Scheduled,
        // An app that was killed mid-download left rows saying "running".
        // They are not running now, and presenting them as such would show a
        // progress bar that never moves, so they load back as paused.
        "probing" | "running" | "paused" => DownloadStatus::Paused,
        "completed" => DownloadStatus::Completed,
        "failed" => DownloadStatus::Failed,
        "cancelled" => DownloadStatus::Cancelled,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DownloadStatus;

    fn item(id: &str, status: DownloadStatus) -> DownloadItem {
        let mut headers = BTreeMap::new();
        headers.insert("Cookie".into(), "session=abc".into());
        DownloadItem {
            id: id.into(),
            url: "https://example.com/f.bin".into(),
            final_url: Some("https://cdn.example.com/f.bin".into()),
            filename: "f.bin".into(),
            user_named: false,
            name_locked: true,
            dest_dir: PathBuf::from("D:/dl"),
            headers,
            status,
            total_bytes: Some(1000),
            downloaded_bytes: 250,
            speed_bps: 0,
            eta_secs: None,
            connections: 4,
            supports_range: true,
            category: Some("Archives".into()),
            source: Some("clipboard".into()),
            scheduled: true,
            error: None,
            checksum: None,
            created_at: 1_700_000_000,
            sequence: 0,
            started_at: Some(1_700_000_010),
            completed_at: None,
            elapsed_secs: 42,
        }
    }

    #[test]
    fn round_trips_a_download_including_headers() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Queued)).unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 1);
        let got = &all[0];
        assert_eq!(got.id, "a");
        assert_eq!(got.headers.get("Cookie").unwrap(), "session=abc");
        assert_eq!(got.dest_dir, PathBuf::from("D:/dl"));
        assert!(got.scheduled);
        assert_eq!(got.connections, 4);
        assert_eq!(got.total_bytes, Some(1000));
    }

    #[test]
    fn upsert_updates_rather_than_duplicating() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Queued)).unwrap();
        let mut updated = item("a", DownloadStatus::Completed);
        updated.downloaded_bytes = 1000;
        s.upsert(&updated).unwrap();

        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].status, DownloadStatus::Completed);
        assert_eq!(all[0].downloaded_bytes, 1000);
    }

    #[test]
    fn an_interrupted_running_download_loads_back_as_paused() {
        // Otherwise the UI shows a frozen progress bar for a transfer that
        // died with the process.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Running)).unwrap();
        s.upsert(&item("b", DownloadStatus::Probing)).unwrap();
        let all = s.load_all().unwrap();
        assert!(all.iter().all(|i| i.status == DownloadStatus::Paused));
    }

    #[test]
    fn terminal_statuses_survive_a_reload() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Completed)).unwrap();
        s.upsert(&item("b", DownloadStatus::Failed)).unwrap();
        s.upsert(&item("c", DownloadStatus::Idle)).unwrap();
        let all = s.load_all().unwrap();
        let by_id = |id: &str| all.iter().find(|i| i.id == id).unwrap().status;
        assert_eq!(by_id("a"), DownloadStatus::Completed);
        assert_eq!(by_id("b"), DownloadStatus::Failed);
        assert_eq!(by_id("c"), DownloadStatus::Idle);
    }

    #[test]
    fn delete_removes_one_row() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Queued)).unwrap();
        s.upsert(&item("b", DownloadStatus::Queued)).unwrap();
        s.delete("a").unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "b");
    }

    #[test]
    fn delete_by_status_clears_finished_and_reports_ids() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("done1", DownloadStatus::Completed)).unwrap();
        s.upsert(&item("done2", DownloadStatus::Completed)).unwrap();
        s.upsert(&item("live", DownloadStatus::Queued)).unwrap();

        let mut removed = s.delete_by_status(&[DownloadStatus::Completed]).unwrap();
        removed.sort();
        assert_eq!(removed, vec!["done1", "done2"]);
        assert_eq!(s.load_all().unwrap().len(), 1);
    }

    #[test]
    fn delete_by_status_with_no_statuses_is_a_no_op() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Completed)).unwrap();
        assert!(s.delete_by_status(&[]).unwrap().is_empty());
        assert_eq!(s.load_all().unwrap().len(), 1);
    }

    #[test]
    fn settings_round_trip() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.load_settings().unwrap().max_concurrent_downloads, 3);

        let mut settings = Settings::default();
        settings.max_concurrent_downloads = 1;
        settings.speed_limit_bps = 2_000_000;
        s.save_settings(&settings).unwrap();

        let back = s.load_settings().unwrap();
        assert_eq!(back.max_concurrent_downloads, 1);
        assert_eq!(back.speed_limit_bps, 2_000_000);
    }

    #[test]
    fn unreadable_settings_fall_back_to_defaults_instead_of_failing() {
        let s = Store::open_in_memory().unwrap();
        s.conn
            .lock()
            .execute("INSERT INTO kv (key, value) VALUES ('settings', 'not json')", [])
            .unwrap();
        let back = s.load_settings().unwrap();
        assert_eq!(back.max_concurrent_downloads, 3);
    }

    #[test]
    fn saved_settings_are_normalised_on_load() {
        let s = Store::open_in_memory().unwrap();
        s.conn
            .lock()
            .execute(
                "INSERT INTO kv (key, value) VALUES ('settings', ?1)",
                params![r#"{"max_concurrent_downloads": 0, "rpc_port": 1}"#],
            )
            .unwrap();
        let back = s.load_settings().unwrap();
        assert_eq!(back.max_concurrent_downloads, 1);
        assert_eq!(back.rpc_port, 47_113);
    }

    #[test]
    fn load_order_follows_the_insertion_sequence() {
        let s = Store::open_in_memory().unwrap();
        let mut a = item("a", DownloadStatus::Queued);
        a.created_at = 200;
        a.sequence = 2;
        let mut b = item("b", DownloadStatus::Queued);
        b.created_at = 100;
        b.sequence = 1;
        s.upsert(&a).unwrap();
        s.upsert(&b).unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all[0].id, "b", "oldest first");
        assert_eq!(all[1].id, "a");
    }

    #[test]
    fn opening_a_file_backed_store_creates_missing_directories() {
        let dir = std::env::temp_dir().join(format!("dp-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested").join("downpour.db");
        let s = Store::open(&path).unwrap();
        s.upsert(&item("a", DownloadStatus::Queued)).unwrap();
        assert!(path.exists());
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }
}
