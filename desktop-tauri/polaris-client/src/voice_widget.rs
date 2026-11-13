//! The voice widget: the call's people, drawn in a small window that stays over
//! every other one - a game included, when it runs windowed or borderless - the
//! way a voice app's in-game overlay does.
//!
//! Mirrors `desktop/src/shared/voice-widget.ts` and the placement rules of
//! `desktop/src/main/voice-widget.ts`. The dashboard page in the call says who
//! is in it and who is speaking; the widget says back which of its buttons was
//! pressed. Both are read here, so the rule for each is one schema the shell
//! and the tests share.

use crate::servers::utf16_len;
use crate::settings::{Point, DEFAULT_TEXT_SIZE, TEXT_SIZES};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The most people the page may list; the widget draws fewer and counts the rest.
pub const MAX_PEOPLE: usize = 50;
/// The most rows the widget draws before it says how many more there are.
pub const MAX_ROWS: usize = 8;
/// Space between the widget and the corner of the screen it starts in.
pub const MARGIN: i64 = 16;

pub const WIDGET_WIDTH: u32 = 240;
const ROW_HEIGHT: u32 = 34;
const PADDING: u32 = 16;
const FOOTER_HEIGHT: u32 = 44;
const MORE_HEIGHT: u32 = 22;

/// The keys that lock and unlock the widget, tried in order, each with the name
/// the widget shows for it. Shift and the key under Esc, as Discord's overlay
/// has it - but only while a game runs: held system-wide the rest of the time
/// it would stop the computer typing the character on that key (`~` on a US
/// keyboard). The same with Ctrl (Cmd on a Mac) always, which nobody types,
/// and which also serves where Discord already holds the first.
///
/// `os` is `std::env::consts::OS` ("macos" where Node says "darwin").
pub fn lock_keys(os: &str, in_game: bool) -> Vec<(&'static str, &'static str)> {
    let with_ctrl = (
        "CommandOrControl+Shift+`",
        if os == "macos" {
            "Cmd+Shift+`"
        } else {
            "Ctrl+Shift+`"
        },
    );
    if in_game {
        vec![("Shift+`", "Shift+`"), with_ctrl]
    } else {
        vec![with_ctrl]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoicePerson {
    pub id: String,
    pub name: String,
    pub speaking: bool,
    pub muted: bool,
    pub deafened: bool,
}

/// A state shaped otherwise than `voiceStateSchema` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unreadable;

/// What the page in a call publishes; `null` instead of this once it has ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VoiceState {
    pub participants: Vec<VoicePerson>,
    pub self_muted: bool,
    pub self_deafened: bool,
}

/// The page's state with the schema's limits applied (`voiceStateSchema`):
/// `Ok(None)` for `null`, `Err` for anything shaped otherwise. Names come back
/// trimmed, as zod's `.trim()` hands them on.
pub fn read_voice_state(raw: &Value) -> Result<Option<VoiceState>, Unreadable> {
    if raw.is_null() {
        return Ok(None);
    }
    let mut state: VoiceState = serde_json::from_value(raw.clone()).map_err(|_| Unreadable)?;
    if state.participants.len() > MAX_PEOPLE {
        return Err(Unreadable);
    }
    for person in &mut state.participants {
        if !(1..=128).contains(&utf16_len(&person.id)) {
            return Err(Unreadable);
        }
        let name = trim_js(&person.name);
        if utf16_len(name) > 120 {
            return Err(Unreadable);
        }
        person.name = name.to_owned();
    }
    Ok(Some(state))
}

/// `String.prototype.trim`: JavaScript's white space and line terminators,
/// which include the byte order mark that `char::is_whitespace` leaves.
fn trim_js(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// A press on the widget, handed to the page as its own call keys are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceAction {
    Mic,
    Deafen,
    Leave,
}

/// One of the three presses, or `None` for anything else.
pub fn read_voice_action(raw: &Value) -> Option<VoiceAction> {
    serde_json::from_value(raw.clone()).ok()
}

/// One person as the widget page draws them: the page's fields, with the face's
/// letters and color worked out here (the Electron page imported them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DrawnPerson {
    #[serde(flatten)]
    pub person: VoicePerson,
    pub initials: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawnState {
    pub participants: Vec<DrawnPerson>,
    pub self_muted: bool,
    pub self_deafened: bool,
}

/// What the widget window is told to draw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetView {
    pub state: DrawnState,
    /// Unlocked: it takes clicks, shows its buttons and can be dragged.
    pub unlocked: bool,
    /// The key that locks it again, or `None` when no key could be held.
    pub lock_key: Option<String>,
}

impl WidgetView {
    pub fn new(state: &VoiceState, unlocked: bool, lock_key: Option<String>) -> Self {
        let participants = state
            .participants
            .iter()
            .map(|person| DrawnPerson {
                initials: initials(&person.name),
                color: face_color(&person.id),
                person: person.clone(),
            })
            .collect();
        Self {
            state: DrawnState {
                participants,
                self_muted: state.self_muted,
                self_deafened: state.self_deafened,
            },
            unlocked,
            lock_key,
        }
    }
}

/// Whether the widget is on screen: only in a call, only when switched on, and
/// - when somebody asked for that - only while a game is running.
pub fn widget_visible(
    in_call: bool,
    enabled: bool,
    only_with_game: bool,
    game_running: bool,
) -> bool {
    in_call && enabled && (!only_with_game || game_running)
}

/// The window's height for this many people: rows, the "and N more" line, and
/// the buttons while it is unlocked.
pub fn widget_height(people: usize, unlocked: bool) -> u32 {
    let rows = u32::try_from(people.clamp(1, MAX_ROWS)).unwrap_or(1);
    PADDING
        + rows * ROW_HEIGHT
        + if people > MAX_ROWS { MORE_HEIGHT } else { 0 }
        + if unlocked { FOOTER_HEIGHT } else { 0 }
}

/// How much bigger the account's text size draws than the default (`textScale`).
pub fn text_scale(size: u16) -> f64 {
    let size = if TEXT_SIZES.contains(&size) {
        size
    } else {
        DEFAULT_TEXT_SIZE
    };
    f64::from(size) / f64::from(DEFAULT_TEXT_SIZE)
}

/// The widget's size, grown with the account's text size: its page is drawn in rem.
pub fn widget_size(people: usize, unlocked: bool, text_size: u16) -> (u32, u32) {
    let scale = text_scale(text_size);
    let grow = |value: u32| {
        let scaled = (f64::from(value) * scale).round();
        // At most 24/16 of a few hundred pixels: always fits.
        if scaled.is_finite() && scaled >= 0.0 && scaled <= f64::from(u32::MAX) {
            scaled as u32
        } else {
            value
        }
    };
    (grow(WIDGET_WIDTH), grow(widget_height(people, unlocked)))
}

/// A screen's work area, in the same units as the kept place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// Where the widget opens: the kept place when it is still on a screen, else
/// the top left of the main one.
pub fn start_point(
    kept: Option<Point>,
    height: u32,
    screens: &[WorkArea],
    primary: WorkArea,
) -> Point {
    if let Some(kept) = kept {
        let low = i64::from(height).min(MARGIN);
        let on_screen = screens.iter().any(|area| {
            kept.x + MARGIN >= area.x
                && kept.y + MARGIN >= area.y
                && kept.x + MARGIN <= area.x + area.width
                && kept.y + low <= area.y + area.height
        });
        if on_screen {
            return kept;
        }
    }
    Point {
        x: primary.x + MARGIN,
        y: primary.y + MARGIN,
    }
}

/// Up to two letters for a face with no picture.
pub fn initials(name: &str) -> String {
    let words: Vec<&str> = trim_js(name)
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|word| !word.is_empty())
        .collect();
    let letters: Vec<char> = match words.as_slice() {
        [] => return "?".to_owned(),
        [word] => word.chars().take(2).collect(),
        [first, .., last] => first.chars().take(1).chain(last.chars().take(1)).collect(),
    };
    letters.into_iter().collect::<String>().to_uppercase()
}

const HUES: [u32; 8] = [210, 262, 330, 20, 45, 150, 180, 0];

/// The same color for the same person every time (`faceColor`): each code
/// point counts with its first UTF-16 unit, as `charCodeAt(0)` reads it.
pub fn face_color(id: &str) -> String {
    let mut hash: u32 = 0;
    for c in id.chars() {
        let mut units = [0u16; 2];
        let first = c.encode_utf16(&mut units)[0];
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(first));
    }
    format!("hsl({} 55% 45%)", HUES[hash as usize % HUES.len()])
}
