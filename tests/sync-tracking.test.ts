import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { at, must, rowOf, rowsOf } from "./helpers";
import { sqlite } from "./testDb";
import { LOCAL_TABLES } from "../scripts/sync-triggers";

// Change tracking (migration 0039): every write to a synced table, whichever
// code path makes it, leaves a version in sync_rows and a count in sync_vv.

const { addFoodEntry, updateFoodEntry, deleteFoodEntry, getFoodEntry, setSetting, addCapture, listPendingCaptures, createChat, chatVersion, updateChatMessagesIf } = await import("../src/lib/db");

const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const files = [...rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map((m) => must(m[1], "migration file"));
const read = (f: string) => readFileSync(new URL(`../src-tauri/migrations/${f}`, import.meta.url), "utf8");

// Version-vector entries are clock values as 64-bit integers (~1.8e18):
// beyond what a JS number holds exactly, so they're read as text and
// compared as BigInt.
const VersionRow = z.object({ hlc: z.string(), origin: z.string(), deleted: z.number(), seq: z.number(), vv: z.string() });
const NameRow = z.object({ name: z.string() });
const DeviceRow = z.object({ device_id: z.string() });
function versionOf(db: Database, tbl: string, pk: string) {
  const r = VersionRow.nullable().parse(db
    .query(
      `SELECT hlc, origin, deleted, seq,
         (SELECT CAST(coalesce(sum(counter), 0) AS TEXT) FROM sync_vv v WHERE v.tbl = r.tbl AND v.pk = r.pk) AS vv
       FROM sync_rows r WHERE tbl = ? AND pk = ?`,
    )
    .get(tbl, pk));
  return r ? { ...r, vv: BigInt(r.vv) } : null;
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
    const tables = rowsOf(NameRow, sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((t) => t.name);
    const triggers = new Set(rowsOf(NameRow, sqlite.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).map((t) => t.name));
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
    const triggers = rowsOf(
      z.object({ tbl_name: z.string(), sql: z.string() }),
      sqlite.query("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%\\_au' ESCAPE '\\'").all(),
    );
    expect(triggers.length).toBeGreaterThan(30);
    for (const t of triggers) {
      const watched = [...t.sql.matchAll(/OLD\.`([^`]+)` IS NOT NEW\./g)].map((m) => must(m[1], "column")).sort();
      const columns = rowsOf(NameRow, sqlite.query(`PRAGMA table_info("${t.tbl_name}")`).all()).map((c) => c.name).sort();
      expect({ table: t.tbl_name, watched }).toEqual({ table: t.tbl_name, watched: columns });
    }
  });

  test("inserts, updates and deletes from the app are recorded", async () => {
    const id = await addFoodEntry(meal);
    const v1 = must(versionOf(sqlite, "food_entries", id), "a sync version");
    expect(v1.deleted).toBe(0);
    expect(v1.vv > 0n).toBe(true);
    const device = rowOf(DeviceRow, sqlite.query("SELECT device_id FROM sync_state").get()).device_id;
    expect(v1.origin).toBe(device);

    await updateFoodEntry({ ...must(await getFoodEntry(id), "the meal"), title: "Porridge" });
    const v2 = must(versionOf(sqlite, "food_entries", id), "a sync version");
    expect(v2.vv > v1.vv).toBe(true);
    expect(v2.seq).toBeGreaterThan(v1.seq);
    expect(v2.hlc > v1.hlc).toBe(true);

    await deleteFoodEntry(id);
    const v3 = must(versionOf(sqlite, "food_entries", id), "a sync version");
    expect(v3.deleted).toBe(1);
    expect(v3.vv > v2.vv).toBe(true);
    expect(v3.hlc > v2.hlc).toBe(true);
  });

  test("upserts are recorded; device-local settings are not", async () => {
    await setSetting("calorie_target_kcal", "2000");
    const first = must(versionOf(sqlite, "settings", "calorie_target_kcal"), "a sync version");
    await setSetting("calorie_target_kcal", "2100");
    const second = must(versionOf(sqlite, "settings", "calorie_target_kcal"), "a sync version");
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
    const before = rowOf(z.object({ h: z.string() }), sqlite.query("SELECT max(hlc) AS h FROM sync_rows").get()).h;
    for (let i = 0; i < 50; i++) {
      sqlite.query("INSERT INTO incomplete_days (day, updated_at) VALUES (?, 'x')").run(`2030-01-${String(i + 1).padStart(2, "0")}`.slice(0, 10) + `-${i}`);
    }
    const hlcs = rowsOf(z.object({ hlc: z.string() }), sqlite.query("SELECT hlc FROM sync_rows WHERE tbl = 'incomplete_days' ORDER BY seq").all()).map((r) => r.hlc);
    expect(hlcs).toHaveLength(50);
    for (let i = 1; i < hlcs.length; i++) expect(at(hlcs, i) > at(hlcs, i - 1)).toBe(true);
    expect(at(hlcs, 0) > before).toBe(true);
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
    const v = must(await chatVersion(id), "the chat's version");
    expect(v.mine).toBe(true);
    expect(await updateChatMessagesIf(id, [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }], v.hlc)).toBe(true);
    const v2 = must(await chatVersion(id), "the chat's version");
    expect(v2.hlc > v.hlc).toBe(true);
    // Another device's version lands (as the sync engine writes it).
    sqlite.exec(`UPDATE sync_state SET applying = 1;
      UPDATE chats SET messages = '[{"role":"user","content":"q1"},{"role":"user","content":"from the mac"}]' WHERE id = '${id}';
      UPDATE sync_rows SET hlc = '9999999999998.000000', origin = 'the-mac' WHERE tbl = 'chats' AND pk = '${id}';
      UPDATE sync_state SET applying = 0;`);
    // Whose it is: a device of the vault by name, or unknown.
    expect(must(await chatVersion(id), "the chat's version")).toMatchObject({ mine: false, device: null });
    sqlite.exec(`UPDATE sync_state SET applying = 1;
      INSERT INTO vault_devices (id, name, public_key, platform, added_at) VALUES ('the-mac', 'Studio Mac', 'k', 'macos', '2026-11-16T08:00:00.000Z');
      UPDATE sync_state SET applying = 0;`);
    expect(must(await chatVersion(id), "the chat's version")).toMatchObject({ mine: false, device: "Studio Mac" });
    // A save built on the old version doesn't touch theirs.
    expect(await updateChatMessagesIf(id, [{ role: "user", content: "stale" }], v2.hlc)).toBe(false);
    const row = rowOf(z.object({ messages: z.string() }), sqlite.query("SELECT messages FROM chats WHERE id = ?").get(id));
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

    const rows = rowsOf(z.object({ tbl: z.string(), pk: z.string(), seq: z.number() }), db.query("SELECT tbl, pk, deleted, seq FROM sync_rows ORDER BY seq").all());
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
    const state = rowOf(z.object({ seq: z.number(), device_id: z.string() }), db.query("SELECT seq, device_id FROM sync_state").get());
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
      return rowOf(DeviceRow, db.query("SELECT device_id FROM sync_state").get()).device_id;
    });
    expect(ids[0]).not.toBe(ids[1]);
  });
});
