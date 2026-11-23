//! Background sync on Android: a periodic WorkManager job, on unmetered
//! networks, that wakes the app's Rust sync (`tally_lib`'s JNI entry point
//! `SyncNative.syncNow`) while the app is closed. Elsewhere it does nothing —
//! the computer syncs while the app runs.
//!
//! It also holds the Wi-Fi multicast lock while the app runs, without which
//! Android drops the mDNS announcements sync finds devices by.
//!
//! Like the coach plugin, this only schedules: Tauri's bridge runs Rust →
//! Kotlin, and the work itself goes back into Rust through JNI.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
pub use error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleArgs {
    /// Absolute path of the app's SQLite file.
    pub db_path: String,
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use serde::de::DeserializeOwned;
    use tauri::plugin::{PluginApi, PluginHandle};
    use tauri::AppHandle;

    pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, api: PluginApi<R, C>) -> Result<SyncBackground<R>> {
        let handle = api.register_android_plugin("com.madsbuch.tally.syncbg", "SyncBackgroundPlugin")?;
        Ok(SyncBackground(handle))
    }

    pub struct SyncBackground<R: Runtime>(PluginHandle<R>);

    impl<R: Runtime> SyncBackground<R> {
        pub fn schedule(&self, args: ScheduleArgs) -> Result<()> {
            self.0.run_mobile_plugin::<serde_json::Value>("schedule", args)?;
            Ok(())
        }
        pub fn cancel(&self) -> Result<()> {
            self.0.run_mobile_plugin::<serde_json::Value>("cancel", ())?;
            Ok(())
        }
        /// Takes a Wi-Fi multicast lock for as long as the app runs, so
        /// mDNS announcements reach it.
        pub fn hold_multicast_lock(&self) -> Result<()> {
            self.0.run_mobile_plugin::<serde_json::Value>("holdMulticastLock", ())?;
            Ok(())
        }
    }
}

#[cfg(not(target_os = "android"))]
mod noop {
    use super::*;
    use serde::de::DeserializeOwned;
    use tauri::plugin::PluginApi;
    use tauri::AppHandle;

    pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, _api: PluginApi<R, C>) -> Result<SyncBackground<R>> {
        Ok(SyncBackground(std::marker::PhantomData))
    }

    pub struct SyncBackground<R: Runtime>(std::marker::PhantomData<fn() -> R>);

    impl<R: Runtime> SyncBackground<R> {
        pub fn schedule(&self, _args: ScheduleArgs) -> Result<()> {
            Ok(())
        }
        pub fn cancel(&self) -> Result<()> {
            Ok(())
        }
        pub fn hold_multicast_lock(&self) -> Result<()> {
            Ok(())
        }
    }
}

#[cfg(target_os = "android")]
pub use android::SyncBackground;
#[cfg(not(target_os = "android"))]
pub use noop::SyncBackground;

pub trait SyncBackgroundExt<R: Runtime> {
    fn sync_background(&self) -> &SyncBackground<R>;
}

impl<R: Runtime, T: Manager<R>> SyncBackgroundExt<R> for T {
    fn sync_background(&self) -> &SyncBackground<R> {
        self.state::<SyncBackground<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sync-background")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let s = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let s = noop::init(app, api)?;
            app.manage(s);
            Ok(())
        })
        .build()
}
