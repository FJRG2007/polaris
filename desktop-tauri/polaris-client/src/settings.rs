//! What the app remembers between runs: the Polaris it opens, the other ones it
//! has opened, and for each service pushed from here the folder and platform used
//! last time.
//!
//! The Rust twin of `desktop/src/main/settings.ts`, with the same file format so
//! the Electron app's `settings.json` reads here unchanged. It holds nothing
//! secret, and every field is read on its own: a file a newer or older build
//! wrote, or one edited by hand, falls back to the default for what it cannot
//! read instead of breaking the app.

use crate::servers::{read_server_address, read_servers, with_server, SavedServer};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

/// A platform `docker build --platform` takes, or "" for this computer's own.
pub const PUSH_PLATFORMS: [&str; 3] = ["", "linux/amd64", "linux/arm64"];

/// The sizes the dashboard offers (`TEXT_SIZES` in `desktop/src/shared/text-size.ts`).
pub const TEXT_SIZES: [u16; 7] = [12, 14, 15, 16, 18, 20, 24];

/// The size before any account has been seen: the dashboard's own default.
pub const DEFAULT_TEXT_SIZE: u16 = 16;

/// The switches kept as they are and read when they matter.
pub const TOGGLES: [&str; 4] = [
    "minimizeToTray",
    "startMinimized",
    "voiceWidget",
    "voiceWidgetGameOnly",
];

/// The file name, the same in the beta's folder and in the Electron app's.
pub const SETTINGS_FILE: &str = "settings.json";

/// The folder Electron names `userData` for the shipped app, inside the system's
/// configuration folder (`%APPDATA%`, `~/Library/Application Support`,
/// `$XDG_CONFIG_HOME`): Electron uses the `productName`, "Polaris".
pub const ELECTRON_DATA_FOLDER: &str = "Polaris";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PushChoice {
    pub folder: String,
    pub platform: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WindowPlace {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Point {
    pub x: i64,
    pub y: i64,
}

/// The whole file. Field order is the Electron app's, so the two write the same text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub server: Option<String>,
    pub servers: Vec<SavedServer>,
    pub pushes: BTreeMap<String, PushChoice>,
    pub update_attempted: Option<String>,
    pub window_place: Option<WindowPlace>,
    pub open_at_login: bool,
    pub hardware_acceleration: bool,
    pub minimize_to_tray: bool,
    pub start_minimized: bool,
    pub voice_widget: bool,
    pub voice_widget_game_only: bool,
    pub voice_widget_place: Option<Point>,
    pub text_size: Option<u16>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: None,
            servers: Vec::new(),
            pushes: BTreeMap::new(),
            update_attempted: None,
            window_place: None,
            open_at_login: true,
            hardware_acceleration: true,
            minimize_to_tray: true,
            start_minimized: false,
            voice_widget: true,
            voice_widget_game_only: false,
            voice_widget_place: None,
            text_size: None,
        }
    }
}

/// `z.number().int()`: a finite number with no fraction.
fn int(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

fn boolean(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

/// `z.string().uuid()`: 8-4-4-4-12 hex digits, any case.
fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| {
            group.len() == length && group.chars().all(|c| c.is_ascii_hexdigit())
        })
}

/// The pushes record: the whole record falls back to empty when any entry is bad,
/// as `.catch({})` does; an unknown platform alone falls back to "".
fn read_pushes(value: Option<&Value>) -> BTreeMap<String, PushChoice> {
    let mut pushes = BTreeMap::new();
    let Some(Value::Object(entries)) = value else {
        return pushes;
    };
    for (service, entry) in entries {
        let folder = entry.get("folder").and_then(Value::as_str);
        let Some(folder) = folder.filter(|folder| crate::servers::utf16_len(folder) <= 4096) else {
            return BTreeMap::new();
        };
        if !is_uuid(service) {
            return BTreeMap::new();
        }
        let platform = entry
            .get("platform")
            .and_then(Value::as_str)
            .filter(|platform| PUSH_PLATFORMS.contains(platform))
            .unwrap_or("");
        pushes.insert(
            service.clone(),
            PushChoice {
                folder: folder.to_owned(),
                platform: platform.to_owned(),
            },
        );
    }
    pushes
}

fn read_place(value: Option<&Value>) -> Option<WindowPlace> {
    let place = value?;
    let width = int(place.get("width")).filter(|width| *width > 0)?;
    let height = int(place.get("height")).filter(|height| *height > 0)?;
    Some(WindowPlace {
        x: int(place.get("x"))?,
        y: int(place.get("y"))?,
        width,
        height,
        maximized: place.get("maximized")?.as_bool()?,
    })
}

/// A size as the root element carries it, such as "18px", or a bare number (`readTextSize`).
pub fn read_text_size(raw: &Value) -> Option<u16> {
    let number = match raw {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => {
            let trimmed = text.trim();
            let digits = trimmed.strip_suffix("px").unwrap_or(trimmed);
            if digits.is_empty() || digits.len() > 3 || !digits.chars().all(|c| c.is_ascii_digit())
            {
                return None;
            }
            digits.parse::<f64>().ok()?
        }
        _ => return None,
    };
    TEXT_SIZES
        .iter()
        .copied()
        .find(|size| f64::from(*size) == number)
}

impl Settings {
    /// Reads a parsed file field by field (`settingsSchema` with its `.catch`es).
    pub fn read(raw: &Value) -> Self {
        let Some(object) = raw.as_object() else {
            return Self::default();
        };
        let field = |name: &str| object.get(name);
        Self {
            server: read_server_address(field("server").unwrap_or(&Value::Null)),
            servers: read_servers(field("servers").unwrap_or(&Value::Null)),
            pushes: read_pushes(field("pushes")),
            update_attempted: field("updateAttempted")
                .and_then(Value::as_str)
                .filter(|text| crate::servers::utf16_len(text) <= 64)
                .map(str::to_owned),
            window_place: read_place(field("windowPlace")),
            open_at_login: boolean(field("openAtLogin"), true),
            hardware_acceleration: boolean(field("hardwareAcceleration"), true),
            minimize_to_tray: boolean(field("minimizeToTray"), true),
            start_minimized: boolean(field("startMinimized"), false),
            voice_widget: boolean(field("voiceWidget"), true),
            voice_widget_game_only: boolean(field("voiceWidgetGameOnly"), false),
            voice_widget_place: field("voiceWidgetPlace").and_then(|place| {
                Some(Point {
                    x: int(place.get("x"))?,
                    y: int(place.get("y"))?,
                })
            }),
            text_size: field("textSize").and_then(read_text_size),
        }
    }

    /// The file at `path`, or the defaults when there is none or it cannot be read.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|raw| Self::read(&raw))
            .unwrap_or_default()
    }

    /// Written beside the file and renamed over it, so a crash mid-write leaves the
    /// previous settings rather than an empty file. Readable by this user only.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_json_atomically(path, self)
    }

    /// Every server this app has opened, the one in use included. A file written
    /// before the list existed has only the one address, which becomes the first entry.
    pub fn known_servers(&self) -> Vec<SavedServer> {
        match &self.server {
            Some(server) => with_server(&self.servers, server),
            None => self.servers.clone(),
        }
    }

    /// Open this server from now on, and keep it in the list.
    pub fn set_server_address(&mut self, origin: Option<String>) {
        if let Some(origin) = &origin {
            self.servers = with_server(&self.known_servers(), origin);
        }
        self.server = origin;
    }

    /// Replace the list. The server in use stays in it whatever the list says.
    pub fn set_saved_servers(&mut self, servers: Vec<SavedServer>) {
        self.servers = servers;
        self.servers = self.known_servers();
    }

    /// What was used the last time this service was pushed from here.
    pub fn push_choice(&self, service_id: &str) -> Option<&PushChoice> {
        self.pushes.get(service_id)
    }

    pub fn remember_push_choice(&mut self, service_id: &str, choice: PushChoice) {
        self.pushes.insert(service_id.to_owned(), choice);
    }

    /// The account's text size, as last seen in the Polaris window.
    pub fn text_size(&self) -> u16 {
        self.text_size.unwrap_or(DEFAULT_TEXT_SIZE)
    }

    /// Keep a size seen in the Polaris window. Whether it changed.
    pub fn remember_text_size(&mut self, size: u16) -> bool {
        if self.text_size == Some(size) {
            return false;
        }
        self.text_size = Some(size);
        true
    }

    /// One of `TOGGLES`, or `None` for a name that is not one.
    pub fn toggle(&self, name: &str) -> Option<bool> {
        match name {
            "minimizeToTray" => Some(self.minimize_to_tray),
            "startMinimized" => Some(self.start_minimized),
            "voiceWidget" => Some(self.voice_widget),
            "voiceWidgetGameOnly" => Some(self.voice_widget_game_only),
            _ => None,
        }
    }

    /// Whether `name` is one of `TOGGLES` and was kept.
    pub fn remember_toggle(&mut self, name: &str, on: bool) -> bool {
        let slot = match name {
            "minimizeToTray" => &mut self.minimize_to_tray,
            "startMinimized" => &mut self.start_minimized,
            "voiceWidget" => &mut self.voice_widget,
            "voiceWidgetGameOnly" => &mut self.voice_widget_game_only,
            _ => return false,
        };
        *slot = on;
        true
    }
}

/// Writes JSON (four-space indent, as `JSON.stringify(_, null, 4)`) to a temporary
/// file beside `path` and renames it over, readable by this user only.
pub fn write_json_atomically(path: &Path, value: &impl Serialize) -> io::Result<()> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let mut text = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut writer = serde_json::Serializer::with_formatter(&mut text, formatter);
    value.serialize(&mut writer).map_err(io::Error::other)?;
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    write_private(&temporary, &text)?;
    std::fs::rename(&temporary, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // The per-user profile folder is already readable by this user only on Windows.
    std::fs::write(path, bytes)
}

/// The Electron app's data folder inside the system configuration folder.
pub fn electron_data_folder(config_dir: &Path) -> PathBuf {
    config_dir.join(ELECTRON_DATA_FOLDER)
}

/// What a one-time import from the Electron app found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Imported {
    /// The beta already had its own file: nothing was read.
    AlreadyHad,
    /// No Electron file to read (or not one that parses as JSON).
    NothingThere,
    /// The Electron file was read and written as the beta's own.
    Copied,
}

/// Carries the Electron app's file named `file_name` over to the beta, once: only
/// while the beta has none of its own, and through `read` so what lands is what
/// the beta would have written. The Electron file is opened for reading only and
/// never written, renamed or removed.
pub fn import_once(
    electron_folder: &Path,
    beta_folder: &Path,
    file_name: &str,
    read: impl FnOnce(&Value) -> Value,
) -> io::Result<Imported> {
    let target = beta_folder.join(file_name);
    if target.exists() {
        return Ok(Imported::AlreadyHad);
    }
    let Ok(text) = std::fs::read_to_string(electron_folder.join(file_name)) else {
        return Ok(Imported::NothingThere);
    };
    let Ok(raw) = serde_json::from_str::<Value>(&text) else {
        return Ok(Imported::NothingThere);
    };
    write_json_atomically(&target, &read(&raw))?;
    Ok(Imported::Copied)
}

/// The Electron app's `settings.json`, read through this schema.
pub fn import_electron_settings(
    electron_folder: &Path,
    beta_folder: &Path,
) -> io::Result<Imported> {
    import_once(electron_folder, beta_folder, SETTINGS_FILE, |raw| {
        serde_json::to_value(Settings::read(raw)).unwrap_or(Value::Object(Map::new()))
    })
}
