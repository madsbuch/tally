import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { must, rowOf, rowsOf } from "./helpers";

// Migration 0038 re-keys every table from integers to UUID strings. It runs
// the way tauri-plugin-sql runs it: inside a transaction, foreign keys ON.

const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const files = [...rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map((m) => must(m[1], "migration file"));
const read = (f: string) => readFileSync(new URL(`../src-tauri/migrations/${f}`, import.meta.url), "utf8");

function beforeUuids(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of files) {
    if (f === "0038_uuid_ids.sql") break;
    db.exec(read(f));
  }
  return db;
}

function migrate(db: Database) {
  db.exec("BEGIN");
  db.exec(read("0038_uuid_ids.sql"));
  db.exec("COMMIT");
}

const T = "2026-01-01T08:00:00.000Z";

/** The id 0038 gives the row that had integer `n` (before 0041 re-spelled it as a TypeID). */
const legacyId = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

describe("migration 0038 (uuid ids)", () => {
  test("re-keys rows and every reference to them", () => {
    const db = beforeUuids();
    db.exec(`
      INSERT INTO food_entries (id, eaten_at, title, nutrients, diet) VALUES (7, '${T}', 'Oats', '{}', 'x');
      INSERT INTO workouts (id, performed_at, title, external_id) VALUES (3, '${T}', 'Run', 'hc-1');
      INSERT INTO supplements (id, name) VALUES (2, 'D3');
      INSERT INTO supplement_logs (id, supplement_id, taken_at) VALUES (1, 2, '${T}');
      INSERT INTO chats (id, created_at, updated_at, title, messages) VALUES (12, '${T}', '${T}', 'Hi', '[]');
      INSERT INTO coach_runs (id, trigger_key, day, created_at, chat_id) VALUES (1, 'k', '2026-01-01', '${T}', 12);
      INSERT INTO coach_runs (id, trigger_key, day, created_at, chat_id) VALUES (2, 'k', '2026-01-01', '${T}', NULL);
      INSERT INTO documents (id, created_at, title) VALUES (5, '${T}', 'Labs');
      INSERT INTO document_files (document_id, filename, media_type, data) VALUES (5, 'a.pdf', 'application/pdf', x'00');
      INSERT INTO manuals (id, title, situation, body, edited_by, created_at, updated_at) VALUES (4, 'M', 's', 'b', 'you', '${T}', '${T}');
      INSERT INTO manual_revisions (id, manual_id, title, situation, body, edited_by, written_at) VALUES (1, 4, 'M', 's', 'b', 'you', '${T}');
      INSERT INTO state_logs (id, logged_at, day, tz_offset_min) VALUES (9, '${T}', '2026-01-01', 60);
      INSERT INTO state_log_tags (id, log_id, label) VALUES (1, 9, 'Bloated'), (2, 9, 'Tired');
      INSERT INTO entry_messages (id, entry_kind, entry_id, role, text, before_entry, created_at)
        VALUES (1, 'meal', 7, 'user', 'less', '{"id":7,"title":"Oats"}', '${T}');
      INSERT INTO entry_notes (id, entry_kind, entry_id, text, created_at) VALUES (1, 'workout', 3, 'n', '${T}');
      INSERT INTO garmin_activities (activity_id, workout_id, started_at, updated_at) VALUES ('g1', 3, '${T}', '${T}');
      INSERT INTO settings (key, value) VALUES ('coach_unread_chat', '12'), ('calorie_target_kcal', '2000'),
        ('garmin_last_sync_at', '${T}'), ('openrouter_api_key', 'sk');
    `);

    migrate(db);

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const one = (sql: string) => rowOf(z.record(z.string(), z.unknown()), db.query(sql).get());

    expect(one("SELECT id, title FROM food_entries")).toEqual({ id: legacyId(7), title: "Oats" });
    expect(one("SELECT supplement_id FROM supplement_logs").supplement_id).toBe(legacyId(2));
    expect(db.query("SELECT chat_id FROM coach_runs ORDER BY id").all()).toEqual([
      { chat_id: legacyId(12) },
      { chat_id: null },
    ]);
    expect(one("SELECT document_id FROM document_files").document_id).toBe(legacyId(5));
    expect(one("SELECT manual_id FROM manual_revisions").manual_id).toBe(legacyId(4));
    expect(db.query("SELECT log_id, label FROM state_log_tags ORDER BY id").all()).toEqual([
      { log_id: legacyId(9), label: "Bloated" },
      { log_id: legacyId(9), label: "Tired" },
    ]);
    const msg = one("SELECT entry_id, before_entry FROM entry_messages");
    expect(msg.entry_id).toBe(legacyId(7));
    expect(db.query("SELECT json_extract(before_entry, '$.id') AS id FROM entry_messages").get()).toEqual({
      id: legacyId(7),
    });
    expect(one("SELECT entry_id FROM entry_notes").entry_id).toBe(legacyId(3));
    expect(one("SELECT workout_id FROM garmin_activities").workout_id).toBe(legacyId(3));

    // The diet column is gone.
    const cols = rowsOf(z.object({ name: z.string() }), db.query("PRAGMA table_info(food_entries)").all());
    expect(cols.map((c) => c.name)).not.toContain("diet");

    // Device-local settings moved out; the unread chat points at its new id.
    expect(db.query("SELECT key FROM settings ORDER BY key").all()).toEqual([
      { key: "calorie_target_kcal" },
      { key: "openrouter_api_key" },
    ]);
    expect(db.query("SELECT key, value FROM device_settings ORDER BY key").all()).toEqual([
      { key: "coach_unread_chat", value: legacyId(12) },
      { key: "garmin_last_sync_at", value: T },
    ]);
  });

  test("references still hold after the rename", () => {
    const db = beforeUuids();
    db.exec(`INSERT INTO documents (id, created_at, title) VALUES (1, '${T}', 'Labs');
      INSERT INTO document_files (document_id, filename, media_type, data) VALUES (1, 'a.pdf', 'application/pdf', x'00');`);
    migrate(db);
    // A child pointing nowhere is refused…
    expect(() =>
      db.exec(`INSERT INTO supplement_logs (id, supplement_id, taken_at) VALUES ('x', 'missing', '${T}')`),
    ).toThrow();
    // …and deleting a document still takes its file with it.
    db.exec(`DELETE FROM documents WHERE id = '${legacyId(1)}'`);
    expect(db.query("SELECT COUNT(*) AS n FROM document_files").get()).toEqual({ n: 0 });
    // Nothing still points at the scaffolding names.
    const sql = rowOf(z.object({ s: z.string() }), db.query("SELECT group_concat(sql) AS s FROM sqlite_master").get());
    expect(sql.s).not.toContain("__new_");
  });
});
