import { describe, expect, test } from "bun:test";
import { parseNutrientChecks } from "../src/lib/schemas";

const { nutrientChecksMet } = await import("../src/lib/goals");

// Spec: GOAL-6
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
});

// Spec: GOAL-7
describe("checking nutrients off", () => {
  const checks = { vitamin_d_ug: 50, creatine_g: 5 };

  test("a day: met once the amount is reached, not before", () => {
    expect(nutrientChecksMet(checks, { vitamin_d_ug: 50, creatine_g: 4.9 }, 1)).toEqual([
      { key: "vitamin_d_ug", amount: 50, met: true },
      { key: "creatine_g", amount: 5, met: false },
    ]);
  });

  test("nothing logged is not met; nothing picked lists nothing", () => {
    expect(nutrientChecksMet({ creatine_g: 5 }, {}, 1)).toEqual([
      { key: "creatine_g", amount: 5, met: false },
    ]);
    expect(nutrientChecksMet({}, { creatine_g: 5 }, 1)).toEqual([]);
  });

  test("a period needs the daily amount times its days", () => {
    expect(nutrientChecksMet({ creatine_g: 5 }, { creatine_g: 34 }, 7)[0]?.met).toBe(false);
    expect(nutrientChecksMet({ creatine_g: 5 }, { creatine_g: 35 }, 7)[0]?.met).toBe(true);
  });
});
