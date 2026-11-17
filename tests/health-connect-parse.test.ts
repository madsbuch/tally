import { describe, expect, test } from "bun:test";
import {
  parseHCDailyMetrics,
  parseHCExerciseSessions,
  parseHCSleepSessions,
  parseHealthConnectStatus,
} from "../src/lib/schemas";

describe("Health Connect answers", () => {
  test("a record missing its id or span is dropped; sloppy fields read as null", () => {
    const sessions = parseHCExerciseSessions({
      sessions: [
        { id: "a", exerciseType: "Running", startMs: 1, endMs: 2, calories: "lots", avgHeartRate: 140 },
        { exerciseType: "Running", startMs: 1, endMs: 2 },
        { id: "c", startMs: 1 },
        "nonsense",
      ],
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "a", calories: null, avgHeartRate: 140, clientRecordId: null });
  });

  test("an answer of the wrong shape fails rather than reading as empty", () => {
    // A full resync purges what isn't in the answer: [] here would wipe the window.
    expect(() => parseHCExerciseSessions(null)).toThrow();
    expect(() => parseHCSleepSessions({ nights: [] })).toThrow();
    expect(() => parseHCDailyMetrics({ days: "none" })).toThrow();
  });

  test("daily metrics need a real day and drop non-finite numbers", () => {
    const days = parseHCDailyMetrics({
      days: [{ day: "2026-11-16", steps: 9000, weightKg: Number.NaN }, { day: "yesterday", steps: 1 }],
    });
    expect(days).toEqual([
      {
        day: "2026-11-16",
        steps: 9000,
        caloriesTotal: null,
        restingHr: null,
        hrvMs: null,
        spo2Pct: null,
        weightKg: null,
        vo2Max: null,
      },
    ]);
  });

  test("status from an older plugin without the history flag", () => {
    expect(parseHealthConnectStatus({ availability: "available", permissionsGranted: true })).toEqual({
      availability: "available",
      permissionsGranted: true,
      historyGranted: false,
    });
  });
});
