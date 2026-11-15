//! The configuration file: INI-style sections of `Key = Value` lines.
//!
//! Section and key names match case-insensitively. `#` and `;` start a comment
//! line. A key the daemon does not know, or a section it does not implement, is
//! refused by name, so a typo fails `--configtest` instead of being ignored.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use base64::Engine as _;

/// The default MTU of the tunnel's interface: WireGuard's usual figure.
pub const DEFAULT_MTU: u16 = 1420;
/// Seconds a UDP flow lives without traffic when its section names none.
pub const DEFAULT_UDP_IDLE: Duration = Duration::from_secs(120);
/// UDP flows one section holds at once when it names no limit.
pub const DEFAULT_UDP_SESSIONS: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

fn err<T>(message: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(message.into()))
}

/// An address and prefix length, as AllowedIPs and Address write them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    pub addr: IpAddr,
    pub prefix: u8,
}

impl Cidr {
    pub fn parse(text: &str) -> Result<Cidr, ConfigError> {
        let (addr, prefix) = match text.split_once('/') {
            Some((addr, prefix)) => (addr, Some(prefix)),
            None => (text, None),
        };
        let Ok(addr) = addr.trim().parse::<IpAddr>() else {
            return err(format!("{text:?} is not an IP address"));
        };
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            None => max,
            Some(p) => match p.trim().parse::<u8>() {
                Ok(p) if p <= max => p,
                _ => return err(format!("{text:?} has no valid prefix length")),
            },
        };
        Ok(Cidr { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - self.prefix)
                };
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - self.prefix)
                };
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interface {
    pub private_key: [u8; 32],
    pub addresses: Vec<Cidr>,
    pub listen_port: Option<u16>,
    pub mtu: u16,
    pub dns: Vec<IpAddr>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub public_key: [u8; 32],
    pub preshared_key: Option<[u8; 32]>,
    /// host:port, resolved when the daemon starts and again while no handshake
    /// succeeds, so a name that moves is followed.
    pub endpoint: Option<String>,
    pub allowed_ips: Vec<Cidr>,
    pub keepalive: Option<u16>,
}

/// Listens on this machine and connects through the tunnel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TcpClient {
    pub bind: SocketAddr,
    pub target: SocketAddr,
}

/// Listens on the tunnel address and connects to a host:port on this side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TcpServer {
    pub listen_port: u16,
    pub target: String,
}

/// Datagrams to `bind` on this machine go through the tunnel to `target`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UdpProxy {
    pub bind: SocketAddr,
    pub target: SocketAddr,
    /// None: a flow ends only when the session cap needs its slot.
    pub idle: Option<Duration>,
    pub max_sessions: usize,
}

/// Datagrams to `listen_port` on the tunnel address go to `target` here, and
/// the replies go back to whoever sent them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UdpServer {
    pub listen_port: u16,
    pub target: String,
    pub idle: Option<Duration>,
    pub max_sessions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub interface: Interface,
    pub peer: Peer,
    pub tcp_clients: Vec<TcpClient>,
    pub tcp_servers: Vec<TcpServer>,
    pub udp_proxies: Vec<UdpProxy>,
    pub udp_servers: Vec<UdpServer>,
}

/// One `[Section]` and its keys, in file order.
struct Section {
    name: String,
    line: usize,
    keys: Vec<(String, String, usize)>,
}

impl Section {
    fn take(&mut self, key: &str) -> Option<String> {
        let at = self
            .keys
            .iter()
            .position(|(k, _, _)| k.eq_ignore_ascii_case(key))?;
        Some(self.keys.remove(at).1)
    }

    fn require(&mut self, key: &str) -> Result<String, ConfigError> {
        match self.take(key) {
            Some(v) => Ok(v),
            None => err(format!(
                "[{}] at line {} has no {key}",
                self.name, self.line
            )),
        }
    }

    fn done(self) -> Result<(), ConfigError> {
        match self.keys.first() {
            Some((k, _, line)) => err(format!("line {line}: [{}] has no key {k}", self.name)),
            None => Ok(()),
        }
    }
}

fn sections(text: &str) -> Result<Vec<Section>, ConfigError> {
    let mut out: Vec<Section> = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line = index + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('[') {
            let Some(name) = rest.strip_suffix(']') else {
                return err(format!("line {line}: a section header is not closed"));
            };
            out.push(Section {
                name: name.trim().to_string(),
                line,
                keys: Vec::new(),
            });
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            return err(format!("line {line}: expected Key = Value"));
        };
        let Some(section) = out.last_mut() else {
            if key.trim().eq_ignore_ascii_case("WGConfig") {
                return err(format!("line {line}: WGConfig is not supported yet"));
            }
            return err(format!(
                "line {line}: {} is outside any section",
                key.trim()
            ));
        };
        section
            .keys
            .push((key.trim().to_string(), value.trim().to_string(), line));
    }
    Ok(out)
}

/// A WireGuard key: 32 bytes in standard base64.
pub fn parse_key(text: &str) -> Result<[u8; 32], ConfigError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|_| ConfigError("a key is not base64".into()))?;
    bytes
        .try_into()
        .map_err(|_| ConfigError("a key is not 32 bytes".into()))
}

/// A private key, or `$NAME` for one read from the environment.
fn private_key(text: &str, env: &dyn Fn(&str) -> Option<String>) -> Result<[u8; 32], ConfigError> {
    match text.strip_prefix('$') {
        Some(name) => match env(name) {
            Some(value) => parse_key(&value),
            None => err(format!("PrivateKey names ${name}, which is not set")),
        },
        None => parse_key(text),
    }
}

fn list(text: &str) -> impl Iterator<Item = &str> {
    text.split(',').map(str::trim).filter(|s| !s.is_empty())
}

fn port(text: &str, what: &str) -> Result<u16, ConfigError> {
    match text.trim().parse::<u16>() {
        Ok(p) if p > 0 => Ok(p),
        _ => err(format!("{what} {text:?} is not a port")),
    }
}

fn socket(text: &str, what: &str) -> Result<SocketAddr, ConfigError> {
    text.trim()
        .parse::<SocketAddr>()
        .map_err(|_| ConfigError(format!("{what} {text:?} is not an address:port")))
}

/// A host:port a name or address may hold, checked for shape only.
fn host_port(text: &str, what: &str) -> Result<String, ConfigError> {
    let Some((host, p)) = text.rsplit_once(':') else {
        return err(format!("{what} {text:?} has no port"));
    };
    port(p, what)?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let plain = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_'));
    if host.is_empty() || !plain {
        return err(format!("{what} {text:?} is not a host:port"));
    }
    Ok(text.trim().to_string())
}

fn seconds(text: Option<String>, default: Duration) -> Result<Option<Duration>, ConfigError> {
    match text {
        None => Ok(Some(default)),
        Some(t) => match t.parse::<u64>() {
            Ok(0) => Ok(None),
            Ok(s) => Ok(Some(Duration::from_secs(s))),
            Err(_) => err(format!(
                "InactivityTimeout {t:?} is not a number of seconds"
            )),
        },
    }
}

fn sessions(text: Option<String>) -> Result<usize, ConfigError> {
    match text {
        None => Ok(DEFAULT_UDP_SESSIONS),
        Some(t) => match t.parse::<usize>() {
            Ok(n) if n > 0 => Ok(n),
            _ => err(format!("MaxSessions {t:?} is not a positive number")),
        },
    }
}

/// Parse a configuration, reading `$NAME` references from the process environment.
pub fn parse(text: &str) -> Result<Config, ConfigError> {
    parse_with_env(text, &|name| std::env::var(name).ok())
}

pub fn parse_with_env(
    text: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Config, ConfigError> {
    let mut interface = None;
    let mut peer = None;
    let mut config_tcp_clients = Vec::new();
    let mut tcp_servers = Vec::new();
    let mut udp_proxies = Vec::new();
    let mut udp_servers = Vec::new();
    for mut s in sections(text)? {
        match s.name.to_ascii_lowercase().as_str() {
            "interface" => {
                if interface.is_some() {
                    return err(format!("line {}: a second [Interface]", s.line));
                }
                let private_key = private_key(&s.require("PrivateKey")?, env)?;
                let addresses = list(&s.require("Address")?)
                    .map(Cidr::parse)
                    .collect::<Result<Vec<_>, _>>()?;
                if addresses.is_empty() {
                    return err("[Interface] Address is empty");
                }
                let listen_port = s
                    .take("ListenPort")
                    .map(|p| port(&p, "ListenPort"))
                    .transpose()?;
                let mtu = match s.take("MTU") {
                    None => DEFAULT_MTU,
                    Some(m) => match m.parse::<u16>() {
                        Ok(m) if (1280..=9000).contains(&m) => m,
                        _ => return err(format!("MTU {m:?} is not between 1280 and 9000")),
                    },
                };
                let dns = match s.take("DNS") {
                    None => Vec::new(),
                    Some(d) => list(&d)
                        .map(|a| {
                            a.parse::<IpAddr>()
                                .map_err(|_| ConfigError(format!("DNS {a:?} is not an IP address")))
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                };
                for unsupported in ["CheckAlive", "CheckAliveInterval"] {
                    if s.take(unsupported).is_some() {
                        return err(format!("{unsupported} is not supported yet"));
                    }
                }
                s.done()?;
                interface = Some(Interface {
                    private_key,
                    addresses,
                    listen_port,
                    mtu,
                    dns,
                });
            }
            "peer" => {
                if peer.is_some() {
                    return err(format!(
                        "line {}: more than one [Peer] is not supported yet",
                        s.line
                    ));
                }
                let public_key = parse_key(&s.require("PublicKey")?)?;
                let preshared_key = s.take("PresharedKey").map(|k| parse_key(&k)).transpose()?;
                let endpoint = s
                    .take("Endpoint")
                    .map(|e| host_port(&e, "Endpoint"))
                    .transpose()?;
                let allowed_ips = list(&s.require("AllowedIPs")?)
                    .map(Cidr::parse)
                    .collect::<Result<Vec<_>, _>>()?;
                let keepalive = match s.take("PersistentKeepalive") {
                    None => None,
                    Some(k) => match k.parse::<u16>() {
                        Ok(0) => None,
                        Ok(k) => Some(k),
                        Err(_) => return err(format!("PersistentKeepalive {k:?} is not a number")),
                    },
                };
                s.done()?;
                peer = Some(Peer {
                    public_key,
                    preshared_key,
                    endpoint,
                    allowed_ips,
                    keepalive,
                });
            }
            "tcpclienttunnel" => {
                let bind = socket(&s.require("BindAddress")?, "BindAddress")?;
                let target = socket(&s.require("Target")?, "Target")?;
                s.done()?;
                config_tcp_clients.push(TcpClient { bind, target });
            }
            "tcpservertunnel" => {
                let listen_port = port(&s.require("ListenPort")?, "ListenPort")?;
                let target = host_port(&s.require("Target")?, "Target")?;
                s.done()?;
                tcp_servers.push(TcpServer {
                    listen_port,
                    target,
                });
            }
            "udpproxytunnel" => {
                let bind = socket(&s.require("BindAddress")?, "BindAddress")?;
                let target = socket(&s.require("Target")?, "Target")?;
                let idle = seconds(s.take("InactivityTimeout"), DEFAULT_UDP_IDLE)?;
                let max_sessions = sessions(s.take("MaxSessions"))?;
                s.done()?;
                udp_proxies.push(UdpProxy {
                    bind,
                    target,
                    idle,
                    max_sessions,
                });
            }
            "udpservertunnel" => {
                let listen_port = port(&s.require("ListenPort")?, "ListenPort")?;
                let target = host_port(&s.require("Target")?, "Target")?;
                let idle = seconds(s.take("InactivityTimeout"), DEFAULT_UDP_IDLE)?;
                let max_sessions = sessions(s.take("MaxSessions"))?;
                s.done()?;
                udp_servers.push(UdpServer {
                    listen_port,
                    target,
                    idle,
                    max_sessions,
                });
            }
            "stdiotunnel" | "socks5" | "http" | "sni" | "resolve" => {
                return err(format!(
                    "line {}: [{}] is not supported yet",
                    s.line, s.name
                ));
            }
            _ => return err(format!("line {}: unknown section [{}]", s.line, s.name)),
        }
    }
    let Some(interface) = interface else {
        return err("there is no [Interface]");
    };
    let Some(peer) = peer else {
        return err("there is no [Peer]");
    };
    let mut tunnel_ports: Vec<u16> = tcp_servers.iter().map(|t| t.listen_port).collect();
    tunnel_ports.sort_unstable();
    if tunnel_ports.windows(2).any(|w| w[0] == w[1]) {
        return err("two [TCPServerTunnel] sections share a ListenPort");
    }
    let mut udp_ports: Vec<u16> = udp_servers.iter().map(|t| t.listen_port).collect();
    udp_ports.sort_unstable();
    if udp_ports.windows(2).any(|w| w[0] == w[1]) {
        return err("two [UDPServerTunnel] sections share a ListenPort");
    }
    Ok(Config {
        interface,
        peer,
        tcp_clients: config_tcp_clients,
        tcp_servers,
        udp_proxies,
        udp_servers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "YNqHbfBQKaGvzefSSGcSzYEx/t0AxgMDDp3c/ajYFlU=";
    const KEY_B: &str = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=";

    fn base(extra: &str) -> String {
        format!("[Interface]\nPrivateKey = {KEY_A}\nAddress = 10.0.0.1/32\n\n[Peer]\nPublicKey = {KEY_B}\nAllowedIPs = 10.0.0.2/32\n{extra}")
    }

    #[test]
    fn reads_every_section() {
        let text = format!(
            "# comment\n[Interface]\nprivatekey = {KEY_A}\nAddress = 10.0.0.1/32, fd00::1/128\nListenPort = 51820\nMTU = 1380\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = {KEY_B}\nPresharedKey = {KEY_B}\nEndpoint = relay.example:51820\nAllowedIPs = 10.0.0.2/32\nPersistentKeepalive = 25\n\n[TCPClientTunnel]\nBindAddress = 0.0.0.0:80\nTarget = 10.0.0.2:80\n\n[TCPServerTunnel]\nListenPort = 443\nTarget = host.docker.internal:443\n\n[UDPProxyTunnel]\nBindAddress = 0.0.0.0:7882\nTarget = 10.0.0.2:7882\nInactivityTimeout = 0\n\n[UDPServerTunnel]\nListenPort = 7882\nTarget = 192.168.1.5:7882\nInactivityTimeout = 30\nMaxSessions = 8\n"
        );
        let c = parse(&text).expect("parses");
        assert_eq!(c.interface.addresses.len(), 2);
        assert_eq!(c.interface.listen_port, Some(51820));
        assert_eq!(c.interface.mtu, 1380);
        assert_eq!(c.interface.dns, vec!["1.1.1.1".parse::<IpAddr>().unwrap()]);
        assert_eq!(c.peer.endpoint.as_deref(), Some("relay.example:51820"));
        assert_eq!(c.peer.keepalive, Some(25));
        assert!(c.peer.preshared_key.is_some());
        assert_eq!(c.tcp_clients[0].target, "10.0.0.2:80".parse().unwrap());
        assert_eq!(c.tcp_servers[0].target, "host.docker.internal:443");
        assert_eq!(c.udp_proxies[0].idle, None);
        assert_eq!(c.udp_servers[0].idle, Some(Duration::from_secs(30)));
        assert_eq!(c.udp_servers[0].max_sessions, 8);
    }

    #[test]
    fn defaults() {
        let c = parse(&base("[UDPServerTunnel]\nListenPort = 1\nTarget = a:1\n")).unwrap();
        assert_eq!(c.interface.mtu, DEFAULT_MTU);
        assert_eq!(c.interface.listen_port, None);
        assert_eq!(c.peer.keepalive, None);
        assert_eq!(c.udp_servers[0].idle, Some(DEFAULT_UDP_IDLE));
        assert_eq!(c.udp_servers[0].max_sessions, DEFAULT_UDP_SESSIONS);
        assert_eq!(
            parse(&base("PersistentKeepalive = 0\n"))
                .unwrap()
                .peer
                .keepalive,
            None
        );
    }

    #[test]
    fn private_key_from_environment() {
        let text = base("").replace(KEY_A, "$WG_KEY");
        let c = parse_with_env(&text, &|n| (n == "WG_KEY").then(|| KEY_A.to_string())).unwrap();
        assert_eq!(c.interface.private_key, parse_key(KEY_A).unwrap());
        assert!(parse_with_env(&text, &|_| None)
            .unwrap_err()
            .0
            .contains("$WG_KEY"));
    }

    #[test]
    fn refusals() {
        let cases = [
            (base("Bogus = 1\n"), "no key Bogus"),
            (base("[Mystery]\n"), "unknown section"),
            (base("[Socks5]\nBindAddress = 127.0.0.1:1080\n"), "not supported yet"),
            (format!("WGConfig = /x\n{}", base("")), "WGConfig"),
            ("Key = 1\n".to_string(), "outside any section"),
            ("[Interface\n".to_string(), "not closed"),
            ("[Interface]\njunk\n".to_string(), "Key = Value"),
            (base("[Peer]\n"), "more than one"),
            (format!("[Interface]\nPrivateKey = {KEY_A}\nAddress = 10.0.0.1\n"), "no [Peer]"),
            (format!("[Peer]\nPublicKey = {KEY_B}\nAllowedIPs = 10.0.0.2\n"), "no [Interface]"),
            (base("[TCPClientTunnel]\nBindAddress = nope\nTarget = 10.0.0.2:1\n"), "BindAddress"),
            (base("[TCPServerTunnel]\nListenPort = 0\nTarget = a:1\n"), "not a port"),
            (base("[TCPServerTunnel]\nListenPort = 1\nTarget = a b:1\n"), "host:port"),
            (base("[TCPServerTunnel]\nListenPort = 1\nTarget = a\n"), "no port"),
            (base("[TCPServerTunnel]\nListenPort = 1\nTarget = a:1\n[TCPServerTunnel]\nListenPort = 1\nTarget = b:1\n"), "share"),
            (base("[UDPServerTunnel]\nListenPort = 1\nTarget = a:1\n[UDPServerTunnel]\nListenPort = 1\nTarget = b:1\n"), "share"),
            (base("[UDPServerTunnel]\nListenPort = 1\nTarget = a:1\nInactivityTimeout = x\n"), "seconds"),
            (base("[UDPServerTunnel]\nListenPort = 1\nTarget = a:1\nMaxSessions = 0\n"), "positive"),
            (base("[TCPServerTunnel]\nListenPort = 1\n"), "no Target"),
        ];
        for (text, expected) in cases {
            let e = parse(&text).unwrap_err();
            assert!(e.0.contains(expected), "{e} should mention {expected}");
        }
        let mut iface = base("").replace("Address = 10.0.0.1/32", "Address = 10.0.0.1/33");
        assert!(parse(&iface).is_err());
        iface = base("").replace("Address = 10.0.0.1/32", "Address = ,");
        assert!(parse(&iface).unwrap_err().0.contains("empty"));
        for bad in [
            "MTU = 100",
            "CheckAlive = 1.1.1.1",
            "ListenPort = 70000",
            "DNS = x",
        ] {
            let t = base("").replace(
                "Address = 10.0.0.1/32",
                &format!("Address = 10.0.0.1/32\n{bad}"),
            );
            assert!(parse(&t).is_err(), "{bad}");
        }
        assert!(parse(&base("PersistentKeepalive = x\n")).is_err());
        assert!(parse(&base("").replace(KEY_B, "short")).is_err());
        assert!(parse(&base("").replace(KEY_B, "AAAA")).is_err());
        let two = format!(
            "{}[Interface]\nPrivateKey = {KEY_A}\nAddress = 10.0.0.3\n",
            base("")
        );
        assert!(parse(&two).unwrap_err().0.contains("second"));
    }

    #[test]
    fn cidr_contains() {
        let net = Cidr::parse("10.213.0.0/16").unwrap();
        assert!(net.contains("10.213.9.9".parse().unwrap()));
        assert!(!net.contains("10.214.0.1".parse().unwrap()));
        assert!(!net.contains("::1".parse().unwrap()));
        assert!(Cidr::parse("0.0.0.0/0")
            .unwrap()
            .contains("8.8.8.8".parse().unwrap()));
        assert!(Cidr::parse("::/0")
            .unwrap()
            .contains("::1".parse().unwrap()));
        assert!(Cidr::parse("fd00::/8")
            .unwrap()
            .contains("fd12::1".parse().unwrap()));
        assert!(!Cidr::parse("fd00::/8")
            .unwrap()
            .contains("fe12::1".parse().unwrap()));
        assert_eq!(Cidr::parse("fd00::1").unwrap().prefix, 128);
        assert!(Cidr::parse("nope/1").is_err());
        assert!(Cidr::parse("10.0.0.1/x").is_err());
    }

    proptest::proptest! {
        #[test]
        fn never_panics_on_any_text(text in "\\PC*") {
            let _ = parse_with_env(&text, &|_| None);
        }

        #[test]
        fn never_panics_on_section_soup(lines in proptest::collection::vec("(\\[[A-Za-z0-9]{0,16}\\]|[A-Za-z]{1,20} ?= ?[ -~]{0,40}|#.*)", 0..30)) {
            let _ = parse_with_env(&lines.join("\n"), &|_| None);
        }
    }
}
