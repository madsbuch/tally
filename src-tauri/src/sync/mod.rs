//! Local peer-to-peer sync between the devices of one vault.
//!
//! - `engine`: what changed, and how a device takes in a peer's changes.
//! - `wire`: the encrypted channel between two devices (Noise over TCP).
//! - `session`: one sync between two devices, pairing included.
//! - `discovery`: finding the vault's other devices on the local network.
//! - `service`: the app's side — Tauri commands, the background loop.
//! - `snapshots`: the computer's daily copies of the database.
//! - `instance`: noticing a database restored from an older copy.
//! - `background`: a sync with the app closed (Android, through JNI).

pub mod background;
pub mod discovery;
pub mod engine;
pub mod instance;
pub mod service;
pub mod session;
pub mod snapshots;
pub mod wire;

#[cfg(test)]
pub(crate) mod tests;
/// Regression tests from an adversarial review of the first version.
#[cfg(test)]
mod review_tests;

/// A random UUID (v4), for device and vault ids.
pub fn new_uuid() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = 0x40 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// "YYYY-MM-DD" of a day number (days since 1970-01-01).
pub fn civil_date(days: i64) -> String {
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Now, as the app writes timestamps: UTC, to the millisecond.
pub fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let rem = ms.rem_euclid(86_400_000);
    format!(
        "{}T{:02}:{:02}:{:02}.{:03}Z",
        civil_date(ms.div_euclid(86_400_000)),
        rem / 3_600_000,
        rem % 3_600_000 / 60_000,
        rem % 60_000 / 1000,
        rem % 1000
    )
}
