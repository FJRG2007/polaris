//! The pure protocol: input reports, the knob engine, display messages.

use polaris_stream100::display::{self, IndexedFrame, Sequence};
use polaris_stream100::encoder::{self, Encoder, Tuning};
use polaris_stream100::report::{from_hid_read, Decoder, Event, KnobMap, Report};

fn report(buttons: u8, positions: [i16; 4]) -> Report {
    let mut bytes = [0u8; 64];
    bytes[1] = buttons;
    for (index, position) in positions.iter().enumerate() {
        bytes[3 + index * 2..5 + index * 2].copy_from_slice(&position.to_le_bytes());
    }
    Report::parse(&bytes).expect("a 64-byte report parses")
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

#[test]
fn a_short_report_is_refused() {
    assert_eq!(Report::parse(&[0u8; 10]), None);
}

#[test]
fn a_windows_hid_read_reads_like_the_usb_transfer() {
    // Windows' HID API puts the report id first: 0 when the device numbers
    // none (a byte the transfer lacks), the id itself when it does.
    let mut transfer = vec![0x01u8, 0x10, 0x00, 0x30, 0x00];
    transfer.resize(64, 0);
    let mut unnumbered = vec![0u8];
    unnumbered.extend_from_slice(&transfer);
    assert_eq!(from_hid_read(&unnumbered), &transfer[..]);
    assert_eq!(from_hid_read(&transfer), &transfer[..]);
    let decoded = Report::parse(from_hid_read(&unnumbered)).unwrap();
    assert_eq!(decoded.buttons, 0x10);
    assert_eq!(decoded.positions[0], 0x30);
    assert!(from_hid_read(&[]).is_empty());
    let again = Report::parse(&decoded.to_bytes()).unwrap();
    assert_eq!(again, decoded);
    let turned = report(0xa5, [-1, i16::MAX, i16::MIN, 300]);
    assert_eq!(Report::parse(&turned.to_bytes()), Some(turned));
}

#[test]
fn encoder_positions_wrap_at_sixteen_bits() {
    let before = report(0, [i16::MAX, 0, 0, 0]);
    let after = report(0, [i16::MIN, 0, 0, 0]);
    assert_eq!(after.delta(&before, 0), 1);
    assert_eq!(before.delta(&after, 0), -1);
}

#[test]
fn the_first_report_is_only_a_baseline() {
    let mut decoder = Decoder::default();
    assert!(decoder.feed(report(0xff, [500, -3, 9, 12])).is_empty());
    assert_eq!(
        decoder.feed(report(0xff, [548, -3, 9, 12])),
        vec![Event::Turn {
            knob: 0,
            counts: 48
        }]
    );
}

#[test]
fn presses_follow_the_measured_bit_order() {
    let mut decoder = Decoder::default();
    decoder.feed(report(0, [0; 4]));
    // 0x01 is knob 1's press, 0x10 button 1.
    assert_eq!(
        decoder.feed(report(0x11, [0; 4])),
        vec![
            Event::KnobPress {
                knob: 0,
                pressed: true
            },
            Event::Button {
                button: 0,
                pressed: true
            }
        ]
    );
    assert_eq!(
        decoder.feed(report(0x10, [0; 4])),
        vec![Event::KnobPress {
            knob: 0,
            pressed: false
        }]
    );
}

#[test]
fn a_knob_press_does_not_nudge_its_encoder() {
    let press = KnobMap::default().0[0];
    let mut decoder = Decoder::default();
    decoder.feed(report(0, [100, 100, 0, 0]));
    // The press moves knob 1 by 3 counts: only the press comes out. Knob 2,
    // not pressed, still turns by as little as that.
    assert_eq!(
        decoder.feed(report(press, [103, 102, 0, 0])),
        vec![
            Event::Turn { knob: 1, counts: 2 },
            Event::KnobPress {
                knob: 0,
                pressed: true
            }
        ]
    );
    // The nudge can arrive in the next reports too.
    assert!(decoder.feed(report(press, [99, 102, 0, 0])).is_empty());
    // A real turn while held is not jitter.
    assert_eq!(
        decoder.feed(report(press, [130, 102, 0, 0])),
        vec![Event::Turn {
            knob: 0,
            counts: 31
        }]
    );
    // Past the window, a slow turn of one count is a turn again.
    assert_eq!(
        decoder.feed(report(press, [131, 102, 0, 0])),
        vec![Event::Turn { knob: 0, counts: 1 }]
    );
    // The release filters again.
    assert_eq!(
        decoder.feed(report(0, [129, 102, 0, 0])),
        vec![Event::KnobPress {
            knob: 0,
            pressed: false
        }]
    );
}

#[test]
fn the_power_button_is_byte_2() {
    let mut bytes = [0u8; 64];
    bytes[2] = 0x01;
    let held = Report::parse(&bytes).unwrap();
    assert!(held.power);
    assert_eq!(held.buttons, 0);
    assert_eq!(Report::parse(&held.to_bytes()), Some(held));
    let mut decoder = Decoder::default();
    decoder.feed(report(0, [0; 4]));
    assert_eq!(decoder.feed(held), vec![Event::Power { pressed: true }]);
    assert_eq!(
        decoder.feed(report(0, [0; 4])),
        vec![Event::Power { pressed: false }]
    );
}

#[test]
fn a_bad_knob_map_falls_back_to_the_measured_one() {
    assert!(!KnobMap([0x01, 0x01, 0x04, 0x08]).is_valid());
    assert!(!KnobMap([0x10, 0x01, 0x04, 0x08]).is_valid());
    assert!(KnobMap([0x01, 0x02, 0x04, 0x08]).is_valid());
    let mut decoder = Decoder::new(KnobMap([0, 0, 0, 0]));
    decoder.feed(report(0, [0; 4]));
    assert_eq!(
        decoder.feed(report(0x08, [0; 4])),
        vec![Event::KnobPress {
            knob: 3,
            pressed: true
        }]
    );
}

#[test]
fn reset_forgets_movement_made_while_ignored() {
    let mut decoder = Decoder::default();
    decoder.feed(report(0, [0; 4]));
    decoder.reset();
    assert!(decoder.feed(report(0, [4800, 0, 0, 0])).is_empty());
}

const SLOW: u64 = 200;

#[test]
fn one_detent_moves_the_configured_amount() {
    let tuning = Tuning::default();
    let mut knob = Encoder::default();
    let detent = encoder::DETENT_COUNTS;
    assert_eq!(knob.turn(detent, 0, &tuning), 2);
    assert_eq!(knob.turn(-detent, SLOW, &tuning), -2);
}

#[test]
fn one_slow_full_turn_moves_about_half_the_range() {
    // A turn in a second, as the SDK delivers it: a callback every 16 ms, each
    // carrying the counts since the last one. Under five full turns from
    // silent to full is what BUG-0064 asked for; half the range is the aim.
    let tuning = Tuning::default();
    let mut knob = Encoder::default();
    let mut moved = 0;
    let mut sent = 0;
    for tick in 0..64u64 {
        let counts = 8;
        sent += counts;
        moved += knob.turn(counts, tick * 16, &tuning);
    }
    assert_eq!(sent, encoder::COUNTS_PER_TURN);
    assert!((45..=60).contains(&moved), "one turn moved {moved}%");
    // A slower turn moves the same distance, never less.
    let mut slow = Encoder::default();
    let slow_moved: i32 = (0..256u64)
        .map(|tick| slow.turn(2, tick * 16, &tuning))
        .sum();
    assert_eq!(slow_moved, encoder::COUNTS_PER_TURN / 10);
}

#[test]
fn jitter_at_rest_never_moves_the_volume() {
    let tuning = Tuning::default();
    let mut knob = Encoder::default();
    let mut moved = 0;
    for tick in 0..10_000u64 {
        let counts = if tick % 2 == 0 { 2 } else { -2 };
        moved += knob.turn(counts, tick * 8, &tuning);
    }
    assert_eq!(moved, 0);
}

#[test]
fn slow_creep_is_dropped_once_it_settles() {
    let tuning = Tuning::default();
    let mut knob = Encoder::default();
    // A count every 400 ms is a knob drifting, not a person turning it.
    let moved: i32 = (0..1_000u64)
        .map(|tick| knob.turn(1, tick * 400, &tuning))
        .sum();
    assert_eq!(moved, 0);
}

#[test]
fn a_slow_deliberate_turn_still_counts() {
    let tuning = Tuning::default();
    let mut knob = Encoder::default();
    // One detent in 2-count reports 10 ms apart.
    let moved: i32 = (0..(encoder::DETENT_COUNTS / 2) as u64)
        .map(|tick| knob.turn(2, tick * 10, &tuning))
        .sum();
    assert_eq!(moved, 2);
}

#[test]
fn a_fast_spin_accelerates_within_the_cap() {
    let tuning = Tuning::default();
    let mut slow = Encoder::default();
    let mut fast = Encoder::default();
    let slow_total: i32 = (0..10u64)
        .map(|tick| slow.turn(encoder::DETENT_COUNTS, tick * SLOW, &tuning))
        .sum();
    let fast_total: i32 = (0..10u64)
        .map(|tick| fast.turn(encoder::DETENT_COUNTS, tick * 4, &tuning))
        .sum();
    assert_eq!(slow_total, 20);
    assert!(
        fast_total > slow_total,
        "fast {fast_total} slow {slow_total}"
    );
    assert!(fast_total <= 10 * i32::from(tuning.max_step));
}

#[test]
fn a_burst_after_a_stall_is_capped() {
    let tuning = Tuning::default();
    let mut knob = Encoder::default();
    assert_eq!(knob.turn(30_000, 0, &tuning), i32::from(tuning.max_step));
    // Nothing of the burst is left to leak into the next report.
    assert_eq!(knob.turn(0, 10, &tuning), 0);
}

#[test]
fn discarded_counts_never_reappear() {
    let tuning = Tuning::default();
    let mut knob = Encoder::default();
    assert_eq!(knob.turn(9, 0, &tuning), 0);
    knob.discard();
    assert_eq!(knob.turn(5, 5, &tuning), 0);
}

#[test]
fn out_of_range_tuning_cannot_disable_a_guard() {
    let wild = Tuning {
        percent_per_detent: 0,
        dead_band: 255,
        settle_ms: 0,
        max_acceleration: 0,
        max_step: 0,
    }
    .clamped();
    assert_eq!(
        (wild.percent_per_detent, wild.dead_band, wild.settle_ms),
        (1, 24, 50)
    );
    assert_eq!((wild.max_acceleration, wild.max_step), (1, 1));
}

#[test]
fn volume_is_clamped() {
    assert_eq!(encoder::apply(98, 5), 100);
    assert_eq!(encoder::apply(3, -10), 0);
    assert_eq!(encoder::apply(250, -1), 99);
}

/// Keep-alive messages recorded from the controller's own software.
const RECORDED: [&str; 4] = [
    "534d0900652d9d0b00",
    "534d0900393c9e0b00",
    "534d0900f4cc9f0b00",
    "534d0900138da00b00",
];

#[test]
fn recorded_messages_validate() {
    for recorded in RECORDED {
        assert!(display::is_valid(&hex(recorded)), "{recorded}");
    }
}

#[test]
fn a_heartbeat_matches_the_recording_byte_for_byte() {
    let mut sequence = Sequence::starting_at(0x0b9d);
    for recorded in RECORDED {
        assert_eq!(display::heartbeat(&mut sequence), hex(recorded));
    }
}

#[test]
fn a_corrupted_message_is_refused() {
    let mut message = hex(RECORDED[0]);
    message[8] = 1;
    assert!(!display::is_valid(&message));
    assert!(!display::is_valid(b"SM"));
    assert!(!display::is_valid(&[b'X', b'M', 9, 0, 0, 0, 0, 0, 0]));
}

#[test]
fn brightness_is_framed_and_capped() {
    let mut sequence = Sequence::default();
    let message = display::brightness(250, &mut sequence);
    assert!(display::is_valid(&message));
    // Recorded from the official software as `31 01 00 VV` and the list's end.
    assert_eq!(&message[8..], &[0x31, 0x01, 0x00, 100, 0x00]);
}

#[test]
fn a_long_message_spans_padded_packets() {
    let mut sequence = Sequence::default();
    let message = display::message(&vec![7u8; 2000], &mut sequence);
    let packets = display::packets(&message);
    assert_eq!(packets.len(), 3);
    assert_eq!(
        packets[2][2008 - 2 * display::PACKET_SIZE..],
        [0u8; 3 * display::PACKET_SIZE - 2008][..]
    );
}

fn flat_image(colors: usize) -> Vec<u8> {
    (0..display::WIDTH * display::HEIGHT)
        .flat_map(|pixel| {
            let color = (pixel % colors) as u32 * 997;
            [(color >> 16) as u8, (color >> 8) as u8, color as u8]
        })
        .collect()
}

#[test]
fn a_few_colors_are_kept_exactly() {
    let frame = IndexedFrame::from_rgb(&flat_image(3)).unwrap();
    assert_eq!(frame.pixels.len(), display::WIDTH * display::HEIGHT);
    assert_eq!(&frame.pixels[..4], &[0, 1, 2, 0]);
    assert_eq!(frame.palette[0], display::rgb565(0, 0, 0));
}

#[test]
fn many_colors_fall_back_to_a_fixed_palette() {
    let frame = IndexedFrame::from_rgb(&flat_image(5_000)).unwrap();
    assert_eq!(frame.palette[0xff], display::rgb565(255, 255, 255));
    assert!(IndexedFrame::from_rgb(&[0u8; 12]).is_none());
}

#[test]
fn an_image_is_thirty_two_messages_of_the_recorded_sizes() {
    let frame = IndexedFrame::from_rgb(&flat_image(2)).unwrap();
    let mut sequence = Sequence::starting_at(40);
    let setup = [0x38u8; 16];
    let first = frame.messages(Some(&setup), &mut sequence);
    assert_eq!(first.len(), display::CHUNK_COUNT);
    assert_eq!(first[0].len(), 4633);
    assert!(first[1..].iter().all(|message| message.len() == 4098));
    assert!(first.iter().all(|message| display::is_valid(message)));
    assert_eq!(first[5][10], 5, "each message names its chunk");
    let redraw = frame.messages(None, &mut sequence);
    assert_eq!(redraw[0].len(), 4098);
    assert_eq!(u16::from_le_bytes([redraw[0][6], redraw[0][7]]), 72);
}
