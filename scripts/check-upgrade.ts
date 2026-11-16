// Dry-runs the app's pending database migrations on a COPY of a database and
// checks nothing was lost: every row of every table is still there, every
// value unchanged (ids re-spelled the way migration 0038 promises), every
// reference still resolves, and SQLite's own integrity checks pass.
//
//   bun scripts/check-upgrade.ts path/to/tally-export.db   # a real database
//   bun scripts/check-upgrade.ts                           # a synthetic one
//
// The database given is never written to: it's copied first (VACUUM INTO, so
// a database still in WAL mode copies whole). Migrations run the way
// tauri-plugin-sql runs them: each in a transaction, foreign keys on.
//
// The synthetic database is the schema as it stood before 0038, filled with
// 60 days' worth of rows in every table, linked to each other the way the app
// links them, with gaps in the ids and NULLs where columns allow them.

import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyId } from "../src/lib/ids";

type Row = Record<string, unknown>;

const root = new URL("..", import.meta.url);
const rust = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");
const migrations = [...rust.matchAll(/version: (\d+),\s*description: "([^"]+)",\s*sql: include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map(
  (m) => ({ version: Number(m[1]), description: m[2]!, file: m[3]! }),
);
const sqlOf = (file: string) => readFileSync(new URL(`src-tauri/migrations/${file}`, root), "utf8");
const UUID_VERSION = migrations.find((m) => m.file === "0038_uuid_ids.sql")!.version;

/** Columns 0038 re-spells from integers to ids (besides `id`). */
const REF_COLUMNS = new Set([
  "supplement_id", "document_id", "manual_id", "experiment_id", "fast_id",
  "chat_id", "entry_id", "log_id", "source_entry_id", "workout_id",
]);
/** Tables whose rows carry their own integer `id` before 0038. */
const DEVICE_KEYS = [
  "models_cache", "models_cache_at",
  "health_connect_last_sync_at", "health_connect_history_synced", "health_connect_resync_version",
  "garmin_last_sync_at", "garmin_display_name", "garmin_activities_backfilled",
  "garmin_wellness_through", "garmin_wellness_back_to", "garmin_paused_until",
  "coach_morning_hour", "coach_prompt_prefix", "coach_unread_chat",
];

const problems: string[] = [];
const notes: string[] = [];
const fail = (msg: string) => problems.push(msg);

// ---------------------------------------------------------------------------
// The database to check
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "tally-upgrade-"));
const workPath = join(scratch, "tally.db");
const given = process.argv[2];

if (given) {
  if (!existsSync(given)) throw new Error(`No such file: ${given}`);
  const src = new Database(given, { readonly: true });
  src.exec(`VACUUM INTO '${workPath.replace(/'/g, "''")}'`);
  src.close();
} else {
  buildSynthetic(workPath);
}

const db = new Database(workPath);
db.exec("PRAGMA foreign_keys = ON");

const applied = new Set<number>(
  tableExists("_sqlx_migrations")
    ? (db.query("SELECT version FROM _sqlx_migrations WHERE success").all() as { version: number }[]).map((r) => r.version)
    : [],
);
const pending = migrations.filter((m) => !applied.has(m.version));
console.log(`Database: ${given ?? "synthetic (60 days)"}`);
console.log(`Applied migrations: ${applied.size}; pending: ${pending.map((m) => m.description).join(", ") || "none"}`);
if (!pending.some((m) => m.version === UUID_VERSION)) {
  console.log("Migration 0038 is already applied here; nothing to check.");
  process.exit(0);
}
for (const m of pending) {
  if (m.version >= UUID_VERSION) break;
  console.log(`Applying ${m.description} first (pending, before 0038)`);
  runMigration(m);
}

// ---------------------------------------------------------------------------
// Before
// ---------------------------------------------------------------------------

const preCheck = db.query("PRAGMA foreign_key_check").all();
if (preCheck.length) {
  fail(`The database already has ${preCheck.length} broken reference(s) before upgrading: ${JSON.stringify(preCheck.slice(0, 5))}`);
}

const tables = (db.query(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations' ORDER BY name",
).all() as { name: string }[]).map((t) => t.name);

const before = new Map<string, Row[]>();
for (const t of tables) before.set(t, db.query(`SELECT * FROM "${t}"`).all() as Row[]);
const photoHashes = photoDigest();

const dietValues = before.get("food_entries")?.filter((r) => r["diet"] != null).length ?? 0;

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

const started = performance.now();
for (const m of pending.filter((p) => p.version >= UUID_VERSION)) {
  try {
    runMigration(m);
  } catch (e) {
    fail(`Migration ${m.description} failed (it would roll back, leaving the data as it was): ${String(e)}`);
    report();
  }
}
const tookMs = performance.now() - started;

// ---------------------------------------------------------------------------
// After
// ---------------------------------------------------------------------------

const integrity = (db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check);
if (integrity.join() !== "ok") fail(`integrity_check: ${integrity.join("; ")}`);
const fk = db.query("PRAGMA foreign_key_check").all();
if (fk.length) fail(`${fk.length} broken reference(s) after upgrading: ${JSON.stringify(fk.slice(0, 5))}`);
const leftovers = db.query("SELECT name FROM sqlite_master WHERE sql LIKE '%__new_%'").all();
if (leftovers.length) fail(`Schema still mentions __new_ tables: ${JSON.stringify(leftovers)}`);

const mapId = (v: unknown) => (v == null ? null : legacyId(Number(v)));
let rowsChecked = 0;
let valuesChecked = 0;

for (const t of tables) {
  const old = before.get(t)!;
  if (t === "settings") {
    checkSettings(old);
    continue;
  }
  const now = db.query(`SELECT * FROM "${t}"`).all() as Row[];
  if (now.length !== old.length) fail(`${t}: ${old.length} rows before, ${now.length} after`);
  const cols = (db.query(`PRAGMA table_info("${t}")`).all() as { name: string; pk: number }[]);
  const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
  const keyOf = (r: Row) => pk.map((c) => String(r[c])).join("\u0000");
  const byKey = new Map(now.map((r) => [keyOf(r), r]));

  for (const o of old) {
    // The old row, spelled the way 0038 says it should come out.
    const expected: Row = {};
    for (const [c, v] of Object.entries(o)) {
      if (t === "food_entries" && c === "diet") continue;
      if (c === "id" && typeof v === "number") expected[c] = mapId(v);
      else if (REF_COLUMNS.has(c)) expected[c] = mapId(v);
      else expected[c] = v;
    }
    const got = byKey.get(keyOf(expected));
    if (!got) {
      fail(`${t}: row ${keyOf(o)} is missing after the upgrade`);
      continue;
    }
    rowsChecked++;
    for (const [c, v] of Object.entries(expected)) {
      valuesChecked++;
      let want = v;
      if (t === "entry_messages" && c === "before_entry" && typeof v === "string") {
        // The undo snapshot's id is re-spelled inside the JSON; the rest is untouched.
        want = (db.query("SELECT json_set(?, '$.id', ?) AS j").get(v, mapId(
          (db.query("SELECT json_extract(?, '$.id') AS i").get(v) as { i: number }).i,
        )) as { j: string }).j;
      }
      if (!same(got[c], want)) fail(`${t} ${keyOf(expected)}.${c}: was ${show(want)}, now ${show(got[c])}`);
    }
  }
}

const photosAfter = photoDigest();
for (const [name, digest] of photoHashes) {
  if (photosAfter.get(name) !== digest) fail(`photo ${name} changed or went missing`);
}

report();

// ---------------------------------------------------------------------------

function report(): never {
  console.log("");
  if (dietValues) notes.push(`food_entries.diet held ${dietValues} non-empty value(s); that column is dropped (the app never reads it).`);
  else notes.push("food_entries.diet was empty everywhere, so dropping it loses nothing.");
  console.log(`Checked ${tables.length} tables, ${rowsChecked} rows, ${valuesChecked} values, ${photoHashes.size} photos (byte for byte).`);
  console.log(`Upgrade took ${Math.round(tookMs)} ms.`);
  for (const n of notes) console.log(`Note: ${n}`);
  if (problems.length) {
    console.log(`\n${problems.length} PROBLEM(S):`);
    for (const p of problems.slice(0, 50)) console.log(`  - ${p}`);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("\nOK: nothing lost, nothing changed apart from the id spelling.");
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

function checkSettings(old: Row[]) {
  const synced = new Map((db.query("SELECT key, value FROM settings").all() as Row[]).map((r) => [r["key"], r["value"]]));
  const device = new Map((db.query("SELECT key, value FROM device_settings").all() as Row[]).map((r) => [r["key"], r["value"]]));
  for (const o of old) {
    const key = String(o["key"]);
    const isDevice = DEVICE_KEYS.includes(key);
    const got = (isDevice ? device : synced).get(key);
    let want = o["value"];
    if (key === "coach_unread_chat" && typeof want === "string" && /^\d+$/.test(want)) want = legacyId(Number(want));
    rowsChecked++;
    valuesChecked++;
    if (got !== want) fail(`setting ${key}: was ${show(want)}, now ${show(got)} (in ${isDevice ? "device_settings" : "settings"})`);
  }
  if (synced.size + device.size !== old.length) fail(`settings: ${old.length} before, ${synced.size + device.size} after`);
}

function runMigration(m: { version: number; description: string; file: string }) {
  db.exec("BEGIN");
  try {
    db.exec(sqlOf(m.file));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if (tableExists("_sqlx_migrations")) {
    db.query("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, 1, x'', 0)")
      .run(m.version, m.description);
  }
}

function tableExists(name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function photoDigest(): Map<string, string> {
  const out = new Map<string, string>();
  if (!tableExists("photos")) return out;
  for (const r of db.query("SELECT filename, data FROM photos").all() as { filename: string; data: Uint8Array }[]) {
    out.set(r.filename, new Bun.CryptoHasher("sha256").update(r.data).digest("hex"));
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

function show(v: unknown): string {
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

// ---------------------------------------------------------------------------
// Synthetic database
// ---------------------------------------------------------------------------

function buildSynthetic(path: string) {
  const s = new Database(path, { create: true });
  s.exec("PRAGMA foreign_keys = ON");
  s.exec(`CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)`);
  for (const m of migrations) {
    if (m.version >= UUID_VERSION) break;
    s.exec(sqlOf(m.file));
    s.query("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, 1, x'', 0)")
      .run(m.version, m.description);
  }

  // Parents before children; anything not listed comes after, in name order.
  const order = [
    "settings", "supplements", "documents", "manuals", "experiments", "chats", "fasts",
    "food_entries", "workouts", "state_logs", "performance_logs", "state_categories",
  ];
  const all = (s.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'").all() as { name: string }[]).map((t) => t.name);
  const tablesInOrder = [...order.filter((t) => all.includes(t)), ...all.filter((t) => !order.includes(t)).sort()];
  const ids = new Map<string, number[]>();
  const target: Record<string, string> = {
    supplement_id: "supplements", document_id: "documents", manual_id: "manuals",
    experiment_id: "experiments", fast_id: "fasts", chat_id: "chats",
    source_entry_id: "food_entries", workout_id: "workouts",
  };
  const pick = (table: string, i: number) => {
    const list = ids.get(table) ?? [];
    return list.length ? list[i % list.length]! : null;
  };

  for (const t of tablesInOrder) {
    const cols = s.query(`PRAGMA table_info("${t}")`).all() as { name: string; type: string; notnull: number; pk: number }[];
    const n = t === "settings" ? 0 : 300; // ~5 rows a day for 60 days
    const made: number[] = [];
    for (let i = 1; i <= n; i++) {
      const id = i * 3 + (i % 7); // gaps, as deletes leave them
      const row: Row = {};
      for (const c of cols) {
        const optional = c.notnull === 0 && c.pk === 0;
        if (optional && i % 4 === 0) {
          row[c.name] = null;
          continue;
        }
        row[c.name] = valueFor(t, c, id, i);
      }
      const names = Object.keys(row);
      try {
        s.query(`INSERT INTO "${t}" (${names.map((x) => `"${x}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(...(Object.values(row) as never[]));
        if (typeof row["id"] === "number") made.push(row["id"]);
      } catch (e) {
        throw new Error(`seeding ${t}: ${String(e)}`);
      }
    }
    ids.set(t, made);
  }

  // Settings, including every device-local key and a pointer at a chat.
  const chat = pick("chats", 5);
  for (const k of DEVICE_KEYS) s.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(k, k === "coach_unread_chat" ? String(chat) : `value of ${k}`);
  for (const k of ["openrouter_api_key", "calorie_target_kcal", "coach_stance", "streak_state"]) {
    s.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(k, `value of ${k}`);
  }
  s.close();

  function valueFor(t: string, c: { name: string; type: string; pk: number }, id: number, i: number): unknown {
    const name = c.name;
    if (name === "id" && c.pk) return id;
    if (t === "document_files" && name === "document_id") return pick("documents", i * 7);
    if (name === "log_id") return pick(t === "state_log_tags" ? "state_logs" : "performance_logs", i);
    if (name === "entry_id") return pick(i % 2 ? "food_entries" : "workouts", i);
    if (name === "entry_kind") return i % 2 ? "meal" : "workout";
    if (target[name]) return pick(target[name]!, i);
    if (name === "before_entry") return `{"id":${pick("food_entries", i)},"title":"snapshot ${i}"}`;
    const type = c.type.toLowerCase();
    if (type.includes("blob")) return new Uint8Array([0xff, 0xd8, 0, i % 256, 0xff, 0xd9, ...Array.from({ length: 64 }, (_, k) => (k * i) % 256)]);
    if (type.includes("int")) return name.startsWith("cardio") || name === "archived" || name === "excluded" || name === "dismissed" ? i % 2 : i;
    if (type.includes("real")) return i * 1.25;
    if (name === "day" || name.endsWith("_day") || name === "document_date" || name === "follow_up_on") {
      // A table keyed by day has one row per day; the rest spread over 60.
      const dayKeyed = c.pk > 0;
      return new Date(Date.UTC(2026, 8, 1) + (dayKeyed ? i : i % 60) * 86_400_000).toISOString().slice(0, 10);
    }
    if (name.endsWith("_at")) return new Date(Date.UTC(2026, 8, 1) + i * 4 * 3_600_000).toISOString();
    if (["nutrients", "summary", "raw", "ratings"].includes(name)) return `{"calories":${i}}`;
    if (["messages", "extracted", "page_paths", "changes", "laps", "zone_secs", "arms", "measures"].includes(name)) return `[${i}]`;
    return `${t}.${name} #${i}`;
  }
}
