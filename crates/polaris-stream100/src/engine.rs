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
use crate::report::{Decoder, Event, KnobMap, Report};
use crate::settings::Settings;
use serde::Serialize;
use std::collections::HashSet;

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

#[derive(Debug)]
pub struct Engine {
    settings: Settings,
    decoder: Decoder,
    encoders: [Encoder; 4],
    games: HashSet<String>,
}

impl Engine {
    pub fn new(settings: Settings, knobs: KnobMap) -> Self {
        Self {
            settings,
            decoder: Decoder::new(knobs),
            encoders: Default::default(),
            games: HashSet::new(),
        }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// New settings apply from the next report; what was turned under the old
    /// ones is dropped rather than applied to a knob's new target.
    pub fn set_settings(&mut self, settings: Settings) {
        self.settings = settings;
        self.encoders.iter_mut().for_each(Encoder::discard);
    }

    /// The running programs the desktop's game detection recognises, by
    /// program key (`program_key`), for the Games category.
    pub fn set_games(&mut self, keys: impl IntoIterator<Item = String>) {
        self.games = keys.into_iter().collect();
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
                } => self.press(usize::from(knob), sessions, output, &mut commands),
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
            &report(0, [0, 50, 0, 0]),
            1_050,
            &sessions,
            Output::default(),
        );
        assert!(commands.is_empty(), "{commands:?}");
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
}
