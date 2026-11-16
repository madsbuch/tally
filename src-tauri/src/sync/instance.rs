//! Noticing a database that isn't where it was written.
//!
//! Sync knows a device by its id, and trusts that device's history to only
//! move forward: what a peer has pulled from it stays pulled, its version
//! counters only grow. A copy of the database put back later — restored from
//! a backup, one of the computer's snapshots copied over, the file carried to
//! another machine — breaks that: same id, older history. Its new writes
//! would never be pulled, and what it lost would never be sent back.
//!
//! So each copy carries a random marker (`sync_state.instance`), mirrored in
//! a file beside the database. When the two disagree — or the file is
//! missing — this database was written somewhere else, and it takes a new
//! device id before anything is written: to the vault it's a new device that
//! happens to hold the old one's data, and syncs from scratch. Copies the
//! app makes itself (snapshots, exports, the pre-migration backup) are
//! marked as copies, so putting one back is caught too.
//!
//! The vault still recognises it by its key (see `session::check_peer`).

use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

fn sidecar(db: &Path) -> PathBuf {
    let mut p = db.as_os_str().to_owned();
    p.push(".instance");
    PathBuf::from(p)
}

/// What [`check`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum Check {
    /// No sync state yet (an older schema): nothing to do.
    NotTracked,
    /// The database is where it was written.
    Same,
    /// First check of this database: marked as this copy.
    Marked,
    /// A copy from elsewhere: it now has a new device id.
    Rotated { old_id: String, new_id: String },
}

/// Compares the database's marker with the file beside it, and gives the
/// database a new device id if it was written elsewhere. Run before anything
/// is written to it.
pub async fn check(pool: &SqlitePool, db_path: &Path) -> Result<Check, String> {
    let tracked: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'sync_state')")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if !tracked {
        return Ok(Check::NotTracked);
    }
    let (device_id, instance): (String, Option<String>) =
        sqlx::query_as("SELECT device_id, instance FROM sync_state WHERE id = 1")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let file = std::fs::read_to_string(sidecar(db_path)).ok().map(|s| s.trim().to_string());
    match (&instance, &file) {
        (Some(i), Some(f)) if i == f => Ok(Check::Same),
        (None, _) => {
            // Never checked: a database fresh from migration 0039, which also
            // gave it a fresh device id. Mark it as this copy.
            let marker = super::new_uuid();
            sqlx::query("UPDATE sync_state SET instance = ? WHERE id = 1")
                .bind(&marker)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            std::fs::write(sidecar(db_path), &marker).map_err(|e| e.to_string())?;
            Ok(Check::Marked)
        }
        _ => {
            let new_id = rotate(pool).await?;
            let marker: String = sqlx::query_scalar("SELECT instance FROM sync_state WHERE id = 1")
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            std::fs::write(sidecar(db_path), marker).map_err(|e| e.to_string())?;
            Ok(Check::Rotated { old_id: device_id, new_id })
        }
    }
}

/// Gives this database a new device id (and marker), keeping its data and
/// key. The new id is added to the vault's device list as an ordinary change
/// that syncs; the old entry stays — if the original is still in use
/// somewhere (a folder copied to a second computer), it must stay listed.
/// Returns the new id.
pub async fn rotate(pool: &SqlitePool) -> Result<String, String> {
    let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
    // The write lock up front: a writer slipping in between the read and the
    // update can't make the rotation fail half-way.
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await.map_err(|e| e.to_string())?;
    let result = async {
        let (old_id, vault): (String, Option<String>) =
            sqlx::query_as("SELECT device_id, vault_id FROM sync_state WHERE id = 1")
                .fetch_one(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
        let new_id = super::new_uuid();
        sqlx::query("UPDATE sync_state SET device_id = ?, instance = ? WHERE id = 1")
            .bind(&new_id)
            .bind(super::new_uuid())
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        if vault.is_some() {
            // Recorded by the triggers under the new id.
            sqlx::query(
                "INSERT INTO vault_devices (id, name, public_key, platform, added_at)
                 SELECT ?, name, public_key, platform, ? FROM vault_devices WHERE id = ?",
            )
            .bind(&new_id)
            .bind(super::now_iso())
            .bind(&old_id)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok::<_, String>(new_id)
    }
    .await;
    match result {
        Ok(id) => {
            sqlx::query("COMMIT").execute(&mut *conn).await.map_err(|e| e.to_string())?;
            Ok(id)
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(e)
        }
    }
}

/// Marks a copy the app made of its database (snapshot, export, backup) as a
/// copy, so a copy put back in place is noticed by [`check`].
pub async fn mark_copy(path: &Path) -> Result<(), String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(path))
        .await
        .map_err(|e| e.to_string())?;
    let tracked: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'sync_state')")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;
    if tracked {
        sqlx::query("UPDATE sync_state SET instance = 'copy:' || ? WHERE id = 1")
            .bind(super::new_uuid())
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    pool.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photos::tests::{migrated_db, Scratch};

    #[tokio::test]
    async fn a_database_in_place_keeps_its_id() {
        let dir = Scratch::new();
        let pool = migrated_db(&dir).await;
        let path = dir.0.join("tally.db");
        let id = crate::sync::engine::local_state(&pool).await.unwrap().device_id;
        assert_eq!(check(&pool, &path).await.unwrap(), Check::Marked);
        assert_eq!(check(&pool, &path).await.unwrap(), Check::Same);
        assert_eq!(check(&pool, &path).await.unwrap(), Check::Same);
        assert_eq!(crate::sync::engine::local_state(&pool).await.unwrap().device_id, id);
    }

    #[tokio::test]
    async fn a_copy_elsewhere_takes_a_new_id() {
        let dir = Scratch::new();
        let pool = migrated_db(&dir).await;
        let path = dir.0.join("tally.db");
        check(&pool, &path).await.unwrap();
        let id = crate::sync::engine::local_state(&pool).await.unwrap().device_id;
        // Carried to another folder (no file beside it there).
        let other = Scratch::new();
        let copy = other.0.join("tally.db");
        sqlx::query(&format!("VACUUM INTO '{}'", copy.display())).execute(&pool).await.unwrap();
        let copied = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&copy))
            .await
            .unwrap();
        match check(&copied, &copy).await.unwrap() {
            Check::Rotated { old_id, new_id } => {
                assert_eq!(old_id, id);
                assert_ne!(new_id, id);
            }
            other => panic!("{other:?}"),
        }
        // And from then on it's itself.
        assert_eq!(check(&copied, &copy).await.unwrap(), Check::Same);
    }

    #[tokio::test]
    async fn a_snapshot_put_back_is_noticed() {
        let dir = Scratch::new();
        let pool = migrated_db(&dir).await;
        let path = dir.0.join("tally.db");
        check(&pool, &path).await.unwrap();
        let snap = dir.0.join("snapshot.db");
        sqlx::query(&format!("VACUUM INTO '{}'", snap.display())).execute(&pool).await.unwrap();
        mark_copy(&snap).await.unwrap();
        // Put back in place: same folder, same file beside it — but marked a copy.
        let restored = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&snap))
            .await
            .unwrap();
        assert!(matches!(check(&restored, &path).await.unwrap(), Check::Rotated { .. }));
    }
}
