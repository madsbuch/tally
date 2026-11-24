//! Finding the vault's devices over mDNS, beside the broadcast in
//! discovery.rs.
//!
//! Each device announces itself as a `_tally-sync._tcp` service: its sync
//! port, its device id and the vault's tag (never the vault id), at every
//! address it has, IPv6 and IPv4. A device showing a pairing code announces
//! a second service with a tag derived from the code (never the code), so
//! the device that scans it finds it at every address too, not only at the
//! ones the code holds. Everything heard is kept, and asked for by tag.
//!
//! Nothing here is trusted, as with the broadcast: an announcement only says
//! where to knock, and the encrypted handshake decides who's at the door.
//! On Android, multicast arrives only while the app holds a multicast lock
//! (the sync-background plugin takes one while sync runs).

use mdns_sd::{ResolvedService, ScopedIp, ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, SocketAddrV6};
use std::sync::{Arc, Mutex};

pub const SERVICE: &str = "_tally-sync._tcp.local.";

/// What one announcement says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Heard {
    pub vault_tag: Option<String>,
    pub device_id: Option<String>,
    pub pair_tag: Option<String>,
    pub addrs: Vec<SocketAddr>,
}

/// Where an announced address can be dialled: a link-local IPv6 address
/// only through the interface it was heard on.
pub fn dialable(ip: &ScopedIp, port: u16) -> SocketAddr {
    match ip {
        ScopedIp::V4(_) => SocketAddr::new(ip.to_ip_addr(), port),
        ScopedIp::V6(v6) => {
            let addr = *v6.addr();
            let link_local = (addr.segments()[0] & 0xffc0) == 0xfe80;
            let scope = if link_local { v6.scope_id().index } else { 0 };
            SocketAddr::V6(SocketAddrV6::new(addr, port, 0, scope))
        }
        other => SocketAddr::new(other.to_ip_addr(), port),
    }
}

fn heard_from(info: &ResolvedService) -> Heard {
    let txt = |k: &str| info.get_property_val_str(k).map(str::to_string).filter(|s| !s.is_empty());
    let mut addrs: Vec<SocketAddr> = info
        .get_addresses()
        .iter()
        .filter(|ip| !ip.to_ip_addr().is_loopback())
        .map(|ip| dialable(ip, info.port))
        .collect();
    addrs.sort();
    Heard { vault_tag: txt("v"), device_id: txt("d"), pair_tag: txt("p"), addrs }
}

/// The mDNS side of a running app: one daemon, announcing and listening.
pub struct Mdns {
    daemon: ServiceDaemon,
    heard: Arc<Mutex<HashMap<String, Heard>>>,
    /// The full names of what this device announces: itself, and a code.
    device: Mutex<Option<(String, String)>>,
    pairing: Mutex<Option<String>>,
}

fn host_name(device_id: &str) -> String {
    format!("tally-{}.local.", &device_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect::<String>())
}

impl Mdns {
    /// Starts the daemon and listens for every Tally device around. None
    /// when the network has no multicast to offer.
    pub fn start() -> Option<Arc<Mdns>> {
        let daemon = ServiceDaemon::new().map_err(|e| eprintln!("sync: mDNS unavailable: {e}")).ok()?;
        let events = daemon.browse(SERVICE).ok()?;
        let heard: Arc<Mutex<HashMap<String, Heard>>> = Arc::default();
        let into = heard.clone();
        std::thread::Builder::new()
            .name("tally-mdns".into())
            .spawn(move || {
                while let Ok(event) = events.recv() {
                    let Ok(mut h) = into.lock() else { return };
                    match event {
                        ServiceEvent::ServiceResolved(info) => {
                            h.insert(info.fullname.clone(), heard_from(&info));
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            h.remove(&fullname);
                        }
                        _ => {}
                    }
                }
            })
            .ok()?;
        Some(Arc::new(Mdns { daemon, heard, device: Mutex::new(None), pairing: Mutex::new(None) }))
    }

    fn register(&self, instance: &str, device_id: &str, port: u16, props: &[(&str, &str)]) -> Option<String> {
        let props: HashMap<String, String> = props.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let info = ServiceInfo::new(SERVICE, instance, &host_name(device_id), "", port, props)
            .ok()?
            .enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        self.daemon.register(info).map_err(|e| eprintln!("sync: mDNS announce failed: {e}")).ok()?;
        Some(fullname)
    }

    // Spec: tandem.SYN-5
    /// Announces this device for its vault (`tag`), once per change.
    pub fn announce_device(&self, tag: &str, device_id: &str, port: u16) {
        let Ok(mut current) = self.device.lock() else { return };
        let key = format!("{tag} {device_id} {port}");
        if current.as_ref().is_some_and(|(k, _)| *k == key) {
            return;
        }
        if let Some((_, old)) = current.take() {
            let _ = self.daemon.unregister(&old);
        }
        if let Some(full) = self.register(device_id, device_id, port, &[("v", tag), ("d", device_id)]) {
            *current = Some((key, full));
        }
    }

    // Spec: tandem.SYN-25
    /// Announces a pairing code's tag while the code is on screen.
    pub fn announce_pairing(&self, pair_tag: &str, device_id: &str, port: u16) {
        self.stop_pairing();
        let instance = format!("pair-{pair_tag}");
        if let (Some(full), Ok(mut p)) = (self.register(&instance, device_id, port, &[("p", pair_tag)]), self.pairing.lock()) {
            *p = Some(full);
        }
    }

    pub fn stop_pairing(&self) {
        if let Some(old) = self.pairing.lock().ok().and_then(|mut p| p.take()) {
            let _ = self.daemon.unregister(&old);
        }
    }

    fn all(&self) -> Vec<Heard> {
        self.heard.lock().map(|h| h.values().cloned().collect()).unwrap_or_default()
    }

    /// The vault's devices heard, by id, with every address each announced.
    pub fn devices(&self, vault_tag: &str) -> Vec<(String, Vec<SocketAddr>)> {
        self.all()
            .into_iter()
            .filter(|h| h.vault_tag.as_deref() == Some(vault_tag))
            .filter_map(|h| Some((h.device_id?, h.addrs)))
            .collect()
    }

    /// Where a device answers, whatever vault it announces.
    pub fn device_addrs(&self, device_id: &str) -> Vec<SocketAddr> {
        self.all()
            .into_iter()
            .filter(|h| h.device_id.as_deref() == Some(device_id))
            .flat_map(|h| h.addrs)
            .collect()
    }

    /// Where the device showing the code with this tag answers.
    pub fn pairing(&self, pair_tag: &str) -> Vec<SocketAddr> {
        self.all()
            .into_iter()
            .filter(|h| h.pair_tag.as_deref() == Some(pair_tag))
            .flat_map(|h| h.addrs)
            .collect()
    }
}

/// Addresses in the order to try them, without repeats: IPv6 and IPv4 are
/// tried all at once, so the order only breaks ties.
pub fn merge(lists: &[&[SocketAddr]]) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    for a in lists.iter().flat_map(|l| l.iter()) {
        if !out.contains(a) && !matches!(a.ip(), IpAddr::V4(v4) if v4.is_unspecified()) {
            out.push(*a);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two devices on one machine: each hears what the other announces.
    /// Needs a network interface that carries multicast.
    // Spec: tandem.SYN-5, tandem.SYN-25
    #[test]
    #[ignore = "needs a network that carries multicast"]
    fn a_device_and_a_pairing_code_are_heard_by_another_device() {
        let a = Mdns::start().expect("mDNS");
        let b = Mdns::start().expect("mDNS");
        a.announce_device("vaulttag", "device-a", 47822);
        a.announce_pairing("pairtag", "device-a", 47822);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline && (b.devices("vaulttag").is_empty() || b.pairing("pairtag").is_empty()) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let found = b.devices("vaulttag");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "device-a");
        assert!(found[0].1.iter().all(|s| s.port() == 47822) && !found[0].1.is_empty());
        assert!(!b.pairing("pairtag").is_empty());
        assert!(b.devices("othertag").is_empty());
        a.stop_pairing();
    }

    // Spec: tandem.SYN-5
    #[test]
    fn addresses_from_every_source_are_tried_once() {
        let a: SocketAddr = "192.168.1.5:47820".parse().unwrap();
        let b: SocketAddr = "[fd00::5]:47820".parse().unwrap();
        let c: SocketAddr = "192.168.1.9:47820".parse().unwrap();
        assert_eq!(merge(&[&[a, b], &[a, c], &[b]]), vec![a, b, c]);
    }
}
