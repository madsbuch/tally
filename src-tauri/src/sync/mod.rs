//! Local peer-to-peer sync between the devices of one vault.
//!
//! - `engine`: what changed, and how a device takes in a peer's changes.
//! - `wire`: the encrypted channel between two devices (Noise over TCP).
//! - `session`: one sync between two devices, pairing included.
//! - `discovery`: finding the vault's other devices on the local network.
//! - `service`: the app's side — Tauri commands, the background loop.
//! - `snapshots`: the computer's daily copies of the database.

pub mod engine;
pub mod wire;

#[cfg(test)]
mod tests;

/// A random UUID (v4), for device and vault ids.
pub fn new_uuid() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = 0x40 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
