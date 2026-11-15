import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { sqlite } from "./testDb";
import { CARDIO_MIN_AVG_HR, countsAsCardio, exerciseTarget, normalizeAverageHeartRate } from "../src/lib/exerciseGoals";
import { parseEntrySnapshot, parseGarminActivities, WorkoutAnalysisSchema, WorkoutChatSchema } from "../src/lib/schemas";

const { addWorkout, getWorkout, updateWorkout, setWorkoutCardio, upsertExternalWorkout, listWorkoutsForRange } = await import("../src/lib/db");
const { cardioMinutes, getCardioTarget } = await import("../src/lib/goals");
const { adoptGarminWorkout, linkGarminActivity } = await import("../src/lib/garminDb");

const workout = {
  performed_at: "2026-10-28T12:00:00Z", title: "Cycling", description: null,
  photo_path: null, calories_burned: 250, duration_min: 60, model_id: null, icon: null,
};
const startMs = Date.parse(workout.performed_at);

async function expectCardio(id: number, avgHr: number | null, cardio: boolean, byHand: boolean) {
  expect(await getWorkout(id)).toMatchObject({ avg_hr: avgHr, cardio, cardio_by_hand: byHand });
  expect(sqlite.query("SELECT avg_hr, cardio, cardio_by_hand FROM workouts WHERE id = ?").get(id)).toEqual({
    avg_hr: avgHr, cardio: cardio ? 1 : 0, cardio_by_hand: byHand ? 1 : 0,
  });
}

function garminActivity(id: number, avgHr: number | null) {
  const raw = {
    activityId: id,
    activityName: "Cycling",
    beginTimestamp: startMs,
    duration: 3600,
    averageHR: avgHr,
    hrTimeInZone_2: 3600,
  };
  const { activities, raws } = parseGarminActivities([raw]);
  const activity = activities[0]!;
  return { activity: { ...activity, id: activity.id!, startMs: activity.startMs! }, raw: raws[0]! };
}

beforeEach(() => {
  sqlite.exec("DELETE FROM garmin_activities; DELETE FROM workouts; DELETE FROM settings;");
});

describe("cardio from average heart rate", () => {
  test("the threshold is strictly above 125 and preserves fractional heart rates", () => {
    expect(CARDIO_MIN_AVG_HR).toBe(125);
    expect(countsAsCardio(124.9)).toBe(false);
    expect(countsAsCardio(125)).toBe(false);
    expect(countsAsCardio(125.1)).toBe(true);
    expect(normalizeAverageHeartRate(125.1)).toBe(125.1);
  });

  test("missing, nonpositive and nonfinite heart rates never count", () => {
    for (const value of [null, undefined, 0, -1, NaN, Infinity, -Infinity]) {
      expect(normalizeAverageHeartRate(value)).toBeNull();
      expect(countsAsCardio(value)).toBe(false);
    }
  });

  test("totals use valid duration and manual choices override automatic HR classification", () => {
    const rows = [
      { avg_hr: 125.1, duration_min: 45.5, cardio: false, cardio_by_hand: false },
      { avg_hr: 160, duration_min: 30, cardio: false, cardio_by_hand: false },
      { avg_hr: 125, duration_min: 60, cardio: true, cardio_by_hand: false },
      { avg_hr: null, duration_min: 60, cardio: true, cardio_by_hand: false },
      { avg_hr: null, duration_min: 20, cardio: true, cardio_by_hand: true },
      { avg_hr: 124, duration_min: 15, cardio: true, cardio_by_hand: true },
      { avg_hr: 160, duration_min: 60, cardio: false, cardio_by_hand: true },
      { avg_hr: 150, duration_min: null, cardio: true, cardio_by_hand: true },
      { avg_hr: 150, duration_min: 0, cardio: true, cardio_by_hand: true },
      { avg_hr: 150, duration_min: -10, cardio: true, cardio_by_hand: true },
      { avg_hr: 150, duration_min: Infinity, cardio: true, cardio_by_hand: true },
      { avg_hr: 150, duration_min: NaN, cardio: true, cardio_by_hand: true },
    ];
    expect(cardioMinutes(rows)).toBe(110.5);
  });

  test("the seven-day goal remains 300 minutes", async () => {
    const target = await getCardioTarget();
    expect(target).toBe(300);
    expect(exerciseTarget(target, 7)).toBe(300);
    expect(exerciseTarget(target, 24)).toBe(1200);
  });

  test("capture and chat schemas preserve precision and distinguish absent HR from clearing it", () => {
    expect(WorkoutAnalysisSchema.parse({ avg_hr: 125.1 }).avg_hr).toBe(125.1);
    for (const avg_hr of [null, undefined, -1, 0, "unknown"]) {
      expect(WorkoutAnalysisSchema.parse({ avg_hr }).avg_hr).toBeNull();
    }
    expect(WorkoutChatSchema.parse({ reply: "OK", entry: { avg_hr: 125.1 } }).entry?.avg_hr).toBe(125.1);
    expect(WorkoutChatSchema.parse({ reply: "OK", entry: { avg_hr: null } }).entry?.avg_hr).toBeNull();
    expect(WorkoutChatSchema.parse({ reply: "OK", entry: { title: "Ride" } }).entry?.avg_hr).toBeUndefined();
    expect(WorkoutChatSchema.parse({ reply: "OK", entry: { avg_hr: "unknown" } }).entry?.avg_hr).toBeUndefined();
    const snapshot = parseEntrySnapshot({ ...workout, id: 1, source: null, external_id: null, day: null, tz_offset_min: null });
    expect(snapshot && "avg_hr" in snapshot ? snapshot.avg_hr : undefined).toBeNull();
  });

  test("automatic workouts follow HR edits while explicit initial choices remain manual", async () => {
    const id = await addWorkout({ ...workout, avg_hr: 125 });
    await expectCardio(id, 125, false, false);
    await updateWorkout({ ...(await getWorkout(id))!, avg_hr: 125.1 });
    await expectCardio(id, 125.1, true, false);
    await updateWorkout({ ...(await getWorkout(id))!, avg_hr: null });
    await expectCardio(id, null, false, false);
    const manualOn = await addWorkout({ ...workout, cardio: true });
    await expectCardio(manualOn, null, true, true);
    const manualOff = await addWorkout({ ...workout, avg_hr: 150, cardio: false });
    await expectCardio(manualOff, 150, false, true);
    const restoredAuto = await addWorkout({ ...workout, avg_hr: 125, cardio: true, cardio_by_hand: false });
    await expectCardio(restoredAuto, 125, false, false);
  });

  test("manual on and off survive stale edits until explicitly reset to automatic", async () => {
    const id = await addWorkout({ ...workout, avg_hr: 150 });
    const beforeToggle = (await getWorkout(id))!;
    await setWorkoutCardio(id, false);
    await updateWorkout({ ...beforeToggle, title: "Corrected ride", avg_hr: 151 });
    await expectCardio(id, 151, false, true);
    expect(cardioMinutes([(await getWorkout(id))!])).toBe(0);
    await setWorkoutCardio(id, null);
    await expectCardio(id, 151, true, false);

    const beforeOn = (await getWorkout(id))!;
    await setWorkoutCardio(id, true);
    await updateWorkout({ ...beforeOn, avg_hr: null, duration_min: 65 });
    await expectCardio(id, null, true, true);
    expect(cardioMinutes([(await getWorkout(id))!])).toBe(65);
    await setWorkoutCardio(id, null);
    await expectCardio(id, null, false, false);
    await updateWorkout({ ...(await getWorkout(id))!, avg_hr: 125.1 });
    await expectCardio(id, 125.1, true, false);
  });

  test("Health Connect refreshes preserve precision and recalculate existing rows", async () => {
    const external = { ...workout, source: "Garmin", external_id: "hc-cardio" };
    await upsertExternalWorkout({ ...external, avg_hr: 125.1 });
    let rows = await listWorkoutsForRange("2026-10-28", "2026-10-28");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ avg_hr: 125.1, cardio: true });
    expect(cardioMinutes(rows)).toBe(60);
    await upsertExternalWorkout({ ...external, avg_hr: 125, duration_min: 65 });
    rows = await listWorkoutsForRange("2026-10-28", "2026-10-28");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ avg_hr: 125, cardio: false, cardio_by_hand: false, duration_min: 65 });
    expect(cardioMinutes(rows)).toBe(0);
    await upsertExternalWorkout({ ...external, avg_hr: null });
    expect(await getWorkout(rows[0]!.id)).toMatchObject({ avg_hr: null, cardio: false });
  });

  test("both manual choices survive Health Connect resync while HR and duration update", async () => {
    for (const choice of [true, false]) {
      const external = { ...workout, source: "Garmin", external_id: `hc-manual-${choice}` };
      await upsertExternalWorkout({ ...external, avg_hr: choice ? 150 : 120 });
      const row = (await listWorkoutsForRange("2026-10-28", "2026-10-28")).find((w) => w.external_id === external.external_id)!;
      await setWorkoutCardio(row.id, choice);
      const correctedHr = choice ? 120 : 150;
      await upsertExternalWorkout({ ...external, avg_hr: correctedHr, duration_min: 70 });
      await expectCardio(row.id, correctedHr, choice, true);
      expect(cardioMinutes([(await getWorkout(row.id))!])).toBe(choice ? 70 : 0);
      await setWorkoutCardio(row.id, null);
      await expectCardio(row.id, correctedHr, !choice, false);
    }
  });

  test("Garmin-created workouts follow corrected average HR rather than Zone 2 time", async () => {
    const first = garminActivity(8001, 125.1);
    expect(await linkGarminActivity(first.activity, first.raw)).toBe("created");
    const [row] = await listWorkoutsForRange("2026-10-28", "2026-10-28");
    expect(row).toMatchObject({ avg_hr: 125.1, cardio: true });
    const corrected = garminActivity(8001, 125);
    expect(await linkGarminActivity(corrected.activity, corrected.raw)).toBe("updated");
    expect(await getWorkout(row!.id)).toMatchObject({ avg_hr: 125, cardio: false, cardio_by_hand: false });
  });

  test("both manual choices survive Garmin-owned updates with changed HR and duration", async () => {
    for (const [index, choice] of [true, false].entries()) {
      const first = garminActivity(8100 + index, choice ? 150 : 120);
      await linkGarminActivity(first.activity, first.raw);
      const row = (await listWorkoutsForRange("2026-10-28", "2026-10-28")).find((w) => w.external_id === `garmin:${8100 + index}`)!;
      await setWorkoutCardio(row.id, choice);
      const corrected = garminActivity(8100 + index, choice ? 120 : 150);
      corrected.activity.durationSec = 4200;
      await linkGarminActivity(corrected.activity, corrected.raw);
      await expectCardio(row.id, corrected.activity.avgHr, choice, true);
      expect(cardioMinutes([(await getWorkout(row.id))!])).toBe(choice ? 70 : 0);
    }
  });

  test("the latest measured Garmin or Health Connect HR updates one linked workout", async () => {
    const external = { ...workout, source: "Garmin", external_id: "hc-linked", source_record_id: "8002" };
    await upsertExternalWorkout(external);
    const garmin = garminActivity(8002, 125.1);
    expect(await linkGarminActivity(garmin.activity, garmin.raw)).toBe("exact");
    let rows = await listWorkoutsForRange("2026-10-28", "2026-10-28");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ avg_hr: 125.1, cardio: true });
    await upsertExternalWorkout({ ...external, avg_hr: 125 });
    expect(await getWorkout(rows[0]!.id)).toMatchObject({ avg_hr: 125, cardio: false });
    expect(await linkGarminActivity(garmin.activity, garmin.raw)).toBe("updated");
    rows = await listWorkoutsForRange("2026-10-28", "2026-10-28");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ avg_hr: 125.1, cardio: true });
    const missing = garminActivity(8002, null);
    await linkGarminActivity(missing.activity, missing.raw);
    expect(await getWorkout(rows[0]!.id)).toMatchObject({ avg_hr: 125.1, cardio: true });
  });

  test("Garmin linking and later refreshes preserve either manual choice on Health Connect rows", async () => {
    for (const [index, choice] of [true, false].entries()) {
      const activityId = 8200 + index;
      const external = { ...workout, source: "Garmin", external_id: `hc-manual-link-${choice}`, source_record_id: String(activityId) };
      await upsertExternalWorkout(external);
      const row = (await listWorkoutsForRange("2026-10-28", "2026-10-28")).find((w) => w.external_id === external.external_id)!;
      await setWorkoutCardio(row.id, choice);
      const garmin = garminActivity(activityId, choice ? 120 : 150);
      expect(await linkGarminActivity(garmin.activity, garmin.raw)).toBe("exact");
      await expectCardio(row.id, garmin.activity.avgHr, choice, true);
      expect(await linkGarminActivity(garmin.activity, garmin.raw)).toBe("updated");
      await expectCardio(row.id, garmin.activity.avgHr, choice, true);
    }
  });

  test("Health Connect adoption with missing HR keeps the attached Garmin measurement", async () => {
    const garmin = garminActivity(8003, 125.1);
    await linkGarminActivity(garmin.activity, garmin.raw);
    expect(await adoptGarminWorkout("hc-adopted", "8003", { startMs, endMs: startMs + 3_600_000 })).toBe("adopted");
    await upsertExternalWorkout({ ...workout, source: "Garmin", external_id: "hc-adopted", avg_hr: null });
    const rows = await listWorkoutsForRange("2026-10-28", "2026-10-28");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ external_id: "hc-adopted", avg_hr: 125.1, cardio: true });
  });

  test("Health Connect adoption preserves both manual choices and Garmin HR fallback", async () => {
    for (const [index, choice] of [true, false].entries()) {
      const activityId = 8300 + index;
      const garmin = garminActivity(activityId, choice ? 120 : 150);
      await linkGarminActivity(garmin.activity, garmin.raw);
      const row = (await listWorkoutsForRange("2026-10-28", "2026-10-28")).find((w) => w.external_id === `garmin:${activityId}`)!;
      await setWorkoutCardio(row.id, choice);
      const hcId = `hc-adopt-manual-${choice}`;
      expect(await adoptGarminWorkout(hcId, String(activityId), { startMs, endMs: startMs + 3_600_000 })).toBe("adopted");
      await upsertExternalWorkout({ ...workout, source: "Garmin", external_id: hcId, avg_hr: null });
      await expectCardio(row.id, garmin.activity.avgHr, choice, true);
      await linkGarminActivity(garmin.activity, garmin.raw);
      await expectCardio(row.id, garmin.activity.avgHr, choice, true);
    }
    expect(await listWorkoutsForRange("2026-10-28", "2026-10-28")).toHaveLength(2);
  });

  test("migration backfills HR and reclassifies automatic history while preserving manual choices", () => {
    const oldDb = new Database(":memory:");
    try {
      const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
      for (const match of rust.matchAll(/include_str!\("\.\.\/migrations\/([^\"]+)"\)/g)) {
        if (match[1] === "0037_workout_average_hr.sql") break;
        oldDb.exec(readFileSync(new URL(`../src-tauri/migrations/${match[1]}`, import.meta.url), "utf8"));
      }
      const insert = oldDb.query("INSERT INTO workouts (id, performed_at, title, description, duration_min, source, external_id, cardio, cardio_by_hand) VALUES (?, ?, 'Cycling', ?, 60, ?, ?, ?, ?)");
      insert.run(1, workout.performed_at, "Cycling · avg HR 125", "Garmin", "old-1", 0, 0);
      insert.run(2, workout.performed_at, "Cycling · avg HR 140", "Garmin", "old-2", 1, 0);
      insert.run(3, workout.performed_at, "Cycling · avg HR 126", "Health Connect", "old-3", 0, 0);
      insert.run(4, workout.performed_at, "Cycling · avg HR 125", "Health Connect", "old-4", 1, 0);
      insert.run(5, workout.performed_at, "Cycling · avg HR 140", null, null, 1, 0);
      insert.run(6, workout.performed_at, "Cycling · avg HR unknown", "Garmin", "old-6", 1, 0);
      insert.run(7, workout.performed_at, "Cycling · avg HR 140 later", "Garmin", "old-7", 1, 0);
      insert.run(8, workout.performed_at, "Cycling", null, null, 1, 1);
      insert.run(9, workout.performed_at, "Cycling · avg HR 150", "Garmin", "old-9", 0, 1);
      insert.run(10, workout.performed_at, "Cycling · avg HR 125", "Garmin", "old-10", 1, 1);
      oldDb.query("INSERT INTO garmin_activities (activity_id, workout_id, started_at, updated_at, avg_hr) VALUES (?, ?, ?, ?, ?)")
        .run("backfill-1", 1, workout.performed_at, workout.performed_at, 125.1);
      oldDb.query("INSERT INTO garmin_activities (activity_id, workout_id, started_at, updated_at, avg_hr) VALUES (?, ?, ?, ?, ?)")
        .run("backfill-2", 2, workout.performed_at, workout.performed_at, 125);
      oldDb.exec(readFileSync(new URL("../src-tauri/migrations/0037_workout_average_hr.sql", import.meta.url), "utf8"));
      expect(oldDb.query("SELECT id, avg_hr, cardio, cardio_by_hand FROM workouts ORDER BY id").all()).toEqual([
        { id: 1, avg_hr: 125.1, cardio: 1, cardio_by_hand: 0 },
        { id: 2, avg_hr: 125, cardio: 0, cardio_by_hand: 0 },
        { id: 3, avg_hr: 126, cardio: 1, cardio_by_hand: 0 },
        { id: 4, avg_hr: 125, cardio: 0, cardio_by_hand: 0 },
        { id: 5, avg_hr: null, cardio: 0, cardio_by_hand: 0 },
        { id: 6, avg_hr: null, cardio: 0, cardio_by_hand: 0 },
        { id: 7, avg_hr: null, cardio: 0, cardio_by_hand: 0 },
        { id: 8, avg_hr: null, cardio: 1, cardio_by_hand: 1 },
        { id: 9, avg_hr: 150, cardio: 0, cardio_by_hand: 1 },
        { id: 10, avg_hr: 125, cardio: 1, cardio_by_hand: 1 },
      ]);
    } finally {
      oldDb.close();
    }
  });
});
