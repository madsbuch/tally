// Generates the SQL that puts a table under sync: the three triggers that
// record every insert, update and delete into `sync_rows` / `sync_vv`, and the
// backfill that records the rows already there.
//
//   bun scripts/sync-triggers.ts            # every table, as in migration 0039
//   bun scripts/sync-triggers.ts my_table   # one new table, for a later migration
//
// A migration that adds a table must include its triggers (and one that
// rebuilds a table must re-create them: dropping a table drops its
// triggers). tests/sync-tracking.test.ts fails for any table that is neither
// tracked nor listed in LOCAL_TABLES.
//
// The SQL sticks to what Android 14's built-in SQLite (3.39) understands: the
// Android check-in worker writes to this database with that engine, and a
// trigger it can't parse would stop it opening the file at all.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/** Tables that never sync: device-local state and the sync machinery itself. */
export const LOCAL_TABLES = [
  "_sqlx_migrations",
  "sqlite_sequence",
  "device_settings",
  "sync_state",
  "sync_rows",
  "sync_vv",
  "sync_peers",
];

/**
 * Backfill order: parents before the rows that point at them, bulky blobs
 * last — so a device joining mid-way through has whole records, not orphans.
 */
const FIRST = [
  "vault_devices", "settings", "supplements", "documents", "manuals", "experiments",
  "chats", "fasts", "food_entries", "workouts", "sleep_sessions", "state_logs",
  "state_categories", "performance_logs",
];
const LAST = ["document_files", "photos"];

/** Milliseconds since the epoch, from julianday (no unixepoch('subsec') on 3.39). */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)";

export function triggerSql(table: string, pk: string): string {
  const record = (ref: "NEW" | "OLD", deleted: 0 | 1) => `
  UPDATE sync_state SET
    hlc_counter = CASE WHEN ${NOW_MS} > hlc_ms THEN 0 ELSE hlc_counter + 1 END,
    hlc_ms = max(hlc_ms, ${NOW_MS}),
    seq = seq + 1
  WHERE id = 1;
  INSERT INTO sync_rows (tbl, pk, hlc, origin, deleted, seq, from_peer)
    SELECT '${table}', ${ref}.\`${pk}\`, printf('%013d.%06d', hlc_ms, hlc_counter), device_id, ${deleted}, seq, NULL
    FROM sync_state WHERE id = 1
    ON CONFLICT (tbl, pk) DO UPDATE SET
      hlc = excluded.hlc, origin = excluded.origin, deleted = excluded.deleted,
      seq = excluded.seq, from_peer = NULL;
  INSERT INTO sync_vv (tbl, pk, device, counter)
    SELECT '${table}', ${ref}.\`${pk}\`, device_id, 1 FROM sync_state WHERE id = 1
    ON CONFLICT (tbl, pk, device) DO UPDATE SET counter = counter + 1;`;
  const when = "WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0";
  return [
    `CREATE TRIGGER \`sync_${table}_ai\` AFTER INSERT ON \`${table}\` ${when}\nBEGIN${record("NEW", 0)}\nEND;`,
    `CREATE TRIGGER \`sync_${table}_au\` AFTER UPDATE ON \`${table}\` ${when}\nBEGIN${record("NEW", 0)}\nEND;`,
    `CREATE TRIGGER \`sync_${table}_ad\` AFTER DELETE ON \`${table}\` ${when}\nBEGIN${record("OLD", 1)}\nEND;`,
  ].join("--> statement-breakpoint\n");
}

/** Records every row already in `table` as this device's first version of it. */
export function backfillSql(table: string, pk: string): string {
  return `INSERT INTO sync_rows (tbl, pk, hlc, origin, deleted, seq)
  SELECT '${table}', t.\`${pk}\`, printf('%013d.%06d', ${NOW_MS}, 0), s.device_id, 0,
    (SELECT coalesce(max(seq), 0) FROM sync_rows) + row_number() OVER (ORDER BY t.\`${pk}\`)
  FROM \`${table}\` t, sync_state s WHERE s.id = 1;--> statement-breakpoint
INSERT INTO sync_vv (tbl, pk, device, counter)
  SELECT '${table}', t.\`${pk}\`, s.device_id, 1 FROM \`${table}\` t, sync_state s WHERE s.id = 1;`;
}

function pkOf(db: Database, table: string): string {
  const cols = db.query(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[];
  const pk = cols.filter((c) => c.pk > 0);
  if (pk.length !== 1) throw new Error(`${table}: sync needs a single-column primary key`);
  return pk[0]!.name;
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url);
  const rust = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");
  const db = new Database(":memory:");
  for (const m of rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)) {
    if (m[1] === "0039_sync.sql") break;
    db.exec(readFileSync(new URL(`src-tauri/migrations/${m[1]}`, root), "utf8"));
  }
  // The tables 0039 itself creates, up to where the generated part begins.
  const own = readFileSync(new URL("src-tauri/migrations/0039_sync.sql", root), "utf8");
  db.exec(own.split("-- @generated")[0]!);

  const only = process.argv[2];
  const tables = only
    ? [only]
    : (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
        .map((t) => t.name)
        .filter((t) => !LOCAL_TABLES.includes(t));
  const ordered = only
    ? tables
    : [
        ...FIRST.filter((t) => tables.includes(t)),
        ...tables.filter((t) => !FIRST.includes(t) && !LAST.includes(t)),
        ...LAST.filter((t) => tables.includes(t)),
      ];

  const out: string[] = [];
  for (const t of ordered) out.push(backfillSql(t, pkOf(db, t)));
  if (!only) {
    out.push(`UPDATE sync_state SET seq = (SELECT coalesce(max(seq), 0) FROM sync_rows), hlc_ms = ${NOW_MS} WHERE id = 1;`);
  }
  for (const t of ordered) out.push(triggerSql(t, pkOf(db, t)));
  process.stdout.write(out.join("--> statement-breakpoint\n") + "\n");
}
