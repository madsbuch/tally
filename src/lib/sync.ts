// ---------------------------------------------------------------------------
// Sync between this device and the rest of the vault (src-tauri/src/sync/).
// Everything happens in Rust; this is the frontend's side: starting it,
// reading its status, pairing, and refreshing the screens when data arrives.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseJoinResult, parseSyncStatus } from "./schemas";
import type { JoinResult, SyncDevice, SyncOutcome, SyncStatus } from "./schemas";

export type { JoinResult, SyncDevice, SyncOutcome, SyncStatus };

/** A backup older than this is worth a reminder. */
export const STALE_BACKUP_MS = 3 * 24 * 3600_000;

export async function startSync(): Promise<void> {
  await invoke("sync_start");
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return parseSyncStatus(await invoke("sync_status"));
}

export async function setDeviceName(name: string): Promise<void> {
  await invoke("sync_set_name", { name });
}

/** A pairing code for the QR, good for one device for ten minutes. */
export async function createPairingCode(): Promise<string> {
  return invoke<string>("sync_offer");
}

export async function cancelPairing(): Promise<void> {
  await invoke("sync_cancel_offer");
}

/**
 * Joins the vault the code came from. This device must be empty — unless
 * `replace`: then a copy of what it holds is saved first, and replaced.
 */
export async function joinVault(code: string, replace = false): Promise<JoinResult> {
  return parseJoinResult(await invoke("sync_join", { code, replace }));
}

const TABLE_LABELS: Record<string, [string, string]> = {
  food_entries: ["meal", "meals"],
  workouts: ["workout", "workouts"],
  chats: ["chat", "chats"],
  fasts: ["fast", "fasts"],
  captures: ["capture", "captures"],
  photos: ["photo", "photos"],
  documents: ["document", "documents"],
  sleep_sessions: ["night of sleep", "nights of sleep"],
  health_metrics: ["day of health data", "days of health data"],
  state_logs: ["observation", "observations"],
  blood_readings: ["reading", "readings"],
  coach_memory: ["coach memory", "coach memories"],
  supplement_logs: ["supplement dose", "supplement doses"],
  ai_usage: ["AI request", "AI requests"],
};

/** "12 meals, 3 chats and 40 other rows" — what a device holds, in words. */
export function describeHeld(held: { table: string; rows: number }[]): string {
  const named: string[] = [];
  let other = 0;
  for (const h of held) {
    const label = TABLE_LABELS[h.table];
    if (label) named.push(`${h.rows} ${h.rows === 1 ? label[0] : label[1]}`);
    else other += h.rows;
  }
  if (other) named.push(`${other} other ${other === 1 ? "record" : "records"}`);
  if (named.length <= 1) return named[0] ?? "nothing";
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

export async function syncNow(): Promise<void> {
  await invoke("sync_now");
}

export async function removeDevice(id: string): Promise<void> {
  await invoke("sync_remove_device", { id });
}

/** Calls `fn` whenever another device's data arrived here. */
export function onSyncChanged(fn: () => void): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  void listen("sync-changed", () => fn()).then((u) => {
    if (stopped) u();
    else stop = u;
  });
  return () => {
    stopped = true;
    stop?.();
  };
}

/** Calls `fn` whenever sync's status moved (a round started or ended). */
export function onSyncStatus(fn: () => void): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  void listen("sync-status", () => fn()).then((u) => {
    if (stopped) u();
    else stop = u;
  });
  return () => {
    stopped = true;
    stop?.();
  };
}

/** How the backup stands, from this device's point of view. */
export interface BackupState {
  /** "none": not in a vault, or alone in it; "ok"; "stale": too long ago; "incomplete": last sync didn't match. */
  kind: "none" | "ok" | "stale" | "incomplete";
  /** The other device it's backed up to, by name. */
  peer: string | null;
  /** When both last held exactly the same data. */
  completeAt: string | null;
}

export function backupState(status: SyncStatus, now: number = Date.now()): BackupState {
  const others = status.devices.filter((d) => !d.isSelf);
  if (!status.inVault || others.length === 0) return { kind: "none", peer: null, completeAt: null };
  // The most recently complete of the others; ties go to the first listed.
  let best: SyncDevice | null = null;
  for (const d of others) {
    if (d.lastCompleteAt && (!best?.lastCompleteAt || d.lastCompleteAt > best.lastCompleteAt)) best = d;
  }
  const peer = best ?? others[0]!;
  const at = peer.lastCompleteAt;
  if (!at) return { kind: "incomplete", peer: peer.name, completeAt: null };
  if (now - Date.parse(at) > STALE_BACKUP_MS) return { kind: "stale", peer: peer.name, completeAt: at };
  if (!peer.complete) return { kind: "incomplete", peer: peer.name, completeAt: at };
  return { kind: "ok", peer: peer.name, completeAt: at };
}

/** "5 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** One line for the Settings row and the Sync page. */
export function backupLine(state: BackupState, now: number = Date.now()): string {
  switch (state.kind) {
    case "none":
      return "Not backed up to another device";
    case "ok":
      return `Backed up to ${state.peer} · ${ago(state.completeAt!, now)} · complete`;
    case "stale":
      return `Last backed up to ${state.peer} ${ago(state.completeAt!, now)}`;
    case "incomplete":
      return state.completeAt
        ? `Backing up to ${state.peer} · last complete ${ago(state.completeAt, now)}`
        : `Backing up to ${state.peer} · not complete yet`;
  }
}

export function isAndroid(): boolean {
  return navigator.userAgent.includes("Android");
}
