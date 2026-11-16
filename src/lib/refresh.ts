// ---------------------------------------------------------------------------
// Pull to refresh: everything new, now, rather than on the syncs' own
// schedules. On the phone that's Health Connect first (the event bus — it has
// the watch's latest), then Garmin's own numbers for what it brought (the ones
// the diary shows, see lib/garminDb.ts), then the vault's other devices, so
// what just came in reaches them too. On the computer, only the last. Every
// screen reads again at the end.
// ---------------------------------------------------------------------------

import { syncHealthConnect } from "./healthConnect";
import { syncGarmin } from "./garmin";
import { syncDevicesNow } from "./sync";
import { notifyTablesChanged } from "./live";

/** Refresh from every source there is here. Never throws. */
export async function refreshEverything(): Promise<void> {
  try {
    // Health Connect and Garmin imports are the phone's (see CLAUDE.md).
    if (navigator.userAgent.includes("Android")) {
      const hc = await syncHealthConnect().catch((e) => {
        console.warn("Health Connect sync failed", e);
        return null;
      });
      await syncGarmin({ pulled: true, newWorkout: (hc?.newWorkouts ?? 0) > 0 }).catch((e) =>
        console.warn("Garmin Connect sync failed", e),
      );
    }
    await syncDevicesNow().catch((e) => console.warn("Syncing with other devices failed", e));
  } finally {
    notifyTablesChanged("all");
  }
}
