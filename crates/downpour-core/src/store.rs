//! SQLite persistence for the download list and settings.
//!
//! The queue has to survive a crash, a reboot and a Windows update at 3am
//! mid-window, so it lives in a real database rather than a JSON file rewritten
//! on every tick. Writes are small and infrequent (status transitions, not
//! progress), so a single connection behind a mutex is more than fast enough
//! and avoids a pool's complexity.

use crate::credentials::{self, RequestHeaders, SystemVault, Vault};
use crate::error::{Error, Result};
use crate::model::{DownloadItem, DownloadStatus};
use crate::settings::Settings;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Incremented for every schema change; `migrate` applies each step in order.
const SCHEMA_VERSION: i64 = 4;

/// Every column `row_to_item` reads, in the order it reads them. Shared so the
/// active list and the history list cannot drift apart: they differ only in
/// their `WHERE` clause, and a column added to one but not the other would
/// shift every index in the mapper.
const ITEM_COLUMNS: &str = "id, url, final_url, filename, user_named, name_locked,
     dest_dir, headers, status,
     total_bytes, downloaded_bytes, connections, supports_range,
     category, source, scheduled, error, checksum,
     created_at, sequence, started_at, completed_at, elapsed_ms, removed_at,
     media_page_url, media_format_id, sealed_headers";

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
    /// Seals the request credentials a download keeps (see
    /// [`crate::credentials`]). The `headers` column never holds one.
    vault: Arc<dyn Vault>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Store")
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_vault(path, Arc::new(SystemVault))
    }

    /// Opens a store whose credentials are sealed by `vault` rather than the
    /// operating system's, for the tests.
    pub fn open_with_vault(path: &Path, vault: Arc<dyn Vault>) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| Error::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let conn = Connection::open(path)?;
        Self::over(conn, vault)
    }

    /// In-memory store, used by the test suite.
    pub fn open_in_memory() -> Result<Self> {
        Self::over(Connection::open_in_memory()?, Arc::new(SystemVault))
    }

    fn over(conn: Connection, vault: Arc<dyn Vault>) -> Result<Self> {
        Self::configure(&conn)?;
        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
            vault,
        };
        store.migrate()?;
        store.scrub_if_pending()?;
        Ok(store)
    }

    fn configure(conn: &Connection) -> Result<()> {
        // WAL keeps a reader (the UI listing downloads) from blocking a writer
        // (a worker recording a status change).
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Deleted and overwritten content is zeroed rather than left in free
        // pages, so a credential that was purged or re-sealed does not linger
        // in the file where it used to be.
        conn.pragma_update(None, "secure_delete", "ON")?;
        Ok(())
    }

    /// Applies every schema step the database has not seen yet.
    ///
    /// The whole thing runs in one transaction, version stamp included. Step 1
    /// is idempotent by construction — every statement is `IF NOT EXISTS` — but
    /// `ALTER TABLE ADD COLUMN` is not, so a process killed between applying a
    /// step and stamping `user_version` would leave a database that refuses to
    /// open ever again with "duplicate column name". `user_version` lives in
    /// the file header and rolls back with everything else, so committing the
    /// two together is what makes a half-applied migration impossible.
    fn migrate(&self) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let current: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;

        if current < 1 {
            tx.execute_batch(
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
                    elapsed_ms        INTEGER NOT NULL DEFAULT 0
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

        if current < 2 {
            // Removing a download used to delete its row, which left a user who
            // cleared the list with no record that the downloads had ever
            // existed. The column is added in place rather than by rebuilding
            // the table: this runs against a database holding someone's real
            // queue, and a copy-and-swap risks all of it for a column every
            // existing row is happy to leave empty. NULL means "still in the
            // list", which is exactly what every pre-existing row is.
            add_column(&tx, "removed_at", "INTEGER")?;
            tx.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_downloads_removed ON downloads(removed_at);",
            )?;
        }

        if current < 3 {
            // Where a media download's address came from, so an expired one can
            // be resolved again. Added in place for the same reason as
            // `removed_at`: every existing row is content to leave it empty.
            add_column(&tx, "media_page_url", "TEXT")?;
            add_column(&tx, "media_format_id", "TEXT")?;
        }

        if current < 4 {
            // Request credentials move out of the plain `headers` column. Every
            // row is rewritten: the credentials of a download that can still
            // resume are sealed into the new column, everyone else's -- the
            // finished, the removed -- are dropped, and `headers` keeps only
            // what is harmless to show. All in this transaction, so a crash
            // leaves either the old rows or the new ones, never a mix.
            //
            // This also runs again after a downgrade and upgrade: an older
            // version resets `user_version` to its own and writes credentials
            // in the clear, and coming back here puts them away again.
            add_column(&tx, "sealed_headers", "BLOB")?;
            if seal_plaintext_credentials(&tx, self.vault.as_ref())? > 0 {
                // Rewriting a row leaves its old bytes in the WAL and,
                // without `secure_delete` at the time they were written, in
                // free pages. Recorded inside the transaction so a crash before
                // the scrub runs is caught by the next open.
                tx.execute(
                    "INSERT INTO kv (key, value) VALUES (?1, '1')
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![SCRUB_FLAG],
                )?;
            }
        }

        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(())
    }

    /// Rebuilds the file if a migration left plaintext credentials behind in
    /// it, then empties the write-ahead log, so the only copy left is the
    /// sealed one.
    fn scrub_if_pending(&self) -> Result<()> {
        if !self.flag(SCRUB_FLAG)? {
            return Ok(());
        }
        let conn = self.conn.lock();
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        conn.execute_batch("VACUUM")?;
        conn.execute("DELETE FROM kv WHERE key = ?1", params![SCRUB_FLAG])?;
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    // -- Downloads ---------------------------------------------------------

    /// Writes an item's live state.
    ///
    /// `removed_at` is deliberately absent from both halves of this statement.
    /// It is owned by the removal and restore paths alone, so a progress tick
    /// that lands after the user removed a running download — which is a
    /// narrow but real race, the pump and the UI being different threads —
    /// cannot resurrect the row into the active list. A fresh insert leaves the
    /// column NULL, which is what a new download wants anyway.
    pub fn upsert(&self, item: &DownloadItem) -> Result<()> {
        // Sealed before the lock: the platform call is quick, but SQLite has
        // no reason to wait on it.
        let sealed = if keeps_credentials(item.status) {
            credentials::seal(self.vault.as_ref(), &item.headers)
        } else {
            None
        };
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO downloads (
                id, url, final_url, filename, user_named, name_locked,
                dest_dir, headers, status,
                total_bytes, downloaded_bytes, connections, supports_range,
                category, source, scheduled, error, checksum,
                created_at, sequence, started_at, completed_at, elapsed_ms,
                media_page_url, media_format_id, sealed_headers
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26
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
                elapsed_ms = excluded.elapsed_ms,
                media_page_url = excluded.media_page_url,
                media_format_id = excluded.media_format_id,
                -- A write that raced the download's removal must not put back
                -- the credentials the removal purged.
                sealed_headers = CASE WHEN downloads.removed_at IS NULL
                                      THEN excluded.sealed_headers END
            "#,
            params![
                item.id,
                item.url,
                item.final_url,
                item.filename,
                item.user_named as i64,
                item.name_locked as i64,
                item.dest_dir.to_string_lossy(),
                serde_json::to_string(&item.headers.public())?,
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
                item.elapsed_ms as i64,
                item.media.as_ref().map(|m| m.page_url.as_str()),
                item.media.as_ref().map(|m| m.format_id.as_str()),
                sealed,
            ],
        )?;
        Ok(())
    }

    /// Everything still in the list. Rows the user removed are excluded; they
    /// are reachable through [`Store::load_removed`].
    pub fn load_active(&self) -> Result<Vec<DownloadItem>> {
        self.query_items("WHERE removed_at IS NULL ORDER BY sequence ASC, created_at ASC")
    }

    /// The history: rows the user removed from the list, most recent first.
    pub fn load_removed(&self) -> Result<Vec<DownloadItem>> {
        self.query_items("WHERE removed_at IS NOT NULL ORDER BY removed_at DESC, sequence DESC")
    }

    fn query_items(&self, tail: &str) -> Result<Vec<DownloadItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!("SELECT {ITEM_COLUMNS} FROM downloads {tail}"))?;
        let rows = stmt
            .query_map([], row_to_item)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        drop(conn);

        Ok(rows
            .into_iter()
            .map(|(mut item, sealed)| {
                if let Some(sealed) = sealed {
                    item.headers
                        .extend(credentials::unseal(self.vault.as_ref(), &sealed));
                }
                item
            })
            .collect())
    }

    /// The highest queue position ever handed out, removed rows included.
    ///
    /// Restoring a history entry puts its original `sequence` back, so the
    /// counter has to clear every row in the table and not just the active
    /// ones. Seeding it from the active list alone would let a download added
    /// after a bulk clear collide with a row the user later restores, and the
    /// two would then sort arbitrarily against each other.
    pub fn max_sequence(&self) -> Result<i64> {
        let conn = self.conn.lock();
        let max: Option<i64> =
            conn.query_row("SELECT MAX(sequence) FROM downloads", [], |r| r.get(0))?;
        Ok(max.unwrap_or(0))
    }

    /// Moves one row into the history, stamped with the moment it left the list.
    ///
    /// Its credentials go with it. Removing a download deletes whatever it had
    /// downloaded, so nothing remains that they could resume, and the history
    /// records what the file was, not the session that fetched it.
    ///
    /// A row already in the history is left alone: a stale multi-select or a
    /// second `clear_finished` would otherwise re-stamp it and quietly extend
    /// its retention past the point the user asked for.
    pub fn mark_removed(&self, id: &str, at: i64) -> Result<bool> {
        let n = self.conn.lock().execute(
            "UPDATE downloads SET removed_at = ?2, sealed_headers = NULL
             WHERE id = ?1 AND removed_at IS NULL",
            params![id, at],
        )?;
        Ok(n > 0)
    }

    /// Moves finished rows into the history and returns the ids that went, so
    /// the caller can emit a `Removed` event for each without re-querying.
    pub fn mark_removed_by_status(
        &self,
        statuses: &[DownloadStatus],
        at: i64,
    ) -> Result<Vec<String>> {
        if statuses.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock();
        let placeholders = vec!["?"; statuses.len()].join(",");
        let names: Vec<String> = statuses
            .iter()
            .map(|s| status_str(*s).to_string())
            .collect();

        let sql = format!(
            "SELECT id FROM downloads WHERE removed_at IS NULL AND status IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let ids: Vec<String> = stmt
            .query_map(rusqlite::params_from_iter(names.iter()), |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);

        let sql = format!(
            "UPDATE downloads SET removed_at = ?, sealed_headers = NULL
             WHERE removed_at IS NULL AND status IN ({placeholders})"
        );
        let mut args: Vec<String> = vec![at.to_string()];
        args.extend(names);
        conn.execute(&sql, rusqlite::params_from_iter(args.iter()))?;
        Ok(ids)
    }

    /// Clears the removal stamp, putting the row back in the active list.
    pub fn restore(&self, id: &str) -> Result<bool> {
        let n = self.conn.lock().execute(
            "UPDATE downloads SET removed_at = NULL WHERE id = ?1 AND removed_at IS NOT NULL",
            params![id],
        )?;
        Ok(n > 0)
    }

    /// Deletes a history entry for good.
    ///
    /// Deliberately refuses to touch an active row: "forget" is a history
    /// action, and a caller that passed the wrong id would otherwise delete a
    /// live download out from under the engine's in-memory list, which would
    /// then happily write it back on the next progress tick.
    pub fn forget(&self, id: &str) -> Result<bool> {
        let n = self.conn.lock().execute(
            "DELETE FROM downloads WHERE id = ?1 AND removed_at IS NOT NULL",
            params![id],
        )?;
        Ok(n > 0)
    }

    /// Drops history entries removed before `before` (unix seconds), and
    /// reports how many went.
    ///
    /// Active rows carry a NULL `removed_at`, and no comparison against NULL is
    /// ever true, so they cannot be caught by this no matter what cutoff is
    /// passed.
    pub fn prune_removed(&self, before: i64) -> Result<usize> {
        let n = self.conn.lock().execute(
            "DELETE FROM downloads WHERE removed_at < ?1",
            params![before],
        )?;
        Ok(n)
    }

    // -- Settings ----------------------------------------------------------

    pub fn load_settings(&self) -> Result<Settings> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = 'settings'", [], |r| {
                r.get(0)
            })
            .optional()?;
        drop(conn);

        let had_row = raw.is_some();
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

        // Persist the defaults the first time they are used.
        //
        // `Settings::default()` mints a fresh `rpc_token`. Without writing it
        // down here, a user who never opens Settings gets a brand new token on
        // every launch, and their paired browser extension silently starts
        // failing with 401 after the first restart.
        if !had_row {
            self.save_settings(&settings)?;
        }
        Ok(settings)
    }

    /// Reads a boolean flag from the key-value table.
    pub fn flag(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(raw.as_deref() == Some("1"))
    }

    pub fn set_flag(&self, key: &str, value: bool) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, if value { "1" } else { "0" }],
        )?;
        Ok(())
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

/// Builds an item from a row selected with [`ITEM_COLUMNS`].
///
/// The sealed credentials come back beside it, for the caller to open once the
/// connection's lock is released.
fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<(DownloadItem, Option<Vec<u8>>)> {
    let dest: String = row.get(6)?;
    let headers_raw: String = row.get(7)?;
    let status_raw: String = row.get(8)?;
    // Only what is safe in the clear is read from this column. A credential
    // found here was written by an older version after this one migrated; the
    // next open migrates it again, and until then it is not used.
    let mut headers: RequestHeaders =
        serde_json::from_str::<BTreeMap<String, String>>(&headers_raw)
            .unwrap_or_default()
            .into();
    headers.drop_secrets();
    let item = DownloadItem {
        awaiting_address_until: None,
        address_expired: false,
        id: row.get(0)?,
        url: row.get(1)?,
        final_url: row.get(2)?,
        filename: row.get(3)?,
        user_named: row.get::<_, i64>(4)? != 0,
        name_locked: row.get::<_, i64>(5)? != 0,
        dest_dir: PathBuf::from(dest),
        headers,
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
        elapsed_ms: row.get::<_, i64>(22)? as u64,
        removed_at: row.get(23)?,
        // Both or neither: half a media source cannot resolve anything.
        media: match (
            row.get::<_, Option<String>>(24)?,
            row.get::<_, Option<String>>(25)?,
        ) {
            (Some(page_url), Some(format_id)) => Some(crate::model::MediaSource {
                page_url,
                format_id,
            }),
            _ => None,
        },
    };
    Ok((item, row.get(26)?))
}

/// Whether a download in this state may keep its credentials. A finished one
/// has nothing left to fetch with them.
fn keeps_credentials(status: DownloadStatus) -> bool {
    status != DownloadStatus::Completed
}

/// Records that the file may still hold plaintext credentials from before they
/// were sealed, until [`Store::scrub_if_pending`] rebuilds it.
const SCRUB_FLAG: &str = "scrub_pending";

/// Adds a column unless it is already there. `ADD COLUMN` is not idempotent,
/// and a database that went through an older version after this one comes back
/// with its schema ahead of its `user_version`.
fn add_column(tx: &rusqlite::Transaction<'_>, name: &str, decl: &str) -> Result<()> {
    let exists: bool = tx.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('downloads') WHERE name = ?1",
        params![name],
        |r| r.get::<_, i64>(0).map(|n| n > 0),
    )?;
    if !exists {
        tx.execute_batch(&format!("ALTER TABLE downloads ADD COLUMN {name} {decl};"))?;
    }
    Ok(())
}

/// Moves every credential still in the plain `headers` column out of it: into
/// `sealed_headers` for a download that can still resume, nowhere for one that
/// cannot. Returns how many rows changed.
fn seal_plaintext_credentials(tx: &rusqlite::Transaction<'_>, vault: &dyn Vault) -> Result<usize> {
    type Row = (String, String, String, Option<i64>, Option<Vec<u8>>);
    let rows: Vec<Row> = {
        let mut stmt =
            tx.prepare("SELECT id, headers, status, removed_at, sealed_headers FROM downloads")?;
        let mapped = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        mapped.collect::<std::result::Result<_, _>>()?
    };

    let mut changed = 0;
    for (id, raw, status, removed_at, sealed) in rows {
        let headers: RequestHeaders = match serde_json::from_str::<BTreeMap<String, String>>(&raw) {
            Ok(map) if !map.keys().any(|k| credentials::is_sensitive(k)) => continue,
            Ok(map) => map.into(),
            // Unreadable, so it cannot be split -- and it might hold a
            // credential. It was already being read as no headers at all.
            Err(_) => RequestHeaders::new(),
        };
        let keep = removed_at.is_none() && parse_status(&status).is_some_and(keeps_credentials);
        let resealed = if keep {
            // Anything already sealed is older than what an older version
            // since wrote in the clear; the plaintext wins where they overlap.
            let mut all: RequestHeaders = sealed
                .as_deref()
                .map(|s| credentials::unseal(vault, s))
                .unwrap_or_default()
                .into();
            all.extend(headers.secrets());
            credentials::seal(vault, &all)
        } else {
            None
        };
        tx.execute(
            "UPDATE downloads SET headers = ?2, sealed_headers = ?3 WHERE id = ?1",
            params![id, serde_json::to_string(&headers.public())?, resealed],
        )?;
        changed += 1;
    }
    Ok(changed)
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
// Varying one field off a default is the clearest way to express these
// cases; struct-update syntax would bury the field under test.
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::model::DownloadStatus;

    fn item(id: &str, status: DownloadStatus) -> DownloadItem {
        let mut headers = BTreeMap::new();
        headers.insert("Cookie".into(), "session=abc".into());
        DownloadItem {
            awaiting_address_until: None,
            address_expired: false,
            media: None,
            id: id.into(),
            url: "https://example.com/f.bin".into(),
            final_url: Some("https://cdn.example.com/f.bin".into()),
            filename: "f.bin".into(),
            user_named: false,
            name_locked: true,
            dest_dir: PathBuf::from("D:/dl"),
            headers: headers.into(),
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
            elapsed_ms: 42_000,
            removed_at: None,
        }
    }

    #[test]
    fn round_trips_a_download_including_headers() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Queued)).unwrap();
        let all = s.load_active().unwrap();
        assert_eq!(all.len(), 1);
        let got = &all[0];
        assert_eq!(got.id, "a");
        assert_eq!(got.headers.get("Cookie").unwrap(), "session=abc");
        assert_eq!(got.dest_dir, PathBuf::from("D:/dl"));
        assert!(got.scheduled);
        assert_eq!(got.connections, 4);
        assert_eq!(got.total_bytes, Some(1000));
    }

    fn sealed_of(s: &Store, id: &str) -> Option<Vec<u8>> {
        s.conn
            .lock()
            .query_row(
                "SELECT sealed_headers FROM downloads WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn a_completed_row_is_never_written_with_its_session() {
        // The engine drops the session on completion before it persists; this
        // is the store refusing to keep one even if handed it.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Paused)).unwrap();
        assert!(sealed_of(&s, "a").is_some());
        s.upsert(&item("a", DownloadStatus::Completed)).unwrap();
        assert!(sealed_of(&s, "a").is_none());
        assert!(!s.load_active().unwrap()[0].headers.has_secrets());
    }

    #[test]
    fn a_write_racing_a_removal_does_not_restore_the_session() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Running)).unwrap();
        assert!(s.mark_removed("a", 100).unwrap());
        // A progress write that had already read the item before it was
        // removed lands afterwards.
        s.upsert(&item("a", DownloadStatus::Running)).unwrap();
        assert!(sealed_of(&s, "a").is_none());
        assert!(!s.load_removed().unwrap()[0].headers.has_secrets());
    }

    #[test]
    fn plaintext_planted_in_the_sealed_column_is_not_accepted() {
        // Well-formed credential JSON, but not sealed by this user: whoever
        // wrote it could not have, so it is not trusted as headers.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Paused)).unwrap();
        s.conn
            .lock()
            .execute(
                "UPDATE downloads SET sealed_headers = ?1 WHERE id = 'a'",
                params![br#"{"Cookie":"planted=1"}"#.to_vec()],
            )
            .unwrap();
        let got = s.load_active().unwrap();
        assert!(!got[0].headers.has_secrets(), "{:?}", got[0].headers);
    }

    #[test]
    fn upsert_updates_rather_than_duplicating() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Queued)).unwrap();
        let mut updated = item("a", DownloadStatus::Completed);
        updated.downloaded_bytes = 1000;
        s.upsert(&updated).unwrap();

        let all = s.load_active().unwrap();
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
        let all = s.load_active().unwrap();
        assert!(all.iter().all(|i| i.status == DownloadStatus::Paused));
    }

    #[test]
    fn terminal_statuses_survive_a_reload() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Completed)).unwrap();
        s.upsert(&item("b", DownloadStatus::Failed)).unwrap();
        s.upsert(&item("c", DownloadStatus::Idle)).unwrap();
        let all = s.load_active().unwrap();
        let by_id = |id: &str| all.iter().find(|i| i.id == id).unwrap().status;
        assert_eq!(by_id("a"), DownloadStatus::Completed);
        assert_eq!(by_id("b"), DownloadStatus::Failed);
        assert_eq!(by_id("c"), DownloadStatus::Idle);
    }

    #[test]
    fn marking_removed_hides_a_row_without_deleting_it() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Queued)).unwrap();
        s.upsert(&item("b", DownloadStatus::Queued)).unwrap();
        assert!(s.mark_removed("a", 1_700_000_500).unwrap());

        let active = s.load_active().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "b");

        let history = s.load_removed().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, "a");
        assert_eq!(history[0].removed_at, Some(1_700_000_500));
    }

    #[test]
    fn a_second_removal_does_not_restamp_the_first() {
        // Re-stamping would silently extend retention every time a stale
        // multi-select or a repeated "clear finished" swept the same row.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Completed)).unwrap();
        assert!(s.mark_removed("a", 1_000).unwrap());
        assert!(!s.mark_removed("a", 9_000).unwrap());
        assert_eq!(s.load_removed().unwrap()[0].removed_at, Some(1_000));
    }

    #[test]
    fn a_progress_write_cannot_resurrect_a_removed_row() {
        // The pump persists from its own copy of the item, which still says
        // "in the list". If upsert wrote removed_at, a tick landing just after
        // the user removed a running download would put it straight back.
        let s = Store::open_in_memory().unwrap();
        let mut live = item("a", DownloadStatus::Running);
        s.upsert(&live).unwrap();
        s.mark_removed("a", 1_000).unwrap();

        live.downloaded_bytes = 999;
        s.upsert(&live).unwrap();

        assert!(s.load_active().unwrap().is_empty());
        assert_eq!(s.load_removed().unwrap()[0].downloaded_bytes, 999);
    }

    #[test]
    fn restore_puts_a_row_back_and_forget_only_touches_history() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Queued)).unwrap();

        assert!(!s.forget("a").unwrap(), "an active row is not forgettable");
        assert_eq!(s.load_active().unwrap().len(), 1);

        s.mark_removed("a", 1_000).unwrap();
        assert!(s.restore("a").unwrap());
        assert_eq!(s.load_active().unwrap()[0].removed_at, None);
        assert!(s.load_removed().unwrap().is_empty());

        s.mark_removed("a", 1_000).unwrap();
        assert!(s.forget("a").unwrap());
        assert!(s.load_active().unwrap().is_empty());
        assert!(s.load_removed().unwrap().is_empty());
    }

    #[test]
    fn pruning_cannot_reach_rows_that_are_still_in_the_list() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("live", DownloadStatus::Running)).unwrap();
        s.upsert(&item("old", DownloadStatus::Completed)).unwrap();
        s.mark_removed("old", 1_000).unwrap();

        assert_eq!(s.prune_removed(i64::MAX).unwrap(), 1);
        assert_eq!(s.load_active().unwrap().len(), 1);
    }

    #[test]
    fn the_sequence_counter_clears_removed_rows_too() {
        let s = Store::open_in_memory().unwrap();
        let mut high = item("a", DownloadStatus::Completed);
        high.sequence = 41;
        s.upsert(&high).unwrap();
        s.mark_removed("a", 1_000).unwrap();
        assert_eq!(
            s.max_sequence().unwrap(),
            41,
            "a restored row would collide with whatever was added after it"
        );
    }

    #[test]
    fn mark_removed_by_status_clears_finished_and_reports_ids() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("done1", DownloadStatus::Completed)).unwrap();
        s.upsert(&item("done2", DownloadStatus::Completed)).unwrap();
        s.upsert(&item("live", DownloadStatus::Queued)).unwrap();

        let mut removed = s
            .mark_removed_by_status(&[DownloadStatus::Completed], 1_000)
            .unwrap();
        removed.sort();
        assert_eq!(removed, vec!["done1", "done2"]);
        assert_eq!(s.load_active().unwrap().len(), 1);
        assert_eq!(s.load_removed().unwrap().len(), 2);

        // A second sweep finds nothing left to move, and leaves the original
        // stamps alone.
        assert!(s
            .mark_removed_by_status(&[DownloadStatus::Completed], 9_000)
            .unwrap()
            .is_empty());
        assert!(s
            .load_removed()
            .unwrap()
            .iter()
            .all(|i| i.removed_at == Some(1_000)));
    }

    #[test]
    fn mark_removed_by_status_with_no_statuses_is_a_no_op() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&item("a", DownloadStatus::Completed)).unwrap();
        assert!(s.mark_removed_by_status(&[], 1_000).unwrap().is_empty());
        assert_eq!(s.load_active().unwrap().len(), 1);
    }

    #[test]
    fn the_first_load_writes_the_defaults_so_the_rpc_token_is_stable() {
        let s = Store::open_in_memory().unwrap();
        let first = s.load_settings().unwrap();
        let second = s.load_settings().unwrap();
        assert_eq!(
            first.rpc_token, second.rpc_token,
            "a token that changes between loads unpairs the browser extension"
        );
        assert_eq!(first.rpc_token.len(), 64);
    }

    #[test]
    fn a_regenerated_token_survives_a_reload() {
        let dir = std::env::temp_dir().join(format!("dp-tok-{}", uuid::Uuid::new_v4()));
        let path = dir.join("downpour.db");
        let store = Store::open(&path).unwrap();
        let mut settings = store.load_settings().unwrap();
        let original = settings.rpc_token.clone();
        settings.rpc_token = crate::settings::generate_token();
        let replaced = settings.rpc_token.clone();
        store.save_settings(&settings).unwrap();
        drop(store);

        let reopened = Store::open(&path).unwrap();
        let back = reopened.load_settings().unwrap();
        assert_eq!(back.rpc_token, replaced);
        assert_ne!(back.rpc_token, original);
        drop(reopened);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flags_default_to_false_and_persist() {
        let s = Store::open_in_memory().unwrap();
        assert!(!s.flag("first_run_done").unwrap());
        s.set_flag("first_run_done", true).unwrap();
        assert!(s.flag("first_run_done").unwrap());
        s.set_flag("first_run_done", false).unwrap();
        assert!(!s.flag("first_run_done").unwrap());
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
            .execute(
                "INSERT INTO kv (key, value) VALUES ('settings', 'not json')",
                [],
            )
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
                params![r#"{"maxConcurrentDownloads": 0, "rpcPort": 1}"#],
            )
            .unwrap();
        let back = s.load_settings().unwrap();
        assert_eq!(back.max_concurrent_downloads, 1);
        assert_eq!(back.rpc_port, 47_113);
        // A settings blob written before a field existed must pick up that
        // field's real default, not its type's. Retention reading back as `0`
        // here would mean "keep forever" on every existing install, which looks
        // exactly like working software and prunes nothing for anyone.
        assert_eq!(back.history_retention_days, 90);
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
        let all = s.load_active().unwrap();
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
