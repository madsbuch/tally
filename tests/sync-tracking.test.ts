import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { sqlite } from "./testDb";
import { LOCAL_TABLES } from "../scripts/sync-triggers";

// Change tracking (migration 0039): every write to a synced table, whichever
// code path makes it, leaves a version in sync_rows and a count in sync_vv.

const { addFoodEntry, updateFoodEntry, deleteFoodEntry, getFoodEntry, setSetting, addCapture, listPendingCaptures, createChat, chatVersion, updateChatMessagesIf } = await import("../src/lib/db");

const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const files = [...rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map((m) => m[1]!);
const read = (f: string) => readFileSync(new URL(`../src-tauri/migrations/${f}`, import.meta.url), "utf8");

type Version = { hlc: string; origin: string; deleted: number; seq: number; vv: number };
function versionOf(db: Database, tbl: string, pk: string): Version | null {
  return db
    .query(
      `SELECT hlc, origin, deleted, seq,
         (SELECT coalesce(sum(counter), 0) FROM sync_vv v WHERE v.tbl = r.tbl AND v.pk = r.pk) AS vv
       FROM sync_rows r WHERE tbl = ? AND pk = ?`,
    )
    .get(tbl, pk) as Version | null;
}

const meal = {
  eaten_at: "2026-11-16T08:00:00.000Z",
  title: "Oats",
  description: null,
  photo_path: null,
  nutrients: { calories: 300 },
  model_id: null,
  icon: null,
};

describe("sync tracking", () => {
  test("every table is either tracked by all three triggers or declared local", () => {
    const tables = (sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    const triggers = new Set((sqlite.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((t) => t.name));
    const untracked: string[] = [];
    for (const t of tables) {
      const has = ["ai", "au", "ad"].map((k) => triggers.has(`sync_${t}_${k}`));
      if (LOCAL_TABLES.includes(t)) {
        expect(has).toEqual([false, false, false]);
      } else if (!has.every(Boolean)) {
        untracked.push(t);
      }
    }
    // A table here was added (or rebuilt, which drops triggers) without its
    // sync triggers: generate them with `bun scripts/sync-triggers.ts <table>`.
    expect(untracked).toEqual([]);
    expect(tables.length - LOCAL_TABLES.filter((t) => tables.includes(t)).length).toBeGreaterThan(30);
  });

  test("every update trigger watches every column of its table", () => {
    // A column added later (ALTER TABLE … ADD) must be added to the trigger's
    // list too — `bun scripts/sync-triggers.ts --retrigger <table>` — or
    // changes to it alone would never sync.
    const triggers = sqlite.query("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%\\_au' ESCAPE '\\'").all() as { tbl_name: string; sql: string }[];
    expect(triggers.length).toBeGreaterThan(30);
    for (const t of triggers) {
      const watched = [...t.sql.matchAll(/OLD\.`([^`]+)` IS NOT NEW\./g)].map((m) => m[1]!).sort();
      const columns = (sqlite.query(`PRAGMA table_info("${t.tbl_name}")`).all() as { name: string }[]).map((c) => c.name).sort();
      expect({ table: t.tbl_name, watched }).toEqual({ table: t.tbl_name, watched: columns });
    }
  });

  test("inserts, updates and deletes from the app are recorded", async () => {
    const id = await addFoodEntry(meal);
    const v1 = versionOf(sqlite, "food_entries", id)!;
    expect(v1.deleted).toBe(0);
    expect(v1.vv).toBeGreaterThan(0);
    const device = (sqlite.query("SELECT device_id FROM sync_state").get() as { device_id: string }).device_id;
    expect(v1.origin).toBe(device);

    await updateFoodEntry({ ...(await getFoodEntry(id))!, title: "Porridge" });
    const v2 = versionOf(sqlite, "food_entries", id)!;
    expect(v2.vv).toBeGreaterThan(v1.vv);
    expect(v2.seq).toBeGreaterThan(v1.seq);
    expect(v2.hlc > v1.hlc).toBe(true);

    await deleteFoodEntry(id);
    const v3 = versionOf(sqlite, "food_entries", id)!;
    expect(v3.deleted).toBe(1);
    expect(v3.vv).toBeGreaterThan(v2.vv);
    expect(v3.hlc > v2.hlc).toBe(true);
  });

  test("upserts are recorded; device-local settings are not", async () => {
    await setSetting("calorie_target_kcal", "2000");
    const first = versionOf(sqlite, "settings", "calorie_target_kcal")!;
    await setSetting("calorie_target_kcal", "2100");
    const second = versionOf(sqlite, "settings", "calorie_target_kcal")!;
    expect(second.deleted).toBe(0);
    expect(second.seq).toBeGreaterThan(first.seq);
    await setSetting("garmin_last_sync_at", "x");
    expect(versionOf(sqlite, "device_settings", "garmin_last_sync_at")).toBeNull();
  });

  test("writes made while the sync engine applies are left to it", () => {
    sqlite.exec("UPDATE sync_state SET applying = 1");
    try {
      sqlite.exec("INSERT INTO fasts (id, started_at, goal_hours) VALUES ('applied-fast', '2026-11-16T08:00:00.000Z', 16)");
    } finally {
      sqlite.exec("UPDATE sync_state SET applying = 0");
    }
    expect(versionOf(sqlite, "fasts", "applied-fast")).toBeNull();
  });

  test("the clock never goes backwards, even within one millisecond", () => {
    const before = (sqlite.query("SELECT max(hlc) AS h FROM sync_rows").get() as { h: string }).h;
    for (let i = 0; i < 50; i++) {
      sqlite.query("INSERT INTO incomplete_days (day, updated_at) VALUES (?, 'x')").run(`2030-01-${String(i + 1).padStart(2, "0")}`.slice(0, 10) + `-${i}`);
    }
    const hlcs = (sqlite.query("SELECT hlc FROM sync_rows WHERE tbl = 'incomplete_days' ORDER BY seq").all() as { hlc: string }[]).map((r) => r.hlc);
    expect(hlcs).toHaveLength(50);
    for (let i = 1; i < hlcs.length; i++) expect(hlcs[i]! > hlcs[i - 1]!).toBe(true);
    expect(hlcs[0]! > before).toBe(true);
  });

  test("cascaded deletes are recorded too", () => {
    sqlite.exec(`INSERT INTO state_logs (id, logged_at, day, tz_offset_min) VALUES ('cascade-log', 'x', '2026-11-16', 60);
      INSERT INTO state_log_tags (id, log_id, label) VALUES ('cascade-tag', 'cascade-log', 'Tired');`);
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("DELETE FROM state_logs WHERE id = 'cascade-log'");
    expect(versionOf(sqlite, "state_log_tags", "cascade-tag")).toMatchObject({ deleted: 1 });
  });
});

describe("saving a chat", () => {
  test("only overwrites the version it was built on", async () => {
    const id = await createChat("Plan", [{ role: "user", content: "q1" }]);
    const v = (await chatVersion(id))!;
    expect(v.mine).toBe(true);
    expect(await updateChatMessagesIf(id, [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }], v.hlc)).toBe(true);
    const v2 = (await chatVersion(id))!;
    expect(v2.hlc > v.hlc).toBe(true);
    // Another device's version lands (as the sync engine writes it).
    sqlite.exec(`UPDATE sync_state SET applying = 1;
      UPDATE chats SET messages = '[{"role":"user","content":"q1"},{"role":"user","content":"from the mac"}]' WHERE id = '${id}';
      UPDATE sync_rows SET hlc = '9999999999998.000000', origin = 'the-mac' WHERE tbl = 'chats' AND pk = '${id}';
      UPDATE sync_state SET applying = 0;`);
    expect((await chatVersion(id))!.mine).toBe(false);
    // A save built on the old version doesn't touch theirs.
    expect(await updateChatMessagesIf(id, [{ role: "user", content: "stale" }], v2.hlc)).toBe(false);
    const row = sqlite.query("SELECT messages FROM chats WHERE id = ?").get(id) as { messages: string };
    expect(row.messages).toContain("from the mac");
  });
});

describe("work waiting on a row", () => {
  test("is only picked up by the device that wrote it", async () => {
    const mine = await addCapture({ created_at: "2026-11-16T08:00:00.000Z", day: "2026-11-16", note: "toast", photo_path: null });
    // As if synced in from the phone: same table, another device's version.
    sqlite.exec(`UPDATE sync_state SET applying = 1;
      INSERT INTO captures (id, created_at, day, note, status) VALUES ('from-phone', '2026-11-16T08:00:00.000Z', '2026-11-16', 'eggs', 'pending');
      INSERT INTO sync_rows (tbl, pk, hlc, origin, deleted, seq) VALUES ('captures', 'from-phone', '0000000000001.000000', 'the-phone', 0, 999999);
      UPDATE sync_state SET applying = 0;`);
    const pending = (await listPendingCaptures()).map((c) => c.id);
    expect(pending).toContain(mine);
    expect(pending).not.toContain("from-phone");
  });
});

describe("migration 0039 on an existing database", () => {
  test("records every row already there, once, in order", () => {
    const db = new Database(":memory:");
    for (const f of files) {
      if (f === "0039_sync.sql") break;
      db.exec(read(f));
    }
    db.exec(`INSERT INTO supplements (id, name) VALUES ('s1', 'D3');
      INSERT INTO supplement_logs (id, supplement_id, taken_at) VALUES ('l1', 's1', 'x'), ('l2', 's1', 'y');
      INSERT INTO photos (filename, data) VALUES ('a.jpg', x'ff');
      INSERT INTO settings (key, value) VALUES ('calorie_target_kcal', '2000');
      INSERT INTO device_settings (key, value) VALUES ('garmin_last_sync_at', 'x');`);
    db.exec("BEGIN");
    db.exec(read("0039_sync.sql"));
    db.exec("COMMIT");

    const rows = db.query("SELECT tbl, pk, deleted, seq FROM sync_rows ORDER BY seq").all() as { tbl: string; pk: string; seq: number }[];
    const tracked = rows.filter((r) => r.tbl !== "state_categories").map((r) => `${r.tbl}/${r.pk}`);
    expect(tracked).toEqual([
      "settings/calorie_target_kcal",
      "supplements/s1",
      "supplement_logs/l1",
      "supplement_logs/l2",
      "photos/a.jpg",
    ]);
    // Seqs are unique, start at 1 and leave no gaps; the counter carries on from there.
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    const state = db.query("SELECT seq, device_id FROM sync_state").get() as { seq: number; device_id: string };
    expect(state.seq).toBe(rows.length);
    expect(state.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(db.query("SELECT count(*) AS n FROM sync_vv").get()).toEqual({ n: rows.length });
    // The next write continues the sequence.
    db.exec("INSERT INTO fasts (id, started_at, goal_hours) VALUES ('f1', 'x', 16)");
    expect(db.query("SELECT seq FROM sync_rows WHERE pk = 'f1'").get()).toEqual({ seq: rows.length + 1 });
  });

  test("two devices get different ids", () => {
    const ids = [0, 1].map(() => {
      const db = new Database(":memory:");
      for (const f of files) db.exec(read(f));
      return (db.query("SELECT device_id FROM sync_state").get() as { device_id: string }).device_id;
    });
    expect(ids[0]).not.toBe(ids[1]);
  });
});
