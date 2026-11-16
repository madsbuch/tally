import { describe, expect, test } from "bun:test";
import { sqlite } from "./testDb";
import { notifyTablesChanged, onTablesChanged, writtenTable } from "../src/lib/live";

const { setSetting, addFoodEntry, deleteFoodEntry } = await import("../src/lib/db");

const tick = () => new Promise((r) => setTimeout(r, 80));

describe("live data", () => {
  test("knows which table a statement writes", () => {
    expect(writtenTable('insert into "food_entries" ("id") values (?)')).toBe("food_entries");
    expect(writtenTable('update "settings" set "value" = ? where "key" = ?')).toBe("settings");
    expect(writtenTable('delete from "chats" where "id" = ?')).toBe("chats");
    expect(writtenTable("INSERT OR IGNORE INTO photos (filename, data) VALUES (?, ?)")).toBe("photos");
    expect(writtenTable('select * from "food_entries"')).toBeNull();
  });

  test("gathers a burst into one notification, for the tables asked about", async () => {
    const heard: string[] = [];
    const off1 = onTablesChanged(["food_entries"], () => heard.push("meals"));
    const off2 = onTablesChanged(["chats"], () => heard.push("chats"));
    const off3 = onTablesChanged("all", () => heard.push("all"));
    for (let i = 0; i < 20; i++) notifyTablesChanged(["food_entries"]);
    await tick();
    expect(heard.sort()).toEqual(["all", "meals"]);
    heard.length = 0;
    notifyTablesChanged("all");
    await tick();
    expect(heard.sort()).toEqual(["all", "chats", "meals"]);
    off1();
    off2();
    off3();
  });

  test("the app's own writes are heard — real changes only", async () => {
    let meals = 0;
    let settings = 0;
    const offMeals = onTablesChanged(["food_entries"], () => meals++);
    const offSettings = onTablesChanged(["settings"], () => settings++);

    const id = await addFoodEntry({ eaten_at: "2026-11-16T08:00:00.000Z", title: "Oats", description: null, photo_path: null, nutrients: {}, model_id: null, icon: null });
    await tick();
    expect(meals).toBe(1);
    await deleteFoodEntry(id);
    await tick();
    expect(meals).toBe(2);

    await setSetting("calorie_target_kcal", "2200");
    await tick();
    expect(settings).toBe(1);
    // The same value again changes nothing, and wakes nobody — a screen whose
    // load writes a value back can't set itself off in a loop.
    await setSetting("calorie_target_kcal", "2200");
    await tick();
    expect(settings).toBe(1);
    // A device-local setting isn't anything a screen shows from the vault.
    await setSetting("garmin_last_sync_at", "now");
    await tick();
    expect(settings).toBe(1);
    expect(sqlite.query("SELECT 1 FROM device_settings WHERE key = 'garmin_last_sync_at'").get()).toBeTruthy();
    offMeals();
    offSettings();
  });
});
