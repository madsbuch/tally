//! A copy of the database taken just before a migration that rewrites every
//! table (0038, UUID ids; 0041, TypeIDs — each into a file of its own). The migration runs in a transaction and rolls back
//! whole if anything in it fails, but a database is a person's whole history:
//! one more copy, made by the app itself before it touches anything, costs a
//! little disk and buys a way back from anything the migration's tests didn't
//! think of.

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
use std::path::Path;

/// Copies `db` to `backup` if migration `version` hasn't been applied to it
/// yet. True when a copy was made.
///
/// Does nothing for a database that doesn't exist yet (a fresh install has
/// nothing to lose), one already past `version`, or when `backup` is already
/// there (an earlier launch made it, and it's the older copy that matters).
/// `VACUUM INTO` makes a consistent snapshot, including anything still in the
/// write-ahead log, without writing to the database itself.
pub async fn before_migration(db: &Path, version: i64, backup: &Path) -> Result<bool, String> {
    if !db.exists() || backup.exists() {
        return Ok(false);
    }
    let mut conn = SqliteConnectOptions::new()
        .filename(db)
        .read_only(true)
        .connect()
        .await
        .map_err(|e| e.to_string())?;
    let has_ledger: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations')",
    )
    .fetch_one(&mut conn)
    .await
    .map_err(|e| e.to_string())?;
    if !has_ledger {
        conn.close().await.ok();
        return Ok(false);
    }
    let applied: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = ? AND success)")
            .bind(version)
            .fetch_one(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
    if applied {
        conn.close().await.ok();
        return Ok(false);
    }
    // Written beside the backup's final name and renamed into place, so a copy
    // cut short (the app killed mid-way) is never mistaken for a whole one.
    let partial = backup.with_extension("partial");
    let _ = std::fs::remove_file(&partial);
    let target = partial.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{target}'"))
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    conn.close().await.ok();
    std::fs::rename(&partial, backup).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photos::tests::Scratch;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn db_at(path: &Path, versions: &[i64]) {
        let pool = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(path).create_if_missing(true))
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, success BOOLEAN NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        for v in versions {
            sqlx::query("INSERT INTO _sqlx_migrations (version, success) VALUES (?, 1)")
                .bind(v)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("CREATE TABLE food_entries (id INTEGER PRIMARY KEY, title TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO food_entries (title) VALUES ('Oats'), ('Eggs')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    async fn titles(path: &Path) -> Vec<String> {
        let mut conn = SqliteConnectOptions::new().filename(path).connect().await.unwrap();
        sqlx::query_scalar("SELECT title FROM food_entries ORDER BY id")
            .fetch_all(&mut conn)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn copies_a_database_the_migration_has_not_reached() {
        let scratch = Scratch::new();
        let db = scratch.0.join("tally.db");
        let backup = scratch.0.join("tally-before.db");
        db_at(&db, &[37, 38]).await;

        assert!(before_migration(&db, 39, &backup).await.unwrap());
        assert_eq!(titles(&backup).await, ["Oats", "Eggs"]);
        assert!(!scratch.0.join("tally-before.partial").exists());
        // Once made, it's kept as it is.
        assert!(!before_migration(&db, 39, &backup).await.unwrap());
    }

    #[tokio::test]
    async fn leaves_alone_what_has_nothing_to_lose() {
        let scratch = Scratch::new();
        let backup = scratch.0.join("tally-before.db");
        // No database yet: a fresh install.
        assert!(!before_migration(&scratch.0.join("missing.db"), 39, &backup).await.unwrap());
        // Already migrated.
        let db = scratch.0.join("tally.db");
        db_at(&db, &[38, 39]).await;
        assert!(!before_migration(&db, 39, &backup).await.unwrap());
        assert!(!backup.exists());
    }
}
