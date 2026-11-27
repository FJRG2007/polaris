//! What the controller's screen shows, drawn into frames, and the order those
//! frames go out in.
//!
//! - [`Screen`]: the page the settings ask for (each knob's name, volume and
//!   mute, the brightness), built by the engine from the audio state.
//! - [`render`]: that page as a 480x272 indexed image, with a fixed palette
//!   so a redraw never has to resend it.
//! - [`Painter`]: everything one session sends on the display interface -
//!   the keep-alive and the heartbeat between, the acknowledgement the controller asks for, and the 32
//!   tiles of each new page - as ready transfers, paced the way the official
//!   software paces them. It is the same on every transport; a transport
//!   only writes what it is handed.
//! - [`post`] / [`latest`]: the engine and the USB session live on different
//!   threads of the plugin process; the newest page is handed over here.
//!
//! The command bytes and the tile layout are in [`crate::display`].

use crate::display::{
    self, IndexedFrame, Sequence, ACK, CUSTOM_BACKGROUND, END, HEIGHT, HOST_KEEPALIVE,
    PALETTE_COLORS, SCREEN_OFF, SCREEN_ON, WIDTH,
};
use crate::session::KEEPALIVE_EVERY;
use crate::settings::DisplayMode;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One knob as the screen shows it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Knob {
    pub label: String,
    /// 0-100, or `None` when nothing it follows is playing.
    pub volume: Option<u8>,
    pub muted: bool,
}

/// The page the screen should show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    pub mode: DisplayMode,
    pub brightness: u8,
    pub knobs: [Knob; 4],
}

impl Screen {
    fn is_off(&self) -> bool {
        self.mode == DisplayMode::Off
    }

    /// Whether the pixels differ (brightness is a command of its own).
    fn same_picture(&self, other: &Screen) -> bool {
        self.is_off() == other.is_off() && (self.is_off() || self.knobs == other.knobs)
    }
}

static LATEST: Mutex<Option<Screen>> = Mutex::new(None);

/// Hands the newest page to whichever session draws it.
pub fn post(screen: Screen) {
    if let Ok(mut latest) = LATEST.lock() {
        *latest = Some(screen);
    }
}

/// The newest page posted, if any.
pub fn latest() -> Option<Screen> {
    LATEST.lock().ok().and_then(|latest| latest.clone())
}

const BACKGROUND: u8 = 0;
const TEXT: u8 = 1;
const DIM: u8 = 2;
const TRACK: u8 = 3;
const FILL: u8 = 4;
const MUTED: u8 = 5;
const DIVIDER: u8 = 6;

/// The page's colours as RGB, by palette index.
const COLORS: [(u8, u8, u8); 7] = [
    (16, 18, 22),
    (240, 242, 245),
    (140, 146, 156),
    (48, 52, 60),
    (64, 150, 255),
    (235, 80, 80),
    (36, 40, 46),
];

fn palette() -> [u16; PALETTE_COLORS] {
    let mut palette = [0u16; PALETTE_COLORS];
    for (entry, (red, green, blue)) in palette.iter_mut().zip(COLORS) {
        *entry = display::rgb565(red, green, blue);
    }
    palette
}

/// A 5x7 glyph, one row per byte, bit 4 the leftmost column.
fn glyph(c: char) -> [u8; 7] {
    match c {
        '0' => [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
        '1' => [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
        '2' => [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
        '3' => [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
        '4' => [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
        '5' => [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
        '6' => [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
        '7' => [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
        '9' => [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
        'A' => [0x0e, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11],
        'B' => [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
        'C' => [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
        'D' => [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
        'E' => [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
        'F' => [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
        'G' => [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
        'H' => [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
        'I' => [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
        'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
        'M' => [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
        'O' => [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
        'P' => [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
        'Q' => [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
        'R' => [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
        'S' => [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
        'T' => [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
        'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
        'X' => [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
        'Z' => [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
        '%' => [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
        '-' => [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
        '+' => [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
        '.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
        ':' => [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
        '/' => [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x00],
        '&' => [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
        '\'' => [0x0c, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
        '(' => [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
        ')' => [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
        '_' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
        ' ' => [0; 7],
        _ => [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
    }
}

/// The text as the font can draw it: upper case, accents dropped.
fn printable(text: &str) -> Vec<char> {
    text.chars()
        .flat_map(char::to_uppercase)
        .map(|c| match c {
            'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'A',
            'É' | 'È' | 'Ê' | 'Ë' => 'E',
            'Í' | 'Ì' | 'Î' | 'Ï' => 'I',
            'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' => 'O',
            'Ú' | 'Ù' | 'Û' | 'Ü' => 'U',
            'Ñ' => 'N',
            'Ç' => 'C',
            '\u{2013}' | '\u{2014}' => '-',
            other => other,
        })
        .collect()
}

struct Canvas {
    pixels: Vec<u8>,
}

impl Canvas {
    fn rect(&mut self, x: usize, y: usize, width: usize, height: usize, color: u8) {
        for row in y.min(HEIGHT)..(y + height).min(HEIGHT) {
            let start = row * WIDTH;
            self.pixels[start + x.min(WIDTH)..start + (x + width).min(WIDTH)].fill(color);
        }
    }

    /// Text centred on `center`, at `scale` pixels per font dot, cut to
    /// `max` characters (the last becomes `.` when cut).
    fn text(&mut self, text: &str, center: usize, y: usize, scale: usize, max: usize, color: u8) {
        let mut chars = printable(text);
        if chars.len() > max {
            chars.truncate(max);
            if let Some(last) = chars.last_mut() {
                *last = '.';
            }
        }
        let advance = 6 * scale;
        let width = (chars.len() * advance).saturating_sub(scale);
        let left = center.saturating_sub(width / 2);
        for (index, c) in chars.iter().enumerate() {
            for (row, bits) in glyph(*c).iter().enumerate() {
                for column in 0..5 {
                    if bits & (0x10 >> column) != 0 {
                        let x = left + index * advance + column * scale;
                        self.rect(x, y + row * scale, scale, scale, color);
                    }
                }
            }
        }
    }
}

/// Column width: one column under each knob.
const COLUMN: usize = WIDTH / 4;
const LABEL_Y: usize = 18;
const VALUE_Y: usize = 52;
const BAR_TOP: usize = 104;
const BAR_HEIGHT: usize = 148;
const BAR_WIDTH: usize = 28;

/// The page as an image. `Off` draws nothing: the screen is switched off.
pub fn render(screen: &Screen) -> Option<IndexedFrame> {
    if screen.is_off() {
        return None;
    }
    // Call and NowPlaying fall back to the mixer (settings.rs): Polaris has
    // no call roster or now-playing source in the plugin yet.
    let mut canvas = Canvas {
        pixels: vec![BACKGROUND; WIDTH * HEIGHT],
    };
    for (index, knob) in screen.knobs.iter().enumerate() {
        let left = index * COLUMN;
        let center = left + COLUMN / 2;
        if index > 0 {
            canvas.rect(left, 12, 1, HEIGHT - 24, DIVIDER);
        }
        canvas.text(&knob.label, center, LABEL_Y, 2, 9, TEXT);
        let (value, color) = match knob.volume {
            None => ("-".to_owned(), DIM),
            Some(volume) if knob.muted => (format!("{volume}%"), MUTED),
            Some(volume) => (format!("{volume}%"), TEXT),
        };
        canvas.text(&value, center, VALUE_Y, 4, 4, color);
        let bar_left = center - BAR_WIDTH / 2;
        canvas.rect(bar_left, BAR_TOP, BAR_WIDTH, BAR_HEIGHT, TRACK);
        if let Some(volume) = knob.volume {
            let filled = BAR_HEIGHT * usize::from(volume.min(100)) / 100;
            let fill = if knob.muted { MUTED } else { FILL };
            canvas.rect(
                bar_left,
                BAR_TOP + BAR_HEIGHT - filled,
                BAR_WIDTH,
                filled,
                fill,
            );
        }
    }
    Some(IndexedFrame {
        palette: palette(),
        pixels: canvas.pixels,
    })
}

/// Time between two tiles: the official software sends one tile every
/// other 20 ms slot, so the firmware has drawn one before the next arrives.
pub const TILE_EVERY: Duration = Duration::from_millis(40);
/// The official software never leaves the display interface quiet for more
/// than one 20 ms slot: an empty slot carries a heartbeat (`0x00` alone), and
/// the panel goes dark when that cadence stops (cont1nuity/hercules-stream-linux,
/// `docs/PROTOCOL.md`).
pub const HEARTBEAT_EVERY: Duration = Duration::from_millis(20);

/// What one session sends on the display interface, in order.
#[derive(Debug, Default)]
pub struct Painter {
    sequence: Sequence,
    /// Command lists still to send for the page being drawn.
    queue: VecDeque<Vec<u8>>,
    /// The page last queued (drawn, or being drawn).
    shown: Option<Screen>,
    /// A page that came in while another was still being drawn.
    waiting: Option<Screen>,
    /// Whether the screen is on with Polaris' background (set up once per
    /// session, and again after it was switched off).
    set_up: bool,
    ack: bool,
    last_keepalive: Option<Instant>,
    last_tile: Option<Instant>,
    last_sent: Option<Instant>,
}

impl Painter {
    /// Asks for `screen` to be drawn. Unchanged pages cost nothing; a page
    /// that comes in mid-draw waits for that draw to finish, so a knob being
    /// turned never restarts it forever.
    pub fn show(&mut self, screen: &Screen) {
        if self.shown.as_ref() == Some(screen) || self.waiting.as_ref() == Some(screen) {
            return;
        }
        if self.queue.is_empty() {
            self.queue_page(screen.clone());
        } else {
            self.waiting = Some(screen.clone());
        }
    }

    /// The controller asked for an acknowledgement ([`display::asks_for_ack`]).
    pub fn acknowledge(&mut self) {
        self.ack = true;
    }

    fn queue_page(&mut self, screen: Screen) {
        let previous = self.shown.replace(screen.clone());
        let Some(frame) = render(&screen) else {
            self.queue.push_back([&SCREEN_OFF[..], &[END]].concat());
            self.set_up = false;
            return;
        };
        let brightness = display::brightness_command(screen.brightness);
        let unchanged = previous
            .as_ref()
            .is_some_and(|previous| self.set_up && previous.same_picture(&screen));
        if unchanged {
            self.queue.push_back([&brightness[..], &[END]].concat());
            return;
        }
        let setup = if self.set_up {
            None
        } else {
            self.set_up = true;
            Some([&SCREEN_ON[..], &brightness[..], &CUSTOM_BACKGROUND[..]].concat())
        };
        let mut bodies = frame.bodies(setup.as_deref());
        if setup.is_none()
            && previous.is_some_and(|previous| previous.brightness != screen.brightness)
        {
            bodies[0].splice(0..0, brightness);
        }
        self.queue.extend(bodies);
    }

    /// The next transfer due at `now`, ready to write as is, or `None` when
    /// nothing is due yet ([`Painter::wait`] says for how long).
    pub fn next(&mut self, now: Instant) -> Option<Vec<u8>> {
        let body = if std::mem::take(&mut self.ack) {
            vec![ACK, END]
        } else if !self.queue.is_empty() && due(self.last_tile, now, TILE_EVERY) {
            self.last_tile = Some(now);
            let body = self.queue.pop_front()?;
            if self.queue.is_empty() {
                if let Some(waiting) = self.waiting.take() {
                    self.queue_page(waiting);
                }
            }
            body
        } else if due(self.last_keepalive, now, KEEPALIVE_EVERY) {
            self.last_keepalive = Some(now);
            HOST_KEEPALIVE.to_vec()
        } else if due(self.last_sent, now, HEARTBEAT_EVERY) {
            vec![END]
        } else {
            return None;
        };
        self.last_sent = Some(now);
        display::transfer(&display::message(&body, &mut self.sequence))
    }

    /// How long until [`Painter::next`] has something to send.
    pub fn wait(&self, now: Instant) -> Duration {
        if self.ack {
            return Duration::ZERO;
        }
        let idle = remaining(self.last_keepalive, now, KEEPALIVE_EVERY).min(remaining(
            self.last_sent,
            now,
            HEARTBEAT_EVERY,
        ));
        if self.queue.is_empty() {
            idle
        } else {
            idle.min(remaining(self.last_tile, now, TILE_EVERY))
        }
    }

    /// Whether a page is still being drawn.
    pub fn is_drawing(&self) -> bool {
        !self.queue.is_empty()
    }
}

fn due(last: Option<Instant>, now: Instant, every: Duration) -> bool {
    last.is_none_or(|at| now.saturating_duration_since(at) >= every)
}

fn remaining(last: Option<Instant>, now: Instant, every: Duration) -> Duration {
    last.map_or(Duration::ZERO, |at| {
        every.saturating_sub(now.saturating_duration_since(at))
    })
}
