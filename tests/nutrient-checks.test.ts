import { describe, expect, test } from "bun:test";
import { parseNutrientChecks } from "../src/lib/schemas";
import { CHECKABLE_NUTRIENTS } from "../src/lib/nutrients";

// Spec: SUM-8
describe("nutrient checks setting", () => {
  test("reads the picked nutrients and their daily amounts", () => {
    expect(parseNutrientChecks('{"vitamin_d_ug":50,"creatine_g":5}')).toEqual({
      vitamin_d_ug: 50,
      creatine_g: 5,
    });
  });

  test("drops a key that is no longer a nutrient", () => {
    expect(parseNutrientChecks('{"creatine_g":5,"unobtainium_g":1}')).toEqual({ creatine_g: 5 });
  });

  test("a corrupt amount surfaces instead of passing", () => {
    expect(() => parseNutrientChecks('{"creatine_g":-1}')).toThrow();
    expect(() => parseNutrientChecks('{"creatine_g":"lots"}')).toThrow();
    expect(() => parseNutrientChecks("[5]")).toThrow();
  });

  test("only nutrients with a Summary row can be picked", () => {
    const keys = CHECKABLE_NUTRIENTS.map((d) => d.key);
    expect(keys).toContain("vitamin_d_ug");
    expect(keys).toContain("creatine_g");
    expect(keys).toContain("epa_dha_g");
    expect(keys).toContain("magnesium_mg");
    expect(keys).not.toContain("calories");
    expect(keys).not.toContain("trans_fat_g");
  });
});
