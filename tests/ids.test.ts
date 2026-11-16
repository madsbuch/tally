import { describe, expect, test } from "bun:test";
import { sqlite } from "./testDb";
import { derivedId, idArg, legacyId, newId, parseRowId } from "../src/lib/ids";
import { SETTING_KEYS } from "../src/lib/types";

// db.ts must load after testDb has mocked the SQL plugin.
const { getSetting, setSetting, upsertSleepSession } = await import("../src/lib/db");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("row ids", () => {
  test("are UUIDv7, ordered as text in the order they were made", () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    for (const id of ids) {
      expect(id).toMatch(UUID);
      expect(id[14]).toBe("7");
      expect("89ab").toContain(id[19]!);
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("carry their timestamp first", () => {
    const at = Date.now() + 86_400_000;
    const a = newId(at);
    const b = newId(at + 1000);
    expect(b > a).toBe(true);
    expect(b.slice(0, 13)).toBe((at + 1000).toString(16).padStart(12, "0").replace(/^(.{8})/, "$1-"));
    // A clock that steps back doesn't break the order.
    expect(newId(at) > b).toBe(true);
  });

  test("legacy ids sort before every new one, in their old order", () => {
    expect(legacyId(1)).toBe("00000000-0000-7000-8000-000000000001");
    expect(legacyId(255) > legacyId(16)).toBe(true);
    expect(legacyId(2 ** 40) < newId()).toBe(true);
  });

  test("derived ids are stable per key and differ between keys", async () => {
    const a = await derivedId("workout", "hc-123");
    expect(a).toMatch(UUID);
    expect(await derivedId("workout", "hc-123")).toBe(a);
    expect(await derivedId("workout", "hc-124")).not.toBe(a);
    expect(await derivedId("sleep", "hc-123")).not.toBe(a);
  });

  test("tool arguments accept ids and the numbers old chats still quote", () => {
    const id = newId();
    expect(idArg(id)).toBe(id);
    expect(idArg(` #${id} `)).toBe(id);
    expect(idArg(12)).toBe(legacyId(12));
    expect(idArg("#12")).toBe(legacyId(12));
    expect(idArg("")).toBeNull();
    expect(idArg(null)).toBeNull();
    expect(idArg(-3)).toBeNull();
  });

  test("URL segments are only ids when shaped like one", () => {
    const id = newId();
    expect(parseRowId(id)).toBe(id);
    expect(parseRowId("12")).toBeNull();
    expect(parseRowId("memory")).toBeNull();
    expect(parseRowId(undefined)).toBeNull();
  });
});

describe("settings", () => {
  test("device-local keys stay out of the synced table", async () => {
    await setSetting(SETTING_KEYS.garminLastSyncAt, "2026-11-16T08:00:00.000Z");
    await setSetting(SETTING_KEYS.calorieTarget, "2100");
    expect(await getSetting(SETTING_KEYS.garminLastSyncAt)).toBe("2026-11-16T08:00:00.000Z");
    expect(await getSetting(SETTING_KEYS.calorieTarget)).toBe("2100");
    const where = (key: string) => ({
      synced: sqlite.query("SELECT 1 FROM settings WHERE key = ?").get(key) != null,
      device: sqlite.query("SELECT 1 FROM device_settings WHERE key = ?").get(key) != null,
    });
    expect(where(SETTING_KEYS.garminLastSyncAt)).toEqual({ synced: false, device: true });
    expect(where(SETTING_KEYS.calorieTarget)).toEqual({ synced: true, device: false });
  });
});

describe("imported rows", () => {
  test("take their id from the record they came from", async () => {
    const night = {
      external_id: "hc-night-1",
      started_at: "2026-11-15T22:00:00.000Z",
      ended_at: "2026-11-16T06:00:00.000Z",
      duration_min: 480,
      deep_min: null,
      rem_min: null,
      light_min: null,
      awake_min: null,
      source: "Garmin",
    };
    await upsertSleepSession(night);
    await upsertSleepSession({ ...night, duration_min: 470 });
    expect(sqlite.query("SELECT id, duration_min FROM sleep_sessions WHERE external_id = 'hc-night-1'").all()).toEqual([
      { id: await derivedId("sleep_sessions", "hc-night-1"), duration_min: 470 },
    ]);
  });
});
