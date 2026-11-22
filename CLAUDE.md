# Tally

A Tauri (React + TypeScript + SQLite via drizzle) health/nutrition tracker.
The frontend lives in `src/`; the Rust shell in `src-tauri/`.

## The spec

What the product is meant to do is written in `.spec/`, in the format of
https://github.com/madsbuch/better-github/blob/main/spec-llms.txt (read it
before editing the spec). One JSON file per part of the product, folders as
the outline; user stories and requirements with ids unique across the spec
(a prefix per item: `CAP-1`, `SYN-3`), and named values for numbers that more
than one requirement uses.

- The spec comes first: a change to what the product does starts as a new
  requirement, a new `version` of one (old text into `history`, with the
  `reason`), or a deprecation (a `deprecation` record saying why). There is
  no `status`: everything without a `deprecation` holds. Nothing is deleted,
  renumbered or reused; history is never edited.
- Before adding a requirement, look among the deprecated ones for the same
  idea; don't bring one back without asking.
- What isn't decided stays out of the spec — ask instead of guessing.
- The spec never names code; code names the spec. Code or a test that exists
  to meet a requirement carries `// Spec: CAP-1` (ids only) on its own line.
  When a requirement changes, search for its id.
- Constants in the code follow the spec's named values; change both together.
- `tests/spec.test.ts` (part of `bun test`) checks the spec: schema, unique
  ids, references, histories, and that every `Spec:` citation
  names a real requirement. CI doesn't run the test suite, so run it before
  pushing a spec change.

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
  `z.number()` fields: dropping a bad value (negative, non-finite,
  non-numeric) rather than failing the whole row is intentional.

## No casts, no `!`, no `any`, no unsafe

ESLint (`eslint.config.js`) holds all TypeScript — `src/`, `tests/`,
`scripts/` — to these, and an `eslint-disable` comment can't switch them off
(only `react-hooks/exhaustive-deps` may be disabled inline). ESLint doesn't
yet block inline configuration comments (`/* eslint rule: "off" */`); don't
use them either. `tsc` typechecks only `src/`, so in `tests/` and `scripts/`
only an explicit `any` is caught:

- No type assertions (`x as T`; `as const` is fine) and no non-null `!`.
  Narrow instead: `if`/`??`, `isOneOf`/`isKeyOf`/`fieldsOf`
  (`src/lib/guards.ts`), a typed annotation (`.catch((): T[] => [])`), or a
  schema. For a true invariant, `must(value, "what")` (`src/lib/must.ts`)
  throws rather than letting `undefined` through.
- No `any`, and in `src/` no `any` flowing anywhere (`no-unsafe-*`, type-aware):
  give it `unknown` and parse it.
- No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`.
- Rust: every crate under `src-tauri` sets `unsafe_code = "forbid"` in its
  `Cargo.toml` (`tools/sqlite-android-compat` sets nothing yet), except
  the app crate (`src-tauri`), which sets `"deny"` for one audited exception:
  the JNI entry point in `src/sync/background.rs` needs `#[no_mangle]` and
  carries `#[allow(unsafe_code)]`. That code is Android-only, so a desktop
  `cargo check` never sees it: only the APK build (CI) does.

Note that drizzle's `.$type<T>()` on JSON columns is a compile-time claim only —
runtime validation still happens through the schema helpers
(e.g. `parseChatTranscript` for `chats.messages`).

## Navigation rule

What's on screen is the URL's to say: every page has an address (a coach
conversation is `/assistant/:chatId`; an open sheet holds a history entry but
no address of its own), and anything that shows you something —
the tab bar, a banner, a sheet handing off, a chip in a coach message, a
notification tap — gets there with `go()` from `src/lib/navigation.ts`. Each
tab holds a stack: the tab, the pages you went into from it, then any open
sheets. `go(page)` pushes onto the stack you're in, even when the page's
address is another tab's (a meal opened from a chat stays on the Coach's
stack, and the tab bar keeps the Coach lit — `useCurrentTab()`, not
`tabOf()`); a page already on the stack is popped back to. The tab bar and
notification taps use `{ jump: true }` (start the tab afresh, page on top);
a redirect off a page that's gone uses `{ replace: true }`. Back buttons use
`useUp(parent?)` — to where you came from, else the page's usual parent —
and `useUpLabel(usual, parent?)` names where that is. Don't push or replace
around `go` (a plain `<Link>` from a tab into one of its own pages is fine).
A new page goes under its tab's path (`/assistant/…`) — that's how `tabOf()`
knows which tab it belongs to; the Diary, being `/`, owns the rest — and
gets a name in `placeName()`. `bun run test:nav` drives the real history in
Chromium (`tests/browser/`).

## Live data

Screens show what's in the database now, whoever changed it: this device,
another one through sync, or the Android check-in worker while the app was
away. A screen that reads data subscribes to the tables it shows —
`useTablesVersion([...])` in its load effect's dependencies, or
`onTablesChanged` (`src/lib/live.ts`) — rather than loading once. Writes
through `db.ts` to synced tables announce themselves (only real changes,
judged by sync's change counter; writes to local tables like
`device_settings` don't announce); anything written past it (Rust commands like `save_photo`)
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
session deleted by hand (`deleted_imports`). Rows are matched by the source's
record id when it names one, else by time (`lib/syncMatch.ts`): every phone's
Health Connect names records afresh, so time is what two phones agree on.
See the header of `src/lib/garminDb.ts`; `tests/garmin-first.test.ts` drives
the real Health Connect sync against a fake one.

## Data rules (sync-ready)

The database is meant to sync between devices, so:

- Every entity table (one with a prefix in `ID_PREFIXES`) is keyed by a
  TypeID string — the table's prefix and a UUID (v7 for new rows),
  `meal_01jd4x8m2kf7r9q3vz5w6t0hyc` (`rowId("<table>")` in
  `src/db/schema.ts`, `newId("<table>")` in `src/lib/ids.ts`). Other tables
  use a natural key (a settings key, a day, a photo's hash, a Garmin
  activity id); no table uses an auto-increment integer. A new entity table
  gets its prefix in `ID_PREFIXES`; a prefix never changes once rows exist. Rows imported from an external system
  get `derivedId(table, externalKey)` so two devices importing the same record
  agree on its id (a UUIDv8). Raw SQL inserts (Kotlin `CoachDb`, Rust, tests)
  must supply the id themselves, spelled the same way. Kotlin and Rust have
  their own encoder; the TS and Rust ones are pinned to the TypeID spec's
  examples by tests, the Kotlin one isn't yet.
- Ids are how the coach points at things: tools take them through
  `idArg(raw, prefix)` (which also reads the bare UUIDs and numbers old chats
  quote, and refuses another kind's id — say why with `idArgProblem`), and an
  id the coach writes in a message shows as a chip with that entity's title
  (`src/lib/entities.ts`, `components/EntityChip.tsx`). A new kind of entity
  the coach can name should get a title and a screen there.
- Settings that belong to one device (sync bookmarks, caches, the unread
  badge) are listed in `DEVICE_SETTING_KEYS` (`src/lib/types.ts`) and live in
  `device_settings`; `getSetting`/`setSetting` route them. Keep the Kotlin
  mirror in `CoachDb.kt` in step.
- New photos are named by the SHA-256 of their bytes (`photos.rs`), so a
  name always means the same image; older photos keep their earlier names.
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
  check-ins and Health Connect and Garmin imports only on Android — otherwise two devices
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
- `bun run build` — typecheck `src/` (`tsc`), lint everything, and bundle
- `bun run lint` — ESLint only
- `bun run tauri android build --apk` — Android build (CI does this)
