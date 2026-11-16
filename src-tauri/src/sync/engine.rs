//! The sync engine: what one device sends another, and how a device takes in
//! what it's sent. No networking here — two databases in one process sync
//! through these functions in the tests, and the transport only carries
//! [`Batch`]es between them.
//!
//! The model (see migration 0039):
//! - Every row of every synced table has a current version in `sync_rows`
//!   (hybrid-logical-clock time `hlc`, writing device `origin`, tombstone
//!   flag) and a version vector in `sync_vv` (how many changes each device has
//!   made to it). Triggers keep both current for every local write.
//! - A device pulls "everything you've recorded since seq N" from a peer.
//! - An incoming version whose vector has seen everything the local one has
//!   simply replaces it; one the local version has already seen is ignored.
//! - Two versions made without either seeing the other (concurrent): the one
//!   with the later clock wins, and both devices end up with the same row and
//!   the merged vector. Chats are the exception — a conversation continued on
//!   two devices at once is split, the losing side kept as a new chat, so no
//!   turn is lost.
//! - A row that collides with a different row on a unique column (the same
//!   observation tag created on two devices) keeps the lower id; the other is
//!   deleted everywhere.
//!
//! Every decision depends only on the two versions involved, so every device
//! reaches the same result whatever order changes arrive in.

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use sqlx::sqlite::{SqliteConnection, SqliteRow};
use sqlx::{Column, Connection, Row, SqlitePool, TypeInfo, ValueRef};
use std::collections::{BTreeMap, HashMap};

pub type Result<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// One column value, as SQLite stores it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(#[serde(with = "serde_bytes")] Vec<u8>),
}

/// A row's version as one device holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub tbl: String,
    pub pk: String,
    pub hlc: String,
    pub origin: String,
    pub deleted: bool,
    pub vv: BTreeMap<String, i64>,
    /// Column → value; `None` for a tombstone.
    pub data: Option<Vec<(String, Value)>>,
}

/// A slice of a device's changes, in the order it recorded them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Batch {
    pub changes: Vec<Change>,
    /// Pull from here next time: every change up to this seq is covered.
    pub upto: i64,
    /// Nothing after `upto` yet.
    pub done: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ApplyStats {
    /// Versions taken over as they came.
    pub applied: usize,
    /// Versions this device already had, or had already moved past.
    pub skipped: usize,
    /// Versions made concurrently with this device's own, settled by clock.
    pub conflicts: usize,
    /// Chats split because both sides had continued them.
    pub forks: usize,
    /// Rows dropped for colliding with another on a unique column.
    pub unique_merges: usize,
}

impl ApplyStats {
    fn add(&mut self, o: ApplyStats) {
        self.applied += o.applied;
        self.skipped += o.skipped;
        self.conflicts += o.conflicts;
        self.forks += o.forks;
        self.unique_merges += o.unique_merges;
    }
}

/// How a synced table is shaped.
#[derive(Debug, Clone)]
pub struct TableInfo {
    pub name: String,
    pub pk: String,
    pub columns: Vec<String>,
    /// Columns declared BLOB (photos, document files): the digest reads their
    /// length, not their bytes.
    pub blob_columns: Vec<String>,
    /// Column sets of the unique indexes other than the primary key.
    pub uniques: Vec<Vec<String>>,
    /// (column, parent table, parent column) of foreign keys that cascade on delete.
    pub cascades: Vec<(String, String, String)>,
}

/// The synced tables, read from the database itself: a table is synced when
/// it carries the sync insert trigger (see scripts/sync-triggers.ts).
pub async fn synced_tables(conn: &mut SqliteConnection) -> Result<BTreeMap<String, TableInfo>> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = 'sync_' || tbl_name || '_ai' ORDER BY tbl_name",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(err)?;
    let mut out = BTreeMap::new();
    for name in names {
        let cols: Vec<(String, i64, String)> =
            sqlx::query_as("SELECT name, pk, upper(type) FROM pragma_table_info(?) ORDER BY cid")
                .bind(&name)
                .fetch_all(&mut *conn)
                .await
                .map_err(err)?;
        let pk = cols
            .iter()
            .find(|(_, p, _)| *p == 1)
            .map(|(c, _, _)| c.clone())
            .ok_or_else(|| format!("{name}: no primary key"))?;
        let blob_columns = cols.iter().filter(|(_, _, t)| t == "BLOB").map(|(c, _, _)| c.clone()).collect();
        let indexes: Vec<(String, String)> =
            sqlx::query_as("SELECT name, origin FROM pragma_index_list(?) WHERE \"unique\" = 1")
                .bind(&name)
                .fetch_all(&mut *conn)
                .await
                .map_err(err)?;
        let mut uniques = Vec::new();
        for (idx, origin) in indexes {
            if origin == "pk" {
                continue;
            }
            let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
                .bind(&idx)
                .fetch_all(&mut *conn)
                .await
                .map_err(err)?;
            if cols.iter().any(|c| c == &pk) && cols.len() == 1 {
                continue;
            }
            uniques.push(cols);
        }
        let fks: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT \"from\", \"table\", \"to\", on_delete FROM pragma_foreign_key_list(?)",
        )
        .bind(&name)
        .fetch_all(&mut *conn)
        .await
        .map_err(err)?;
        let cascades = fks
            .into_iter()
            .filter(|(_, _, _, d)| d.eq_ignore_ascii_case("cascade"))
            .map(|(f, t, to, _)| (f, t, to))
            .collect();
        out.insert(
            name.clone(),
            TableInfo { name, pk, columns: cols.into_iter().map(|(c, _, _)| c).collect(), blob_columns, uniques, cascades },
        );
    }
    Ok(out)
}

fn quote(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// The newest migration applied: two devices only sync on the same schema.
pub async fn schema_version(pool: &SqlitePool) -> Result<i64> {
    sqlx::query_scalar("SELECT coalesce(max(version), 0) FROM _sqlx_migrations WHERE success")
        .fetch_one(pool)
        .await
        .map_err(err)
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalState {
    pub device_id: String,
    pub vault_id: Option<String>,
    pub seq: i64,
}

pub async fn local_state(pool: &SqlitePool) -> Result<LocalState> {
    let (device_id, vault_id, seq): (String, Option<String>, i64) =
        sqlx::query_as("SELECT device_id, vault_id, seq FROM sync_state WHERE id = 1")
            .fetch_one(pool)
            .await
            .map_err(err)?;
    Ok(LocalState { device_id, vault_id, seq })
}

// ---------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------

fn row_values(row: &SqliteRow) -> Result<Vec<(String, Value)>> {
    let mut out = Vec::with_capacity(row.columns().len());
    for (i, col) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(i).map_err(err)?;
        let v = if raw.is_null() {
            Value::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" => Value::Int(row.try_get_unchecked::<i64, _>(i).map_err(err)?),
                "REAL" => Value::Real(row.try_get_unchecked::<f64, _>(i).map_err(err)?),
                "BLOB" => Value::Blob(row.try_get_unchecked::<Vec<u8>, _>(i).map_err(err)?),
                _ => Value::Text(row.try_get_unchecked::<String, _>(i).map_err(err)?),
            }
        };
        out.push((col.name().to_string(), v));
    }
    Ok(out)
}

async fn read_row(conn: &mut SqliteConnection, t: &TableInfo, pk: &str) -> Result<Option<Vec<(String, Value)>>> {
    let sql = format!("SELECT * FROM {} WHERE {} = ?", quote(&t.name), quote(&t.pk));
    let row = sqlx::query(&sql).bind(pk).fetch_optional(&mut *conn).await.map_err(err)?;
    row.as_ref().map(row_values).transpose()
}

async fn vv_of(conn: &mut SqliteConnection, tbl: &str, pk: &str) -> Result<BTreeMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as("SELECT device, counter FROM sync_vv WHERE tbl = ? AND pk = ?")
        .bind(tbl)
        .bind(pk)
        .fetch_all(&mut *conn)
        .await
        .map_err(err)?;
    Ok(rows.into_iter().collect())
}

fn data_size(data: &Option<Vec<(String, Value)>>) -> usize {
    data.as_ref().map_or(16, |d| {
        d.iter()
            .map(|(c, v)| {
                c.len()
                    + match v {
                        Value::Text(s) => s.len(),
                        Value::Blob(b) => b.len(),
                        _ => 9,
                    }
            })
            .sum()
    })
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// The changes recorded after `since`, for `peer`: at most `max_rows`, and
/// stopping once about `max_bytes` of row data is in (always at least one).
/// Versions that came from `peer` itself, unchanged since, aren't sent back.
pub async fn export(pool: &SqlitePool, since: i64, peer: &str, max_rows: i64, max_bytes: usize) -> Result<Batch> {
    let mut conn = pool.acquire().await.map_err(err)?;
    // One read transaction, so the rows and their versions agree.
    sqlx::query("BEGIN").execute(&mut *conn).await.map_err(err)?;
    let result = export_in(&mut conn, since, peer, max_rows, max_bytes).await;
    let _ = sqlx::query("COMMIT").execute(&mut *conn).await;
    result
}

async fn export_in(
    conn: &mut SqliteConnection,
    since: i64,
    peer: &str,
    max_rows: i64,
    max_bytes: usize,
) -> Result<Batch> {
    let tables = synced_tables(conn).await?;
    let rows: Vec<(String, String, String, String, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT tbl, pk, hlc, origin, deleted, seq, from_peer FROM sync_rows WHERE seq > ? ORDER BY seq LIMIT ?",
    )
    .bind(since)
    .bind(max_rows + 1)
    .fetch_all(&mut *conn)
    .await
    .map_err(err)?;
    let more = rows.len() as i64 > max_rows;
    let mut changes = Vec::new();
    let mut upto = since;
    let mut bytes = 0usize;
    let mut stopped_early = false;
    for (tbl, pk, hlc, origin, deleted, seq, from_peer) in rows.into_iter().take(max_rows as usize) {
        if bytes >= max_bytes && !changes.is_empty() {
            stopped_early = true;
            break;
        }
        upto = seq;
        if from_peer.as_deref() == Some(peer) {
            continue;
        }
        let Some(t) = tables.get(&tbl) else {
            // A table no longer synced on this side: nothing to send.
            continue;
        };
        let data = if deleted != 0 {
            None
        } else {
            match read_row(conn, t, &pk).await? {
                Some(d) => Some(d),
                // Recorded as live but gone: not ours to invent a deletion for.
                None => continue,
            }
        };
        bytes += data_size(&data);
        let vv = vv_of(conn, &tbl, &pk).await?;
        changes.push(Change { tbl, pk, hlc, origin, deleted: deleted != 0, vv, data });
    }
    Ok(Batch { changes, upto, done: !more && !stopped_early })
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Order {
    Equal,
    /// The incoming version has seen everything the local one has, and more.
    Newer,
    /// The local version has seen everything the incoming one has.
    Older,
    Concurrent,
}

fn compare_vv(incoming: &BTreeMap<String, i64>, local: &BTreeMap<String, i64>) -> Order {
    let mut greater = false;
    let mut less = false;
    for k in incoming.keys().chain(local.keys()) {
        let a = incoming.get(k).copied().unwrap_or(0);
        let b = local.get(k).copied().unwrap_or(0);
        if a > b {
            greater = true;
        }
        if a < b {
            less = true;
        }
    }
    match (greater, less) {
        (false, false) => Order::Equal,
        (true, false) => Order::Newer,
        (false, true) => Order::Older,
        (true, true) => Order::Concurrent,
    }
}

fn merge_vv(a: &BTreeMap<String, i64>, b: &BTreeMap<String, i64>) -> BTreeMap<String, i64> {
    let mut out = a.clone();
    for (k, v) in b {
        let e = out.entry(k.clone()).or_insert(0);
        *e = (*e).max(*v);
    }
    out
}

struct LocalVersion {
    hlc: String,
    origin: String,
    deleted: bool,
    vv: BTreeMap<String, i64>,
}

async fn local_version(conn: &mut SqliteConnection, tbl: &str, pk: &str) -> Result<Option<LocalVersion>> {
    let row: Option<(String, String, i64)> =
        sqlx::query_as("SELECT hlc, origin, deleted FROM sync_rows WHERE tbl = ? AND pk = ?")
            .bind(tbl)
            .bind(pk)
            .fetch_optional(&mut *conn)
            .await
            .map_err(err)?;
    match row {
        None => Ok(None),
        Some((hlc, origin, deleted)) => {
            let vv = vv_of(conn, tbl, pk).await?;
            Ok(Some(LocalVersion { hlc, origin, deleted: deleted != 0, vv }))
        }
    }
}

/// Takes the next local seq.
async fn next_seq(conn: &mut SqliteConnection) -> Result<i64> {
    sqlx::query_scalar("UPDATE sync_state SET seq = seq + 1 WHERE id = 1 RETURNING seq")
        .fetch_one(&mut *conn)
        .await
        .map_err(err)
}

/// Moves this device's clock past a time it has seen, so its next change is
/// ordered after it (the hybrid logical clock's receive rule).
async fn observe_hlc(conn: &mut SqliteConnection, hlc: &str) -> Result<()> {
    let (ms, counter) = parse_hlc(hlc)?;
    let limit = wall_ms() + MAX_CLOCK_LEAD_MS;
    let (ms, counter) = if ms > limit { (limit, 0) } else { (ms, counter) };
    sqlx::query(
        "UPDATE sync_state SET
           hlc_counter = CASE WHEN ?1 > hlc_ms THEN ?2 WHEN ?1 = hlc_ms THEN max(hlc_counter, ?2) ELSE hlc_counter END,
           hlc_ms = max(hlc_ms, ?1)
         WHERE id = 1",
    )
    .bind(ms)
    .bind(counter)
    .execute(&mut *conn)
    .await
    .map_err(err)?;
    Ok(())
}

/// "<13 digits>.<6 digits>": the only shape that sorts correctly as text.
fn parse_hlc(hlc: &str) -> Result<(i64, i64)> {
    let bad = || format!("bad clock value {hlc:?}");
    let (ms, counter) = hlc.split_once('.').ok_or_else(bad)?;
    if ms.len() != 13 || counter.len() != 6 || !ms.bytes().chain(counter.bytes()).all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    Ok((ms.parse().map_err(err)?, counter.parse().map_err(err)?))
}

fn wall_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// How far ahead of this device's own clock a peer's may pull it along: a
/// peer with a clock years ahead must not pin every device's clock there.
const MAX_CLOCK_LEAD_MS: i64 = 24 * 3600 * 1000;

/// A fresh local clock value, as the triggers make them.
async fn tick(conn: &mut SqliteConnection) -> Result<String> {
    sqlx::query_scalar(
        "UPDATE sync_state SET
           hlc_counter = CASE WHEN CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER) > hlc_ms THEN 0
                              WHEN hlc_counter >= 999999 THEN 0 ELSE hlc_counter + 1 END,
           hlc_ms = CASE WHEN CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER) > hlc_ms
                           THEN CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)
                         WHEN hlc_counter >= 999999 THEN hlc_ms + 1 ELSE hlc_ms END
         WHERE id = 1
         RETURNING printf('%013d.%06d', hlc_ms, hlc_counter)",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(err)
}

async fn device_id(conn: &mut SqliteConnection) -> Result<String> {
    sqlx::query_scalar("SELECT device_id FROM sync_state WHERE id = 1")
        .fetch_one(&mut *conn)
        .await
        .map_err(err)
}

/// Records `version` as this device's current one for a row.
async fn record(
    conn: &mut SqliteConnection,
    tbl: &str,
    pk: &str,
    hlc: &str,
    origin: &str,
    deleted: bool,
    vv: &BTreeMap<String, i64>,
    from_peer: Option<&str>,
) -> Result<()> {
    let seq = next_seq(conn).await?;
    sqlx::query(
        "INSERT INTO sync_rows (tbl, pk, hlc, origin, deleted, seq, from_peer) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tbl, pk) DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin,
           deleted = excluded.deleted, seq = excluded.seq, from_peer = excluded.from_peer",
    )
    .bind(tbl)
    .bind(pk)
    .bind(hlc)
    .bind(origin)
    .bind(deleted as i64)
    .bind(seq)
    .bind(from_peer)
    .execute(&mut *conn)
    .await
    .map_err(err)?;
    sqlx::query("DELETE FROM sync_vv WHERE tbl = ? AND pk = ?")
        .bind(tbl)
        .bind(pk)
        .execute(&mut *conn)
        .await
        .map_err(err)?;
    for (device, counter) in vv {
        sqlx::query("INSERT INTO sync_vv (tbl, pk, device, counter) VALUES (?, ?, ?, ?)")
            .bind(tbl)
            .bind(pk)
            .bind(device)
            .bind(counter)
            .execute(&mut *conn)
            .await
            .map_err(err)?;
    }
    Ok(())
}

/// Deletes a row on this device's own authority (a unique-column merge), with
/// a version that supersedes `seen` — so the deletion travels to the peers.
async fn delete_locally(
    conn: &mut SqliteConnection,
    t: &TableInfo,
    pk: &str,
    seen: &BTreeMap<String, i64>,
) -> Result<()> {
    let me = device_id(conn).await?;
    let hlc = tick(conn).await?;
    let mut vv = seen.clone();
    *vv.entry(me.clone()).or_insert(0) += 1;
    sqlx::query(&format!("DELETE FROM {} WHERE {} = ?", quote(&t.name), quote(&t.pk)))
        .bind(pk)
        .execute(&mut *conn)
        .await
        .map_err(err)?;
    record(conn, &t.name, pk, &hlc, &me, true, &vv, None).await
}

fn bind_value<'q>(
    q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    v: &'q Value,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Int(i) => q.bind(*i),
        Value::Real(f) => q.bind(*f),
        Value::Text(s) => q.bind(s.as_str()),
        Value::Blob(b) => q.bind(b.as_slice()),
    }
}

async fn write_row(conn: &mut SqliteConnection, t: &TableInfo, data: &[(String, Value)]) -> Result<()> {
    let cols: Vec<String> = data.iter().map(|(c, _)| quote(c)).collect();
    let updates: Vec<String> = data
        .iter()
        .filter(|(c, _)| c != &t.pk)
        .map(|(c, _)| format!("{0} = excluded.{0}", quote(c)))
        .collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO {}",
        quote(&t.name),
        cols.join(", "),
        vec!["?"; cols.len()].join(", "),
        quote(&t.pk),
        if updates.is_empty() { "NOTHING".to_string() } else { format!("UPDATE SET {}", updates.join(", ")) },
    );
    let mut q = sqlx::query(&sql);
    for (_, v) in data {
        q = bind_value(q, v);
    }
    q.execute(&mut *conn).await.map_err(err)?;
    Ok(())
}

fn value_of<'a>(data: &'a [(String, Value)], col: &str) -> Option<&'a Value> {
    data.iter().find(|(c, _)| c == col).map(|(_, v)| v)
}

/// Another row holding the same values as `data` in one of the table's
/// unique indexes, if there is one.
async fn unique_clash(conn: &mut SqliteConnection, t: &TableInfo, pk: &str, data: &[(String, Value)]) -> Result<Option<String>> {
    for cols in &t.uniques {
        let values: Vec<&Value> = cols.iter().filter_map(|c| value_of(data, c)).collect();
        // A NULL never clashes in a unique index.
        if values.len() != cols.len() || values.iter().any(|v| matches!(v, Value::Null)) {
            continue;
        }
        let cond: Vec<String> = cols.iter().map(|c| format!("{} = ?", quote(c))).collect();
        let sql = format!(
            "SELECT {} FROM {} WHERE {} AND {} <> ? LIMIT 1",
            quote(&t.pk),
            quote(&t.name),
            cond.join(" AND "),
            quote(&t.pk)
        );
        let mut q = sqlx::query_scalar::<_, String>(&sql);
        for v in &values {
            q = match v {
                Value::Null => q.bind(None::<String>),
                Value::Int(i) => q.bind(*i),
                Value::Real(f) => q.bind(*f),
                Value::Text(s) => q.bind(s.as_str()),
                Value::Blob(b) => q.bind(b.as_slice()),
            };
        }
        if let Some(other) = q.bind(pk).fetch_optional(&mut *conn).await.map_err(err)? {
            return Ok(Some(other));
        }
    }
    Ok(None)
}

/// Writes `data` as row `pk`, settling a clash on a unique column by keeping
/// the lower id. False when the incoming row lost and wasn't written.
async fn write_settling_clashes(
    conn: &mut SqliteConnection,
    t: &TableInfo,
    pk: &str,
    data: &[(String, Value)],
    incoming_vv: &BTreeMap<String, i64>,
    stats: &mut ApplyStats,
) -> Result<bool> {
    while let Some(other) = unique_clash(conn, t, pk, data).await? {
        stats.unique_merges += 1;
        if other.as_str() < pk {
            // The existing row keeps its place; the incoming one is deleted
            // everywhere, by a version that has seen it.
            delete_locally(conn, t, pk, incoming_vv).await?;
            return Ok(false);
        }
        let seen = vv_of(conn, &t.name, &other).await?;
        delete_locally(conn, t, &other, &seen).await?;
    }
    write_row(conn, t, data).await?;
    Ok(true)
}

/// The deterministic id of the chat split off from `pk` at `hlc`/`origin`.
fn fork_id(pk: &str, hlc: &str, origin: &str) -> String {
    let d = Sha256::digest(format!("chat-fork:{pk}:{hlc}:{origin}").as_bytes());
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[..16]);
    b[6] = 0x80 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Keeps the losing side of a chat continued on two devices as a chat of its
/// own. Its id, title and version follow from the losing version alone, so
/// both devices create exactly the same one.
async fn fork_chat(
    conn: &mut SqliteConnection,
    t: &TableInfo,
    pk: &str,
    loser_hlc: &str,
    loser_origin: &str,
    loser_vv: &BTreeMap<String, i64>,
    loser_data: &[(String, Value)],
) -> Result<()> {
    let id = fork_id(pk, loser_hlc, loser_origin);
    // The title follows from the losing version alone — not from anything
    // devices might see differently (like what each calls the others) — or
    // two devices would make the same chat under two titles, forever.
    let data: Vec<(String, Value)> = loser_data
        .iter()
        .map(|(c, v)| match (c.as_str(), v) {
            (c, _) if c == t.pk => (c.to_string(), Value::Text(id.clone())),
            ("title", Value::Text(title)) => (c.to_string(), Value::Text(format!("{title} (continued in parallel)"))),
            _ => (c.clone(), v.clone()),
        })
        .collect();
    if local_version(conn, &t.name, &id).await?.is_some() {
        return Ok(());
    }
    write_row(conn, t, &data).await?;
    record(conn, &t.name, &id, loser_hlc, loser_origin, false, loser_vv, None).await
}

async fn apply_one(
    conn: &mut SqliteConnection,
    tables: &BTreeMap<String, TableInfo>,
    from_peer: &str,
    c: &Change,
) -> Result<ApplyStats> {
    let mut stats = ApplyStats::default();
    let t = tables.get(&c.tbl).ok_or_else(|| format!("not a synced table: {:?}", c.tbl))?;
    parse_hlc(&c.hlc)?;
    if let Some(data) = &c.data {
        // Only this table's own columns, all of them, and the key must match.
        let mut got: Vec<&str> = data.iter().map(|(k, _)| k.as_str()).collect();
        got.sort_unstable();
        let mut want: Vec<&str> = t.columns.iter().map(String::as_str).collect();
        want.sort_unstable();
        if got != want {
            return Err(format!("{}: columns {:?} don't match this schema {:?}", t.name, got, want));
        }
        if value_of(data, &t.pk) != Some(&Value::Text(c.pk.clone())) {
            return Err(format!("{}: row key doesn't match its version's", t.name));
        }
    } else if !c.deleted {
        return Err(format!("{} {}: a live version without data", t.name, c.pk));
    }
    observe_hlc(conn, &c.hlc).await?;

    let local = local_version(conn, &c.tbl, &c.pk).await?;
    let order = local.as_ref().map_or(Order::Newer, |l| compare_vv(&c.vv, &l.vv));
    match order {
        Order::Equal | Order::Older => {
            stats.skipped += 1;
        }
        Order::Newer => {
            if c.deleted {
                sqlx::query(&format!("DELETE FROM {} WHERE {} = ?", quote(&t.name), quote(&t.pk)))
                    .bind(&c.pk)
                    .execute(&mut *conn)
                    .await
                    .map_err(err)?;
            } else if !write_settling_clashes(conn, t, &c.pk, c.data.as_deref().unwrap_or(&[]), &c.vv, &mut stats).await? {
                return Ok(stats);
            }
            record(conn, &c.tbl, &c.pk, &c.hlc, &c.origin, c.deleted, &c.vv, Some(from_peer)).await?;
            stats.applied += 1;
        }
        Order::Concurrent => {
            let l = local.expect("concurrent implies a local version");
            stats.conflicts += 1;
            let incoming_wins = (c.hlc.as_str(), c.origin.as_str()) > (l.hlc.as_str(), l.origin.as_str());
            let merged = merge_vv(&c.vv, &l.vv);
            let local_data = if l.deleted { None } else { read_row(conn, t, &c.pk).await? };

            if t.name == "chats" {
                let (loser_hlc, loser_origin, loser_vv, loser_data) = if incoming_wins {
                    (&l.hlc, &l.origin, &l.vv, local_data.clone())
                } else {
                    (&c.hlc, &c.origin, &c.vv, c.data.clone())
                };
                let winner_data = if incoming_wins { c.data.clone() } else { local_data.clone() };
                if let Some(loser) = loser_data {
                    if winner_data.as_ref() != Some(&loser) {
                        fork_chat(conn, t, &c.pk, loser_hlc, loser_origin, loser_vv, &loser).await?;
                        stats.forks += 1;
                    }
                }
            }

            let (hlc, origin, deleted) = if incoming_wins {
                if c.deleted {
                    sqlx::query(&format!("DELETE FROM {} WHERE {} = ?", quote(&t.name), quote(&t.pk)))
                        .bind(&c.pk)
                        .execute(&mut *conn)
                        .await
                        .map_err(err)?;
                } else if !write_settling_clashes(conn, t, &c.pk, c.data.as_deref().unwrap_or(&[]), &merged, &mut stats).await? {
                    return Ok(stats);
                }
                (c.hlc.as_str(), c.origin.as_str(), c.deleted)
            } else {
                (l.hlc.as_str(), l.origin.as_str(), l.deleted)
            };
            // The merged vector is a state neither side had: send it on, to
            // the peer it came from as well.
            record(conn, &c.tbl, &c.pk, hlc, origin, deleted, &merged, None).await?;
        }
    }
    Ok(stats)
}

/// Takes in a batch pulled from `peer` in one transaction, and records that
/// everything up to `batch.upto` has been pulled — both or neither.
pub async fn apply(pool: &SqlitePool, peer: &str, batch: &Batch) -> Result<ApplyStats> {
    // A connection of its own: foreign keys are off while it applies (a child
    // may arrive before its parent's newest version), and that must not leak
    // into the pool.
    let mut conn = pool.acquire().await.map_err(err)?.detach();
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut conn).await.map_err(err)?;
    let result = apply_in(&mut conn, peer, batch).await;
    let _ = conn.close().await;
    result
}

async fn apply_in(conn: &mut SqliteConnection, peer: &str, batch: &Batch) -> Result<ApplyStats> {
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await.map_err(err)?;
    let result = async {
        sqlx::query("UPDATE sync_state SET applying = 1 WHERE id = 1")
            .execute(&mut *conn)
            .await
            .map_err(err)?;
        let tables = synced_tables(conn).await?;
        let mut stats = ApplyStats::default();
        for c in &batch.changes {
            stats.add(apply_one(conn, &tables, peer, c).await.map_err(|e| format!("{} {}: {e}", c.tbl, c.pk))?);
        }
        sqlx::query(
            "INSERT INTO sync_peers (device_id, last_pulled_seq) VALUES (?, ?)
             ON CONFLICT (device_id) DO UPDATE SET last_pulled_seq = max(last_pulled_seq, excluded.last_pulled_seq)",
        )
        .bind(peer)
        .bind(batch.upto)
        .execute(&mut *conn)
        .await
        .map_err(err)?;
        sqlx::query("UPDATE sync_state SET applying = 0 WHERE id = 1")
            .execute(&mut *conn)
            .await
            .map_err(err)?;
        Ok::<_, String>(stats)
    }
    .await;
    match result {
        Ok(stats) => {
            sqlx::query("COMMIT").execute(&mut *conn).await.map_err(err)?;
            Ok(stats)
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(e)
        }
    }
}

/// How far this device has pulled from `peer`.
pub async fn pulled_from(pool: &SqlitePool, peer: &str) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT last_pulled_seq FROM sync_peers WHERE device_id = ?")
        .bind(peer)
        .fetch_optional(pool)
        .await
        .map_err(err)?
        .unwrap_or(0))
}

/// Pulls everything `from` has that `into` hasn't, batch by batch. Used by
/// the tests directly and by the transport over the wire.
pub async fn pull_all(into: &SqlitePool, from: &SqlitePool, batch_rows: i64, batch_bytes: usize) -> Result<ApplyStats> {
    let into_id = local_state(into).await?.device_id;
    let from_id = local_state(from).await?.device_id;
    let mut stats = ApplyStats::default();
    loop {
        let since = pulled_from(into, &from_id).await?;
        let batch = export(from, since, &into_id, batch_rows, batch_bytes).await?;
        stats.add(apply(into, &from_id, &batch).await?);
        if batch.done {
            return Ok(stats);
        }
    }
}

// ---------------------------------------------------------------------------
// After a sync
// ---------------------------------------------------------------------------

/// Removes rows whose parent was deleted on another device while they were
/// being added here, where the parent's deletion would have taken them along
/// (`ON DELETE CASCADE`). Done as ordinary local deletes, so they sync.
///
/// Only a parent known to be deleted (a tombstone here) counts. A parent
/// that simply hasn't arrived yet — a pull cut off between a child and its
/// parent's newest version — is not a deletion, and treating it as one
/// would delete the child on every device.
pub async fn remove_orphans(pool: &SqlitePool) -> Result<u64> {
    let mut conn = pool.acquire().await.map_err(err)?;
    let tables = synced_tables(&mut conn).await?;
    let mut removed = 0;
    for t in tables.values() {
        for (col, parent, parent_col) in &t.cascades {
            let sql = format!(
                "DELETE FROM {t} WHERE {col} IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM {p} WHERE {p}.{pc} = {t}.{col})
                   AND EXISTS (SELECT 1 FROM sync_rows r WHERE r.tbl = ? AND r.pk = {t}.{col} AND r.deleted = 1)",
                t = quote(&t.name),
                col = quote(col),
                p = quote(parent),
                pc = quote(parent_col),
            );
            removed += sqlx::query(&sql).bind(parent).execute(&mut *conn).await.map_err(err)?.rows_affected();
        }
    }
    Ok(removed)
}

/// A fingerprint of everything a device holds, table by table. Two devices
/// whose digests are equal hold the same rows with the same values and the
/// same versions — that's what "the backup is complete" means.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableDigest {
    /// Rows in the table.
    pub rows: i64,
    /// Live versions recorded for it; equal to `rows` unless tracking broke.
    pub tracked: i64,
    /// SHA-256 over every row's values and version, in key order.
    pub hash: String,
}

pub type Digest = BTreeMap<String, TableDigest>;

pub async fn digest(pool: &SqlitePool) -> Result<Digest> {
    let mut conn = pool.acquire().await.map_err(err)?;
    sqlx::query("BEGIN").execute(&mut *conn).await.map_err(err)?;
    let result = digest_in(&mut conn).await;
    let _ = sqlx::query("COMMIT").execute(&mut *conn).await;
    result
}

async fn digest_in(conn: &mut SqliteConnection) -> Result<Digest> {
    let tables = synced_tables(conn).await?;
    let mut out = BTreeMap::new();
    for t in tables.values() {
        let versions: HashMap<String, (String, String)> = sqlx::query_as::<_, (String, String, String)>(
            "SELECT pk, hlc, origin FROM sync_rows WHERE tbl = ? AND deleted = 0",
        )
        .bind(&t.name)
        .fetch_all(&mut *conn)
        .await
        .map_err(err)?
        .into_iter()
        .map(|(pk, h, o)| (pk, (h, o)))
        .collect();
        let tombstones: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT pk, hlc, origin FROM sync_rows WHERE tbl = ? AND deleted = 1 ORDER BY pk",
        )
        .bind(&t.name)
        .fetch_all(&mut *conn)
        .await
        .map_err(err)?;
        let mut cols: Vec<&String> = t.columns.iter().collect();
        cols.sort();
        // A blob is represented by its length: hashing every photo on every
        // sync would read the whole library each time. Photos are named by
        // their content, and the rows around them by their versions.
        let select: Vec<String> = cols
            .iter()
            .map(|c| if t.blob_columns.contains(c) { format!("length({0}) AS {0}", quote(c)) } else { quote(c) })
            .collect();
        let sql = format!("SELECT {} FROM {} ORDER BY {}", select.join(", "), quote(&t.name), quote(&t.pk));
        let mut h = Sha256::new();
        let mut count = 0i64;
        // One row at a time: memory stays flat however big the table.
        let mut stream = sqlx::query(&sql).fetch(&mut *conn);
        use futures_util::TryStreamExt;
        while let Some(row) = stream.try_next().await.map_err(err)? {
            count += 1;
            let values = row_values(&row)?;
            let pk = match value_of(&values, &t.pk) {
                Some(Value::Text(s)) => s.clone(),
                other => format!("{other:?}"),
            };
            h.update(pk.as_bytes());
            if let Some((hlc, origin)) = versions.get(&pk) {
                h.update(hlc.as_bytes());
                h.update(origin.as_bytes());
            }
            h.update(rmp_serde::to_vec(&values).map_err(err)?);
        }
        drop(stream);
        for (pk, hlc, origin) in &tombstones {
            h.update(b"\x00deleted");
            h.update(pk.as_bytes());
            h.update(hlc.as_bytes());
            h.update(origin.as_bytes());
        }
        out.insert(
            t.name.clone(),
            TableDigest { rows: count, tracked: versions.len() as i64, hash: hex::encode(h.finalize()) },
        );
    }
    Ok(out)
}

/// The tables where two digests differ, and any where tracking is off.
pub fn digest_differences(a: &Digest, b: &Digest) -> Vec<String> {
    let mut out = Vec::new();
    for name in a.keys().chain(b.keys()) {
        if out.contains(name) {
            continue;
        }
        match (a.get(name), b.get(name)) {
            (Some(x), Some(y)) if x == y && x.rows == x.tracked => {}
            _ => out.push(name.clone()),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Joining a vault
// ---------------------------------------------------------------------------

/// Tables a fresh install may already have rows in without holding anything
/// of the person's: preferences, unlocked badges, and the vault's devices.
const JOIN_EXEMPT: &[&str] = &["settings", "achievements", "vault_devices", "state_categories"];

/// Whether this device has nothing of its own to lose by joining a vault —
/// the condition for joining at all. Returns the tables holding data if not.
pub async fn data_tables(pool: &SqlitePool) -> Result<Vec<String>> {
    let mut conn = pool.acquire().await.map_err(err)?;
    data_tables_in(&mut conn).await
}

async fn data_tables_in(conn: &mut SqliteConnection) -> Result<Vec<String>> {
    let tables = synced_tables(conn).await?;
    let mut with_data = Vec::new();
    for t in tables.keys() {
        if JOIN_EXEMPT.contains(&t.as_str()) {
            continue;
        }
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {}", quote(t)))
            .fetch_one(&mut *conn)
            .await
            .map_err(err)?;
        if n > 0 {
            with_data.push(t.clone());
        }
    }
    Ok(with_data)
}

/// Empties every synced table and the sync bookkeeping, and gives this device
/// the id `new_id` and the vault's — ready to receive the vault's data.
/// Refuses if any of the person's data is here, checked in the same
/// transaction that empties it, so nothing written meanwhile can be lost.
pub async fn reset_for_join(pool: &SqlitePool, vault_id: &str, new_id: &str) -> Result<()> {
    let mut conn = pool.acquire().await.map_err(err)?.detach();
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut conn).await.map_err(err)?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut conn).await.map_err(err)?;
    let result = async {
        let held = data_tables_in(&mut conn).await?;
        if !held.is_empty() {
            return Err(format!("this device already holds data ({}); joining needs an empty one", held.join(", ")));
        }
        sqlx::query("UPDATE sync_state SET applying = 1 WHERE id = 1").execute(&mut conn).await.map_err(err)?;
        let tables = synced_tables(&mut conn).await?;
        for t in tables.keys() {
            sqlx::query(&format!("DELETE FROM {}", quote(t))).execute(&mut conn).await.map_err(err)?;
        }
        for t in ["sync_rows", "sync_vv", "sync_peers"] {
            sqlx::query(&format!("DELETE FROM {t}")).execute(&mut conn).await.map_err(err)?;
        }
        sqlx::query("UPDATE sync_state SET device_id = ?, vault_id = ?, seq = 0, applying = 0 WHERE id = 1")
            .bind(new_id)
            .bind(vault_id)
            .execute(&mut conn)
            .await
            .map_err(err)?;
        Ok::<_, String>(())
    }
    .await;
    let out = match result {
        Ok(()) => sqlx::query("COMMIT").execute(&mut conn).await.map(|_| ()).map_err(err),
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
            Err(e)
        }
    };
    let _ = conn.close().await;
    out
}
