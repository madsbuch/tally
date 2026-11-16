import { and, eq, getTableColumns, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { deletedImports, garminActivities, garminDays, healthMetrics, sleepSessions, workouts } from "../db/schema";
import { db, editedByHand, upsertSleepSession } from "./db";
import { derivedId } from "./ids";
import { dayOf, stampOf } from "./daystamp";
import { bestSessionMatch, recordIdNames, sameNight, sameSession } from "./syncMatch";
import type { Span } from "./syncMatch";
import type { GarminActivity, GarminLap } from "./schemas";
import {
  parseGarminLoadBalance,
  parseStoredGarminLaps,
  parseStoredTrainingStatusRaw,
  parseStoredZoneSecs,
} from "./schemas";
import type { GarminLoadBalance } from "./schemas";
import { CARDIO_MIN_AVG_HR, countsAsCardio, normalizeAverageHeartRate } from "./exerciseGoals";
import { WORKOUT_EDITED } from "./types";

// ---------------------------------------------------------------------------
// Storage for the Garmin Connect sync (lib/garmin.ts), and how it and Health
// Connect share the diary. Both carry the same watch's data — Health Connect
// gets it from the Garmin Connect app — so they're one source arriving twice:
//  - Health Connect is the event bus: it has a session (or a day's numbers)
//    first, so its row goes in at once, provisional;
//  - Garmin's own numbers are the ones trusted: once the Garmin sync has the
//    activity it attaches to that row (linkGarminActivity) and its values
//    replace Health Connect's, which from then on leaves them alone. A
//    session Health Connect doesn't have gets a row of its own;
//  - Health Connect, meeting a session already in the diary under another id
//    (made by the Garmin sync, or read on another phone, whose Health Connect
//    names records afresh), takes that row over instead of adding a twin
//    (adoptSyncedWorkout/Sleep);
//  - above both: a field changed by hand stays (WORKOUT_EDITED), and a
//    session deleted by hand stays deleted (`deleted_imports`).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

export type LinkOutcome = "exact" | "time" | "created" | "updated" | "skipped";

type ActivityIn = GarminActivity & { id: string; startMs: number };

function spanOfWorkout(performedAt: string, durationMin: number | null): Span {
  const startMs = Date.parse(performedAt);
  return { startMs, endMs: startMs + (durationMin ?? 0) * 60_000 };
}

function spanOfActivity(a: ActivityIn): Span {
  return { startMs: a.startMs, endMs: a.startMs + (a.durationSec ?? 0) * 1000 };
}

const TITLE_CASE = (key: string) =>
  key
    .split("_")
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");

/** "Running · 5.3 km · avg HR 142" — like the Health Connect sync's. */
function describe(a: ActivityIn): string {
  const parts = [a.typeKey ? TITLE_CASE(a.typeKey) : "Workout"];
  if (a.distanceM != null && a.distanceM >= 100) parts.push(`${(a.distanceM / 1000).toFixed(1)} km`);
  if (a.avgHr != null && a.avgHr > 0) parts.push(`avg HR ${Math.round(a.avgHr)}`);
  return parts.join(" · ");
}

/**
 * Synced workouts (Health Connect or Garmin-created) within a day of `startMs`
 * that no other Garmin activity has claimed.
 */
async function unclaimedSyncedWorkoutsNear(startMs: number, activityId: string) {
  return db
    .select({
      id: workouts.id,
      performedAt: workouts.performedAt,
      durationMin: workouts.durationMin,
      sourceRecordId: workouts.sourceRecordId,
    })
    .from(workouts)
    .where(
      and(
        isNotNull(workouts.externalId),
        gte(workouts.performedAt, iso(startMs - DAY_MS)),
        lte(workouts.performedAt, iso(startMs + DAY_MS)),
        sql`NOT EXISTS (SELECT 1 FROM ${garminActivities} WHERE ${garminActivities.workoutId} = ${workouts.id} AND ${garminActivities.activityId} <> ${activityId})`,
      ),
    );
}

function detailValues(a: ActivityIn, raw: Record<string, unknown>) {
  return {
    startedAt: iso(a.startMs),
    durationSec: a.durationSec,
    typeKey: a.typeKey,
    name: a.name,
    distanceM: a.distanceM,
    avgHr: a.avgHr,
    maxHr: a.maxHr,
    calories: a.calories,
    aerobicTe: a.aerobicTe,
    anaerobicTe: a.anaerobicTe,
    teLabel: a.teLabel,
    trainingLoad: a.trainingLoad,
    avgPower: a.avgPower,
    maxPower: a.maxPower,
    normPower: a.normPower,
    avgCadence: a.avgCadence,
    elevationGainM: a.elevationGainM,
    avgSpeedMps: a.avgSpeedMps,
    vo2Max: a.vo2Max,
    zoneSecs: a.zoneSecs,
    summary: raw,
    updatedAt: new Date().toISOString(),
  };
}

function workoutValuesFor(a: ActivityIn) {
  const durationMin = a.durationSec != null ? Math.round(a.durationSec / 60) : null;
  const avgHr = normalizeAverageHeartRate(a.avgHr);
  return {
    performedAt: iso(a.startMs),
    title: a.name?.trim() || (a.typeKey ? TITLE_CASE(a.typeKey) : "Workout"),
    description: describe(a),
    caloriesBurned: Math.round(a.activeCalories ?? 0),
    durationMin: durationMin != null && durationMin > 0 ? durationMin : null,
    avgHr,
    cardio: countsAsCardio(avgHr) ? 1 : 0,
  };
}

/**
 * Garmin's numbers onto the workout an activity is linked to, whoever made
 * the row: what Health Connect wrote there was provisional. A field changed
 * by hand stays, and so does whatever Garmin has no value for.
 */
async function applyGarminToWorkout(workoutId: string, a: ActivityIn): Promise<void> {
  const E = WORKOUT_EDITED;
  const col = (name: string) => sql.raw(`"workouts"."${name}"`);
  const follow = (bit: number, name: string, value: string | number | null) =>
    sql`CASE WHEN ${editedByHand(bit)} THEN ${col(name)} ELSE coalesce(${value}, ${col(name)}) END`;
  const minutes = a.durationSec != null ? Math.round(a.durationSec / 60) : null;
  const avgHr = follow(E.avgHr, "avg_hr", normalizeAverageHeartRate(a.avgHr));
  const duration = follow(E.duration, "duration_min", minutes != null && minutes > 0 ? minutes : null);
  const startedAt = iso(a.startMs);
  await db
    .update(workouts)
    .set({
      title: follow(E.title, "title", a.name?.trim() || null),
      description: follow(E.description, "description", describe(a)),
      caloriesBurned: follow(
        E.calories,
        "calories_burned",
        a.activeCalories != null ? Math.round(a.activeCalories) : null,
      ),
      durationMin: duration,
      avgHr,
      // The time only with the zone it was in, so the day is the one it was.
      ...(a.offsetMin != null
        ? {
            performedAt: follow(E.time, "performed_at", startedAt),
            day: follow(E.time, "day", dayOf(startedAt, a.offsetMin)),
            tzOffsetMin: follow(E.time, "tz_offset_min", a.offsetMin),
          }
        : {}),
      cardio: sql`CASE WHEN ${col("cardio_by_hand")} = 1 THEN ${col("cardio")}
        WHEN (${avgHr}) > ${CARDIO_MIN_AVG_HR} THEN 1 ELSE 0 END`,
      // Whole-session Zone 2 marks follow a corrected duration.
      zone2Min: sql`CASE WHEN ${col("zone2_min")} > 0 AND ${col("zone2_min")} = ${col("duration_min")}
        AND (${duration}) > 0 THEN (${duration}) ELSE ${col("zone2_min")} END`,
    })
    .where(eq(workouts.id, workoutId));
}

/**
 * Whether the user deleted this session from the diary (`deleted_imports`):
 * by one of its ids, or — under an id it didn't have then, as a new phone's
 * Health Connect gives — by its time.
 */
export async function deletedByHand(externalIds: string[], span: Span): Promise<boolean> {
  const rows = await db
    .select({ externalId: deletedImports.externalId, startedAt: deletedImports.startedAt, endedAt: deletedImports.endedAt })
    .from(deletedImports)
    .where(
      or(
        inArray(deletedImports.externalId, externalIds),
        and(gte(deletedImports.startedAt, iso(span.startMs - DAY_MS)), lte(deletedImports.startedAt, iso(span.startMs + DAY_MS))),
      ),
    );
  return rows.some(
    (r) =>
      externalIds.includes(r.externalId) ||
      sameSession(span, { startMs: Date.parse(r.startedAt), endMs: Date.parse(r.endedAt) }),
  );
}

/**
 * Store one Garmin activity and attach it to its diary workout: the one it
 * already belongs to, else the Health Connect row naming it (exact) or
 * recorded at the same time, else a new row — unless the user deleted its
 * workout before, in which case it is only ever re-attached, never re-made.
 * Its numbers then replace the provisional ones on that row.
 */
export async function linkGarminActivity(
  a: ActivityIn,
  raw: Record<string, unknown>,
): Promise<LinkOutcome> {
  const details = detailValues(a, raw);
  const [existing] = await db
    .select({
      workoutId: garminActivities.workoutId,
      dismissed: garminActivities.dismissed,
      linkedBy: garminActivities.linkedBy,
    })
    .from(garminActivities)
    .where(eq(garminActivities.activityId, a.id));

  if (existing?.workoutId != null) {
    const [w] = await db
      .select({ id: workouts.id, externalId: workouts.externalId })
      .from(workouts)
      .where(eq(workouts.id, existing.workoutId));
    if (w) {
      await db.update(garminActivities).set(details).where(eq(garminActivities.activityId, a.id));
      // Follows edits made in Garmin Connect; never what was changed here by
      // hand, the icon, the manual cardio choice or Zone 2 marks.
      await applyGarminToWorkout(w.id, a);
      return "updated";
    }
  }

  const candidates = await unclaimedSyncedWorkoutsNear(a.startMs, a.id);
  let match: { id: string; how: "exact" | "time" } | null = null;
  const exact = candidates.find((c) => recordIdNames(c.sourceRecordId, a.id));
  if (exact) {
    match = { id: exact.id, how: "exact" };
  } else {
    const best = bestSessionMatch(
      spanOfActivity(a),
      candidates.map((c) => ({ id: c.id, ...spanOfWorkout(c.performedAt, c.durationMin) })),
    );
    if (best) match = { id: best.id, how: "time" };
  }

  let workoutId: string | null = match?.id ?? null;
  let outcome: LinkOutcome = match?.how ?? "skipped";
  // Deleted by hand: its own row, or the Health Connect one it would have
  // joined (that one's id is gone, but not when it was).
  const deleted =
    !match && (existing?.dismissed === 1 || (await deletedByHand([`garmin:${a.id}`], spanOfActivity(a))));
  if (!match && !deleted) {
    const tzOffsetMin = a.offsetMin ?? stampOf(iso(a.startMs)).tz_offset_min;
    const values = workoutValuesFor(a);
    const externalId = `garmin:${a.id}`;
    await db
      .insert(workouts)
      .values({
        ...values,
        // Named after the activity, so two devices importing it agree on its id.
        id: await derivedId("workouts", externalId),
        day: dayOf(values.performedAt, tzOffsetMin),
        tzOffsetMin,
        source: "Garmin",
        externalId,
      })
      .onConflictDoNothing();
    const [row] = await db.select({ id: workouts.id }).from(workouts).where(eq(workouts.externalId, externalId));
    workoutId = row?.id ?? null;
    outcome = "created";
  }

  const linkedBy = outcome === "skipped" ? (existing?.linkedBy ?? null) : outcome;
  const dismissed = workoutId == null && deleted ? 1 : 0;
  await db
    .insert(garminActivities)
    .values({ activityId: a.id, workoutId, dismissed, linkedBy, ...details })
    .onConflictDoUpdate({
      target: garminActivities.activityId,
      set: { workoutId, dismissed, linkedBy, ...details },
    });
  if (workoutId != null) await applyGarminToWorkout(workoutId, a);
  return outcome;
}

/**
 * Health Connect side: before writing session `hcId`, take over the synced
 * row that is the same session under another id, if there is one, so the
 * upsert that follows updates it instead of adding a twin. That's the row the
 * Garmin sync made for it, or one read from Health Connect on another phone —
 * every phone's Health Connect names records afresh. Rows named by sessions
 * in this same read (`claimed`) are theirs, not up for taking.
 *
 * Says whether the session was already in the diary — its own row ("known"),
 * or one under another id ("adopted") — or is new to it ("new").
 */
export async function adoptSyncedWorkout(
  hcId: string,
  clientRecordId: string | null | undefined,
  span: Span,
  claimed: ReadonlySet<string> = new Set(),
): Promise<"known" | "adopted" | "new"> {
  const [own] = await db
    .select({ id: workouts.id })
    .from(workouts)
    .where(eq(workouts.externalId, hcId));
  if (own) return "known";
  const rows = (
    await db
      .select({
        id: workouts.id,
        externalId: workouts.externalId,
        sourceRecordId: workouts.sourceRecordId,
        performedAt: workouts.performedAt,
        durationMin: workouts.durationMin,
      })
      .from(workouts)
      .where(
        and(
          isNotNull(workouts.externalId),
          ne(workouts.externalId, hcId),
          gte(workouts.performedAt, iso(span.startMs - DAY_MS)),
          lte(workouts.performedAt, iso(span.startMs + DAY_MS)),
        ),
      )
  ).filter((r) => !claimed.has(r.externalId ?? ""));
  const exact = rows.find((r) =>
    r.externalId?.startsWith("garmin:")
      ? recordIdNames(clientRecordId, r.externalId.slice(7))
      : clientRecordId != null && r.sourceRecordId === clientRecordId,
  );
  const hit =
    exact ??
    bestSessionMatch(
      span,
      rows.map((r) => ({ id: r.id, ...spanOfWorkout(r.performedAt, r.durationMin) })),
    );
  if (!hit) return "new";
  await db.update(workouts).set({ externalId: hcId }).where(eq(workouts.id, hit.id));
  return "adopted";
}

/**
 * The same for a night: take over the synced session it is (overlapping it
 * mostly), Garmin-made or from another phone's Health Connect. Says whether
 * the night was new to the diary.
 */
export async function adoptSyncedSleep(
  hcId: string,
  span: Span,
  claimed: ReadonlySet<string> = new Set(),
): Promise<"known" | "adopted" | "new"> {
  const [own] = await db
    .select({ id: sleepSessions.id })
    .from(sleepSessions)
    .where(eq(sleepSessions.externalId, hcId));
  if (own) return "known";
  const rows = (
    await db
      .select({
        id: sleepSessions.id,
        externalId: sleepSessions.externalId,
        startedAt: sleepSessions.startedAt,
        endedAt: sleepSessions.endedAt,
      })
      .from(sleepSessions)
      .where(
        and(
          ne(sleepSessions.externalId, hcId),
          lte(sleepSessions.startedAt, iso(span.endMs)),
          gte(sleepSessions.endedAt, iso(span.startMs)),
        ),
      )
  ).filter((r) => !claimed.has(r.externalId));
  const hit = rows.find((r) =>
    sameNight(span, { startMs: Date.parse(r.startedAt), endMs: Date.parse(r.endedAt) }),
  );
  if (!hit) return "new";
  await db.update(sleepSessions).set({ externalId: hcId }).where(eq(sleepSessions.id, hit.id));
  return "adopted";
}

/** Recent activities still without laps, newest first. */
export async function activitiesMissingLaps(sinceMs: number, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: garminActivities.activityId })
    .from(garminActivities)
    .where(
      and(
        sql`${garminActivities.laps} IS NULL`,
        gte(garminActivities.startedAt, iso(sinceMs)),
      ),
    )
    .orderBy(sql`${garminActivities.startedAt} DESC`)
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function setGarminLaps(activityId: string, laps: GarminLap[]): Promise<void> {
  await db.update(garminActivities).set({ laps }).where(eq(garminActivities.activityId, activityId));
}

export type GarminDayRow = typeof garminDays.$inferInsert;

/**
 * Write a day, merging into what's there: a value only replaces another, never
 * erases it, and `raw` gains the new endpoints' answers beside the old. The
 * Personal API and the optional sign-in each fill part of a day (readiness
 * and training status only come from the latter), so neither may blank out
 * the other's columns.
 */
export async function upsertGarminDay(row: GarminDayRow): Promise<void> {
  const set: Record<string, SQL> = {};
  for (const [key, col] of Object.entries(getTableColumns(garminDays))) {
    if (key === "day") continue;
    const excluded = sql.raw(`excluded."${col.name}"`);
    set[key] =
      key === "raw"
        ? sql`json_patch(COALESCE(${garminDays.raw}, '{}'), COALESCE(${excluded}, '{}'))`
        : sql`COALESCE(${excluded}, ${col})`;
  }
  await db.insert(garminDays).values(row).onConflictDoUpdate({ target: garminDays.day, set });
}

/** Whether Garmin had anything at all for that day (for the backfill's end). */
export function garminDayHasData(row: GarminDayRow): boolean {
  return (
    row.steps != null ||
    row.restingHr != null ||
    row.sleepId != null ||
    row.caloriesTotal != null ||
    row.hrvLastNight != null
  );
}

/**
 * Garmin wins; Health Connect fills what Garmin doesn't have. Garmin's own
 * daily numbers — the whole-day burn above all — replace Health Connect's for
 * the same day; days and columns Garmin has nothing for keep Health
 * Connect's. (A Health Connect sync defers to Garmin the same way as it
 * writes, see upsertHealthMetric, so its number never shows in between.)
 *
 * Local and idempotent — run after either sync (a Health Connect full resync
 * wipes and rewrites its days). A day already as Garmin has it isn't written
 * again, so a sync that brought nothing new changes nothing.
 */
export async function applyGarminMetrics(): Promise<void> {
  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO health_metrics (day, steps, resting_hr, hrv_ms, spo2_pct, weight_kg, vo2_max, calories_total, updated_at)
    SELECT day, steps, resting_hr, hrv_last_night, spo2_avg, weight_kg, vo2_max, calories_total, ${now}
    FROM garmin_days
    WHERE steps IS NOT NULL OR resting_hr IS NOT NULL OR hrv_last_night IS NOT NULL
      OR spo2_avg IS NOT NULL OR weight_kg IS NOT NULL OR vo2_max IS NOT NULL OR calories_total IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET
      steps = COALESCE(excluded.steps, health_metrics.steps),
      resting_hr = COALESCE(excluded.resting_hr, health_metrics.resting_hr),
      hrv_ms = COALESCE(excluded.hrv_ms, health_metrics.hrv_ms),
      spo2_pct = COALESCE(excluded.spo2_pct, health_metrics.spo2_pct),
      weight_kg = COALESCE(excluded.weight_kg, health_metrics.weight_kg),
      vo2_max = COALESCE(excluded.vo2_max, health_metrics.vo2_max),
      calories_total = COALESCE(excluded.calories_total, health_metrics.calories_total),
      updated_at = excluded.updated_at
    WHERE excluded.steps IS NOT health_metrics.steps AND excluded.steps IS NOT NULL
      OR excluded.resting_hr IS NOT health_metrics.resting_hr AND excluded.resting_hr IS NOT NULL
      OR excluded.hrv_ms IS NOT health_metrics.hrv_ms AND excluded.hrv_ms IS NOT NULL
      OR excluded.spo2_pct IS NOT health_metrics.spo2_pct AND excluded.spo2_pct IS NOT NULL
      OR excluded.weight_kg IS NOT health_metrics.weight_kg AND excluded.weight_kg IS NOT NULL
      OR excluded.vo2_max IS NOT health_metrics.vo2_max AND excluded.vo2_max IS NOT NULL
      OR excluded.calories_total IS NOT health_metrics.calories_total AND excluded.calories_total IS NOT NULL
  `);
  // Keep the reference to the table so a rename breaks the build, not the SQL.
  void healthMetrics;
}

/** A night as Garmin has it (the sleep columns of `garmin_days`). */
export interface GarminNight {
  sleepId: string;
  startMs: number;
  endMs: number;
  tzOffsetMin: number | null;
  deepMin: number | null;
  remMin: number | null;
  lightMin: number | null;
  awakeMin: number | null;
}

/** Garmin's nights that ended from `fromMs` on. */
export async function garminNightsSince(fromMs: number): Promise<GarminNight[]> {
  const rows = await db
    .select({
      sleepId: garminDays.sleepId,
      startedAt: garminDays.sleepStartedAt,
      endedAt: garminDays.sleepEndedAt,
      tz: garminDays.sleepTzOffsetMin,
      deep: garminDays.sleepDeepMin,
      rem: garminDays.sleepRemMin,
      light: garminDays.sleepLightMin,
      awake: garminDays.sleepAwakeMin,
    })
    .from(garminDays)
    .where(
      and(
        isNotNull(garminDays.sleepId),
        isNotNull(garminDays.sleepStartedAt),
        gte(garminDays.sleepEndedAt, iso(fromMs)),
      ),
    );
  return rows.flatMap((r) => {
    const startMs = Date.parse(r.startedAt ?? "");
    const endMs = Date.parse(r.endedAt ?? "");
    if (!r.sleepId || !(endMs > startMs)) return [];
    return [{
      sleepId: r.sleepId,
      startMs,
      endMs,
      tzOffsetMin: r.tz,
      deepMin: r.deep,
      remMin: r.rem,
      lightMin: r.light,
      awakeMin: r.awake,
    }];
  });
}

const overlap = (a: Span, b: Span) => Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);

/** Which of `nights` the night `span` is (see sameNight; the most overlap wins). */
export function garminNightFor(span: Span, nights: GarminNight[]): GarminNight | null {
  let best: GarminNight | null = null;
  for (const n of nights) {
    if (!sameNight(span, n)) continue;
    if (best == null || overlap(span, n) > overlap(span, best)) best = n;
  }
  return best;
}

/**
 * Garmin's nights into the diary. Over the session that is that night,
 * whoever wrote it — Health Connect's times and stages were provisional — and
 * as a session of its own (keyed `garmin-sleep:<id>`) where there's none. A
 * stage Garmin has no number for keeps the one there. Only nights that differ
 * are written. Returns how many were added.
 */
export async function applyGarminSleep(): Promise<number> {
  const nights = await garminNightsSince(0);
  if (nights.length === 0) return 0;
  const sessions = await db
    .select({
      externalId: sleepSessions.externalId,
      startedAt: sleepSessions.startedAt,
      endedAt: sleepSessions.endedAt,
      deep: sleepSessions.deepMin,
      rem: sleepSessions.remMin,
      light: sleepSessions.lightMin,
      awake: sleepSessions.awakeMin,
      tz: sleepSessions.tzOffsetMin,
      sourceRecordId: sleepSessions.sourceRecordId,
    })
    .from(sleepSessions);
  const spans = sessions.map((s) => ({ ...s, startMs: Date.parse(s.startedAt), endMs: Date.parse(s.endedAt) }));
  let added = 0;
  for (const n of nights) {
    const near = spans.filter((s) => s.startMs < n.endMs && s.endMs > n.startMs);
    let same: (typeof spans)[number] | null = null;
    for (const s of near) {
      if (sameNight(n, s) && (same == null || overlap(n, s) > overlap(n, same))) same = s;
    }
    // Something else is there (a nap across the edge of it, say): leave it.
    if (!same && near.length > 0) continue;
    const values = {
      started_at: iso(n.startMs),
      ended_at: iso(n.endMs),
      duration_min: Math.round((n.endMs - n.startMs) / 60_000),
      deep_min: n.deepMin ?? same?.deep ?? null,
      rem_min: n.remMin ?? same?.rem ?? null,
      light_min: n.lightMin ?? same?.light ?? null,
      awake_min: n.awakeMin ?? same?.awake ?? null,
    };
    if (
      same &&
      same.startedAt === values.started_at &&
      same.endedAt === values.ended_at &&
      same.deep === values.deep_min &&
      same.rem === values.rem_min &&
      same.light === values.light_min &&
      same.awake === values.awake_min &&
      (n.tzOffsetMin == null || same.tz === n.tzOffsetMin)
    ) {
      continue;
    }
    if (values.duration_min <= 0) continue;
    await upsertSleepSession({
      external_id: same?.externalId ?? `garmin-sleep:${n.sleepId}`,
      ...values,
      source: "Garmin",
      tz_offset_min: n.tzOffsetMin ?? same?.tz ?? null,
      source_record_id: same?.sourceRecordId ?? null,
    });
    if (!same) added++;
  }
  return added;
}

export interface GarminLinkReport {
  activities: number;
  exact: number;
  time: number;
  created: number;
  dismissed: number;
  days: number;
  earliestDay: string | null;
  /** Health Connect workouts that carry a clientRecordId, and one example. */
  hcWithRecordId: number;
  hcRecordIdExample: string | null;
}

/** What the Garmin sync has stored and how it attached it — for Settings. */
export async function garminLinkReport(): Promise<GarminLinkReport> {
  const byHow = await db
    .select({ how: garminActivities.linkedBy, dismissed: garminActivities.dismissed, n: sql<number>`count(*)` })
    .from(garminActivities)
    .groupBy(garminActivities.linkedBy, garminActivities.dismissed);
  const count = (how: string) =>
    byHow.filter((r) => r.how === how && !r.dismissed).reduce((s, r) => s + Number(r.n), 0);
  const [days] = await db
    .select({ n: sql<number>`count(*)`, earliest: sql<string | null>`min(${garminDays.day})` })
    .from(garminDays);
  const [rec] = await db
    .select({ n: sql<number>`count(*)`, example: sql<string | null>`max(${workouts.sourceRecordId})` })
    .from(workouts)
    .where(isNotNull(workouts.sourceRecordId));
  return {
    activities: byHow.reduce((s, r) => s + Number(r.n), 0),
    exact: count("exact"),
    time: count("time"),
    created: count("created"),
    dismissed: byHow.filter((r) => r.dismissed).reduce((s, r) => s + Number(r.n), 0),
    days: Number(days?.n ?? 0),
    earliestDay: days?.earliest ?? null,
    hcWithRecordId: Number(rec?.n ?? 0),
    hcRecordIdExample: rec?.example ?? null,
  };
}

/** Earliest Garmin activity day — how far back the wellness backfill goes. */
export async function earliestGarminActivityAt(): Promise<string | null> {
  const [r] = await db
    .select({ at: sql<string | null>`min(${garminActivities.startedAt})` })
    .from(garminActivities);
  return r?.at ?? null;
}

export interface GarminWorkoutDetail {
  workoutId: string;
  activityId: string;
  typeKey: string | null;
  distanceM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  aerobicTe: number | null;
  anaerobicTe: number | null;
  teLabel: string | null;
  trainingLoad: number | null;
  avgPower: number | null;
  normPower: number | null;
  avgCadence: number | null;
  elevationGainM: number | null;
  avgSpeedMps: number | null;
  vo2Max: number | null;
  zoneSecs: number[] | null;
  laps: GarminLap[] | null;
}

/** Garmin's detail for these workouts, keyed by workout id. */
export async function garminDetailsForWorkouts(
  ids: string[],
): Promise<Map<string, GarminWorkoutDetail>> {
  const out = new Map<string, GarminWorkoutDetail>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(garminActivities)
    .where(inArray(garminActivities.workoutId, ids));
  for (const r of rows) {
    if (r.workoutId == null) continue;
    out.set(r.workoutId, {
      workoutId: r.workoutId,
      activityId: r.activityId,
      typeKey: r.typeKey,
      distanceM: r.distanceM,
      avgHr: r.avgHr,
      maxHr: r.maxHr,
      aerobicTe: r.aerobicTe,
      anaerobicTe: r.anaerobicTe,
      teLabel: r.teLabel,
      trainingLoad: r.trainingLoad,
      avgPower: r.avgPower,
      normPower: r.normPower,
      avgCadence: r.avgCadence,
      elevationGainM: r.elevationGainM,
      avgSpeedMps: r.avgSpeedMps,
      vo2Max: r.vo2Max,
      zoneSecs: parseStoredZoneSecs(r.zoneSecs),
      laps: r.laps == null ? null : parseStoredGarminLaps(r.laps),
    });
  }
  return out;
}

export type GarminDay = typeof garminDays.$inferSelect;

/** Garmin wellness days in a range, newest first (the `raw` blob left out). */
export async function listGarminDaysForRange(
  startDay: string,
  endDay: string,
): Promise<Omit<GarminDay, "raw">[]> {
  const rows = await db
    .select()
    .from(garminDays)
    .where(and(gte(garminDays.day, startDay), lte(garminDays.day, endDay)))
    .orderBy(sql`${garminDays.day} DESC`);
  return rows.map(({ raw: _raw, ...rest }) => rest);
}

/**
 * Garmin's own load focus for the newest day from `startDay` through `endDay`
 * that has one (it only comes with the optional sign-in), with that day.
 */
export async function latestGarminLoadBalance(
  startDay: string,
  endDay: string,
): Promise<{ day: string; balance: GarminLoadBalance } | null> {
  const rows = await db
    .select({ day: garminDays.day, raw: garminDays.raw })
    .from(garminDays)
    .where(and(gte(garminDays.day, startDay), lte(garminDays.day, endDay)))
    .orderBy(sql`${garminDays.day} DESC`);
  for (const r of rows) {
    const balance = parseGarminLoadBalance(parseStoredTrainingStatusRaw(r.raw));
    if (balance) return { day: r.day, balance };
  }
  return null;
}
