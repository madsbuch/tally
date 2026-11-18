import { describe, expect, test } from "bun:test";
import { sqlite } from "./testDb";
import {
  derivedId,
  idArg,
  idArgProblem,
  legacyId,
  newId,
  parseRowId,
  parseTypeId,
  prefixOf,
  splitTypeIds,
  typeIdOf,
} from "../src/lib/ids";
import { must } from "./helpers";
import { SETTING_KEYS } from "../src/lib/types";

// db.ts must load after testDb has mocked the SQL plugin.
const { getSetting, setSetting, upsertSleepSession } = await import("../src/lib/db");

const TYPE_ID = /^meal_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

// The TypeID spec's own examples (typeid/spec/valid.yml). The migration
// (tests/type-id-migration.test.ts), Rust and Kotlin are held to the same.
const SPEC: [string, string][] = [
  ["00000000-0000-0000-0000-000000000000", "00000000000000000000000000"],
  ["00000000-0000-0000-0000-000000000001", "00000000000000000000000001"],
  ["00000000-0000-0000-0000-00000000000a", "0000000000000000000000000a"],
  ["00000000-0000-0000-0000-000000000010", "0000000000000000000000000g"],
  ["00000000-0000-0000-0000-000000000020", "00000000000000000000000010"],
  ["ffffffff-ffff-ffff-ffff-ffffffffffff", "7zzzzzzzzzzzzzzzzzzzzzzzzz"],
  ["01890a5d-ac96-774b-bcce-b302099a8057", "01h455vb4pex5vsknk084sn02q"],
];

describe("row ids", () => {
  test("spell a UUID the way the TypeID spec does, and read back", () => {
    for (const [uuid, suffix] of SPEC) {
      expect(typeIdOf("meal", uuid)).toBe(`meal_${suffix}`);
      expect(parseTypeId(`meal_${suffix}`)).toEqual({ prefix: "meal", uuid });
    }
  });

  test("carry their table's prefix", () => {
    expect(newId("food_entries").startsWith("meal_")).toBe(true);
    expect(newId("state_logs").startsWith("observation_")).toBe(true);
    expect(prefixOf(newId("supplement_logs"))).toBe("dose");
    // Unknown prefixes and malformed suffixes aren't ours.
    expect(parseTypeId("user_01h455vb4pex5vsknk084sn02q")).toBeNull();
    expect(parseTypeId("meal_81h455vb4pex5vsknk084sn02q")).toBeNull();
    expect(parseTypeId("meal_01h455vb4pex5vsknk084sn02")).toBeNull();
    expect(parseTypeId("meal_01h455vb4pex5vsknk084sn0iq")).toBeNull();
  });

  test("are UUIDv7 inside, ordered as text in the order they were made", () => {
    const ids = Array.from({ length: 5000 }, () => newId("food_entries"));
    for (const id of ids) {
      expect(id).toMatch(TYPE_ID);
      const uuid = must(parseTypeId(id), "parsed id").uuid;
      expect(uuid[14]).toBe("7");
      expect("89ab").toContain(uuid[19] ?? "");
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("carry their timestamp first", () => {
    const at = Date.now() + 86_400_000;
    const a = newId("workouts", at);
    const b = newId("workouts", at + 1000);
    expect(b > a).toBe(true);
    const uuid = must(parseTypeId(b), "parsed id").uuid;
    expect(uuid.slice(0, 13)).toBe((at + 1000).toString(16).padStart(12, "0").replace(/^(.{8})/, "$1-"));
    // A clock that steps back doesn't break the order.
    expect(newId("workouts", at) > b).toBe(true);
  });

  test("legacy ids sort before every new one, in their old order", () => {
    expect(legacyId("meal", 1)).toBe(typeIdOf("meal", "00000000-0000-7000-8000-000000000001"));
    expect(legacyId("meal", 255) > legacyId("meal", 16)).toBe(true);
    expect(legacyId("meal", 2 ** 40) < newId("food_entries")).toBe(true);
  });

  test("derived ids are stable per key and differ between keys", async () => {
    const a = await derivedId("workouts", "hc-123");
    expect(a.startsWith("workout_")).toBe(true);
    expect(await derivedId("workouts", "hc-123")).toBe(a);
    expect(await derivedId("workouts", "hc-124")).not.toBe(a);
    expect(prefixOf(await derivedId("sleep_sessions", "hc-123"))).toBe("sleep");
  });

  test("tool arguments: the id of the right kind, or one an old chat quotes", () => {
    const id = newId("food_entries");
    expect(idArg(id, "meal")).toBe(id);
    expect(idArg(` #${id} `, "meal")).toBe(id);
    // Another kind's id isn't a meal's.
    expect(idArg(newId("workouts"), "meal")).toBeNull();
    // Before TypeIDs: a bare UUID, and before that a number.
    const uuid = must(parseTypeId(id), "parsed id").uuid;
    expect(idArg(uuid, "meal")).toBe(id);
    expect(idArg(uuid.toUpperCase(), "meal")).toBe(id);
    expect(idArg(12, "meal")).toBe(legacyId("meal", 12));
    expect(idArg("#12", "meal")).toBe(legacyId("meal", 12));
    expect(idArg("", "meal")).toBeNull();
    expect(idArg(null, "meal")).toBeNull();
    expect(idArg(-3, "meal")).toBeNull();
  });

  test("a wrong id says what it is and what was wanted", () => {
    const workout = newId("workouts");
    expect(idArgProblem(workout, "meal")).toBe(`${workout} is a workout's id; this needs a meal's id (meal_…).`);
    expect(idArgProblem(undefined, "meal")).toBe("This needs a meal's id (meal_…).");
    expect(idArgProblem("lunch", "meal")).toBe("lunch isn't an id; this needs a meal's id (meal_…).");
  });

  test("URL segments are only ids of the page's kind", () => {
    const id = newId("chats");
    expect(parseRowId(id, "chat")).toBe(id);
    expect(parseRowId(id, "meal")).toBeNull();
    // A notification posted before the update carries the bare UUID.
    expect(parseRowId(must(parseTypeId(id), "parsed id").uuid, "chat")).toBe(id);
    expect(parseRowId("12", "chat")).toBeNull();
    expect(parseRowId("memory", "chat")).toBeNull();
    expect(parseRowId(undefined, "chat")).toBeNull();
  });

  test("ids are found in running text, not inside longer words", () => {
    const id = newId("food_entries");
    expect(splitTypeIds(`Had ${id}, then \`${id}\`.`)).toEqual(["Had ", { id }, ", then `", { id }, "`."]);
    expect(splitTypeIds(`x${id} ${id}y`)).toEqual([`x${id} ${id}y`]);
    // The longest prefix wins: an observation_tag id isn't an observation's.
    const tag = newId("state_log_tags");
    expect(splitTypeIds(tag)).toEqual([{ id: tag }]);
    expect(splitTypeIds("no ids here")).toEqual(["no ids here"]);
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
