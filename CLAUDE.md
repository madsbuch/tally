# Tally

A Tauri (React + TypeScript + SQLite via drizzle) health/nutrition tracker.
The frontend lives in `src/`; the Rust shell in `src-tauri/`.

## JSON boundary rule

All untrusted JSON — SQLite JSON columns, LLM output, external API responses
(OpenRouter, Open Food Facts), and JSON blobs in the `settings` table — must be
parsed through a zod schema defined in `src/lib/schemas.ts`. Concretely:

- `JSON.parse` is only allowed inside `src/lib/schemas.ts` (via its `parseJson`
  helper). ESLint enforces this (`eslint.config.js`, run by `bun run lint` and
  as part of `bun run build`).
- Never cast parsed JSON with `as` — add or extend a schema in
  `src/lib/schemas.ts` and export a typed parse helper instead.
- The same goes for what Tauri commands and plugins hand back: no
  `invoke<T>()` and no `as` on an awaited result (ESLint enforces both) —
  pass the result to a parse helper (`parseCommandString`,
  `parseHCExerciseSessions`, `parseSqlRows`, …).
- Prefer inferring types from schemas (`z.infer`) over maintaining parallel
  interfaces. `ChatMessage`, `ToolCall`, `ContentPart`, and `ORModel` are
  already schema-derived.
- Schemas for model/API output should be forgiving (coerce + default, e.g.
  `.catch()` / transforms) so a sloppy answer degrades instead of failing;
  schemas for our own persisted data should be strict so corruption surfaces.
- Value-level coercion helpers like `sanitizeNutrients` (`src/lib/nutrients.ts`)
  are legitimate and used *inside* schemas — don't replace them with naive
  `z.number()` fields, their clamping semantics are intentional.

## No casts, no `!`, no `any`, no unsafe

ESLint (`eslint.config.js`) holds all TypeScript — `src/`, `tests/`,
`scripts/` — to these, and they can't be switched off with a comment (only
`react-hooks/exhaustive-deps` may be disabled inline):

- No type assertions (`x as T`; `as const` is fine) and no non-null `!`.
  Narrow instead: `if`/`??`, `isOneOf`/`isKeyOf`/`fieldsOf`
  (`src/lib/guards.ts`), a typed annotation (`.catch((): T[] => [])`), or a
  schema. For a true invariant, `must(value, "what")` (`src/lib/must.ts`)
  throws rather than letting `undefined` through.
- No `any`, and in `src/` no `any` flowing anywhere (`no-unsafe-*`, type-aware):
  give it `unknown` and parse it.
- No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`.
- Rust: every crate sets `unsafe_code = "forbid"` in its `Cargo.toml`.

Note that drizzle's `.$type<T>()` on JSON columns is a compile-time claim only —
runtime validation still happens through the schema helpers
(e.g. `parseChatTranscript` for `chats.messages`).

## Navigation rule

What's on screen is the URL's to say: every screen has an address (a coach
conversation is `/assistant/:chatId`), and anything that shows you something —
the tab bar, a banner, a sheet handing off, a notification tap — gets there
with `go()` from `src/lib/navigation.ts`. It keeps history in one shape: the
tab, at most one of its pages, then any open sheets — so back from a page lands
on its tab and back from a tab leaves the app. Don't push or replace around it
(a plain `<Link>` from a tab into one of its own pages is fine); back buttons
use `useUp()`. A new page goes under its tab's path (`/assistant/…`) — that's
how `tabOf()` knows which tab it belongs to; the Diary, being `/`, owns the rest.

## Live data

Screens show what's in the database now, whoever changed it: this device,
another one through sync, or the Android check-in worker while the app was
away. A screen that reads data subscribes to the tables it shows —
`useTablesVersion([...])` in its load effect's dependencies, or
`onTablesChanged` (`src/lib/live.ts`) — rather than loading once. Writes
through `db.ts` announce themselves (only real changes, judged by sync's
change counter); anything written past it (Rust commands like `save_photo`)
calls `notifyTablesChanged` itself. Forms that hold a draft (Settings) load
once on open, so a sync never overwrites what you're typing.

## Health data: Health Connect and Garmin

Both carry the same watch (Health Connect only reads what the Garmin Connect
app writes there), so they're one source arriving twice. Health Connect is
the event bus: it has things first, so its rows go in at once, provisional,
and its movement triggers a Garmin sync (`syncGarminIfStale`). Garmin's own
numbers are the trusted ones: once Garmin has a day, an activity or a night,
its values stand — `applyGarminMetrics`, `applyGarminToWorkout`,
`applyGarminSleep` — and Health Connect's writes defer to them. Above both:
a field changed by hand (`workouts.edited_by_hand`, `WORKOUT_EDITED`) and a
session deleted by hand (`deleted_imports`). Rows are matched by time, not
id (`lib/syncMatch.ts`): every phone's Health Connect names records afresh.
See the header of `src/lib/garminDb.ts`; `tests/garmin-first.test.ts` drives
the real Health Connect sync against a fake one.

## Data rules (sync-ready)

The database is meant to sync between devices, so:

- Every table is keyed by a UUIDv7 string (`rowId()` in `src/db/schema.ts`,
  `newId()` in `src/lib/ids.ts`) — never an auto-increment integer. Rows
  imported from an external system get `derivedId(namespace, externalKey)` so
  two devices importing the same record agree on its id. Raw SQL inserts
  (Kotlin `CoachDb`, Rust, tests) must supply the id themselves.
- Settings that belong to one device (sync bookmarks, caches, the unread
  badge) are listed in `DEVICE_SETTING_KEYS` (`src/lib/types.ts`) and live in
  `device_settings`; `getSetting`/`setSetting` route them. Keep the Kotlin
  mirror in `CoachDb.kt` in step.
- Photos are named by the SHA-256 of their bytes (`photos.rs`), so a name
  always means the same image.
- Every table syncs between the vault's devices (`src-tauri/src/sync/`)
  unless it's listed in `LOCAL_TABLES` (`scripts/sync-triggers.ts`). Sync
  rides on triggers: a migration that adds a table must add its triggers
  (`bun scripts/sync-triggers.ts <table>` prints them); one that rebuilds a
  table must re-create them (dropping a table drops its triggers); and one
  that adds a column must re-create that table's triggers
  (`--retrigger <table>`), since the update trigger lists the columns it
  watches. `tests/sync-tracking.test.ts` fails for any of these left undone.
  Trigger SQL must run on Android 14's SQLite 3.39 (the coach worker opens
  the database with it); CI checks with `tools/sqlite-android-compat`.
- Work waiting on a row (a capture to analyse, a document to read) is done
  only by the device that wrote it (`writtenHere` in `src/lib/db.ts`), and
  check-ins and Garmin imports only on the phone — otherwise two devices
  would both do it.

## Commands

- `bun run dev` — Vite dev server
- `bun run tauri dev` — the app in development. It always runs as
  "Tally Dev" with data of its own, never as the real app:
  - desktop: `scripts/tauri.mjs` adds `src-tauri/tauri.dev.conf.json`
    (`com.madsbuch.tally.dev`, its own data folder); a debug build started
    any other way under the real identifier refuses to start (`lib.rs`);
  - Android: debug builds are the package `com.madsbuch.tally.dev`
    (`debugApplicationIdSuffix`), installed beside the real app;
  - sync: development and release builds never sync with each other
    (`same_build` in `src-tauri/src/sync/session.rs`).
  The real database must never be opened by unfinished code: with sync, its
  mistakes would reach every device.
- `bun run build` — typecheck (`tsc`), lint, and bundle
- `bun run lint` — ESLint only
- `bun run tauri android build --apk` — Android build (CI does this)
