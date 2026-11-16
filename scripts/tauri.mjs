// `bun run tauri …` goes through here on its way to the Tauri CLI, so that a
// development build can never run as the real app.
//
// The real app keeps its database in a folder named after its identifier
// (com.madsbuch.tally). A desktop `tauri dev` with that identifier would open
// the real database — and with sync, whatever an unfinished build does to it
// would reach every device. So `dev` on the desktop always gets
// src-tauri/tauri.dev.conf.json: "Tally Dev", com.madsbuch.tally.dev, a
// folder of its own.
//
// Android is kept apart differently: debug builds get the package
// com.madsbuch.tally.dev (applicationIdSuffix in gen/android/app/
// build.gradle.kts), so they install beside the real app with their own data.
// Its identifier can't change here — Tauri derives the Android JNI bindings
// from it.
//
// Everything else (build, android build, …) passes through untouched.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DEV_CONFIG = "src-tauri/tauri.dev.conf.json";

const desktopDev = args[0] === "dev";
const overridesConfig = args.some((a) => a === "--config" || a === "-c" || a.startsWith("--config="));
if (desktopDev && !overridesConfig) {
  args.push("--config", join(root, DEV_CONFIG));
  console.error(`tauri dev: running as "Tally Dev" with its own data (${DEV_CONFIG}).`);
}

const cli = join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const r = spawnSync(cli, args, { stdio: "inherit", cwd: process.cwd() });
process.exit(r.status ?? 1);
