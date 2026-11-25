import { useState } from "react";
import { exportDatabase } from "../lib/exportDb";
import ThemeSetting from "../components/ThemeSetting";
import SettingsFolder from "../components/SettingsFolder";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Spec: SET-1
/** Settings → General: the theme, the database export and what the app is. */
export default function SettingsGeneralPage() {
  // Database export
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  async function runExport() {
    setExporting(true);
    setExportMsg(null);
    setExportErr(null);
    try {
      const res = await exportDatabase();
      setExportMsg(
        res.shared
          ? "Snapshot ready. Pick where to send it in the share sheet."
          : `Snapshot saved to ${res.path}`,
      );
    } catch (e) {
      setExportErr(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <SettingsFolder title="General">
      <ThemeSetting />

      <div className="card">
        <h2 className="card-title">Export database</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Saves a consistent snapshot of the raw SQLite database: every meal,
          workout, supplement, fast, and photo. Open it with
          any SQLite tool, or keep it as a backup.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            className="btn btn-primary"
            onClick={() => void runExport()}
            disabled={exporting}
          >
            Export database
          </button>
          {exporting && <div className="spinner" />}
        </div>
        {exportMsg && (
          <p
            className="muted small"
            style={{ margin: "8px 0 0", overflowWrap: "anywhere" }}
          >
            {exportMsg}
          </p>
        )}
        {exportErr && (
          <div className="error-text" style={{ marginTop: 8 }}>
            {exportErr}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">About</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Tally 0.1.0, a local-first fitness tracker. All your data lives in a
          SQLite database on this device; food photos never leave your phone
          except to the AI model you choose for analysis.
        </p>
      </div>
    </SettingsFolder>
  );
}
