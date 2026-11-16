import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { backupLine, backupState, getSyncStatus, onSyncStatus } from "../lib/sync";

/** Settings' way into Sync & backup, with how the backup stands. */
export default function SyncLink() {
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getSyncStatus()
        .then((s) => {
          if (alive) setLine(backupLine(backupState(s)));
        })
        .catch(() => {});
    void load();
    const off = onSyncStatus(load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <Link to="/settings/sync" className="list-row" style={{ color: "inherit", textDecoration: "none", marginBottom: 12 }}>
      <div className="row-main">
        <div className="row-title">Sync & backup</div>
        <div className="row-sub">{line ?? "Keep a copy on your computer"}</div>
      </div>
      <div className="row-end faint">›</div>
    </Link>
  );
}
