//! Which game is running on this computer, the way Discord tells: by looking at
//! the list of running programs and matching it against games it knows. Mirrors
//! `desktop/src/main/game-detect.ts`; the list is read with `sysinfo` rather than
//! `tasklist`/`ps`/`/proc`, down to the same bare lowercased names.
//!
//! Only the matched game ever leaves this module - its name, its program and when
//! it was first seen. The rest of the process list stays on the computer, except
//! when the settings page asks, on a press, for the names of what is running so
//! somebody can pick one to add as a game.

use crate::known_games::{KnownGame, KNOWN_GAMES};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// How often the process list is read.
pub const CHECK: Duration = Duration::from_secs(15);
/// How often a game that is still running is said again, which keeps the card
/// beside somebody's name alive (the dashboard forgets one after three minutes).
pub const REPEAT_MS: u64 = 60_000;

/// A program somebody said is a game.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomGame {
    pub executable: String,
    pub name: String,
}

/// The game running now, as it is reported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGame {
    pub key: String,
    pub name: String,
    /// When this app first saw it, as an ISO moment.
    pub started_at: String,
}

/// A program's own name, lowercased, without its folder - the dashboard's key.
pub fn program_key(path: &str) -> String {
    path.trim()
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

/// A program's names from its command line (`/proc/<pid>/cmdline` on Linux): its
/// first argument, and for a game under a compatibility layer (`wine game.exe`,
/// `wine64-preloader Z:\...\game.exe`) whichever argument ends in `.exe`.
pub fn parse_cmdline<S: AsRef<str>>(args: &[S]) -> Vec<String> {
    let args: Vec<&str> = args
        .iter()
        .map(AsRef::as_ref)
        .filter(|arg| !arg.is_empty())
        .collect();
    let mut found = Vec::new();
    let first = args.first().copied();
    if let Some(first) = first {
        found.push(program_key(first));
    }
    let exe = args
        .iter()
        .copied()
        .find(|arg| arg.trim().to_ascii_lowercase().ends_with(".exe"));
    if let Some(exe) = exe {
        if Some(exe) != first {
            found.push(program_key(exe));
        }
    }
    found.retain(|name| !name.is_empty());
    found
}

/// The game running, out of these program names, or `None`. Somebody's own
/// additions come first, so a program they named is called what they called it.
pub fn match_game<S: AsRef<str>>(
    running: &[S],
    custom: &[CustomGame],
    known: &[KnownGame],
) -> Option<(String, String)> {
    let names: std::collections::HashSet<String> = running
        .iter()
        .map(|name| program_key(name.as_ref()))
        .collect();
    for game in custom {
        let key = program_key(&game.executable);
        if names.contains(&key) {
            return Some((key, game.name.clone()));
        }
    }
    known.iter().find_map(|game| {
        let program = game.programs.iter().find(|entry| names.contains(**entry))?;
        Some(((*program).to_owned(), game.name.to_owned()))
    })
}

/// The names of every program running on this computer, from `system` (kept
/// between reads so each is cheap).
pub fn running_programs(system: &mut sysinfo::System) -> Vec<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    let linux = cfg!(target_os = "linux");
    let mut kind = ProcessRefreshKind::nothing();
    if linux {
        kind = kind.with_cmd(UpdateKind::Always);
    }
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let mut names = Vec::new();
    for process in system.processes().values() {
        if linux {
            let args: Vec<String> = process
                .cmd()
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            names.extend(parse_cmdline(&args));
        } else {
            let key = program_key(&process.name().to_string_lossy());
            if !key.is_empty() {
                names.push(key);
            }
        }
    }
    names
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, as JavaScript's `toISOString` writes it.
pub fn iso_time(millis: u64) -> String {
    let (year, month, day) = civil(millis / 86_400_000);
    let rest = millis % 86_400_000;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's days-to-civil).
pub(crate) fn civil(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + u64::from(month <= 2), month, day)
}

/// Says when a game starts, stops, and - while it runs - that it is still running.
///
/// `check` is handed each look at the process list and answers what to say, if
/// anything: `Some(Some(game))`, or `Some(None)` when none is running any more.
/// The first look says whichever it is, so the dashboard is told the truth after
/// the app restarts. A look that failed changes nothing: not being able to look
/// is not the same as nothing running.
#[derive(Debug, Default)]
pub struct GameWatcher {
    current: Option<RunningGame>,
    said: u64,
    custom: Vec<CustomGame>,
    looked: bool,
}

impl GameWatcher {
    /// The programs somebody added as games. The caller looks again at once, so a
    /// game added while it is already running is recognized the moment it is added.
    pub fn set_custom_games(&mut self, games: Vec<CustomGame>) {
        self.custom = games;
    }

    /// What is running now, as last seen.
    pub fn running(&self) -> Option<&RunningGame> {
        self.current.as_ref()
    }

    /// One look, at `now` (milliseconds since the Unix epoch).
    pub fn check<E>(
        &mut self,
        programs: Result<Vec<String>, E>,
        now: u64,
    ) -> Option<Option<RunningGame>> {
        let programs = programs.ok()?;
        let found = match_game(&programs, &self.custom, KNOWN_GAMES);
        let same = matches!((&found, &self.current), (Some((key, name)), Some(current)) if *key == current.key && *name == current.name);
        if same {
            if now.saturating_sub(self.said) >= REPEAT_MS {
                self.said = now;
                return Some(self.current.clone());
            }
            return None;
        }
        if found.is_none() && self.current.is_none() && self.looked {
            return None;
        }
        self.looked = true;
        self.current = found.map(|(key, name)| RunningGame {
            key,
            name,
            started_at: iso_time(now),
        });
        self.said = now;
        Some(self.current.clone())
    }
}
