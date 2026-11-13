//! Strokes drawn on a shared screen, as the dashboard hands them to this app to
//! show over the shared display.
//!
//! Mirrors `desktop/src/shared/annotate.ts` (the stroke schema) and the window
//! rules of `desktop/src/main/annotate-overlay.ts`. The dashboard has already
//! believed the stroke - only a seat the sharer let draw gets this far - but the
//! page is still a web page, so its shape is checked here the same way as any
//! other input. Points are fractions of the shared picture, which on a screen
//! share is the whole display. Fading and the 200-stroke board live in the
//! overlay page (`ui/overlay.js`), as they do in the Electron renderer.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

/// How long the window stays after the last stroke, with nothing to draw.
pub const IDLE_MS: u64 = 30_000;
/// Strokes held while the window loads.
pub const QUEUE_MAX: usize = 256;
/// The most points one message carries.
pub const POINTS_MAX: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    pub key: String,
    pub color: String,
    pub points: Vec<[f64; 2]>,
    pub end: bool,
}

/// `^[^\s\p{Cc}]{1,160}$` with the `u` flag: 1 to 160 code points, none of
/// them JavaScript white space or a control character.
fn key_ok(key: &str) -> bool {
    let count = key.chars().count();
    (1..=160).contains(&count)
        && key
            .chars()
            .all(|c| !c.is_whitespace() && c != '\u{feff}' && !c.is_control())
}

/// `^#[0-9a-f]{6}$` with the `i` flag.
fn color_ok(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A stroke as `strokeSchema` takes it, or `None`.
pub fn read_stroke(raw: &Value) -> Option<Stroke> {
    let stroke: Stroke = serde_json::from_value(raw.clone()).ok()?;
    let unit = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
    (key_ok(&stroke.key)
        && color_ok(&stroke.color)
        && stroke.points.len() <= POINTS_MAX
        && stroke.points.iter().all(|[x, y]| unit(*x) && unit(*y)))
    .then_some(stroke)
}

/// A display the shared picture may be: its id as the share names it.
pub trait Display {
    fn id(&self) -> String;
}

/// The display the current share is of, or `None` for a window or no share
/// (`sharedDisplay`). Some systems leave the display id empty on a screen
/// source; with one display there is no question which it is.
pub fn shared_display<'a, D: Display>(
    source: Option<(&str, &str)>,
    displays: &'a [D],
) -> Option<&'a D> {
    let (id, display_id) = source?;
    if !id.starts_with("screen:") {
        return None;
    }
    displays
        .iter()
        .find(|display| display.id() == display_id)
        .or(match displays {
            [only] => Some(only),
            _ => None,
        })
}

/// What the overlay window does with a stroke (`drawOnShare`).
#[derive(Debug, Clone, PartialEq)]
pub enum Delivery {
    /// The page is loaded: hand it over now.
    Send(Stroke),
    /// Held until the page loads.
    Queued,
    /// The queue was full while the page loaded.
    Dropped,
}

/// The overlay as it stands: which display it is on, whether its page loaded,
/// and what waits for it.
#[derive(Debug, Default)]
pub struct Overlay {
    pub display: Option<String>,
    pub ready: bool,
    queued: VecDeque<Stroke>,
}

impl Overlay {
    /// Whether the overlay has to be closed and opened again on `display`: a
    /// share moved to another display starts over there.
    pub fn moves_to(&self, display: &str) -> bool {
        self.display.as_deref().is_some_and(|open| open != display)
    }

    pub fn open_on(display: String) -> Self {
        Self {
            display: Some(display),
            ready: false,
            queued: VecDeque::new(),
        }
    }

    pub fn deliver(&mut self, stroke: Stroke) -> Delivery {
        if self.ready {
            return Delivery::Send(stroke);
        }
        if self.queued.len() >= QUEUE_MAX {
            return Delivery::Dropped;
        }
        self.queued.push_back(stroke);
        Delivery::Queued
    }

    /// The page loaded: everything held, in order.
    pub fn loaded(&mut self) -> Vec<Stroke> {
        self.ready = true;
        self.queued.drain(..).collect()
    }
}
