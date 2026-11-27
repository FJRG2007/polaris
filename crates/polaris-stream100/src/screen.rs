//! What the controller's screen shows, drawn into frames, and the order those
//! frames go out in.
//!
//! - [`Screen`]: the page the settings ask for (each knob's name, volume and
//!   mute; the Polaris call; what is playing; the brightness), built by the
//!   engine from the audio state, in the desktop app's language.
//! - [`render`]: that page as a 480x272 indexed image, with a fixed palette
//!   so a redraw never has to resend it.
//! - [`Painter`]: everything one session sends on the display interface -
//!   the keep-alive and the heartbeat between, the acknowledgement the controller asks for, and the
//!   tiles of each new page that differ from what the panel shows - as ready
//!   transfers, paced the way the official software paces them. It is the same on every transport; a transport
//!   only writes what it is handed.
//! - [`post`] / [`latest`]: the engine and the USB session live on different
//!   threads of the plugin process; the newest page is handed over here.
//!
//! The command bytes and the tile layout are in [`crate::display`].

use crate::display::{
    self, IndexedFrame, Sequence, ACK, CHUNK_COUNT, CUSTOM_BACKGROUND, END, HEIGHT, HOST_KEEPALIVE,
    PALETTE_COLORS, SCREEN_OFF, SCREEN_ON, WIDTH,
};
use crate::plugin::Locale;
use crate::session::KEEPALIVE_EVERY;
use crate::settings::DisplayMode;
use serde::{Deserialize, Serialize};
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

/// Somebody in the call, as the desktop app's call state names them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Person {
    pub name: String,
    pub speaking: bool,
    pub muted: bool,
    pub deafened: bool,
}

/// The Polaris call this computer is in: the shape the desktop app answers
/// `polaris.state` with (`call`, `clients/desktop/src/shared/voice-widget.ts`).
/// Whether the camera is on is not part of it, so the page does not claim it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Call {
    pub participants: Vec<Person>,
    pub self_muted: bool,
    pub self_deafened: bool,
}

/// More people than this are counted, not kept.
const MAX_PEOPLE: usize = 64;
/// Longest name or title kept, in characters.
const MAX_TEXT: usize = 120;

/// `text` with control characters dropped, trimmed and cut to [`MAX_TEXT`].
fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_TEXT)
        .collect()
}

impl Call {
    /// The same call with every name cleaned and at most [`MAX_PEOPLE`] kept.
    pub fn bounded(mut self) -> Self {
        self.participants.truncate(MAX_PEOPLE);
        for person in &mut self.participants {
            person.name = clean(&person.name);
        }
        self
    }
}

/// What the system's media session says is playing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    /// Playing, rather than paused.
    pub playing: bool,
}

impl NowPlaying {
    /// A media session's texts, cleaned; `None` when it names nothing.
    pub fn new(title: &str, artist: &str, playing: bool) -> Option<Self> {
        let (title, artist) = (clean(title), clean(artist));
        (!title.is_empty() || !artist.is_empty()).then_some(Self {
            title,
            artist,
            playing,
        })
    }
}

/// The page the screen should show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    pub mode: DisplayMode,
    pub brightness: u8,
    pub knobs: [Knob; 4],
    /// The language its words are drawn in.
    pub locale: Locale,
    /// The call `Call` mode shows; with none it shows the knobs.
    pub call: Option<Call>,
    /// What `NowPlaying` mode shows; with nothing it shows the knobs.
    pub playing: Option<NowPlaying>,
}

impl Screen {
    fn is_off(&self) -> bool {
        self.mode == DisplayMode::Off
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

/// Rows above a letter's body, where an accent goes.
const ACCENT_ROWS: usize = 2;
/// A glyph's height in font dots: the accent rows, then a 5x7 body.
const GLYPH_ROWS: usize = ACCENT_ROWS + 7;

/// A 5x7 letter body, one row per byte, bit 4 the leftmost column.
fn body(c: char) -> [u8; 7] {
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
        '!' => [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
        '?' => [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
        '¡' => [0x04, 0x00, 0x04, 0x04, 0x04, 0x04, 0x04],
        '¿' => [0x04, 0x00, 0x04, 0x08, 0x10, 0x11, 0x0e],
        ',' => [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
        '"' => [0x0a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00],
        '#' => [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00],
        ' ' => [0; 7],
        // Anything the font has no letter for: a hollow box.
        _ => [0x1f, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1f],
    }
}

/// A letter with its accent: the accent rows, then the body.
fn glyph(c: char) -> [u8; GLYPH_ROWS] {
    let (base, accent) = match c {
        'Á' => ('A', [0x02, 0x04]),
        'É' => ('E', [0x02, 0x04]),
        'Í' => ('I', [0x02, 0x04]),
        'Ó' => ('O', [0x02, 0x04]),
        'Ú' => ('U', [0x02, 0x04]),
        'Ñ' => ('N', [0x0d, 0x16]),
        'Ü' => ('U', [0x00, 0x0a]),
        other => (other, [0, 0]),
    };
    let mut rows = [0u8; GLYPH_ROWS];
    rows[..ACCENT_ROWS].copy_from_slice(&accent);
    rows[ACCENT_ROWS..].copy_from_slice(&body(base));
    rows
}

/// The text as the font can draw it: upper case; the Spanish accents kept
/// (Á É Í Ó Ú Ñ Ü ¿ ¡), any other accent dropped.
fn printable(text: &str) -> Vec<char> {
    text.chars()
        .flat_map(char::to_uppercase)
        .map(|c| match c {
            'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'A',
            'È' | 'Ê' | 'Ë' => 'E',
            'Ì' | 'Î' | 'Ï' => 'I',
            'Ò' | 'Ô' | 'Ö' | 'Õ' => 'O',
            'Ù' | 'Û' => 'U',
            'Ç' => 'C',
            '\u{2013}' | '\u{2014}' => '-',
            '\u{2018}' | '\u{2019}' => '\'',
            '\u{201c}' | '\u{201d}' => '"',
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

    /// `chars` cut to `max` (the last becomes `.` when cut).
    fn fit(text: &str, max: usize) -> Vec<char> {
        let mut chars = printable(text);
        if chars.len() > max {
            chars.truncate(max);
            if let Some(last) = chars.last_mut() {
                *last = '.';
            }
        }
        chars
    }

    /// Text from `left`, its letters' tops at `y` (accents sit above), at
    /// `scale` pixels per font dot, cut to `max` characters.
    fn text_at(&mut self, text: &str, left: usize, y: usize, scale: usize, max: usize, color: u8) {
        let advance = 6 * scale;
        let top = y.saturating_sub(ACCENT_ROWS * scale);
        for (index, c) in Self::fit(text, max).iter().enumerate() {
            for (row, bits) in glyph(*c).iter().enumerate() {
                for column in 0..5 {
                    if bits & (0x10 >> column) != 0 {
                        let x = left + index * advance + column * scale;
                        self.rect(x, top + row * scale, scale, scale, color);
                    }
                }
            }
        }
    }

    /// Text centred on `center`, otherwise as [`Canvas::text_at`].
    fn text(&mut self, text: &str, center: usize, y: usize, scale: usize, max: usize, color: u8) {
        let count = Self::fit(text, max).len();
        let width = (count * 6 * scale).saturating_sub(scale);
        let left = center.saturating_sub(width / 2);
        self.text_at(text, left, y, scale, max, color);
    }
}

/// Column width: one column under each knob.
const COLUMN: usize = WIDTH / 4;
const LABEL_Y: usize = 18;
const VALUE_Y: usize = 52;
const BAR_TOP: usize = 104;
const BAR_HEIGHT: usize = 148;
const BAR_WIDTH: usize = 28;

/// Space kept clear at the screen's left and right edges.
const MARGIN: usize = 16;

/// The page as an image. `Off` draws nothing: the screen is switched off.
/// `Call` with no call and `NowPlaying` with nothing playing show the knobs.
pub fn render(screen: &Screen) -> Option<IndexedFrame> {
    if screen.is_off() {
        return None;
    }
    let mut canvas = Canvas {
        pixels: vec![BACKGROUND; WIDTH * HEIGHT],
    };
    match (screen.mode, &screen.call, &screen.playing) {
        (DisplayMode::Call, Some(call), _) => call_page(&mut canvas, call, screen.locale),
        (DisplayMode::NowPlaying, _, Some(playing)) => {
            playing_page(&mut canvas, playing, screen.locale)
        }
        _ => mixer_page(&mut canvas, &screen.knobs),
    }
    Some(IndexedFrame {
        palette: palette(),
        pixels: canvas.pixels,
    })
}

fn mixer_page(canvas: &mut Canvas, knobs: &[Knob; 4]) {
    for (index, knob) in knobs.iter().enumerate() {
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
}

/// People listed on the call page; the rest are counted.
const CALL_ROWS: usize = 5;
const CALL_ROW_TOP: usize = 104;
const CALL_ROW_HEIGHT: usize = 30;

/// The call: how many are in it, this computer's microphone and sound, and
/// the people in it (who is speaking, who is muted).
fn call_page(canvas: &mut Canvas, call: &Call, locale: Locale) {
    let count = call.participants.len();
    let header = format!("{} - {count}", locale.pick("In call", "En llamada"));
    canvas.text(&header, WIDTH / 2, 16, 3, 24, TEXT);
    let (mic, mic_color) = if call.self_muted {
        (locale.pick("Muted", "Silenciado"), MUTED)
    } else {
        (locale.pick("Mic on", "Micro activo"), FILL)
    };
    let (sound, sound_color) = if call.self_deafened {
        (locale.pick("Deafened", "Ensordecido"), MUTED)
    } else {
        (locale.pick("Hearing", "Oyendo"), FILL)
    };
    canvas.text(mic, WIDTH / 4, 60, 2, 17, mic_color);
    canvas.text(sound, WIDTH * 3 / 4, 60, 2, 17, sound_color);
    canvas.rect(MARGIN, 88, WIDTH - 2 * MARGIN, 1, DIVIDER);
    let shown = if count > CALL_ROWS {
        CALL_ROWS - 1
    } else {
        count
    };
    for (row, person) in call.participants.iter().take(shown).enumerate() {
        let y = CALL_ROW_TOP + row * CALL_ROW_HEIGHT;
        // A lit square for whoever is speaking.
        if person.speaking {
            canvas.rect(MARGIN, y + 2, 10, 10, FILL);
        }
        let color = if person.muted || person.deafened {
            DIM
        } else {
            TEXT
        };
        canvas.text_at(&person.name, MARGIN + 20, y, 2, 25, color);
        let state = if person.deafened {
            locale.pick("Deafened", "Ensordecido")
        } else if person.muted {
            locale.pick("Muted", "Silenciado")
        } else {
            ""
        };
        let width = state.chars().count() * 12;
        canvas.text_at(state, WIDTH - MARGIN - width, y, 2, 11, MUTED);
    }
    if count > shown {
        let more = format!("+{} {}", count - shown, locale.pick("more", "más"));
        let y = CALL_ROW_TOP + shown * CALL_ROW_HEIGHT;
        canvas.text_at(&more, MARGIN + 20, y, 2, 25, DIM);
    }
}

/// `text` in at most `lines` lines of `width` characters, broken between
/// words where it can; the last line is cut with `.` when it does not fit.
fn wrap(text: &str, width: usize, lines: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut words = text.split_whitespace().peekable();
    while out.len() < lines && words.peek().is_some() {
        let mut line = String::new();
        while let Some(word) = words.peek() {
            let needed =
                line.chars().count() + usize::from(!line.is_empty()) + word.chars().count();
            if needed > width && !line.is_empty() {
                break;
            }
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
            words.next();
        }
        out.push(line);
    }
    if let (Some(last), Some(_)) = (out.last_mut(), words.peek()) {
        // More words than lines: mark the cut.
        let kept: String = last.chars().take(width.saturating_sub(1)).collect();
        *last = format!("{kept}.");
    }
    out
}

/// What is playing: playing or paused, the title (two lines) and the artist.
fn playing_page(canvas: &mut Canvas, playing: &NowPlaying, locale: Locale) {
    let state = if playing.playing {
        locale.pick("Now playing", "Suena ahora")
    } else {
        locale.pick("Paused", "En pausa")
    };
    canvas.text(state, WIDTH / 2, 24, 2, 36, DIM);
    // 4 pixels a dot: 24 a letter, 18 letters between the margins.
    let title_width = (WIDTH - 2 * MARGIN) / 24;
    for (line, text) in wrap(&playing.title, title_width, 2).iter().enumerate() {
        canvas.text(text, WIDTH / 2, 76 + line * 44, 4, title_width, TEXT);
    }
    let artist_width = (WIDTH - 2 * MARGIN) / 18;
    canvas.text(&playing.artist, WIDTH / 2, 190, 3, artist_width, DIM);
    let bar = if playing.playing { FILL } else { TRACK };
    canvas.rect(MARGIN, HEIGHT - 24, WIDTH - 2 * MARGIN, 4, bar);
}

/// Time between two tiles: the official software sends one tile every
/// other 20 ms slot, so the firmware has drawn one before the next arrives.
pub const TILE_EVERY: Duration = Duration::from_millis(40);
/// The official software never leaves the display interface quiet for more
/// than one 20 ms slot: an empty slot carries a heartbeat (`0x00` alone), and
/// the panel goes dark when that cadence stops (cont1nuity/hercules-stream-linux,
/// `docs/PROTOCOL.md`).
pub const HEARTBEAT_EVERY: Duration = Duration::from_millis(20);

/// A pixel the panel holds that Polaris does not know (nothing drawn yet in
/// this session, or the screen was switched off since).
const UNKNOWN: u16 = 256;

/// What one session sends on the display interface, in order.
///
/// It keeps a model of the panel and sends only the tiles whose pixels
/// differ from the newest page, coarse to fine, one per [`TILE_EVERY`]. A
/// page that comes in mid-draw replaces the one being drawn at once: the
/// tiles still owed to the older page are never sent, and the next tile is
/// the first one the newer page needs.
///
/// The panel is modelled twice, because how the firmware treats a tile sent
/// again after the whole picture is not documented: once as if it fills each
/// sample's block ([`display::TILE_BLOCKS`], what it does on the first pass)
/// and once as if it stores only the sample. A tile goes out while either
/// model differs from the page, so the picture ends right under both.
#[derive(Debug)]
pub struct Painter {
    sequence: Sequence,
    /// Command lists that go out on their own (the screen switched off).
    queue: VecDeque<Vec<u8>>,
    /// The newest page asked for.
    shown: Option<Screen>,
    /// Its picture, while the screen is on.
    target: Option<IndexedFrame>,
    /// The panel if the firmware fills each sample's block.
    filled: Vec<u16>,
    /// The panel if it stores only each sample.
    sampled: Vec<u16>,
    /// Whether the screen is on with Polaris' background (set up once per
    /// session, and again after it was switched off).
    set_up: bool,
    /// The screen set-up (with the palette) rides on the next tile.
    setup_due: bool,
    /// A new brightness rides on the next tile, or goes alone.
    brightness_due: bool,
    ack: bool,
    last_keepalive: Option<Instant>,
    last_tile: Option<Instant>,
    last_sent: Option<Instant>,
}

impl Default for Painter {
    fn default() -> Self {
        Self {
            sequence: Sequence::default(),
            queue: VecDeque::new(),
            shown: None,
            target: None,
            filled: vec![UNKNOWN; WIDTH * HEIGHT],
            sampled: vec![UNKNOWN; WIDTH * HEIGHT],
            set_up: false,
            setup_due: false,
            brightness_due: false,
            ack: false,
            last_keepalive: None,
            last_tile: None,
            last_sent: None,
        }
    }
}

/// The pixel index of each of tile `tile`'s samples, in the order it sends them.
fn samples(tile: usize) -> impl Iterator<Item = usize> {
    let (dx, dy) = display::TILE_OFFSETS[tile];
    (0..HEIGHT / 4).flat_map(move |row| {
        (0..WIDTH / 8)
            .map(move |column| (row * 4 + usize::from(dy)) * WIDTH + column * 8 + usize::from(dx))
    })
}

impl Painter {
    /// Asks for `screen` to be drawn. Unchanged pages cost nothing; a page
    /// that comes in mid-draw supersedes the one being drawn.
    pub fn show(&mut self, screen: &Screen) {
        if self.shown.as_ref() == Some(screen) {
            return;
        }
        let previous = self.shown.replace(screen.clone());
        let Some(frame) = render(screen) else {
            if self.set_up || previous.is_none() {
                self.queue.push_back([&SCREEN_OFF[..], &[END]].concat());
            }
            self.forget_panel();
            return;
        };
        if !self.set_up {
            self.set_up = true;
            self.setup_due = true;
            self.brightness_due = false;
        } else if previous.is_some_and(|previous| previous.brightness != screen.brightness) {
            self.brightness_due = true;
        }
        self.target = Some(frame);
    }

    /// The screen went off: what it shows next is set up and drawn whole.
    fn forget_panel(&mut self) {
        self.set_up = false;
        self.setup_due = false;
        self.brightness_due = false;
        self.target = None;
        self.filled.fill(UNKNOWN);
        self.sampled.fill(UNKNOWN);
    }

    /// The controller asked for an acknowledgement ([`display::asks_for_ack`]).
    pub fn acknowledge(&mut self) {
        self.ack = true;
    }

    /// The first tile, coarse to fine, whose samples the panel does not
    /// show yet under either model.
    fn next_tile(&self) -> Option<usize> {
        let target = self.target.as_ref()?;
        (0..CHUNK_COUNT).find(|tile| {
            samples(*tile).any(|at| {
                let want = u16::from(target.pixels[at]);
                self.filled[at] != want || self.sampled[at] != want
            })
        })
    }

    /// The panel after `tile` of the newest page went out.
    fn sent_tile(&mut self, tile: usize) {
        let Some(target) = self.target.as_ref() else {
            return;
        };
        let (width, height) = display::TILE_BLOCKS[tile];
        for at in samples(tile) {
            let value = u16::from(target.pixels[at]);
            self.sampled[at] = value;
            for row in 0..usize::from(height) {
                let start = at + row * WIDTH;
                self.filled[start..start + usize::from(width)].fill(value);
            }
        }
    }

    /// The commands that ride ahead of the next tile (no [`END`]).
    fn prefix(&mut self) -> Vec<u8> {
        let Some(screen) = self.shown.as_ref() else {
            return Vec::new();
        };
        let brightness = display::brightness_command(screen.brightness);
        if std::mem::take(&mut self.setup_due) {
            self.brightness_due = false;
            let palette = self
                .target
                .as_ref()
                .map(IndexedFrame::palette_command)
                .unwrap_or_default();
            return [
                &SCREEN_ON[..],
                &brightness[..],
                &CUSTOM_BACKGROUND[..],
                &palette[..],
            ]
            .concat();
        }
        if std::mem::take(&mut self.brightness_due) {
            return brightness.to_vec();
        }
        Vec::new()
    }

    /// The next drawing transfer's body, when one is owed.
    fn next_draw(&mut self) -> Option<Vec<u8>> {
        if let Some(body) = self.queue.pop_front() {
            return Some(body);
        }
        let tile = self.next_tile();
        if tile.is_none() && !self.setup_due && !self.brightness_due {
            return None;
        }
        let prefix = self.prefix();
        let Some(tile) = tile else {
            return Some([&prefix[..], &[END]].concat());
        };
        let body = self.target.as_ref()?.tile_body(tile, &prefix);
        self.sent_tile(tile);
        Some(body)
    }

    /// The next transfer due at `now`, ready to write as is, or `None` when
    /// nothing is due yet ([`Painter::wait`] says for how long).
    pub fn next(&mut self, now: Instant) -> Option<Vec<u8>> {
        let draw_due = self.is_drawing() && due(self.last_tile, now, TILE_EVERY);
        let body = if std::mem::take(&mut self.ack) {
            vec![ACK, END]
        } else if let Some(draw) = draw_due.then(|| self.next_draw()).flatten() {
            self.last_tile = Some(now);
            draw
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
        if self.is_drawing() {
            idle.min(remaining(self.last_tile, now, TILE_EVERY))
        } else {
            idle
        }
    }

    /// Whether the panel does not show the newest page yet.
    pub fn is_drawing(&self) -> bool {
        !self.queue.is_empty()
            || self.setup_due
            || self.brightness_due
            || self.next_tile().is_some()
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
