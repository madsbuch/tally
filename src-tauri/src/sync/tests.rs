//! Correctness of the sync engine, on real databases (every app migration
//! applied, triggers and all), several devices in one process.
//!
//! The heart of it is `random_histories_converge`: devices make random edits
//! — the kinds the app makes — and sync in random pairs, with small batches
//! and connections dropped half-way, for many seeds. Afterwards every device
//! must hold exactly the same data and versions, and no chat turn may have
//! been lost except by a deletion that had seen it.

use super::engine::{self, ApplyStats, Batch, Digest};
use crate::photos::tests::{migrated_db, Scratch};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub(crate) struct Device {
    pub(crate) pool: SqlitePool,
    pub(crate) id: String,
    pub(crate) _dir: Scratch,
}

pub(crate) async fn device() -> Device {
    let dir = Scratch::new();
    let pool = migrated_db(&dir).await;
    let id = engine::local_state(&pool).await.unwrap().device_id;
    Device { pool, id, _dir: dir }
}

pub(crate) async fn exec(pool: &SqlitePool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn sync_pair(a: &Device, b: &Device) -> (ApplyStats, ApplyStats) {
    let x = engine::pull_all(&a.pool, &b.pool, 4, 64 * 1024).await.unwrap();
    let y = engine::pull_all(&b.pool, &a.pool, 4, 64 * 1024).await.unwrap();
    (x, y)
}

/// Pulls at most `batches` batches, as a connection that drops would.
async fn pull_some(into: &Device, from: &Device, batches: usize, rows: i64) {
    for _ in 0..batches {
        let since = engine::pulled_from(&into.pool, &from.id).await.unwrap();
        let batch = engine::export(&from.pool, since, &into.id, rows, 1024).await.unwrap();
        engine::apply(&into.pool, &from.id, &batch).await.unwrap();
        if batch.done {
            break;
        }
    }
}

/// Every synced table's rows, with their versions, as comparable text.
pub(crate) async fn dump(pool: &SqlitePool) -> BTreeMap<String, Vec<String>> {
    let mut conn = pool.acquire().await.unwrap();
    let tables = engine::synced_tables(&mut conn).await.unwrap();
    let mut out = BTreeMap::new();
    for t in tables.values() {
        let rows = sqlx::query(&format!("SELECT * FROM \"{}\" ORDER BY \"{}\"", t.name, t.pk))
            .fetch_all(&mut *conn)
            .await
            .unwrap();
        let mut lines: Vec<String> = Vec::new();
        for r in &rows {
            use sqlx::{Column, Row, ValueRef};
            let mut cells = Vec::new();
            for (i, c) in r.columns().iter().enumerate() {
                let raw = r.try_get_raw(i).unwrap();
                let v = if raw.is_null() {
                    "NULL".to_string()
                } else {
                    match r.try_get_unchecked::<String, _>(i) {
                        Ok(s) => s,
                        Err(_) => format!("{:?}", r.try_get_unchecked::<Vec<u8>, _>(i).unwrap()),
                    }
                };
                cells.push(format!("{}={}", c.name(), v));
            }
            lines.push(cells.join("|"));
        }
        out.insert(t.name.clone(), lines);
    }
    let versions: Vec<(String, String, String, String, i64)> =
        sqlx::query_as("SELECT tbl, pk, hlc, origin, deleted FROM sync_rows ORDER BY tbl, pk")
            .fetch_all(&mut *conn)
            .await
            .unwrap();
    out.insert("~versions".into(), versions.iter().map(|v| format!("{v:?}")).collect());
    let vv: Vec<(String, String, String, i64)> =
        sqlx::query_as("SELECT tbl, pk, device, counter FROM sync_vv ORDER BY tbl, pk, device")
            .fetch_all(&mut *conn)
            .await
            .unwrap();
    out.insert("~vv".into(), vv.iter().map(|v| format!("{v:?}")).collect());
    out
}

fn uuid(rng: &mut StdRng) -> String {
    let b: [u8; 16] = rng.gen();
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

async fn ids(pool: &SqlitePool, sql: &str) -> Vec<String> {
    sqlx::query_scalar(sql).fetch_all(pool).await.unwrap()
}

fn pick<'a>(rng: &mut StdRng, v: &'a [String]) -> Option<&'a String> {
    if v.is_empty() {
        None
    } else {
        Some(&v[rng.gen_range(0..v.len())])
    }
}

/// What the chats test watches: every turn ever written, and the turns a
/// deletion had seen when it removed them.
#[derive(Default)]
struct Turns {
    written: BTreeSet<String>,
    deleted_knowingly: HashSet<String>,
}

fn turns_of(messages: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(messages).unwrap();
    v.as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect()
}

/// One random edit of the kind the app makes.
async fn random_edit(rng: &mut StdRng, d: &Device, turns: &mut Turns, n: usize) {
    let p = &d.pool;
    let now = format!("2026-11-16T08:{:02}:00.000Z", n % 60);
    match rng.gen_range(0..16) {
        0 | 1 => {
            let id = uuid(rng);
            exec(p, &format!("INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('{id}', '{now}', 'meal {n}', '{{}}')")).await;
        }
        2 => {
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM food_entries").await) {
                exec(p, &format!("UPDATE food_entries SET title = 'edited {n}' WHERE id = '{id}'")).await;
            }
        }
        3 => {
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM food_entries").await) {
                exec(p, &format!("DELETE FROM food_entries WHERE id = '{id}'")).await;
            }
        }
        4 => {
            // The same few labels on every device: the unique index will clash.
            let label = ["Bloated", "Tired", "Calm", "Anxious", "Headache"][rng.gen_range(0..5)];
            let exists: Option<String> = sqlx::query_scalar("SELECT id FROM state_categories WHERE label = ?")
                .bind(label)
                .fetch_optional(p)
                .await
                .unwrap();
            if exists.is_none() {
                let id = uuid(rng);
                exec(p, &format!("INSERT INTO state_categories (id, label, icon, created_at) VALUES ('{id}', '{label}', 'x', '{now}')")).await;
            }
        }
        5 => {
            let log = uuid(rng);
            exec(p, &format!("INSERT INTO state_logs (id, logged_at, day, tz_offset_min, note) VALUES ('{log}', '{now}', '2026-11-16', 60, 'n{n}')")).await;
            for k in 0..rng.gen_range(0..3) {
                let tag = uuid(rng);
                exec(p, &format!("INSERT INTO state_log_tags (id, log_id, label) VALUES ('{tag}', '{log}', 'tag{k}')")).await;
            }
        }
        6 => {
            // Tags added to an existing observation — maybe one deleted elsewhere meanwhile.
            if let Some(log) = pick(rng, &ids(p, "SELECT id FROM state_logs").await) {
                let tag = uuid(rng);
                exec(p, &format!("INSERT INTO state_log_tags (id, log_id, label) VALUES ('{tag}', '{log}', 'later')")).await;
            }
        }
        7 => {
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM state_logs").await) {
                exec(p, &format!("DELETE FROM state_logs WHERE id = '{id}'")).await;
            }
        }
        8 => {
            let id = uuid(rng);
            let turn = format!("{}:{n}:first", d.id);
            turns.written.insert(turn.clone());
            exec(p, &format!("INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('{id}', '{now}', '{now}', 'chat {n}', '[\"{turn}\"]')")).await;
        }
        9 | 10 => {
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM chats").await) {
                let messages: String = sqlx::query_scalar("SELECT messages FROM chats WHERE id = ?").bind(id).fetch_one(p).await.unwrap();
                let mut t = turns_of(&messages);
                let turn = format!("{}:{n}:turn", d.id);
                turns.written.insert(turn.clone());
                t.push(turn);
                let json = serde_json::to_string(&t).unwrap();
                sqlx::query("UPDATE chats SET messages = ?, updated_at = ? WHERE id = ?").bind(json).bind(&now).bind(id).execute(p).await.unwrap();
            }
        }
        11 => {
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM chats").await) {
                let messages: String = sqlx::query_scalar("SELECT messages FROM chats WHERE id = ?").bind(id).fetch_one(p).await.unwrap();
                turns.deleted_knowingly.extend(turns_of(&messages));
                exec(p, &format!("DELETE FROM chats WHERE id = '{id}'")).await;
            }
        }
        12 => {
            let key = ["calorie_target_kcal", "protein_target_g", "openrouter_api_key"][rng.gen_range(0..3)];
            sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .bind(key)
                .bind(format!("v{n}"))
                .execute(p)
                .await
                .unwrap();
        }
        13 => {
            // Content-addressed: the same picture on two devices is one row.
            let k: u8 = rng.gen_range(0..6);
            let bytes: Vec<u8> = (0..2000u32).map(|i| (i as u8).wrapping_mul(k + 1)).collect();
            let name = crate::photos::content_name(&bytes);
            sqlx::query("INSERT OR IGNORE INTO photos (filename, data) VALUES (?, ?)").bind(name).bind(bytes).execute(p).await.unwrap();
        }
        14 => {
            let id = uuid(rng);
            exec(p, &format!("INSERT INTO documents (id, created_at, title) VALUES ('{id}', '{now}', 'doc {n}')")).await;
            let pdf: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
            sqlx::query("INSERT INTO document_files (document_id, filename, media_type, data) VALUES (?, 'a.pdf', 'application/pdf', ?)")
                .bind(&id)
                .bind(pdf)
                .execute(p)
                .await
                .unwrap();
        }
        _ => {
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM documents").await) {
                exec(p, &format!("DELETE FROM documents WHERE id = '{id}'")).await;
            }
        }
    }
}

/// Syncs every pair until a whole round changes nothing anywhere, cleaning up
/// orphans as the app does after a sync. Panics if it doesn't settle.
async fn settle(devices: &[Device]) {
    for round in 0..12 {
        let mut changed = 0;
        for i in 0..devices.len() {
            for j in 0..devices.len() {
                if i != j {
                    let s = engine::pull_all(&devices[i].pool, &devices[j].pool, 7, 16 * 1024).await.unwrap();
                    changed += s.applied + s.conflicts + s.forks + s.unique_merges;
                }
            }
        }
        for d in devices {
            changed += engine::remove_orphans(&d.pool).await.unwrap() as usize;
        }
        if changed == 0 {
            return;
        }
        assert!(round < 11, "sync didn't settle");
    }
}

async fn assert_identical(devices: &[Device]) {
    let first = dump(&devices[0].pool).await;
    let first_digest = engine::digest(&devices[0].pool).await.unwrap();
    for d in &devices[1..] {
        let other = dump(&d.pool).await;
        for (table, rows) in &first {
            assert_eq!(rows, &other[table], "{table} differs between devices");
        }
        let digest = engine::digest(&d.pool).await.unwrap();
        assert_eq!(engine::digest_differences(&first_digest, &digest), Vec::<String>::new());
    }
    for d in devices {
        let fk: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check").fetch_all(&d.pool).await.unwrap();
        assert!(fk.is_empty(), "dangling references: {fk:?}");
        let applying: i64 = sqlx::query_scalar("SELECT applying FROM sync_state").fetch_one(&d.pool).await.unwrap();
        assert_eq!(applying, 0);
    }
}

async fn chat_turns(pool: &SqlitePool) -> BTreeSet<String> {
    let all: Vec<String> = sqlx::query_scalar("SELECT messages FROM chats").fetch_all(pool).await.unwrap();
    all.iter().flat_map(|m| turns_of(m)).collect()
}

async fn run_history(seed: u64, devices_n: usize, steps: usize) {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut devices = Vec::new();
    for _ in 0..devices_n {
        devices.push(device().await);
    }
    let mut turns = Turns::default();
    for n in 0..steps {
        let d = rng.gen_range(0..devices_n);
        random_edit(&mut rng, &devices[d], &mut turns, n).await;
        if rng.gen_bool(0.25) {
            let a = rng.gen_range(0..devices_n);
            let b = (a + rng.gen_range(1..devices_n)) % devices_n;
            if rng.gen_bool(0.3) {
                // A connection that drops part-way.
                let k = rng.gen_range(0..3);
                let rows = rng.gen_range(1..4);
                pull_some(&devices[a], &devices[b], k, rows).await;
            } else {
                sync_pair(&devices[a], &devices[b]).await;
            }
        }
    }
    settle(&devices).await;
    assert_identical(&devices).await;

    // No turn lost, unless a deletion had seen it.
    let kept = chat_turns(&devices[0].pool).await;
    for t in &turns.written {
        assert!(
            kept.contains(t) || turns.deleted_knowingly.contains(t),
            "seed {seed}: turn {t} was lost"
        );
    }

    // Quiet once settled: nothing more moves, in either direction.
    for i in 0..devices_n {
        for j in 0..devices_n {
            if i != j {
                let s = engine::pull_all(&devices[i].pool, &devices[j].pool, 50, 1 << 20).await.unwrap();
                assert_eq!(s.applied + s.conflicts + s.forks, 0, "seed {seed}: still moving after settling");
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn random_histories_converge_between_two_devices() {
    for seed in 0..25 {
        run_history(seed, 2, 120).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn random_histories_converge_between_three_devices() {
    for seed in 100..115 {
        run_history(seed, 3, 160).await;
    }
}

// ---------------------------------------------------------------------------
// Specific cases, spelled out
// ---------------------------------------------------------------------------

async fn messages(pool: &SqlitePool) -> Vec<(String, String, String)> {
    sqlx::query_as("SELECT id, title, messages FROM chats ORDER BY title").fetch_all(pool).await.unwrap()
}

async fn name_devices(a: &Device, b: &Device) {
    for (d, name) in [(a, "Phone"), (b, "Mac")] {
        exec(&d.pool, &format!("INSERT INTO vault_devices (id, name, public_key, platform, added_at) VALUES ('{}', '{name}', '00', 'x', 'now')", d.id)).await;
    }
}

#[tokio::test]
async fn a_chat_continued_on_both_devices_is_split_in_two() {
    let (a, b) = (device().await, device().await);
    name_devices(&a, &b).await;
    exec(&a.pool, "INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('c', 'now', 'now', 'Plan', '[\"q1\",\"a1\"]')").await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"a1\",\"phone q\"]' WHERE id = 'c'").await;
    exec(&b.pool, "UPDATE chats SET messages = '[\"q1\",\"a1\",\"mac q\"]' WHERE id = 'c'").await;

    let (x, y) = sync_pair(&a, &b).await;
    assert_eq!(x.forks + y.forks, 1);
    settle(&[a, b].map(|d| d)).await;
}

#[tokio::test]
async fn a_split_chat_comes_out_the_same_on_both_devices() {
    let (a, b) = (device().await, device().await);
    name_devices(&a, &b).await;
    exec(&a.pool, "INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('c', 'now', 'now', 'Plan', '[\"q1\"]')").await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"phone\"]' WHERE id = 'c'").await;
    exec(&b.pool, "UPDATE chats SET messages = '[\"q1\",\"mac\"]' WHERE id = 'c'").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let chats = messages(&devices[0].pool).await;
    assert_eq!(chats.len(), 2, "{chats:?}");
    // The later edit (the Mac's) keeps the chat; the phone's becomes its own.
    assert_eq!(chats[0], ("c".into(), "Plan".into(), "[\"q1\",\"mac\"]".into()));
    assert_eq!(chats[1].1, "Plan (continued in parallel)");
    assert_eq!(chats[1].2, "[\"q1\",\"phone\"]");
}

#[tokio::test]
async fn a_chat_continued_on_one_device_just_moves_along() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('c', 'now', 'now', 'Plan', '[\"q1\"]')").await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"a1\"]' WHERE id = 'c'").await;
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"a1\",\"q2\"]' WHERE id = 'c'").await;
    let (_, y) = sync_pair(&a, &b).await;
    assert_eq!((y.forks, y.conflicts), (0, 0));
    assert_eq!(messages(&b.pool).await, vec![("c".into(), "Plan".into(), "[\"q1\",\"a1\",\"q2\"]".into())]);
}

#[tokio::test]
async fn a_chat_deleted_on_one_device_and_continued_on_the_other_is_kept() {
    let (a, b) = (device().await, device().await);
    name_devices(&a, &b).await;
    exec(&a.pool, "INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('c', 'now', 'now', 'Plan', '[\"q1\"]')").await;
    sync_pair(&a, &b).await;
    exec(&b.pool, "UPDATE chats SET messages = '[\"q1\",\"mac\"]' WHERE id = 'c'").await;
    exec(&a.pool, "DELETE FROM chats WHERE id = 'c'").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let kept = chat_turns(&devices[0].pool).await;
    assert!(kept.contains("mac"), "{kept:?}");
}

#[tokio::test]
async fn deletes_reach_the_other_device_and_stay_deleted() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    sync_pair(&a, &b).await;
    exec(&b.pool, "DELETE FROM food_entries WHERE id = 'm'").await;
    sync_pair(&a, &b).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM food_entries").fetch_one(&a.pool).await.unwrap();
    assert_eq!(n, 0);
    // A stale copy of the old version arriving later can't bring it back.
    let c = device().await;
    let devices = [a, b, c];
    settle(&devices).await;
    assert_identical(&devices).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM food_entries").fetch_one(&devices[2].pool).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn concurrent_edits_to_a_row_settle_on_the_later_one_everywhere() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE food_entries SET title = 'first' WHERE id = 'm'").await;
    std::thread::sleep(std::time::Duration::from_millis(5));
    exec(&b.pool, "UPDATE food_entries SET title = 'second' WHERE id = 'm'").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let t: String = sqlx::query_scalar("SELECT title FROM food_entries").fetch_one(&devices[0].pool).await.unwrap();
    assert_eq!(t, "second");
}

#[tokio::test]
async fn the_same_tag_made_on_two_devices_ends_up_as_one() {
    let (a, b) = (device().await, device().await);
    // Migrations seed the same three default categories on both, under the
    // same ids — those are simply the same rows.
    exec(&a.pool, "INSERT INTO state_categories (id, label, icon, created_at) VALUES ('b-id', 'Headache', 'x', 'now')").await;
    exec(&b.pool, "INSERT INTO state_categories (id, label, icon, created_at) VALUES ('a-id', 'Headache', 'y', 'now')").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM state_categories WHERE label = 'Headache'").fetch_all(&devices[0].pool).await.unwrap();
    assert_eq!(ids, vec!["a-id".to_string()]);
}

#[tokio::test]
async fn photos_and_document_files_arrive_byte_for_byte() {
    let (a, b) = (device().await, device().await);
    let photo: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 256) as u8).collect();
    let name = crate::photos::save(&a.pool, &photo).await.unwrap();
    exec(&a.pool, "INSERT INTO documents (id, created_at, title) VALUES ('d', 'now', 'Labs')").await;
    let pdf: Vec<u8> = (0..1_000_000u32).map(|i| (i % 253) as u8).collect();
    crate::document_files::save(&a.pool, "d", "labs.pdf", "application/pdf", &pdf).await.unwrap();
    // Small batches: the big rows still go, one per batch.
    engine::pull_all(&b.pool, &a.pool, 50, 1024).await.unwrap();
    assert_eq!(crate::photos::read(&b.pool, &name).await.unwrap(), photo);
    assert_eq!(crate::document_files::read(&b.pool, "d").await.unwrap(), pdf);
}

#[tokio::test]
async fn an_interrupted_pull_resumes_where_it_stopped() {
    let (a, b) = (device().await, device().await);
    for i in 0..40 {
        exec(&a.pool, &format!("INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m{i:02}', 'now', 'meal', '{{}}')")).await;
    }
    pull_some(&b, &a, 2, 5).await;
    let half: i64 = sqlx::query_scalar("SELECT count(*) FROM food_entries").fetch_one(&b.pool).await.unwrap();
    assert!(half > 0 && half < 40);
    let s = engine::pull_all(&b.pool, &a.pool, 5, 1 << 20).await.unwrap();
    // Exactly the rest: nothing pulled before the drop came again.
    assert_eq!(s.applied as i64, 40 - half);
    let all: i64 = sqlx::query_scalar("SELECT count(*) FROM food_entries").fetch_one(&b.pool).await.unwrap();
    assert_eq!(all, 40);
}

#[tokio::test]
async fn applying_the_same_batch_twice_changes_nothing() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    let batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    engine::apply(&b.pool, &a.id, &batch).await.unwrap();
    let before = dump(&b.pool).await;
    let again = engine::apply(&b.pool, &a.id, &batch).await.unwrap();
    assert_eq!(again.applied, 0);
    let after = dump(&b.pool).await;
    assert_eq!(before.get("food_entries"), after.get("food_entries"));
}

#[tokio::test]
async fn a_bad_batch_changes_nothing_at_all() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    let mut batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    let before = dump(&b.pool).await;
    // A change for a table that isn't synced, at the end of an otherwise good batch.
    let mut evil = batch.changes[0].clone();
    evil.tbl = "sync_state".into();
    batch.changes.push(evil);
    assert!(engine::apply(&b.pool, &a.id, &batch).await.is_err());
    assert_eq!(dump(&b.pool).await, before);
    assert_eq!(engine::pulled_from(&b.pool, &a.id).await.unwrap(), 0);
    let applying: i64 = sqlx::query_scalar("SELECT applying FROM sync_state").fetch_one(&b.pool).await.unwrap();
    assert_eq!(applying, 0);
}

#[tokio::test]
async fn a_change_with_unknown_columns_is_refused() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    let mut batch: Batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    let c = batch.changes.iter_mut().find(|c| c.tbl == "food_entries").unwrap();
    c.data.as_mut().unwrap().push(("evil".into(), engine::Value::Text("x".into())));
    assert!(engine::apply(&b.pool, &a.id, &batch).await.is_err());
}

#[tokio::test]
async fn local_writes_made_during_a_sync_are_still_recorded() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    sync_pair(&a, &b).await;
    exec(&b.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('n', 'now', 'Eggs', '{}')").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM food_entries").fetch_one(&devices[0].pool).await.unwrap();
    assert_eq!(n, 2);
}

#[tokio::test]
async fn joining_needs_an_empty_device_and_then_receives_everything() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "UPDATE sync_state SET vault_id = 'v'").await;
    for i in 0..30 {
        exec(&a.pool, &format!("INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m{i}', 'now', 'meal', '{{}}')")).await;
    }
    crate::photos::save(&a.pool, b"a photo").await.unwrap();
    exec(&a.pool, "INSERT INTO settings (key, value) VALUES ('openrouter_api_key', 'sk-123')").await;

    // A device with data of its own is refused, and keeps it.
    exec(&b.pool, "INSERT INTO fasts (id, started_at, goal_hours) VALUES ('f', 'now', 16)").await;
    assert!(engine::reset_for_join(&b.pool, "v", "new-b", None, false).await.is_err());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM fasts").fetch_one(&b.pool).await.unwrap();
    assert_eq!(n, 1);

    // An empty one (settings and defaults don't count) joins.
    let c = device().await;
    exec(&c.pool, "INSERT INTO settings (key, value) VALUES ('calorie_target_kcal', '1800')").await;
    let old_id = c.id.clone();
    let new_id = crate::sync::new_uuid();
    engine::reset_for_join(&c.pool, "v", &new_id, None, false).await.unwrap();
    assert_ne!(new_id, old_id);
    let c = Device { id: new_id, ..c };
    engine::pull_all(&c.pool, &a.pool, 10, 1 << 20).await.unwrap();
    let devices = [a, c];
    settle(&devices).await;
    assert_identical(&devices).await;
    let key: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'openrouter_api_key'").fetch_one(&devices[1].pool).await.unwrap();
    assert_eq!(key, "sk-123");
}

#[tokio::test]
async fn the_digest_notices_any_difference() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    sync_pair(&a, &b).await;
    let same: Digest = engine::digest(&a.pool).await.unwrap();
    assert!(engine::digest_differences(&same, &engine::digest(&b.pool).await.unwrap()).is_empty());
    // Changed behind sync's back (no trigger): the digest still sees it.
    exec(&b.pool, "UPDATE sync_state SET applying = 1").await;
    exec(&b.pool, "UPDATE food_entries SET title = 'Eggs'").await;
    exec(&b.pool, "UPDATE sync_state SET applying = 0").await;
    let diff = engine::digest_differences(&same, &engine::digest(&b.pool).await.unwrap());
    assert_eq!(diff, vec!["food_entries".to_string()]);
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_peer_with_a_clock_years_ahead_cannot_drag_ours_along() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    let mut batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    for c in &mut batch.changes {
        c.hlc = "9999999999999.000000".into();
    }
    engine::apply(&b.pool, &a.id, &batch).await.unwrap();
    let ms: i64 = sqlx::query_scalar("SELECT hlc_ms FROM sync_state").fetch_one(&b.pool).await.unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    assert!(ms <= now + 24 * 3600 * 1000 + 1000, "clock dragged to {ms}");
}

#[tokio::test]
async fn the_clock_rolls_into_the_next_millisecond_rather_than_overflow() {
    let a = device().await;
    let ahead = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + 3_600_000;
    exec(&a.pool, &format!("UPDATE sync_state SET hlc_ms = {ahead}, hlc_counter = 999999")).await;
    exec(&a.pool, "INSERT INTO fasts (id, started_at, goal_hours) VALUES ('f', 'now', 16)").await;
    let hlc: String = sqlx::query_scalar("SELECT hlc FROM sync_rows WHERE pk = 'f'").fetch_one(&a.pool).await.unwrap();
    assert_eq!(hlc, format!("{:013}.000000", ahead + 1));
}

#[tokio::test]
async fn malformed_clock_values_are_refused() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    for bad in ["1.2", "99999999999999.000000", "0000000000001.0000001", "000000000000a.000000"] {
        let mut batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
        batch.changes[0].hlc = bad.into();
        assert!(engine::apply(&b.pool, &a.id, &batch).await.is_err(), "{bad} accepted");
    }
}

#[tokio::test]
async fn an_update_that_changes_nothing_is_not_a_new_version() {
    let a = device().await;
    exec(&a.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m', 'now', 'Oats', '{}')").await;
    let before: (String, i64) = sqlx::query_as("SELECT hlc, seq FROM sync_rows WHERE pk = 'm'").fetch_one(&a.pool).await.unwrap();
    exec(&a.pool, "UPDATE food_entries SET title = 'Oats', nutrients = '{}' WHERE id = 'm'").await;
    let after: (String, i64) = sqlx::query_as("SELECT hlc, seq FROM sync_rows WHERE pk = 'm'").fetch_one(&a.pool).await.unwrap();
    assert_eq!(before, after);
    exec(&a.pool, "UPDATE food_entries SET title = 'Porridge' WHERE id = 'm'").await;
    let changed: (String, i64) = sqlx::query_as("SELECT hlc, seq FROM sync_rows WHERE pk = 'm'").fetch_one(&a.pool).await.unwrap();
    assert!(changed.1 > before.1);
}

#[tokio::test]
async fn a_revocation_cannot_be_deleted_by_a_peer() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO vault_revocations (public_key, device_id, revoked_at) VALUES ('cc', 'lost', 'now')").await;
    sync_pair(&a, &b).await;
    // A modified client claims a newer deletion of it.
    let mut batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    let c = batch.changes.iter_mut().find(|c| c.tbl == "vault_revocations").unwrap();
    c.deleted = true;
    c.data = None;
    c.hlc = "9999999999999.000000".into();
    for v in c.vv.values_mut() {
        *v += 1_000_000_000_000_000;
    }
    engine::apply(&b.pool, &a.id, &batch).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_revocations").fetch_one(&b.pool).await.unwrap();
    assert_eq!(n, 1);
}
