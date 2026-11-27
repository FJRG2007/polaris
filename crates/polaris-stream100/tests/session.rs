//! The plain-USB session: what is sent at start, and the keep-alive.

use polaris_stream100::display::{is_valid, PACKET_SIZE};
use polaris_stream100::session::{
    keepalive_due, read_slice, KeepAlive, VendorRead, DEVICE_INTERFACE_GUID,
    DEVICE_INTERFACE_GUID_U128, FORBIDDEN_REQUESTS, INIT_READS, KEEPALIVE_EVERY,
};
use std::time::Duration;

#[test]
fn the_start_up_reads_are_the_documented_vendor_reads() {
    let setups: Vec<_> = INIT_READS.iter().map(|read| read.setup()).collect();
    assert_eq!(
        setups,
        vec![Some((0xc0, 0x52, 0, 0, 2)), Some((0xc0, 0x02, 0, 0, 2))]
    );
}

#[test]
fn the_firmware_updater_request_can_never_be_built() {
    for request in FORBIDDEN_REQUESTS {
        for value in [0u16, 1, 0xffff] {
            let read = VendorRead {
                request,
                value,
                length: 2,
            };
            assert_eq!(read.setup(), None);
        }
    }
    // Anything outside the start-up reads is refused too.
    let other = VendorRead {
        request: 0x52,
        value: 1,
        length: 9,
    };
    assert_eq!(other.setup(), None);
    assert!(INIT_READS.iter().all(|read| read.request != 0xf2));
}

#[test]
fn a_keep_alive_is_one_valid_packet_numbered_in_order() {
    let mut keepalive = KeepAlive::default();
    let first = keepalive.next_packet();
    let second = keepalive.next_packet();
    assert_eq!(first.len(), PACKET_SIZE);
    assert!(is_valid(&first[..9]));
    assert_eq!(&first[..2], b"SM");
    assert_eq!(u16::from_le_bytes([first[2], first[3]]), 9);
    assert_eq!(first[8], 0x00);
    assert!(first[9..].iter().all(|byte| *byte == 0));
    assert_eq!(u16::from_le_bytes([first[6], first[7]]), 0);
    assert_eq!(u16::from_le_bytes([second[6], second[7]]), 1);
    assert!(is_valid(&second[..9]));
}

#[test]
fn the_keep_alive_goes_out_at_least_twice_a_second() {
    assert!(KEEPALIVE_EVERY <= Duration::from_millis(500));
    assert!(keepalive_due(None));
    assert!(!keepalive_due(Some(Duration::from_millis(100))));
    assert!(keepalive_due(Some(KEEPALIVE_EVERY)));
    // A read never blocks past the next keep-alive.
    assert_eq!(
        read_slice(Duration::from_millis(500), Duration::from_millis(100)),
        KEEPALIVE_EVERY - Duration::from_millis(100)
    );
    assert_eq!(
        read_slice(Duration::from_millis(20), Duration::ZERO),
        Duration::from_millis(20)
    );
    assert_eq!(
        read_slice(Duration::from_millis(500), Duration::from_secs(1)),
        Duration::ZERO
    );
}

#[test]
fn the_interface_guid_string_and_number_agree() {
    let hex: String = DEVICE_INTERFACE_GUID
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();
    assert_eq!(
        u128::from_str_radix(&hex, 16).unwrap(),
        DEVICE_INTERFACE_GUID_U128
    );
}

/// A link that records what the session asks of it.
#[derive(Default)]
struct Recorder {
    display: bool,
    controls: Vec<polaris_stream100::session::Setup>,
    packets: Vec<[u8; PACKET_SIZE]>,
    reports: Vec<Vec<u8>>,
    waits: Vec<Duration>,
}

impl polaris_stream100::session::Link for Recorder {
    type Error = ();

    fn control_in(&mut self, setup: polaris_stream100::session::Setup) {
        self.controls.push(setup);
    }

    fn start_display(&mut self) -> bool {
        self.display
    }

    fn write_packet(&mut self, packet: &[u8; PACKET_SIZE], _wait: Duration) {
        self.packets.push(*packet);
    }

    fn read_report(
        &mut self,
        buffer: &mut [u8; polaris_stream100::report::REPORT_LEN],
        wait: Duration,
    ) -> Result<Option<usize>, ()> {
        self.waits.push(wait);
        let Some(report) = self.reports.pop() else {
            std::thread::sleep(wait);
            return Ok(None);
        };
        buffer[..report.len()].copy_from_slice(&report);
        Ok(Some(report.len()))
    }
}

#[test]
fn every_link_starts_with_the_display_then_the_documented_reads() {
    let session = polaris_stream100::session::Session::start(Recorder {
        display: true,
        ..Default::default()
    });
    assert!(session.has_display());
    assert_eq!(
        session.link().controls,
        vec![(0xc0, 0x52, 0, 0, 2), (0xc0, 0x02, 0, 0, 2)]
    );
}

#[test]
fn a_session_keeps_the_controller_alive_while_it_waits() {
    let mut session = polaris_stream100::session::Session::start(Recorder {
        display: true,
        ..Default::default()
    });
    let read = session.next(Duration::from_millis(600)).unwrap();
    assert!(read.is_none());
    let link = session.link();
    // One keep-alive at once, then one every 250 ms of the 600 ms wait.
    assert!(
        link.packets.len() >= 3,
        "{} keep-alives",
        link.packets.len()
    );
    assert!(link.packets.iter().all(|packet| is_valid(&packet[..9])));
    // No read blocks past the next keep-alive.
    assert!(link.waits.iter().all(|wait| *wait <= KEEPALIVE_EVERY));
}

#[test]
fn without_the_display_interface_no_keep_alive_is_sent_and_input_is_still_read() {
    let mut report = vec![0u8; 64];
    report[0] = 0x01;
    let mut session = polaris_stream100::session::Session::start(Recorder {
        display: false,
        reports: vec![report],
        ..Default::default()
    });
    assert!(!session.has_display());
    let read = session.next(Duration::from_millis(100)).unwrap();
    assert!(session.link().packets.is_empty());
    assert_eq!(
        read,
        polaris_stream100::report::Report::parse(&{
            let mut bytes = vec![0u8; 64];
            bytes[0] = 0x01;
            bytes
        })
    );
}
