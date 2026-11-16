import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

// One in-memory database for every test file: bun runs them in one process,
// so db.ts (and its cached connection) is shared — two files mocking
// tauri-plugin-sql with two databases would write to one and read the other.
// Migrations are applied in the order lib.rs registers them.
export const sqlite = new Database(":memory:");
const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
for (const match of rust.matchAll(/include_str!\("\.\.\/migrations\/([^\"]+)"\)/g)) {
  sqlite.exec(readFileSync(new URL(`../src-tauri/migrations/${match[1]}`, import.meta.url), "utf8"));
}
mock.module("@tauri-apps/plugin-sql", () => ({ default: {
  load: async () => ({
    execute: async (sql: string, params: never[] = []) => sqlite.query(sql).run(...params),
    select: async (sql: string, params: never[] = []) => sqlite.query(sql).all(...params),
  }),
} }));

/**
 * Tauri commands, as the tests want them answered: `tauriCommands[name] =
 * (args) => result`. Unlisted ones fail, as they would outside the app.
 * Shared by every test file (bun mocks a module once per process).
 */
export const tauriCommands: Record<string, (args: Record<string, unknown>) => unknown> = {
  sync_check_instance: () => null,
  import_photo_files: () => 0,
};
const tauriCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...tauriCore,
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const handler = tauriCommands[cmd];
    if (!handler) throw new Error(`No Tauri command "${cmd}" in tests`);
    return handler(args);
  },
}));
