// ---------------------------------------------------------------------------
// Row ids. Every table is keyed by a UUIDv7 string rather than an
// auto-increment integer, so rows written on two devices never collide when
// they're synced into one vault.
//
// v7 leads with the millisecond timestamp, so ids sort by creation time as
// text — `ORDER BY id` still means "in the order they were written". Within
// one millisecond the 12-bit counter after the timestamp is incremented
// rather than re-rolled, so a loop that writes several rows (an observation's
// tags, say) keeps them in order too.
//
// Rows from before the switch kept their old integer, re-spelled as
// `00000000-0000-7000-8000-<12 hex digits>` (see migration 0038 and
// `legacyId`): a zero timestamp sorts them before everything since, in their
// old order.
// ---------------------------------------------------------------------------

let lastMs = -1;
let lastSeq = 0;

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** A fresh UUIDv7, monotonic within this process. */
export function newId(now: number = Date.now()): string {
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
  b[8] = 0x80 | (b[8]! & 0x3f);
  return hex(b);
}

/**
 * The id a row from before UUIDs carries: its old integer in the last group.
 * Mirrors the `printf` in migration 0038.
 */
export function legacyId(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * An id derived from a stable external key — a Health Connect record id, a
 * Garmin activity id — so two devices importing the same record arrive at
 * the same row instead of two copies of it. Shaped as a UUIDv8 (custom) from
 * the key's SHA-256.
 */
export async function derivedId(namespace: string, key: string): Promise<string> {
  const data = new TextEncoder().encode(`${namespace}:${key}`);
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  b[6] = 0x80 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  return hex(b);
}

/**
 * An id handed back by a model in a tool call. Ids are strings now, but a
 * conversation from before the switch may still quote an old number ("#12"),
 * which is read as the row it became.
 */
export function idArg(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return legacyId(Math.round(raw));
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^#/, "");
  if (/^\d+$/.test(s)) return legacyId(Number(s));
  return s || null;
}

const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A row id taken from a URL segment, or null if it isn't shaped like one. */
export function parseRowId(raw: string | undefined | null): string | null {
  return raw && ROW_ID.test(raw) ? raw : null;
}
