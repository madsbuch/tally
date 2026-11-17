// Small helpers the tests share, so a test never has to cast what a query or
// a fixture hands back (ESLint bans `as` and `!`; see eslint.config.js).

import { z } from "zod";
import { must } from "../src/lib/must";

export { must };

/** `SELECT id …` / `RETURNING id`. */
export const IdRow = z.object({ id: z.string() });
/** `SELECT count(*) AS n …`. */
export const CountRow = z.object({ n: z.number() });

/** Rows from a raw SQLite query, checked against the shape the query promises. */
export function rowsOf<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T>[] {
  return z.array(schema).parse(raw);
}

/** One row from a raw SQLite query (`.get()`), checked the same way; throws when there is none. */
export function rowOf<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  return schema.parse(raw);
}

/** The item at `i`, which the test has set up to be there. */
export function at<T>(list: readonly T[], i: number): T {
  return must(list[i], `item ${i} of ${list.length}`);
}
