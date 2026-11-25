import { useEffect, useRef, useState } from "react";
import { deleteSetting, getSetting, setSetting } from "../lib/db";
import { DEFAULT_FAST_HOURS, DEFAULT_KETO_NET_CARB_LIMIT_G, SETTING_KEYS } from "../lib/types";
import SettingsFolder from "../components/SettingsFolder";

// Spec: SET-1
/** Settings → Goals: the calorie target, the usual fast and the keto carb limit. */
export default function SettingsGoalsPage() {
  const [loading, setLoading] = useState(true);

  // Fasting
  const [fastHours, setFastHours] = useState(String(DEFAULT_FAST_HOURS));
  const [fastSaved, setFastSaved] = useState(false);
  const fastSavedTimer = useRef<number | null>(null);
  const lastFastHoursRef = useRef(String(DEFAULT_FAST_HOURS));

  // Keto
  const [carbLimit, setCarbLimit] = useState(String(DEFAULT_KETO_NET_CARB_LIMIT_G));
  const [carbSaved, setCarbSaved] = useState(false);
  const carbSavedTimer = useRef<number | null>(null);
  const lastCarbLimitRef = useRef(String(DEFAULT_KETO_NET_CARB_LIMIT_G));

  // Calorie target ("" = no target set)
  const [calTarget, setCalTarget] = useState("");
  const [calSaved, setCalSaved] = useState(false);
  const calSavedTimer = useRef<number | null>(null);
  const lastCalTargetRef = useRef("");

  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      try {
        const [hours, carbs, kcal] = await Promise.all([
          getSetting(SETTING_KEYS.fastDefaultHours),
          getSetting(SETTING_KEYS.ketoNetCarbLimit),
          getSetting(SETTING_KEYS.calorieTarget),
        ]);
        if (hours) {
          setFastHours(hours);
          lastFastHoursRef.current = hours;
        }
        if (carbs) {
          setCarbLimit(carbs);
          lastCarbLimitRef.current = carbs;
        }
        if (kcal) {
          setCalTarget(kcal);
          lastCalTargetRef.current = kcal;
        }
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      if (fastSavedTimer.current != null) window.clearTimeout(fastSavedTimer.current);
      if (carbSavedTimer.current != null) window.clearTimeout(carbSavedTimer.current);
      if (calSavedTimer.current != null) window.clearTimeout(calSavedTimer.current);
    };
  }, []);

  function commitFastHours() {
    const n = parseFloat(fastHours);
    // Empty/invalid input: restore the last committed value, don't overwrite.
    if (!isFinite(n)) {
      setFastHours(lastFastHoursRef.current);
      return;
    }
    // Fasts can be multi-day; keep fractional hours (0.5 steps).
    const clamped = Math.min(168, Math.max(1, Math.round(n * 10) / 10));
    const str = String(clamped);
    setFastHours(str);
    if (str === lastFastHoursRef.current) return;
    lastFastHoursRef.current = str;
    void setSetting(SETTING_KEYS.fastDefaultHours, str).then(() => {
      setFastSaved(true);
      if (fastSavedTimer.current != null) window.clearTimeout(fastSavedTimer.current);
      fastSavedTimer.current = window.setTimeout(() => setFastSaved(false), 1500);
    });
  }

  function commitCarbLimit() {
    const n = parseFloat(carbLimit);
    // Empty/invalid input: restore the last committed value, don't overwrite.
    if (!isFinite(n)) {
      setCarbLimit(lastCarbLimitRef.current);
      return;
    }
    const clamped = Math.min(150, Math.max(5, Math.round(n)));
    const str = String(clamped);
    setCarbLimit(str);
    if (str === lastCarbLimitRef.current) return;
    lastCarbLimitRef.current = str;
    void setSetting(SETTING_KEYS.ketoNetCarbLimit, str).then(() => {
      setCarbSaved(true);
      if (carbSavedTimer.current != null) window.clearTimeout(carbSavedTimer.current);
      carbSavedTimer.current = window.setTimeout(() => setCarbSaved(false), 1500);
    });
  }

  function flashCalSaved() {
    setCalSaved(true);
    if (calSavedTimer.current != null) window.clearTimeout(calSavedTimer.current);
    calSavedTimer.current = window.setTimeout(() => setCalSaved(false), 1500);
  }

  function commitCalorieTarget() {
    const trimmed = calTarget.trim();
    // Empty clears the target and hides tracking on the Diary page.
    if (!trimmed) {
      if (lastCalTargetRef.current === "") return;
      lastCalTargetRef.current = "";
      void deleteSetting(SETTING_KEYS.calorieTarget).then(flashCalSaved);
      return;
    }
    const n = parseFloat(trimmed);
    if (!isFinite(n)) {
      setCalTarget(lastCalTargetRef.current);
      return;
    }
    const clamped = Math.min(10000, Math.max(500, Math.round(n)));
    const str = String(clamped);
    setCalTarget(str);
    if (str === lastCalTargetRef.current) return;
    lastCalTargetRef.current = str;
    void setSetting(SETTING_KEYS.calorieTarget, str).then(flashCalSaved);
  }

  if (loading) {
    return (
      <SettingsFolder title="Goals">
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      </SettingsFolder>
    );
  }

  return (
    <SettingsFolder title="Goals">
      <div className="card">
        <h2 className="card-title">Calorie target</h2>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="calorie-target">
            Daily target (kcal)
          </label>
          <div className="input-row" style={{ alignItems: "center" }}>
            <input
              id="calorie-target"
              className="input"
              type="number"
              min={500}
              max={10000}
              step={50}
              inputMode="numeric"
              placeholder="No target"
              value={calTarget}
              onChange={(e) => setCalTarget(e.target.value)}
              onBlur={commitCalorieTarget}
            />
            {calSaved && (
              <span className="chip chip-accent" style={{ flex: "0 0 auto" }}>
                Saved
              </span>
            )}
          </div>
          <p className="muted small" style={{ margin: "8px 2px 0" }}>
            The Diary page tracks your net kcal (eaten − burned) against this
            budget: daily, weekly (target × 7) and monthly (target × days in
            the month). Leave empty for no target. A single day can be
            corrected from the Diary; that shifts the day, not the week.
          </p>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Fasting</h2>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="fast-hours">
            Default goal hours
          </label>
          <div className="input-row" style={{ alignItems: "center" }}>
            <input
              id="fast-hours"
              className="input"
              type="number"
              min={1}
              max={168}
              step={0.5}
              inputMode="numeric"
              value={fastHours}
              onChange={(e) => setFastHours(e.target.value)}
              onBlur={commitFastHours}
            />
            {fastSaved && (
              <span className="chip chip-accent" style={{ flex: "0 0 auto" }}>
                Saved
              </span>
            )}
          </div>
          <p className="muted small" style={{ margin: "8px 2px 0" }}>
            Used when starting a new fast (1–168 hours, multi-day fasts welcome).
          </p>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Keto</h2>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="keto-carb-limit">
            Daily net-carb limit (g)
          </label>
          <div className="input-row" style={{ alignItems: "center" }}>
            <input
              id="keto-carb-limit"
              className="input"
              type="number"
              min={5}
              max={150}
              step={1}
              inputMode="numeric"
              value={carbLimit}
              onChange={(e) => setCarbLimit(e.target.value)}
              onBlur={commitCarbLimit}
            />
            {carbSaved && (
              <span className="chip chip-accent" style={{ flex: "0 0 auto" }}>
                Saved
              </span>
            )}
          </div>
          <p className="muted small" style={{ margin: "8px 2px 0" }}>
            The Keto card on the Nutrients page tracks net carbs (carbs − fiber)
            against this budget. Strict keto is usually 20–25 g, relaxed low-carb
            up to 50 g.
          </p>
        </div>
      </div>
    </SettingsFolder>
  );
}
