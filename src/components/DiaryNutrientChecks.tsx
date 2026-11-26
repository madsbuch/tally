import { useEffect, useMemo, useState } from "react";
import { getNutrientChecks, nutrientChecksMet } from "../lib/goals";
import { formatAmount, nutrientDef, scaleNutrients, sumNutrients } from "../lib/nutrients";
import type { FoodEntry, Nutrients, SupplementLogWithSupplement } from "../lib/types";
import { useTablesVersion } from "../lib/live";

// Spec: GOAL-7
/**
 * In the Calorie target card: the nutrients picked in Settings → Goals, each
 * checked off once the shown period's intake (food and legacy supplement
 * doses) reaches its daily amount times the period's days. Nothing when none
 * are picked.
 */
export default function DiaryNutrientChecks({
  entries,
  suppLogs,
  days,
}: {
  entries: FoodEntry[] | null;
  suppLogs: SupplementLogWithSupplement[] | null;
  days: number;
}) {
  const [checks, setChecks] = useState<Nutrients>({});
  const live = useTablesVersion(["settings"]);
  useEffect(() => {
    let cancelled = false;
    getNutrientChecks()
      .then((c) => {
        if (!cancelled) setChecks(c);
      })
      .catch((e: unknown) => {
        // A broken setting costs the check marks, not the Diary.
        console.warn("nutrient checks:", e);
        if (!cancelled) setChecks({});
      });
    return () => {
      cancelled = true;
    };
  }, [live]);

  const intake = useMemo(
    () =>
      sumNutrients([
        ...(entries ?? []).map((e) => e.nutrients),
        ...(suppLogs ?? []).map((l) => scaleNutrients(l.nutrients, l.amount)),
      ]),
    [entries, suppLogs],
  );

  const rows = nutrientChecksMet(checks, intake, days);
  if (rows.length === 0 || entries == null) return null;

  return (
    <div className="chips" style={{ marginTop: 10 }}>
      {rows.map(({ key, amount, met }) => {
        const def = nutrientDef(key);
        const label = `${def.label}: ${met ? "reached" : "not yet"} ${formatAmount(key, amount)} a day`;
        return (
          <span
            key={key}
            className={`chip${met ? " chip-accent" : ""}`}
            aria-label={label}
            title={label}
          >
            {met ? "✓" : "○"} {def.label}
          </span>
        );
      })}
    </div>
  );
}
