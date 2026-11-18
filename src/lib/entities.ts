// ---------------------------------------------------------------------------
// What an id stands for: the title a row goes by in the app, and the screen
// that shows it.
//
// Ids are TypeIDs (lib/ids.ts), so an id on its own says which table it's
// from — which is what lets the coach write `meal_01jd…` into a message and
// the app show "Oat porridge" in its place (components/EntityChip). The titles
// are the ones the screens themselves use: a meal's title, an observation's
// tags, a reading as the meter showed it.
//
// Resolutions are cached per id and dropped when one of the tables a title is
// read from changes (lib/live.ts), so a conversation with twenty chips reads
// each row once, and still follows an edit made anywhere.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import {
  aiUsage,
  coachMemory,
  coachRuns,
  deletedImports,
  entryMessages,
  entryNotes,
  fasts,
  manualRevisions,
  performanceStats,
  progressPhotos,
  stateCategories,
  stateLogTags,
  supplements,
} from "../db/schema";
import {
  db,
  getBloodReading,
  getCapture,
  getChatSummary,
  getDocument,
  getExperiment,
  getFoodEntry,
  getGlucoseUnit,
  getManual,
  getPerformanceLog,
  getSavedMeal,
  getSleepSession,
  getStateLog,
  getSupplementLog,
  getTrial,
  getWorkout,
} from "./db";
import { ID_PREFIXES, parseTypeId, splitTypeIds } from "./ids";
import { isKeyOf } from "./guards";
import type { IdPrefix, IdTable } from "./ids";
import { chatPath } from "./navigation";
import { MANUAL_GLYPH, manualPath } from "./manuals";
import { EXPERIMENT_GLYPH, experimentPath } from "./experiments";
import {
  SYNCED_WORKOUT_GLYPH,
  WORKOUT_FALLBACK_GLYPH,
  entryGlyph,
  guessIconKey,
  iconGlyph,
} from "./icons";
import { stateGlyph, stateGlyphs, stateTitle } from "./states";
import { READING_DEFS, formatReading } from "./readings";
import { PERFORMANCE_GLYPH, formatStat, statsSummary } from "./performance";
import { onTablesChanged } from "./live";

/** What an id resolves to. */
export interface ResolvedEntity {
  /** Short, human: what the app calls this row. */
  title: string;
  /** The screen that shows it; null when nothing does. */
  path: string | null;
  /** The emoji the app shows beside it. */
  glyph: string;
}

/** The table each prefix names (the inverse of ID_PREFIXES). */
const TABLE_OF = new Map<IdPrefix, IdTable>();
for (const table of Object.keys(ID_PREFIXES)) {
  if (isKeyOf(ID_PREFIXES, table)) TABLE_OF.set(ID_PREFIXES[table], table);
}

/**
 * Tables a title is read from beyond the row's own: a dose is named by its
 * supplement, an observation by its tags, a trial by its experiment.
 */
const ALSO_READS: Partial<Record<IdPrefix, readonly string[]>> = {
  dose: ["supplements"],
  observation: ["state_log_tags"],
  performance: ["performance_stats"],
  trial: ["experiments"],
  manual_revision: ["manuals"],
  // The unit glucose is shown in.
  reading: ["settings"],
};

/** The tables whose changes can change what `prefix`'s ids resolve to. */
export function entityTables(prefix: IdPrefix): string[] {
  const own = TABLE_OF.get(prefix);
  return [...(own ? [own] : []), ...(ALSO_READS[prefix] ?? [])];
}

/** How a kind of row is spoken of: "meal", "saved meal", "observation". */
export function entityNoun(prefix: IdPrefix): string {
  return prefix.replace(/_/g, " ");
}

/** "Tue 12 Nov" for a local day "YYYY-MM-DD". */
function dayLabel(day: string | null | undefined): string | null {
  if (!day) return null;
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Text cut to one short line, with an ellipsis when it was longer. */
function excerpt(text: string, max = 48): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/** "7 h 32 min", as the entry page shows a duration. */
function duration(min: number | null): string | null {
  if (min == null || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function joined(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p).join(" · ");
}

const NOTED_KINDS = ["meal", "workout", "reading", "state", "performance", "sleep"] as const;

/** An entry's page, for the kinds a coach note or a message can sit on. */
function entryPagePath(kind: string, id: string): string | null {
  return NOTED_KINDS.some((k) => k === kind) ? `/entry/${kind}/${id}` : null;
}

async function first<T>(rows: Promise<T[]>): Promise<T | null> {
  return (await rows)[0] ?? null;
}

/** Looks up `id` (a TypeID whose prefix is `prefix`). */
async function lookup(prefix: IdPrefix, id: string): Promise<ResolvedEntity | null> {
  switch (prefix) {
    case "meal": {
      const e = await getFoodEntry(id);
      return e && { title: e.title, path: `/entry/meal/${id}`, glyph: entryGlyph(e.icon, e.title, "meal") };
    }
    case "workout": {
      const w = await getWorkout(id);
      if (!w) return null;
      const glyph =
        iconGlyph(w.icon) ??
        iconGlyph(guessIconKey(w.title, "workout")) ??
        (w.source ? SYNCED_WORKOUT_GLYPH : WORKOUT_FALLBACK_GLYPH);
      return { title: w.title, path: `/entry/workout/${id}`, glyph };
    }
    case "dose": {
      const l = await getSupplementLog(id);
      return l && { title: joined(l.name, dayLabel(l.day)), path: `/entry/supplement/${id}`, glyph: "💊" };
    }
    case "supplement": {
      const s = await first(db.select({ name: supplements.name }).from(supplements).where(eq(supplements.id, id)));
      return s && { title: s.name, path: null, glyph: "💊" };
    }
    case "sleep": {
      const n = await getSleepSession(id);
      return n && { title: joined("Sleep", dayLabel(n.day), duration(n.duration_min)), path: `/entry/sleep/${id}`, glyph: "😴" };
    }
    case "fast": {
      const f = await first(db.select().from(fasts).where(eq(fasts.id, id)));
      if (!f) return null;
      const hours = f.endedAt ? (Date.parse(f.endedAt) - Date.parse(f.startedAt)) / 3_600_000 : null;
      const length =
        hours == null || !Number.isFinite(hours)
          ? `running, ${Math.round(f.goalHours)} h goal`
          : `${Math.round(hours)} h`;
      return { title: joined("Fast", length, dayLabel(f.startDay)), path: "/body", glyph: "⏳" };
    }
    case "chat": {
      const c = await getChatSummary(id);
      return c && { title: c.title, path: chatPath(id), glyph: "💬" };
    }
    case "document": {
      const d = await getDocument(id);
      return d && { title: d.title, path: "/assistant/library", glyph: "📄" };
    }
    case "memory": {
      const m = await first(db.select({ text: coachMemory.text }).from(coachMemory).where(eq(coachMemory.id, id)));
      return m && { title: excerpt(m.text), path: "/assistant/memory", glyph: "🧠" };
    }
    case "manual": {
      const m = await getManual(id);
      return m && { title: m.title, path: manualPath(id), glyph: MANUAL_GLYPH };
    }
    case "manual_revision": {
      const r = await first(
        db
          .select({ title: manualRevisions.title, manualId: manualRevisions.manualId, at: manualRevisions.writtenAt })
          .from(manualRevisions)
          .where(eq(manualRevisions.id, id)),
      );
      return r && { title: joined(r.title, `version of ${dayLabel(r.at.slice(0, 10)) ?? "earlier"}`), path: manualPath(r.manualId), glyph: MANUAL_GLYPH };
    }
    case "experiment": {
      const e = await getExperiment(id);
      return e && { title: e.title, path: experimentPath(id), glyph: EXPERIMENT_GLYPH };
    }
    case "trial": {
      const t = await getTrial(id);
      if (!t) return null;
      const e = await getExperiment(t.experiment_id);
      const arm = e?.arms.find((a) => a.key === t.arm)?.label ?? t.arm;
      return { title: joined(e?.title ?? "Trial", arm, dayLabel(t.day)), path: experimentPath(t.experiment_id), glyph: EXPERIMENT_GLYPH };
    }
    case "observation": {
      const s = await getStateLog(id);
      return s && { title: stateTitle(s), path: `/entry/state/${id}`, glyph: stateGlyphs(s).join("") };
    }
    case "observation_tag": {
      const t = await first(db.select().from(stateLogTags).where(eq(stateLogTags.id, id)));
      return t && { title: t.label, path: `/entry/state/${t.logId}`, glyph: stateGlyph(t.icon) };
    }
    case "tag": {
      const c = await first(db.select().from(stateCategories).where(eq(stateCategories.id, id)));
      return c && { title: c.label, path: null, glyph: stateGlyph(c.icon) };
    }
    case "reading": {
      const r = await getBloodReading(id);
      if (!r) return null;
      const unit = await getGlucoseUnit();
      const def = READING_DEFS[r.kind];
      return { title: `${def.label} ${formatReading(r.kind, r.value, unit)}`, path: `/entry/reading/${id}`, glyph: def.glyph };
    }
    case "performance": {
      const p = await getPerformanceLog(id);
      if (!p) return null;
      const title = p.title.trim() || statsSummary(p.stats, 2) || "Performance";
      return { title, path: `/entry/performance/${id}`, glyph: PERFORMANCE_GLYPH };
    }
    case "performance_stat": {
      const s = await first(db.select().from(performanceStats).where(eq(performanceStats.id, id)));
      return s && { title: `${s.label} ${formatStat(s)}`, path: `/entry/performance/${s.logId}`, glyph: PERFORMANCE_GLYPH };
    }
    case "note": {
      const n = await first(db.select().from(entryNotes).where(eq(entryNotes.id, id)));
      return n && { title: excerpt(n.text), path: entryPagePath(n.entryKind, n.entryId), glyph: "📝" };
    }
    case "entry_message": {
      const m = await first(db.select().from(entryMessages).where(eq(entryMessages.id, id)));
      return m && { title: excerpt(m.text), path: entryPagePath(m.entryKind, m.entryId), glyph: "💬" };
    }
    case "saved_meal": {
      const m = await getSavedMeal(id);
      return m && { title: m.name, path: null, glyph: entryGlyph(m.icon, m.name, "meal") };
    }
    case "capture": {
      const c = await getCapture(id);
      return c && { title: c.note?.trim() ? excerpt(c.note) : joined("Photo", dayLabel(c.day)), path: null, glyph: "📷" };
    }
    case "progress_photo": {
      const p = await first(db.select({ day: progressPhotos.day }).from(progressPhotos).where(eq(progressPhotos.id, id)));
      return p && { title: joined("Progress photo", dayLabel(p.day)), path: "/nutrients/progress", glyph: "🪞" };
    }
    case "coach_run": {
      const r = await first(db.select().from(coachRuns).where(eq(coachRuns.id, id)));
      return r && { title: joined("Check-in", dayLabel(r.day)), path: r.chatId ? chatPath(r.chatId) : null, glyph: "🔔" };
    }
    case "ai_usage": {
      const u = await first(db.select({ day: aiUsage.day }).from(aiUsage).where(eq(aiUsage.id, id)));
      return u && { title: joined("AI usage", dayLabel(u.day)), path: "/settings/costs", glyph: "🪙" };
    }
    case "deleted_import": {
      const d = await first(db.select({ at: deletedImports.startedAt }).from(deletedImports).where(eq(deletedImports.id, id)));
      return d && { title: joined("Deleted import", dayLabel(d.at.slice(0, 10))), path: null, glyph: "🗑" };
    }
  }
}

/**
 * What `id` stands for: a short title and the screen that shows it. Null for
 * anything that isn't one of our ids, and for a row that's gone.
 */
export async function resolveEntity(id: string): Promise<ResolvedEntity | null> {
  const parsed = parseTypeId(id);
  if (!parsed) return null;
  return lookup(parsed.prefix, id);
}

// -- Cache -----------------------------------------------------------------

interface CacheEntry {
  promise: Promise<ResolvedEntity | null>;
  /** Set once it has settled: undefined until then. */
  value?: ResolvedEntity | null;
}

const cache = new Map<string, CacheEntry>();

// A change to a table drops every cached id whose title is read from it.
// Registered here, at load, so it runs before any chip's own listener asks
// again. "Everything changed" (a sync, a resume) reaches each of these.
for (const prefix of Object.values(ID_PREFIXES)) {
  onTablesChanged(entityTables(prefix), () => {
    for (const id of [...cache.keys()]) {
      if (parseTypeId(id)?.prefix === prefix) cache.delete(id);
    }
  });
}

/**
 * `resolveEntity`, remembered until one of the tables it read from changes.
 * A lookup that fails isn't kept, so the next ask tries again.
 */
export function resolveEntityCached(id: string): Promise<ResolvedEntity | null> {
  const hit = cache.get(id);
  if (hit) return hit.promise;
  const entry: CacheEntry = { promise: resolveEntity(id) };
  cache.set(id, entry);
  entry.promise.then(
    (value) => {
      entry.value = value;
    },
    () => {
      if (cache.get(id) === entry) cache.delete(id);
    },
  );
  return entry.promise;
}

/**
 * The cached resolution of `id` if one has settled and is still current;
 * undefined otherwise — so a chip seen before renders its title at once.
 */
export function peekEntity(id: string): ResolvedEntity | null | undefined {
  return cache.get(id)?.value;
}

/**
 * Plain text with every id in it replaced by its title — for places that
 * can't show a chip, like a notification. A deleted row reads "a deleted meal".
 */
export async function withEntityTitles(text: string): Promise<string> {
  const out = await Promise.all(
    splitTypeIds(text).map(async (p) => {
      if (typeof p === "string") return p;
      const r = await resolveEntityCached(p.id).catch(() => null);
      if (r) return r.title;
      const prefix = parseTypeId(p.id)?.prefix;
      return prefix ? `a deleted ${entityNoun(prefix)}` : p.id;
    }),
  );
  return out.join("");
}
