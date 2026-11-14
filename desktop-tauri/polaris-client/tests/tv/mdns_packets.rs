//! Reading the announcements off the wire, and asking for them without listening
//! for the network: the twin of `desktop/test/main/tv-mdns.test.ts`, on responses
//! built the way `desktop/test/fixtures/mdns.ts` builds them (RFC 1035 / 6762,
//! with name compression as real responders use it). Every serial, uuid and
//! address here is made up.

use std::collections::{BTreeMap, HashMap};
use std::net::Ipv4Addr;
use std::time::Duration;

use polaris_client::tv_mdns::*;
use polaris_client::tv_path::{choose_path, TvRoute, TvService};

enum Rr<'a> {
    Ptr(&'a str, &'a str),
    Srv(&'a str, u16, &'a str),
    A(&'a str, [u8; 4]),
    Txt(&'a str, &'a [&'a str]),
}

/// Writes names with compression: a suffix written before is pointed at, not repeated.
struct Writer {
    out: Vec<u8>,
    seen: HashMap<String, usize>,
}

impl Writer {
    /// `name` encoded as if it started `ahead` bytes past what is written so far.
    fn name(&mut self, name: &str, ahead: usize) -> Vec<u8> {
        let labels: Vec<&str> = name.split('.').collect();
        let mut encoded = Vec::new();
        for index in 0..labels.len() {
            let suffix = labels[index..].join(".").to_lowercase();
            if let Some(pointer) = self.seen.get(&suffix) {
                encoded.extend_from_slice(&(0xc000 | *pointer as u16).to_be_bytes());
                return encoded;
            }
            self.seen
                .insert(suffix, self.out.len() + ahead + encoded.len());
            encoded.push(labels[index].len() as u8);
            encoded.extend_from_slice(labels[index].as_bytes());
        }
        encoded.push(0);
        encoded
    }
}

/// A response (QR bit set) carrying `answers` then `additional`, each record class IN with cache-flush.
fn response(answers: &[Rr], additional: &[Rr]) -> Vec<u8> {
    let mut writer = Writer {
        out: Vec::new(),
        seen: HashMap::new(),
    };
    for value in [
        0,
        0x8400,
        0,
        answers.len() as u16,
        0,
        additional.len() as u16,
    ] {
        writer.out.extend_from_slice(&u16::to_be_bytes(value));
    }
    for record in answers.iter().chain(additional) {
        let (name, kind) = match record {
            Rr::Ptr(name, _) => (*name, 12u16),
            Rr::Srv(name, _, _) => (*name, 33),
            Rr::A(name, _) => (*name, 1),
            Rr::Txt(name, _) => (*name, 16),
        };
        let encoded = writer.name(name, 0);
        writer.out.extend_from_slice(&encoded);
        writer.out.extend_from_slice(&kind.to_be_bytes());
        writer
            .out
            .extend_from_slice(&[0x80, 0x01, 0, 0, 0x11, 0x94]);
        // The rdata's names are compressed against what was written, starting after the length field.
        let rdata = match record {
            Rr::Ptr(_, target) => writer.name(target, 2),
            Rr::Srv(_, port, target) => {
                let mut rdata = vec![0, 0, 0, 0];
                rdata.extend_from_slice(&port.to_be_bytes());
                rdata.extend(writer.name(target, 8));
                rdata
            }
            Rr::A(_, address) => address.to_vec(),
            Rr::Txt(_, entries) => entries
                .iter()
                .flat_map(|entry| std::iter::once(entry.len() as u8).chain(entry.bytes()))
                .collect(),
        };
        writer
            .out
            .extend_from_slice(&(rdata.len() as u16).to_be_bytes());
        writer.out.extend(rdata);
    }
    writer.out
}

/// A Chromecast with Google TV: Cast record, and Wireless debugging's pairing service only.
fn chromecast_google_tv() -> Vec<u8> {
    response(
        &[
            Rr::Ptr(
                "_googlecast._tcp.local",
                "Chromecast-HD-0a1b2c3d4e5f._googlecast._tcp.local",
            ),
            Rr::Ptr(
                "_adb-tls-pairing._tcp.local",
                "adb-FIXTURE0001-AbCdEf._adb-tls-pairing._tcp.local",
            ),
        ],
        &[
            Rr::Txt(
                "Chromecast-HD-0a1b2c3d4e5f._googlecast._tcp.local",
                &[
                    "id=0a1b2c3d4e5f",
                    "md=Chromecast HD",
                    "fn=Living Room TV",
                    "ve=05",
                ],
            ),
            Rr::Srv(
                "Chromecast-HD-0a1b2c3d4e5f._googlecast._tcp.local",
                8009,
                "0a1b2c3d-fixture.local",
            ),
            Rr::Srv(
                "adb-FIXTURE0001-AbCdEf._adb-tls-pairing._tcp.local",
                37215,
                "Android.local",
            ),
            Rr::A("0a1b2c3d-fixture.local", [192, 168, 1, 40]),
            Rr::A("Android.local", [192, 168, 1, 40]),
        ],
    )
}

/// An Android TV with network debugging on: the classic `_adb._tcp` service, no address record.
fn android_tv_adb() -> Vec<u8> {
    response(
        &[Rr::Ptr(
            "_adb._tcp.local",
            "adb-FIXTURE0002._adb._tcp.local",
        )],
        &[],
    )
}

/// A printer on the same network: not a TV service, so nothing is taken from it.
fn printer() -> Vec<u8> {
    response(
        &[Rr::Ptr("_ipp._tcp.local", "Office Printer._ipp._tcp.local")],
        &[Rr::A("printer.local", [192, 168, 1, 9])],
    )
}

fn packet(data: Vec<u8>, from: [u8; 4]) -> MdnsPacket {
    MdnsPacket {
        data,
        from: Ipv4Addr::from(from),
    }
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([bytes[at], bytes[at + 1]])
}

#[test]
fn asks_for_each_tv_service_as_a_ptr_question_that_wants_a_unicast_answer() {
    let query = tv_query();
    assert_eq!(u16_at(&query, 2), 0);
    assert_eq!(u16_at(&query, 4), 4);
    for (_, kind) in TV_SERVICE_TYPES {
        let encoded: Vec<u8> = kind
            .split('.')
            .flat_map(|label| std::iter::once(label.len() as u8).chain(label.bytes()))
            .collect();
        let at = query
            .windows(encoded.len())
            .position(|window| window == encoded.as_slice())
            .expect("question present");
        assert!(at > 0);
        let tail = at + encoded.len() + 1;
        assert_eq!(u16_at(&query, tail), 12);
        assert_eq!(u16_at(&query, tail + 2), 0x8001);
    }
}

#[test]
fn reads_ptr_txt_srv_and_a_records_through_compressed_names() {
    let records = parse_mdns(&chromecast_google_tv());
    assert!(records.contains(&MdnsRecord {
        name: "_googlecast._tcp.local".into(),
        kind: 12,
        data: MdnsData::Name("Chromecast-HD-0a1b2c3d4e5f._googlecast._tcp.local".into()),
        port: None,
    }));
    assert!(records.contains(&MdnsRecord {
        name: "adb-FIXTURE0001-AbCdEf._adb-tls-pairing._tcp.local".into(),
        kind: 33,
        data: MdnsData::Name("Android.local".into()),
        port: Some(37215),
    }));
    assert!(records.contains(&MdnsRecord {
        name: "Android.local".into(),
        kind: 1,
        data: MdnsData::Name("192.168.1.40".into()),
        port: None,
    }));
    let txt = records.iter().find(|record| record.kind == 16).unwrap();
    assert!(
        matches!(&txt.data, MdnsData::Entries(entries) if entries.contains(&"md=Chromecast HD".to_string()))
    );
}

#[test]
fn reads_a_query_a_truncated_packet_and_a_pointer_loop_as_nothing() {
    assert!(parse_mdns(&tv_query()).is_empty());
    assert!(parse_mdns(&chromecast_google_tv()[..40]).is_empty());
    assert!(parse_mdns(&[0; 4]).is_empty());
    assert!(parse_mdns(&[0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12]).is_empty());
}

#[test]
fn knows_a_chromecast_with_google_tv_from_its_packet_by_its_model_and_as_pairing_only() {
    let found = collect_packets(&[packet(chromecast_google_tv(), [192, 168, 1, 40])]);
    assert_eq!(found.keys().collect::<Vec<_>>(), vec!["192.168.1.40"]);
    let ports: BTreeMap<String, u16> = [
        ("adb-tls-pairing".to_string(), 37215),
        ("googlecast".to_string(), 8009),
    ]
    .into();
    let tv = &found["192.168.1.40"];
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
fn takes_the_senders_address_when_no_address_record_came() {
    let found = collect_packets(&[packet(android_tv_adb(), [192, 168, 1, 51])]);
    let tv = &found["192.168.1.51"];
    assert_eq!(tv.services, vec![TvService::Adb]);
    assert_eq!(tv.name, None);
    assert_eq!(
        choose_path(&sighting_of(Some(tv), false), None).route,
        TvRoute::Network
    );
}

#[test]
fn joins_records_that_came_in_separate_packets_and_dedupes_by_address() {
    let ptr = response(
        &[Rr::Ptr(
            "_googlecast._tcp.local",
            "TV-1._googlecast._tcp.local",
        )],
        &[],
    );
    let txt = response(
        &[Rr::Txt(
            "tv-1._googlecast._tcp.local",
            &["MD=BRAVIA 4K VH2"],
        )],
        &[],
    );
    let adb = response(&[Rr::Ptr("_adb._tcp.local", "adb-X._adb._tcp.local")], &[]);
    let found = collect_packets(&[
        packet(ptr, [10, 0, 0, 7]),
        packet(txt, [10, 0, 0, 7]),
        packet(adb, [10, 0, 0, 7]),
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
fn ignores_other_services_and_public_senders() {
    assert!(collect_packets(&[packet(printer(), [192, 168, 1, 9])]).is_empty());
    assert!(collect_packets(&[packet(android_tv_adb(), [8, 8, 8, 8])]).is_empty());
}

#[test]
fn sends_again_before_each_three_second_window_ends_for_the_whole_listen() {
    assert!(RESEND < Duration::from_secs(3));
    assert_eq!(
        ask_times(Duration::from_secs(3)),
        vec![
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::from_secs(2)
        ]
    );
    for listen in [500u64, 1_500, 3_000, 10_000, 60_000].map(Duration::from_millis) {
        let times = ask_times(listen);
        assert_eq!(times[0], Duration::ZERO);
        for pair in times.windows(2) {
            assert!(pair[1] - pair[0] < Duration::from_secs(3));
        }
        let last = *times.last().unwrap();
        assert!(last + Duration::from_secs(3) >= listen);
        assert!(last < listen);
    }
}

#[tokio::test]
async fn binds_the_address_it_is_given_on_a_port_the_system_picks_never_5353() {
    let socket = open_query_socket(Ipv4Addr::LOCALHOST).unwrap();
    let address = socket.local_addr().unwrap();
    assert_eq!(address.ip(), Ipv4Addr::LOCALHOST);
    assert_ne!(address.port(), 5353);
    assert_ne!(address.port(), 0);
}

#[tokio::test]
async fn a_search_ends_on_time_or_on_cancel_and_finds_nothing_without_failing() {
    let started = std::time::Instant::now();
    let found = browse_on(
        &[Ipv4Addr::LOCALHOST],
        Duration::from_millis(300),
        std::future::pending(),
    )
    .await;
    assert!(found.is_empty());
    assert!(started.elapsed() < Duration::from_secs(2));
    let cancelled = browse_on(
        &[Ipv4Addr::LOCALHOST],
        Duration::from_secs(30),
        std::future::ready(()),
    )
    .await;
    assert!(cancelled.is_empty());
    assert!(
        browse_on(&[], Duration::from_secs(30), std::future::pending())
            .await
            .is_empty()
    );
}
