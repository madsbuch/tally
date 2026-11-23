// The constants in the code that follow a shared part's named values (or the
// value the import sets instead) must match the spec. They live in Rust,
// which `bun test` can't run, so this reads them from the source.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "../src/lib/schemas";

const ROOT = join(import.meta.dir, "..");
const SPEC = join(ROOT, ".spec");

const Imports = z.object({
  imports: z
    .array(z.object({ at: z.string(), values: z.array(z.object({ id: z.string(), value: z.unknown() })).optional() }))
    .optional(),
});
const Values = z.object({ values: z.array(z.object({ id: z.string(), value: z.unknown() })).optional() });

/** A named value as this product has it: the import's override, else the part's own. */
function specValue(file: string, id: string): unknown {
  const imports = Imports.parse(parseJson(readFileSync(join(SPEC, "index.json"), "utf8"))).imports ?? [];
  const override = imports.flatMap((i) => i.values ?? []).find((v) => v.id === id);
  if (override) return override.value;
  const values = Values.parse(parseJson(readFileSync(join(SPEC, file), "utf8"))).values ?? [];
  const own = values.find((v) => v.id === id);
  if (!own) throw new Error(`${file} has no value ${id}`);
  return own.value;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
function durationMs(v: unknown): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|min|h|d)$/.exec(z.string().parse(v));
  const unit = UNIT_MS[m?.[2] ?? ""];
  if (!m || unit === undefined) throw new Error(`not a duration: ${String(v)}`);
  return Number(m[1]) * unit;
}

/** A Rust constant's right-hand side, with `a * b` products worked out. */
function rustConst(file: string, name: string): string {
  const src = readFileSync(join(ROOT, "src-tauri/src", file), "utf8");
  const m = new RegExp(`const ${name}: [^=]+= ([^;]+);`).exec(src);
  if (!m?.[1]) throw new Error(`${file} has no const ${name}`);
  return m[1];
}
function product(expr: string): number {
  return expr.split("*").reduce((acc, f) => acc * Number(f.trim().replace(/_/g, "")), 1);
}

describe("Tandem's named values", () => {
  test("the pairing code lasts tandem.pairing-lifetime", () => {
    const m = /^Duration::from_secs\((.+)\)$/.exec(rustConst("sync/session.rs", "PAIRING_TTL"));
    expect(product(m?.[1] ?? "NaN") * 1000).toBe(durationMs(specValue("tandem/pairing.json", "tandem.pairing-lifetime")));
  });

  test("daily snapshots are kept for tandem.snapshot-daily", () => {
    expect(product(rustConst("sync/snapshots.rs", "DAILY")) * UNIT_MS.d).toBe(
      durationMs(specValue("tandem/snapshots.json", "tandem.snapshot-daily")),
    );
  });

  test("weekly snapshots are kept back to tandem.snapshot-weekly", () => {
    expect(product(rustConst("sync/snapshots.rs", "WEEKLY_UNTIL")) * UNIT_MS.d).toBe(
      durationMs(specValue("tandem/snapshots.json", "tandem.snapshot-weekly")),
    );
  });
});
