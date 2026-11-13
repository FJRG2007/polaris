//! What discovery collects from resolved announcements, and how it feeds the path engine.

use std::collections::BTreeMap;
use std::net::Ipv4Addr;

use polaris_client::tv_address::read_tv_address;
use polaris_client::tv_mdns::*;
use polaris_client::tv_path::{choose_path, TvRoute, TvService};

fn heard(
    service: TvService,
    instance: &str,
    address: [u8; 4],
    port: u16,
    txt: &[(&str, &str)],
) -> Heard {
    Heard {
        service,
        instance: instance.into(),
        addresses: vec![Ipv4Addr::from(address)],
        port,
        txt: txt
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
    }
}

/// A Chromecast with Google TV: Cast and Wireless debugging pairing, no classic port.
fn chromecast() -> Vec<Heard> {
    vec![
        heard(
            TvService::Googlecast,
            "Chromecast-1._googlecast._tcp.local.",
            [192, 168, 1, 40],
            8009,
            &[("md", "Chromecast HD"), ("fn", "Living Room TV")],
        ),
        heard(
            TvService::AdbTlsPairing,
            "adb-1._adb-tls-pairing._tcp.local.",
            [192, 168, 1, 40],
            37215,
            &[],
        ),
    ]
}

#[test]
fn knows_a_chromecast_with_google_tv_by_its_model_and_as_pairing_only() {
    let found = collect_tvs(&chromecast());
    assert_eq!(found.keys().collect::<Vec<_>>(), vec!["192.168.1.40"]);
    let tv = &found["192.168.1.40"];
    let ports: BTreeMap<String, u16> = [
        ("adb-tls-pairing".to_string(), 37215),
        ("googlecast".to_string(), 8009),
    ]
    .into();
    assert_eq!(
        *tv,
        TvAnnouncement {
            services: vec![TvService::AdbTlsPairing, TvService::Googlecast],
            cast_model: Some("Chromecast HD".into()),
            name: Some("Living Room TV".into()),
            ports,
        }
    );
    let path = choose_path(&sighting_of(Some(tv), false), None);
    assert_eq!(path.route, TvRoute::Pairing);
    assert_eq!(path.reason.as_deref(), Some("google-pairing"));
}

#[test]
fn sees_classic_network_debugging_with_no_name() {
    let found = collect_tvs(&[heard(
        TvService::Adb,
        "adb-X._adb._tcp.local.",
        [192, 168, 1, 51],
        5555,
        &[],
    )]);
    let tv = &found["192.168.1.51"];
    assert_eq!(tv.services, vec![TvService::Adb]);
    assert_eq!(tv.name, None);
    assert_eq!(
        choose_path(&sighting_of(Some(tv), false), None).route,
        TvRoute::Network
    );
}

#[test]
fn joins_services_of_one_address_reads_txt_keys_in_any_case_and_names_by_model() {
    let found = collect_tvs(&[
        heard(
            TvService::Googlecast,
            "TV-1._googlecast._tcp.local.",
            [10, 0, 0, 7],
            0,
            &[("MD", "BRAVIA 4K VH2")],
        ),
        heard(
            TvService::Adb,
            "adb-X._adb._tcp.local.",
            [10, 0, 0, 7],
            0,
            &[],
        ),
    ]);
    assert_eq!(found.len(), 1);
    assert_eq!(
        found["10.0.0.7"],
        TvAnnouncement {
            services: vec![TvService::Adb, TvService::Googlecast],
            cast_model: Some("BRAVIA 4K VH2".into()),
            name: Some("BRAVIA 4K VH2".into()),
            ports: BTreeMap::new(),
        }
    );
}

#[test]
fn ignores_public_addresses() {
    assert!(collect_tvs(&[heard(
        TvService::Adb,
        "adb._adb._tcp.local.",
        [8, 8, 8, 8],
        5555,
        &[]
    )])
    .is_empty());
}

#[test]
fn lists_each_address_once_in_numeric_order_whether_the_sweep_or_an_announcement_found_it() {
    let mut all = chromecast();
    all.push(heard(
        TvService::Adb,
        "adb._adb._tcp.local.",
        [192, 168, 1, 100],
        5555,
        &[],
    ));
    let found = collect_tvs(&all);
    let open = vec!["192.168.1.100".to_string(), "192.168.1.9".to_string()];
    assert_eq!(
        merge_found(&open, &found),
        vec!["192.168.1.9", "192.168.1.40", "192.168.1.100"]
    );
    let names: BTreeMap<String, String> =
        [("192.168.1.40".to_string(), "Living Room TV".to_string())].into();
    assert_eq!(names_of(&found), names);
}

#[test]
fn gives_the_engine_what_the_tv_announced_so_a_pairing_only_tv_needs_pairing_before_any_wait() {
    let found = collect_tvs(&chromecast());
    let tv = found.get("192.168.1.40");
    assert_eq!(
        choose_path(&sighting_of(tv, false), None).route,
        TvRoute::Pairing
    );
    assert_eq!(
        choose_path(&sighting_of(tv, true), None).route,
        TvRoute::Network
    );
    assert_eq!(
        choose_path(&sighting_of(None, false), None).route,
        TvRoute::Network
    );
}

#[test]
fn reads_only_private_ipv4_addresses() {
    assert_eq!(
        read_tv_address(" 192.168.001.2 ").as_deref(),
        Some("192.168.1.2")
    );
    assert_eq!(read_tv_address("172.16.0.1").as_deref(), Some("172.16.0.1"));
    assert_eq!(read_tv_address("172.32.0.1"), None);
    assert_eq!(read_tv_address("10.0.0.256"), None);
    assert_eq!(read_tv_address("8.8.8.8"), None);
    assert_eq!(read_tv_address("tv.local"), None);
    assert_eq!(read_tv_address("10.0.0"), None);
}
