/**
 * Runtime checks that narrow types honestly, for the spots that used to cast
 * (ESLint bans `as` and `!`; see eslint.config.js). Each one looks at the
 * value, so what TypeScript believes afterwards is what's true.
 */

/** `x` is one of `list`'s members — `list.includes(x)` that narrows. */
export function isOneOf<T>(list: readonly T[], x: unknown): x is T {
  return list.some((v) => v === x);
}

/** `k` is one of `o`'s own keys (not something inherited, like "toString"). */
export function isKeyOf<O extends object>(o: O, k: PropertyKey): k is keyof O {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** An object's own fields, each still to be checked; null for a non-object. */
export function fieldsOf(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object") return null;
  return Object.fromEntries(Object.entries(raw));
}
