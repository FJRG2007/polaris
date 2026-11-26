//! What Polaris reads from the Hercules SDK (`hsm_api_core_x64.dll`), the
//! only way into the controller while the Hercules driver is bound to it
//! (`docs/devices/hercules-stream100.md`, "Windows: the Hercules driver").
//!
//! This module is the pure half: the layouts the SDK hands over and how they
//! become the same [`Report`] the HID and USB routes produce, so the decoder,
//! the press-jitter filter and the 16-bit encoder wrap are shared. Loading
//! and calling the DLL is `native::sdk`, Windows only.
//!
//! Layouts are read from the DLL's own code (its input dispatch at
//! `0x180016ee0`) and from CataclysmX/New-Hera-lunx (`docs/protocol/inputs.md`,
//! `docs/re/dll-map.md`), and confirmed against a real unit's callbacks
//! (`tests/fixtures/sdk-states.txt`): every knob counts up clockwise on its own
//! encoder, one callback per change (about every 16 ms while a knob turns),
//! and the encoders start at arbitrary absolute values, so only deltas count.

use crate::report::{Report, BUTTON_BITS, DEFAULT_KNOB_BITS};
use crate::{PRODUCT_ID, VENDOR_ID};

/// Where the Hercules installer puts the SDK, under Program Files.
pub const SDK_DIR: [&str; 3] = ["Hercules", "HSM Series", "sdk"];
/// The SDK itself.
pub const SDK_DLL: &str = "hsm_api_core_x64.dll";
/// The USB library the SDK loads by name; loaded first, from the same folder,
/// so that lookup finds this copy and never one elsewhere on the search path.
pub const USB_DLL: &str = "tlusbapi_x64.dll";

/// The size of the input state the SDK passes to the callback.
pub const STATE_LEN: usize = 0x60;
const STATE_BUTTONS: usize = 0x04;
const STATE_ENCODERS: usize = 0x0c;

/// `HSM_GetDeviceInfo`'s structure: its first field is its own size.
pub const INFO_LEN: usize = 0x640;
const INFO_VENDOR: usize = 0x20c;
const INFO_PRODUCT: usize = 0x20e;

/// Which bit of the SDK's button word each knob press uses, knob 1 first.
///
/// Confirmed on a real unit (firmware 1.40, SDK 0x153) on 2026-11-26: each
/// knob pressed alone, in order, set exactly these bits, the order the
/// printed numbers follow, the same bits as the HID report's byte 1
/// ([`DEFAULT_KNOB_BITS`]). The callbacks are in
/// `tests/fixtures/sdk-states.txt`, and agree with New-Hera-lunx's
/// `inputs.md`.
pub const SDK_KNOB_BITS: [u32; 4] = [0x0001, 0x0002, 0x0004, 0x0008];
/// The four lit buttons, button 1 first. Confirmed by the same run.
pub const SDK_BUTTON_BITS: [u32; 4] = [0x0010, 0x0020, 0x0040, 0x0080];
/// The power button, past the low byte: the reason the word is read whole.
/// Confirmed by the same run (one click: 0x100 set, then cleared, and the
/// screen-state byte at `+0x5C` went from 0xBC to 0xD0).
pub const SDK_POWER_BIT: u32 = 0x0100;

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// The SDK's input state as a [`Report`] in the HID layout: each SDK bit is
/// moved to the bit the HID route uses for the same control, so the decoder
/// reads both routes with one knob map. `None` when the state is too short.
pub fn decode_state(state: &[u8]) -> Option<Report> {
    if state.len() < STATE_LEN {
        return None;
    }
    let word = u32_at(state, STATE_BUTTONS);
    let mut buttons = 0u8;
    for (sdk, hid) in SDK_KNOB_BITS.iter().zip(DEFAULT_KNOB_BITS) {
        if word & sdk != 0 {
            buttons |= hid;
        }
    }
    for (sdk, hid) in SDK_BUTTON_BITS.iter().zip(BUTTON_BITS) {
        if word & sdk != 0 {
            buttons |= hid;
        }
    }
    let mut positions = [0i16; 4];
    for (index, position) in positions.iter_mut().enumerate() {
        let at = STATE_ENCODERS + index * 2;
        *position = i16::from_le_bytes([state[at], state[at + 1]]);
    }
    Some(Report {
        buttons,
        positions,
        power: word & SDK_POWER_BIT != 0,
    })
}

/// The SDK calls back only when something changed, so its first state may
/// already carry a press. The decoder takes its first report as a baseline;
/// this is that baseline: the encoders where they are, nothing held. The
/// first state is fed right after it, so a press is never lost.
pub fn baseline(first: &Report) -> Report {
    Report {
        buttons: 0,
        positions: first.positions,
        power: false,
    }
}

/// An empty `HSM_GetDeviceInfo` structure, its size field set.
pub fn info_buffer() -> Vec<u8> {
    let mut info = vec![0u8; INFO_LEN];
    info[..4].copy_from_slice(&(INFO_LEN as u32).to_le_bytes());
    info
}

/// The device the SDK described is a Stream 100.
pub fn info_is_stream100(info: &[u8]) -> bool {
    info.len() >= INFO_LEN
        && u16::from_le_bytes([info[INFO_VENDOR], info[INFO_VENDOR + 1]]) == VENDOR_ID
        && u16::from_le_bytes([info[INFO_PRODUCT], info[INFO_PRODUCT + 1]]) == PRODUCT_ID
}

/// The company a Hercules SDK file must be signed by, the same signer the
/// desktop app requires of the vendor uninstaller (`HERCULES_SIGNER` in
/// `clients/desktop/src/main/addons/hercules-official.ts`). Its R&D arm signs
/// the SDK ("Guillemot Recherche & Developpement, Inc").
pub const SIGNER: &str = "Guillemot";

/// A certificate's common or organization name belongs to [`SIGNER`]: it
/// starts with the word, as `hercules-official-run.ts` checks the subject.
pub fn signer_is_hercules(name: &str) -> bool {
    let name = name.trim().trim_start_matches('"');
    let Some(head) = name.get(..SIGNER.len()) else {
        return false;
    };
    head.eq_ignore_ascii_case(SIGNER)
        && !name[SIGNER.len()..]
            .chars()
            .next()
            .is_some_and(|next| next.is_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::{Decoder, Event, KnobMap};

    fn state(buttons: u32, encoders: [i16; 4]) -> Vec<u8> {
        let mut bytes = vec![0u8; STATE_LEN];
        bytes[0..4].copy_from_slice(&1234u32.to_le_bytes());
        bytes[STATE_BUTTONS..STATE_BUTTONS + 4].copy_from_slice(&buttons.to_le_bytes());
        for (index, value) in encoders.iter().enumerate() {
            let at = STATE_ENCODERS + index * 2;
            bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
        }
        // VU floats and the screen byte, which the decoder must ignore.
        bytes[0x1c..0x20].copy_from_slice(&(-1.0f32).to_le_bytes());
        bytes[0x5c] = 0xbc;
        bytes
    }

    #[test]
    fn a_short_state_is_refused() {
        assert_eq!(decode_state(&[0u8; STATE_LEN - 1]), None);
    }

    #[test]
    fn the_state_decodes_at_the_sdk_offsets() {
        let report = decode_state(&state(0, [-1, 300, i16::MIN, i16::MAX])).unwrap();
        assert_eq!(report.positions, [-1, 300, i16::MIN, i16::MAX]);
        assert_eq!(report.buttons, 0);
        assert!(!report.power);
        // The time field and the bytes between the fields are not read.
        let mut noisy = state(0, [5, 6, 7, 8]);
        noisy[0x08..0x0c].fill(0xff);
        noisy[0x14..0x1c].fill(0xff);
        assert_eq!(decode_state(&noisy).unwrap().positions, [5, 6, 7, 8]);
    }

    #[test]
    fn each_sdk_bit_lands_on_the_hid_bit_of_the_same_control() {
        for knob in 0..4 {
            let report = decode_state(&state(SDK_KNOB_BITS[knob], [0; 4])).unwrap();
            assert_eq!(report.buttons, DEFAULT_KNOB_BITS[knob]);
        }
        for button in 0..4 {
            let report = decode_state(&state(SDK_BUTTON_BITS[button], [0; 4])).unwrap();
            assert_eq!(report.buttons, BUTTON_BITS[button]);
        }
        let all = decode_state(&state(0x01ff, [0; 4])).unwrap();
        assert_eq!(all.buttons, 0xff);
        assert!(all.power);
        // Bits above power are not controls: they change nothing.
        assert_eq!(decode_state(&state(0xfe00, [0; 4])).unwrap().buttons, 0);
        assert!(!decode_state(&state(0xfe00, [0; 4])).unwrap().power);
    }

    #[test]
    fn sdk_states_give_the_events_the_hid_route_gives() {
        let mut decoder = Decoder::new(KnobMap::default());
        let first = decode_state(&state(SDK_KNOB_BITS[2], [100, 0, 0, 0])).unwrap();
        assert!(decoder.feed(baseline(&first)).is_empty());
        // The first state's press is not swallowed by the baseline.
        assert_eq!(
            decoder.feed(first),
            vec![Event::KnobPress {
                knob: 2,
                pressed: true
            }]
        );
        let released = decode_state(&state(0, [100, 0, 0, 0])).unwrap();
        assert_eq!(
            decoder.feed(released),
            vec![Event::KnobPress {
                knob: 2,
                pressed: false
            }]
        );
        let button = decode_state(&state(SDK_BUTTON_BITS[3] | SDK_POWER_BIT, [100, 0, 0, 0]));
        assert_eq!(
            decoder.feed(button.unwrap()),
            vec![
                Event::Button {
                    button: 3,
                    pressed: true
                },
                Event::Power { pressed: true }
            ]
        );
    }

    #[test]
    fn an_sdk_turn_wraps_at_16_bits() {
        let mut decoder = Decoder::new(KnobMap::default());
        decoder.feed(decode_state(&state(0, [i16::MAX - 10, 0, 0, i16::MIN + 5])).unwrap());
        assert_eq!(
            decoder.feed(decode_state(&state(0, [i16::MIN + 9, 0, 0, i16::MAX - 4])).unwrap()),
            vec![
                Event::Turn {
                    knob: 0,
                    counts: 20
                },
                Event::Turn {
                    knob: 3,
                    counts: -10
                }
            ]
        );
    }

    #[test]
    fn the_device_info_names_the_stream100() {
        let mut info = info_buffer();
        assert_eq!(u32_at(&info, 0), 0x640);
        assert!(!info_is_stream100(&info));
        info[INFO_VENDOR..INFO_VENDOR + 2].copy_from_slice(&0x06f8u16.to_le_bytes());
        info[INFO_PRODUCT..INFO_PRODUCT + 2].copy_from_slice(&0xe053u16.to_le_bytes());
        assert!(info_is_stream100(&info));
        assert!(!info_is_stream100(&info[..INFO_LEN - 1]));
        info[INFO_PRODUCT] = 0x54;
        assert!(!info_is_stream100(&info));
    }

    #[test]
    fn only_the_hercules_signer_is_accepted() {
        assert!(signer_is_hercules(
            "Guillemot Recherche & Developpement, Inc"
        ));
        assert!(signer_is_hercules(
            "\"Guillemot Recherche & Developpement, Inc"
        ));
        assert!(signer_is_hercules("Guillemot Corporation"));
        assert!(signer_is_hercules("guillemot"));
        assert!(!signer_is_hercules("Guillemots Ltd"));
        assert!(!signer_is_hercules("Not Guillemot"));
        assert!(!signer_is_hercules(""));
        assert!(!signer_is_hercules("Guille"));
    }
}
