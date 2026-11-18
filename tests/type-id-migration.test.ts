import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { must, rowOf, rowsOf } from "./helpers";
import { ID_PREFIXES, typeIdOf } from "../src/lib/ids";
import type { IdPrefix } from "../src/lib/ids";

// Migration 0041 (version 42) re-spells every row id from a bare UUID to the
// TypeID of the same 128 bits. It runs the way tauri-plugin-sql runs it:
// inside a transaction, foreign keys ON — and on every device alike, so it
// must not look like a change to sync.

const MIGRATION = "0041_type_ids.sql";
const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const files = [...rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map((m) => must(m[1], "migration file"));
const read = (f: string) => readFileSync(new URL(`../src-tauri/migrations/${f}`, import.meta.url), "utf8");

function atVersion41(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of files) {
    if (f === MIGRATION) break;
    db.exec(read(f));
  }
  return db;
}

function migrate(db: Database) {
  db.exec("BEGIN");
  db.exec(read(MIGRATION));
  db.exec("COMMIT");
}

const Row = z.record(z.string(), z.unknown());
const all = (db: Database, sql: string, ...args: string[]) => rowsOf(Row, db.query(sql).all(...args));
const one = (db: Database, sql: string, ...args: string[]) => rowOf(Row, db.query(sql).get(...args));
const value = (db: Database, sql: string, ...args: string[]) => rowOf(z.object({ v: z.unknown() }), db.query(sql).get(...args)).v;

const T = "2026-11-01T08:00:00.000Z";
const D = "2026-11-01";

// The TypeID spec's own example.
const SPEC_UUID = "01890a5d-ac96-774b-bcce-b302099a8057";
// A row from before 0038 (`legacyId`), and one imported from Health Connect (v8, `derivedId`).
const LEGACY = "00000000-0000-7000-8000-00000000000c";
const DERIVED = "3b1f0c2e-9a4d-8c71-a5e2-6f0d4b8c9e13";
// Upper case never comes out of the app; read the same anyway.
const UPPER = "0193A1B2-0000-7ABC-8DEF-0123456789AB";

const ids = {
  supplement: UPPER,
  dose: crypto.randomUUID(),
  document: crypto.randomUUID(),
  manual: crypto.randomUUID(),
  revision: crypto.randomUUID(),
  experiment: crypto.randomUUID(),
  trial: crypto.randomUUID(),
  fast: crypto.randomUUID(),
  chat: crypto.randomUUID(),
  run: crypto.randomUUID(),
  usage: crypto.randomUUID(),
  observation: crypto.randomUUID(),
  tag: crypto.randomUUID(),
  category: crypto.randomUUID(),
  performance: crypto.randomUUID(),
  stat: crypto.randomUUID(),
  meal: LEGACY,
  spec: SPEC_UUID,
  workout: DERIVED,
  sleep: crypto.randomUUID(),
  reading: crypto.randomUUID(),
  savedMeal: crypto.randomUUID(),
  message1: crypto.randomUUID(),
  message2: crypto.randomUUID(),
  capture: crypto.randomUUID(),
  goneCapture: crypto.randomUUID(),
  memory: crypto.randomUUID(),
  photo: crypto.randomUUID(),
  deletedImport: crypto.randomUUID(),
  goneWorkout: crypto.randomUUID(),
  garminSleep: crypto.randomUUID(),
  mystery: crypto.randomUUID(),
  notes: [0, 1, 2, 3, 4, 5].map(() => crypto.randomUUID()),
};

function seed(db: Database) {
  const n = ids.notes;
  db.exec(`
    INSERT INTO supplements (id, name) VALUES ('${ids.supplement}', 'D3');
    INSERT INTO supplement_logs (id, supplement_id, taken_at) VALUES ('${ids.dose}', '${ids.supplement}', '${T}');
    INSERT INTO documents (id, created_at, title) VALUES ('${ids.document}', '${T}', 'Labs');
    INSERT INTO document_files (document_id, filename, media_type, data) VALUES ('${ids.document}', 'a.pdf', 'application/pdf', x'00');
    INSERT INTO manuals (id, title, situation, body, edited_by, created_at, updated_at) VALUES ('${ids.manual}', 'M', 's', 'b', 'you', '${T}', '${T}');
    INSERT INTO manual_revisions (id, manual_id, title, situation, body, edited_by, written_at) VALUES ('${ids.revision}', '${ids.manual}', 'M', 's', 'b', 'you', '${T}');
    INSERT INTO fasts (id, started_at, goal_hours) VALUES ('${ids.fast}', '${T}', 16), ('junk-fast', '${T}', 12);
    INSERT INTO experiments (id, title, hypothesis, arms, measures, assignment, target_per_arm, status, manual_id, created_at, updated_at)
      VALUES ('${ids.experiment}', 'E', 'h', '[]', '[]', 'balanced', 3, 'running', '${ids.manual}', '${T}', '${T}');
    INSERT INTO experiment_trials (id, experiment_id, arm, fast_id, started_at, day, tz_offset_min, created_at, updated_at)
      VALUES ('${ids.trial}', '${ids.experiment}', 'A', '${ids.fast}', '${T}', '${D}', 60, '${T}', '${T}');
    INSERT INTO chats (id, created_at, updated_at, title, messages)
      VALUES ('${ids.chat}', '${T}', '${T}', 'Hi', '[{"role":"user","content":"about ${ids.meal}"}]');
    INSERT INTO coach_runs (id, trigger_key, day, created_at, chat_id) VALUES ('${ids.run}', 'k', '${D}', '${T}', '${ids.chat}');
    INSERT INTO ai_usage (id, created_at, day, source, chat_id, model, requests, prompt_tokens, cached_tokens, completion_tokens, cost_usd)
      VALUES ('${ids.usage}', '${T}', '${D}', 'coach', '${ids.chat}', 'm', 1, 1, 0, 1, 0.1);
    INSERT INTO state_logs (id, logged_at, day, tz_offset_min) VALUES ('${ids.observation}', '${T}', '${D}', 60);
    INSERT INTO state_log_tags (id, log_id, label) VALUES ('${ids.tag}', '${ids.observation}', 'Tired');
    INSERT INTO state_categories (id, label, icon, created_at) VALUES ('${ids.category}', 'Foggy', 'x', '${T}');
    INSERT INTO performance_logs (id, measured_at, title, day, tz_offset_min) VALUES ('${ids.performance}', '${T}', 'Squat', '${D}', 60);
    INSERT INTO performance_stats (id, log_id, metric, label, value) VALUES ('${ids.stat}', '${ids.performance}', 'kg', 'Weight', 100);
    INSERT INTO food_entries (id, eaten_at, title) VALUES ('${ids.meal}', '${T}', 'Oats'), ('${ids.spec}', '${T}', 'Spec');
    INSERT INTO saved_meals (id, name, source_entry_id, created_at, updated_at) VALUES ('${ids.savedMeal}', 'Oats', '${ids.meal}', '${T}', '${T}');
    INSERT INTO workouts (id, performed_at, title) VALUES ('${ids.workout}', '${T}', 'Run');
    INSERT INTO garmin_activities (activity_id, workout_id, started_at, updated_at) VALUES ('g1', '${ids.workout}', '${T}', '${T}');
    INSERT INTO garmin_days (day, sleep_id, fetched_at) VALUES ('${D}', '${ids.garminSleep}', '${T}');
    INSERT INTO sleep_sessions (id, external_id, started_at, ended_at, duration_min) VALUES ('${ids.sleep}', 'hc-1', '${T}', '${T}', 420);
    INSERT INTO blood_readings (id, measured_at, kind, value, day, tz_offset_min) VALUES ('${ids.reading}', '${T}', 'glucose', 5.1, '${D}', 60);
    INSERT INTO entry_messages (id, entry_kind, entry_id, role, text, before_entry, created_at) VALUES
      ('${ids.message1}', 'meal', '${ids.meal}', 'user', 'less', '{"id":"${ids.meal}","title":"Oats","nutrients":{"calories":300}}', '${T}'),
      ('${ids.message2}', 'workout', '${ids.workout}', 'user', 'longer', '{"id":"${ids.workout}","title":"Run"}', '${T}');
    INSERT INTO entry_notes (id, entry_kind, entry_id, text, created_at) VALUES
      ('${n[0]}', 'meal', '${ids.meal}', 'n', '${T}'),
      ('${n[1]}', 'workout', '${ids.workout}', 'n', '${T}'),
      ('${n[2]}', 'reading', '${ids.reading}', 'n', '${T}'),
      ('${n[3]}', 'state', '${ids.observation}', 'n', '${T}'),
      ('${n[4]}', 'performance', '${ids.performance}', 'n', '${T}'),
      ('${n[5]}', 'sleep', '${ids.sleep}', 'n', '${T}');
    INSERT INTO captures (id, created_at, day) VALUES ('${ids.capture}', '${T}', '${D}'), ('${ids.goneCapture}', '${T}', '${D}');
    DELETE FROM captures WHERE id = '${ids.goneCapture}';
    INSERT INTO coach_memory (id, kind, text, created_at, updated_at) VALUES ('${ids.memory}', 'note', 't', '${T}', '${T}');
    INSERT INTO progress_photos (id, taken_at, day, tz_offset_min, photo_path) VALUES ('${ids.photo}', '${T}', '${D}', 60, 'p.jpg');
    INSERT INTO deleted_imports (id, external_id, started_at, ended_at, deleted_at) VALUES ('${ids.deletedImport}', 'hc-9', '${T}', '${T}', '${T}');
    INSERT INTO device_settings (key, value) VALUES ('coach_unread_chat', '${ids.chat}'), ('garmin_last_sync_at', '${T}');
    INSERT INTO settings (key, value) VALUES ('calorie_target_kcal', '2000');
    -- What the sync engine writes for other devices' changes: another
    -- device's tombstone for a row never seen here, and its vector entry.
    INSERT INTO sync_rows (tbl, pk, hlc, origin, deleted, seq, from_peer)
      VALUES ('workouts', '${ids.goneWorkout}', '0000000000001.000000', 'other-device', 1, 9999, 'other-device');
    INSERT INTO sync_vv (tbl, pk, device, counter) VALUES ('workouts', '${ids.goneWorkout}', 'other-device', 5),
      ('food_entries', '${ids.meal}', 'other-device', 7);
  `);
}

const SyncRow = z.object({ r: z.number(), tbl: z.string(), pk: z.string(), hlc: z.string(), origin: z.string(), deleted: z.number(), seq: z.number(), from_peer: z.string().nullable() });
const VvRow = z.object({ r: z.number(), tbl: z.string(), pk: z.string(), device: z.string(), counter: z.number() });
const syncRows = (db: Database) => rowsOf(SyncRow, db.query("SELECT rowid AS r, * FROM sync_rows ORDER BY rowid").all());
const vvRows = (db: Database) => rowsOf(VvRow, db.query("SELECT rowid AS r, * FROM sync_vv ORDER BY rowid").all());
const syncState = (db: Database) => one(db, "SELECT * FROM sync_state");
const triggers = (db: Database) => all(db, "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");

/** The sync pk's prefix by table, as the migration's own inventory doesn't know it. */
const PK_PREFIX: Record<string, IdPrefix> = { ...ID_PREFIXES, document_files: "document" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("migration 0041 (type ids)", () => {
  test("re-spells every id and every reference to one", () => {
    const db = atVersion41();
    seed(db);
    migrate(db);

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const ty = typeIdOf;
    expect(one(db, "SELECT id FROM food_entries WHERE title = 'Spec'")).toEqual({ id: "meal_01h455vb4pex5vsknk084sn02q" });
    expect(one(db, "SELECT id FROM food_entries WHERE title = 'Oats'")).toEqual({ id: ty("meal", LEGACY) });
    expect(one(db, "SELECT id FROM workouts")).toEqual({ id: ty("workout", DERIVED) });
    expect(one(db, "SELECT id FROM supplements")).toEqual({ id: ty("supplement", UPPER) });
    expect(one(db, "SELECT id, supplement_id FROM supplement_logs")).toEqual({ id: ty("dose", ids.dose), supplement_id: ty("supplement", UPPER) });
    expect(one(db, "SELECT document_id FROM document_files")).toEqual({ document_id: ty("document", ids.document) });
    expect(one(db, "SELECT id, manual_id FROM manual_revisions")).toEqual({ id: ty("manual_revision", ids.revision), manual_id: ty("manual", ids.manual) });
    expect(one(db, "SELECT id, manual_id FROM experiments")).toEqual({ id: ty("experiment", ids.experiment), manual_id: ty("manual", ids.manual) });
    expect(one(db, "SELECT id, experiment_id, fast_id FROM experiment_trials")).toEqual({
      id: ty("trial", ids.trial),
      experiment_id: ty("experiment", ids.experiment),
      fast_id: ty("fast", ids.fast),
    });
    expect(one(db, "SELECT id, chat_id FROM coach_runs")).toEqual({ id: ty("coach_run", ids.run), chat_id: ty("chat", ids.chat) });
    expect(one(db, "SELECT id, chat_id FROM ai_usage")).toEqual({ id: ty("ai_usage", ids.usage), chat_id: ty("chat", ids.chat) });
    expect(one(db, "SELECT id, log_id FROM state_log_tags")).toEqual({ id: ty("observation_tag", ids.tag), log_id: ty("observation", ids.observation) });
    expect(one(db, "SELECT id, log_id FROM performance_stats")).toEqual({ id: ty("performance_stat", ids.stat), log_id: ty("performance", ids.performance) });
    expect(one(db, "SELECT id, source_entry_id FROM saved_meals")).toEqual({ id: ty("saved_meal", ids.savedMeal), source_entry_id: ty("meal", LEGACY) });
    expect(one(db, "SELECT workout_id FROM garmin_activities")).toEqual({ workout_id: ty("workout", DERIVED) });
    expect(one(db, "SELECT id FROM state_categories WHERE label = 'Foggy'")).toEqual({ id: ty("tag", ids.category) });
    expect(one(db, "SELECT id FROM captures")).toEqual({ id: ty("capture", ids.capture) });
    expect(one(db, "SELECT id FROM coach_memory")).toEqual({ id: ty("memory", ids.memory) });
    expect(one(db, "SELECT id FROM progress_photos")).toEqual({ id: ty("progress_photo", ids.photo) });
    expect(one(db, "SELECT id FROM deleted_imports")).toEqual({ id: ty("deleted_import", ids.deletedImport) });
    expect(one(db, "SELECT id FROM sleep_sessions")).toEqual({ id: ty("sleep", ids.sleep) });
    expect(one(db, "SELECT id FROM blood_readings")).toEqual({ id: ty("reading", ids.reading) });
    expect(one(db, "SELECT id FROM chats")).toEqual({ id: ty("chat", ids.chat) });

    // Polymorphic references follow their entry_kind; the kind itself stays.
    expect(all(db, "SELECT id, entry_kind, entry_id FROM entry_notes ORDER BY rowid")).toEqual([
      { id: ty("note", must(ids.notes[0], "note")), entry_kind: "meal", entry_id: ty("meal", LEGACY) },
      { id: ty("note", must(ids.notes[1], "note")), entry_kind: "workout", entry_id: ty("workout", DERIVED) },
      { id: ty("note", must(ids.notes[2], "note")), entry_kind: "reading", entry_id: ty("reading", ids.reading) },
      { id: ty("note", must(ids.notes[3], "note")), entry_kind: "state", entry_id: ty("observation", ids.observation) },
      { id: ty("note", must(ids.notes[4], "note")), entry_kind: "performance", entry_id: ty("performance", ids.performance) },
      { id: ty("note", must(ids.notes[5], "note")), entry_kind: "sleep", entry_id: ty("sleep", ids.sleep) },
    ]);
    // The undo snapshot's id is re-spelled inside the JSON; the rest of it is untouched.
    expect(
      all(db, "SELECT id, entry_id, json_extract(before_entry, '$.id') AS before_id, json_extract(before_entry, '$.title') AS title, json_extract(before_entry, '$.nutrients.calories') AS kcal FROM entry_messages ORDER BY rowid"),
    ).toEqual([
      { id: ty("entry_message", ids.message1), entry_id: ty("meal", LEGACY), before_id: ty("meal", LEGACY), title: "Oats", kcal: 300 },
      { id: ty("entry_message", ids.message2), entry_id: ty("workout", DERIVED), before_id: ty("workout", DERIVED), title: "Run", kcal: null },
    ]);

    // The unread chat follows its chat; other settings are as they were.
    expect(all(db, "SELECT key, value FROM device_settings ORDER BY key")).toEqual([
      { key: "coach_unread_chat", value: ty("chat", ids.chat) },
      { key: "garmin_last_sync_at", value: T },
    ]);
    expect(value(db, "SELECT value AS v FROM settings WHERE key = 'calorie_target_kcal'")).toBe("2000");

    // Left as they are: a transcript (idArg reads the old spelling), Garmin's
    // own sleep id, and a value that was never a UUID.
    expect(value(db, "SELECT messages AS v FROM chats")).toContain(ids.meal);
    expect(value(db, "SELECT sleep_id AS v FROM garmin_days")).toBe(ids.garminSleep);
    expect(value(db, "SELECT count(*) AS v FROM fasts WHERE id = 'junk-fast'")).toBe(1);
    expect(value(db, "SELECT count(*) AS v FROM sync_rows WHERE pk = 'junk-fast'")).toBe(1);
  });

  test("no UUID is left where a row id belongs", () => {
    const db = atVersion41();
    seed(db);
    migrate(db);
    const tables = [...Object.keys(ID_PREFIXES), "document_files", "garmin_activities", "device_settings", "sync_rows", "sync_vv"];
    // Not row ids: a transcript, Garmin's sleep id, and devices' own ids.
    const notIds = new Set(["chats.messages", "sync_rows.origin", "sync_rows.from_peer", "sync_vv.device"]);
    const left: string[] = [];
    for (const t of tables) {
      for (const r of all(db, `SELECT * FROM "${t}"`)) {
        for (const [c, v] of Object.entries(r)) {
          if (!notIds.has(`${t}.${c}`) && typeof v === "string" && UUID.test(v)) left.push(`${t}.${c} = ${v}`);
        }
      }
    }
    // The entry note of an unknown kind isn't seeded here, so nothing at all.
    expect(left).toEqual([]);
  });

  test("is not a change to sync: bookkeeping re-spelled, nothing recorded", () => {
    const db = atVersion41();
    seed(db);
    const rowsBefore = syncRows(db);
    const vvBefore = vvRows(db);
    const stateBefore = syncState(db);
    const triggersBefore = triggers(db);
    // The tombstones are there to be converted.
    expect(rowsBefore.find((r) => r.pk === ids.goneCapture)).toMatchObject({ tbl: "captures", deleted: 1 });
    expect(rowsBefore.length).toBeGreaterThan(30);

    migrate(db);

    const conv = (tbl: string, pk: string) => {
      const p = PK_PREFIX[tbl];
      return p && UUID.test(pk) ? typeIdOf(p, pk) : pk;
    };
    expect(syncRows(db)).toEqual(rowsBefore.map((r) => ({ ...r, pk: conv(r.tbl, r.pk) })));
    expect(vvRows(db)).toEqual(vvBefore.map((r) => ({ ...r, pk: conv(r.tbl, r.pk) })));
    expect(syncState(db)).toEqual(stateBefore);
    expect(syncRows(db).find((r) => r.tbl === "captures" && r.deleted === 1)?.pk).toBe(typeIdOf("capture", ids.goneCapture));
    expect(syncRows(db).find((r) => r.origin === "other-device")?.pk).toBe(typeIdOf("workout", ids.goneWorkout));
    expect(syncRows(db).find((r) => r.tbl === "document_files")?.pk).toBe(typeIdOf("document", ids.document));
    // Every trigger is back, exactly as it was.
    expect(triggers(db)).toEqual(triggersBefore);
    expect(value(db, "SELECT count(*) AS v FROM sqlite_temp_master")).toBe(0);
  });

  test("triggers record writes made afterwards, under the new ids", () => {
    const db = atVersion41();
    seed(db);
    migrate(db);
    const seq = rowOf(z.object({ seq: z.number() }), db.query("SELECT seq FROM sync_state").get()).seq;

    const fresh = "fast_01jd4x8m2kf7r9q3vz5w6t0hyc";
    db.exec(`INSERT INTO fasts (id, started_at, goal_hours) VALUES ('${fresh}', '${T}', 16)`);
    expect(one(db, "SELECT deleted, seq FROM sync_rows WHERE tbl = 'fasts' AND pk = ?", fresh)).toEqual({ deleted: 0, seq: seq + 1 });

    const meal = typeIdOf("meal", LEGACY);
    db.exec(`UPDATE food_entries SET title = 'Porridge' WHERE id = '${meal}'`);
    expect(one(db, "SELECT seq FROM sync_rows WHERE tbl = 'food_entries' AND pk = ?", meal)).toEqual({ seq: seq + 2 });

    db.exec(`DELETE FROM documents WHERE id = '${typeIdOf("document", ids.document)}'`);
    // The file went with it (ON DELETE CASCADE still holds), recorded under the document's id.
    expect(value(db, "SELECT count(*) AS v FROM document_files")).toBe(0);
    expect(one(db, "SELECT deleted FROM sync_rows WHERE tbl = 'document_files' AND pk = ?", typeIdOf("document", ids.document))).toEqual({ deleted: 1 });
    // References are still enforced.
    expect(() => db.exec(`INSERT INTO supplement_logs (id, supplement_id, taken_at) VALUES ('dose_x', 'supplement_missing', '${T}')`)).toThrow();
  });

  test("running it again changes nothing", () => {
    const db = atVersion41();
    seed(db);
    migrate(db);
    const snapshot = (d: Database) =>
      ["food_entries", "entry_messages", "entry_notes", "supplement_logs", "sync_rows", "sync_vv", "device_settings"].map((t) => all(d, `SELECT * FROM "${t}" ORDER BY rowid`));
    const once = snapshot(db);
    migrate(db);
    expect(snapshot(db)).toEqual(once);
  });

  test("an entry of a kind it doesn't know keeps its entry_id", () => {
    const db = atVersion41();
    db.exec(`INSERT INTO entry_notes (id, entry_kind, entry_id, text, created_at) VALUES ('${ids.notes[0] ?? ""}', 'mystery', '${ids.mystery}', 'n', '${T}')`);
    migrate(db);
    expect(one(db, "SELECT id, entry_id FROM entry_notes")).toEqual({ id: typeIdOf("note", must(ids.notes[0], "note")), entry_id: ids.mystery });
  });

  test("the SQL encoder agrees with typeIdOf", () => {
    const db = atVersion41();
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const uuidOf = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    const uuids = [
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "80000000-0000-0000-0000-000000000001",
      "7fffffff-ffff-ffff-ffff-fffffffffffe",
      SPEC_UUID,
      LEGACY,
      DERIVED,
      ...Array.from({ length: 200 }, () => uuidOf(hex(crypto.getRandomValues(new Uint8Array(16))))),
    ];
    const insert = db.query("INSERT INTO food_entries (id, eaten_at, title) VALUES (?, ?, ?)");
    uuids.forEach((u, i) => insert.run(i % 3 === 0 ? u.toUpperCase() : u, T, String(i)));
    migrate(db);
    const got = rowsOf(z.object({ id: z.string(), title: z.string() }), db.query("SELECT id, title FROM food_entries").all());
    expect(got).toHaveLength(uuids.length);
    for (const r of got) expect(r.id).toBe(typeIdOf("meal", must(uuids[Number(r.title)], "uuid")));
    expect(got.find((r) => r.title === "0")?.id).toBe("meal_00000000000000000000000000");
    expect(got.find((r) => r.title === "1")?.id).toBe("meal_7zzzzzzzzzzzzzzzzzzzzzzzzz");
  });

  test("every table keyed by a row id is converted", () => {
    // A table added to ID_PREFIXES later needs the migration regenerated.
    const sql = read(MIGRATION);
    for (const t of Object.keys(ID_PREFIXES)) expect(sql).toContain(`UPDATE "${t}" SET "id" = m.new`);
  });
});
