// ---------------------------------------------------------------------------
// Row ids are TypeIDs (https://github.com/jetify-com/typeid): a prefix naming
// what the row is, then a UUID spelled in 26 characters of Crockford base32 —
// `meal_01jd4x8m2kf7r9q3vz5w6t0hyc`. The prefix is what lets an id stand on its
// own: the coach can write one into a message and the app knows to show that
// meal's title in its place (components/EntityChip), and a tool handed a
// workout's id where it wanted a meal's can tell.
//
// The UUID underneath is v7, which leads with the millisecond timestamp, and
// base32 keeps the order: within a table (one prefix) ids still sort by
// creation time as text, so `ORDER BY id` means "in the order they were
// written". Within one millisecond the 12-bit counter after the timestamp is
// incremented rather than re-rolled, so a loop that writes several rows (an
// observation's tags, say) keeps them in order too.
//
// History: rows were keyed by integers until migration 0038, then by bare
// UUIDs until migration 0041 (version 42), which re-spelled each one as the TypeID of the same 128
// bits. An integer's row became `00000000-0000-7000-8000-<12 hex digits>`
// (`legacyId`), so those still sort first, in their old order. Old chat
// transcripts quote ids in the earlier spellings; `idArg` reads them all.
//
// The same encoding lives in the migration (0041_type_ids.sql), in Rust
// (src-tauri/src/type_id.rs, for chats split by sync) and in Kotlin
// (CoachDb.kt, for the Android check-in). tests/ids.test.ts pins them to the
// spec's own examples.
// ---------------------------------------------------------------------------

/**
 * Every table keyed by a row id, and the prefix its ids carry. A prefix never
 * changes once rows exist: it's part of every id, every reference and every
 * transcript. Where the app already had a word for the kind of entry (the
 * Diary's `entry_kind`s), it's that word.
 */
export const ID_PREFIXES = {
  food_entries: "meal",
  workouts: "workout",
  supplements: "supplement",
  supplement_logs: "dose",
  captures: "capture",
  sleep_sessions: "sleep",
  chats: "chat",
  fasts: "fast",
  documents: "document",
  coach_memory: "memory",
  manuals: "manual",
  manual_revisions: "manual_revision",
  experiments: "experiment",
  experiment_trials: "trial",
  coach_runs: "coach_run",
  ai_usage: "ai_usage",
  entry_messages: "entry_message",
  state_logs: "observation",
  state_log_tags: "observation_tag",
  state_categories: "tag",
  blood_readings: "reading",
  performance_logs: "performance",
  performance_stats: "performance_stat",
  entry_notes: "note",
  saved_meals: "saved_meal",
  progress_photos: "progress_photo",
  deleted_imports: "deleted_import",
} as const;

export type IdTable = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdTable];

const PREFIX_LIST: readonly IdPrefix[] = Object.values(ID_PREFIXES);

export function isIdPrefix(x: unknown): x is IdPrefix {
  return PREFIX_LIST.some((p) => p === x);
}

/** Crockford's base32, lower case, as TypeID spells it. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUFFIX = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** 16 bytes as TypeID's 26-character suffix (two zero bits, then all 128). */
function encodeSuffix(b: Uint8Array): string {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  let s = "";
  for (let i = 0; i < 26; i++) {
    s = (ALPHABET[Number(n & 31n)] ?? "0") + s;
    n >>= 5n;
  }
  return s;
}

function decodeSuffix(s: string): string {
  let n = 0n;
  for (const c of s) n = (n << 5n) | BigInt(ALPHABET.indexOf(c));
  const h = n.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function uuidBytes(uuid: string): Uint8Array {
  const h = uuid.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
}

/** The TypeID of `uuid` under `prefix` — the same 128 bits, re-spelled. */
export function typeIdOf(prefix: IdPrefix, uuid: string): string {
  return `${prefix}_${encodeSuffix(uuidBytes(uuid.toLowerCase()))}`;
}

/** A TypeID taken apart, or null when `raw` isn't one of ours. */
export function parseTypeId(raw: string): { prefix: IdPrefix; uuid: string } | null {
  const cut = raw.lastIndexOf("_");
  if (cut <= 0) return null;
  const prefix = raw.slice(0, cut);
  const suffix = raw.slice(cut + 1);
  if (!isIdPrefix(prefix) || !SUFFIX.test(suffix)) return null;
  return { prefix, uuid: decodeSuffix(suffix) };
}

/** The prefix of an id of ours, or null. */
export function prefixOf(raw: string): IdPrefix | null {
  return parseTypeId(raw)?.prefix ?? null;
}

const IN_TEXT = new RegExp(
  `(^|[^A-Za-z0-9_])((?:${[...PREFIX_LIST].sort((a, b) => b.length - a.length).join("|")})_[0-7][0-9a-hjkmnp-tv-z]{25})(?![A-Za-z0-9_])`,
  "g",
);

/**
 * Text cut where ids of ours appear in it: plain strings between the ids,
 * `{ id }` for each one — not inside a longer word. (No lookbehind: older
 * macOS WebKit can't parse one.)
 */
export function splitTypeIds(text: string): (string | { id: string })[] {
  const out: (string | { id: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(IN_TEXT)) {
    const lead = m[1] ?? "";
    const id = m[2] ?? "";
    const start = (m.index ?? 0) + lead.length;
    if (start > at) out.push(text.slice(at, start));
    out.push({ id });
    at = start + id.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

let lastMs = -1;
let lastSeq = 0;

/** A fresh id for a row of `table`: UUIDv7 inside, monotonic within this process. */
export function newId(table: IdTable, now: number = Date.now()): string {
  let ms = Math.max(now, lastMs);
  let seq: number;
  if (ms === lastMs) {
    seq = lastSeq + 1;
    if (seq > 0xfff) {
      ms += 1;
      seq = 0;
    }
  } else {
    // Start low in the counter's range, leaving room to count up.
    seq = Math.floor(Math.random() * 0x800);
  }
  lastMs = ms;
  lastSeq = seq;

  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  return `${ID_PREFIXES[table]}_${encodeSuffix(b)}`;
}

/**
 * The id a row from before UUIDs carries: its old integer in the last group.
 * Mirrors the `printf` in migration 0038, re-spelled as 0041 did.
 */
export function legacyId(prefix: IdPrefix, n: number): string {
  return typeIdOf(prefix, `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
}

/**
 * An id derived from a stable external key — a Health Connect record id, a
 * Garmin activity id — so two devices importing the same record arrive at
 * the same row instead of two copies of it. A UUIDv8 (custom) from the SHA-256
 * of the table and the key.
 */
export async function derivedId(table: IdTable, key: string): Promise<string> {
  const data = new TextEncoder().encode(`${table}:${key}`);
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  b[6] = 0x80 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  return `${ID_PREFIXES[table]}_${encodeSuffix(b)}`;
}

/**
 * An id handed back by a model in a tool call, for a row it means to be a
 * `prefix`. Null when it isn't one — including another kind's id (a workout's
 * where a meal's belongs), so the tool can say so. Conversations from before
 * TypeIDs quote bare UUIDs, and older ones numbers ("#12"); both are read as
 * the row they became.
 */
export function idArg(raw: unknown, prefix: IdPrefix): string | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return legacyId(prefix, Math.round(raw));
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^#/, "");
  if (/^\d+$/.test(s)) return legacyId(prefix, Number(s));
  if (UUID.test(s.toLowerCase())) return typeIdOf(prefix, s);
  const t = parseTypeId(s);
  return t && t.prefix === prefix ? s : null;
}

/**
 * A `prefix` id taken from a URL segment, or null if it isn't one. A bare
 * UUID is one from before TypeIDs (a notification posted before the update),
 * read as the row it became.
 */
export function parseRowId(raw: string | undefined | null, prefix: IdPrefix): string | null {
  if (!raw) return null;
  if (UUID.test(raw)) return typeIdOf(prefix, raw);
  return parseTypeId(raw)?.prefix === prefix ? raw : null;
}

const PREFIX_NAMES: Record<IdPrefix, string> = {
  meal: "a meal",
  workout: "a workout",
  supplement: "a supplement",
  dose: "a supplement dose",
  capture: "a capture",
  sleep: "a night's sleep",
  chat: "a chat",
  fast: "a fast",
  document: "a document",
  memory: "a memory",
  manual: "a manual",
  manual_revision: "a manual revision",
  experiment: "an experiment",
  trial: "an experiment trial",
  coach_run: "a check-in run",
  ai_usage: "an AI usage row",
  entry_message: "an entry message",
  observation: "an observation",
  observation_tag: "an observation's tag",
  tag: "an observation tag",
  reading: "a reading",
  performance: "a performance log",
  performance_stat: "a performance stat",
  note: "a note",
  saved_meal: "a saved meal",
  progress_photo: "a progress photo",
  deleted_import: "a deleted import",
};

/**
 * Why `raw` won't do where a `prefix` id was wanted, worded for the model:
 * missing, the id of something else, or not an id at all.
 */
export function idArgProblem(raw: unknown, prefix: IdPrefix): string {
  const want = `${PREFIX_NAMES[prefix]}'s id (${prefix}_…)`;
  if (raw == null || raw === "") return `This needs ${want}.`;
  const other = typeof raw === "string" ? parseTypeId(raw.trim()) : null;
  if (other) return `${String(raw)} is ${PREFIX_NAMES[other.prefix]}'s id; this needs ${want}.`;
  return `${String(raw)} isn't an id; this needs ${want}.`;
}
