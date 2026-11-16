import { beforeEach, describe, expect, test } from "bun:test";
import { sqlite, tauriCommands } from "./testDb";

// Health Connect is the event bus, Garmin the authority, the user above both
// (lib/garminDb.ts). These run the real Health Connect sync (healthConnect.ts)
// against a fake Health Connect, and the real Garmin linking, through db.ts.

const db = await import("../src/lib/db");
const g = await import("../src/lib/garminDb");
const { syncHealthConnect } = await import("../src/lib/healthConnect");
const { parseGarminActivities } = await import("../src/lib/schemas");
const { garminSyncPlan } = await import("../src/lib/garmin");

const MIN = 60_000;
const HOUR = 60 * MIN;
// Inside the window a first (full) read covers: the last 30 days.
const T = Date.now() - 2 * 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

interface FakeSession {
  id: string;
  startMs: number;
  endMs: number;
  calories?: number;
  avgHeartRate?: number;
  title?: string;
  clientRecordId?: string;
}
interface FakeNight {
  id: string;
  startMs: number;
  endMs: number;
  deepMin?: number;
}
interface FakeDay {
  day: string;
  steps?: number;
  caloriesTotal?: number;
}

/** What the fake Health Connect holds. */
const hc: { sessions: FakeSession[]; nights: FakeNight[]; days: FakeDay[] } = { sessions: [], nights: [], days: [] };

tauriCommands["plugin:health-connect|get_status"] = () => ({
  availability: "available",
  permissionsGranted: true,
  historyGranted: false,
});
tauriCommands["plugin:health-connect|read_exercise_sessions"] = () => ({
  sessions: hc.sessions.map((s) => ({
    exerciseType: "Running",
    startOffsetMin: 60,
    sourcePackage: "com.garmin.android.apps.connectmobile",
    ...s,
  })),
});
tauriCommands["plugin:health-connect|read_sleep_sessions"] = () => ({
  sessions: hc.nights.map((n) => ({
    endOffsetMin: 60,
    sourcePackage: "com.garmin.android.apps.connectmobile",
    ...n,
  })),
});
tauriCommands["plugin:health-connect|read_daily_metrics"] = () => ({ days: hc.days });

function activity(id: string, startMs: number, durationMin: number, extra: Record<string, unknown> = {}) {
  const raw = {
    activityId: Number(id),
    activityName: "Morning Run",
    beginTimestamp: startMs,
    startTimeGMT: iso(startMs).slice(0, 19).replace("T", " "),
    startTimeLocal: iso(startMs + HOUR).slice(0, 19).replace("T", " "),
    activityType: { typeKey: "running" },
    duration: durationMin * 60,
    calories: 520,
    bmrCalories: 60,
    averageHR: 141.6,
    ...extra,
  };
  const { activities, raws } = parseGarminActivities([raw]);
  return { a: activities[0]!, raw: raws[0]! };
}

type Row = Record<string, unknown>;
const workoutRows = () =>
  sqlite.query("SELECT * FROM workouts WHERE external_id IS NOT NULL ORDER BY performed_at").all() as Row[];
const nightRows = () => sqlite.query("SELECT * FROM sleep_sessions ORDER BY started_at").all() as Row[];
const versionOf = (tbl: string, pk: unknown) =>
  (sqlite.query("SELECT hlc FROM sync_rows WHERE tbl = ? AND pk = ?").get(tbl, pk as string) as { hlc: string } | null)?.hlc;

beforeEach(() => {
  sqlite.exec(
    "DELETE FROM workouts; DELETE FROM garmin_activities; DELETE FROM sleep_sessions; DELETE FROM garmin_days; " +
      "DELETE FROM deleted_imports; DELETE FROM health_metrics; DELETE FROM device_settings; DELETE FROM entry_messages;",
  );
  hc.sessions = [];
  hc.nights = [];
  hc.days = [];
});

describe("workouts: Health Connect first, Garmin's numbers once it has them", () => {
  test("Garmin's numbers replace Health Connect's, and a re-read doesn't put them back", async () => {
    hc.sessions = [{ id: "hc-1", startMs: T, endMs: T + 40 * MIN, calories: 400, avgHeartRate: 144, title: "Running" }];
    await syncHealthConnect();
    expect(workoutRows()[0]).toMatchObject({ title: "Running", calories_burned: 400, avg_hr: 144 });

    const { a, raw } = activity("501", T + 5_000, 40);
    expect(await g.linkGarminActivity(a, raw)).toBe("time");
    const linked = workoutRows()[0]!;
    // Garmin's: active calories (520 − 60), its average, its name.
    expect(linked).toMatchObject({ title: "Morning Run", calories_burned: 460, avg_hr: 141.6 });

    // Health Connect reads it again, with its own numbers: nothing changes,
    // not even a new version for sync to carry.
    const before = versionOf("workouts", linked["id"]);
    await syncHealthConnect();
    expect(workoutRows()).toHaveLength(1);
    expect(workoutRows()[0]).toMatchObject({ calories_burned: 460, avg_hr: 141.6, title: "Morning Run" });
    expect(versionOf("workouts", linked["id"])).toBe(before);
  });

  test("a field changed by hand stays, through both syncs; the rest still follow Garmin", async () => {
    hc.sessions = [{ id: "hc-2", startMs: T, endMs: T + 30 * MIN, calories: 300, avgHeartRate: 150 }];
    await syncHealthConnect();
    const row = (await db.listSyncedWorkouts())[0]!;
    await db.updateWorkout({ ...row, title: "Intervals", calories_burned: 333 });

    await syncHealthConnect();
    expect(workoutRows()[0]).toMatchObject({ title: "Intervals", calories_burned: 333, avg_hr: 150 });

    const { a, raw } = activity("502", T, 30, { averageHR: 152 });
    await g.linkGarminActivity(a, raw);
    // Title and calories are the user's; HR and duration Garmin's.
    expect(workoutRows()[0]).toMatchObject({ title: "Intervals", calories_burned: 333, avg_hr: 152, duration_min: 30 });
    await g.linkGarminActivity(a, raw);
    await syncHealthConnect();
    expect(workoutRows()[0]).toMatchObject({ title: "Intervals", calories_burned: 333, avg_hr: 152 });
  });

  test("an edit that changes nothing marks nothing", async () => {
    hc.sessions = [{ id: "hc-3", startMs: T, endMs: T + 30 * MIN, calories: 300 }];
    await syncHealthConnect();
    const row = (await db.listSyncedWorkouts())[0]!;
    await db.updateWorkout({ ...row });
    expect(workoutRows()[0]!["edited_by_hand"]).toBe(0);
    await db.updateWorkout({ ...row, duration_min: 31 });
    expect(workoutRows()[0]!["edited_by_hand"]).toBe(16);
  });

  test("a hand-logged workout is never marked (it isn't synced)", async () => {
    const id = await db.addWorkout({
      performed_at: iso(T), title: "Yoga", description: null, photo_path: null,
      calories_burned: 100, duration_min: 30, model_id: null, icon: null,
    });
    const w = (await db.getWorkout(id))!;
    await db.updateWorkout({ ...w, title: "Yin yoga" });
    expect((sqlite.query("SELECT edited_by_hand FROM workouts WHERE id = ?").get(id) as Row)["edited_by_hand"]).toBe(0);
  });
});

describe("a synced workout deleted by hand stays deleted", () => {
  test("Health Connect reading it again doesn't bring it back", async () => {
    hc.sessions = [{ id: "hc-del", startMs: T, endMs: T + 40 * MIN, calories: 400 }];
    await syncHealthConnect();
    await db.deleteWorkout(workoutRows()[0]!["id"] as string);
    const r = await syncHealthConnect();
    expect(workoutRows()).toHaveLength(0);
    expect(r.newWorkouts).toBe(0);
  });

  test("nor does Garmin listing the activity, linked or not yet", async () => {
    // Deleted before Garmin linked it: Garmin mustn't make a row of its own.
    hc.sessions = [{ id: "hc-del2", startMs: T, endMs: T + 40 * MIN, calories: 400 }];
    await syncHealthConnect();
    await db.deleteWorkout(workoutRows()[0]!["id"] as string);
    const { a, raw } = activity("601", T + 5_000, 40);
    expect(await g.linkGarminActivity(a, raw)).toBe("skipped");
    expect(workoutRows()).toHaveLength(0);
    expect((sqlite.query("SELECT dismissed FROM garmin_activities WHERE activity_id = '601'").get() as Row)["dismissed"]).toBe(1);
    await syncHealthConnect();
    expect(await g.linkGarminActivity(a, raw)).toBe("skipped");
    expect(workoutRows()).toHaveLength(0);
  });

  test("a Garmin-made one isn't brought back by Health Connect", async () => {
    const { a, raw } = activity("602", T, 25);
    expect(await g.linkGarminActivity(a, raw)).toBe("created");
    await db.deleteWorkout(workoutRows()[0]!["id"] as string);
    hc.sessions = [{ id: "hc-602", startMs: T + 5_000, endMs: T + 25 * MIN }];
    await syncHealthConnect();
    expect(await g.linkGarminActivity(a, raw)).toBe("skipped");
    expect(workoutRows()).toHaveLength(0);
  });

  test("the deletion syncs as a record, named after the workout", async () => {
    hc.sessions = [{ id: "hc-rec", startMs: T, endMs: T + 40 * MIN }];
    await syncHealthConnect();
    await db.deleteWorkout(workoutRows()[0]!["id"] as string);
    const rec = sqlite.query("SELECT id, external_id FROM deleted_imports").all() as Row[];
    expect(rec).toHaveLength(1);
    expect(rec[0]!["external_id"]).toBe("hc-rec");
    expect(versionOf("deleted_imports", rec[0]!["id"])).toBeTruthy();
  });
});

describe("a new phone, whose Health Connect names everything afresh", () => {
  test("takes over the workouts and nights already there instead of adding twins", async () => {
    hc.sessions = [
      { id: "old-a", startMs: T, endMs: T + 40 * MIN, calories: 400 },
      { id: "old-b", startMs: T + 6 * HOUR, endMs: T + 6 * HOUR + 30 * MIN, calories: 300 },
    ];
    hc.nights = [{ id: "old-n", startMs: T - 9 * HOUR, endMs: T - HOUR }];
    await syncHealthConnect();
    const { a, raw } = activity("701", T, 40);
    await g.linkGarminActivity(a, raw);
    expect(workoutRows()).toHaveLength(2);

    // The new phone: same sessions, new ids, and none of the old phone's
    // bookmarks (they're device settings).
    sqlite.exec("DELETE FROM device_settings");
    hc.sessions = [
      { id: "new-a", startMs: T, endMs: T + 40 * MIN, calories: 400 },
      { id: "new-b", startMs: T + 6 * HOUR, endMs: T + 6 * HOUR + 30 * MIN, calories: 300 },
    ];
    hc.nights = [{ id: "new-n", startMs: T - 9 * HOUR, endMs: T - HOUR }];
    const r = await syncHealthConnect();
    expect(r.newWorkouts).toBe(0);
    expect(r.newNights).toBe(0);
    const rows = workoutRows();
    expect(rows.map((w) => w["external_id"]).sort()).toEqual(["new-a", "new-b"]);
    // Still linked, still Garmin's numbers.
    expect(rows.find((w) => w["external_id"] === "new-a")).toMatchObject({ calories_burned: 460 });
    expect(nightRows().map((n) => n["external_id"])).toEqual(["new-n"]);
  });

  test("two sessions in one read never take each other's rows", async () => {
    hc.sessions = [
      { id: "s1", startMs: T, endMs: T + 30 * MIN },
      { id: "s2", startMs: T + 60_000, endMs: T + 31 * MIN },
    ];
    await syncHealthConnect();
    await syncHealthConnect();
    // A duplicate in Health Connect stays one (as before) — but never
    // flips its row between the two ids.
    expect(workoutRows().map((w) => w["external_id"]).sort()).toEqual(["s1", "s2"]);
  });
});

describe("nights: Garmin's times and stages", () => {
  const nightStart = T - 9 * HOUR;
  const nightEnd = T - HOUR;
  const garminNight = (deep: number, endMs = nightEnd) =>
    g.upsertGarminDay({
      day: iso(endMs).slice(0, 10),
      sleepId: "gs-1",
      sleepStartedAt: iso(nightStart + 10 * MIN),
      sleepEndedAt: iso(endMs),
      sleepTzOffsetMin: 60,
      sleepDeepMin: deep,
      fetchedAt: iso(Date.now()),
    });

  test("Health Connect's night takes Garmin's numbers, and keeps them", async () => {
    hc.nights = [{ id: "hc-n", startMs: nightStart, endMs: nightEnd, deepMin: 50 }];
    await syncHealthConnect();
    expect(nightRows()[0]).toMatchObject({ deep_min: 50, started_at: iso(nightStart) });

    await garminNight(72);
    expect(await g.applyGarminSleep()).toBe(0);
    expect(nightRows()).toHaveLength(1);
    expect(nightRows()[0]).toMatchObject({ external_id: "hc-n", deep_min: 72, started_at: iso(nightStart + 10 * MIN) });

    const before = versionOf("sleep_sessions", nightRows()[0]!["id"]);
    await syncHealthConnect();
    await g.applyGarminSleep();
    expect(nightRows()[0]).toMatchObject({ deep_min: 72 });
    expect(versionOf("sleep_sessions", nightRows()[0]!["id"])).toBe(before);
  });

  test("a night only Garmin has is added, then follows Garmin's later numbers", async () => {
    await garminNight(60);
    expect(await g.applyGarminSleep()).toBe(1);
    expect(nightRows()[0]).toMatchObject({ external_id: "garmin-sleep:gs-1", deep_min: 60 });
    await garminNight(65);
    expect(await g.applyGarminSleep()).toBe(0);
    expect(nightRows()).toHaveLength(1);
    expect(nightRows()[0]).toMatchObject({ deep_min: 65 });
  });
});

describe("Health Connect as the event bus", () => {
  test("says when today's numbers moved, and when a night is new", async () => {
    const today = db.todayStr();
    hc.days = [{ day: today, steps: 4000, caloriesTotal: 1500 }];
    expect((await syncHealthConnect()).todayMoved).toBe(true);
    expect((await syncHealthConnect()).todayMoved).toBe(false);
    hc.days = [{ day: today, steps: 4200, caloriesTotal: 1530 }];
    expect((await syncHealthConnect()).todayMoved).toBe(true);

    hc.nights = [{ id: "n-1", startMs: T - 9 * HOUR, endMs: T - HOUR }];
    expect((await syncHealthConnect()).newNights).toBe(1);
    expect((await syncHealthConnect()).newNights).toBe(0);
  });
});

describe("when Garmin syncs (garminSyncPlan)", () => {
  const ask = (o: Partial<{ manual: boolean; newWorkout: boolean; moved: boolean }> = {}) => ({
    manual: false, newWorkout: false, moved: false, ...o,
  });
  const H = 3_600_000;

  test("Health Connect moving brings it forward from hours to minutes — the cheap part", () => {
    expect(garminSyncPlan(ask(), true, 20 * MIN, 20 * MIN)).toEqual({ run: false });
    expect(garminSyncPlan(ask({ moved: true }), true, 20 * MIN, 20 * MIN)).toEqual({ run: true, light: true });
    expect(garminSyncPlan(ask({ moved: true }), true, 10 * MIN, 10 * MIN)).toEqual({ run: false });
    // With the sign-in alone (five requests a day) it waits longer.
    expect(garminSyncPlan(ask({ moved: true }), false, 20 * MIN, 20 * MIN)).toEqual({ run: false });
    expect(garminSyncPlan(ask({ moved: true }), false, 61 * MIN, 61 * MIN)).toEqual({ run: true, light: true });
  });

  test("a full sync still comes round every few hours, moved or not", () => {
    expect(garminSyncPlan(ask({ moved: true }), true, 20 * MIN, 3 * H + MIN)).toEqual({ run: true, light: false });
    expect(garminSyncPlan(ask(), true, 3 * H + MIN, 3 * H + MIN)).toEqual({ run: true, light: false });
  });

  test("a new workout or the button: full, at once", () => {
    expect(garminSyncPlan(ask({ newWorkout: true, moved: true }), true, 3 * MIN, MIN)).toEqual({ run: true, light: false });
    expect(garminSyncPlan(ask({ manual: true, moved: true }), true, 0, 0)).toEqual({ run: true, light: false });
  });
});
