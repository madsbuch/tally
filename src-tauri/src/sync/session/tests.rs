//! Pairing and syncing over real TCP connections on localhost, both devices
//! in this process.

use super::*;
use crate::sync::tests::{device, dump, exec, Device};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Host {
    device: Device,
    slot: PairingSlot,
    addr: SocketAddr,
    served: Arc<AtomicUsize>,
    errors: Arc<Mutex<Vec<String>>>,
}

async fn host() -> Host {
    let device = device().await;
    let slot: PairingSlot = Arc::new(Mutex::new(None));
    let served = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let (s, e) = (served.clone(), errors.clone());
    let (port, _) = listen(device.pool.clone(), slot.clone(), "127.0.0.1", move |r| match r {
        Ok(_) => {
            s.fetch_add(1, Ordering::SeqCst);
        }
        Err(err) => e.lock().unwrap().push(err),
    })
    .await
    .unwrap();
    Host { device, slot, addr: format!("127.0.0.1:{port}").parse().unwrap(), served, errors }
}

/// Syncs, waiting out a host that's still finishing the previous sync.
async fn sync_now(pool: &SqlitePool, addr: SocketAddr) -> Result<Outcome> {
    for _ in 0..100 {
        if let Some(o) = sync_with(pool, addr).await? {
            return Ok(o);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err("host stayed busy".into())
}

async fn offer_from(h: &Host) -> PairingOffer {
    offer(&h.device.pool, &h.slot, vec![h.addr.to_string()]).await.unwrap()
}

async fn count(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn with_some_data(pool: &SqlitePool) {
    for i in 0..25 {
        exec(pool, &format!("INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('m{i:02}', 'now', 'meal {i}', '{{}}')")).await;
    }
    exec(pool, "INSERT INTO settings (key, value) VALUES ('openrouter_api_key', 'sk-live')").await;
    let photo: Vec<u8> = (0..2_000_000u32).map(|i| (i * 13 % 256) as u8).collect();
    crate::photos::save(pool, &photo).await.unwrap();
}

/// The host's and joiner's data, compared table by table (versions included).
async fn assert_same(a: &SqlitePool, b: &SqlitePool) {
    let (x, y) = (dump(a).await, dump(b).await);
    for (table, rows) in &x {
        assert_eq!(rows, &y[table], "{table} differs");
    }
}

#[tokio::test]
async fn a_new_device_joins_with_the_code_and_gets_everything() {
    let h = host().await;
    with_some_data(&h.device.pool).await;
    let o = offer_from(&h).await;
    let joiner = device().await;

    let outcome = join(&joiner.pool, &PairingOffer::decode(&o.encode()).unwrap(), false).await.unwrap();
    assert!(outcome.complete, "{:?}", outcome.differences);
    assert!(outcome.received.applied >= 27);
    assert_same(&h.device.pool, &joiner.pool).await;
    // Both know both, by the keys they proved.
    assert_eq!(count(&h.device.pool, "SELECT count(*) FROM vault_devices").await, 2);
    assert_eq!(count(&joiner.pool, "SELECT count(*) FROM vault_devices").await, 2);
    let joiner_id = identity(&joiner.pool).await.unwrap().device_id;
    assert_ne!(joiner_id, joiner.id, "a joining device takes a new id");

    // Afterwards, plain syncs both ways.
    exec(&h.device.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('later', 'now', 'Dinner', '{}')").await;
    exec(&joiner.pool, "INSERT INTO fasts (id, started_at, goal_hours) VALUES ('f', 'now', 16)").await;
    let outcome = sync_now(&joiner.pool, h.addr).await.unwrap();
    assert!(outcome.complete);
    assert_same(&h.device.pool, &joiner.pool).await;
    assert_eq!(count(&h.device.pool, "SELECT count(*) FROM fasts").await, 1);
    assert_eq!(count(&joiner.pool, "SELECT count(*) FROM food_entries WHERE id = 'later'").await, 1);

    // A sync with nothing new moves nothing.
    let outcome = sync_now(&joiner.pool, h.addr).await.unwrap();
    assert!(!outcome.received.changed_anything());
    assert!(outcome.complete);
}

#[tokio::test]
async fn a_code_works_once() {
    let h = host().await;
    let o = offer_from(&h).await;
    join(&device().await.pool, &o, false).await.unwrap();
    let err = join(&device().await.pool, &o, false).await.unwrap_err();
    assert!(err.contains("expired or was already used"), "{err}");
    assert_eq!(count(&h.device.pool, "SELECT count(*) FROM vault_devices").await, 2);
}

#[tokio::test]
async fn an_expired_code_is_refused() {
    let h = host().await;
    let o = offer_from(&h).await;
    h.slot.lock().unwrap().as_mut().unwrap().expires = Instant::now() - Duration::from_secs(1);
    let joiner = device().await;
    let err = join(&joiner.pool, &o, false).await.unwrap_err();
    assert!(err.contains("expired"), "{err}");
    // Nothing on the joiner was touched.
    assert_eq!(identity(&joiner.pool).await.unwrap().vault_id, None);
}

#[tokio::test]
async fn a_forged_code_is_refused_before_anything_is_touched() {
    let h = host().await;
    let mut o = offer_from(&h).await;
    // Someone else's key: the device that answers isn't the one in the code.
    o.host_key = wire::generate_keypair().1;
    let joiner = device().await;
    exec(&joiner.pool, "INSERT INTO settings (key, value) VALUES ('calorie_target_kcal', '1800')").await;
    assert!(join(&joiner.pool, &o, false).await.is_err());
    assert_eq!(count(&joiner.pool, "SELECT count(*) FROM settings").await, 1);
    assert_eq!(identity(&joiner.pool).await.unwrap().vault_id, None);
}

#[tokio::test]
async fn a_device_with_data_cannot_join_and_keeps_its_data() {
    let h = host().await;
    let o = offer_from(&h).await;
    let joiner = device().await;
    exec(&joiner.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('mine', 'now', 'Oats', '{}')").await;
    let err = join(&joiner.pool, &o, false).await.unwrap_err();
    assert!(err.contains("already holds data"), "{err}");
    assert_eq!(count(&joiner.pool, "SELECT count(*) FROM food_entries").await, 1);
    // And the code is still good for an empty one.
    join(&device().await.pool, &o, false).await.unwrap();
}

#[tokio::test]
async fn a_stranger_cannot_sync() {
    let h = host().await;
    with_some_data(&h.device.pool).await;
    offer_from(&h).await; // the host now has a vault
    let stranger = device().await;
    // A vault of its own, same id even: still not on the host's list.
    let vault = identity(&h.device.pool).await.unwrap().vault_id.unwrap();
    exec(&stranger.pool, &format!("UPDATE sync_state SET vault_id = '{vault}'")).await;
    ensure_vault(&stranger.pool).await.unwrap();
    let before = dump(&h.device.pool).await;
    // Dropped straight after the handshake: it learns nothing, not even why.
    assert!(sync_now(&stranger.pool, h.addr).await.is_err());
    // The host records it on its own task: give it a moment.
    for _ in 0..100 {
        if h.errors.lock().unwrap().iter().any(|e| e.contains("outside the vault")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(h.errors.lock().unwrap().iter().any(|e| e.contains("outside the vault")));
    assert_eq!(dump(&h.device.pool).await, before);
    assert_eq!(count(&stranger.pool, "SELECT count(*) FROM food_entries").await, 0);
}

#[tokio::test]
async fn a_removed_device_is_refused_from_then_on() {
    let h = host().await;
    let joiner = device().await;
    join(&joiner.pool, &offer_from(&h).await, false).await.unwrap();
    let joiner_id = identity(&joiner.pool).await.unwrap().device_id;
    exec(&h.device.pool, &format!("DELETE FROM vault_devices WHERE id = '{joiner_id}'")).await;
    exec(&h.device.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('secret', 'now', 'x', '{}')").await;
    assert!(sync_now(&joiner.pool, h.addr).await.is_err());
    assert_eq!(count(&joiner.pool, "SELECT count(*) FROM food_entries WHERE id = 'secret'").await, 0);
}

#[tokio::test]
async fn different_versions_of_the_app_do_not_sync() {
    let h = host().await;
    let joiner = device().await;
    join(&joiner.pool, &offer_from(&h).await, false).await.unwrap();
    exec(&joiner.pool, "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (999, 'future', 1, x'', 0)").await;
    let err = sync_now(&joiner.pool, h.addr).await.unwrap_err();
    assert!(err.contains("different version of Tally"), "{err}");
}

#[tokio::test]
async fn edits_on_both_sides_meet_in_one_sync() {
    let h = host().await;
    let joiner = device().await;
    join(&joiner.pool, &offer_from(&h).await, false).await.unwrap();
    exec(&h.device.pool, "INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('c', 'now', 'now', 'Plan', '[\"q1\"]')").await;
    sync_now(&joiner.pool, h.addr).await.unwrap();
    exec(&h.device.pool, "UPDATE chats SET messages = '[\"q1\",\"from the computer\"]'").await;
    exec(&joiner.pool, "UPDATE chats SET messages = '[\"q1\",\"from the phone\"]'").await;
    exec(&joiner.pool, "INSERT INTO settings (key, value) VALUES ('protein_target_g', '160')").await;
    let outcome = sync_now(&joiner.pool, h.addr).await.unwrap();
    // One round may leave the merged version to travel back; the next settles it.
    let outcome = if outcome.complete { outcome } else { sync_now(&joiner.pool, h.addr).await.unwrap() };
    assert!(outcome.complete, "{:?}", outcome.differences);
    assert_same(&h.device.pool, &joiner.pool).await;
    assert_eq!(count(&h.device.pool, "SELECT count(*) FROM chats").await, 2);
    let all: Vec<String> = sqlx::query_scalar("SELECT messages FROM chats").fetch_all(&h.device.pool).await.unwrap();
    assert!(all.iter().any(|m| m.contains("from the computer")) && all.iter().any(|m| m.contains("from the phone")));
}

#[tokio::test]
async fn the_last_sync_is_remembered_per_peer() {
    let h = host().await;
    let joiner = device().await;
    join(&joiner.pool, &offer_from(&h).await, false).await.unwrap();
    let host_id = identity(&h.device.pool).await.unwrap().device_id;
    let (complete, at, addr): (i64, Option<String>, Option<String>) =
        sqlx::query_as("SELECT complete, last_complete_at, last_addr FROM sync_peers WHERE device_id = ?")
            .bind(&host_id)
            .fetch_one(&joiner.pool)
            .await
            .unwrap();
    assert_eq!(complete, 1);
    assert!(at.unwrap().ends_with('Z'));
    assert_eq!(addr.unwrap(), h.addr.to_string());
}

#[test]
fn pairing_codes_round_trip_and_garbage_is_rejected() {
    let o = PairingOffer {
        vault_id: "v".into(),
        host_id: "h".into(),
        host_name: "Phone".into(),
        host_key: vec![1; 32],
        token: [9; 32],
        addrs: vec!["192.168.1.20:47822".into()],
    };
    assert_eq!(PairingOffer::decode(&o.encode()).unwrap(), o);
    assert!(PairingOffer::decode("hello").is_err());
    assert!(PairingOffer::decode("tally-pair:1:@@@").is_err());
    let mut s = o.encode();
    s.truncate(s.len() - 10);
    assert!(PairingOffer::decode(&s).is_err());
}

#[test]
fn timestamps_are_utc_iso() {
    let t = now_iso();
    assert_eq!(t.len(), 24, "{t}");
    assert!(t.starts_with("20") && t.ends_with('Z'));
}

#[tokio::test]
async fn failed_connections_are_reported_by_the_listener() {
    let h = host().await;
    // Something that isn't Tally knocks on the port.
    let mut s = TcpStream::connect(h.addr).await.unwrap();
    tokio::io::AsyncWriteExt::write_all(&mut s, b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
    drop(s);
    for _ in 0..50 {
        if !h.errors.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(h.served.load(Ordering::SeqCst), 0);
    assert!(!h.errors.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_restored_copy_is_caught_at_the_start_of_a_sync_and_then_catches_up() {
    let h = host().await;
    let joiner = device().await;
    join(&joiner.pool, &offer_from(&h).await, false).await.unwrap();
    // A copy of the phone's database, taken now…
    let dir = crate::photos::tests::Scratch::new();
    let copy = dir.0.join("restored.db");
    sqlx::query(&format!("VACUUM INTO '{}'", copy.display())).execute(&joiner.pool).await.unwrap();
    // …then the phone logs more, and syncs it.
    for i in 0..4 {
        exec(&joiner.pool, &format!("INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('lost-{i}', 'now', 'x', '{{}}')")).await;
    }
    sync_now(&joiner.pool, h.addr).await.unwrap();
    // The phone is restored from the copy — and nothing checked the file
    // beside it (the worst case). It logs a meal.
    let restored = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&copy))
        .await
        .unwrap();
    let old_id = identity(&restored).await.unwrap().device_id;
    exec(&restored, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('after-restore', 'now', 'Eggs', '{}')").await;

    // The first sync notices, takes a new id, and stops.
    let err = sync_now(&restored, h.addr).await.unwrap_err();
    assert!(err.contains("older copy"), "{err}");
    assert_ne!(identity(&restored).await.unwrap().device_id, old_id);
    // The next one goes through — the host knows it by its key — and
    // everything comes together.
    let mut outcome = sync_now(&restored, h.addr).await.unwrap();
    if !outcome.complete {
        outcome = sync_now(&restored, h.addr).await.unwrap();
    }
    assert!(outcome.complete, "{:?}", outcome.differences);
    assert_eq!(count(&restored, "SELECT count(*) FROM food_entries WHERE id LIKE 'lost-%'").await, 4);
    assert_eq!(count(&h.device.pool, "SELECT count(*) FROM food_entries WHERE id = 'after-restore'").await, 1);
    assert_same(&h.device.pool, &restored).await;
}

#[tokio::test]
async fn a_removed_device_is_refused_by_its_key_whatever_id_it_takes() {
    let h = host().await;
    let joiner = device().await;
    join(&joiner.pool, &offer_from(&h).await, false).await.unwrap();
    let joiner_id = identity(&joiner.pool).await.unwrap().device_id;
    crate::sync::service::remove_device(&h.device.pool, &joiner_id).await.unwrap();
    // A new id doesn't help: the key is what's revoked.
    crate::sync::instance::rotate(&joiner.pool).await.unwrap();
    let err = sync_now(&joiner.pool, h.addr).await.unwrap_err();
    assert!(!err.is_empty());
    assert_eq!(h.served.load(Ordering::SeqCst), 1, "only the join's sync went through");
}

#[tokio::test]
async fn a_busy_host_leaves_the_joiner_untouched_and_the_code_usable() {
    let h = host().await;
    let o = offer_from(&h).await;
    let host_id = identity(&h.device.pool).await.unwrap().device_id;
    let joiner = device().await;
    exec(&joiner.pool, "INSERT INTO settings (key, value) VALUES ('calorie_target_kcal', '1800')").await;
    {
        let _held = try_busy(&host_id).unwrap();
        let err = join(&joiner.pool, &o, false).await.unwrap_err();
        assert!(err.contains("busy"), "{err}");
        // Nothing on the joiner changed.
        assert_eq!(identity(&joiner.pool).await.unwrap().vault_id, None);
        assert_eq!(count(&joiner.pool, "SELECT count(*) FROM settings").await, 1);
    }
    // The code wasn't used up.
    join(&joiner.pool, &o, false).await.unwrap();
}

#[tokio::test]
async fn a_stranger_is_turned_away_before_it_can_send_much() {
    let h = host().await;
    offer_from(&h).await;
    // A device that isn't in the vault completes a handshake and announces a
    // huge message: it's dropped without the host reading or holding it.
    let (secret, _) = wire::generate_keypair();
    let stream = TcpStream::connect(h.addr).await.unwrap();
    let mut ch = Channel::initiate(stream, PURPOSE_SYNC, &secret, None).await.unwrap();
    let big = vec![0u8; 8 * 1024 * 1024];
    let _ = ch.send_bytes(&big).await;
    for _ in 0..50 {
        if h.errors.lock().unwrap().iter().any(|e| e.contains("outside the vault")) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("not turned away: {:?}", h.errors.lock().unwrap());
}

#[tokio::test]
async fn a_failed_join_leaves_the_device_exactly_as_it_was() {
    let joiner = device().await;
    let before: (Option<Vec<u8>>, String) = {
        identity(&joiner.pool).await.unwrap();
        sqlx::query_as("SELECT public_key, device_id FROM sync_state").fetch_one(&joiner.pool).await.unwrap()
    };
    let o = PairingOffer {
        vault_id: "v".into(),
        host_id: "h".into(),
        host_name: "Phone".into(),
        host_key: vec![1; 32],
        token: [9; 32],
        // Nothing listens here.
        addrs: vec!["127.0.0.1:9".into()],
    };
    assert!(join(&joiner.pool, &o, false).await.is_err());
    let after: (Option<Vec<u8>>, String) =
        sqlx::query_as("SELECT public_key, device_id FROM sync_state").fetch_one(&joiner.pool).await.unwrap();
    assert_eq!(before, after, "key and id untouched");
}

#[tokio::test]
async fn a_device_answering_at_a_spoofed_address_is_not_trusted() {
    // Our vault, and a host of another vault that someone points us at.
    let ours = host().await;
    let joiner = device().await;
    join(&joiner.pool, &offer_from(&ours).await, false).await.unwrap();
    let impostor = host().await;
    offer_from(&impostor).await;
    let err = sync_now(&joiner.pool, impostor.addr).await.unwrap_err();
    assert!(err.contains("outside the vault"), "{err}");
}

#[tokio::test]
async fn a_device_with_data_can_join_by_replacing_it_after_a_copy_is_saved() {
    let h = host().await;
    with_some_data(&h.device.pool).await;
    let o = offer_from(&h).await;
    let joiner = device().await;
    exec(&joiner.pool, "INSERT INTO food_entries (id, eaten_at, title, nutrients) VALUES ('mine', 'now', 'Old toast', '{}')").await;
    exec(&joiner.pool, "INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('c', 'now', 'now', 'Old chat', '[]')").await;
    let held = engine::held_data(&joiner.pool).await.unwrap();
    assert_eq!(held, vec![("chats".to_string(), 1), ("food_entries".to_string(), 1)]);

    // Saved first…
    let dir = crate::photos::tests::Scratch::new();
    let backup = crate::sync::service::backup_before_join(&joiner.pool, &dir.0).await.unwrap();
    // …then replaced by the vault's.
    let outcome = join(&joiner.pool, &o, true).await.unwrap();
    assert!(outcome.complete, "{:?}", outcome.differences);
    assert_same(&h.device.pool, &joiner.pool).await;
    assert_eq!(count(&joiner.pool, "SELECT count(*) FROM food_entries WHERE id = 'mine'").await, 0);

    // The copy holds exactly what was there, and is marked as a copy.
    let copy = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&backup))
        .await
        .unwrap();
    assert_eq!(count(&copy, "SELECT count(*) FROM food_entries WHERE id = 'mine'").await, 1);
    assert_eq!(count(&copy, "SELECT count(*) FROM chats WHERE title = 'Old chat'").await, 1);
    let marker: String = sqlx::query_scalar("SELECT instance FROM sync_state").fetch_one(&copy).await.unwrap();
    assert!(marker.starts_with("copy:"));
}

#[test]
fn development_and_release_builds_never_sync() {
    assert!(same_build("dev", "dev"));
    assert!(same_build("release", "release"));
    // A version from before the field existed is a release.
    assert!(same_build("", "release"));
    assert!(!same_build("dev", "release"));
    assert!(!same_build("dev", ""));
    // These tests are a debug build.
    assert_eq!(build_kind(), "dev");
}

#[tokio::test]
async fn a_release_build_is_refused_by_a_development_build() {
    let h = host().await;
    let joiner = device().await;
    join(&joiner.pool, &offer_from(&h).await, false).await.unwrap();
    let me = identity(&joiner.pool).await.unwrap();
    let mut theirs = hello(&h.device.pool, &identity(&h.device.pool).await.unwrap()).await.unwrap();
    theirs.build = "release".into();
    let mine = hello(&joiner.pool, &me).await.unwrap();
    let host_key = identity(&h.device.pool).await.unwrap().public;
    let err = check_peer(&joiner.pool, &mine, &theirs, &host_key, None).await.unwrap_err();
    assert!(err.contains("development builds never sync"), "{err}");
}
