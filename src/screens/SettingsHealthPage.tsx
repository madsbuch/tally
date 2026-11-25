import { useEffect, useRef, useState } from "react";
import { getSetting, listAllHealthMetrics, listAllSleepSessions, listSyncedWorkouts } from "../lib/db";
import { SETTING_KEYS } from "../lib/types";
import type { HealthMetric, SleepSession, Workout } from "../lib/types";
import {
  disconnectHealthConnect,
  getHealthConnectStatus,
  openHealthConnectSettings,
  requestHealthConnectPermissions,
  syncHealthConnect,
} from "../lib/healthConnect";
import type { HealthConnectStatus } from "../lib/healthConnect";
import { syncGarminIfStale } from "../lib/garmin";
import GarminConnectSettings from "../components/GarminConnectSettings";
import { confirmAction } from "../lib/confirm";
import SettingsFolder from "../components/SettingsFolder";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

function fmtDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Local calendar day of a UTC ISO timestamp, e.g. "Mon, Jul 20". */
function fmtDayIso(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(min: number | null): string | null {
  if (min == null || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function metricLine(m: HealthMetric): string {
  const parts: string[] = [];
  if (m.steps != null) parts.push(`${m.steps.toLocaleString()} steps`);
  if (m.calories_total != null) parts.push(`${Math.round(m.calories_total)} kcal`);
  if (m.resting_hr != null) parts.push(`RHR ${Math.round(m.resting_hr)}`);
  if (m.hrv_ms != null) parts.push(`HRV ${Math.round(m.hrv_ms)} ms`);
  if (m.spo2_pct != null) parts.push(`SpO2 ${Math.round(m.spo2_pct)}%`);
  if (m.weight_kg != null) parts.push(`${m.weight_kg.toFixed(1)} kg`);
  if (m.vo2_max != null) parts.push(`VO2 ${m.vo2_max.toFixed(1)}`);
  return parts.length > 0 ? parts.join(" · ") : "no values";
}

function sleepLine(s: SleepSession): string {
  const parts: string[] = [fmtDuration(s.duration_min) ?? "–"];
  if (s.deep_min != null) parts.push(`deep ${Math.round(s.deep_min)}m`);
  if (s.rem_min != null) parts.push(`REM ${Math.round(s.rem_min)}m`);
  if (s.light_min != null) parts.push(`light ${Math.round(s.light_min)}m`);
  if (s.awake_min != null) parts.push(`awake ${Math.round(s.awake_min)}m`);
  return parts.join(" · ");
}

function workoutLine(w: Workout): string {
  const parts: string[] = [];
  if (w.description) parts.push(w.description);
  if (w.calories_burned > 0) parts.push(`${w.calories_burned} kcal`);
  const dur = fmtDuration(w.duration_min);
  if (dur) parts.push(dur);
  return parts.join(" · ");
}

/** Everything Health Connect sync has written into the local database. */
interface HcData {
  workouts: Workout[];
  sleep: SleepSession[];
  metrics: HealthMetric[];
}

// Spec: SET-1
/** Settings → Health data: Health Connect and Garmin, read on the phone. */
export default function SettingsHealthPage() {
  const [loading, setLoading] = useState(true);

  // Garmin / Health Connect
  const [hcStatus, setHcStatus] = useState<HealthConnectStatus | null>(null);
  const [hcLastSync, setHcLastSync] = useState<string | null>(null);
  const [hcData, setHcData] = useState<HcData | null>(null);
  const [hcDataOpen, setHcDataOpen] = useState(false);
  const [hcDataBusy, setHcDataBusy] = useState(false);
  const [hcBusy, setHcBusy] = useState(false);
  const [hcMessage, setHcMessage] = useState<string | null>(null);
  const [hcError, setHcError] = useState<string | null>(null);

  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      try {
        setHcLastSync(await getSetting(SETTING_KEYS.healthConnectLastSyncAt));
        void getHealthConnectStatus().then(setHcStatus);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function runHcSync() {
    setHcBusy(true);
    setHcError(null);
    setHcMessage(null);
    try {
      const res = await syncHealthConnect();
      // A new workout: fetch its Garmin detail now, as the app start does.
      if (res.newWorkouts > 0) {
        void syncGarminIfStale(res).catch((e) => console.warn("Garmin Connect sync failed", e));
      }
      setHcStatus(res.status);
      const at = new Date().toISOString();
      setHcLastSync(at);
      const parts: string[] = [];
      if (res.workouts > 0) {
        parts.push(`${res.workouts} workout${res.workouts === 1 ? "" : "s"}`);
      }
      if (res.sleep > 0) {
        parts.push(`${res.sleep} night${res.sleep === 1 ? "" : "s"} of sleep`);
      }
      if (res.days > 0) {
        parts.push(`${res.days} day${res.days === 1 ? "" : "s"} of health metrics`);
      }
      setHcMessage(
        parts.length === 0
          ? "Up to date. Nothing new in the sync window."
          : `Synced ${parts.join(", ")}.`,
      );
    } catch (e) {
      setHcError(errorMessage(e));
    } finally {
      setHcBusy(false);
    }
    // Keep the open data view in step with what the sync just wrote.
    if (hcDataOpen) void loadHcData();
  }

  async function loadHcData() {
    setHcDataBusy(true);
    try {
      const [workouts, sleep, metrics] = await Promise.all([
        listSyncedWorkouts(),
        listAllSleepSessions(),
        listAllHealthMetrics(),
      ]);
      setHcData({ workouts, sleep, metrics });
    } catch (e) {
      setHcError(errorMessage(e));
    } finally {
      setHcDataBusy(false);
    }
  }

  function toggleHcData() {
    if (hcDataOpen) {
      setHcDataOpen(false);
      return;
    }
    setHcDataOpen(true);
    void loadHcData();
  }

  async function disconnectHc() {
    if (
      !(await confirmAction(
        "Disconnect Health Connect? Already-synced entries stay on this " +
          "device, and you can reconnect anytime. The permission sheet will " +
          "appear again, including “access data history”.",
        { confirmLabel: "Disconnect" },
      ))
    ) {
      return;
    }
    setHcBusy(true);
    setHcError(null);
    setHcMessage(null);
    try {
      await disconnectHealthConnect();
      const status = await getHealthConnectStatus();
      setHcStatus(status);
      setHcLastSync(null);
      setHcDataOpen(false);
      setHcData(null);
      setHcMessage(
        status.permissionsGranted
          ? "Disconnect requested. Restart the app if it still shows as connected."
          : "Disconnected. Tap “Connect Health Connect” to reconnect and grant history access.",
      );
    } catch (e) {
      setHcError(errorMessage(e));
    } finally {
      setHcBusy(false);
    }
  }

  async function connectHc() {
    setHcBusy(true);
    setHcError(null);
    setHcMessage(null);
    try {
      const granted = await requestHealthConnectPermissions();
      const status = await getHealthConnectStatus();
      setHcStatus(status);
      if (granted) {
        await runHcSync();
      } else {
        setHcError(
          "Permissions weren't granted. If no dialog appeared, grant Tally access " +
            "manually in the Health Connect app (App permissions → Tally).",
        );
      }
    } catch (e) {
      setHcError(errorMessage(e));
    } finally {
      setHcBusy(false);
    }
  }

  if (loading) {
    return (
      <SettingsFolder title="Health data">
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      </SettingsFolder>
    );
  }

  return (
    <SettingsFolder title="Health data">
      {!navigator.userAgent.includes("Android") ? (
        <div className="card">
          <p className="muted small" style={{ margin: 0 }}>
            Watch data is read on the phone (Health Connect and Garmin
            Connect) and arrives here through Sync & backup.
          </p>
        </div>
      ) : (
      <>
      <div className="card">
        <h2 className="card-title">Garmin watch sync</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Pulls workouts, sleep, steps, resting heart rate, HRV, blood oxygen,
          weight, and VO2 max that Garmin Connect writes into Android Health
          Connect. Enable “Health Connect” in the Garmin Connect app first,
          then connect Tally here. Everything stays on this device.
        </p>
        {hcStatus === null ? (
          <div className="spinner" />
        ) : hcStatus.availability === "unavailable" ? (
          <p className="muted small" style={{ margin: 0 }}>
            Health Connect isn’t available here. It needs an Android phone
            with the Health Connect app (built into Android 14+).
          </p>
        ) : hcStatus.availability === "updateRequired" ? (
          <p className="muted small" style={{ margin: 0 }}>
            The Health Connect app needs an update before Tally can read from
            it. Update it in the Play Store, then come back.
          </p>
        ) : !hcStatus.permissionsGranted ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              className="btn btn-primary"
              onClick={() => void connectHc()}
              disabled={hcBusy}
            >
              Connect Health Connect
            </button>
            {hcBusy && <div className="spinner" />}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="chip chip-accent">✓ Connected</span>
              <button
                className="btn btn-sm"
                onClick={() => void runHcSync()}
                disabled={hcBusy}
              >
                Sync now
              </button>
              {hcBusy && <div className="spinner" />}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void openHealthConnectSettings().catch(() => {})}
              >
                Open Health Connect
              </button>
              <button className="btn btn-ghost btn-sm" onClick={toggleHcData}>
                {hcDataOpen ? "Hide synced data" : "View synced data"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void disconnectHc()}
                disabled={hcBusy}
              >
                Disconnect
              </button>
            </div>
            {!hcStatus.historyGranted && (
              <div style={{ marginTop: 10 }}>
                <p className="muted small" style={{ margin: "0 0 8px" }}>
                  Android currently limits Tally to recent data. Grant “access
                  data history” to backfill everything already in Health
                  Connect (up to a year). If no permission sheet appears, tap
                  Disconnect above and connect again.
                </p>
                <button
                  className="btn btn-sm"
                  onClick={() => void connectHc()}
                  disabled={hcBusy}
                >
                  Allow history access
                </button>
              </div>
            )}
            <p className="faint small" style={{ margin: "10px 0 0" }}>
              Everything syncs automatically when the app opens
              {hcLastSync ? ` · last sync ${relativeTime(hcLastSync)}` : ""}.
              Synced entries are matched by their Health Connect id, so
              re-syncing never duplicates. Health Connect only holds data from
              after you enabled the Garmin&nbsp;Connect → Health&nbsp;Connect
              link. Older activity stays in Garmin and can’t be pulled from
              here.
            </p>
            {hcDataOpen && (
              <div style={{ marginTop: 12 }}>
                {hcDataBusy && !hcData ? (
                  <div className="spinner" />
                ) : hcData == null ? null : hcData.workouts.length === 0 &&
                  hcData.sleep.length === 0 &&
                  hcData.metrics.length === 0 ? (
                  <p className="muted small" style={{ margin: 0 }}>
                    Nothing synced yet. Tap “Sync now” above.
                  </p>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    <details>
                      <summary className="small" style={{ cursor: "pointer", fontWeight: 600 }}>
                        Daily metrics · {hcData.metrics.length}{" "}
                        {hcData.metrics.length === 1 ? "day" : "days"}
                      </summary>
                      <div
                        className="muted small"
                        style={{
                          marginTop: 6,
                          display: "grid",
                          gap: 4,
                          maxHeight: 260,
                          overflowY: "auto",
                        }}
                      >
                        {hcData.metrics.map((m) => (
                          <div key={m.day}>
                            <strong>{fmtDay(m.day)}</strong>: {metricLine(m)}
                          </div>
                        ))}
                      </div>
                    </details>
                    <details>
                      <summary className="small" style={{ cursor: "pointer", fontWeight: 600 }}>
                        Sleep · {hcData.sleep.length}{" "}
                        {hcData.sleep.length === 1 ? "night" : "nights"}
                      </summary>
                      <div
                        className="muted small"
                        style={{
                          marginTop: 6,
                          display: "grid",
                          gap: 4,
                          maxHeight: 260,
                          overflowY: "auto",
                        }}
                      >
                        {hcData.sleep.map((s) => (
                          <div key={s.external_id}>
                            <strong>{fmtDayIso(s.ended_at)}</strong>: {sleepLine(s)}
                          </div>
                        ))}
                      </div>
                    </details>
                    <details>
                      <summary className="small" style={{ cursor: "pointer", fontWeight: 600 }}>
                        Workouts · {hcData.workouts.length}
                      </summary>
                      <div
                        className="muted small"
                        style={{
                          marginTop: 6,
                          display: "grid",
                          gap: 4,
                          maxHeight: 260,
                          overflowY: "auto",
                        }}
                      >
                        {hcData.workouts.map((w) => (
                          <div key={w.id}>
                            <strong>{fmtDateTime(w.performed_at)}</strong>: {w.title}
                            {workoutLine(w) ? ` · ${workoutLine(w)}` : ""}
                            {w.source ? ` (${w.source})` : ""}
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {hcMessage && (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {hcMessage}
          </p>
        )}
        {hcError && (
          <div className="error-text" style={{ marginTop: 8 }}>
            {hcError}
          </div>
        )}
      </div>

      <GarminConnectSettings />
      </>
      )}
    </SettingsFolder>
  );
}
