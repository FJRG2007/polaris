//! The plain-USB session: what is sent at start, and the keep-alive.

use polaris_stream100::session::{
    keepalive_due, read_slice, VendorRead, DEVICE_INTERFACE_GUID, DEVICE_INTERFACE_GUID_U128,
    FORBIDDEN_REQUESTS, INIT_READS, KEEPALIVE_EVERY,
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
