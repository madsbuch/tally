import { describe, expect, test } from "bun:test";
import { ago, backupLine, backupState, describeHeld, STALE_BACKUP_MS } from "../src/lib/sync";
import type { SyncDevice, SyncStatus } from "../src/lib/sync";
import { parseSyncStatus } from "../src/lib/schemas";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");

function device(over: Partial<SyncDevice>): SyncDevice {
  return { id: "x", name: "Mac", platform: "desktop", isSelf: false, lastSyncAt: null, lastCompleteAt: null, complete: false, ...over };
}

function status(devices: SyncDevice[], inVault = true): SyncStatus {
  return {
    deviceId: "me",
    name: "Phone",
    platform: "android",
    inVault,
    devices: [device({ id: "me", name: "Phone", isSelf: true }), ...devices],
    canJoin: false,
    held: [],
    offerActive: false,
    syncing: false,
    lastError: null,
    lastRoundAt: null,
    unreached: [],
    joinProblem: null,
  };
}

describe("backup state", () => {
  test("no vault, or nobody else in it, is no backup", () => {
    expect(backupState(status([], false), NOW).kind).toBe("none");
    expect(backupState(status([]), NOW).kind).toBe("none");
    expect(backupLine(backupState(status([]), NOW), NOW)).toBe("Not backed up to another device");
  });

  test("a recent complete sync is a good backup", () => {
    const at = new Date(NOW - 2 * 3600_000).toISOString();
    const s = backupState(status([device({ lastSyncAt: at, lastCompleteAt: at, complete: true })]), NOW);
    expect(s).toEqual({ kind: "ok", peer: "Mac", completeAt: at });
    expect(backupLine(s, NOW)).toBe("Backed up to Mac · 2 h ago · complete");
  });

  test("an old one goes stale, however complete it was", () => {
    const at = new Date(NOW - STALE_BACKUP_MS - 60_000).toISOString();
    const s = backupState(status([device({ lastSyncAt: at, lastCompleteAt: at, complete: true })]), NOW);
    expect(s.kind).toBe("stale");
    expect(backupLine(s, NOW)).toBe("Last backed up to Mac 3 days ago");
  });

  test("a sync that didn't end identical isn't called complete", () => {
    const earlier = new Date(NOW - 3600_000).toISOString();
    const s = backupState(status([device({ lastSyncAt: new Date(NOW).toISOString(), lastCompleteAt: earlier, complete: false })]), NOW);
    expect(s.kind).toBe("incomplete");
    expect(backupLine(s, NOW)).toBe("Backing up to Mac · last complete 1 h ago");
    expect(backupLine(backupState(status([device({})]), NOW), NOW)).toBe("Backing up to Mac · not complete yet");
  });

  test("with several devices, the freshest complete one counts", () => {
    const old = new Date(NOW - 10 * 86_400_000).toISOString();
    const fresh = new Date(NOW - 60_000).toISOString();
    const s = backupState(
      status([
        device({ id: "a", name: "Old laptop", lastCompleteAt: old, complete: true }),
        device({ id: "b", name: "Mac", lastCompleteAt: fresh, complete: true }),
      ]),
      NOW,
    );
    expect(s).toMatchObject({ kind: "ok", peer: "Mac" });
  });

  test("ages read naturally", () => {
    expect(ago(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(ago(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min ago");
    expect(ago(new Date(NOW - 86_400_000).toISOString(), NOW)).toBe("1 day ago");
  });

  test("what a device holds reads as words", () => {
    expect(describeHeld([{ table: "food_entries", rows: 30 }])).toBe("30 meals");
    expect(describeHeld([{ table: "workouts", rows: 1 }, { table: "food_entries", rows: 2 }, { table: "garmin_days", rows: 5 }, { table: "entry_notes", rows: 1 }])).toBe(
      "1 workout, 2 meals and 6 other records",
    );
  });

  test("the status from Rust is checked on the way in", () => {
    expect(() => parseSyncStatus({ deviceId: "x" })).toThrow();
    const ok = status([]);
    expect(parseSyncStatus(ok)).toEqual(ok);
  });
});
