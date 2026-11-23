//! The input report the controller sends on interface 0, endpoint `0x81`.
//!
//! Layout (64 bytes, little-endian):
//!
//! | Byte | Meaning |
//! | ---- | ------- |
//! | 1    | button bitmask: four knob presses in the low nibble, the four lit buttons in the high one |
//! | 3-10 | four signed 16-bit encoder positions, knob 1 to 4 |
//!
//! Encoder positions are absolute and wrap at 16 bits; only the difference
//! between two reports means anything.

use serde::{Deserialize, Serialize};

/// The shortest report that still holds every field read here.
pub const MIN_REPORT_LEN: usize = 11;
/// The size of one interrupt transfer from the controller.
pub const REPORT_LEN: usize = 64;

const BUTTONS: usize = 1;
const ENCODERS: usize = 3;

/// Which bit of byte 1 each knob press uses, knob 1 first. The hardware's bit
/// order does not follow the printed knob numbers; this is the order measured
/// on a real unit. A unit that differs is corrected with [`KnobMap`].
pub const DEFAULT_KNOB_BITS: [u8; 4] = [0x08, 0x01, 0x04, 0x02];
/// Which bit each of the four lit buttons uses, button 1 first.
pub const BUTTON_BITS: [u8; 4] = [0x10, 0x20, 0x40, 0x80];

/// The knob-press bits of a unit, knob 1 first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnobMap(pub [u8; 4]);

impl Default for KnobMap {
    fn default() -> Self {
        Self(DEFAULT_KNOB_BITS)
    }
}

impl KnobMap {
    /// A map is usable only when it names four distinct low-nibble bits.
    pub fn is_valid(&self) -> bool {
        let mut seen = 0u8;
        for bit in self.0 {
            if bit.count_ones() != 1 || bit & 0xf0 != 0 || seen & bit != 0 {
                return false;
            }
            seen |= bit;
        }
        true
    }
}

/// One decoded input report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    pub buttons: u8,
    pub positions: [i16; 4],
}

impl Report {
    /// Decodes a report, or `None` when it is too short to be one.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < MIN_REPORT_LEN {
            return None;
        }
        let mut positions = [0i16; 4];
        for (index, position) in positions.iter_mut().enumerate() {
            let at = ENCODERS + index * 2;
            *position = i16::from_le_bytes([bytes[at], bytes[at + 1]]);
        }
        Some(Self {
            buttons: bytes[BUTTONS],
            positions,
        })
    }

    /// How far encoder `index` moved since `previous`, across the 16-bit wrap.
    pub fn delta(&self, previous: &Report, index: usize) -> i32 {
        i32::from(self.positions[index].wrapping_sub(previous.positions[index]))
    }
}

/// Something that happened on the controller between two reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// Raw encoder counts; [`crate::encoder::Encoder`] turns them into steps.
    Turn {
        knob: u8,
        counts: i32,
    },
    KnobPress {
        knob: u8,
        pressed: bool,
    },
    Button {
        button: u8,
        pressed: bool,
    },
}

/// Turns consecutive reports into events. The first report only sets the
/// baseline, so whatever the encoders read at connect is never a movement.
#[derive(Debug, Default)]
pub struct Decoder {
    previous: Option<Report>,
    knobs: KnobMap,
}

impl Decoder {
    pub fn new(knobs: KnobMap) -> Self {
        let knobs = if knobs.is_valid() {
            knobs
        } else {
            KnobMap::default()
        };
        Self {
            previous: None,
            knobs,
        }
    }

    /// Forgets the baseline: the next report is a fresh start. Called after a
    /// reconnect and while input is ignored (a locked session), so movements
    /// made meanwhile are never replayed.
    pub fn reset(&mut self) {
        self.previous = None;
    }

    pub fn feed(&mut self, report: Report) -> Vec<Event> {
        let Some(previous) = self.previous.replace(report) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        for knob in 0..4 {
            let counts = report.delta(&previous, knob);
            if counts != 0 {
                events.push(Event::Turn {
                    knob: knob as u8,
                    counts,
                });
            }
        }
        let changed = report.buttons ^ previous.buttons;
        for (knob, bit) in self.knobs.0.iter().enumerate() {
            if changed & bit != 0 {
                events.push(Event::KnobPress {
                    knob: knob as u8,
                    pressed: report.buttons & bit != 0,
                });
            }
        }
        for (button, bit) in BUTTON_BITS.iter().enumerate() {
            if changed & bit != 0 {
                events.push(Event::Button {
                    button: button as u8,
                    pressed: report.buttons & bit != 0,
                });
            }
        }
        events
    }
}
