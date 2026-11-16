//! One sync between two devices, and pairing a new device into a vault.
//!
//! A sync, after the encrypted handshake:
//!
//! ```text
//! client                              server
//!   Hello  ───────────────────────────▶       both check: same vault, same
//!          ◀─────────────────────────── Hello  schema, a key the vault knows
//!   Pull{since} ──────────────────────▶
//!          ◀─────────────────────────── Batch  …until the batch says done
//!   YourTurn ─────────────────────────▶
//!          ◀─────────────────────────── Pull{since}
//!   Batch ────────────────────────────▶        …until done
//!          ◀─────────────────────────── Finished
//!   Digest ───────────────────────────▶
//!          ◀─────────────────────────── Digest  both record whether they match
//! ```
//!
//! Pairing: the host shows a QR code ([`PairingOffer`]) holding its address,
//! its key and a one-time token. The joiner connects with that token (Noise
//! XXpsk3), checks the host is who the code said, empties itself, introduces
//! itself (`Join`), and is added to the vault's device list under the key it
//! proved in the handshake. The same connection then carries on as a sync,
//! which brings everything over.

use super::engine::{self, ApplyStats, Batch, Digest};
use super::wire::{self, Channel, PURPOSE_PAIR, PURPOSE_SYNC};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use sqlx::SqlitePool;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

pub type Result<T> = std::result::Result<T, String>;

pub const PROTOCOL: u32 = 1;
/// Rows and bytes per batch over the wire: big enough to move along, small
/// enough that one transaction never holds the database for long.
const BATCH_ROWS: i64 = 500;
const BATCH_BYTES: usize = 4 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
/// How long a QR code works.
pub const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);
/// The TCP port tried first; any free one if it's taken.
pub const PREFERRED_PORT: u16 = 47822;
/// The most a device may send before it's known to belong to the vault.
const PRE_AUTH_LIMIT: usize = 64 * 1024;
/// Connections handled at once; more are turned away at the door.
const MAX_CONNECTIONS: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub schema: i64,
    pub vault_id: Option<String>,
    /// This device's current epoch (see `sync_epochs` in schema.ts).
    pub epoch: String,
    /// "dev" for a development build, "release" otherwise (absent, from a
    /// version before this existed: a release). The two never sync.
    #[serde(default)]
    pub build: String,
    /// Understands [`Msg::SkipDigest`] (absent from older versions, which
    /// then always get the full comparison).
    #[serde(default)]
    pub skips_idle_digest: bool,
}

/// What kind of build this is, for [`Hello::build`].
pub fn build_kind() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    }
}

/// Whether two builds may sync: a development build never touches the real
/// app's data, whatever database it was given — unfinished code's mistakes
/// would otherwise reach every device.
fn same_build(a: &str, b: &str) -> bool {
    let norm = |k: &str| if k.is_empty() { "release" } else { k }.to_string();
    norm(a) == norm(b)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Msg {
    Hello(Hello),
    Join { device_id: String, name: String, platform: String },
    Welcome { vault_id: String },
    /// What the sender knows of the receiver's history: how far it has
    /// pulled from it, and the epoch it last saw it in. Further than the
    /// receiver has recorded, or an epoch it never had, means the receiver
    /// is an older copy of itself (restored from a backup) — see
    /// [`check_not_stale`].
    Seen { pulled_from_you: i64, last_epoch: Option<String> },
    Pull { since: i64 },
    Batch(Batch),
    YourTurn,
    Finished,
    Digest(Digest),
    /// Nothing moved either way and the last sync ended identical: they still
    /// are, so the full comparison (a pass over every table) is skipped.
    SkipDigest,
    Refused { reason: String },
}

/// Who this device is, for sync.
#[derive(Debug, Clone)]
pub struct Identity {
    pub device_id: String,
    pub vault_id: Option<String>,
    pub secret: Vec<u8>,
    pub public: Vec<u8>,
    pub name: String,
    pub platform: String,
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

/// This device's identity, making its key pair the first time.
pub async fn identity(pool: &SqlitePool) -> Result<Identity> {
    let (device_id, vault_id, secret, public): (String, Option<String>, Option<Vec<u8>>, Option<Vec<u8>>) =
        sqlx::query_as("SELECT device_id, vault_id, secret_key, public_key FROM sync_state WHERE id = 1")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let (secret, public) = match (secret, public) {
        (Some(s), Some(p)) => (s, p),
        _ => {
            let (s, p) = wire::generate_keypair();
            sqlx::query("UPDATE sync_state SET secret_key = ?, public_key = ? WHERE id = 1")
                .bind(&s)
                .bind(&p)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            (s, p)
        }
    };
    let name: Option<String> = sqlx::query_scalar("SELECT value FROM device_settings WHERE key = 'sync_device_name'")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| if platform() == "android" { "Phone".into() } else { "Computer".into() });
    Ok(Identity { device_id, vault_id, secret, public, name, platform: platform().into() })
}

async fn hello(pool: &SqlitePool, me: &Identity) -> Result<Hello> {
    Ok(Hello {
        protocol: PROTOCOL,
        device_id: me.device_id.clone(),
        name: me.name.clone(),
        platform: me.platform.clone(),
        schema: engine::schema_version(pool).await?,
        vault_id: me.vault_id.clone(),
        epoch: current_epoch(pool).await?,
        build: build_kind().into(),
        skips_idle_digest: true,
    })
}

/// The epoch to introduce this device with: the latest, or a new one if
/// anything has been written since it began. Peers remember it; a copy of
/// this database from before it — restored from a backup, a folder copied
/// back — never had it, and the first peer to meet that copy says so.
async fn current_epoch(pool: &SqlitePool) -> Result<String> {
    let seq = engine::local_state(pool).await?.seq;
    let latest: Option<(String, i64)> =
        sqlx::query_as("SELECT epoch, seq FROM sync_epochs ORDER BY rowid DESC LIMIT 1")
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    match latest {
        Some((epoch, at)) if at >= seq => Ok(epoch),
        _ => {
            let epoch = super::new_uuid();
            sqlx::query("INSERT INTO sync_epochs (epoch, seq, created_at) VALUES (?, ?, ?)")
                .bind(&epoch)
                .bind(seq)
                .bind(now_iso())
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(epoch)
        }
    }
}

async fn last_epoch_of(pool: &SqlitePool, peer: &str) -> Result<Option<String>> {
    Ok(sqlx::query_scalar::<_, Option<String>>("SELECT last_epoch FROM sync_peers WHERE device_id = ?")
        .bind(peer)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten())
}

/// Before anything else is read from an incoming connection: whether the key
/// it proved belongs to a device of this vault (and isn't revoked). A
/// stranger is turned away before it can send anything of size.
async fn key_known(pool: &SqlitePool, key: &[u8]) -> Result<bool> {
    let k = hex::encode(key);
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM vault_devices WHERE public_key = ?1)
           AND NOT EXISTS (SELECT 1 FROM vault_revocations WHERE public_key = ?1)",
    )
    .bind(&k)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())
}

/// Whether `theirs` may sync with this device: the same vault, the same
/// schema, a key the vault lists and hasn't revoked — or, while joining (the
/// device list is still empty here), the key the QR code named.
///
/// A device is known by its key; its id can change (a restored copy takes a
/// new one, see `instance.rs`), and the new id arrives with the sync itself.
async fn check_peer(pool: &SqlitePool, me: &Hello, theirs: &Hello, proven_key: &[u8], vouched: Option<&[u8]>) -> Result<()> {
    if theirs.protocol != me.protocol {
        return Err(format!("{} runs a different version of sync; update both devices", theirs.name));
    }
    if theirs.schema != me.schema {
        return Err(format!(
            "{} is on a different version of Tally ({} vs {}); update both devices",
            theirs.name, theirs.schema, me.schema
        ));
    }
    if !same_build(&me.build, &theirs.build) {
        return Err(format!(
            "{} is a {} build and this is a {} one: development builds never sync with the real app",
            theirs.name,
            if theirs.build.is_empty() { "release" } else { &theirs.build },
            me.build
        ));
    }
    if me.vault_id.is_none() || theirs.vault_id != me.vault_id {
        return Err("not in the same vault".into());
    }
    if theirs.device_id == me.device_id {
        return Err("the other device has this device's id: one of them is a copy".into());
    }
    if let Some(k) = vouched {
        return if k == proven_key { Ok(()) } else { Err("the host's key changed mid-pairing".into()) };
    }
    let key = hex::encode(proven_key);
    let revoked: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM vault_revocations WHERE public_key = ?)")
        .bind(&key)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if revoked {
        return Err(format!("{} was removed from this vault", theirs.name));
    }
    let listed: Option<String> = sqlx::query_scalar("SELECT public_key FROM vault_devices WHERE id = ?")
        .bind(&theirs.device_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    match listed {
        Some(k) if k == key => Ok(()),
        Some(_) => Err(format!("{} presented a key the vault doesn't know it by", theirs.name)),
        None if key_known(pool, proven_key).await? => Ok(()),
        None => Err(format!("{} isn't (or is no longer) in this vault", theirs.name)),
    }
}

/// After the hellos, each side says what it knows of the other's history. A
/// device that's been pulled from further than it has ever recorded, or seen
/// in an epoch it never had, is an older copy of itself: it takes a new id
/// (`instance::rotate`) and the sync stops here — the next one starts clean.
async fn check_not_stale(pool: &SqlitePool, pulled_from_me: i64, last_epoch: Option<String>) -> Result<()> {
    let mine = engine::local_state(pool).await?.seq;
    let unknown_epoch = match &last_epoch {
        Some(e) => !sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM sync_epochs WHERE epoch = ?)")
            .bind(e)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?,
        None => false,
    };
    if pulled_from_me > mine || unknown_epoch {
        super::instance::rotate(pool).await?;
        return Err("this device's database is an older copy of itself (restored?); it has taken a new id and will sync from scratch".into());
    }
    Ok(())
}

/// What a finished sync did.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Outcome {
    pub peer_id: String,
    pub peer_name: String,
    /// What this device took in.
    pub received: Received,
    /// Whether both devices ended holding exactly the same data.
    pub complete: bool,
    /// Tables that differed, when not.
    pub differences: Vec<String>,
    /// Nothing moved and the last sync had ended identical, so the full
    /// comparison was skipped.
    pub digest_skipped: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Received {
    pub applied: usize,
    pub conflicts: usize,
    pub forks: usize,
    pub unique_merges: usize,
}

impl Received {
    fn add(&mut self, s: ApplyStats) {
        self.applied += s.applied;
        self.conflicts += s.conflicts;
        self.forks += s.forks;
        self.unique_merges += s.unique_merges;
    }
    pub fn changed_anything(&self) -> bool {
        self.applied + self.conflicts + self.forks + self.unique_merges > 0
    }
}

use super::now_iso;

async fn record_outcome(pool: &SqlitePool, peer: &str, epoch: &str, addr: Option<SocketAddr>, complete: bool) -> Result<()> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_peers (device_id, last_addr, last_sync_at, complete, last_complete_at, last_epoch)
         VALUES (?1, ?2, ?3, ?4, CASE WHEN ?4 = 1 THEN ?3 END, ?5)
         ON CONFLICT (device_id) DO UPDATE SET
           last_addr = coalesce(excluded.last_addr, last_addr),
           last_sync_at = excluded.last_sync_at,
           complete = excluded.complete,
           last_complete_at = CASE WHEN excluded.complete = 1 THEN excluded.last_sync_at ELSE last_complete_at END,
           last_epoch = excluded.last_epoch",
    )
    .bind(peer)
    .bind(addr.map(|a| a.to_string()))
    .bind(&now)
    .bind(complete as i64)
    .bind(epoch)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn expect(ch: &mut Channel) -> Result<Msg> {
    match ch.recv::<Msg>().await? {
        Msg::Refused { reason } => Err(reason),
        m => Ok(m),
    }
}

/// Pulls from the far side until it says it's done.
async fn pull(ch: &mut Channel, pool: &SqlitePool, peer: &str) -> Result<Received> {
    let mut got = Received::default();
    loop {
        let since = engine::pulled_from(pool, peer).await?;
        ch.send(&Msg::Pull { since }).await?;
        let Msg::Batch(batch) = expect(ch).await? else {
            return Err("expected a batch".into());
        };
        match engine::apply(pool, peer, &batch).await {
            Ok(s) => got.add(s),
            Err(e) => {
                let _ = ch.send(&Msg::Refused { reason: format!("couldn't apply: {e}") }).await;
                return Err(e);
            }
        }
        if batch.done {
            return Ok(got);
        }
    }
}

/// Answers the far side's pulls until it hands the turn back with `end`.
/// Returns how many changes it sent.
async fn serve_pulls(ch: &mut Channel, pool: &SqlitePool, peer: &str, end: &Msg) -> Result<usize> {
    let mut sent = 0;
    loop {
        match expect(ch).await? {
            Msg::Pull { since } => {
                let batch = engine::export(pool, since, peer, BATCH_ROWS, BATCH_BYTES).await?;
                sent += batch.changes.len();
                ch.send(&Msg::Batch(batch)).await?;
            }
            m if &m == end => return Ok(sent),
            other => return Err(format!("unexpected message: {other:?}")),
        }
    }
}

async fn compare_digests(pool: &SqlitePool, theirs: &Digest) -> Result<(bool, Vec<String>)> {
    let mine = engine::digest(pool).await?;
    let diff = engine::digest_differences(&mine, theirs);
    Ok((diff.is_empty(), diff))
}

async fn client_session(
    ch: &mut Channel,
    pool: &SqlitePool,
    me: &Hello,
    addr: Option<SocketAddr>,
    vouched: Option<&[u8]>,
) -> Result<Outcome> {
    ch.send(&Msg::Hello(me.clone())).await?;
    let Msg::Hello(theirs) = (match ch.recv_limited::<Msg>(PRE_AUTH_LIMIT).await? {
        Msg::Refused { reason } => return Err(reason),
        m => m,
    }) else {
        return Err("expected a hello".into());
    };
    check_peer(pool, me, &theirs, &ch.remote_key, vouched).await?;
    ch.send(&Msg::Seen {
        pulled_from_you: engine::pulled_from(pool, &theirs.device_id).await?,
        last_epoch: last_epoch_of(pool, &theirs.device_id).await?,
    })
    .await?;
    let Msg::Seen { pulled_from_you, last_epoch } = expect(ch).await? else {
        return Err("expected how far it has pulled".into());
    };
    check_not_stale(pool, pulled_from_you, last_epoch).await?;
    let received = pull(ch, pool, &theirs.device_id).await?;
    ch.send(&Msg::YourTurn).await?;
    let sent = serve_pulls(ch, pool, &theirs.device_id, &Msg::Finished).await?;
    // A sync that moved nothing, after one that ended identical: still
    // identical. Skipping the comparison makes the frequent idle syncs cheap.
    let idle = !received.changed_anything()
        && sent == 0
        && me.skips_idle_digest
        && theirs.skips_idle_digest
        && was_complete(pool, &theirs.device_id).await?;
    if idle {
        ch.send(&Msg::SkipDigest).await?;
        record_outcome(pool, &theirs.device_id, &theirs.epoch, addr, true).await?;
        return Ok(Outcome {
            peer_id: theirs.device_id,
            peer_name: theirs.name,
            received,
            complete: true,
            differences: vec![],
            digest_skipped: true,
        });
    }
    ch.send(&Msg::Digest(engine::digest(pool).await?)).await?;
    let Msg::Digest(their_digest) = expect(ch).await? else {
        return Err("expected a digest".into());
    };
    let (complete, differences) = compare_digests(pool, &their_digest).await?;
    record_outcome(pool, &theirs.device_id, &theirs.epoch, addr, complete).await?;
    engine::remove_orphans(pool).await?;
    Ok(Outcome { peer_id: theirs.device_id, peer_name: theirs.name, received, complete, differences, digest_skipped: false })
}

/// Whether the last finished sync with `peer` ended with both identical.
async fn was_complete(pool: &SqlitePool, peer: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT complete FROM sync_peers WHERE device_id = ?")
        .bind(peer)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        == Some(1))
}

async fn server_session(ch: &mut Channel, pool: &SqlitePool, me: &Hello, theirs: Hello) -> Result<Outcome> {
    if let Err(reason) = check_peer(pool, me, &theirs, &ch.remote_key, None).await {
        let _ = ch.send(&Msg::Refused { reason: reason.clone() }).await;
        return Err(reason);
    }
    ch.send(&Msg::Hello(me.clone())).await?;
    let Msg::Seen { pulled_from_you, last_epoch } = expect(ch).await? else {
        return Err("expected how far it has pulled".into());
    };
    ch.send(&Msg::Seen {
        pulled_from_you: engine::pulled_from(pool, &theirs.device_id).await?,
        last_epoch: last_epoch_of(pool, &theirs.device_id).await?,
    })
    .await?;
    check_not_stale(pool, pulled_from_you, last_epoch).await?;
    serve_pulls(ch, pool, &theirs.device_id, &Msg::YourTurn).await?;
    let received = pull(ch, pool, &theirs.device_id).await?;
    ch.send(&Msg::Finished).await?;
    let their_digest = match expect(ch).await? {
        Msg::Digest(d) => d,
        // The client saw nothing move after a sync that ended identical.
        Msg::SkipDigest if me.skips_idle_digest => {
            record_outcome(pool, &theirs.device_id, &theirs.epoch, None, true).await?;
            return Ok(Outcome {
                peer_id: theirs.device_id,
                peer_name: theirs.name,
                received,
                complete: true,
                differences: vec![],
                digest_skipped: true,
            });
        }
        _ => return Err("expected a digest".into()),
    };
    ch.send(&Msg::Digest(engine::digest(pool).await?)).await?;
    let (complete, differences) = compare_digests(pool, &their_digest).await?;
    record_outcome(pool, &theirs.device_id, &theirs.epoch, None, complete).await?;
    engine::remove_orphans(pool).await?;
    Ok(Outcome { peer_id: theirs.device_id, peer_name: theirs.name, received, complete, differences, digest_skipped: false })
}

// ---------------------------------------------------------------------------
// One sync at a time, per process
// ---------------------------------------------------------------------------

/// Devices (by id) with a sync running in this process. Keyed by device
/// rather than one lock for the process, so the tests can run two devices in
/// one process; in the app there's one device, and the background sync on
/// Android shares this with the app when both are alive.
static BUSY: Mutex<std::collections::BTreeSet<String>> = Mutex::new(std::collections::BTreeSet::new());

struct Busy(String);

impl Drop for Busy {
    fn drop(&mut self) {
        if let Ok(mut b) = BUSY.lock() {
            b.remove(&self.0);
        }
    }
}

fn try_busy(device: &str) -> Option<Busy> {
    let mut b = BUSY.lock().ok()?;
    b.insert(device.to_string()).then(|| Busy(device.to_string()))
}

/// Syncs with the device at `addr`. `Ok(None)` when a sync is already running
/// here (it'll come round again).
pub async fn sync_with(pool: &SqlitePool, addr: SocketAddr) -> Result<Option<Outcome>> {
    let me = identity(pool).await?;
    let Some(_guard) = try_busy(&me.device_id) else {
        return Ok(None);
    };
    let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| format!("{addr}: no answer"))?
        .map_err(|e| format!("{addr}: {e}"))?;
    let mut ch = Channel::initiate(stream, PURPOSE_SYNC, &me.secret, None).await?;
    // Whoever answered at a discovered address has to be one of the vault's
    // devices before this one sends or reads anything more.
    if !key_known(pool, &ch.remote_key).await? {
        return Err(format!("{addr}: answered by a device outside the vault"));
    }
    let hello = hello(pool, &me).await?;
    match client_session(&mut ch, pool, &hello, Some(addr), None).await {
        // The other side is mid-sync with someone (or just finishing with
        // us): not a failure, just another time.
        Err(e) if e == "busy" => Ok(None),
        r => r.map(Some),
    }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/// What the QR code carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairingOffer {
    pub vault_id: String,
    pub host_id: String,
    pub host_name: String,
    #[serde(with = "serde_bytes")]
    pub host_key: Vec<u8>,
    pub token: [u8; 32],
    pub addrs: Vec<String>,
}

const OFFER_PREFIX: &str = "tally-pair:1:";

impl PairingOffer {
    pub fn encode(&self) -> String {
        let bytes = rmp_serde::to_vec(self).expect("serializable");
        format!("{OFFER_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn decode(s: &str) -> Result<PairingOffer> {
        let body = s.trim().strip_prefix(OFFER_PREFIX).ok_or("not a Tally pairing code")?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| "the pairing code is damaged")?;
        rmp_serde::from_slice(&bytes).map_err(|_| "the pairing code is damaged".into())
    }
}

/// A QR code on screen, waiting to be scanned.
#[derive(Clone)]
pub struct PendingPairing {
    pub token: [u8; 32],
    pub expires: Instant,
}

pub type PairingSlot = Arc<Mutex<Option<PendingPairing>>>;

/// Puts this device in a vault of its own if it isn't in one, listing itself
/// as its first device.
pub async fn ensure_vault(pool: &SqlitePool) -> Result<Identity> {
    let me = identity(pool).await?;
    if me.vault_id.is_some() {
        // Make sure this device is listed (it would be, unless removed).
        sqlx::query(
            "INSERT INTO vault_devices (id, name, public_key, platform, added_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(&me.device_id)
        .bind(&me.name)
        .bind(hex::encode(&me.public))
        .bind(&me.platform)
        .bind(now_iso())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(me);
    }
    let vault = super::new_uuid();
    sqlx::query("UPDATE sync_state SET vault_id = ? WHERE id = 1")
        .bind(&vault)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Box::pin(ensure_vault(pool)).await
}

/// Starts a pairing: a fresh one-time token, and the code to show.
pub async fn offer(pool: &SqlitePool, slot: &PairingSlot, addrs: Vec<String>) -> Result<PairingOffer> {
    let me = ensure_vault(pool).await?;
    let token: [u8; 32] = rand::random();
    *slot.lock().map_err(|e| e.to_string())? = Some(PendingPairing { token, expires: Instant::now() + PAIRING_TTL });
    Ok(PairingOffer {
        vault_id: me.vault_id.expect("ensured"),
        host_id: me.device_id,
        host_name: me.name,
        host_key: me.public,
        token,
        addrs,
    })
}

/// Joins the vault `offer` came from. Without `replace` this device must hold
/// none of the person's data; with it, whatever it holds is replaced by the
/// vault's (the caller saves a copy first — see `service::backup_before_join`).
/// Ends with everything the host has.
pub async fn join(pool: &SqlitePool, offer: &PairingOffer, replace: bool) -> Result<Outcome> {
    let held = engine::data_tables(pool).await?;
    if !held.is_empty() && !replace {
        return Err(format!(
            "this device already holds data ({}), so it can't join — only an empty device can",
            held.join(", ")
        ));
    }
    let me = identity(pool).await?;
    let Some(_guard) = try_busy(&me.device_id) else {
        return Err("a sync is running; try again in a moment".into());
    };
    // A fresh key for a fresh member: a device once removed (its key revoked)
    // can be paired again, and a key never outlives the device's place. Kept
    // in memory until the host lets this device in: a failed join changes
    // nothing here.
    let (secret, public) = wire::generate_keypair();
    let new_id = super::new_uuid();
    let mut last_error = String::from("the code holds no address");
    for addr in &offer.addrs {
        let Ok(addr) = addr.parse::<SocketAddr>() else { continue };
        let stream = match timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                last_error = format!("{addr}: {e}");
                continue;
            }
            Err(_) => {
                last_error = format!("{addr}: no answer");
                continue;
            }
        };
        let mut ch = match Channel::initiate(stream, PURPOSE_PAIR, &secret, Some(&offer.token)).await {
            Ok(ch) => ch,
            Err(_) => return Err("the code has expired or was already used; show a new one".into()),
        };
        if ch.remote_key != offer.host_key {
            return Err("the device that answered isn't the one that showed the code".into());
        }
        // The host is who the code said. Ask to be let in; only once it has,
        // empty out — a refusal leaves this device exactly as it was.
        ch.send(&Msg::Join { device_id: new_id.clone(), name: me.name.clone(), platform: me.platform.clone() }).await?;
        match expect(&mut ch).await? {
            Msg::Welcome { vault_id } if vault_id == offer.vault_id => {}
            _ => return Err("the host didn't let this device in".into()),
        }
        engine::reset_for_join(pool, &offer.vault_id, &new_id, Some((&secret, &public)), replace).await?;
        let me = identity(pool).await?;
        let hello = hello(pool, &me).await?;
        let host_key = offer.host_key.clone();
        return client_session(&mut ch, pool, &hello, Some(addr), Some(&host_key)).await;
    }
    Err(format!("couldn't reach {}: {last_error}", offer.host_name))
}

// ---------------------------------------------------------------------------
// The listening side
// ---------------------------------------------------------------------------

/// Handles one incoming connection: a sync, or a device joining with the
/// code currently on screen.
pub async fn serve(pool: &SqlitePool, mut stream: TcpStream, slot: &PairingSlot) -> Result<Outcome> {
    let me = identity(pool).await?;
    match Channel::purpose(&mut stream).await? {
        PURPOSE_SYNC => {
            let mut ch = Channel::respond(stream, &me.secret, None).await?;
            if !key_known(pool, &ch.remote_key).await? {
                return Err("a device outside the vault knocked".into());
            }
            let Msg::Hello(theirs) = ch.recv_limited::<Msg>(PRE_AUTH_LIMIT).await? else {
                return Err("expected a hello".into());
            };
            let Some(_guard) = try_busy(&me.device_id) else {
                let _ = ch.send(&Msg::Refused { reason: "busy".into() }).await;
                return Err("busy".into());
            };
            let hello = hello(pool, &me).await?;
            server_session(&mut ch, pool, &hello, theirs).await
        }
        PURPOSE_PAIR => {
            let token = {
                let slot = slot.lock().map_err(|e| e.to_string())?;
                match slot.as_ref() {
                    Some(p) if p.expires > Instant::now() => p.token,
                    _ => return Err("no pairing code is showing".into()),
                }
            };
            let mut ch = Channel::respond(stream, &me.secret, Some(&token)).await?;
            // Busy: say so before the code is used up, so it can be scanned again.
            let Some(_guard) = try_busy(&me.device_id) else {
                let _ = ch.send(&Msg::Refused { reason: "busy; scan again in a moment".into() }).await;
                return Err("busy".into());
            };
            // The token is good for one device only.
            {
                let mut slot = slot.lock().map_err(|e| e.to_string())?;
                match slot.as_ref() {
                    Some(p) if p.token == token => *slot = None,
                    _ => return Err("pairing code already used".into()),
                }
            }
            let Msg::Join { device_id, name, platform } = ch.recv_limited::<Msg>(PRE_AUTH_LIMIT).await? else {
                return Err("expected a join".into());
            };
            let me = ensure_vault(pool).await?;
            let key = hex::encode(&ch.remote_key);
            let taken: Option<String> = sqlx::query_scalar("SELECT public_key FROM vault_devices WHERE id = ?")
                .bind(&device_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
            let revoked: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM vault_revocations WHERE public_key = ?)")
                .bind(&key)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            if revoked || taken.is_some_and(|k| k != key) {
                let _ = ch.send(&Msg::Refused { reason: "that device can't join".into() }).await;
                return Err("refused a join under another device's id or a revoked key".into());
            }
            // Listed under the key it proved, whatever it claims.
            sqlx::query(
                "INSERT INTO vault_devices (id, name, public_key, platform, added_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(&device_id)
            .bind(&name)
            .bind(&key)
            .bind(&platform)
            .bind(now_iso())
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            ch.send(&Msg::Welcome { vault_id: me.vault_id.clone().expect("ensured") }).await?;
            let Msg::Hello(theirs) = expect(&mut ch).await? else {
                return Err("expected a hello".into());
            };
            let hello = hello(pool, &me).await?;
            server_session(&mut ch, pool, &hello, theirs).await
        }
        _ => Err("not a Tally connection".into()),
    }
}

/// Listens for other devices, on [`PREFERRED_PORT`] if it's free. Each
/// connection is handled on its own task; `on_outcome` hears how it went.
pub async fn listen<F>(pool: SqlitePool, slot: PairingSlot, bind_ip: &str, on_outcome: F) -> Result<(u16, tokio::task::JoinHandle<()>)>
where
    F: Fn(Result<Outcome>) + Send + Sync + 'static,
{
    let listener = match TcpListener::bind((bind_ip, PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind((bind_ip, 0)).await.map_err(|e| e.to_string())?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let on_outcome = Arc::new(on_outcome);
    let permits = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let handle = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                drop(stream);
                continue;
            };
            let (pool, slot, on_outcome) = (pool.clone(), slot.clone(), on_outcome.clone());
            tokio::spawn(async move {
                on_outcome(serve(&pool, stream, &slot).await);
                drop(permit);
            });
        }
    });
    Ok((port, handle))
}

/// This device's addresses on the local network, for the QR code.
pub fn local_addrs(port: u16) -> Vec<String> {
    let mut out: Vec<String> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v4) if v4.is_private() || v4.is_link_local() => Some(format!("{v4}:{port}")),
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// A short tag for the vault, for discovery: devices of other vaults on the
/// same network ignore each other without learning the vault's id.
pub fn vault_tag(vault_id: &str) -> String {
    hex::encode(&Sha256::digest(format!("tally-vault:{vault_id}").as_bytes())[..8])
}

#[cfg(test)]
mod tests;
