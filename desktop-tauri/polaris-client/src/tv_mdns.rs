//! Finding TVs by what they announce on the network (multicast DNS, RFC 6762
//! and DNS-SD, RFC 6763).
//!
//! The Rust twin of `desktop/src/main/tv-mdns.ts`. The TypeScript module reads
//! the packets itself; here `mdns-sd` does the asking and the record reading,
//! and what it resolves is collected by the same rules: a TV whose debugging
//! only opens through Wireless debugging pairing (Chromecast with Google TV,
//! Google TV Streamer) never answers on the classic port 5555, so the port sweep
//! cannot see it; it does announce `_adb-tls-pairing._tcp` and
//! `_adb-tls-connect._tcp`, and its Cast record names the model (`md`). What is
//! found here feeds the path engine (`tv_path`) as a `TvSighting`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::net::Ipv4Addr;
use std::time::Duration;

use crate::tv_address::read_tv_address;
use crate::tv_path::{TvService, TvSighting};

/// The DNS-SD service type each `TvService` is announced under, as `mdns-sd` names it.
pub const TV_SERVICE_TYPES: [(TvService, &str); 4] = [
    (TvService::Adb, "_adb._tcp.local."),
    (TvService::AdbTlsConnect, "_adb-tls-connect._tcp.local."),
    (TvService::AdbTlsPairing, "_adb-tls-pairing._tcp.local."),
    (TvService::Googlecast, "_googlecast._tcp.local."),
];

/// One resolved service instance, as discovery heard it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heard {
    pub service: TvService,
    /// The instance name, e.g. `TV-1._googlecast._tcp.local.`.
    pub instance: String,
    pub addresses: Vec<Ipv4Addr>,
    pub port: u16,
    /// Each TXT `key=value`, as announced.
    pub txt: Vec<(String, String)>,
}

/// A TV found by its announcements, with the name it gave itself when it gave one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TvAnnouncement {
    /// In the TypeScript module's order: adb, adb-tls-connect, adb-tls-pairing, googlecast.
    pub services: Vec<TvService>,
    pub cast_model: Option<String>,
    pub name: Option<String>,
    /// The port each service announced: Wireless debugging's TLS and pairing ports move on every switch-on.
    pub ports: BTreeMap<String, u16>,
}

fn service_name(service: TvService) -> &'static str {
    match service {
        TvService::Adb => "adb",
        TvService::AdbTlsConnect => "adb-tls-connect",
        TvService::AdbTlsPairing => "adb-tls-pairing",
        TvService::Googlecast => "googlecast",
    }
}

/// A TXT value by key, without regard to the key's case; an empty value is none.
fn txt_value(entries: &[(String, String)], key: &str) -> Option<String> {
    entries
        .iter()
        .find(|(name, _)| !name.is_empty() && name.to_lowercase() == key)
        .and_then(|(_, value)| Some(value.trim().to_string()).filter(|value| !value.is_empty()))
}

/// Every TV the resolved services announce, by its private address. Instances are matched without regard to case, as DNS does.
pub fn collect_tvs(heard: &[Heard]) -> BTreeMap<String, TvAnnouncement> {
    let mut found: HashMap<String, (BTreeSet<&'static str>, TvAnnouncement)> = HashMap::new();
    for one in heard {
        let Some(address) = one
            .addresses
            .iter()
            .find_map(|address| read_tv_address(&address.to_string()))
        else {
            continue;
        };
        let (services, entry) = found.entry(address).or_default();
        services.insert(service_name(one.service));
        if one.port != 0 {
            entry
                .ports
                .insert(service_name(one.service).to_string(), one.port);
        }
        if one.service == TvService::Googlecast {
            entry.cast_model = txt_value(&one.txt, "md").or(entry.cast_model.take());
            entry.name = txt_value(&one.txt, "fn").or(entry.name.take());
        }
    }
    found
        .into_iter()
        .map(|(address, (services, mut entry))| {
            entry.services = TV_SERVICE_TYPES
                .iter()
                .map(|(service, _)| *service)
                .filter(|service| services.contains(service_name(*service)))
                .collect();
            entry.name = entry.name.or_else(|| entry.cast_model.clone());
            (address, entry)
        })
        .collect()
}

fn numeric(host: &str) -> u64 {
    host.split('.').fold(0u64, |sum, part| {
        sum * 256 + part.parse::<u64>().unwrap_or(0)
    })
}

/// Every TV found, by address: the port sweep's and the announced, one entry per address, in numeric order.
pub fn merge_found(open: &[String], heard: &BTreeMap<String, TvAnnouncement>) -> Vec<String> {
    let all: BTreeSet<&String> = open.iter().chain(heard.keys()).collect();
    let mut hosts: Vec<String> = all.into_iter().cloned().collect();
    hosts.sort_by_key(|host| numeric(host));
    hosts
}

/// The names TVs gave themselves, for the addresses that gave one.
pub fn names_of(heard: &BTreeMap<String, TvAnnouncement>) -> BTreeMap<String, String> {
    heard
        .iter()
        .filter_map(|(host, tv)| tv.name.clone().map(|name| (host.clone(), name)))
        .collect()
}

/// What is known about a TV before connecting: what it announced, and whether the classic port answered.
pub fn sighting_of(heard: Option<&TvAnnouncement>, adb_open: bool) -> TvSighting {
    TvSighting {
        services: heard.map(|tv| tv.services.clone()).unwrap_or_default(),
        cast_model: heard.and_then(|tv| tv.cast_model.clone()),
        adb_open,
    }
}

/// Asks the network for TVs for `listen` and returns what answered, or until
/// `cancel` finishes. Never fails: a network that cannot be asked finds nothing.
pub async fn browse_tvs(
    listen: Duration,
    cancel: impl Future<Output = ()>,
) -> BTreeMap<String, TvAnnouncement> {
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else {
        return BTreeMap::new();
    };
    let mut heard = Vec::new();
    let receivers: Vec<_> = TV_SERVICE_TYPES
        .iter()
        .filter_map(|(service, kind)| {
            daemon
                .browse(kind)
                .ok()
                .map(|receiver| (*service, receiver))
        })
        .collect();
    let collect = async {
        let deadline = tokio::time::Instant::now() + listen;
        loop {
            let next = futures_any(&receivers);
            match tokio::time::timeout_at(deadline, next).await {
                Ok(Some((service, mdns_sd::ServiceEvent::ServiceResolved(resolved)))) => heard
                    .push(Heard {
                        service,
                        instance: resolved.fullname.clone(),
                        addresses: resolved.get_addresses_v4().into_iter().collect(),
                        port: resolved.port,
                        txt: resolved
                            .txt_properties
                            .iter()
                            .map(|property| {
                                (property.key().to_string(), property.val_str().to_string())
                            })
                            .collect(),
                    }),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
    };
    tokio::select! {
        () = collect => {}
        () = cancel => {}
    }
    for (_, kind) in TV_SERVICE_TYPES {
        let _ = daemon.stop_browse(kind);
    }
    let _ = daemon.shutdown();
    collect_tvs(&heard)
}

/// The next event from any of the browses, with the service it is for; None once all have ended.
async fn futures_any(
    receivers: &[(TvService, mdns_sd::Receiver<mdns_sd::ServiceEvent>)],
) -> Option<(TvService, mdns_sd::ServiceEvent)> {
    loop {
        let mut open = false;
        for (service, receiver) in receivers {
            match receiver.try_recv() {
                Ok(event) => return Some((*service, event)),
                Err(mdns_sd::TryRecvError::Empty) => open = true,
                Err(_) => {}
            }
        }
        if !open {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
