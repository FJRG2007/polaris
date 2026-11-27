//! The plain-USB session: what is sent at start, and the keep-alive.

use polaris_stream100::display::{asks_for_ack, ACK, HOST_KEEPALIVE, PACKET_SIZE, SYNC};
use polaris_stream100::session::TRANSFER_LEN;
use polaris_stream100::session::{
    keepalive_due, read_slice, VendorRead, DEVICE_INTERFACE_GUID, DEVICE_INTERFACE_GUID_U128,
    FORBIDDEN_REQUESTS, INIT_READS, KEEPALIVE_EVERY,
};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// A link that records what the session asks of it. Reads and writes come
/// from two threads, as on a real link.
#[derive(Default)]
struct Recorder {
    display: bool,
    controls: Vec<polaris_stream100::session::Setup>,
    transfers: Mutex<Vec<Vec<u8>>>,
    reports: Mutex<Vec<Vec<u8>>>,
    /// How long each write takes, as a slow display interface would.
    write_takes: Duration,
}

impl Recorder {
    fn transfers(&self) -> Vec<Vec<u8>> {
        self.transfers.lock().unwrap().clone()
    }
}

impl polaris_stream100::session::Link for Recorder {
    type Error = ();

    fn control_in(&mut self, setup: polaris_stream100::session::Setup) {
        self.controls.push(setup);
    }

    fn start_display(&mut self) -> bool {
        self.display
    }

    fn write_transfer(&self, transfer: &[u8], _wait: Duration) {
        std::thread::sleep(self.write_takes);
        self.transfers.lock().unwrap().push(transfer.to_vec());
    }

    fn read_report(
        &self,
        buffer: &mut [u8; polaris_stream100::report::REPORT_LEN],
        wait: Duration,
    ) -> Result<Option<usize>, ()> {
        let Some(report) = self.reports.lock().unwrap().pop() else {
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
    // One read that blocks the whole time: the display is fed meanwhile.
    let read = session.next(Duration::from_millis(600)).unwrap();
    assert!(read.is_none());
    let transfers = session.link().transfers();
    // The painter's transfers, as built: the sync packet first, whole packets.
    assert!(!transfers.is_empty());
    assert!(transfers.iter().all(|transfer| {
        transfer.len() % PACKET_SIZE == 0
            && transfer.len() <= TRANSFER_LEN
            && transfer.starts_with(&SYNC)
    }));
    // The official keep-alive went out at least once a 500 ms, so twice in 600 ms.
    let keepalives = transfers
        .iter()
        .filter(|transfer| {
            transfer[PACKET_SIZE..]
                .windows(HOST_KEEPALIVE.len())
                .any(|window| window == HOST_KEEPALIVE)
        })
        .count();
    assert!(keepalives >= 2, "{keepalives} keep-alives");
    // A quiet display still hears from the host every 20 ms or so.
    assert!(transfers.len() >= 10, "{} transfers", transfers.len());
}

#[test]
fn a_slow_display_write_never_holds_back_a_report() {
    let mut report = vec![0u8; 64];
    report[0] = 0x01;
    let mut session = polaris_stream100::session::Session::start(Recorder {
        display: true,
        // Every write takes as long as a write may (WRITE_WAIT).
        write_takes: polaris_stream100::session::WRITE_WAIT,
        ..Default::default()
    });
    // Let the display thread get into a write first.
    std::thread::sleep(Duration::from_millis(10));
    session.link().reports.lock().unwrap().push(report);
    let started = Instant::now();
    let read = session.next(Duration::from_millis(500)).unwrap();
    assert!(read.is_some());
    assert!(
        started.elapsed() < Duration::from_millis(50),
        "the report waited {:?}",
        started.elapsed()
    );
}

#[test]
fn a_request_for_an_acknowledgement_is_answered_on_the_display() {
    // A report whose device-information message asks for the host's ack.
    let report = ack_request();
    assert!(asks_for_ack(&report));
    let mut session = polaris_stream100::session::Session::start(Recorder {
        display: true,
        reports: Mutex::new(vec![report]),
        ..Default::default()
    });
    let before = session.link().transfers().len();
    session.next(Duration::from_millis(50)).unwrap();
    let deadline = Instant::now() + Duration::from_millis(500);
    let acked = || {
        session.link().transfers()[before..]
            .iter()
            // The body follows the 8-byte message header.
            .any(|transfer| transfer[PACKET_SIZE + 8] == ACK)
    };
    while !acked() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(acked(), "the acknowledgement went out");
}

#[test]
fn without_the_display_interface_no_keep_alive_is_sent_and_input_is_still_read() {
    let mut report = vec![0u8; 64];
    report[0] = 0x01;
    let mut session = polaris_stream100::session::Session::start(Recorder {
        display: false,
        reports: Mutex::new(vec![report]),
        ..Default::default()
    });
    assert!(!session.has_display());
    let read = session.next(Duration::from_millis(100)).unwrap();
    assert!(session.link().transfers().is_empty());
    assert_eq!(
        read,
        polaris_stream100::report::Report::parse(&{
            let mut bytes = vec![0u8; 64];
            bytes[0] = 0x01;
            bytes
        })
    );
}

/// A report carrying the device-information message (`sm`, type 1), which
/// asks the host for an acknowledgement.
fn ack_request() -> Vec<u8> {
    let mut report = vec![0u8; 64];
    report[0] = 12;
    let mut message = vec![b's', b'm', 10, 0, 7, 0, 1, 0, 0, 0];
    let sum = message
        .iter()
        .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
    message[9] = 0u8.wrapping_sub(sum);
    report[12..22].copy_from_slice(&message);
    report
}
