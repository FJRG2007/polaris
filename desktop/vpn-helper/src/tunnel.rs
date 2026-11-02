//! The tunnel itself, through a library that drives each system's own way of
//! doing it. Everything goes through it, IPv6 included, so nothing leaks around a
//! tunnel that only carries IPv4.

use crate::server::UpRequest;
use defguard_wireguard_rs::{
    InterfaceConfiguration, WGApi, WireguardInterfaceApi, error::WireguardInterfaceError, key::Key,
    net::IpAddrMask, peer::Peer,
};
use std::{
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    str::FromStr,
    thread::sleep,
    time::{Duration, Instant, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
type Backend = defguard_wireguard_rs::Userspace;
#[cfg(not(target_os = "macos"))]
type Backend = defguard_wireguard_rs::Kernel;

#[cfg(windows)]
const INTERFACE: &str = "Polaris";
#[cfg(target_os = "macos")]
const INTERFACE: &str = "utun99";
#[cfg(all(unix, not(target_os = "macos")))]
const INTERFACE: &str = "polaris0";

const KEEPALIVE_SECONDS: u16 = 25;
/// Long enough for a slow link's first exchange, short enough to feel like an answer.
const HANDSHAKE_WAIT: Duration = Duration::from_secs(8);

/// Why a tunnel did not come up, as a word the app turns into a sentence.
pub type Refusal = &'static str;

pub struct Target {
    public_key: Key,
    private_key: Option<String>,
    preshared_key: Option<Key>,
    addresses: Vec<IpAddrMask>,
    allowed_ips: Vec<IpAddrMask>,
    mtu: Option<u32>,
    dns: Vec<IpAddr>,
    endpoint: SocketAddr,
}

fn network(value: &str) -> Result<IpAddrMask, Refusal> {
    IpAddrMask::from_str(value).map_err(|_| "badRequest")
}

/// Everything from the app is checked before anything is touched.
pub fn parse(request: &UpRequest) -> Result<Target, Refusal> {
    let public_key = Key::from_str(&request.node_public_key).map_err(|_| "badRequest")?;
    let mut addresses = vec![network(&request.address)?];
    let own = request.own.as_ref();
    if let Some(own) = own {
        Key::from_str(&own.private_key).map_err(|_| "badRequest")?;
        for address in &own.more_addresses {
            addresses.push(network(address)?);
        }
    }
    let preshared_key = own
        .and_then(|own| own.preshared_key.as_deref())
        .map(|key| Key::from_str(key).map_err(|_| "badRequest"))
        .transpose()?;
    let allowed_ips = match own {
        Some(own) => own
            .allowed_ips
            .iter()
            .map(|ip| network(ip))
            .collect::<Result<_, _>>()?,
        None => vec![network("0.0.0.0/0")?, network("::/0")?],
    };
    let dns = request
        .dns
        .iter()
        .map(|server| server.parse().map_err(|_| "badRequest"))
        .collect::<Result<Vec<IpAddr>, Refusal>>()?;
    let endpoint = (request.endpoint.as_str(), request.port)
        .to_socket_addrs()
        .map_err(|_| "unreachable")?
        .next()
        .ok_or("unreachable")?;
    Ok(Target {
        public_key,
        private_key: own.map(|own| own.private_key.clone()),
        preshared_key,
        addresses,
        allowed_ips,
        mtu: own.and_then(|own| own.mtu),
        dns,
        endpoint,
    })
}

#[derive(Default)]
pub struct Tunnel {
    live: Option<WGApi<Backend>>,
    node_id: Option<String>,
}

fn start(
    api: &mut WGApi<Backend>,
    private_key: &str,
    target: &Target,
) -> Result<(), WireguardInterfaceError> {
    let mut peer = Peer::new(target.public_key.clone());
    peer.endpoint = Some(target.endpoint);
    peer.persistent_keepalive_interval = Some(KEEPALIVE_SECONDS);
    peer.preshared_key = target.preshared_key.clone();
    peer.allowed_ips = target.allowed_ips.clone();
    api.create_interface()?;
    api.configure_interface(&InterfaceConfiguration {
        name: INTERFACE.to_owned(),
        prvkey: target
            .private_key
            .as_deref()
            .unwrap_or(private_key)
            .to_owned(),
        addresses: target.addresses.clone(),
        port: 0,
        peers: vec![peer.clone()],
        mtu: target.mtu,
        fwmark: None,
    })?;
    api.configure_peer_routing(&[peer])?;
    api.configure_dns(&target.dns, &[])
}

fn server_answered(api: &WGApi<Backend>) -> bool {
    api.read_interface_data().is_ok_and(|host| {
        host.peers
            .values()
            .any(|peer| peer.last_handshake.is_some_and(|at| at > UNIX_EPOCH))
    })
}

fn discard(mut api: WGApi<Backend>) {
    if let Err(error) = api.remove_interface() {
        eprintln!("polaris-vpn: could not remove the interface: {error}");
        // The library stops at a system with no DNS manager, before the interface
        // goes. A tunnel left behind would carry on holding the routes.
        #[cfg(target_os = "linux")]
        let _ = std::process::Command::new("ip")
            .args(["link", "delete", INTERFACE])
            .status();
    }
}

/// Takes down a tunnel this process did not make. A service that was stopped leaves
/// Linux's interface and routes in place, and nothing here would know about them:
/// the status would say off while they held the computer's traffic. Elsewhere the
/// interface ends with the process.
pub fn clear_leftover() {
    #[cfg(target_os = "linux")]
    {
        let found = std::process::Command::new("ip")
            .args(["link", "show", INTERFACE])
            .output()
            .is_ok_and(|shown| shown.status.success());
        if found && let Ok(api) = WGApi::<Backend>::new(INTERFACE.to_owned()) {
            discard(api);
        }
    }
}

impl Tunnel {
    pub fn node_id(&self) -> Option<&str> {
        self.node_id.as_deref()
    }

    pub fn down(&mut self) {
        if let Some(api) = self.live.take() {
            discard(api);
        }
        self.node_id = None;
    }

    /// Connected means the server answered, so that is waited for. Anything less
    /// leaves the computer as it was.
    pub fn up(&mut self, private_key: &str, request: &UpRequest) -> Result<(), Refusal> {
        let target = parse(request)?;
        self.down();
        let mut api = WGApi::<Backend>::new(INTERFACE.to_owned()).map_err(|error| {
            eprintln!("polaris-vpn: {error}");
            "failed"
        })?;
        if let Err(error) = start(&mut api, private_key, &target) {
            eprintln!("polaris-vpn: the tunnel did not start: {error}");
            discard(api);
            return Err("failed");
        }
        let deadline = Instant::now() + HANDSHAKE_WAIT;
        while !server_answered(&api) {
            if Instant::now() >= deadline {
                discard(api);
                return Err("noAnswer");
            }
            sleep(Duration::from_millis(250));
        }
        self.live = Some(api);
        self.node_id = Some(request.node_id.clone());
        Ok(())
    }
}
