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

/// One line of the idle page: a name, its value as the plugin wrote it, and
/// how full it is (0-100) for a bar, when it has one.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IdleRow {
    pub label: String,
    pub value: String,
    pub percent: Option<u8>,
}

/// What the screen shows while nobody touches the controller: the clock and
/// a few of this computer's figures (CPU, memory, disk, network), each one
/// formatted by the plugin in the reader's language.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Idle {
    pub clock: String,
    pub rows: Vec<IdleRow>,
}

/// Rows the idle page has room for.
pub const IDLE_ROWS: usize = 4;

impl Idle {
    /// The same page with every text cleaned and at most [`IDLE_ROWS`] rows.
    pub fn bounded(mut self) -> Self {
        self.clock = clean(&self.clock);
        self.rows.truncate(IDLE_ROWS);
        for row in &mut self.rows {
            row.label = clean(&row.label);
            row.value = clean(&row.value);
            row.percent = row.percent.map(|percent| percent.min(100));
        }
        self
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
    /// The idle page, shown instead of `mode`'s while it is set.
    pub idle: Option<Idle>,
    /// How it looks: colours, label size and pictures.
    pub theme: std::sync::Arc<Theme>,
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

use crate::theme::{self, Theme};

const BACKGROUND: u8 = theme::BACKGROUND as u8;
const TEXT: u8 = theme::TEXT as u8;
const DIM: u8 = theme::DIM as u8;
const TRACK: u8 = theme::TRACK as u8;
const FILL: u8 = theme::FILL as u8;
const MUTED: u8 = theme::MUTED as u8;
const DIVIDER: u8 = theme::DIVIDER as u8;

/// The page's letters: Roboto Medium (SIL Open Font License 1.1,
/// `assets/Roboto-LICENSE.txt`), drawn from its outlines at the size each
/// line asks for, with smooth edges, instead of a 5x7 bitmap blown up into
/// blocks.
static FONT_DATA: &[u8] = include_bytes!("../assets/Roboto-Medium.ttf");

fn font() -> &'static ab_glyph::FontRef<'static> {
    static FONT: std::sync::OnceLock<ab_glyph::FontRef<'static>> = std::sync::OnceLock::new();
    FONT.get_or_init(|| {
        ab_glyph::FontRef::try_from_slice(FONT_DATA).expect("the bundled font reads")
    })
}

/// Pixels per em for a capital letter `cap` pixels tall.
fn em_for_cap(cap: f32) -> f32 {
    use ab_glyph::Font;
    static RATIO: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    let ratio = *RATIO.get_or_init(|| {
        let font = font();
        let glyph = font.glyph_id('H').with_scale(1000.0);
        font.outline_glyph(glyph)
            .map(|outline| outline.px_bounds().height() / 1000.0)
            .filter(|ratio| *ratio > 0.1)
            .unwrap_or(0.711)
    });
    cap / ratio
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

/// A page being drawn, in full colour at the panel's own 480x272: letters
/// and pictures are blended here and only the finished page is put into
/// the palette ([`Canvas::finish`]).
struct Canvas<'a> {
    pixels: Vec<(u8, u8, u8)>,
    theme: &'a Theme,
}

impl<'a> Canvas<'a> {
    /// A page of the theme's background colour, or its picture.
    fn new(theme: &'a Theme) -> Self {
        let pixels = match &theme.background {
            Some(picture) => picture
                .rgba
                .chunks_exact(4)
                .map(|pixel| (pixel[0], pixel[1], pixel[2]))
                .collect(),
            None => vec![theme.colors[usize::from(BACKGROUND)]; WIDTH * HEIGHT],
        };
        Self { pixels, theme }
    }

    fn color(&self, role: u8) -> (u8, u8, u8) {
        self.theme.colors[usize::from(role) % theme::ROLES]
    }

    fn rect(&mut self, x: usize, y: usize, width: usize, height: usize, role: u8) {
        let color = self.color(role);
        for row in y.min(HEIGHT)..(y + height).min(HEIGHT) {
            let start = row * WIDTH;
            self.pixels[start + x.min(WIDTH)..start + (x + width).min(WIDTH)].fill(color);
        }
    }

    /// `picture` with its top-left corner at `(left, top)`, over what is there.
    fn picture(&mut self, picture: &theme::Picture, left: usize, top: usize) {
        for y in 0..picture.height.min(HEIGHT.saturating_sub(top)) {
            let row = (top + y) * WIDTH;
            for x in 0..picture.width.min(WIDTH.saturating_sub(left)) {
                let at = (y * picture.width + x) * 4;
                let source = &picture.rgba[at..at + 4];
                let under = self.pixels[row + left + x];
                self.pixels[row + left + x] =
                    theme::mix(under, (source[0], source[1], source[2]), source[3]);
            }
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

    /// `chars` with capitals `cap` pixels tall, placed from x = 0 on the
    /// baseline, and how wide they are.
    fn layout(chars: &[char], cap: usize) -> (Vec<ab_glyph::Glyph>, f32) {
        use ab_glyph::{Font, ScaleFont};
        let font = font();
        let scaled = font.as_scaled(em_for_cap(cap as f32));
        let mut glyphs = Vec::with_capacity(chars.len());
        let mut caret = 0.0f32;
        let mut previous: Option<ab_glyph::GlyphId> = None;
        for c in chars {
            let id = font.glyph_id(*c);
            if let Some(previous) = previous {
                caret += scaled.kern(previous, id);
            }
            glyphs.push(id.with_scale_and_position(scaled.scale(), ab_glyph::point(caret, 0.0)));
            caret += scaled.h_advance(id);
            previous = Some(id);
        }
        (glyphs, caret)
    }

    /// How wide `text` is drawn at `scale` ([`Canvas::text_at`]), cut to `max` characters.
    fn width(text: &str, scale: usize, max: usize) -> usize {
        Self::layout(&Self::fit(text, max), 7 * scale).1.ceil() as usize
    }

    /// Text from `left`, its capitals' tops at `y` (accents sit above),
    /// `cap` pixels tall, cut to `max` characters.
    fn draw_text(&mut self, text: &str, left: usize, y: usize, cap: usize, max: usize, role: u8) {
        use ab_glyph::Font;
        let color = self.color(role);
        let baseline = (y + cap) as f32;
        let (glyphs, _) = Self::layout(&Self::fit(text, max), cap);
        for mut glyph in glyphs {
            glyph.position.x += left as f32;
            glyph.position.y = baseline;
            let Some(outline) = font().outline_glyph(glyph) else {
                continue;
            };
            let bounds = outline.px_bounds();
            let pixels = &mut self.pixels;
            outline.draw(|gx, gy, coverage| {
                let x = bounds.min.x as i64 + i64::from(gx);
                let y = bounds.min.y as i64 + i64::from(gy);
                if x < 0 || y < 0 || x as usize >= WIDTH || y as usize >= HEIGHT {
                    return;
                }
                let at = y as usize * WIDTH + x as usize;
                let amount = (coverage.clamp(0.0, 1.0) * 255.0).round() as u8;
                pixels[at] = theme::mix(pixels[at], color, amount);
            });
        }
    }

    /// Text from `left`, its capitals' tops at `y`, `7 * scale` pixels tall
    /// (the old 5x7 font's body at that scale, so every line keeps its
    /// place), cut to `max` characters.
    fn text_at(&mut self, text: &str, left: usize, y: usize, scale: usize, max: usize, role: u8) {
        self.draw_text(text, left, y, 7 * scale, max, role);
    }

    /// Text centred on `center`, capitals `cap` pixels tall.
    fn text_cap(&mut self, text: &str, center: usize, y: usize, cap: usize, max: usize, role: u8) {
        let width = Self::layout(&Self::fit(text, max), cap).1.ceil() as usize;
        self.draw_text(text, center.saturating_sub(width / 2), y, cap, max, role);
    }

    /// Text centred on `center`, otherwise as [`Canvas::text_at`].
    fn text(&mut self, text: &str, center: usize, y: usize, scale: usize, max: usize, role: u8) {
        self.text_cap(text, center, y, 7 * scale, max, role);
    }

    /// The page in the theme's palette.
    fn finish(self) -> IndexedFrame {
        let theme = self.theme;
        IndexedFrame {
            palette: theme.palette,
            pixels: self
                .pixels
                .iter()
                .map(|color| theme.index_of(*color))
                .collect(),
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

/// Space kept clear at the screen's left and right edges.
const MARGIN: usize = 16;

/// The page as an image. `Off` draws nothing: the screen is switched off.
/// `Call` with no call and `NowPlaying` with nothing playing show the knobs.
pub fn render(screen: &Screen) -> Option<IndexedFrame> {
    if screen.is_off() {
        return None;
    }
    let mut canvas = Canvas::new(&screen.theme);
    if let Some(idle) = &screen.idle {
        idle_page(&mut canvas, idle);
        return Some(canvas.finish());
    }
    match (screen.mode, &screen.call, &screen.playing) {
        (DisplayMode::Call, Some(call), _) => call_page(&mut canvas, call, screen.locale),
        (DisplayMode::NowPlaying, _, Some(playing)) => {
            playing_page(&mut canvas, playing, screen.locale)
        }
        _ => mixer_page(&mut canvas, &screen.knobs),
    }
    Some(canvas.finish())
}

fn mixer_page(canvas: &mut Canvas<'_>, knobs: &[Knob; 4]) {
    for (index, knob) in knobs.iter().enumerate() {
        let left = index * COLUMN;
        let center = left + COLUMN / 2;
        if index > 0 {
            canvas.rect(left, 12, 1, HEIGHT - 24, DIVIDER);
        }
        // A knob's picture takes the top of its column; its name then moves
        // under the value, into the room above the bar.
        let theme = canvas.theme;
        let cap = theme.label_size.cap_height();
        let label_top = match &theme.knob_images[index] {
            Some(picture) => {
                canvas.picture(picture, center - theme::KNOB_IMAGE_SIDE / 2, 6);
                VALUE_Y + 34
            }
            None => (LABEL_Y + 7).saturating_sub(cap / 2),
        };
        canvas.text_cap(&knob.label, center, label_top, cap, 9, TEXT);
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

const IDLE_ROW_TOP: usize = 92;
const IDLE_ROW_HEIGHT: usize = 44;

/// The clock large at the top, then one row per figure: its name on the
/// left, its value on the right and a thin bar under it when it has one.
fn idle_page(canvas: &mut Canvas<'_>, idle: &Idle) {
    canvas.text(&idle.clock, WIDTH / 2, 14, 7, 8, TEXT);
    for (index, row) in idle.rows.iter().take(IDLE_ROWS).enumerate() {
        let top = IDLE_ROW_TOP + index * IDLE_ROW_HEIGHT;
        canvas.text_at(&row.label, MARGIN, top, 3, 9, DIM);
        let right = (WIDTH - MARGIN).saturating_sub(Canvas::width(&row.value, 3, 14));
        canvas.text_at(&row.value, right, top, 3, 14, TEXT);
        if let Some(percent) = row.percent {
            let width = WIDTH - 2 * MARGIN;
            canvas.rect(MARGIN, top + 28, width, 4, TRACK);
            canvas.rect(
                MARGIN,
                top + 28,
                width * usize::from(percent.min(100)) / 100,
                4,
                FILL,
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
fn call_page(canvas: &mut Canvas<'_>, call: &Call, locale: Locale) {
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
        let width = Canvas::width(state, 2, 11);
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
fn playing_page(canvas: &mut Canvas<'_>, playing: &NowPlaying, locale: Locale) {
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
/// How long a finished idle page stays before the next one starts. A page
/// takes 32 tiles, 1.3 s, and the firmware refines it coarse to fine, so an
/// idle page redrawn every second (its CPU and memory figures change that
/// often) was never finished: the panel sat in its blocky first passes.
pub const IDLE_HOLD: Duration = Duration::from_secs(2);

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
    /// An idle page that waits for the one being drawn to finish and stay
    /// [`IDLE_HOLD`]; only the newest is kept.
    pending: Option<Screen>,
    /// The palette the panel holds, once one went out.
    palette: Option<[u16; PALETTE_COLORS]>,
    /// The next tile carries the target's palette (the look changed).
    palette_due: bool,
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
            pending: None,
            palette: None,
            palette_due: false,
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
    ///
    /// An idle page that follows another idle page does not: it waits for
    /// the page on the panel to be finished and stay [`IDLE_HOLD`], so the
    /// clock and figures are always seen whole. Anything somebody did (a
    /// knob, a button, the idle page coming or going) still goes at once.
    pub fn show(&mut self, screen: &Screen) {
        if self.shown.as_ref() == Some(screen) {
            self.pending = None;
            return;
        }
        if self.pending.as_ref() == Some(screen) {
            return;
        }
        let both_idle = screen.idle.is_some()
            && self
                .shown
                .as_ref()
                .is_some_and(|shown| shown.idle.is_some())
            && self.set_up;
        if both_idle {
            self.pending = Some(screen.clone());
            return;
        }
        self.pending = None;
        self.apply(screen);
    }

    fn apply(&mut self, screen: &Screen) {
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
        if !self.setup_due && self.palette != Some(frame.palette) {
            // Another look: every index on the panel means another colour
            // now, so the new palette goes first and the page is drawn whole.
            self.palette_due = true;
            self.filled.fill(UNKNOWN);
            self.sampled.fill(UNKNOWN);
        }
        self.target = Some(frame);
    }

    /// Starts the waiting idle page once the panel has shown the last one,
    /// whole, for [`IDLE_HOLD`].
    fn promote(&mut self, now: Instant) {
        if self.pending.is_none() || self.is_drawing() || !due(self.last_tile, now, IDLE_HOLD) {
            return;
        }
        if let Some(screen) = self.pending.take() {
            self.apply(&screen);
        }
    }

    /// The screen went off: what it shows next is set up and drawn whole.
    fn forget_panel(&mut self) {
        self.set_up = false;
        self.setup_due = false;
        self.brightness_due = false;
        self.palette_due = false;
        self.palette = None;
        self.pending = None;
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
            self.palette_due = false;
            self.palette = self.target.as_ref().map(|target| target.palette);
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
        let mut out = Vec::new();
        if std::mem::take(&mut self.brightness_due) {
            out.extend_from_slice(&brightness);
        }
        if std::mem::take(&mut self.palette_due) {
            if let Some(target) = self.target.as_ref() {
                out.extend_from_slice(&target.palette_command());
                self.palette = Some(target.palette);
            }
        }
        out
    }

    /// The next drawing transfer's body, when one is owed.
    fn next_draw(&mut self) -> Option<Vec<u8>> {
        if let Some(body) = self.queue.pop_front() {
            return Some(body);
        }
        let tile = self.next_tile();
        if tile.is_none() && !self.setup_due && !self.brightness_due && !self.palette_due {
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
        self.promote(now);
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
        } else if self.pending.is_some() {
            idle.min(remaining(self.last_tile, now, IDLE_HOLD))
        } else {
            idle
        }
    }

    /// Whether the panel does not show the newest page yet.
    ///
    /// An idle page waiting its turn ([`Painter::show`]) is not drawing yet.
    pub fn is_drawing(&self) -> bool {
        !self.queue.is_empty()
            || self.setup_due
            || self.brightness_due
            || self.palette_due
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
