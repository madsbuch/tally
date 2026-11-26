import { useEffect, useRef, useState } from "react";
import { getNutrientChecks, saveNutrientChecks } from "../lib/goals";
import { CHECKABLE_NUTRIENTS, REFERENCE_INTAKES, nutrientDef } from "../lib/nutrients";
import type { NutrientKey, Nutrients } from "../lib/types";

/** A picked nutrient as typed: the amount stays a string while it's edited. */
interface Row {
  key: NutrientKey;
  amount: string;
}

/** The rows that hold a positive amount, as they are stored. */
function toChecks(rows: Row[]): Nutrients {
  const out: Nutrients = {};
  for (const r of rows) {
    const n = parseFloat(r.amount);
    if (isFinite(n) && n > 0) out[r.key] = n;
  }
  return out;
}

// Spec: SUM-8
/**
 * Settings → Goals: the nutrients to check off each day, each with the user's
 * own daily amount. The Summary marks a picked nutrient's row once that amount
 * is reached. A row without a valid amount yet is kept here but not saved.
 */
export default function NutrientChecksSetting() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);
  const lastSaved = useRef("{}");

  // A form holding a draft: load once, so a sync never overwrites typing.
  useEffect(() => {
    getNutrientChecks()
      .then((checks) => {
        lastSaved.current = JSON.stringify(checks);
        setRows(
          CHECKABLE_NUTRIENTS.flatMap((d) => {
            const amount = checks[d.key];
            return amount != null ? [{ key: d.key, amount: String(amount) }] : [];
          }),
        );
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  function commit(next: Row[]) {
    const checks = toChecks(next);
    const json = JSON.stringify(checks);
    if (json === lastSaved.current) return;
    lastSaved.current = json;
    saveNutrientChecks(checks)
      .then(() => {
        setSaved(true);
        if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => setSaved(false), 1500);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  function add(value: string) {
    const def = CHECKABLE_NUTRIENTS.find((d) => d.key === value);
    if (!def || !rows) return;
    setRows([...rows, { key: def.key, amount: "" }]);
  }

  function remove(key: NutrientKey) {
    if (!rows) return;
    const next = rows.filter((r) => r.key !== key);
    setRows(next);
    commit(next);
  }

  const unpicked = CHECKABLE_NUTRIENTS.filter((d) => !rows?.some((r) => r.key === d.key));

  return (
    <div className="card">
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <h2 className="card-title" style={{ margin: 0 }}>Daily nutrients</h2>
        {saved && <span className="chip chip-accent">Saved</span>}
      </div>
      {error ? (
        <p className="error-text">{error}</p>
      ) : rows == null ? null : (
        <>
          {rows.map((r) => {
            const def = nutrientDef(r.key);
            const id = `nutrient-check-${r.key}`;
            return (
              <div
                key={r.key}
                className="input-row"
                style={{ alignItems: "center", marginTop: 10 }}
              >
                <label htmlFor={id} style={{ flex: 1, minWidth: 0 }}>
                  {def.label}
                </label>
                <input
                  id={id}
                  className="input"
                  style={{ flex: "0 0 96px" }}
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  placeholder={String(REFERENCE_INTAKES[r.key] ?? "")}
                  autoFocus={r.amount === ""}
                  value={r.amount}
                  onChange={(e) =>
                    setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: e.target.value } : x)))
                  }
                  onBlur={() => commit(rows)}
                />
                <span className="muted small" style={{ flex: "0 0 28px" }}>{def.unit}</span>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ flex: "0 0 auto" }}
                  aria-label={`Stop checking ${def.label}`}
                  onClick={() => remove(r.key)}
                >
                  ×
                </button>
              </div>
            );
          })}
          <select
            className="input"
            style={{ marginTop: 10 }}
            aria-label="Add a nutrient"
            value=""
            onChange={(e) => add(e.target.value)}
          >
            <option value="">Add a nutrient…</option>
            {unpicked.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label} ({d.unit})
              </option>
            ))}
          </select>
          <p className="muted small" style={{ margin: "8px 2px 0" }}>
            The Summary puts a checkmark on each of these once you&apos;ve had
            your daily amount: supplements and food together. Over several days
            it compares the average per day.
          </p>
        </>
      )}
    </div>
  );
}
