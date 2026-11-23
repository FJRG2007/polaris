//! Node binding of `polaris-stream100`. Conversion only: the protocol, the knob
//! engine, the categories and the backends are the crate's.
//!
//! Values cross as JSON text in the crate's own serde shapes, so the add-on's
//! TypeScript validates one documented shape instead of a second copy of every
//! type. Every export catches panics (built with the `release-node` profile,
//! which unwinds), so a defect surfaces as an `Error` and never aborts the
//! add-on's process.

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
use polaris_stream100::audio::{backend_status, AudioError, AudioSessions, Session};
use polaris_stream100::engine::{Command, Engine, Output};
use polaris_stream100::report::KnobMap;
use polaris_stream100::settings::{schema, Settings};
use polaris_stream100::{addon, manifest, native, ownership};

fn json(value: &impl serde::Serialize) -> napi::Result<String> {
    serde_json::to_string(value).map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn audio_error(error: AudioError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// The module's manifest: id, version, the USB ids it claims, permissions.
#[napi(catch_unwind)]
pub fn manifest_json() -> napi::Result<String> {
    json(&manifest::manifest())
}

/// The declarative settings schema the add-on's settings page draws.
#[napi(catch_unwind)]
pub fn schema_json() -> napi::Result<String> {
    json(&schema())
}

/// The add-on manifest's `settings` list (flat switches, choices, ranges, actions).
#[napi(catch_unwind)]
pub fn addon_settings_json() -> napi::Result<String> {
    json(&addon::addon_settings())
}

/// The add-on page's stored flat values (a JSON object) as the full settings
/// [`Controller`] takes; anything missing or not fitting keeps its default.
#[napi(catch_unwind)]
pub fn settings_from_addon(values: String) -> napi::Result<String> {
    let values = serde_json::from_str::<serde_json::Value>(&values).unwrap_or_default();
    let empty = serde_json::Map::new();
    json(&addon::settings_from_addon(
        values.as_object().unwrap_or(&empty),
    ))
}

/// Stored settings brought to a complete, in-range form (defaults for anything
/// missing or damaged).
#[napi(catch_unwind)]
pub fn normalize_settings(stored: String) -> napi::Result<String> {
    json(&Settings::from_json(&stored))
}

/// Who holds the controller on this machine and what Polaris can offer:
/// `{ observed, ownership }`. Read-only: it lists devices and processes.
#[napi(catch_unwind)]
pub fn ownership_json() -> napi::Result<String> {
    let observed = native::observe();
    let decided = ownership::decide(&observed);
    json(&serde_json::json!({
        "observed": {
            "os": observed.os,
            "service": observed.service,
            "streamControlRunning": observed.stream_control_running,
            "present": observed.present,
        },
        "ownership": decided,
    }))
}

/// Where this system's per-app volume stands, in words a screen can show.
#[napi(catch_unwind)]
pub fn audio_status() -> String {
    backend_status(std::env::consts::OS).to_owned()
}

/// The controller: input reports in; volume and mute applied through this
/// system's per-app volume; Polaris actions handed back to the caller.
///
/// Create and use it on one thread (the add-on's main thread): the Windows
/// backend's COM objects belong to the thread that made them.
#[napi]
pub struct Controller {
    engine: Engine,
    mixer: Option<Box<dyn AudioSessions>>,
}

impl Controller {
    fn mixer(&mut self) -> napi::Result<&mut Box<dyn AudioSessions>> {
        if self.mixer.is_none() {
            self.mixer = Some(native::open().map_err(audio_error)?);
        }
        self.mixer
            .as_mut()
            .ok_or_else(|| napi::Error::from_reason("no audio backend"))
    }
}

#[napi]
impl Controller {
    #[napi(constructor, catch_unwind)]
    pub fn new(settings: String) -> Self {
        Self {
            engine: Engine::new(Settings::from_json(&settings), KnobMap::default()),
            mixer: None,
        }
    }

    #[napi(catch_unwind)]
    pub fn set_settings(&mut self, settings: String) {
        self.engine.set_settings(Settings::from_json(&settings));
    }

    /// Program keys of the running games the desktop's game detection found.
    #[napi(catch_unwind)]
    pub fn set_games(&mut self, keys: Vec<String>) {
        self.engine.set_games(keys);
    }

    /// Forgets the baseline and pending turns (reconnect, locked session).
    #[napi(catch_unwind)]
    pub fn reset(&mut self) {
        self.engine.reset();
    }

    /// The apps playing audio now, as `Session[]` JSON.
    #[napi(catch_unwind)]
    pub fn sessions_json(&mut self) -> napi::Result<String> {
        let sessions = self.mixer()?.sessions().map_err(audio_error)?;
        json(&sessions)
    }

    /// One input report. Applies its volume and mute changes and answers the
    /// deck action ids it asked for (`["call.mic"]`), for the caller to run.
    /// A change the backend refuses (the app closed meanwhile) is skipped.
    #[napi(catch_unwind)]
    pub fn feed(&mut self, report: Uint8Array, now_ms: f64) -> napi::Result<Vec<String>> {
        let now = if now_ms.is_finite() && now_ms > 0.0 {
            now_ms as u64
        } else {
            0
        };
        let mixer = self.mixer()?;
        let sessions: Vec<Session> = mixer.sessions().map_err(audio_error)?;
        let (volume, muted) = mixer.output_volume().map_err(audio_error)?;
        let commands = self
            .engine
            .feed(&report, now, &sessions, Output { volume, muted });
        let mixer = self.mixer()?;
        let mut actions = Vec::new();
        for command in commands {
            let _ = match command {
                Command::SetVolume { id, volume } => mixer.set_volume(&id, volume),
                Command::SetMuted { id, muted } => mixer.set_muted(&id, muted),
                Command::SetOutputVolume { volume } => mixer.set_output_volume(volume),
                Command::SetOutputMuted { muted } => mixer.set_output_muted(muted),
                Command::Action { id } => {
                    actions.push(id);
                    Ok(())
                }
            };
        }
        Ok(actions)
    }
}
