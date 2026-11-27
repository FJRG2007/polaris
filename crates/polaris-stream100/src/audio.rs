//! What a knob controls.
//!
//! A knob follows a category of apps, not a fixed program: "Music" moves
//! Spotify today and whatever player is open tomorrow, "Calls" moves a Polaris
//! call first and Discord or Teams when that is what is running. A person can
//! still pin a knob to one program.
//!
//! Each operating system's per-app volume sits behind [`AudioSessions`]:
//! Windows Core Audio sessions (`IAudioSessionManager2`), PipeWire/PulseAudio
//! sink inputs on Linux, and Core Audio process taps on macOS 14.2+. The
//! backends are in `native` (feature `native`); this module is the shared
//! model and the rules.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Music,
    Calls,
    Games,
    Browser,
    System,
    Other,
}

/// One app playing audio, as a backend reports it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Backend-specific and stable while the session lives.
    pub id: String,
    /// Executable file name (`Spotify.exe`) or the backend's app id.
    pub program: String,
    pub pid: u32,
    /// The operating system's own sounds (Windows' system-sounds session,
    /// PulseAudio's event sounds).
    #[serde(default)]
    pub system: bool,
    /// Volume 0-100.
    pub volume: u8,
    pub muted: bool,
}

/// What one knob is set to follow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// Every app of a category; Calls prefers Polaris' own call.
    Category { category: Category },
    /// One program, by executable name, whatever its category.
    Program { program: String },
    /// The default output device as a whole.
    Output,
    /// Nothing.
    None,
}

/// The knobs' targets when nothing was chosen.
pub fn default_targets() -> [Target; 4] {
    [
        Target::Category {
            category: Category::Calls,
        },
        Target::Category {
            category: Category::Music,
        },
        Target::Category {
            category: Category::Games,
        },
        Target::Output,
    ]
}

/// Lowercased program name without directory or `.exe`.
pub fn program_key(program: &str) -> String {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    name.strip_suffix(".exe").map(str::to_owned).unwrap_or(name)
}

const POLARIS: &[&str] = &["polaris", "polaris desktop"];
const CALLS: &[&str] = &[
    "discord",
    "discordptb",
    "discordcanary",
    "teams",
    "ms-teams",
    "msteams",
    "zoom",
    "slack",
    "skype",
    "webex",
    "ciscocollabhost",
    "whatsapp",
    "telegram",
    "signal",
    "element",
    "mumble",
    "teamspeak",
    "ts3client_win64",
    "facetime",
    "jitsi meet",
    "zoom.us",
    "microsoft teams",
    "microsoft teams (work or school)",
    "webex meetings",
];
const MUSIC: &[&str] = &[
    "spotify",
    "applemusic",
    "music",
    "itunes",
    "tidal",
    "deezer",
    "amazon music",
    "amazonmusic",
    "foobar2000",
    "musicbee",
    "aimp",
    "winamp",
    "vlc",
    "rhythmbox",
    "elisa",
    "clementine",
    "strawberry",
    "audacious",
    "cider",
    "youtube music",
    "qobuz",
];
const BROWSERS: &[&str] = &[
    "chrome",
    "msedge",
    "firefox",
    "brave",
    "opera",
    "opera_gx",
    "vivaldi",
    "arc",
    "safari",
    "chromium",
    "librewolf",
    "zen",
    "waterfox",
    "thorium",
    "google chrome",
    "microsoft edge",
    "brave browser",
    "opera gx",
    "zen browser",
    // Safari, and every other WebKit app, plays through WebKit's GPU process.
    "com.apple.webkit.gpu",
];
const SYSTEM: &[&str] = &[
    "explorer",
    "shellexperiencehost",
    "systemsettings",
    "pulseaudio",
    "gnome-shell",
    "systemuiserver",
    "systemsoundserverd",
];

/// The category of a session. `is_game` comes from the desktop app's game
/// detection (its known-games list and launcher stores), which knows far more
/// games than any list here could.
pub fn classify(session: &Session, is_game: impl Fn(&str) -> bool) -> Category {
    if session.system {
        return Category::System;
    }
    let key = program_key(&session.program);
    if POLARIS.contains(&key.as_str()) || CALLS.contains(&key.as_str()) {
        Category::Calls
    } else if MUSIC.contains(&key.as_str()) {
        Category::Music
    } else if is_game(&key) {
        Category::Games
    } else if BROWSERS.contains(&key.as_str()) {
        Category::Browser
    } else if SYSTEM.contains(&key.as_str()) {
        Category::System
    } else {
        Category::Other
    }
}

/// The sessions a knob moves right now, by id. `None` means the default
/// output device itself; an empty list means the knob has nothing to move,
/// and the caller then discards its pending counts.
pub fn resolve<'a>(
    target: &Target,
    sessions: &'a [Session],
    is_game: impl Fn(&str) -> bool,
) -> Option<Vec<&'a str>> {
    match target {
        Target::Output => None,
        Target::None => Some(Vec::new()),
        Target::Program { program } => {
            let wanted = program_key(program);
            Some(
                sessions
                    .iter()
                    .filter(|s| program_key(&s.program) == wanted)
                    .map(|s| s.id.as_str())
                    .collect(),
            )
        }
        Target::Category { category } => {
            if *category == Category::Calls {
                // A Polaris call is the call: while one plays audio, the knob
                // moves it alone and leaves a Discord idling in the tray alone.
                let polaris: Vec<&str> = sessions
                    .iter()
                    .filter(|s| POLARIS.contains(&program_key(&s.program).as_str()))
                    .map(|s| s.id.as_str())
                    .collect();
                if !polaris.is_empty() {
                    return Some(polaris);
                }
            }
            Some(
                sessions
                    .iter()
                    .filter(|s| classify(s, &is_game) == *category)
                    .map(|s| s.id.as_str())
                    .collect(),
            )
        }
    }
}

/// The volume shown for a knob following several sessions: the loudest one,
/// so turning down always visibly starts from what is heard.
pub fn shown_volume(sessions: &[Session], ids: &[&str]) -> Option<u8> {
    sessions
        .iter()
        .filter(|s| ids.contains(&s.id.as_str()))
        .map(|s| s.volume)
        .max()
}

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("per-app volume is not available on this system yet")]
    Unsupported,
    #[error("Polaris is not allowed to change app audio on this system")]
    NotAllowed,
    #[error("that app stopped playing audio")]
    Gone,
    #[error("the audio service refused the change: {0}")]
    Backend(String),
}

/// One operating system's per-app volume.
pub trait AudioSessions {
    fn sessions(&mut self) -> Result<Vec<Session>, AudioError>;
    fn set_volume(&mut self, id: &str, volume: u8) -> Result<(), AudioError>;
    fn set_muted(&mut self, id: &str, muted: bool) -> Result<(), AudioError>;
    fn output_volume(&mut self) -> Result<(u8, bool), AudioError>;
    fn set_output_volume(&mut self, volume: u8) -> Result<(), AudioError>;
    fn set_output_muted(&mut self, muted: bool) -> Result<(), AudioError>;
}

/// Where each operating system's backend stands, said plainly so a screen can
/// tell a person instead of failing silently.
pub fn backend_status(os: &str) -> &'static str {
    match os {
        "windows" => "Core Audio sessions on every active output",
        "linux" => "the PulseAudio protocol, served by PulseAudio and PipeWire",
        "macos" => {
            "Core Audio process taps on macOS 14.2 and later; the whole output only before 14.2"
        }
        _ => "not supported",
    }
}

/// A macOS program's name from its executable's path: the outermost `.app`
/// bundle, so a browser's or Electron app's helper processes (`Google Chrome
/// Helper.app` inside `Google Chrome.app`) count as the app itself, else the
/// file name.
pub fn bundle_program(path: &str) -> String {
    path.split('/')
        .find_map(|part| part.strip_suffix(".app"))
        .filter(|name| !name.is_empty())
        .or_else(|| path.rsplit('/').next())
        .unwrap_or(path)
        .to_owned()
}

/// The amplitude a process tap plays an app back at: cubic, like PulseAudio's
/// software volume, so each step of the knob sounds like the same step.
pub fn tap_gain(volume: u8, muted: bool) -> f32 {
    if muted {
        return 0.0;
    }
    let level = f32::from(volume.min(100)) / 100.0;
    level * level * level
}

/// One IO cycle of a tap: `input` (interleaved, `in_channels` wide) into
/// `output` (interleaved, `out_channels` wide) at `gain`. Output channels past
/// the input's repeat it (a stereo tap on a 5.1 device fills every speaker
/// pair), and output frames past the input's are silence.
pub fn mix(input: &[f32], in_channels: usize, output: &mut [f32], out_channels: usize, gain: f32) {
    if in_channels == 0 || out_channels == 0 {
        output.fill(0.0);
        return;
    }
    let frames = (input.len() / in_channels).min(output.len() / out_channels);
    for frame in 0..frames {
        for channel in 0..out_channels {
            output[frame * out_channels + channel] =
                input[frame * in_channels + channel % in_channels] * gain;
        }
    }
    output[frames * out_channels..].fill(0.0);
}
