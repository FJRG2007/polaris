//! Node binding of `polaris-stream100`. Conversion only: the protocol, the knob
//! engine, the categories and the backends are the crate's.
//!
//! Values cross as JSON text in the crate's own serde shapes, so the plugin's
//! TypeScript validates one documented shape instead of a second copy of every
//! type. Every export catches panics (built with the `release-node` profile,
//! which unwinds), so a defect surfaces as an `Error` and never aborts the
//! plugin's process.

use napi::bindgen_prelude::{AsyncTask, Uint8Array};
use napi::{Env, Task};
use napi_derive::napi;
use polaris_stream100::audio::{backend_status, AudioError, AudioSessions, Session};
use polaris_stream100::engine::{Command, Engine, Output};
use polaris_stream100::native::input::Input;
use polaris_stream100::plugin::Locale;
use polaris_stream100::report::KnobMap;
use polaris_stream100::screen::{self, Call, NowPlaying};
use polaris_stream100::settings::{schema, Settings};
use polaris_stream100::transport::TransportError;
use polaris_stream100::{manifest, native, ownership, plugin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn json(value: &impl serde::Serialize) -> napi::Result<String> {
    serde_json::to_string(value).map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn audio_error(error: AudioError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// The device plugin manifest (`clients/device-plugins/hercules-stream100/manifest.json`).
#[napi(catch_unwind)]
pub fn manifest_json() -> napi::Result<String> {
    json(&manifest::manifest())
}

/// The declarative settings schema the plugin's settings page draws.
#[napi(catch_unwind)]
pub fn schema_json() -> napi::Result<String> {
    json(&schema())
}

/// The plugin manifest's `settings` list (flat switches, choices, ranges, actions).
#[napi(catch_unwind)]
pub fn plugin_settings_json() -> napi::Result<String> {
    json(&plugin::plugin_settings())
}

/// The plugin page's stored flat values (a JSON object) as the full settings
/// [`Controller`] takes; anything missing or not fitting keeps its default.
#[napi(catch_unwind)]
pub fn settings_from_plugin(values: String) -> napi::Result<String> {
    let values = serde_json::from_str::<serde_json::Value>(&values).unwrap_or_default();
    let empty = serde_json::Map::new();
    json(&plugin::settings_from_plugin(
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

/// Whether per-app volume can be used on this system (`native::per_app_access`):
/// the plugin's page header says so when it cannot.
#[napi(catch_unwind)]
pub fn audio_access() -> String {
    native::per_app_access().to_owned()
}

/// Shows the system's prompt for what per-app volume needs (macOS: recording
/// system audio). Only the desktop app calls it; the answer is read back with
/// `audioAccess`.
#[napi(catch_unwind)]
pub fn request_audio_access() {
    native::request_per_app_access();
}

/// The controller: input reports in; volume and mute applied through this
/// system's per-app volume; Polaris actions handed back to the caller.
///
/// Create and use it on one thread (the plugin's main thread): the Windows
/// backend's COM objects belong to the thread that made them.
#[napi]
pub struct Controller {
    engine: Engine,
    mixer: Option<Box<dyn AudioSessions>>,
}

impl Controller {
    /// Posts the page as it stands now, without waiting for a knob; with no
    /// audio backend it follows at the next report instead.
    fn repaint(&mut self) {
        if let Ok(mixer) = self.mixer() {
            if let (Ok(sessions), Ok((volume, muted))) = (mixer.sessions(), mixer.output_volume()) {
                screen::post(self.engine.screen(&sessions, Output { volume, muted }, &[]));
            }
        }
    }

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
        // The screen follows a new mode or brightness without waiting for a knob.
        self.repaint();
    }

    /// The desktop app's language (`es-ES`, `en-US`, ...) for the screen's
    /// words; any language Polaris does not ship draws in English.
    #[napi(catch_unwind)]
    pub fn set_locale(&mut self, locale: String) {
        if self.engine.set_locale(Locale::from_tag(&locale)) {
            self.repaint();
        }
    }

    /// The Polaris call as the app answers `polaris.state` (its `call`: JSON,
    /// `null` when there is none). Anything not of that shape is no call.
    #[napi(catch_unwind)]
    pub fn set_call(&mut self, call: String) {
        let call = serde_json::from_str::<Option<Call>>(&call).unwrap_or_default();
        if self.engine.set_call(call) {
            self.repaint();
        }
    }

    /// What is playing, as [`now_playing`] answers it (JSON, `null` for nothing).
    #[napi(catch_unwind)]
    pub fn set_now_playing(&mut self, playing: String) {
        let playing = serde_json::from_str::<Option<NowPlaying>>(&playing)
            .ok()
            .flatten()
            .and_then(|now| NowPlaying::new(&now.title, &now.artist, now.playing));
        if self.engine.set_now_playing(playing) {
            self.repaint();
        }
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
        screen::post(
            self.engine
                .screen(&sessions, Output { volume, muted }, &commands),
        );
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

/// One read of the system's media session, on a worker thread: the
/// Windows one waits on its own asynchronous calls.
pub struct ReadNowPlaying;

impl Task for ReadNowPlaying {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<String> {
        let playing = std::panic::catch_unwind(native::media::now_playing)
            .map_err(|_| napi::Error::from_reason("reading what is playing failed"))?
            .map_err(napi::Error::from_reason)?;
        json(&playing)
    }

    fn resolve(&mut self, _env: Env, output: String) -> napi::Result<String> {
        Ok(output)
    }
}

/// What the system's media session says is playing, as `NowPlaying` JSON
/// (`null` for nothing, and always on macOS), for `Controller.setNowPlaying`.
#[napi(ts_return_type = "Promise<string>")]
pub fn now_playing() -> AsyncTask<ReadNowPlaying> {
    AsyncTask::new(ReadNowPlaying)
}

/// What one [`Reader::next`] answers: a report, nothing within the wait, or
/// why the controller could not be read (`notFound`, `busy`, `noAccess`,
/// `unsupported`, `io`). After an error the next call opens the controller afresh.
#[napi(object)]
pub struct Read {
    pub report: Option<Uint8Array>,
    pub error: Option<String>,
}

fn error_code(error: &TransportError) -> &'static str {
    match error {
        TransportError::NotFound => "notFound",
        TransportError::Busy => "busy",
        TransportError::NoAccess => "noAccess",
        TransportError::Unsupported => "unsupported",
        TransportError::Io(_) => "io",
    }
}

#[derive(Default)]
struct ReaderState {
    input: Mutex<Option<Input>>,
    closed: AtomicBool,
}

/// One wait for a report, run on a worker thread so the plugin's main
/// thread (and the Controller's audio objects on it) never block on the device.
pub struct NextRead {
    state: Arc<ReaderState>,
    timeout: Duration,
}

impl Task for NextRead {
    type Output = (Option<Vec<u8>>, Option<&'static str>);
    type JsValue = Read;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let mut input = self
            .state
            .input
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.state.closed.load(Ordering::Acquire) {
            *input = None;
            return Ok((None, None));
        }
        if input.is_none() {
            match Input::open() {
                Ok(opened) => *input = Some(opened),
                Err(error) => return Ok((None, Some(error_code(&error)))),
            }
        }
        let Some(open) = input.as_mut() else {
            return Ok((None, None));
        };
        let read = open.next(self.timeout);
        if self.state.closed.load(Ordering::Acquire) {
            *input = None;
            return Ok((None, None));
        }
        match read {
            Ok(report) => Ok((report.map(|report| report.to_bytes().to_vec()), None)),
            Err(error) => {
                *input = None;
                Ok((None, Some(error_code(&error))))
            }
        }
    }

    fn resolve(&mut self, _env: Env, (report, error): Self::Output) -> napi::Result<Read> {
        Ok(Read {
            report: report.map(Uint8Array::from),
            error: error.map(String::from),
        })
    }
}

/// The controller's input reports, read on a worker thread: `await
/// reader.next(500)` answers each report as bytes `Controller.feed` takes.
/// Read-only: nothing is ever written to the device.
#[napi]
pub struct Reader {
    state: Arc<ReaderState>,
}

#[napi]
impl Reader {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::default(),
        }
    }

    /// Waits up to `timeoutMs` (at most 5 s) for the next report.
    #[napi(ts_return_type = "Promise<Read>")]
    pub fn next(&self, timeout_ms: u32) -> AsyncTask<NextRead> {
        AsyncTask::new(NextRead {
            state: Arc::clone(&self.state),
            timeout: Duration::from_millis(u64::from(timeout_ms.min(5_000))),
        })
    }

    /// Lets the controller go; a read in flight answers nothing.
    #[napi]
    pub fn close(&self) {
        self.state.closed.store(true, Ordering::Release);
        if let Ok(mut input) = self.state.input.try_lock() {
            *input = None;
        }
    }
}

impl Default for Reader {
    fn default() -> Self {
        Self::new()
    }
}
