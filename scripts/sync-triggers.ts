// Generates the SQL that puts a table under sync: the three triggers that
// record every insert, update and delete into `sync_rows` / `sync_vv`, and the
// backfill that records the rows already there.
//
//   bun scripts/sync-triggers.ts                     # every table (how 0039 put them all under sync)
//   bun scripts/sync-triggers.ts my_table            # a new table: backfill + triggers
//   bun scripts/sync-triggers.ts --retrigger my_table  # a table that gained a column
//
// A migration that adds a table must include its triggers; one that rebuilds
// a table must re-create them (dropping a table drops its triggers); and one
// that adds a column must re-create the table's triggers (`--retrigger`, run
// after the column exists): the update trigger lists the columns it watches.
// tests/sync-tracking.test.ts fails for any of these left undone.
//
// The SQL sticks to what Android 14's built-in SQLite (3.39) understands: the
// Android check-in worker writes to this database with that engine, and a
// trigger it can't parse would stop it opening the file at all.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";

/** Tables that never sync: device-local state and the sync machinery itself. */
export const LOCAL_TABLES = [
  "_sqlx_migrations",
  "sqlite_sequence",
  "device_settings",
  "sync_state",
  "sync_rows",
  "sync_vv",
  "sync_peers",
  "sync_epochs",
];

/**
 * Backfill order: parents before the rows that point at them, bulky blobs
 * last — so a device joining mid-way through has whole records, not orphans.
 */
const FIRST = [
  "vault_devices", "vault_revocations", "settings", "supplements", "documents", "manuals", "experiments",
  "chats", "fasts", "food_entries", "workouts", "sleep_sessions", "state_logs",
  "state_categories", "performance_logs",
];
const LAST = ["document_files", "photos"];

/** Milliseconds since the epoch, from julianday (no unixepoch('subsec') on 3.39). */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)";

/**
 * The hybrid logical clock's tick, as SET clauses on sync_state (SQLite
 * evaluates them all against the old row): the wall clock if it has moved
 * on, else one more within the same millisecond — rolling into the next
 * millisecond rather than let the 6-digit counter overflow and sort wrong.
 */
export const TICK_SQL = `hlc_counter = CASE WHEN ${NOW_MS} > hlc_ms THEN 0 WHEN hlc_counter >= 999999 THEN 0 ELSE hlc_counter + 1 END,
    hlc_ms = CASE WHEN ${NOW_MS} > hlc_ms THEN ${NOW_MS} WHEN hlc_counter >= 999999 THEN hlc_ms + 1 ELSE hlc_ms END`;

/**
 * A device's entry in a row's version vector is the clock value of its
 * latest change to it (as one integer), not a count of changes: a copy of
 * the database restored from earlier — with counts that would start again
 * from where they were — still writes values above any the original used,
 * so its edits can never look identical to ones they never saw.
 */
const VV_TICK = "hlc_ms * 1000000 + hlc_counter";

export function triggerSql(table: string, pk: string, columns: string[]): string {
  const record = (ref: "NEW" | "OLD", deleted: 0 | 1) => `
  UPDATE sync_state SET
    ${TICK_SQL},
    seq = seq + 1
  WHERE id = 1;
  INSERT INTO sync_rows (tbl, pk, hlc, origin, deleted, seq, from_peer)
    SELECT '${table}', ${ref}.\`${pk}\`, printf('%013d.%06d', hlc_ms, hlc_counter), device_id, ${deleted}, seq, NULL
    FROM sync_state WHERE id = 1
    ON CONFLICT (tbl, pk) DO UPDATE SET
      hlc = excluded.hlc, origin = excluded.origin, deleted = excluded.deleted,
      seq = excluded.seq, from_peer = NULL;
  INSERT INTO sync_vv (tbl, pk, device, counter)
    SELECT '${table}', ${ref}.\`${pk}\`, device_id, ${VV_TICK} FROM sync_state WHERE id = 1
    ON CONFLICT (tbl, pk, device) DO UPDATE SET counter = max(counter + 1, excluded.counter);`;
  const when = "WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0";
  // An update that changes nothing (a re-import writing the same values) is
  // not a new version: it would otherwise win over a real edit made
  // concurrently elsewhere.
  const changed = columns.map((c) => `OLD.\`${c}\` IS NOT NEW.\`${c}\``).join(" OR ");
  return [
    `CREATE TRIGGER \`sync_${table}_ai\` AFTER INSERT ON \`${table}\` ${when}\nBEGIN${record("NEW", 0)}\nEND;`,
    `CREATE TRIGGER \`sync_${table}_au\` AFTER UPDATE ON \`${table}\` ${when} AND (${changed})\nBEGIN${record("NEW", 0)}\nEND;`,
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

function shapeOf(db: Database, table: string): { pk: string; columns: string[] } {
  const cols = z.array(z.object({ name: z.string(), pk: z.number() })).parse(db.query(`PRAGMA table_info("${table}")`).all());
  const pk = cols.filter((c) => c.pk > 0);
  const [only] = pk;
  if (pk.length !== 1 || !only) throw new Error(`${table}: sync needs a single-column primary key`);
  return { pk: only.name, columns: cols.map((c) => c.name) };
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url);
  const rust = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");
  const db = new Database(":memory:");
  // Every migration's own part — what shapes the tables — up to where its
  // generated part (the triggers this prints) begins, if it has one. A new
  // migration's tables and columns are therefore already there: write its
  // schema changes first, then append this script's output after a
  // `-- @generated` line.
  for (const m of rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)) {
    const sql = readFileSync(new URL(`src-tauri/migrations/${m[1]}`, root), "utf8");
    db.exec(sql.split("-- @generated")[0] ?? sql);
  }

  const retrigger = process.argv[2] === "--retrigger";
  const only = retrigger ? process.argv[3] : process.argv[2];
  if (retrigger) {
    if (!only) throw new Error("--retrigger needs a table");
    // The table as it is after the migrations' own changes (above).
    const { pk, columns } = shapeOf(db, only);
    const drops = ["ai", "au", "ad"].map((k) => `DROP TRIGGER IF EXISTS \`sync_${only}_${k}\`;`).join("--> statement-breakpoint\n");
    process.stdout.write(`${drops}--> statement-breakpoint\n${triggerSql(only, pk, columns)}\n`);
    process.exit(0);
  }
  const tables = only
    ? [only]
    : z.array(z.object({ name: z.string() })).parse(db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
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
  for (const t of ordered) out.push(backfillSql(t, shapeOf(db, t).pk));
  if (!only) {
    out.push(`UPDATE sync_state SET seq = (SELECT coalesce(max(seq), 0) FROM sync_rows), hlc_ms = ${NOW_MS} WHERE id = 1;`);
  }
  for (const t of ordered) {
    const { pk, columns } = shapeOf(db, t);
    out.push(triggerSql(t, pk, columns));
  }
  process.stdout.write(out.join("--> statement-breakpoint\n") + "\n");
}
