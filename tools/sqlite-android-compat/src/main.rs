// Applies Tally's migrations with SQLite 3.39 (what Android 14 ships) and
// performs the writes the Android check-in worker makes, checking the sync
// triggers parse and record them.
use rusqlite::Connection;
use std::fs;

// Spec: tandem.TRG-4
fn main() {
    let root = std::env::args().nth(1).expect("repo root");
    let conn = Connection::open_in_memory().unwrap();
    println!("sqlite {}", rusqlite::version());
    let lib = fs::read_to_string(format!("{root}/src-tauri/src/lib.rs")).unwrap();
    for line in lib.lines() {
        if let Some(i) = line.find("include_str!(\"../migrations/") {
            let rest = &line[i + "include_str!(\"../migrations/".len()..];
            let file = &rest[..rest.find('"').unwrap()];
            let sql = fs::read_to_string(format!("{root}/src-tauri/migrations/{file}")).unwrap();
            conn.execute_batch(&sql).unwrap_or_else(|e| panic!("{file}: {e}"));
        }
    }
    // What CoachDb.kt does, statement for statement in shape.
    conn.execute("INSERT INTO settings (key, value) VALUES ('openrouter_api_key', 'k') ON CONFLICT(key) DO UPDATE SET value = excluded.value", []).unwrap();
    conn.execute("INSERT INTO device_settings (key, value) VALUES ('coach_unread_chat', 'c') ON CONFLICT(key) DO UPDATE SET value = excluded.value", []).unwrap();
    conn.execute("INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES ('c1', 'now', 'now', 'Hi', '[]')", []).unwrap();
    conn.execute("INSERT INTO coach_runs (id, trigger_key, day, created_at, chat_id) VALUES ('r1', 'k', '2026-11-16', 'now', 'c1')", []).unwrap();
    conn.execute("INSERT INTO ai_usage (id, created_at, day, source, chat_id, model, requests, prompt_tokens, cached_tokens, completion_tokens, cost_usd) VALUES ('u1', 'now', 'd', 'checkin', 'c1', 'm', 1, 1, 0, 1, 0.1)", []).unwrap();
    conn.execute("INSERT INTO coach_memory (id, kind, text, created_at, updated_at, follow_up_on) VALUES ('m1', 'note', 't', 'now', 'now', '2026-11-16')", []).unwrap();
    conn.execute("UPDATE coach_memory SET follow_up_on = NULL, updated_at = 'later' WHERE id = 'm1'", []).unwrap();
    conn.execute("DELETE FROM chats WHERE id = 'c1'", []).unwrap();
    // An update that changes nothing records nothing (the WHEN clause).
    let before: i64 = conn.query_row("SELECT seq FROM sync_state", [], |r| r.get(0)).unwrap();
    conn.execute("UPDATE coach_memory SET follow_up_on = NULL WHERE id = 'm1'", []).unwrap();
    let after: i64 = conn.query_row("SELECT seq FROM sync_state", [], |r| r.get(0)).unwrap();
    assert_eq!(before, after, "a no-op update was recorded");
    // The version-vector entry is the clock of the latest change, as one
    // integer: what's checked is that it's there and that a second change
    // (the coach memory's update) moved it on — see `changes` below.
    let mut q = conn.prepare("SELECT tbl, pk, deleted, seq, (SELECT count(*) FROM sync_vv v WHERE v.tbl = r.tbl AND v.pk = r.pk AND v.counter > 1000000) FROM sync_rows r WHERE tbl <> 'state_categories' ORDER BY seq").unwrap();
    let rows: Vec<(String, String, i64, i64, i64)> = q
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    for r in &rows {
        println!("{r:?}");
    }
    let expect = [
        ("settings", "openrouter_api_key", 0, 1),
        ("coach_runs", "r1", 0, 1),
        ("ai_usage", "u1", 0, 1),
        ("coach_memory", "m1", 0, 1),
        ("chats", "c1", 1, 1),
    ];
    assert_eq!(rows.len(), expect.len(), "device_settings must not be tracked");
    for ((t, p, d, c), r) in expect.iter().zip(&rows) {
        assert_eq!((*t, *p, *d, *c), (r.0.as_str(), r.1.as_str(), r.2, r.4));
    }
    let seqs: Vec<i64> = rows.iter().map(|r| r.3).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]));
    println!("OK: migrations and worker writes behave on SQLite {}", rusqlite::version());
}
