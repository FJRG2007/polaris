//! What is playing, from the operating system's media session: the title and
//! artist a music or video player publishes for the lock screen and the
//! media keys.
//!
//! - Windows: the Global System Media Transport Controls session manager
//!   (`Windows.Media.Control`), the source of the Windows volume flyout.
//! - Linux: MPRIS (`org.mpris.MediaPlayer2.Player`) on the session D-Bus,
//!   what `playerctl` and every desktop's media applet read. A playing
//!   player wins over a paused one.
//! - macOS: nothing. The only system-wide source is the private MediaRemote
//!   framework, and since macOS 15.4 it answers only Apple-entitled
//!   processes (ungive/mediaremote-adapter documents the change and its
//!   workarounds, which load code through a system binary). Polaris does
//!   not do that, so the page says macOS does not let apps read it and the
//!   screen shows the knobs.

use crate::screen::NowPlaying;

/// What is playing now, `None` when nothing is (or the system cannot say).
pub fn now_playing() -> Result<Option<NowPlaying>, String> {
    #[cfg(windows)]
    return windows::now_playing().map_err(|error| error.message());
    #[cfg(target_os = "linux")]
    return linux::now_playing().map_err(|error| error.to_string());
    #[cfg(not(any(windows, target_os = "linux")))]
    Ok(None)
}

#[cfg(windows)]
mod windows {
    use crate::screen::NowPlaying;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    pub fn now_playing() -> windows::core::Result<Option<NowPlaying>> {
        let manager = Manager::RequestAsync()?.join()?;
        // No session at all comes back as an error from a null object.
        let Ok(session) = manager.GetCurrentSession() else {
            return Ok(None);
        };
        let status = session.GetPlaybackInfo()?.PlaybackStatus()?;
        if status != Status::Playing && status != Status::Paused {
            return Ok(None);
        }
        let properties = session.TryGetMediaPropertiesAsync()?.join()?;
        Ok(NowPlaying::new(
            &properties.Title()?.to_string_lossy(),
            &properties.Artist()?.to_string_lossy(),
            status == Status::Playing,
        ))
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use crate::screen::NowPlaying;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use zbus::blocking::{fdo::DBusProxy, Connection, Proxy};
    use zbus::zvariant::{OwnedValue, Value};

    const PREFIX: &str = "org.mpris.MediaPlayer2.";
    const PATH: &str = "/org/mpris/MediaPlayer2";
    const PLAYER: &str = "org.mpris.MediaPlayer2.Player";

    /// The session bus, opened once and dropped after a failure.
    static BUS: Mutex<Option<Connection>> = Mutex::new(None);

    pub fn now_playing() -> zbus::Result<Option<NowPlaying>> {
        let mut bus = BUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if bus.is_none() {
            *bus = Some(Connection::session()?);
        }
        let Some(connection) = bus.as_ref() else {
            return Ok(None);
        };
        let read = read(connection);
        if read.is_err() {
            *bus = None;
        }
        read
    }

    fn read(connection: &Connection) -> zbus::Result<Option<NowPlaying>> {
        let mut paused = None;
        for name in DBusProxy::new(connection)?.list_names()? {
            if !name.as_str().starts_with(PREFIX) {
                continue;
            }
            // One player that does not answer never hides the others.
            let Ok(player) = Proxy::new(connection, name.as_str(), PATH, PLAYER) else {
                continue;
            };
            let Ok(status) = player.get_property::<String>("PlaybackStatus") else {
                continue;
            };
            if status != "Playing" && (status != "Paused" || paused.is_some()) {
                continue;
            }
            let Ok(metadata) = player.get_property::<HashMap<String, OwnedValue>>("Metadata")
            else {
                continue;
            };
            let title = metadata.get("xesam:title").map(text).unwrap_or_default();
            let artist = metadata.get("xesam:artist").map(text).unwrap_or_default();
            let playing = NowPlaying::new(&title, &artist, status == "Playing");
            if status == "Playing" && playing.is_some() {
                return Ok(playing);
            }
            paused = paused.or(playing);
        }
        Ok(paused)
    }

    /// A metadata value as text: a string, or a list of them joined.
    fn text(value: &OwnedValue) -> String {
        match &**value {
            Value::Str(text) => text.as_str().to_owned(),
            Value::Array(list) => list
                .inner()
                .iter()
                .filter_map(|item| match item {
                    Value::Str(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(", "),
            _ => String::new(),
        }
    }
}
