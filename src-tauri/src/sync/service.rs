//! Sync as the app runs it: listening for the vault's other devices,
//! answering discovery, syncing soon after every change (and every minute
//! regardless), the computer's daily snapshots, and the commands the Sync
//! page calls. Events tell the frontend when data arrived (`sync-changed`)
//! and when the status moved (`sync-status`).

use super::discovery;
use super::engine;
use super::session::{self, Outcome, PairingOffer, PairingSlot};
use serde::Serialize;
use sqlx::SqlitePool;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Notify, OnceCell};

/// Syncs at least this often while the app runs, changes or not.
const IDLE_ROUND: Duration = Duration::from_secs(60);
/// After a local change, wait this long for more before syncing.
const DEBOUNCE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub syncing: bool,
    pub last_error: Option<String>,
    pub last_round_at: Option<String>,
}

#[derive(Default)]
pub struct SyncService {
    pool: OnceCell<SqlitePool>,
    slot: PairingSlot,
    port: AtomicU16,
    started: AtomicBool,
    kick: Notify,
    activity: Mutex<Activity>,
    /// (vault tag, device id) for answering discovery without the database.
    discovery_state: Arc<Mutex<Option<(String, String)>>>,
}

use super::now_iso;

impl SyncService {
    fn set_activity(&self, app: &AppHandle, f: impl FnOnce(&mut Activity)) {
        let snapshot = {
            let mut a = self.activity.lock().expect("activity lock");
            f(&mut a);
            a.clone()
        };
        let _ = app.emit("sync-status", snapshot);
    }

    pub fn pool(&self) -> Result<&SqlitePool, String> {
        self.pool.get().ok_or_else(|| "sync hasn't started".into())
    }

    fn announce(&self, app: &AppHandle, outcome: &Outcome) {
        if outcome.received.changed_anything() {
            let _ = app.emit("sync-changed", outcome.received);
        }
    }

    /// Starts listening and the sync loop, once. `pool` is the app's own.
    pub async fn start(self: &Arc<Self>, app: AppHandle, pool: SqlitePool) -> Result<(), String> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _ = self.pool.set(pool.clone());
        session::identity(&pool).await?;

        // Incoming connections.
        let (svc, app2) = (self.clone(), app.clone());
        let (port, _) = session::listen(pool.clone(), self.slot.clone(), "0.0.0.0", move |r| match r {
            Ok(outcome) => {
                svc.announce(&app2, &outcome);
                svc.set_activity(&app2, |a| {
                    a.last_error = None;
                    a.last_round_at = Some(now_iso());
                });
            }
            Err(e) if e == "busy" => {}
            Err(e) => {
                eprintln!("sync: incoming connection failed: {e}");
            }
        })
        .await?;
        self.port.store(port, Ordering::SeqCst);

        // Discovery answers.
        if let Ok(socket) = discovery::bind_responder(discovery::PORT).await {
            let state = self.discovery_state.clone();
            tokio::spawn(discovery::respond(socket, move || {
                state.lock().ok()?.clone().map(|(tag, id)| (tag, id, port))
            }));
        }

        // The loop: soon after a change, and every minute anyway.
        let svc = self.clone();
        let app3 = app.clone();
        let loop_pool = pool.clone();
        tokio::spawn(async move {
            let pool = loop_pool;
            let mut last_seq = -1i64;
            let mut last_round = std::time::Instant::now() - IDLE_ROUND;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(DEBOUNCE) => {}
                    _ = svc.kick.notified() => { last_seq = -1; }
                }
                let Ok(state) = engine::local_state(&pool).await else { continue };
                if let (Some(vault), Ok(mut d)) = (&state.vault_id, svc.discovery_state.lock()) {
                    *d = Some((session::vault_tag(vault), state.device_id.clone()));
                }
                if state.vault_id.is_none() {
                    continue;
                }
                if state.seq == last_seq && last_round.elapsed() < IDLE_ROUND {
                    continue;
                }
                last_round = std::time::Instant::now();
                svc.round(&app3, &pool).await;
                // Our own sync bumps seq (applied rows): re-read so that alone
                // doesn't trigger another round.
                last_seq = engine::local_state(&pool).await.map(|s| s.seq).unwrap_or(-1);
            }
        });

        // The computer keeps daily snapshots.
        if cfg!(not(any(target_os = "android", target_os = "ios"))) {
            if let Ok(dir) = app.path().app_data_dir() {
                let pool = pool.clone();
                tokio::spawn(async move {
                    loop {
                        if let Err(e) = super::snapshots::run(&pool, &dir.join("snapshots"), &today()).await {
                            eprintln!("sync: snapshot failed: {e}");
                        }
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                    }
                });
            }
        }
        Ok(())
    }

    /// Finds the vault's devices on the network and syncs with each.
    async fn round(&self, app: &AppHandle, pool: &SqlitePool) {
        self.set_activity(app, |a| a.syncing = true);
        let result = sync_round(pool).await;
        for o in result.outcomes.iter() {
            self.announce(app, o);
        }
        self.set_activity(app, |a| {
            a.syncing = false;
            a.last_round_at = Some(now_iso());
            a.last_error = result.errors.first().cloned();
        });
    }

    pub fn kick(&self) {
        self.kick.notify_one();
    }

    pub fn activity(&self) -> Activity {
        self.activity.lock().map(|a| a.clone()).unwrap_or_default()
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    pub async fn offer(&self) -> Result<String, String> {
        let pool = self.pool()?;
        let port = self.port();
        if port == 0 {
            return Err("sync isn't listening yet".into());
        }
        let addrs = session::local_addrs(port);
        if addrs.is_empty() {
            return Err("this device isn't on a local network".into());
        }
        let offer = session::offer(pool, &self.slot, addrs).await?;
        self.kick();
        Ok(offer.encode())
    }

    pub fn cancel_offer(&self) {
        if let Ok(mut s) = self.slot.lock() {
            *s = None;
        }
    }

    pub fn offer_active(&self) -> bool {
        self.slot
            .lock()
            .map(|s| s.as_ref().is_some_and(|p| p.expires > std::time::Instant::now()))
            .unwrap_or(false)
    }

    pub async fn join(&self, app: &AppHandle, code: &str) -> Result<Outcome, String> {
        let pool = self.pool()?;
        let offer = PairingOffer::decode(code)?;
        self.set_activity(app, |a| a.syncing = true);
        let result = session::join(pool, &offer).await;
        self.set_activity(app, |a| {
            a.syncing = false;
            a.last_error = result.as_ref().err().cloned();
            a.last_round_at = Some(now_iso());
        });
        if let Ok(o) = &result {
            // Everything changed: the frontend reloads whatever it shows.
            let _ = app.emit("sync-changed", o.received);
        }
        result
    }
}

/// What one round found.
pub struct Round {
    pub outcomes: Vec<Outcome>,
    pub errors: Vec<String>,
}

/// One round: probe for the vault's devices, then sync with each one found —
/// and with any known one that didn't answer, at the address it was last
/// reached at (a network that drops broadcasts still reaches it).
pub async fn sync_round(pool: &SqlitePool) -> Round {
    let mut round = Round { outcomes: vec![], errors: vec![] };
    let Ok(me) = session::identity(pool).await else { return round };
    let Some(vault) = me.vault_id.clone() else { return round };
    let peers: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT d.id, p.last_addr FROM vault_devices d LEFT JOIN sync_peers p ON p.device_id = d.id
         WHERE d.id <> ? AND d.public_key NOT IN (SELECT public_key FROM vault_revocations)",
    )
    .bind(&me.device_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if peers.is_empty() {
        return round;
    }
    let last: Vec<String> = peers.iter().filter_map(|(_, a)| a.clone()).collect();
    let found = discovery::probe(
        &session::vault_tag(&vault),
        &me.device_id,
        &discovery::targets(&last, discovery::PORT),
        Duration::from_millis(800),
    )
    .await;
    for (id, last_addr) in &peers {
        // Where discovery says it is, then where it was last reached: an
        // answer to a probe isn't proof of anything (anyone on the network
        // can send one), so a failed attempt there doesn't end the search.
        let mut addrs: Vec<SocketAddr> = found.iter().filter(|f| &f.device_id == id).map(|f| f.addr).collect();
        if let Some(a) = last_addr.as_ref().and_then(|a| a.parse().ok()) {
            if !addrs.contains(&a) {
                addrs.push(a);
            }
        }
        let mut last_err = None;
        for addr in addrs {
            match session::sync_with(pool, addr).await {
                Ok(Some(o)) => {
                    round.outcomes.push(o);
                    last_err = None;
                    break;
                }
                Ok(None) => {
                    last_err = None;
                    break;
                }
                Err(e) => last_err = Some(e),
            }
        }
        match last_err {
            // Not around is normal; anything else is worth showing.
            Some(e) if e.contains("no answer") || e.contains("refused") || e.contains("unreachable") => {}
            Some(e) => round.errors.push(e),
            None => {}
        }
    }
    round
}

/// Today's date (UTC), "YYYY-MM-DD".
pub fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 / 86_400)
        .unwrap_or(0);
    super::civil_date(days)
}

// ---------------------------------------------------------------------------
// What the Sync page shows
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub is_self: bool,
    pub last_sync_at: Option<String>,
    pub last_complete_at: Option<String>,
    pub complete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub in_vault: bool,
    pub devices: Vec<DeviceStatus>,
    /// True when this device holds none of the person's data, so it may join.
    pub can_join: bool,
    pub offer_active: bool,
    #[serde(flatten)]
    pub activity: Activity,
}

pub async fn status(pool: &SqlitePool, svc: &SyncService) -> Result<Status, String> {
    let me = session::identity(pool).await?;
    let rows: Vec<(String, String, String, Option<String>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT d.id, d.name, d.platform, p.last_sync_at, p.last_complete_at, p.complete
         FROM vault_devices d LEFT JOIN sync_peers p ON p.device_id = d.id
         WHERE d.public_key NOT IN (SELECT public_key FROM vault_revocations)
         ORDER BY d.added_at",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let devices = rows
        .into_iter()
        .map(|(id, name, platform, last_sync_at, last_complete_at, complete)| DeviceStatus {
            is_self: id == me.device_id,
            id,
            name,
            platform,
            last_sync_at,
            last_complete_at,
            complete: complete == Some(1),
        })
        .collect();
    Ok(Status {
        device_id: me.device_id,
        name: me.name,
        platform: me.platform,
        in_vault: me.vault_id.is_some(),
        devices,
        can_join: engine::data_tables(pool).await?.is_empty(),
        offer_active: svc.offer_active(),
        activity: svc.activity(),
    })
}

pub async fn set_name(pool: &SqlitePool, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err("a name of 1–60 characters".into());
    }
    sqlx::query(
        "INSERT INTO device_settings (key, value) VALUES ('sync_device_name', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(name)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    let me = session::identity(pool).await?;
    sqlx::query("UPDATE vault_devices SET name = ? WHERE id = ?")
        .bind(name)
        .bind(&me.device_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Takes a device out of the vault: its key goes on the revocation list,
/// which only ever grows, so it's refused from then on everywhere the list
/// reaches — whatever later edits say about its entry. Its data stays where
/// it is.
pub async fn remove_device(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let me = session::identity(pool).await?;
    if id == me.device_id {
        return Err("a device can't remove itself".into());
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO vault_revocations (public_key, device_id, revoked_at)
         SELECT public_key, id, ? FROM vault_devices WHERE id = ?
         ON CONFLICT (public_key) DO NOTHING",
    )
    .bind(super::now_iso())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM vault_devices WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}
