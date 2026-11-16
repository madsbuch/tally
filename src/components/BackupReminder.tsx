import { useEffect, useState } from "react";
import { useGo } from "../lib/navigation";
import { ago, backupState, getSyncStatus, isAndroid, onSyncStatus } from "../lib/sync";

/**
 * On the phone, a word when the last complete backup to another device is
 * more than a few days old — the backup is only as fresh as the last time
 * both were on the same network. Nothing when there's no vault yet.
 */
export default function BackupReminder() {
  const go = useGo();
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!isAndroid()) return;
    let alive = true;
    const load = () =>
      getSyncStatus()
        .then((s) => {
          const st = backupState(s);
          if (!alive) return;
          setText(
            st.kind === "stale" && st.completeAt
              ? `Last backed up to ${st.peer} ${ago(st.completeAt)}. Open Tally on the same Wi-Fi to catch up.`
              : null,
          );
        })
        .catch(() => {});
    void load();
    const off = onSyncStatus(load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!text) return null;
  return (
    <button
      className="card"
      onClick={() => go("/settings/sync")}
      style={{ display: "block", width: "100%", textAlign: "left", cursor: "pointer" }}
    >
      <span className="small">{text}</span>
    </button>
  );
}
