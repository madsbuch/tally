//! Sync as the app runs it: listening for the vault's other devices,
//! answering discovery, syncing soon after every change (and every minute
//! regardless), the computer's daily snapshots, and the commands the Sync
//! page calls. Events tell the frontend when data arrived (`sync-changed`)
//! and when the status moved (`sync-status`).

use super::discovery;
use super::engine;
use super::mdns::{self, Mdns};
use super::reach::{self, Problem, Why};
use super::session::{self, Missed, Outcome, PairingOffer, PairingSlot};
use serde::Serialize;
use sqlx::SqlitePool;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Notify, OnceCell};

/// Syncs at least this often while the app runs, changes or not. The
/// computer asks often: the phone's own pushes may not reach it (a Mac
/// firewall turns away incoming connections to an unsigned app), so its
/// asking is what brings the phone's changes over. Idle syncs are cheap (no
/// full comparison when nothing moved). The phone asks less, for the battery.
const IDLE_ROUND: Duration = if cfg!(any(target_os = "android", target_os = "ios")) {
    Duration::from_secs(60)
} else {
    Duration::from_secs(10)
};
/// After a local change, wait this long for more before syncing.
const DEBOUNCE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub syncing: bool,
    pub last_error: Option<String>,
    pub last_round_at: Option<String>,
    /// The vault's devices the last round couldn't reach, and why.
    pub unreached: Vec<Unreached>,
    /// Why the last join couldn't reach the device that showed the code.
    pub join_problem: Option<Problem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unreached {
    pub device_id: String,
    pub problem: Problem,
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
    /// Announcing and listening over mDNS, where the network allows it.
    mdns: OnceCell<Option<Arc<Mdns>>>,
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

        // Discovery: mDNS beside the broadcast answers.
        let _ = self.mdns.set(Mdns::start());
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
                    if let Some(m) = svc.mdns() {
                        m.announce_device(&session::vault_tag(vault), &state.device_id, port);
                    }
                }
                if !svc.offer_active() {
                    if let Some(m) = svc.mdns() {
                        m.stop_pairing();
                    }
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
    fn mdns(&self) -> Option<&Mdns> {
        self.mdns.get().and_then(|m| m.as_deref())
    }

    async fn round(&self, app: &AppHandle, pool: &SqlitePool) {
        self.set_activity(app, |a| a.syncing = true);
        let result = sync_round(pool, self.mdns()).await;
        for o in result.outcomes.iter() {
            self.announce(app, o);
        }
        self.set_activity(app, |a| {
            a.syncing = false;
            a.last_round_at = Some(now_iso());
            a.last_error = result.errors.first().cloned();
            a.unreached = result.unreached.iter().map(|(id, p)| Unreached { device_id: id.clone(), problem: p.clone() }).collect();
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
        if let Some(m) = self.mdns() {
            m.announce_pairing(&session::pairing_tag(&offer.token), &offer.host_id, port);
        }
        self.kick();
        Ok(offer.encode())
    }

    pub fn cancel_offer(&self) {
        if let Ok(mut s) = self.slot.lock() {
            *s = None;
        }
        if let Some(m) = self.mdns() {
            m.stop_pairing();
        }
    }

    pub fn offer_active(&self) -> bool {
        self.slot
            .lock()
            .map(|s| s.as_ref().is_some_and(|p| p.expires > std::time::Instant::now()))
            .unwrap_or(false)
    }

    // Spec: tandem.SYN-22
    /// Joins the vault behind `code`. With `replace`, a device that already
    /// holds data joins too: a complete copy of its database is saved in the
    /// app's `backups` folder first, and its path returned.
    pub async fn join(&self, app: &AppHandle, code: &str, replace: bool) -> Result<JoinResult, String> {
        let pool = self.pool()?;
        let offer = PairingOffer::decode(code)?;
        let backup = if replace && !engine::data_tables(pool).await?.is_empty() {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
            Some(backup_before_join(pool, &dir).await?.to_string_lossy().into_owned())
        } else {
            None
        };
        remember_join(pool, &offer).await;
        let nearby = self.nearby(&offer).await;
        self.set_activity(app, |a| a.syncing = true);
        let result = session::join_any(pool, &offer, &nearby, replace).await;
        let problem = match &result {
            Err(Missed::Unreached(fails)) => Some(diagnose(&offer.host_name, fails).await),
            _ => None,
        };
        let result = result.map_err(|e| match (&e, &problem) {
            (_, Some(p)) => format!("Couldn't reach {}. {}", offer.host_name, p.message),
            (Missed::Failed(e), None) => e.clone(),
            (e, None) => e.to_string(),
        });
        self.set_activity(app, |a| {
            a.syncing = false;
            a.last_error = result.as_ref().err().cloned();
            a.last_round_at = Some(now_iso());
            a.join_problem = problem;
        });
        if let Ok(o) = &result {
            // Everything changed: the frontend reloads whatever it shows.
            let _ = app.emit("sync-changed", o.received);
        }
        result.map(|outcome| JoinResult { outcome, backup })
    }

    /// Where the device showing the code answers to its tag nearby: heard
    /// already, or within a moment.
    async fn nearby(&self, offer: &PairingOffer) -> Vec<SocketAddr> {
        let Some(m) = self.mdns() else { return vec![] };
        let tag = session::pairing_tag(&offer.token);
        for _ in 0..6 {
            let found = m.pairing(&tag);
            if !found.is_empty() {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        vec![]
    }

    // Spec: tandem.SYN-23
    /// Checks the connection: this device's addresses, whether sync listens,
    /// which of the vault's devices answer the search, and whether each one
    /// there's an address for can be reached — the vault's, and the one
    /// whose code was last joined — then what stands in the way.
    pub async fn check(&self) -> Result<ConnectionCheck, String> {
        let pool = self.pool()?;
        let nets = reach::local_nets();
        let addresses: Vec<String> = nets
            .iter()
            .filter(|n| !matches!(n.ip, std::net::IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80))
            .map(|n| format!("{} ({})", n.ip, n.iface))
            .collect();
        let port = self.port();
        let listening = port != 0
            && tokio::time::timeout(
                Duration::from_secs(1),
                tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)),
            )
            .await
            .is_ok_and(|r| r.is_ok());

        let me = session::identity(pool).await?;
        let peers = vault_peers(pool, &me.device_id).await;
        let (found, heard) = match &me.vault_id {
            Some(vault) if !peers.is_empty() => {
                let tag = session::vault_tag(vault);
                let last: Vec<String> = peers.iter().filter_map(|p| p.last_addr.clone()).collect();
                let found = discovery::probe(&tag, &me.device_id, &discovery::targets(&last, discovery::PORT), Duration::from_millis(800)).await;
                let heard = self.mdns().map(|m| m.devices(&tag)).unwrap_or_default();
                (found, heard)
            }
            _ => (vec![], vec![]),
        };

        let mut answered = Vec::new();
        let mut devices = Vec::new();
        for p in &peers {
            let by_broadcast: Vec<SocketAddr> = found.iter().filter(|f| f.device_id == p.id).map(|f| f.addr).collect();
            let by_mdns: Vec<SocketAddr> = heard.iter().filter(|(id, _)| *id == p.id).flat_map(|(_, a)| a.clone()).collect();
            let mut via = Vec::new();
            if !by_mdns.is_empty() {
                via.push("mDNS".to_string());
            }
            if !by_broadcast.is_empty() {
                via.push("broadcast".to_string());
            }
            if !via.is_empty() {
                answered.push(Answered { device_id: p.id.clone(), name: p.name.clone(), via });
            }
            let last: Vec<SocketAddr> = p.last_addr.iter().filter_map(|a| a.parse().ok()).collect();
            let addrs = mdns::merge(&[&by_mdns, &by_broadcast, &last]);
            devices.push(reachability(Some(p.id.clone()), &p.name, false, &addrs).await);
        }
        if let Some((host_id, name, addrs)) = last_join(pool).await {
            if !peers.iter().any(|p| p.id == host_id) {
                let nearby: Vec<SocketAddr> = self
                    .mdns()
                    .map(|m| m.device_addrs(&host_id))
                    .unwrap_or_default();
                let addrs = mdns::merge(&[&addrs, &nearby]);
                devices.push(reachability(None, &name, true, &addrs).await);
            }
        }

        let mut problems: Vec<Problem> = Vec::new();
        if addresses.is_empty() {
            problems.push(reach::problem("", Why::Offline, false));
        }
        if !listening {
            problems.push(reach::problem("", Why::NotListening, false));
        }
        if !addresses.is_empty() && reach::held_off(&nets, discovery::PORT).await {
            problems.push(reach::problem("", Why::Blocked, false));
        }
        for p in devices.iter().filter_map(|d| d.problem.clone()) {
            if !problems.iter().any(|q| q.message == p.message) {
                problems.push(p);
            }
        }
        Ok(ConnectionCheck { addresses, listening, port, in_vault: me.vault_id.is_some(), answered, devices, problems })
    }
}

/// The result of checking the connection (the Sync page shows it).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCheck {
    pub addresses: Vec<String>,
    pub listening: bool,
    pub port: u16,
    pub in_vault: bool,
    pub answered: Vec<Answered>,
    pub devices: Vec<Reachability>,
    pub problems: Vec<Problem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answered {
    pub device_id: String,
    pub name: String,
    /// How it answered: "mDNS", "broadcast".
    pub via: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reachability {
    /// None for the device whose code was last joined, when it isn't (yet)
    /// one of the vault's.
    pub device_id: Option<String>,
    pub name: String,
    pub joined_code: bool,
    pub addrs: Vec<String>,
    pub reached_at: Option<String>,
    pub problem: Option<Problem>,
}

async fn reachability(device_id: Option<String>, name: &str, joined_code: bool, addrs: &[SocketAddr]) -> Reachability {
    let (reached_at, problem) = if addrs.is_empty() {
        (None, Some(reach::problem(name, Why::NoAddress, false)))
    } else {
        match reach::connect_first(addrs).await {
            Ok((_, at)) => (Some(at.to_string()), None),
            Err(fails) => (None, Some(diagnose(name, &fails).await)),
        }
    };
    Reachability {
        device_id,
        name: name.to_string(),
        joined_code,
        addrs: addrs.iter().map(|a| a.to_string()).collect(),
        reached_at,
        problem,
    }
}

// Spec: tandem.SYN-24
/// Why `name` couldn't be reached, on this device's networks.
pub async fn diagnose(name: &str, fails: &[(SocketAddr, reach::Failure)]) -> Problem {
    let nets = reach::local_nets();
    let held_off = reach::held_off(&nets, discovery::PORT).await;
    reach::diagnose(name, fails, &nets, held_off)
}

/// The device whose code was last joined, kept so the connection check can
/// try it again: (its device id, name, the addresses the code held).
async fn remember_join(pool: &SqlitePool, offer: &PairingOffer) {
    let value = serde_json::json!({ "id": offer.host_id, "name": offer.host_name, "addrs": offer.addrs }).to_string();
    let _ = sqlx::query(
        "INSERT INTO device_settings (key, value) VALUES ('sync_last_join', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(value)
    .execute(pool)
    .await;
}

async fn last_join(pool: &SqlitePool) -> Option<(String, String, Vec<SocketAddr>)> {
    let (raw,): (String,) = sqlx::query_as("SELECT value FROM device_settings WHERE key = 'sync_last_join'")
        .fetch_optional(pool)
        .await
        .ok()??;
    #[derive(serde::Deserialize)]
    struct Joined {
        id: String,
        name: String,
        addrs: Vec<String>,
    }
    let j: Joined = serde_json::from_str(&raw).ok()?;
    Some((j.id, j.name, j.addrs.iter().filter_map(|a| a.parse().ok()).collect()))
}

struct Peer {
    id: String,
    name: String,
    last_addr: Option<String>,
}

/// The vault's other devices that haven't been removed.
async fn vault_peers(pool: &SqlitePool, me: &str) -> Vec<Peer> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT d.id, d.name, p.last_addr FROM vault_devices d LEFT JOIN sync_peers p ON p.device_id = d.id
         WHERE d.id <> ? AND d.public_key NOT IN (SELECT public_key FROM vault_revocations)",
    )
    .bind(me)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    rows.into_iter().map(|(id, name, last_addr)| Peer { id, name, last_addr }).collect()
}

#[derive(Debug, Serialize)]
pub struct JoinResult {
    pub outcome: Outcome,
    /// Where the copy of this device's own data went, when it held any.
    pub backup: Option<String>,
}

/// Saves a complete copy of the database in `dir` before a join replaces
/// what's here — marked as a copy (instance.rs), so putting it back later is
/// noticed. Returns its path.
pub async fn backup_before_join(pool: &SqlitePool, dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp: String = now_iso().chars().filter(|c| c.is_ascii_digit()).take(14).collect();
    let path = dir.join(format!("tally-before-join-{stamp}.db"));
    let _ = std::fs::remove_file(&path);
    let target = path.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{target}'")).execute(pool).await.map_err(|e| e.to_string())?;
    super::instance::mark_copy(&path).await?;
    Ok(path)
}

/// What one round found.
pub struct Round {
    pub outcomes: Vec<Outcome>,
    pub errors: Vec<String>,
    /// The devices that couldn't be reached, and why.
    pub unreached: Vec<(String, Problem)>,
}

// Spec: tandem.SYN-1, tandem.SYN-5
/// One round: look for the vault's devices (mDNS and broadcast), then sync
/// with each, trying every address it was found or last reached at, all at
/// once — a network that drops one kind of search still has the other.
pub async fn sync_round(pool: &SqlitePool, mdns: Option<&Mdns>) -> Round {
    let mut round = Round { outcomes: vec![], errors: vec![], unreached: vec![] };
    let Ok(me) = session::identity(pool).await else { return round };
    let Some(vault) = me.vault_id.clone() else { return round };
    let peers = vault_peers(pool, &me.device_id).await;
    if peers.is_empty() {
        return round;
    }
    let tag = session::vault_tag(&vault);
    let last: Vec<String> = peers.iter().filter_map(|p| p.last_addr.clone()).collect();
    let found = discovery::probe(&tag, &me.device_id, &discovery::targets(&last, discovery::PORT), Duration::from_millis(800)).await;
    let heard = mdns.map(|m| m.devices(&tag)).unwrap_or_default();
    for p in &peers {
        // An answer to a search isn't proof of anything (anyone on the
        // network can send one): the handshake decides, and a device that
        // fails it at one address is tried at the others.
        let by_mdns: Vec<SocketAddr> = heard.iter().filter(|(id, _)| *id == p.id).flat_map(|(_, a)| a.clone()).collect();
        let by_broadcast: Vec<SocketAddr> = found.iter().filter(|f| f.device_id == p.id).map(|f| f.addr).collect();
        let last: Vec<SocketAddr> = p.last_addr.iter().filter_map(|a| a.parse().ok()).collect();
        let addrs = mdns::merge(&[&by_mdns, &by_broadcast, &last]);
        if addrs.is_empty() {
            round.unreached.push((p.id.clone(), reach::problem(&p.name, Why::NoAddress, false)));
            continue;
        }
        match session::sync_with_any(pool, &addrs).await {
            Ok(Some(o)) => round.outcomes.push(o),
            Ok(None) => {}
            // Not around is normal: said per device, not as an error.
            Err(Missed::Unreached(fails)) => round.unreached.push((p.id.clone(), diagnose(&p.name, &fails).await)),
            Err(Missed::Failed(e)) => round.errors.push(e),
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
    /// What it holds when it does: (table, rows).
    pub held: Vec<Held>,
    pub offer_active: bool,
    #[serde(flatten)]
    pub activity: Activity,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub table: String,
    pub rows: i64,
}

pub async fn status(pool: &SqlitePool, svc: &SyncService) -> Result<Status, String> {
    let me = session::identity(pool).await?;
    let held: Vec<Held> = engine::held_data(pool)
        .await?
        .into_iter()
        .map(|(table, rows)| Held { table, rows })
        .collect();
    let rows: Vec<(String, String, String, Option<String>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT d.id, d.name, d.platform, p.last_sync_at, p.last_complete_at, p.complete
         FROM vault_devices d LEFT JOIN sync_peers p ON p.device_id = d.id
         WHERE d.public_key NOT IN (SELECT public_key FROM vault_revocations)
           -- One entry per key: a device that took a new id (instance.rs) is
           -- listed once, under the newest. This device is always its own.
           AND (d.id = ?1 OR NOT EXISTS (
             SELECT 1 FROM vault_devices n WHERE n.public_key = d.public_key AND n.id <> d.id
               AND (n.added_at > d.added_at OR n.id = ?1)))
         ORDER BY d.added_at",
    )
    .bind(&me.device_id)
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
        can_join: held.is_empty(),
        held,
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

#[cfg(test)]
mod tests {
    use super::*;

    // Spec: tandem.SYN-23
    #[tokio::test]
    async fn the_check_reaches_a_listening_device_and_explains_one_it_cannot() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up = listener.local_addr().unwrap();
        let r = reachability(Some("d1".into()), "Phone", false, &[up]).await;
        assert_eq!(r.reached_at, Some(up.to_string()));
        assert!(r.problem.is_none());

        let down = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let r = reachability(Some("d1".into()), "Phone", false, &[down]).await;
        assert_eq!(r.reached_at, None);
        assert_eq!(r.problem.map(|p| p.why), Some(Why::NotRunning));

        let r = reachability(None, "Laptop", true, &[]).await;
        assert_eq!(r.problem.map(|p| p.why), Some(Why::NoAddress));
    }

    // Spec: tandem.SYN-23
    #[tokio::test]
    async fn the_last_joined_code_s_device_is_remembered_for_the_check() {
        let d = crate::sync::tests::device().await;
        assert!(last_join(&d.pool).await.is_none());
        let offer = PairingOffer {
            vault_id: "v".into(),
            host_id: "host-1".into(),
            host_name: "Laptop".into(),
            host_key: vec![1, 2, 3],
            token: [0u8; 32],
            addrs: vec!["192.168.1.7:47822".into()],
        };
        remember_join(&d.pool, &offer).await;
        let (id, name, addrs) = last_join(&d.pool).await.unwrap();
        assert_eq!((id.as_str(), name.as_str()), ("host-1", "Laptop"));
        assert_eq!(addrs, vec!["192.168.1.7:47822".parse::<SocketAddr>().unwrap()]);
    }
}
