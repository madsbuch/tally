//! Reaching a device, and saying why it couldn't be reached.
//!
//! A device can be at several addresses (what mDNS announced, IPv6 and IPv4,
//! what the broadcast answered from, where it was last reached), so they're
//! all tried at once and the first to answer wins. When none does, each
//! address's failure says something about why, and `diagnose` turns them
//! into one plain reason, with what to do about it.

use serde::Serialize;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::timeout;

/// How long one address gets to answer.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

/// What went wrong reaching one address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// Nothing came back in time.
    Timeout,
    /// The connection failed outright.
    Io(ErrorKind),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Timeout => write!(f, "no answer"),
            Failure::Io(ErrorKind::ConnectionRefused) => write!(f, "refused"),
            Failure::Io(ErrorKind::HostUnreachable) => write!(f, "host unreachable"),
            Failure::Io(ErrorKind::NetworkUnreachable) => write!(f, "network unreachable"),
            Failure::Io(ErrorKind::PermissionDenied) => write!(f, "not permitted"),
            Failure::Io(k) => write!(f, "{k}"),
        }
    }
}

/// Every address tried, and how each failed.
pub type Failures = Vec<(SocketAddr, Failure)>;

/// Connects to whichever of `addrs` answers first, trying them all at once.
pub async fn connect_first(addrs: &[SocketAddr]) -> Result<(TcpStream, SocketAddr), Failures> {
    let mut tries = JoinSet::new();
    for &addr in addrs {
        tries.spawn(async move {
            let r = match timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
                Ok(Ok(s)) => Ok(s),
                Ok(Err(e)) => Err(Failure::Io(e.kind())),
                Err(_) => Err(Failure::Timeout),
            };
            (addr, r)
        });
    }
    let mut failures = Vec::new();
    while let Some(done) = tries.join_next().await {
        let Ok((addr, r)) = done else { continue };
        match r {
            // Dropping the set cancels the attempts still running.
            Ok(stream) => return Ok((stream, addr)),
            Err(f) => failures.push((addr, f)),
        }
    }
    Err(failures)
}

/// Why a device couldn't be reached, in the order a cause is preferred when
/// its addresses disagree: the most telling first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Why {
    /// It's on the network, but nothing listens: the app isn't running there.
    NotRunning,
    /// This computer keeps the app off the local network.
    Blocked,
    /// It isn't on this device's network, or a VPN is in the way.
    OtherNetwork,
    /// Nothing answers: off, asleep, or out of range.
    NoAnswer,
    /// There's no address for it yet.
    NoAddress,
    /// This device isn't on a local network at all.
    Offline,
    /// Sync isn't listening on this device.
    NotListening,
}

/// A reason, in plain words, with what to do about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub why: Why,
    pub message: String,
    /// Opens the setting that fixes it, when there's one (the Sync page
    /// offers a button that calls `open_network_settings`).
    pub has_setting: bool,
}

/// One of this device's networks.
#[derive(Debug, Clone)]
pub struct LocalNet {
    pub ip: IpAddr,
    pub mask: IpAddr,
    pub iface: String,
}

impl LocalNet {
    fn contains(&self, ip: IpAddr) -> bool {
        match (self.ip, self.mask, ip) {
            (IpAddr::V4(a), IpAddr::V4(m), IpAddr::V4(b)) => u32::from(a) & u32::from(m) == u32::from(b) & u32::from(m),
            (IpAddr::V6(a), IpAddr::V6(m), IpAddr::V6(b)) => u128::from(a) & u128::from(m) == u128::from(b) & u128::from(m),
            _ => false,
        }
    }
}

/// This device's networks, loopback left out.
pub fn local_nets() -> Vec<LocalNet> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .map(|i| {
            let (ip, mask) = match &i.addr {
                if_addrs::IfAddr::V4(a) => (IpAddr::V4(a.ip), IpAddr::V4(a.netmask)),
                if_addrs::IfAddr::V6(a) => (IpAddr::V6(a.ip), IpAddr::V6(a.netmask)),
            };
            LocalNet { ip, mask, iface: i.name.clone() }
        })
        .collect()
}

fn link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// A VPN's tunnel with a routable address: macOS always has a few `utun`
/// interfaces with only link-local addresses, which aren't VPNs.
pub fn vpn_up(nets: &[LocalNet]) -> bool {
    nets.iter().any(|n| {
        let tunnel = ["utun", "tun", "tap", "wg", "ppp", "ipsec"].iter().any(|p| n.iface.starts_with(p));
        tunnel && !link_local(n.ip)
    })
}

/// Why one address failed.
fn why_one(addr: SocketAddr, failure: &Failure, nets: &[LocalNet], macos: bool) -> Why {
    let ip = addr.ip();
    let on_our_network = link_local(ip) || nets.iter().any(|n| n.contains(ip));
    match failure {
        Failure::Io(ErrorKind::ConnectionRefused) => Why::NotRunning,
        Failure::Io(ErrorKind::PermissionDenied) => Why::Blocked,
        // macOS answers a denied Local Network permission with "no route to
        // host", even for a device right there on the Wi-Fi.
        Failure::Io(ErrorKind::HostUnreachable) if macos && on_our_network => Why::Blocked,
        Failure::Io(ErrorKind::NetworkUnreachable) => Why::OtherNetwork,
        _ if !on_our_network => Why::OtherNetwork,
        _ => Why::NoAnswer,
    }
}

/// One reason a device (`name`) couldn't be reached, from how each of its
/// addresses failed.
pub fn diagnose(name: &str, failures: &[(SocketAddr, Failure)], nets: &[LocalNet], macos: bool) -> Problem {
    let why = failures
        .iter()
        .map(|(a, f)| why_one(*a, f, nets, macos))
        .min()
        .unwrap_or(Why::NoAddress);
    problem(name, why, vpn_up(nets))
}

/// The words for a reason.
pub fn problem(name: &str, why: Why, vpn: bool) -> Problem {
    let message = match why {
        Why::NotRunning => format!("{name} is on the network, but Tally isn't running there. Open Tally on {name}."),
        Why::Blocked => "This computer is keeping Tally off the local network. Allow Tally under System Settings → \
             Privacy & Security → Local Network."
            .to_string(),
        Why::OtherNetwork if vpn => format!(
            "{name} isn't on this device's network, or a VPN is in the way. Put both on the same Wi-Fi, and turn the \
             VPN off while they sync."
        ),
        Why::OtherNetwork => format!("{name} is on another network. Put both devices on the same Wi-Fi."),
        Why::NoAnswer if vpn => format!(
            "{name} doesn't answer. Make sure it's on and on the same Wi-Fi, and turn this device's VPN off while \
             they sync."
        ),
        Why::NoAnswer => format!("{name} doesn't answer. Make sure it's on, awake and on the same Wi-Fi."),
        Why::NoAddress => format!(
            "There's no address for {name} yet. Open Tally on {name}, on the same Wi-Fi, and check again."
        ),
        Why::Offline => "This device isn't on a local network. Connect it to the Wi-Fi the other device is on.".to_string(),
        Why::NotListening => "Sync isn't listening on this device, so the others can't reach it. Quit Tally and open it \
             again."
            .to_string(),
    };
    Problem { why, message, has_setting: why == Why::Blocked }
}

/// The setting that lets the app onto the local network, where there is one.
pub const NETWORK_SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork";

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn home() -> Vec<LocalNet> {
        vec![LocalNet {
            ip: IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
            mask: IpAddr::V4(Ipv4Addr::new(255, 255, 255, 0)),
            iface: "en0".into(),
        }]
    }
    fn at(ip: [u8; 4]) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::from(ip)), 47820)
    }

    // Spec: tandem.SYN-24
    #[test]
    fn each_cause_is_told_apart() {
        let nets = home();
        let d = |f: Failure, ip: [u8; 4], mac: bool| diagnose("Phone", &[(at(ip), f)], &nets, mac).why;
        assert_eq!(d(Failure::Io(ErrorKind::ConnectionRefused), [192, 168, 1, 30], false), Why::NotRunning);
        assert_eq!(d(Failure::Timeout, [192, 168, 1, 30], false), Why::NoAnswer);
        assert_eq!(d(Failure::Io(ErrorKind::HostUnreachable), [192, 168, 1, 30], true), Why::Blocked);
        assert_eq!(d(Failure::Io(ErrorKind::HostUnreachable), [192, 168, 1, 30], false), Why::NoAnswer);
        assert_eq!(d(Failure::Timeout, [10, 0, 0, 5], false), Why::OtherNetwork);
        assert_eq!(d(Failure::Io(ErrorKind::NetworkUnreachable), [192, 168, 1, 30], false), Why::OtherNetwork);
        assert_eq!(diagnose("Phone", &[], &nets, false).why, Why::NoAddress);
    }

    // Spec: tandem.SYN-24
    #[test]
    fn the_most_telling_address_wins_and_blocked_leads_to_the_setting() {
        let nets = home();
        let p = diagnose(
            "Phone",
            &[(at([10, 0, 0, 5]), Failure::Timeout), (at([192, 168, 1, 30]), Failure::Io(ErrorKind::ConnectionRefused))],
            &nets,
            false,
        );
        assert_eq!(p.why, Why::NotRunning);
        assert!(p.message.contains("Open Tally on Phone"));
        let blocked = diagnose("Phone", &[(at([192, 168, 1, 30]), Failure::Io(ErrorKind::HostUnreachable))], &nets, true);
        assert!(blocked.has_setting);
        assert!(!p.has_setting);
    }

    #[test]
    fn a_vpn_is_a_tunnel_with_a_routable_address() {
        let mut nets = home();
        nets.push(LocalNet { ip: IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)), mask: IpAddr::V6(Ipv6Addr::UNSPECIFIED), iface: "utun0".into() });
        assert!(!vpn_up(&nets));
        nets.push(LocalNet { ip: IpAddr::V4(Ipv4Addr::new(10, 8, 0, 2)), mask: IpAddr::V4(Ipv4Addr::new(255, 255, 255, 0)), iface: "utun4".into() });
        assert!(vpn_up(&nets));
        assert!(diagnose("Phone", &[(at([192, 168, 1, 30]), Failure::Timeout)], &nets, false).message.contains("VPN"));
    }

    // Spec: tandem.SYN-5
    #[tokio::test]
    async fn the_first_address_to_answer_wins() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let good = listener.local_addr().unwrap();
        // A closed port next to it refuses; the listening one answers.
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        let (_, addr) = connect_first(&[closed, good]).await.unwrap();
        assert_eq!(addr, good);
        let failures = connect_first(&[closed]).await.unwrap_err();
        assert_eq!(failures, vec![(closed, Failure::Io(ErrorKind::ConnectionRefused))]);
    }
}
