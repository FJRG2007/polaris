//! The screen: the display's initialization and keep-alive bytes against
//! frames recorded from the official software, the tile layout, the order a
//! session sends things in, and the page drawn from the knobs.

use polaris_stream100::audio::Session;
use polaris_stream100::display::{
    self, IndexedFrame, Sequence, ACK, CHUNK_COUNT, CHUNK_SIZE, CUSTOM_BACKGROUND, END, HEIGHT,
    HOST_KEEPALIVE, MAX_TRANSFER_PACKETS, PACKET_SIZE, SCREEN_OFF, SCREEN_ON, TILE_BLOCKS,
    TILE_OFFSETS, WIDTH,
};
use polaris_stream100::engine::{Command, Engine, Output};
use polaris_stream100::plugin::Locale;
use polaris_stream100::report::KnobMap;
use polaris_stream100::screen::{
    render, Call, Knob, NowPlaying, Painter, Person, Screen, TILE_EVERY,
};
use polaris_stream100::session::KEEPALIVE_EVERY;
use polaris_stream100::settings::{DisplayMode, Settings};
use std::time::{Duration, Instant};

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

/// Messages recorded from the official Windows software (CataclysmX/New-Hera-lunx,
/// `driver/rust/hsm01-proto/src/frame.rs`, frames 311, 2079 and 2049 of its capture):
/// the keep-alive, the start-up configuration, and an acknowledgement.
const RECORDED_KEEPALIVE: &str =
    "534d2200b89a010010010a000000f465c80251010000000000000000000000001100";
const RECORDED_CONFIG: &str = "534d1e007a7c24001431010064380004ffffffffffffffff04ffffffff00";
const RECORDED_ACK: &str = "534d0a00ad1a1d001400";

fn sequence_of(message: &[u8]) -> u16 {
    u16::from_le_bytes([message[6], message[7]])
}

#[test]
fn the_recorded_initialization_messages_pass_the_checksum() {
    for recorded in [RECORDED_KEEPALIVE, RECORDED_CONFIG, RECORDED_ACK] {
        assert!(display::is_valid(&hex(recorded)), "{recorded}");
    }
}

#[test]
fn the_keep_alive_is_the_recorded_one_byte_for_byte() {
    let recorded = hex(RECORDED_KEEPALIVE);
    let mut sequence = Sequence::starting_at(sequence_of(&recorded));
    assert_eq!(display::message(&HOST_KEEPALIVE, &mut sequence), recorded);
}

#[test]
fn the_acknowledgement_is_the_recorded_one_byte_for_byte() {
    let recorded = hex(RECORDED_ACK);
    let mut sequence = Sequence::starting_at(sequence_of(&recorded));
    assert_eq!(display::message(&[ACK, END], &mut sequence), recorded);
}

#[test]
fn the_brightness_command_is_the_recorded_one() {
    let recorded = hex(RECORDED_CONFIG);
    // ack, brightness 100, configuration, end.
    assert_eq!(&recorded[9..13], &display::brightness_command(100));
    assert_eq!(display::brightness_command(250), [0x31, 0x01, 0x00, 100]);
    let mut sequence = Sequence::default();
    assert_eq!(display::brightness(80, &mut sequence).len(), 13);
}

#[test]
fn the_custom_background_configuration_has_the_recorded_shape() {
    let recorded = hex(RECORDED_CONFIG);
    let configuration = &recorded[13..29];
    assert_eq!(configuration[0], CUSTOM_BACKGROUND[0]);
    assert_eq!(configuration.len(), CUSTOM_BACKGROUND.len());
    // Recorded with the Hercules background (type 4); Polaris' own is 0xff.
    assert_eq!(configuration[2], 0x04);
    assert_eq!(CUSTOM_BACKGROUND[2], 0xff);
    assert_eq!(SCREEN_ON, [0x12, 0, 0, 0, 0]);
    assert_eq!(SCREEN_OFF, [0x13, 0, 0, 0, 0]);
}

#[test]
fn a_transfer_starts_with_the_sync_packet() {
    let mut sequence = Sequence::default();
    let message = display::message(&HOST_KEEPALIVE, &mut sequence);
    let transfer = display::transfer(&message).unwrap();
    assert_eq!(transfer.len(), 2 * PACKET_SIZE);
    assert_eq!(&transfer[..8], b"HERCULES");
    assert!(transfer[8..PACKET_SIZE].iter().all(|byte| *byte == 0));
    assert_eq!(
        &transfer[PACKET_SIZE..PACKET_SIZE + message.len()],
        &message[..]
    );
    assert!(transfer[PACKET_SIZE + message.len()..]
        .iter()
        .all(|byte| *byte == 0));
    let longest = display::message(&vec![0u8; 9 * PACKET_SIZE - 8], &mut sequence);
    assert_eq!(
        display::transfer(&longest).unwrap().len(),
        MAX_TRANSFER_PACKETS * PACKET_SIZE
    );
    let too_long = display::message(&vec![0u8; 9 * PACKET_SIZE], &mut sequence);
    assert!(display::transfer(&too_long).is_none());
}

#[test]
fn every_pixel_is_in_exactly_one_tile() {
    let mut seen = [0u8; 32];
    for (dx, dy) in TILE_OFFSETS {
        seen[usize::from(dy) * 8 + usize::from(dx)] += 1;
    }
    assert!(seen.iter().all(|count| *count == 1));
    assert_eq!(TILE_OFFSETS[0], (0, 0));
}

#[test]
fn a_tile_samples_its_offset_across_the_whole_screen() {
    // Each pixel holds its own offset inside its 8x4 block.
    let pixels = (0..WIDTH * HEIGHT)
        .map(|at| ((at % WIDTH) % 8 + 8 * ((at / WIDTH) % 4)) as u8)
        .collect();
    let frame = IndexedFrame {
        palette: [0; 256],
        pixels,
    };
    for (tile, (dx, dy)) in TILE_OFFSETS.iter().enumerate() {
        let samples = frame.tile(tile);
        assert_eq!(samples.len(), 4080);
        let expected = dx + 8 * dy;
        assert!(samples.iter().all(|sample| *sample == expected), "{tile}");
    }
}

fn report_with_message(kind: u8, valid: bool) -> Vec<u8> {
    let mut report = vec![0u8; 64];
    report[0] = 12;
    let mut message = vec![b's', b'm', 10, 0, 7, 0, kind, 0, 0, 0];
    let sum = message
        .iter()
        .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
    message[9] = 0u8.wrapping_sub(sum).wrapping_add(u8::from(!valid));
    report[12..22].copy_from_slice(&message);
    report
}

#[test]
fn only_a_device_information_message_asks_for_an_acknowledgement() {
    assert!(display::asks_for_ack(&report_with_message(1, true)));
    assert!(!display::asks_for_ack(&report_with_message(2, true)));
    assert!(!display::asks_for_ack(&report_with_message(1, false)));
    assert!(!display::asks_for_ack(&[12u8; 11]));
    assert!(!display::asks_for_ack(&[]));
    assert!(!display::asks_for_ack(&[200, 0, 0]));
}

fn knob(label: &str, volume: Option<u8>, muted: bool) -> Knob {
    Knob {
        label: label.to_owned(),
        volume,
        muted,
    }
}

fn page(volume: u8) -> Screen {
    Screen {
        mode: DisplayMode::Mixer,
        brightness: 80,
        knobs: [
            knob("Calls", Some(volume), false),
            knob("Music", Some(100), true),
            knob("Games", None, false),
            knob("A very long program name", Some(0), false),
        ],
        locale: Locale::EnUs,
        call: None,
        playing: None,
    }
}

/// The SM message inside a transfer.
fn message_of(transfer: &[u8]) -> Vec<u8> {
    assert_eq!(&transfer[..8], b"HERCULES");
    let message = &transfer[PACKET_SIZE..];
    let length = usize::from(u16::from_le_bytes([message[2], message[3]]));
    message[..length].to_vec()
}

/// Everything the painter sends in `span`, stepping 1 ms at a time.
fn run(painter: &mut Painter, start: Instant, span: Duration) -> Vec<Vec<u8>> {
    let mut sent = Vec::new();
    let mut at = Duration::ZERO;
    while at <= span {
        while let Some(transfer) = painter.next(start + at) {
            assert_eq!(transfer.len() % PACKET_SIZE, 0);
            assert!(transfer.len() <= MAX_TRANSFER_PACKETS * PACKET_SIZE);
            let message = message_of(&transfer);
            assert!(display::is_valid(&message));
            sent.push(message);
        }
        at += Duration::from_millis(1);
    }
    sent
}

fn draws(sent: &[Vec<u8>]) -> Vec<&Vec<u8>> {
    sent.iter()
        .filter(|message| {
            message[8..].windows(2).any(|w| w == [0x37, 0x01]) && message.len() > 4000
        })
        .collect()
}

#[test]
fn a_session_keeps_alive_on_its_own() {
    let mut painter = Painter::default();
    let start = Instant::now();
    let sent = run(&mut painter, start, Duration::from_millis(1_000));
    let keepalives = sent
        .iter()
        .filter(|message| message[8..] == HOST_KEEPALIVE)
        .count();
    let heartbeats = sent.iter().filter(|message| message[8..] == [END]).count();
    assert_eq!(keepalives + heartbeats, sent.len());
    assert!((4..=5).contains(&keepalives), "{keepalives}");
    // Never a quiet 20 ms slot.
    assert!(sent.len() >= 50, "{}", sent.len());
    let sequences: Vec<u16> = sent.iter().map(|message| sequence_of(message)).collect();
    assert!(sequences.windows(2).all(|pair| pair[1] == pair[0] + 1));
    assert!(KEEPALIVE_EVERY <= Duration::from_millis(500));
}

#[test]
fn the_first_page_sets_the_screen_up_then_sends_thirty_two_tiles_in_order() {
    let mut painter = Painter::default();
    painter.show(&page(40));
    let start = Instant::now();
    let sent = run(&mut painter, start, TILE_EVERY * 40);
    let tiles = draws(&sent);
    assert_eq!(tiles.len(), CHUNK_COUNT);
    let first = &tiles[0][8..];
    let setup = [
        &SCREEN_ON[..],
        &display::brightness_command(80),
        &CUSTOM_BACKGROUND,
    ]
    .concat();
    assert_eq!(&first[..setup.len()], &setup[..]);
    // Then the palette, then tile 0.
    assert_eq!(first[setup.len()], 0x33);
    // 8 header + 25 setup + 519 palette + 4089 tile + end.
    assert_eq!(tiles[0].len(), 4642);
    for (index, tile) in tiles.iter().enumerate().skip(1) {
        assert_eq!(tile.len(), 4098);
        assert_eq!(&tile[8..11], &[0x37, 0x01, index as u8]);
    }
    // Keep-alives still go out while it draws, all in one sequence.
    assert!(sent.iter().any(|message| message[8..] == HOST_KEEPALIVE));
    let sequences: Vec<u16> = sent.iter().map(|message| sequence_of(message)).collect();
    assert!(sequences.windows(2).all(|pair| pair[1] == pair[0] + 1));
    assert!(!painter.is_drawing());
}

#[test]
fn tiles_are_spaced_so_the_panel_draws_each_one() {
    let mut painter = Painter::default();
    painter.show(&page(40));
    let start = Instant::now();
    // Within one tile period only the first tile (and a keep-alive) go out.
    let sent = run(&mut painter, start, TILE_EVERY - Duration::from_millis(1));
    assert_eq!(draws(&sent).len(), 1);
    assert!(painter.wait(start + Duration::from_millis(1)) <= TILE_EVERY);
}

#[test]
fn an_unchanged_page_costs_nothing_and_a_brightness_change_costs_one_command() {
    let mut painter = Painter::default();
    painter.show(&page(40));
    let start = Instant::now();
    run(&mut painter, start, TILE_EVERY * 40);
    painter.show(&page(40));
    assert!(!painter.is_drawing());
    let mut brighter = page(40);
    brighter.brightness = 30;
    painter.show(&brighter);
    let later = start + TILE_EVERY * 41;
    let message = message_of(&painter.next(later).unwrap());
    assert_eq!(&message[8..], &[0x31, 0x01, 0x00, 30, 0x00]);
    assert!(!painter.is_drawing());
}

/// The tile number and samples of each tile message in `sent`.
fn tiles_in(sent: &[Vec<u8>]) -> Vec<(usize, Vec<u8>)> {
    draws(sent)
        .into_iter()
        .map(|message| {
            let body = &message[8..];
            let at = body
                .windows(2)
                .rposition(|w| w == [0x37, 0x01])
                .expect("a tile command");
            let tile = usize::from(body[at + 2]);
            let samples = body[at + 9..at + 9 + CHUNK_SIZE].to_vec();
            (tile, samples)
        })
        .collect()
}

/// A panel as the firmware may hold it: filling each sample's block (what it
/// does on the first pass), or storing only the sample.
struct Panel {
    pixels: Vec<u16>,
    fills: bool,
}

impl Panel {
    fn new(fills: bool) -> Self {
        Self {
            pixels: vec![u16::MAX; WIDTH * HEIGHT],
            fills,
        }
    }

    fn apply(&mut self, sent: &[Vec<u8>]) {
        for (tile, samples) in tiles_in(sent) {
            let (dx, dy) = TILE_OFFSETS[tile];
            let (width, height) = if self.fills {
                TILE_BLOCKS[tile]
            } else {
                (1, 1)
            };
            for (index, value) in samples.iter().enumerate() {
                let x = (index % (WIDTH / 8)) * 8 + usize::from(dx);
                let y = (index / (WIDTH / 8)) * 4 + usize::from(dy);
                for row in 0..usize::from(height) {
                    for column in 0..usize::from(width) {
                        self.pixels[(y + row) * WIDTH + x + column] = u16::from(*value);
                    }
                }
            }
        }
    }

    fn shows(&self, screen: &Screen) -> bool {
        let frame = render(screen).unwrap();
        self.pixels
            .iter()
            .zip(&frame.pixels)
            .all(|(held, want)| *held == u16::from(*want))
    }
}

#[test]
fn a_coarse_tile_is_never_sent_after_a_finer_one_inside_its_block() {
    // The firmware's blocks nest: a tile's block never covers an earlier
    // tile's sample, so sending coarse to fine never undoes a sent tile.
    for (tile, (width, height)) in TILE_BLOCKS.iter().enumerate() {
        let (dx, dy) = TILE_OFFSETS[tile];
        assert!(usize::from(dx + width) <= 8 && usize::from(dy + height) <= 4);
        for (earlier, (ex, ey)) in TILE_OFFSETS.iter().copied().enumerate().take(tile) {
            let inside = (dx..dx + width).contains(&ex) && (dy..dy + height).contains(&ey);
            assert!(!inside, "tile {tile} covers tile {earlier}");
        }
    }
}

#[test]
fn a_new_volume_sends_only_the_tiles_that_changed_and_ends_right() {
    let mut painter = Painter::default();
    let start = Instant::now();
    let first = run(&mut painter, start, TILE_EVERY * 40);
    let mut filled = Panel::new(true);
    let mut sampled = Panel::new(false);
    filled.apply(&first);
    sampled.apply(&first);
    // Nothing was shown yet: the first page is still drawn whole.
    painter.show(&page(40));
    let whole = run(&mut painter, start + TILE_EVERY * 41, TILE_EVERY * 40);
    assert_eq!(draws(&whole).len(), CHUNK_COUNT);
    filled.apply(&whole);
    sampled.apply(&whole);

    // The value text changes too, so most tiles do; the screen's other
    // three knobs, labels and dividers are never resent on their own.
    painter.show(&page(42));
    let later = start + TILE_EVERY * 82;
    let change = run(&mut painter, later, TILE_EVERY * 40);
    let tiles = tiles_in(&change);
    assert!(!tiles.is_empty() && tiles.len() <= CHUNK_COUNT);
    assert!(tiles.windows(2).all(|pair| pair[0].0 < pair[1].0));
    assert!(change.iter().all(|message| message.len() <= 4098));
    filled.apply(&change);
    sampled.apply(&change);
    assert!(filled.shows(&page(42)) && sampled.shows(&page(42)));
    assert!(!painter.is_drawing());

    // The first tile of the change goes out within one tile period.
    painter.show(&page(44));
    let soon = run(
        &mut painter,
        later + TILE_EVERY * 41,
        TILE_EVERY - Duration::from_millis(1),
    );
    assert_eq!(draws(&soon).len(), 1);
}

#[test]
fn a_page_that_comes_in_mid_draw_supersedes_the_one_being_drawn() {
    let mut painter = Painter::default();
    let mut filled = Panel::new(true);
    let mut sampled = Panel::new(false);
    painter.show(&page(40));
    let start = Instant::now();
    let begun = run(&mut painter, start, TILE_EVERY * 3);
    assert_eq!(draws(&begun).len(), 4);
    painter.show(&page(50));
    painter.show(&page(60));
    let rest = run(&mut painter, start + TILE_EVERY * 4, TILE_EVERY * 80);
    // Not the rest of the first page and then the newest whole: only what
    // the newest still needs, and never a tile of the page in between.
    let tiles = draws(&rest);
    assert!(tiles.len() <= CHUNK_COUNT, "{} tiles", tiles.len());
    for panel in [&mut filled, &mut sampled] {
        panel.apply(&begun);
        panel.apply(&rest);
        assert!(panel.shows(&page(60)));
    }
    let fifty = render(&page(50)).unwrap();
    let sixty = render(&page(60)).unwrap();
    for (tile, samples) in tiles_in(&rest) {
        if fifty.tile(tile) != sixty.tile(tile) {
            assert_ne!(samples, fifty.tile(tile), "tile {tile} of the stale page");
        }
    }
}

#[test]
fn a_turn_is_followed_live_and_the_panel_settles_on_the_last_volume() {
    let mut painter = Painter::default();
    let start = Instant::now();
    painter.show(&page(10));
    let mut sent = run(&mut painter, start, TILE_EVERY * 40);
    // A turn: a new volume every 20 ms, for a second.
    let mut at = start + TILE_EVERY * 41;
    for step in 0..50u8 {
        painter.show(&page(10 + step));
        sent.extend(run(&mut painter, at, Duration::from_millis(19)));
        at += Duration::from_millis(20);
    }
    sent.extend(run(&mut painter, at, TILE_EVERY * 40));
    let mut filled = Panel::new(true);
    let mut sampled = Panel::new(false);
    filled.apply(&sent);
    sampled.apply(&sent);
    assert!(filled.shows(&page(59)) && sampled.shows(&page(59)));
}

#[test]
fn off_switches_the_screen_off_and_on_sets_it_up_again() {
    let mut painter = Painter::default();
    painter.show(&page(40));
    let start = Instant::now();
    run(&mut painter, start, TILE_EVERY * 40);
    let mut off = page(40);
    off.mode = DisplayMode::Off;
    painter.show(&off);
    let message = message_of(&painter.next(start + TILE_EVERY * 41).unwrap());
    assert_eq!(&message[8..], &[&SCREEN_OFF[..], &[END]].concat()[..]);
    painter.show(&page(40));
    let sent = run(&mut painter, start + TILE_EVERY * 42, TILE_EVERY * 40);
    let tiles = draws(&sent);
    assert_eq!(tiles.len(), CHUNK_COUNT);
    assert_eq!(&tiles[0][8..13], &SCREEN_ON);
}

#[test]
fn an_acknowledgement_goes_out_first() {
    let mut painter = Painter::default();
    painter.show(&page(40));
    painter.acknowledge();
    assert_eq!(painter.wait(Instant::now()), Duration::ZERO);
    let message = message_of(&painter.next(Instant::now()).unwrap());
    assert_eq!(&message[8..], &[ACK, END]);
}

fn pixel(frame: &IndexedFrame, x: usize, y: usize) -> u8 {
    frame.pixels[y * WIDTH + x]
}

#[test]
fn the_page_shows_each_knob_volume_as_a_bar() {
    let frame = render(&page(50)).unwrap();
    let background = pixel(&frame, 2, 2);
    // Knob 1 at 50%: the bar's lower half filled, its upper half empty track.
    let center = 60;
    let near_bottom = pixel(&frame, center, 250);
    let near_top = pixel(&frame, center, 106);
    assert_ne!(near_bottom, near_top);
    assert_ne!(near_top, background);
    // Knob 2 is muted at 100%: filled to the top, in another colour.
    let muted_top = pixel(&frame, 180, 106);
    assert_ne!(muted_top, near_top);
    assert_ne!(muted_top, near_bottom);
    // Knob 3 follows nothing playing: an empty track.
    assert_eq!(pixel(&frame, 300, 250), near_top);
    // Text is drawn under each label row.
    for column in 0..4 {
        let row = &frame.pixels[18 * WIDTH + column * 120..18 * WIDTH + column * 120 + 120];
        let label_rows: Vec<u8> = (18..32)
            .flat_map(|y| {
                frame.pixels[y * WIDTH + column * 120..y * WIDTH + column * 120 + 120].to_vec()
            })
            .collect();
        assert!(
            row.len() == 120 && label_rows.iter().any(|value| *value != background),
            "{column}"
        );
    }
    // A long name stays inside its column.
    for y in 18..32 {
        assert_eq!(pixel(&frame, 361, y), background);
        assert_eq!(pixel(&frame, 479, y), background);
    }
}

#[test]
fn a_different_volume_draws_a_different_page_and_off_draws_none() {
    assert_ne!(render(&page(10)), render(&page(90)));
    assert_eq!(render(&page(10)), render(&page(10)));
    let mut off = page(10);
    off.mode = DisplayMode::Off;
    assert!(render(&off).is_none());
}

fn session(id: &str, program: &str, volume: u8, muted: bool) -> Session {
    Session {
        id: id.to_owned(),
        program: program.to_owned(),
        pid: 1,
        system: false,
        volume,
        muted,
    }
}

#[test]
fn the_engine_shows_each_knob_after_this_report_applies() {
    let engine = Engine::new(Settings::default(), KnobMap::default());
    let sessions = [
        session("a", "Discord.exe", 30, false),
        session("b", "Spotify.exe", 70, true),
    ];
    let output = Output {
        volume: 55,
        muted: false,
    };
    let commands = [
        Command::SetVolume {
            id: "a".into(),
            volume: 32,
        },
        Command::SetOutputVolume { volume: 57 },
    ];
    let screen = engine.screen(&sessions, output, &commands);
    assert_eq!(screen.mode, DisplayMode::Mixer);
    assert_eq!(screen.brightness, 80);
    assert_eq!(screen.knobs[0], knob("Calls", Some(32), false));
    assert_eq!(screen.knobs[1], knob("Music", Some(70), true));
    assert_eq!(screen.knobs[2], knob("Games", None, false));
    assert_eq!(screen.knobs[3], knob("Output", Some(57), false));
}

fn lit(frame: &IndexedFrame, x: std::ops::Range<usize>, y: std::ops::Range<usize>) -> usize {
    y.flat_map(|row| x.clone().map(move |column| (column, row)))
        .filter(|&(column, row)| pixel(frame, column, row) != pixel(frame, 2, 2))
        .count()
}

fn person(name: &str, speaking: bool, muted: bool) -> Person {
    Person {
        name: name.to_owned(),
        speaking,
        muted,
        deafened: false,
    }
}

#[test]
fn spanish_accents_are_drawn_and_differ_from_the_plain_letters() {
    // Same word, one accented: the accent dots sit above the letters.
    let mut plain = page(50);
    plain.knobs[1].label = "MUSICA".to_owned();
    let mut accented = page(50);
    accented.knobs[1].label = "Música".to_owned();
    let (plain, accented) = (render(&plain).unwrap(), render(&accented).unwrap());
    assert_ne!(plain, accented);
    // The label's letters start at row 18; the accent is drawn in 14..18 (x 120 is the divider).
    assert_eq!(lit(&plain, 121..240, 14..18), 0);
    assert!(lit(&accented, 121..240, 14..18) > 0);
    // Every Spanish letter has a glyph of its own, none is the unknown box.
    let unknown = {
        let mut screen = page(50);
        screen.knobs[1].label = "\u{4e2d}".to_owned();
        render(&screen).unwrap()
    };
    for letter in ["Á", "É", "Í", "Ó", "Ú", "Ñ", "Ü", "¿", "¡", "á", "ñ", "ü"] {
        let mut screen = page(50);
        screen.knobs[1].label = letter.to_owned();
        let frame = render(&screen).unwrap();
        assert_ne!(frame, unknown, "{letter}");
        assert_ne!(frame, plain, "{letter}");
    }
    // Lower case draws as upper case.
    let upper = {
        let mut screen = page(50);
        screen.knobs[1].label = "ÑÚ".to_owned();
        render(&screen).unwrap()
    };
    let lower = {
        let mut screen = page(50);
        screen.knobs[1].label = "ñú".to_owned();
        render(&screen).unwrap()
    };
    assert_eq!(upper, lower);
}

fn call() -> Call {
    Call {
        participants: vec![
            person("Ana", true, false),
            person("Bea", false, true),
            person("Carlos", false, false),
        ],
        self_muted: false,
        self_deafened: false,
    }
}

#[test]
fn the_call_page_shows_the_call_and_falls_back_to_the_knobs_without_one() {
    let mut screen = page(50);
    screen.mode = DisplayMode::Call;
    let mixer = render(&page(50)).unwrap();
    // No call: the knobs.
    assert_eq!(render(&screen).unwrap(), mixer);
    screen.call = Some(call());
    let in_call = render(&screen).unwrap();
    assert_ne!(in_call, mixer);
    // Ana is speaking: her row's square is lit; Carlos' is not.
    assert!(lit(&in_call, 16..26, 106..116) > 0);
    assert_eq!(lit(&in_call, 16..26, 166..176), 0);
    // Muting this computer changes the page, and so does the language.
    let mut muted = screen.clone();
    muted.call.as_mut().unwrap().self_muted = true;
    assert_ne!(render(&muted).unwrap(), in_call);
    let mut spanish = screen.clone();
    spanish.locale = Locale::EsEs;
    assert_ne!(render(&spanish).unwrap(), in_call);
    // Many people: five rows, the last counting the rest, nothing below.
    let mut crowded = screen.clone();
    crowded.call.as_mut().unwrap().participants = (0..40)
        .map(|n| person(&format!("P{n}"), false, false))
        .collect();
    let frame = render(&crowded).unwrap();
    assert!(lit(&frame, 0..WIDTH, 224..240) > 0);
    assert_eq!(lit(&frame, 0..WIDTH, 256..HEIGHT), 0);
}

#[test]
fn the_now_playing_page_shows_the_track_and_falls_back_to_the_knobs() {
    let mut screen = page(50);
    screen.mode = DisplayMode::NowPlaying;
    let mixer = render(&page(50)).unwrap();
    assert_eq!(render(&screen).unwrap(), mixer);
    screen.playing = NowPlaying::new(
        "  Canción de una noche muy larga que no cabe en dos líneas de la pantalla ",
        "Rosalía",
        true,
    );
    let playing = render(&screen).unwrap();
    assert_ne!(playing, mixer);
    // Title on two lines, artist under it, all inside the margins.
    assert!(lit(&playing, 0..WIDTH, 76..104) > 0);
    assert!(lit(&playing, 0..WIDTH, 120..148) > 0);
    assert!(lit(&playing, 0..WIDTH, 190..211) > 0);
    assert_eq!(lit(&playing, 0..16, 0..HEIGHT), 0);
    assert_eq!(lit(&playing, WIDTH - 16..WIDTH, 0..HEIGHT), 0);
    let mut paused = screen.clone();
    paused.playing.as_mut().unwrap().playing = false;
    assert_ne!(render(&paused).unwrap(), playing);
    // A session that names nothing is nothing playing.
    assert_eq!(NowPlaying::new(" ", "\u{7}", true), None);
    assert_eq!(
        NowPlaying::new("a\nb", "", false).map(|now| now.title),
        Some("ab".to_owned())
    );
}

#[test]
fn a_new_call_or_track_redraws_the_page() {
    let mut painter = Painter::default();
    let start = Instant::now();
    let mut screen = page(50);
    screen.mode = DisplayMode::Call;
    screen.call = Some(call());
    painter.show(&screen);
    let first = run(&mut painter, start, Duration::from_secs(3));
    assert_eq!(draws(&first).len(), 32);
    screen.call.as_mut().unwrap().self_deafened = true;
    painter.show(&screen);
    let second = run(
        &mut painter,
        start + Duration::from_secs(3),
        Duration::from_secs(3),
    );
    assert_eq!(draws(&second).len(), 32);
}
