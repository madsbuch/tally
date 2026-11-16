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
- Prefer inferring types from schemas (`z.infer`) over maintaining parallel
  interfaces. `ChatMessage`, `ToolCall`, `ContentPart`, and `ORModel` are
  already schema-derived.
- Schemas for model/API output should be forgiving (coerce + default, e.g.
  `.catch()` / transforms) so a sloppy answer degrades instead of failing;
  schemas for our own persisted data should be strict so corruption surfaces.
- Value-level coercion helpers like `sanitizeNutrients` (`src/lib/nutrients.ts`)
  are legitimate and used *inside* schemas — don't replace them with naive
  `z.number()` fields, their clamping semantics are intentional.

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
- `bun run build` — typecheck (`tsc`), lint, and bundle
- `bun run lint` — ESLint only
- `bun run tauri android build --apk` — Android build (CI does this)
