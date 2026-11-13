//! Installing on a TV over a USB cable: the pipe against a fake device that
//! speaks adbd's USB framing - header and payload as separate transfers - and
//! checks the key the way a TV does, with the ADB client on top of it. The same
//! cases as `desktop/test/main/tv-usb.test.ts`; no real device is touched.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use polaris_client::adb_client::*;
use polaris_client::tv_install::{connect_failure, target_label, TvOutcome, TvTarget};
use polaris_client::usb_adb::*;
use rsa::Pkcs1v15Sign;
use tokio::sync::Notify;

use crate::key;

const PACKET_SIZE: usize = 512;
const SHA1_PREFIX: [u8; 15] = [
    0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
];

fn adb_configuration() -> UsbConfiguration {
    UsbConfiguration {
        configuration_value: 1,
        interfaces: vec![
            UsbInterface {
                interface_number: 0,
                alternates: vec![UsbAlternate {
                    alternate_setting: 0,
                    class: 0x08,
                    subclass: 6,
                    protocol: 0x50,
                    endpoints: vec![],
                }],
            },
            UsbInterface {
                interface_number: 1,
                alternates: vec![UsbAlternate {
                    alternate_setting: 0,
                    class: 0xff,
                    subclass: 0x42,
                    protocol: 0x01,
                    endpoints: vec![
                        UsbEndpoint {
                            address: 0x81,
                            direction: UsbDirection::In,
                            kind: UsbTransferType::Bulk,
                            packet_size: PACKET_SIZE,
                        },
                        UsbEndpoint {
                            address: 0x02,
                            direction: UsbDirection::Out,
                            kind: UsbTransferType::Bulk,
                            packet_size: PACKET_SIZE,
                        },
                    ],
                }],
            },
        ],
    }
}

fn tv_description() -> UsbDescription {
    UsbDescription {
        vendor_id: 0x18d1,
        product_id: 0x4ee7,
        serial_number: Some("ABC123\u{7}".into()),
        manufacturer_name: Some("Fake".into()),
        product_name: Some("TV\n".into()),
        configuration: None,
        configurations: vec![adb_configuration()],
    }
}

struct FakeState {
    header: Option<Vec<u8>>,
    reader: PacketReader,
    inbox: VecDeque<Vec<u8>>,
    unplugged: bool,
    outs: Vec<usize>,
    shells: Vec<String>,
    prompted: bool,
}

impl Default for FakeState {
    fn default() -> Self {
        Self {
            header: None,
            reader: PacketReader::new(),
            inbox: VecDeque::new(),
            unplugged: false,
            outs: Vec::new(),
            shells: Vec::new(),
            prompted: false,
        }
    }
}

/// A TV on the end of a cable: adbd's USB side, with a shell that answers `Success`.
#[derive(Clone)]
struct FakeTv {
    description: UsbDescription,
    /// Whether the TV already trusts this computer's key.
    trusted: bool,
    claim: Result<(), UsbOpenError>,
    state: Arc<Mutex<FakeState>>,
    arrived: Arc<Notify>,
}

impl FakeTv {
    fn new(trusted: bool) -> Self {
        Self {
            description: tv_description(),
            trusted,
            claim: Ok(()),
            state: Arc::default(),
            arrived: Arc::new(Notify::new()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().unwrap()
    }

    /// Pulls the cable: every read under way fails.
    fn unplug(&self) {
        self.state().unplugged = true;
        self.arrived.notify_one();
    }

    fn reply(&self, state: &mut FakeState, command: u32, arg0: u32, arg1: u32, data: &[u8]) {
        let packet = encode_packet(command, arg0, arg1, data);
        state.inbox.push_back(packet[..HEADER_BYTES].to_vec());
        if packet.len() > HEADER_BYTES {
            state.inbox.push_back(packet[HEADER_BYTES..].to_vec());
        }
        self.arrived.notify_one();
    }

    fn handle(&self, state: &mut FakeState, packet: Packet) {
        let token = [5u8; 20];
        let device = b"device::\0";
        match packet.command {
            A_CNXN => self.reply(state, A_AUTH, AUTH_TOKEN, 0, &token),
            A_AUTH if packet.arg0 == AUTH_SIGNATURE => {
                let public = read_key(key()).unwrap().to_public_key();
                let digest = [&SHA1_PREFIX[..], &token].concat();
                let signed = public
                    .verify(Pkcs1v15Sign::new_unprefixed(), &digest, &packet.data)
                    .is_ok();
                if self.trusted && signed {
                    self.reply(state, A_CNXN, VERSION, 256 * 1024, device);
                } else {
                    self.reply(state, A_AUTH, AUTH_TOKEN, 0, &token);
                }
            }
            A_AUTH if packet.arg0 == AUTH_PUBLIC_KEY => {
                assert_eq!(packet.data, android_public_key(key(), KEY_COMMENT).unwrap());
                state.prompted = true;
                self.reply(state, A_CNXN, VERSION, 256 * 1024, device);
            }
            A_OPEN => {
                let name = String::from_utf8_lossy(&packet.data)
                    .trim_end_matches('\0')
                    .to_string();
                state.shells.push(name.clone());
                self.reply(state, A_OKAY, 77, packet.arg0, &[]);
                if name.starts_with("shell:hang") {
                    return;
                }
                self.reply(state, A_WRTE, 77, packet.arg0, b"Success\n");
                self.reply(state, A_CLSE, 77, packet.arg0, &[]);
            }
            _ => {}
        }
    }
}

struct FakeBulk(FakeTv);

impl UsbBulk for FakeBulk {
    async fn transfer_in(&mut self, length: usize) -> Result<Vec<u8>, UsbTransferFailed> {
        loop {
            {
                let mut state = self.0.state();
                if let Some(part) = state.inbox.pop_front() {
                    assert!(part.len() <= length);
                    return Ok(part);
                }
                if state.unplugged {
                    return Err(UsbTransferFailed);
                }
            }
            self.0.arrived.notified().await;
        }
    }

    async fn transfer_out(&mut self, data: &[u8]) -> Result<(), UsbTransferFailed> {
        let tv = self.0.clone();
        let mut state = tv.state();
        if state.unplugged {
            return Err(UsbTransferFailed);
        }
        state.outs.push(data.len());
        if data.is_empty() {
            return Ok(());
        }
        // adbd reads the header, then the payload, as two transfers.
        let bytes = match state.header.take() {
            Some(header) => [header.as_slice(), data].concat(),
            None => {
                assert_eq!(data.len(), HEADER_BYTES);
                let length = u32::from_le_bytes(data[12..16].try_into().unwrap());
                if length > 0 {
                    state.header = Some(data.to_vec());
                    return Ok(());
                }
                data.to_vec()
            }
        };
        let packets = state.reader.push(&bytes).unwrap();
        for packet in packets {
            tv.handle(&mut state, packet);
        }
        Ok(())
    }

    async fn release(&mut self) {}
}

impl UsbDevice for FakeTv {
    type Bulk = FakeBulk;

    fn description(&self) -> &UsbDescription {
        &self.description
    }

    async fn claim(&self, _found: &AdbUsbInterface) -> Result<FakeBulk, UsbOpenError> {
        self.claim?;
        Ok(FakeBulk(self.clone()))
    }
}

async fn connection(tv: &FakeTv) -> AdbConnection<UsbAdbPipe<FakeBulk>> {
    let pipe = open_adb_pipe(tv).await.unwrap();
    AdbConnection::new(
        pipe,
        AdbOptions {
            key: key().to_string(),
            certificate: None,
            connect: Duration::from_secs(2),
            approve: Duration::from_secs(2),
            command: Duration::from_secs(2),
        },
    )
}

#[test]
fn picks_the_adb_interface_and_its_bulk_endpoints() {
    let found = adb_interface(&tv_description()).unwrap();
    assert_eq!(
        (found.configuration, found.interface_number, found.alternate),
        (1, 1, 0)
    );
    assert_eq!(found.input.address, 0x81);
    assert_eq!(found.output.address, 0x02);
}

#[test]
fn lists_only_devices_that_offer_adb_with_no_control_characters_in_what_is_shown() {
    let stick = UsbDescription {
        configurations: vec![UsbConfiguration {
            configuration_value: 1,
            interfaces: vec![],
        }],
        ..tv_description()
    };
    let listed: Vec<TvUsbDevice> = describe_devices(&[stick, tv_description()])
        .into_iter()
        .map(|(_, info)| info)
        .collect();
    assert_eq!(
        listed,
        vec![TvUsbDevice {
            id: "s:ABC123".into(),
            name: "Fake TV".into()
        }]
    );
}

#[test]
fn names_a_device_with_no_serial_by_its_ids_and_its_place_in_the_list() {
    let plain = UsbDescription {
        serial_number: None,
        manufacturer_name: None,
        product_name: None,
        ..tv_description()
    };
    let listed = describe_devices(&[plain]);
    assert_eq!(listed[0].1.id, "d:18d1:4ee7:0");
    assert_eq!(listed[0].1.name, "Android device");
}

#[tokio::test]
async fn authenticates_with_a_key_the_tv_trusts_and_runs_a_command() {
    let tv = FakeTv::new(true);
    let mut adb = connection(&tv).await;
    adb.open(|| {}).await.unwrap();
    assert_eq!(
        adb.shell("getprop ro.build.version.sdk").await.unwrap(),
        "Success\n"
    );
    assert!(!tv.state().prompted);
    adb.close().await;
}

#[tokio::test]
async fn sends_the_public_key_and_waits_for_allow_on_a_tv_that_does_not_know_it() {
    let tv = FakeTv::new(false);
    let mut adb = connection(&tv).await;
    let mut prompts = 0;
    adb.open(|| prompts += 1).await.unwrap();
    assert_eq!(prompts, 1);
    assert!(tv.state().prompted);
    adb.close().await;
}

#[tokio::test]
async fn ends_a_transfer_that_fills_its_last_usb_packet_with_an_empty_one() {
    let tv = FakeTv::new(true);
    let mut adb = connection(&tv).await;
    adb.open(|| {}).await.unwrap();
    // "shell:", the command and the NUL: make the payload exactly 1024.
    adb.shell(&"x".repeat(1024 - "shell:".len() - 1))
        .await
        .unwrap();
    let outs = tv.state().outs.clone();
    let at = outs.iter().position(|one| *one == 1024).unwrap();
    assert!(at > 0);
    assert_eq!(outs[at + 1], 0);
    assert_eq!(outs.iter().filter(|one| **one == 0).count(), 1);
    adb.close().await;
}

#[tokio::test]
async fn fails_what_is_under_way_when_the_cable_is_pulled() {
    let tv = FakeTv::new(true);
    let mut adb = connection(&tv).await;
    adb.open(|| {}).await.unwrap();
    let pull = async {
        while !tv.state().shells.iter().any(|one| one == "shell:hang") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tv.unplug();
    };
    let (pending, ()) = tokio::join!(adb.shell("hang"), pull);
    assert_eq!(
        pending.unwrap_err().to_string(),
        "The TV closed the connection."
    );
}

#[tokio::test]
async fn says_busy_when_another_program_holds_the_interface_gone_when_it_was_unplugged() {
    let held = FakeTv {
        claim: Err(UsbOpenError::Busy),
        ..FakeTv::new(true)
    };
    assert_eq!(open_adb_pipe(&held).await.err(), Some(UsbOpenError::Busy));
    let gone = FakeTv {
        claim: Err(UsbOpenError::Gone),
        ..FakeTv::new(true)
    };
    assert_eq!(open_adb_pipe(&gone).await.err(), Some(UsbOpenError::Gone));
    let none = FakeTv {
        description: UsbDescription {
            configurations: vec![],
            ..tv_description()
        },
        ..FakeTv::new(true)
    };
    assert_eq!(open_adb_pipe(&none).await.err(), Some(UsbOpenError::Gone));
}

#[test]
fn names_the_usb_failures() {
    assert_eq!(
        connect_failure(&AdbError::from(UsbOpenError::Busy)),
        TvOutcome::UsbBusy
    );
    assert_eq!(
        connect_failure(&AdbError::from(UsbOpenError::Gone)),
        TvOutcome::UsbGone
    );
    let refused = AdbError::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
    assert_eq!(connect_failure(&refused), TvOutcome::AdbOff);
}

#[test]
fn keeps_a_usb_id_out_of_the_backup_paths_separators() {
    assert_eq!(
        target_label(&TvTarget::Usb {
            id: "s:../x\\y".into()
        }),
        "usb-s----x-y"
    );
}
