// ---------------------------------------------------------------------------
// Live data: screens re-read what they show when it changes, wherever the
// change came from.
//
// Three sources feed one signal, by table:
// - every write the app makes (db.ts reports the table, but only when sync's
//   change counter moved — a write that changed nothing doesn't count, so a
//   screen whose load writes an unchanged value back can't wake itself up);
// - another device's data arriving through sync ("sync-changed": anything);
// - the app coming back to the front (anything: the Android check-in worker
//   writes while it's away).
//
// Screens subscribe with `useTablesVersion([...tables])` — a number that
// moves when one of them changes, for the dependency list of the effect that
// loads them — or `onTablesChanged`. Bursts (a sync applying 500 rows) are
// gathered into one notification.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

export type Tables = readonly string[] | "all";

interface Listener {
  tables: Set<string> | null;
  fn: () => void;
}

const listeners = new Set<Listener>();
let pending: Set<string> | "all" | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** How long changes are gathered before listeners hear of them. */
const BATCH_MS = 40;

function flush(): void {
  timer = null;
  const changed = pending;
  pending = null;
  if (!changed) return;
  for (const l of [...listeners]) {
    const tables = l.tables;
    if (changed === "all" || tables === null || [...changed].some((t) => tables.has(t))) {
      try {
        l.fn();
      } catch (e) {
        console.error("A live-data listener failed", e);
      }
    }
  }
}

/** Says these tables (or anything) changed. */
export function notifyTablesChanged(tables: Iterable<string> | "all"): void {
  if (tables === "all" || pending === "all") {
    pending = "all";
  } else {
    pending ??= new Set();
    for (const t of tables) pending.add(t);
  }
  timer ??= setTimeout(flush, BATCH_MS);
}

/** Calls `fn` after a change to any of `tables` ("all": any change at all). */
export function onTablesChanged(tables: Tables, fn: () => void): () => void {
  const l: Listener = { tables: tables === "all" ? null : new Set(tables), fn };
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * A number that moves whenever one of `tables` changes: put it in the
 * dependency list of the effect that loads them, and the screen stays live.
 */
export function useTablesVersion(tables: Tables): number {
  const [version, setVersion] = useState(0);
  const key = tables === "all" ? "all" : [...tables].sort().join(",");
  useEffect(
    () => onTablesChanged(key === "all" ? "all" : key.split(","), () => setVersion((v) => v + 1)),
    [key],
  );
  return version;
}

/** The table a write statement writes to, or null for anything else. */
export function writtenTable(sql: string): string | null {
  const m = /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|update(?:\s+or\s+\w+)?|delete\s+from|replace\s+into)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
  return m?.[1] ?? null;
}

// Groups of tables the screens think in. A screen may of course list its own.

/** What a day in the Diary is made of. */
export const DIARY_TABLES = [
  "food_entries",
  "workouts",
  "supplements",
  "supplement_logs",
  "captures",
  "sleep_sessions",
  "health_metrics",
  "state_logs",
  "state_log_tags",
  "state_categories",
  "blood_readings",
  "performance_logs",
  "performance_stats",
  "fasts",
  "day_goal_adjustments",
  "incomplete_days",
  "entry_notes",
  "entry_messages",
  "garmin_activities",
  "garmin_days",
  "saved_meals",
] as const;

export const LIBRARY_TABLES = ["documents", "document_files"] as const;
export const MANUAL_TABLES = ["manuals", "manual_revisions"] as const;
export const EXPERIMENT_TABLES = ["experiments", "experiment_trials", "fasts"] as const;
export const COACH_TABLES = ["chats", "coach_memory", "coach_runs", "ai_usage"] as const;
