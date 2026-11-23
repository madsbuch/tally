package com.madsbuch.tally.syncbg

import android.app.Activity
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.util.concurrent.TimeUnit

@InvokeArg
class ScheduleArgs {
    var dbPath: String = ""
}

/**
 * Schedules the periodic background sync. WorkManager keeps the schedule
 * across reboots and app updates, runs it only on unmetered networks (home
 * Wi-Fi, where the computer is), and spaces it out under Doze as it sees fit.
 */
@TauriPlugin
class SyncBackgroundPlugin(private val activity: Activity) : Plugin(activity) {

    // Spec: tandem.SYN-17
    @Command
    fun schedule(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleArgs::class.java)
        if (args.dbPath.isBlank()) {
            invoke.reject("dbPath is required")
            return
        }
        val request = PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build(),
            )
            .setInputData(workDataOf(SyncWorker.KEY_DB_PATH to args.dbPath))
            .build()
        WorkManager.getInstance(activity.applicationContext).enqueueUniquePeriodicWork(
            SyncWorker.NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            request,
        )
        invoke.resolve()
    }

    @Command
    fun cancel(invoke: Invoke) {
        WorkManager.getInstance(activity.applicationContext).cancelUniqueWork(SyncWorker.NAME)
        invoke.resolve()
    }
}
