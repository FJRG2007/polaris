//! The whole controller in one place: reports in, commands out.
//!
//! The engine owns the report decoder and the four knob encoders, reads what
//! each knob and button is set to, and answers each input report with what to
//! do: change a session's volume or mute, change the output's, or run a
//! Polaris action. It never touches audio or the network itself, so the host
//! (the plugin process) applies the commands and the engine stays pure and
//! tested without a device.

use crate::audio::{resolve, Session, Target};
use crate::encoder::{apply, Encoder};
use crate::plugin::{action_name, knob_value, screen_name, Locale};
use crate::report::{Decoder, Event, KnobMap, Report};
use crate::screen::{Call, Idle, Knob, NowPlaying, Screen};
use crate::settings::Settings;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    SetVolume {
        id: String,
        volume: u8,
    },
    SetMuted {
        id: String,
        muted: bool,
    },
    SetOutputVolume {
        volume: u8,
    },
    SetOutputMuted {
        muted: bool,
    },
    /// A deck action id (`call.mic`, `call.deafen`, ...) for the host to run.
    Action {
        id: String,
    },
}

/// The default output's state, as the backend reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Output {
    pub volume: u8,
    pub muted: bool,
}

/// Most names of the app's own actions kept.
const MAX_ACTION_NAMES: usize = 256;
/// Longest action name kept, in characters.
const MAX_ACTION_NAME: usize = 40;

#[derive(Debug)]
pub struct Engine {
    settings: Settings,
    decoder: Decoder,
    encoders: [Encoder; 4],
    games: HashSet<String>,
    locale: Locale,
    call: Option<Call>,
    playing: Option<NowPlaying>,
    idle: Option<Idle>,
    /// The names the app gave its own actions (`custom:<id>`, `launcher:<entry>`).
    action_names: HashMap<String, String>,
    /// The look decoded once (pictures scaled, palette built), not per page.
    theme: std::sync::Arc<crate::theme::Theme>,
}

impl Engine {
    pub fn new(settings: Settings, knobs: KnobMap) -> Self {
        Self {
            theme: std::sync::Arc::new(crate::theme::Theme::new(&settings.look)),
            settings,
            decoder: Decoder::new(knobs),
            encoders: Default::default(),
            games: HashSet::new(),
            locale: Locale::default(),
            call: None,
            playing: None,
            idle: None,
            action_names: HashMap::new(),
        }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// New settings apply from the next report; what was turned under the old
    /// ones is dropped rather than applied to a knob's new target.
    pub fn set_settings(&mut self, settings: Settings) {
        if settings.look != *self.theme.look() {
            self.theme = std::sync::Arc::new(crate::theme::Theme::new(&settings.look));
        }
        self.settings = settings;
        self.encoders.iter_mut().for_each(Encoder::discard);
    }

    /// The running programs the desktop's game detection recognises, by
    /// program key (`program_key`), for the Games category.
    pub fn set_games(&mut self, keys: impl IntoIterator<Item = String>) {
        // The desktop's keys keep `.exe` and may carry a folder; the sessions
        // are matched by the bare lowercased name.
        self.games = keys
            .into_iter()
            .map(|key| crate::audio::program_key(key.trim()))
            .filter(|key| !key.is_empty())
            .collect();
    }

    /// The language the screen is drawn in. Answers whether it changed.
    pub fn set_locale(&mut self, locale: Locale) -> bool {
        std::mem::replace(&mut self.locale, locale) != locale
    }

    /// The Polaris call this computer is in, as the desktop app reports it
    /// (`None`: no call). Answers whether it changed.
    pub fn set_call(&mut self, call: Option<Call>) -> bool {
        let call = call.map(Call::bounded);
        if self.call == call {
            return false;
        }
        self.call = call;
        true
    }

    /// What the system's media session says is playing. Answers whether it changed.
    pub fn set_now_playing(&mut self, playing: Option<NowPlaying>) -> bool {
        if self.playing == playing {
            return false;
        }
        self.playing = playing;
        true
    }

    /// The idle page the plugin wants shown instead of the chosen one
    /// (`None`: the chosen page). Answers whether it changed.
    pub fn set_idle(&mut self, idle: Option<Idle>) -> bool {
        let idle = idle.map(Idle::bounded);
        if self.idle == idle {
            return false;
        }
        self.idle = idle;
        true
    }

    /// The names of the app's own actions, by the id a button holds
    /// (`custom:<id>`, `launcher:<entry>`), for the action zone. Kept to
    /// [`MAX_ACTION_NAMES`], each cut to [`MAX_ACTION_NAME`] characters with
    /// control characters dropped. Answers whether it changed.
    pub fn set_action_names(&mut self, names: impl IntoIterator<Item = (String, String)>) -> bool {
        let names: HashMap<String, String> = names
            .into_iter()
            .filter(|(id, _)| id.len() <= 64)
            .map(|(id, name)| {
                let name: String = name
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(MAX_ACTION_NAME)
                    .collect();
                (id, name.trim().to_owned())
            })
            .filter(|(_, name)| !name.is_empty())
            .take(MAX_ACTION_NAMES)
            .collect();
        if names == self.action_names {
            return false;
        }
        self.action_names = names;
        true
    }

    /// What each button shows in the action zone: a call action in the
    /// screen's language, the app's own name for one of its actions, or
    /// nothing (no action, or one the app has not named).
    fn button_names(&self) -> [String; 4] {
        std::array::from_fn(|index| {
            let id = self.settings.buttons[index].trim();
            match action_name(id) {
                Some((en, es)) => self.locale.pick(en, es).to_owned(),
                None => self.action_names.get(id).cloned().unwrap_or_default(),
            }
        })
    }

    /// Forgets the decoder baseline and pending counts (reconnect, lock).
    pub fn reset(&mut self) {
        self.decoder.reset();
        self.encoders.iter_mut().for_each(Encoder::discard);
    }

    /// One input report. `sessions` and `output` are the audio state now.
    pub fn feed(
        &mut self,
        bytes: &[u8],
        now_ms: u64,
        sessions: &[Session],
        output: Output,
    ) -> Vec<Command> {
        let Some(report) = Report::parse(bytes) else {
            return Vec::new();
        };
        let events = self.decoder.feed(report);
        if !self.settings.enabled {
            self.encoders.iter_mut().for_each(Encoder::discard);
            return Vec::new();
        }
        let mut commands = Vec::new();
        for event in events {
            match event {
                Event::Turn { knob, counts } => self.turn(
                    usize::from(knob),
                    counts,
                    now_ms,
                    sessions,
                    output,
                    &mut commands,
                ),
                Event::KnobPress {
                    knob,
                    pressed: true,
                } => {
                    let id = self.settings.knob_press[usize::from(knob) % 4].trim();
                    if id.is_empty() {
                        self.press(usize::from(knob), sessions, output, &mut commands);
                    } else {
                        commands.push(Command::Action { id: id.to_owned() });
                    }
                }
                Event::Button {
                    button,
                    pressed: true,
                } => {
                    let id = self.settings.buttons[usize::from(button) % 4].trim();
                    if !id.is_empty() {
                        commands.push(Command::Action { id: id.to_owned() });
                    }
                }
                _ => {}
            }
        }
        commands
    }

    /// What each knob's channel plays now, 0-100: the loudest of the sessions
    /// it follows, the output's own meter for the output knob, `None` when
    /// it follows nothing playing or the backend has no meters.
    pub fn levels(
        &self,
        sessions: &[Session],
        peaks: &[(String, f32)],
        output: Option<f32>,
    ) -> [Option<u8>; 4] {
        let level = |peak: f32| (peak.clamp(0.0, 1.0) * 100.0).round() as u8;
        std::array::from_fn(|knob| match self.targets(knob, sessions) {
            None => output.map(level),
            Some(ids) => peaks
                .iter()
                .filter(|(id, _)| ids.contains(&id.as_str()))
                .map(|(_, peak)| level(*peak))
                .max(),
        })
    }

    fn targets<'a>(&self, knob: usize, sessions: &'a [Session]) -> Option<Vec<&'a str>> {
        let target: &Target = &self.settings.knobs[knob % 4];
        resolve(target, sessions, |key| self.games.contains(key))
    }

    fn turn(
        &mut self,
        knob: usize,
        counts: i32,
        now_ms: u64,
        sessions: &[Session],
        output: Output,
        commands: &mut Vec<Command>,
    ) {
        let ids = self.targets(knob, sessions);
        let encoder = &mut self.encoders[knob % 4];
        if ids.as_ref().is_some_and(Vec::is_empty) {
            // Nothing to move: counts turned now are never applied later.
            encoder.discard();
            return;
        }
        let change = encoder.turn(counts, now_ms, &self.settings.tuning);
        if change == 0 {
            return;
        }
        match ids {
            None => commands.push(Command::SetOutputVolume {
                volume: apply(output.volume, change),
            }),
            Some(ids) => {
                for session in sessions.iter().filter(|s| ids.contains(&s.id.as_str())) {
                    let volume = apply(session.volume, change);
                    if volume != session.volume {
                        commands.push(Command::SetVolume {
                            id: session.id.clone(),
                            volume,
                        });
                    }
                }
            }
        }
    }

    /// What the screen shows after `commands` (this report's answer) apply:
    /// each knob's name, the loudest volume among what it follows, and
    /// whether all of that is muted.
    pub fn screen(&self, sessions: &[Session], output: Output, commands: &[Command]) -> Screen {
        let mut output = output;
        let mut sessions = sessions.to_vec();
        for command in commands {
            match command {
                Command::SetVolume { id, volume } => {
                    for session in sessions.iter_mut().filter(|s| &s.id == id) {
                        session.volume = *volume;
                    }
                }
                Command::SetMuted { id, muted } => {
                    for session in sessions.iter_mut().filter(|s| &s.id == id) {
                        session.muted = *muted;
                    }
                }
                Command::SetOutputVolume { volume } => output.volume = *volume,
                Command::SetOutputMuted { muted } => output.muted = *muted,
                Command::Action { .. } => {}
            }
        }
        let knobs = std::array::from_fn(|knob| {
            let label = knob_label(&self.settings.knobs[knob], self.locale);
            match self.targets(knob, &sessions) {
                None => Knob {
                    label,
                    volume: Some(output.volume),
                    muted: output.muted,
                },
                Some(ids) => {
                    let followed: Vec<&Session> = sessions
                        .iter()
                        .filter(|s| ids.contains(&s.id.as_str()))
                        .collect();
                    Knob {
                        label,
                        volume: followed.iter().map(|s| s.volume).max(),
                        muted: !followed.is_empty() && followed.iter().all(|s| s.muted),
                    }
                }
            }
        });
        Screen {
            mode: self.settings.display,
            brightness: self.settings.brightness,
            knobs,
            buttons: self.button_names(),
            locale: self.locale,
            call: self.call.clone(),
            playing: self.playing.clone(),
            idle: self.idle.clone(),
            theme: self.theme.clone(),
        }
    }

    /// A knob press mutes what it follows, or unmutes it when all of it is muted.
    fn press(
        &self,
        knob: usize,
        sessions: &[Session],
        output: Output,
        commands: &mut Vec<Command>,
    ) {
        match self.targets(knob, sessions) {
            None => commands.push(Command::SetOutputMuted {
                muted: !output.muted,
            }),
            Some(ids) => {
                let followed: Vec<&Session> = sessions
                    .iter()
                    .filter(|s| ids.contains(&s.id.as_str()))
                    .collect();
                let muted = !followed.iter().all(|s| s.muted);
                for session in followed {
                    commands.push(Command::SetMuted {
                        id: session.id.clone(),
                        muted,
                    });
                }
            }
        }
    }
}

/// A knob's name on the screen, in `locale`: its category or `Output` (the
/// plugin page's words, [`screen_name`]), or the program it follows without
/// the extension.
fn knob_label(target: &Target, locale: Locale) -> String {
    match target {
        Target::Program { program } => program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(program)
            .trim_end_matches(".exe")
            .to_owned(),
        other => {
            let (en, es) = screen_name(knob_value(other));
            locale.pick(en, es).to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::Category;
    use crate::encoder::DETENT_COUNTS;
    use crate::report::BUTTON_BITS;

    fn report(buttons: u8, positions: [i16; 4]) -> Vec<u8> {
        let mut bytes = vec![0u8; 64];
        bytes[1] = buttons;
        for (i, p) in positions.iter().enumerate() {
            bytes[3 + i * 2..5 + i * 2].copy_from_slice(&p.to_le_bytes());
        }
        bytes
    }

    fn session(id: &str, program: &str, volume: u8, muted: bool) -> Session {
        Session {
            id: id.into(),
            program: program.into(),
            pid: 1,
            system: false,
            volume,
            muted,
        }
    }

    fn engine() -> Engine {
        let mut engine = Engine::new(Settings::default(), KnobMap::default());
        engine.feed(&report(0, [0; 4]), 0, &[], Output::default());
        engine
    }

    #[test]
    fn each_knob_meters_the_loudest_of_what_it_follows_and_the_output_its_own() {
        let mut engine = engine();
        let mut knobs = Settings::default().knobs;
        knobs[0] = Target::Program {
            program: "spotify.exe".into(),
        };
        engine.set_settings(Settings {
            knobs,
            ..Default::default()
        });
        let sessions = [
            session("a", "Spotify.exe", 50, false),
            session("b", "spotify.exe", 50, false),
            session("c", "notepad.exe", 50, false),
        ];
        let peaks = [
            ("a".to_owned(), 0.2),
            ("b".to_owned(), 0.654),
            ("c".to_owned(), 1.0),
        ];
        let levels = engine.levels(&sessions, &peaks, Some(0.3));
        assert_eq!(levels[0], Some(65));
        assert_eq!(levels[3], Some(30));
        // Nothing it follows is playing: no meter, not a silent one.
        assert_eq!(levels[2], None);
        // A backend without meters draws none.
        assert_eq!(engine.levels(&sessions, &[], None), [None; 4]);
    }

    #[test]
    fn knob_names_follow_the_locale_and_program_names_never_do() {
        let mut engine = engine();
        let names = |engine: &Engine| {
            engine
                .screen(&[], Output::default(), &[])
                .knobs
                .map(|knob| knob.label)
        };
        assert_eq!(names(&engine), ["Calls", "Music", "Games", "Output"]);
        assert!(engine.set_locale(Locale::from_tag("es-ES")));
        assert!(!engine.set_locale(Locale::EsEs));
        assert_eq!(names(&engine), ["Llamadas", "Música", "Juegos", "Salida"]);
        let mut knobs = Settings::default().knobs;
        knobs[0] = Target::Program {
            program: r"C:\Games\Obs64.exe".into(),
        };
        engine.set_settings(Settings {
            knobs,
            ..Default::default()
        });
        assert_eq!(names(&engine)[0], "Obs64");
        // An unknown language falls back to English.
        engine.set_locale(Locale::from_tag("fr-FR"));
        assert_eq!(names(&engine)[1], "Music");
    }

    #[test]
    fn a_detent_moves_the_category_it_follows() {
        let mut engine = engine();
        let sessions = [
            session("a", "Spotify.exe", 50, false),
            session("b", "Discord.exe", 40, false),
        ];
        // Knob 2 follows Music by default.
        let commands = engine.feed(
            &report(0, [0, DETENT_COUNTS as i16, 0, 0]),
            1_000,
            &sessions,
            Output::default(),
        );
        assert_eq!(
            commands,
            vec![Command::SetVolume {
                id: "a".into(),
                volume: 52
            }]
        );
    }

    #[test]
    fn the_output_knob_moves_the_output() {
        let mut engine = engine();
        let commands = engine.feed(
            &report(0, [0, 0, 0, -(DETENT_COUNTS as i16)]),
            1_000,
            &[],
            Output {
                volume: 30,
                muted: false,
            },
        );
        assert_eq!(commands, vec![Command::SetOutputVolume { volume: 28 }]);
    }

    #[test]
    fn counts_with_nothing_to_move_are_never_banked() {
        let mut engine = engine();
        // Music knob turned with no music playing.
        assert!(engine
            .feed(&report(0, [0, 40, 0, 0]), 1_000, &[], Output::default())
            .is_empty());
        let sessions = [session("a", "Spotify.exe", 50, false)];
        // A small move once Spotify plays must not release the earlier 40 counts.
        let commands = engine.feed(
            &report(0, [0, 45, 0, 0]),
            1_050,
            &sessions,
            Output::default(),
        );
        assert!(commands.is_empty(), "{commands:?}");
    }

    #[test]
    fn the_action_zone_names_call_actions_and_the_apps_own() {
        let settings = Settings {
            buttons: ["call.mic", "custom:obs", "launcher:x", ""].map(String::from),
            ..Settings::default()
        };
        let mut engine = engine();
        engine.set_settings(settings);
        assert!(engine.set_action_names([
            ("custom:obs".to_owned(), "Start\u{7}stream".to_owned()),
            ("launcher:y".to_owned(), "Other".to_owned()),
        ]));
        assert!(!engine.set_action_names([
            ("custom:obs".to_owned(), "Startstream".to_owned()),
            ("launcher:y".to_owned(), "Other".to_owned()),
        ]));
        let screen = engine.screen(&[], Output::default(), &[]);
        // An action nobody named shows nothing rather than its id.
        assert_eq!(
            screen.buttons,
            ["Mute mic", "Startstream", "", ""].map(String::from)
        );
        engine.set_locale(Locale::EsEs);
        assert_eq!(
            engine.screen(&[], Output::default(), &[]).buttons[0],
            "Silenciar"
        );
    }

    #[test]
    fn a_lit_button_runs_its_action() {
        let mut engine = engine();
        let commands = engine.feed(&report(BUTTON_BITS[1], [0; 4]), 10, &[], Output::default());
        assert_eq!(
            commands,
            vec![Command::Action {
                id: "call.deafen".into()
            }]
        );
        // Releasing it runs nothing.
        assert!(engine
            .feed(&report(0, [0; 4]), 20, &[], Output::default())
            .is_empty());
    }

    #[test]
    fn a_knob_press_runs_its_action_when_one_is_set() {
        let mut settings = Settings::default();
        settings.knob_press[1] = "custom:obs".into();
        let mut engine = engine();
        engine.set_settings(settings);
        let _ = engine.feed(&report(0, [0; 4]), 0, &[], Output::default());
        let bit = KnobMap::default().0[1];
        let commands = engine.feed(
            &report(bit, [0; 4]),
            10,
            &[session("a", "Spotify.exe", 50, false)],
            Output::default(),
        );
        assert_eq!(
            commands,
            vec![Command::Action {
                id: "custom:obs".into()
            }]
        );
    }

    #[test]
    fn the_idle_page_replaces_the_chosen_one_until_it_is_cleared() {
        let mut engine = Engine::new(Settings::default(), KnobMap::default());
        let idle = Idle {
            clock: "12:30".into(),
            rows: vec![crate::screen::IdleRow {
                label: "CPU".into(),
                value: "12%".into(),
                percent: Some(12),
            }],
        };
        assert!(engine.set_idle(Some(idle.clone())));
        assert!(!engine.set_idle(Some(idle)));
        assert!(engine.screen(&[], Output::default(), &[]).idle.is_some());
        assert!(engine.set_idle(None));
        assert!(engine.screen(&[], Output::default(), &[]).idle.is_none());
    }

    #[test]
    fn a_knob_press_toggles_mute_of_everything_it_follows() {
        let mut engine = engine();
        let sessions = [
            session("a", "Spotify.exe", 50, true),
            session("b", "vlc.exe", 50, false),
        ];
        let bit = KnobMap::default().0[1];
        let commands = engine.feed(&report(bit, [0; 4]), 10, &sessions, Output::default());
        assert_eq!(
            commands,
            vec![
                Command::SetMuted {
                    id: "a".into(),
                    muted: true
                },
                Command::SetMuted {
                    id: "b".into(),
                    muted: true
                }
            ]
        );
    }

    #[test]
    fn games_come_from_the_desktop_detection_and_disabled_does_nothing() {
        let mut engine = engine();
        engine.set_games(["eldenring".to_owned()]);
        let sessions = [session("g", "eldenring.exe", 80, false)];
        let commands = engine.feed(
            &report(0, [0, 0, DETENT_COUNTS as i16, 0]),
            1_000,
            &sessions,
            Output::default(),
        );
        assert_eq!(
            commands,
            vec![Command::SetVolume {
                id: "g".into(),
                volume: 82
            }]
        );

        let mut knobs = Settings::default().knobs;
        knobs[2] = Target::Category {
            category: Category::Games,
        };
        engine.set_settings(Settings {
            enabled: false,
            knobs,
            ..Default::default()
        });
        let commands = engine.feed(
            &report(BUTTON_BITS[0], [0, 0, 2 * DETENT_COUNTS as i16, 0]),
            2_000,
            &sessions,
            Output::default(),
        );
        assert!(commands.is_empty());
    }

    #[test]
    fn the_desktop_game_keys_match_however_they_are_written() {
        let mut engine = engine();
        // As the desktop's game detection writes them: `.exe` kept, any case.
        engine.set_games([r"C:\Games\EldenRing.exe".to_owned(), " ".to_owned()]);
        let sessions = [session("g", "eldenring.exe", 80, false)];
        let commands = engine.feed(
            &report(0, [0, 0, DETENT_COUNTS as i16, 0]),
            1_000,
            &sessions,
            Output::default(),
        );
        assert_eq!(
            commands,
            vec![Command::SetVolume {
                id: "g".into(),
                volume: 82
            }]
        );
    }
}
