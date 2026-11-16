//! Regression tests from an adversarial review of sync. Each one reproduced a
//! real bug (data loss, divergence, a removed device coming back) against the
//! first version, and guards the fix now.

use super::engine;
use super::tests::{device, dump, exec};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

async fn count(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

/// Both directions, then orphan cleanup on both sides — what one session does.
async fn session(a: &SqlitePool, b: &SqlitePool) {
    engine::pull_all(a, b, 500, 4 << 20).await.unwrap();
    engine::pull_all(b, a, 500, 4 << 20).await.unwrap();
    engine::remove_orphans(a).await.unwrap();
    engine::remove_orphans(b).await.unwrap();
}

async fn settle(devices: &[&SqlitePool]) {
    for _ in 0..6 {
        for (i, a) in devices.iter().enumerate() {
            for (j, b) in devices.iter().enumerate() {
                if i != j {
                    session(a, b).await;
                }
            }
        }
    }
}

/// One pull of a single one-row batch: a connection that dropped after it.
async fn pull_one_row(into: &SqlitePool, from: &SqlitePool) {
    let into_id = engine::local_state(into).await.unwrap().device_id;
    let from_id = engine::local_state(from).await.unwrap().device_id;
    let since = engine::pulled_from(into, &from_id).await.unwrap();
    let batch = engine::export(from, since, &into_id, 1, 1 << 20).await.unwrap();
    engine::apply(into, &from_id, &batch).await.unwrap();
}

// ---------------------------------------------------------------------------
// 1. remove_orphans after an interrupted pull deletes a child everywhere
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_interrupted_pull_then_a_session_with_a_third_device_keeps_the_file() {
    let (a, b, c) = (device().await, device().await, device().await);
    settle(&[&a.pool, &b.pool, &c.pool]).await;

    // On A: a document, its file, then the document is renamed — so the
    // parent's newest version sits *after* the child in A's log.
    exec(&a.pool, "INSERT INTO documents (id, created_at, title) VALUES ('d', 'now', 'Labs')").await;
    crate::document_files::save(&a.pool, "d", "labs.pdf", "application/pdf", b"%PDF-1.7 blood work").await.unwrap();
    exec(&a.pool, "UPDATE documents SET title = 'Labs, November' WHERE id = 'd'").await;

    // B pulls one batch from A (the file, not the document) and the
    // connection drops: no orphan cleanup, the session failed.
    pull_one_row(&b.pool, &a.pool).await;
    assert_eq!(count(&b.pool, "SELECT count(*) FROM document_files").await, 1);
    assert_eq!(count(&b.pool, "SELECT count(*) FROM documents WHERE id = 'd'").await, 0);

    // B then completes an ordinary session with C, which ends in remove_orphans.
    session(&b.pool, &c.pool).await;

    // Everyone syncs with everyone until nothing moves.
    settle(&[&a.pool, &b.pool, &c.pool]).await;

    // The document survives everywhere — and so must its file.
    assert_eq!(count(&a.pool, "SELECT count(*) FROM documents WHERE id = 'd'").await, 1);
    assert_eq!(
        count(&a.pool, "SELECT count(*) FROM document_files WHERE document_id = 'd'").await,
        1,
        "the PDF was deleted on the device that created it"
    );
}

// ---------------------------------------------------------------------------
// 2. A device restored from an older copy of its own database
// ---------------------------------------------------------------------------

/// A copy of `d`'s database as it is now (what Android Auto Backup, a
/// device-to-device transfer, or putting back one of the computer's daily
/// snapshots hands back later).
async fn copy_of(d: &SqlitePool, dir: &crate::photos::tests::Scratch) -> std::path::PathBuf {
    let path = dir.0.join("copy.db");
    sqlx::query(&format!("VACUUM INTO '{}'", path.display())).execute(d).await.unwrap();
    path
}

#[tokio::test]
async fn a_device_restored_from_an_older_copy_takes_a_new_id_and_catches_up() {
    let (a, b) = (device().await, device().await);
    // As the app does every time it opens its database.
    super::instance::check(&b.pool, &b._dir.0.join("tally.db")).await.unwrap();
    exec(&b.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('old', 'now', 'Oats', '{}')").await;
    session(&a.pool, &b.pool).await;

    let dir = crate::photos::tests::Scratch::new();
    let backup = copy_of(&b.pool, &dir).await;

    // After the backup, B keeps logging and syncing as usual.
    for i in 0..5 {
        exec(&b.pool, &format!("INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('after-backup-{i}', 'now', 'x', '{{}}')")).await;
    }
    session(&a.pool, &b.pool).await;

    // The phone is reset and restored from the backup: same device id, same
    // key, older seq. The person logs three meals on it.
    let restored = SqlitePoolOptions::new()
        .connect_with(SqliteConnectOptions::new().filename(&backup))
        .await
        .unwrap();
    let b2 = restored;
    assert_eq!(engine::local_state(&b2).await.unwrap().device_id, b.id);
    // What the app does on opening a database, before anything is written:
    // this one wasn't written here, so it takes a new id.
    assert!(matches!(
        super::instance::check(&b2, &backup).await.unwrap(),
        super::instance::Check::Rotated { .. }
    ));
    for i in 0..3 {
        exec(&b2, &format!("INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('new-{i}', 'now', 'Eggs', '{{}}')")).await;
    }
    settle(&[&a.pool, &b2]).await;

    let on_a = count(&a.pool, "SELECT count(*) FROM food_entries WHERE id LIKE 'new-%'").await;
    let on_b = count(&b2, "SELECT count(*) FROM food_entries WHERE id LIKE 'after-backup-%'").await;
    let (da, db) = (engine::digest(&a.pool).await.unwrap(), engine::digest(&b2).await.unwrap());
    eprintln!("new meals on the computer: {on_a}/3; post-backup meals back on the phone: {on_b}/5; differing tables: {:?}",
        engine::digest_differences(&da, &db));
    assert_eq!(on_a, 3, "meals logged on the restored phone never reach the computer");
    assert_eq!(on_b, 5, "the computer never sends the restored phone what it had lost");
}

// ---------------------------------------------------------------------------
// 3. A split chat's title depends on each device's copy of the device list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_chat_split_on_two_devices_while_a_device_renames_itself_converges() {
    let (a, b, c) = (device().await, device().await, device().await);
    for (d, name) in [(&a, "Phone"), (&b, "Mac"), (&c, "Tablet")] {
        exec(&d.pool, &format!("INSERT INTO vault_devices (id, name, public_key, platform, added_at) VALUES ('{}', '{name}', '00', 'x', 'now')", d.id)).await;
    }
    exec(&a.pool, "INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('c', 'now', 'now', 'Plan', '[\"q1\"]')").await;
    settle(&[&a.pool, &b.pool, &c.pool]).await;

    // B continues the chat, then A does (later: A's wins, B's is split off),
    // then B renames itself on the Sync page.
    exec(&b.pool, "UPDATE chats SET messages = '[\"q1\",\"mac\"]' WHERE id = 'c'").await;
    std::thread::sleep(std::time::Duration::from_millis(5));
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"phone\"]' WHERE id = 'c'").await;
    super::service::set_name(&b.pool, "Mac Studio").await.unwrap_or(()); // device_settings + vault_devices

    // C hears from B first (B's edit, then the rename), then from A: it splits
    // the chat naming B "Mac Studio". A hears from B: splits it at B's edit,
    // before the rename arrives — "Mac".
    engine::pull_all(&c.pool, &b.pool, 500, 1 << 20).await.unwrap();
    engine::pull_all(&c.pool, &a.pool, 500, 1 << 20).await.unwrap();
    engine::pull_all(&a.pool, &b.pool, 500, 1 << 20).await.unwrap();
    settle(&[&a.pool, &b.pool, &c.pool]).await;

    let titles = |p: SqlitePool| async move {
        sqlx::query_scalar::<_, String>("SELECT title FROM chats ORDER BY id").fetch_all(&p).await.unwrap()
    };
    let (ta, tc) = (titles(a.pool.clone()).await, titles(c.pool.clone()).await);
    eprintln!("A: {ta:?}\nC: {tc:?}");
    let (da, dc) = (engine::digest(&a.pool).await.unwrap(), engine::digest(&c.pool).await.unwrap());
    assert_eq!(engine::digest_differences(&da, &dc), Vec::<String>::new(), "devices never converge");
    assert_eq!(dump(&a.pool).await.get("chats"), dump(&c.pool).await.get("chats"));
}

// ---------------------------------------------------------------------------
// 4. A removed device puts itself back
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_removed_device_stays_removed_even_if_its_entry_comes_back() {
    let (a, b, x) = (device().await, device().await, device().await);
    for (d, name, key) in [(&a, "Mac", "aa"), (&b, "Tablet", "bb"), (&x, "Lost phone", "cc")] {
        exec(&d.pool, &format!("INSERT INTO vault_devices (id, name, public_key, platform, added_at) VALUES ('{}', '{name}', '{key}', 'x', 'now')", d.id)).await;
    }
    settle(&[&a.pool, &b.pool, &x.pool]).await;

    // The phone is stolen. On the Mac, the person removes it.
    super::service::remove_device(&a.pool, &x.id).await.unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    // The thief renames the phone, and it reaches the tablet before the
    // removal does (the tablet still lists the phone, so it lets it sync).
    exec(&x.pool, &format!("UPDATE vault_devices SET name = 'whatever' WHERE id = '{}'", x.id)).await;
    session(&b.pool, &x.pool).await;
    // Mac and tablet sync.
    session(&a.pool, &b.pool).await;
    session(&a.pool, &b.pool).await;

    // The entry may come back through an edit made elsewhere, but the key is
    // on the revocation list, which nothing undoes — on both devices — and
    // the vault doesn't count the device any more.
    for d in [&a, &b] {
        assert_eq!(count(&d.pool, "SELECT count(*) FROM vault_revocations WHERE public_key = 'cc'").await, 1);
        let listed: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM vault_devices WHERE public_key NOT IN (SELECT public_key FROM vault_revocations)",
        )
        .fetch_all(&d.pool)
        .await
        .unwrap();
        assert!(!listed.contains(&x.id), "{listed:?}");
    }
}

// ---------------------------------------------------------------------------
// 5. The digest loads every row of a table — every photo blob — at once
// ---------------------------------------------------------------------------

fn peak_rss_mb() -> i64 {
    let s = std::fs::read_to_string("/proc/self/status").unwrap();
    let line = s.lines().find(|l| l.starts_with("VmHWM:")).unwrap();
    line.split_whitespace().nth(1).unwrap().parse::<i64>().unwrap() / 1024
}

#[tokio::test]
#[ignore = "measures the process's peak memory, so run it on its own: cargo test --lib digest_holds -- --ignored"]
async fn the_digest_holds_the_whole_photo_library_in_memory() {
    let a = device().await;
    // 200 photos of 1 MB: a modest library.
    for i in 0..200u32 {
        let bytes: Vec<u8> = (0..1_000_000u32).map(|j| (j.wrapping_mul(i + 7) >> 3) as u8).collect();
        crate::photos::save(&a.pool, &bytes).await.unwrap();
    }
    let before = peak_rss_mb();
    engine::digest(&a.pool).await.unwrap();
    let after = peak_rss_mb();
    eprintln!("peak RSS before digest: {before} MB, after: {after} MB");
    assert!(after - before < 50, "digest grew peak memory by {} MB", after - before);
}

// ---------------------------------------------------------------------------
// 6. An UPDATE that changes nothing is a new version, and wins
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_no_op_reimport_on_one_device_wipes_a_manual_edit_made_on_the_other() {
    let (phone, mac) = (device().await, device().await);
    exec(&mac.pool, "INSERT INTO workouts (id, performed_at, day, tz_offset_min, title, calories_burned, duration_min, cardio, cardio_by_hand, source, external_id)
        VALUES ('w', '2026-11-16T07:00:00.000Z', '2026-11-16', 60, 'Run', 400, 40, 0, 0, 'Garmin', 'garmin:5')").await;
    session(&phone.pool, &mac.pool).await;
    // At the gym (no sync): the person marks the run as cardio by hand.
    exec(&phone.pool, "UPDATE workouts SET cardio = 1, cardio_by_hand = 1 WHERE id = 'w'").await;
    std::thread::sleep(std::time::Duration::from_millis(5));
    // At home, the Mac's hourly Garmin sync re-applies the same activity
    // (workoutUpdatesFor — never touches cardio_by_hand), changing nothing.
    exec(&mac.pool, "UPDATE workouts SET title = 'Run', calories_burned = 400, duration_min = 40 WHERE id = 'w'").await;
    session(&phone.pool, &mac.pool).await;
    let by_hand = count(&phone.pool, "SELECT cardio_by_hand FROM workouts WHERE id = 'w'").await;
    assert_eq!(by_hand, 1, "the manual cardio choice was overwritten by an update that changed nothing");
}
