//! A sync run with the app closed: Android's background worker calls in here
//! through JNI (`SyncNative.syncNow`, see the sync-background plugin). It
//! opens the database itself — there's no app around to borrow a connection
//! from — and syncs with whichever devices of the vault answer.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::time::Duration;

/// One round against the database at `db_path`, given at most `budget`.
/// Returns a line for the log.
pub async fn run_once(db_path: &str, budget: Duration) -> String {
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(15));
    let pool = match SqlitePoolOptions::new().max_connections(2).connect_with(opts).await {
        Ok(p) => p,
        Err(e) => return format!("couldn't open the database: {e}"),
    };
    // Only a database the app has already migrated: the schema must be the
    // one both sides of a sync agree on, and the app is what migrates it.
    let migrated: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'sync_state')")
        .fetch_one(&pool)
        .await
        .unwrap_or(false);
    let summary = if !migrated {
        "the app hasn't opened its database since updating".to_string()
    } else if let Err(e) = super::instance::check(&pool, std::path::Path::new(db_path)).await {
        format!("couldn't check the database: {e}")
    } else {
        match tokio::time::timeout(budget, super::service::sync_round(&pool)).await {
            Err(_) => "ran out of time; carries on next run".to_string(),
            Ok(round) => {
                let synced: Vec<String> = round
                    .outcomes
                    .iter()
                    .map(|o| format!("{} ({} in, {})", o.peer_name, o.received.applied, if o.complete { "complete" } else { "incomplete" }))
                    .collect();
                match (synced.is_empty(), round.errors.first()) {
                    (_, Some(e)) => format!("error: {e}"),
                    (true, None) => "no device of the vault around".to_string(),
                    (false, None) => format!("synced with {}", synced.join(", ")),
                }
            }
        }
    };
    pool.close().await;
    summary
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_madsbuch_tally_syncbg_SyncNative_syncNow<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    db_path: jni::objects::JString<'local>,
) -> jni::sys::jstring {
    let path: String = match env.get_string(&db_path) {
        Ok(s) => s.into(),
        Err(_) => return std::ptr::null_mut(),
    };
    // WorkManager gives a worker ten minutes; leave room to close cleanly.
    let summary = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => rt.block_on(run_once(&path, Duration::from_secs(8 * 60))),
        Err(e) => format!("couldn't start: {e}"),
    };
    env.new_string(summary).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::session;
    use crate::sync::tests::{device, exec};

    #[tokio::test]
    async fn a_background_run_syncs_with_a_device_that_answers() {
        // The "computer": a vault, listening, answering discovery on a test port.
        let host = device().await;
        let slot: session::PairingSlot = Default::default();
        let (port, _) = session::listen(host.pool.clone(), slot.clone(), "127.0.0.1", |_| {}).await.unwrap();
        let offer = session::offer(&host.pool, &slot, vec![format!("127.0.0.1:{port}")]).await.unwrap();

        // The "phone" joins, then writes with the app "closed".
        let phone_dir = crate::photos::tests::Scratch::new();
        let phone = crate::photos::tests::migrated_db(&phone_dir).await;
        session::join(&phone, &offer, false).await.unwrap();
        exec(&phone, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('bg', 'now', 'Snack', '{}')").await;
        phone.close().await;

        // Discovery may not answer on this machine (no broadcast); the last
        // known address from pairing is enough.
        let path = phone_dir.0.join("tally.db");
        let summary = run_once(path.to_str().unwrap(), Duration::from_secs(30)).await;
        assert!(summary.starts_with("synced with"), "{summary}");
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM food_entries WHERE id = 'bg'").fetch_one(&host.pool).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn a_database_from_before_sync_is_left_alone() {
        let dir = crate::photos::tests::Scratch::new();
        let path = dir.0.join("old.db");
        let pool = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true))
            .await
            .unwrap();
        sqlx::query("CREATE TABLE food_entries (id INTEGER PRIMARY KEY)").execute(&pool).await.unwrap();
        pool.close().await;
        let summary = run_once(path.to_str().unwrap(), Duration::from_secs(5)).await;
        assert!(summary.contains("hasn't opened"), "{summary}");
    }
}
