//! Sharing a screen or a window, for a call's screen share and a clip recording.
//!
//! Mirrors the rules of `desktop/src/main/screen-share.ts`: the dashboard draws
//! its own picker from `shareSources` (screens first, then up to 40 windows,
//! each with a small picture), hands the pick back with `chooseShare`, and the
//! `getDisplayMedia` that follows shares exactly that.
//!
//! Electron gets there through `setDisplayMediaRequestHandler`. No engine the
//! beta runs on lets the app answer `getDisplayMedia` with a source of its
//! choosing (see [`dashboard_picker`]), so the beta answers `shareSources`
//! with `null`, the answer the Electron app gives on macOS: the page then
//! calls `getDisplayMedia` straight away and the engine's own picker asks.
//! The list shape and the pick rules are kept here, tested, for the engine
//! that grows such a hook.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How many windows the page's picker lists.
pub const MAX_WINDOWS: usize = 40;
/// The longest name a source is listed with, in characters.
pub const MAX_NAME: usize = 200;
/// The thumbnail size the page's picker draws.
pub const THUMBNAIL: (u32, u32) = (320, 180);
/// How long a pick waits for the `getDisplayMedia` it was made for.
pub const PICK_MS: u64 = 15_000;
/// The longest source id `chooseShare` takes.
pub const MAX_SOURCE_ID: usize = 200;

/// Whether the dashboard's own picker can be fed on `os`
/// (`std::env::consts::OS`): `Err` names why not.
pub fn dashboard_picker(os: &str) -> Result<(), &'static str> {
    match os {
        "windows" => Err(
            "WebView2 has no way to answer getDisplayMedia with a chosen source: \
             ScreenCaptureStarting can only cancel or defer the capture, and the \
             engine then shows its own picker",
        ),
        // The Electron app gives macOS no list either: the system picker is the one used.
        "macos" => Err("macOS shares through the system picker, as the Electron app does"),
        _ => Err(
            "WebKitGTK answers getDisplayMedia through the desktop portal, which \
             asks the person itself, and wry gives the app no hook into it",
        ),
    }
}

/// The source ids handed out: `screen:0:0`, `window:1234:0`
/// (`^(screen|window):[\w-]+:\d+$`).
pub fn is_source_id(id: &str) -> bool {
    if id.len() > MAX_SOURCE_ID {
        return false;
    }
    let Some((kind, rest)) = id.split_once(':') else {
        return false;
    };
    let Some((middle, last)) = rest.rsplit_once(':') else {
        return false;
    };
    matches!(kind, "screen" | "window")
        && !middle.is_empty()
        && middle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        && !last.is_empty()
        && last.bytes().all(|byte| byte.is_ascii_digit())
}

/// What `chooseShare` takes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChooseShare {
    pub id: String,
    pub sound: bool,
}

/// A pick, or `None` for anything shaped otherwise.
pub fn read_choice(raw: &Value) -> Option<ChooseShare> {
    let choice: ChooseShare = serde_json::from_value(raw.clone()).ok()?;
    is_source_id(&choice.id).then_some(choice)
}

/// What `shareSources` takes: `{thumbnails?}` or nothing. Anything else is
/// read as nothing, as the zod `safeParse` there falls back to the defaults.
pub fn wants_thumbnails(raw: Option<&Value>) -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        thumbnails: Option<bool>,
    }
    raw.and_then(|raw| serde_json::from_value::<Input>(raw.clone()).ok())
        .and_then(|input| input.thumbnails)
        .unwrap_or(true)
}

/// The page's pick, held for the request that follows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    pub id: String,
    pub sound: bool,
    pub until: u64,
}

impl Pick {
    /// Sound goes with a share only where the system can capture it.
    pub fn new(choice: ChooseShare, sound_supported: bool, now: u64) -> Self {
        Self {
            id: choice.id,
            sound: choice.sound && sound_supported,
            until: now.saturating_add(PICK_MS),
        }
    }

    /// A pick stays until a share starts from it or it runs out, so a retry
    /// without sound after one with sound failed shares the same source.
    pub fn live(&self, now: u64) -> bool {
        self.until > now
    }
}

/// Sound can be captured with a share only on Windows (system loopback).
pub fn sound_supported(os: &str) -> bool {
    os == "windows"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Screen,
    Window,
}

/// A screen or a window as the system lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSource {
    pub id: String,
    pub name: String,
    /// A JPEG data URL, or `None` when the system gave no picture.
    pub thumbnail: Option<String>,
    /// The program's icon as a PNG data URL.
    pub icon: Option<String>,
}

/// A screen or a window that can be shared (`ShareSource` in `bridge.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShareSource {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    pub thumbnail: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShareSources {
    pub sources: Vec<ShareSource>,
    /// Whether this computer's sound can go with a share.
    pub sound: bool,
}

/// The list the page's picker draws: every screen, then windows up to
/// [`MAX_WINDOWS`], names trimmed and cut at [`MAX_NAME`].
pub fn share_list(sources: Vec<RawSource>, sound: bool) -> ShareSources {
    let (screens, windows): (Vec<_>, Vec<_>) = sources
        .into_iter()
        .partition(|source| source.id.starts_with("screen:"));
    let shape = |source: RawSource| ShareSource {
        kind: if source.id.starts_with("screen:") {
            SourceKind::Screen
        } else {
            SourceKind::Window
        },
        name: source
            .name
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .chars()
            .take(MAX_NAME)
            .collect(),
        id: source.id,
        thumbnail: source.thumbnail,
        icon: source.icon,
    };
    ShareSources {
        sources: screens
            .into_iter()
            .chain(windows.into_iter().take(MAX_WINDOWS))
            .map(shape)
            .collect(),
        sound,
    }
}
