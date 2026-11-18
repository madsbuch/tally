// Generates migration 0041 (src-tauri/migrations/0041_type_ids.sql), which
// re-spells every row id from a bare UUID to the TypeID of the same 128 bits
// (src/lib/ids.ts): `0190…-…` becomes `meal_01j…`.
//
//   bun scripts/type-id-migration.ts > src-tauri/migrations/0041_type_ids.sql
//
// The SQL is plain SQLite (no custom functions, nothing newer than Android
// 14's 3.39): the encoder is one expression, written once, that fills a
// temporary map of (prefix, old, new) from every id-shaped value the database
// holds — ids, references to them, sync bookkeeping, the unread-chat setting.
// Every column is then rewritten through that map. tests/type-id-migration.test.ts
// checks the result against `typeIdOf` and runs it on a database at version 41.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ID_PREFIXES } from "../src/lib/ids";
import type { IdTable } from "../src/lib/ids";
import { isKeyOf } from "../src/lib/guards";
import { shapeOf, triggerSql } from "./sync-triggers";

export const MIGRATION_FILE = "0041_type_ids.sql";

/** Columns holding another row's id: [table, column, the table it points into]. */
export const REFERENCES: readonly (readonly [string, string, IdTable])[] = [
  ["supplement_logs", "supplement_id", "supplements"],
  ["document_files", "document_id", "documents"],
  ["manual_revisions", "manual_id", "manuals"],
  ["experiments", "manual_id", "manuals"],
  ["experiment_trials", "experiment_id", "experiments"],
  ["experiment_trials", "fast_id", "fasts"],
  ["coach_runs", "chat_id", "chats"],
  ["ai_usage", "chat_id", "chats"],
  ["state_log_tags", "log_id", "state_logs"],
  ["performance_stats", "log_id", "performance_logs"],
  ["saved_meals", "source_entry_id", "food_entries"],
  ["garmin_activities", "workout_id", "workouts"],
  // Not garmin_days.sleep_id: that is Garmin's own id for the night.
];

/**
 * `entry_kind` → the table `entry_id` points into, for entry_messages and
 * entry_notes (lib/types.ts `NotedEntryKind`; entry_messages only uses the
 * first two). A kind not listed leaves its `entry_id` as it is.
 */
export const ENTRY_KINDS: Readonly<Record<string, IdTable>> = {
  meal: "food_entries",
  workout: "workouts",
  reading: "blood_readings",
  state: "state_logs",
  performance: "performance_logs",
  sleep: "sleep_sessions",
};

/** Tables whose primary key is another table's id (sync_rows.pk under their name). */
const KEYED_BY_REFERENCE: Readonly<Record<string, IdTable>> = { document_files: "documents" };

/** Device-local settings whose value is a row id. */
export const ID_SETTINGS: readonly (readonly [string, IdTable])[] = [["coach_unread_chat", "chats"]];

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const MAP = "type_id_map";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const idTables = Object.keys(ID_PREFIXES).filter((t) => isKeyOf(ID_PREFIXES, t));
const prefixOf = (t: IdTable) => ID_PREFIXES[t];

/** A UUID's spelling, as a GLOB over its lower-cased text. */
const UUID_GLOB = [8, 4, 4, 4, 12].map((n) => "[0-9a-f]".repeat(n)).join("-");

/**
 * The TypeID suffix of `h`, a column holding the UUID's 32 hex digits. The
 * 128 bits are read as the top byte (hex digits 1–2) and six 20-bit groups
 * (5 hex digits each); base32 takes the byte's top 3 bits (with TypeID's two
 * zero bits ahead of them) and its low 5 as the first two characters, then 4
 * characters per group — 2 + 6 × 4 = 26, most significant first.
 */
export function suffixSql(h: string): string {
  const digit = (i: number) => `(instr('0123456789abcdef', substr(${h}, ${i}, 1)) - 1)`;
  const char = (x: string) => `substr('${ALPHABET}', (${x}) + 1, 1)`;
  const top = `(${digit(1)} * 16 + ${digit(2)})`;
  const parts = [char(`${top} >> 5`), char(`${top} & 31`)];
  for (let g = 0; g < 6; g++) {
    const first = 3 + g * 5;
    const value = `(${[0, 1, 2, 3, 4].map((k) => `${digit(first + k)} * ${16 ** (4 - k)}`).join(" + ")})`;
    parts.push(char(`${value} >> 15`), char(`(${value} >> 10) & 31`), char(`(${value} >> 5) & 31`), char(`${value} & 31`));
  }
  return parts.join("\n      || ");
}

/** `CASE <kind> WHEN 'meal' THEN 'meal' …` — the prefix an entry kind's ids take. */
function kindPrefix(column: string): string {
  return `CASE ${column} ${Object.entries(ENTRY_KINDS).map(([k, t]) => `WHEN ${q(k)} THEN ${q(prefixOf(t))}`).join(" ")} END`;
}

/** `CASE tbl WHEN 'food_entries' THEN 'meal' …` — the prefix of a sync pk. */
function tblPrefix(column: string): string {
  const pairs: [string, string][] = [
    ...idTables.map((t): [string, string] => [t, prefixOf(t)]),
    ...Object.entries(KEYED_BY_REFERENCE).map(([t, target]): [string, string] => [t, prefixOf(target)]),
  ];
  return `CASE ${column} ${pairs.map(([t, p]) => `WHEN ${q(t)} THEN ${q(p)}`).join(" ")} END`;
}

const beforeId = "CASE WHEN json_valid(before_entry) THEN json_extract(before_entry, '$.id') END";

export function migrationSql(db: Database): string {
  const out: string[] = [];
  const push = (s: string) => out.push(s);

  // Every table written to: its sync triggers come off for the rewrite.
  const touched = [...new Set([...idTables, ...REFERENCES.map(([t]) => t)])];
  const triggers = z
    .array(z.object({ name: z.string(), tbl_name: z.string() }))
    .parse(db.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'").all());
  for (const t of touched) {
    const own = triggers.filter((r) => r.tbl_name === t).map((r) => r.name).sort();
    const want = ["ad", "ai", "au"].map((k) => `sync_${t}_${k}`);
    if (JSON.stringify(own) !== JSON.stringify(want)) throw new Error(`${t}: expected exactly its sync triggers, found ${own.join(", ")}`);
  }
  for (const [t, c] of REFERENCES) {
    if (!shapeOf(db, t).columns.includes(c) && shapeOf(db, t).pk !== c) throw new Error(`${t}.${c} doesn't exist`);
  }
  // Every declared foreign key is one of the references above.
  for (const t of touched) {
    const fks = z.array(z.object({ table: z.string(), from: z.string() })).parse(db.query(`PRAGMA foreign_key_list("${t}")`).all());
    for (const fk of fks) {
      if (!REFERENCES.some(([rt, rc, target]) => rt === t && rc === fk.from && target === fk.table)) {
        throw new Error(`${t}.${fk.from} → ${fk.table} is not in REFERENCES`);
      }
    }
  }

  // Where old ids are found, with the prefix each one takes.
  const sources: string[] = [
    ...idTables.map((t) => `SELECT ${q(prefixOf(t))} AS prefix, "id" AS old FROM "${t}"`),
    ...REFERENCES.map(([t, c, target]) => `SELECT ${q(prefixOf(target))}, "${c}" FROM "${t}"`),
    ...["entry_messages", "entry_notes"].map((t) => `SELECT ${kindPrefix("entry_kind")}, "entry_id" FROM "${t}"`),
    `SELECT ${kindPrefix("entry_kind")}, ${beforeId} FROM "entry_messages"`,
    ...["sync_rows", "sync_vv"].map((t) => `SELECT ${tblPrefix("tbl")}, "pk" FROM "${t}"`),
    ...ID_SETTINGS.map(([key, target]) => `SELECT ${q(prefixOf(target))}, "value" FROM "device_settings" WHERE "key" = ${q(key)}`),
  ];

  push(`CREATE TEMP TABLE ${MAP} (
  prefix text NOT NULL,
  old text NOT NULL,
  new text NOT NULL,
  PRIMARY KEY (prefix, old)
) WITHOUT ROWID;`);
  push(`INSERT INTO ${MAP} (prefix, old, new)
SELECT prefix, old, prefix || '_' || ${suffixSql("h")}
FROM (
  SELECT prefix, old, replace(lower(old), '-', '') AS h FROM (
    ${sources.join("\n    UNION\n    ")}
  )
  WHERE prefix IS NOT NULL AND typeof(old) = 'text' AND lower(old) GLOB '${UUID_GLOB}'
);`);

  for (const t of touched) {
    for (const k of ["ai", "au", "ad"]) push(`DROP TRIGGER IF EXISTS \`sync_${t}_${k}\`;`);
  }

  const via = (table: string, set: string, prefix: string, old: string) =>
    `UPDATE "${table}" SET ${set} FROM ${MAP} AS m WHERE m.prefix = ${prefix} AND m.old = ${old};`;
  for (const t of idTables) push(via(t, `"id" = m.new`, q(prefixOf(t)), `"${t}"."id"`));
  for (const [t, c, target] of REFERENCES) push(via(t, `"${c}" = m.new`, q(prefixOf(target)), `"${t}"."${c}"`));
  for (const t of ["entry_messages", "entry_notes"]) {
    push(via(t, `"entry_id" = m.new`, kindPrefix(`"${t}"."entry_kind"`), `"${t}"."entry_id"`));
  }
  push(via("entry_messages", `"before_entry" = json_set("before_entry", '$.id', m.new)`, kindPrefix(`"entry_messages"."entry_kind"`), beforeId.replace(/before_entry/g, `"entry_messages"."before_entry"`)));
  for (const t of ["sync_rows", "sync_vv"]) push(via(t, `"pk" = m.new`, tblPrefix(`"${t}"."tbl"`), `"${t}"."pk"`));
  for (const [key, target] of ID_SETTINGS) {
    push(`UPDATE "device_settings" SET "value" = m.new FROM ${MAP} AS m WHERE "device_settings"."key" = ${q(key)} AND m.prefix = ${q(prefixOf(target))} AND m.old = "device_settings"."value";`);
  }
  push(`DROP TABLE ${MAP};`);

  for (const t of touched) {
    const { pk, columns } = shapeOf(db, t);
    push(triggerSql(t, pk, columns));
  }

  return `${HEADER}PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
-- @generated by \`bun scripts/type-id-migration.ts\`; everything below.
${out.join("--> statement-breakpoint\n")}
`;
}

const HEADER = `-- Every row id becomes a TypeID: the table's prefix, then the same 128 bits
-- in 26 characters of Crockford base32 (src/lib/ids.ts): the UUID
-- \`01890a5d-ac96-774b-bcce-b302099a8057\` of a meal is now
-- \`meal_01h455vb4pex5vsknk084sn02q\`. Every column pointing at a row follows
-- with the prefix of the table it points into (entry_messages/entry_notes by
-- their entry_kind), as do the undo snapshots' ids in
-- entry_messages.before_entry, the unread-chat setting, and sync's bookkeeping
-- (sync_rows / sync_vv pks, tombstones included, converted from the value
-- itself since their rows are gone). Chat transcripts are left as written:
-- \`idArg\` reads the old spellings.
--
-- A value that isn't a UUID (nothing the app wrote) is left as it is.
--
-- Every device runs this same rewrite and ends with the same ids, so it is
-- not a change to sync: the sync triggers of every table it writes come off
-- first and go back on after (as scripts/sync-triggers.ts generates them),
-- and no hlc, origin or seq moves.
--
-- Runs inside a transaction with foreign keys ON; references are checked at
-- commit (defer_foreign_keys), by which time parents and children agree.
--
-- Generated by scripts/type-id-migration.ts — edit that, not this.
`;

if (import.meta.main) {
  const root = new URL("..", import.meta.url);
  const rust = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");
  const db = new Database(":memory:");
  // The database as it stands at version 41, triggers and all.
  for (const m of rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)) {
    if (m[1] === MIGRATION_FILE) break;
    db.exec(readFileSync(new URL(`src-tauri/migrations/${m[1]}`, root), "utf8"));
  }
  process.stdout.write(migrationSql(db));
}
