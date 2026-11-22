// Checks the product spec in `.spec/` against the spec format
// (https://github.com/madsbuch/better-github/blob/main/spec-llms.txt):
// every item fits the schema, every reference resolves, versions carry
// their history, no id is used twice, and every
// `Spec: ID` citation in the code names a requirement the spec has.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { parseJson } from "../src/lib/schemas";

const ROOT = join(import.meta.dir, "..");
const SPEC = join(ROOT, ".spec");

const Level = z.enum(["must", "should", "may"]);
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Deprecation = z.strictObject({
  reason: z.string().min(1),
  replacedBy: z.array(z.string().min(1)).optional(),
  date: Day.optional(),
});
const Story = z.strictObject({
  id: Id,
  as: z.string().min(1),
  want: z.string().min(1),
  soThat: z.string().min(1).optional(),
  requirements: z.array(z.string().min(1)).optional(),
  deprecation: Deprecation.optional(),
});
const Requirement = z.strictObject({
  id: Id,
  text: z.string().min(1),
  level: Level.optional(),
  version: z.number().int().min(1).optional(),
  history: z
    .array(
      z.strictObject({
        version: z.number().int().min(1),
        text: z.string().min(1),
        level: Level.optional(),
        reason: z.string().min(1),
        date: Day.optional(),
      }),
    )
    .optional(),
  deprecation: Deprecation.optional(),
});
// The value forms are the schema's own patterns, verbatim.
const Hex = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
const ValueBase = {
  id: Id,
  description: z.string().optional(),
  deprecation: Deprecation.optional(),
  history: z
    .array(
      z.strictObject({
        value: z.union([z.string(), z.number(), z.array(z.string())]),
        dark: z.string().optional(),
        reason: z.string().min(1),
        date: Day.optional(),
      }),
    )
    .optional(),
};
const Value = z.discriminatedUnion("type", [
  z.strictObject({ ...ValueBase, type: z.literal("color"), value: Hex, dark: Hex.optional() }),
  z.strictObject({
    ...ValueBase,
    type: z.literal("dimension"),
    value: z.string().regex(/^-?\d+(?:\.\d+)?(?:px|rem|em|%|pt|dp|vw|vh)$/),
  }),
  z.strictObject({
    ...ValueBase,
    type: z.literal("duration"),
    value: z.string().regex(/^\d+(?:\.\d+)?(?:ms|s|min|h|d)$/),
  }),
  z.strictObject({ ...ValueBase, type: z.literal("number"), value: z.number(), unit: z.string().min(1).optional() }),
  z.strictObject({ ...ValueBase, type: z.literal("text"), value: z.string() }),
  z.strictObject({ ...ValueBase, type: z.literal("font"), value: z.string().min(1) }),
  z.strictObject({ ...ValueBase, type: z.literal("list"), value: z.array(z.string().min(1)) }),
]);
const Item = z.strictObject({
  $schema: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().optional(),
  deprecation: Deprecation.optional(),
  order: z.number().optional(),
  description: z.string().optional(),
  stories: z.array(Story).optional(),
  requirements: z.array(Requirement).optional(),
  values: z.array(Value).optional(),
  figures: z
    .array(z.strictObject({ src: z.string().min(1).regex(/^[^/]/), alt: z.string().optional(), caption: z.string().optional() }))
    .optional(),
  related: z.array(z.string().min(1)).optional(),
});
type Item = z.infer<typeof Item>;

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" || name === "target" || name.startsWith(".") ? [] : walk(path, keep);
    }
    return keep(path) ? [path] : [];
  });
}

/** An item's id: its path in `.spec` without `.json`; a folder's `index.json` is the folder. */
function itemId(path: string): string {
  const rel = relative(SPEC, path).replace(/\.json$/, "");
  return rel === "index" ? "" : rel.replace(/\/index$/, "");
}

const items = new Map<string, Item>();
const problems: string[] = [];
for (const path of walk(SPEC, (p) => p.endsWith(".json"))) {
  const parsed = Item.safeParse(parseJson(readFileSync(path, "utf8")));
  if (parsed.success) items.set(itemId(path), parsed.data);
  else problems.push(`${relative(ROOT, path)}: ${parsed.error.message}`);
}

const requirementIds = new Set<string>();
const allIds: string[] = [];
for (const item of items.values()) {
  for (const s of item.stories ?? []) allIds.push(s.id);
  for (const r of item.requirements ?? []) {
    allIds.push(r.id);
    requirementIds.add(r.id);
  }
  for (const v of item.values ?? []) allIds.push(v.id);
}
const idSet = new Set(allIds);

/** `#ID`, `#ID@2`, `item`, or `item#ID`. */
function resolves(ref: string): boolean {
  const [item, id] = ref.includes("#") ? ref.split("#", 2) : [ref, undefined];
  if (item !== undefined && item !== "" && !items.has(item)) return false;
  if (id === undefined) return true;
  const bare = id.replace(/@\d+$/, "");
  if (item !== undefined && item !== "") {
    const owner = items.get(item);
    return [...(owner?.stories ?? []), ...(owner?.requirements ?? []), ...(owner?.values ?? [])].some(
      (x) => x.id === bare,
    );
  }
  return idSet.has(bare);
}

describe("spec", () => {
  test("every item fits the schema", () => {
    expect(problems).toEqual([]);
    expect(items.has("")).toBe(true);
  });

  test("no story, requirement or value id is used twice", () => {
    expect(allIds.filter((id, i) => allIds.indexOf(id) !== i)).toEqual([]);
  });

  test("every reference resolves", () => {
    const bad: string[] = [];
    for (const [id, item] of items) {
      const where = id || "(root)";
      for (const ref of item.related ?? []) if (!resolves(ref)) bad.push(`${where} related ${ref}`);
      for (const s of item.stories ?? []) {
        for (const ref of s.requirements ?? []) {
          if (!ref.startsWith("#") || !requirementIds.has(ref.slice(1).replace(/@\d+$/, ""))) {
            bad.push(`${where} ${s.id} names ${ref}, not a requirement`);
          }
        }
      }
      const deprecations = [
        item.deprecation,
        ...[...(item.stories ?? []), ...(item.requirements ?? []), ...(item.values ?? [])].map((x) => x.deprecation),
      ];
      for (const d of deprecations) {
        for (const ref of d?.replacedBy ?? []) if (!resolves(ref)) bad.push(`${where} replacedBy ${ref}`);
      }
      for (const f of item.figures ?? []) if (!existsSync(join(SPEC, f.src))) bad.push(`${where} figure ${f.src}`);
    }
    expect(bad).toEqual([]);
  });

  test("versions carry their history", () => {
    const bad: string[] = [];
    for (const [id, item] of items) {
      for (const r of item.requirements ?? []) {
        const versions = (r.history ?? []).map((h) => h.version);
        const expected = Array.from({ length: (r.version ?? 1) - 1 }, (_, i) => i + 1);
        if (JSON.stringify(versions) !== JSON.stringify(expected)) bad.push(`${id || "(root)"} ${r.id} history`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("code cites only requirements the spec has", () => {
    const sources = [join(ROOT, "src"), join(ROOT, "src-tauri"), join(ROOT, "tests"), join(ROOT, "scripts")];
    const bad: string[] = [];
    for (const dir of sources) {
      for (const path of walk(dir, (p) => /\.(ts|tsx|rs|kt|mjs|cjs)$/.test(p))) {
        for (const m of readFileSync(path, "utf8").matchAll(/^\s*(?:\/\/|\*|#)\s*Spec:\s*(.+)$/gm)) {
          for (const ref of (m[1] ?? "").split(",").map((s) => s.trim().replace(/@\d+$/, ""))) {
            if (!requirementIds.has(ref)) bad.push(`${relative(ROOT, path)}: ${ref}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
