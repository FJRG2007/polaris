//! The Hercules SDK's input states, replayed from a real unit.
//!
//! `fixtures/sdk-states.txt` holds callbacks copied verbatim from the probe
//! log of 2026-11-26 (`out6-pump.txt`): the owner turned each knob, pressed
//! each knob, each lit button and power, one at a time. Nothing here loads
//! the SDK or opens a device; the bytes are only decoded.

use polaris_stream100::report::{Decoder, Event, KnobMap, Report};
use polaris_stream100::sdk::{self, STATE_LEN};

const LOG: &str = include_str!("fixtures/sdk-states.txt");

/// One callback: the state's bytes and what the probe printed for them.
struct Frame {
    state: Vec<u8>,
    buttons: u32,
    encoders: [i16; 4],
}

fn field<'a>(line: &'a str, name: &str) -> &'a str {
    let start = line.find(name).expect("the field is on the line") + name.len();
    line[start..].split_whitespace().next().unwrap()
}

/// Each `##` section of the log as its frames, in order.
fn sections() -> Vec<(String, Vec<Frame>)> {
    let mut sections: Vec<(String, Vec<Frame>)> = Vec::new();
    let mut lines = LOG.lines();
    while let Some(line) = lines.next() {
        if let Some(name) = line.strip_prefix("## ") {
            sections.push((name.to_owned(), Vec::new()));
        } else if line.contains("buttons=") {
            let raw = lines.next().expect("a raw line follows each callback");
            let raw = raw.trim().strip_prefix("raw ").expect("the raw bytes");
            let state = raw
                .split('-')
                .map(|byte| u8::from_str_radix(byte, 16).unwrap())
                .collect();
            let buttons = field(line, "buttons=0x");
            let mut encoders = [0i16; 4];
            for (slot, value) in encoders.iter_mut().zip(field(line, "enc=").split(',')) {
                *slot = value.parse().unwrap();
            }
            let frames = &mut sections.last_mut().expect("a section heads the frames").1;
            frames.push(Frame {
                state,
                buttons: u32::from_str_radix(buttons, 16).unwrap(),
                encoders,
            });
        }
    }
    sections
}

fn section(name: &str) -> Vec<Frame> {
    sections()
        .into_iter()
        .find(|(title, _)| title.starts_with(name))
        .unwrap_or_else(|| panic!("no section {name}"))
        .1
}

/// The events a section gives, the first frame taken as the baseline the
/// way `native::sdk` feeds the decoder.
fn replay(name: &str) -> Vec<Vec<Event>> {
    let frames = section(name);
    let mut decoder = Decoder::new(KnobMap::default());
    let first = sdk::decode_state(&frames[0].state).unwrap();
    assert!(decoder.feed(sdk::baseline(&first)).is_empty());
    let mut events = vec![decoder.feed(first)];
    for frame in &frames[1..] {
        let report = sdk::decode_state(&frame.state).unwrap();
        // The plugin carries each report across as bytes; replay that hop.
        events.push(decoder.feed(Report::parse(&report.to_bytes()).unwrap()));
    }
    events
}

fn turn(knob: u8, counts: i32) -> Vec<Event> {
    vec![Event::Turn { knob, counts }]
}

fn knob(knob: u8, pressed: bool) -> Vec<Event> {
    vec![Event::KnobPress { knob, pressed }]
}

fn button(button: u8, pressed: bool) -> Vec<Event> {
    vec![Event::Button { button, pressed }]
}

#[test]
fn every_logged_state_decodes_to_what_the_probe_printed() {
    let all: Vec<Frame> = sections()
        .into_iter()
        .flat_map(|(_, frames)| frames)
        .collect();
    assert_eq!(all.len(), 37);
    for frame in &all {
        assert_eq!(frame.state.len(), STATE_LEN);
        let report = sdk::decode_state(&frame.state).unwrap();
        assert_eq!(report.positions, frame.encoders);
        assert_eq!(report.power, frame.buttons & sdk::SDK_POWER_BIT != 0);
    }
}

#[test]
fn each_knob_turned_clockwise_counts_up_on_its_own_encoder() {
    // The hands-off baseline, then the first callbacks of a slow turn: 21
    // counts banked over the minute between them, then one count each.
    assert_eq!(
        replay("knob 1"),
        vec![vec![], turn(0, 21), turn(0, 1), turn(0, 1), turn(0, 1)]
    );
    assert_eq!(replay("knob 2"), vec![vec![], turn(1, 4)]);
    assert_eq!(replay("knob 3"), vec![vec![], turn(2, 6)]);
    assert_eq!(replay("knob 4"), vec![vec![], turn(3, 1)]);
}

#[test]
fn knob_presses_land_on_their_knobs_and_the_press_nudge_is_dropped() {
    // Knob 1's press moved its encoder: -1 twice as the finger landed (before
    // the switch closed, so not filtered here; the encoder's dead band absorbs
    // it), -1 while held, then +3 and +2 on release. The last three are the
    // press-jitter window's. Knobs 2 to 4 did not move at all.
    assert_eq!(
        replay("press knob"),
        vec![
            vec![],
            turn(0, -1),
            turn(0, -1),
            knob(0, true),
            vec![],
            knob(0, false),
            vec![],
            vec![],
            knob(1, true),
            knob(1, false),
            knob(2, true),
            knob(2, false),
            knob(3, true),
            knob(3, false),
        ]
    );
}

#[test]
fn the_lit_buttons_and_power_come_through_the_wider_button_word() {
    assert_eq!(
        replay("press button"),
        vec![
            vec![],
            button(0, true),
            button(0, false),
            button(1, true),
            button(1, false),
            button(2, true),
            button(2, false),
            button(3, true),
            button(3, false),
        ]
    );
    // Power is bit 8, past the byte the HID route uses for buttons. The
    // screen-state byte changing on release (0xBC to 0xD0, the device's own
    // reaction) is not an input.
    let power = section("press power");
    assert_eq!(power[1].buttons, 0x100);
    assert_eq!(power[2].state[0x5c], 0xd0);
    assert_eq!(
        replay("press power"),
        vec![
            vec![],
            vec![Event::Power { pressed: true }],
            vec![Event::Power { pressed: false }],
        ]
    );
}
