/**
 * The value, when the code around it guarantees one — an index already
 * bounds-checked, a lookup into a table that lists every key. Throws instead
 * of letting `undefined` slip on, which a `!` would do silently (ESLint bans
 * `!` and `as`; see eslint.config.js). Prefer narrowing (`if`, `??`, a type
 * guard) wherever "missing" has a sensible meaning; this is for the
 * invariants that don't.
 */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value == null) throw new Error(`Expected a ${what}, found ${String(value)}`);
  return value;
}

/** `load`, run once on first call; every later call gets the same promise. */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= load());
}
