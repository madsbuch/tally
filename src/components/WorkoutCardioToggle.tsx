import { useState } from "react";
import { setWorkoutCardio } from "../lib/db";
import { CARDIO_MIN_AVG_HR, normalizeAverageHeartRate } from "../lib/exerciseGoals";
import type { Workout } from "../lib/types";

/** A manual choice takes precedence until the user restores the automatic rule. */
export default function WorkoutCardioToggle({ workout, onSaved }: {
  workout: Workout;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = workout.cardio;
  const manual = workout.cardio_by_hand;
  const avgHr = normalizeAverageHeartRate(workout.avg_hr);
  const minutes = workout.duration_min != null && Number.isFinite(workout.duration_min) && workout.duration_min > 0
    ? workout.duration_min
    : null;
  const counted = checked
    ? minutes != null
      ? `${Math.round(minutes)} min count toward your cardio goal`
      : "Add a duration to count minutes toward your cardio goal"
    : "Not counted toward your cardio goal";
  const reason = manual
    ? checked ? "Manually included" : "Manually excluded"
    : avgHr == null
      ? "Automatic · average heart rate unknown"
      : `Automatic · average heart rate ${avgHr > CARDIO_MIN_AVG_HR ? "above" : "at or below"} ${CARDIO_MIN_AVG_HR} bpm`;

  async function save(value: boolean | null) {
    setSaving(true);
    setError(null);
    try {
      await setWorkoutCardio(workout.id, value);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="info-row zone2-toggle"
        role="switch"
        aria-checked={checked}
        aria-label="Cardio"
        aria-describedby={`cardio-help-${workout.id}`}
        disabled={saving}
        onClick={() => void save(!checked)}
      >
        <span>
          <span className="zone2-toggle-label">Cardio</span>
          <span id={`cardio-help-${workout.id}`} className="small muted zone2-toggle-help">
            {saving ? "Saving…" : `${reason}. ${counted}.`}
          </span>
        </span>
        <span className={`zone2-switch${checked ? " zone2-switch-on" : ""}`} aria-hidden="true"><span /></span>
      </button>
      {manual && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 6 }}
          disabled={saving}
          onClick={() => void save(null)}
        >
          Use automatic rule
        </button>
      )}
      {error && <p className="error-text small" role="alert">{error}</p>}
    </div>
  );
}
