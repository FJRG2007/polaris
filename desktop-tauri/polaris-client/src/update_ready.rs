//! The update waiting for a restart, held for the pages that offer it. Pure, for
//! the tests: the shell feeds it what the update check finds and hands each change
//! to the Polaris windows, and answers the page's questions from it.
//!
//! Only an update with a way to restart into it is held - one that is installed
//! already. An update that can only be downloaded from its page is the menu's and
//! the notice's to offer, not a button that would have to open a browser.
//!
//! The page's version and this app's are independent - one app opens Polaris
//! servers of any version - so a page says it draws the button, and only then is
//! the app's own notice left out. A page that never says so, an older dashboard,
//! gets the notice and the tray as before.
//!
//! The Rust twin of `desktop/src/main/update-ready.ts` and
//! `desktop/src/shared/update-ready.ts`.

use crate::update_first::RESTART_BEFORE_OPENING;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

/// The longest version the page is told.
const VERSION_MAX: usize = 64;

/// An update that is downloaded and installed and only waits for a restart, as
/// the dashboard is told it. `None` stands for "there is none".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateReady {
    pub version: String,
}

/// `1.2.3`, optionally with a `-pre.release` suffix of `[0-9A-Za-z.-]`.
fn is_ready_version(text: &str) -> bool {
    if text.len() > VERSION_MAX {
        return false;
    }
    let (core, suffix) = match text.split_once('-') {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (text, None),
    };
    let core_ok = {
        let parts: Vec<&str> = core.split('.').collect();
        parts.len() == 3
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    };
    let suffix_ok = suffix.is_none_or(|suffix| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    });
    core_ok && suffix_ok
}

/// The state as the page may hear it: anything that is not one is no update.
pub fn read_update_ready(raw: &serde_json::Value) -> Option<UpdateReady> {
    let state = UpdateReady::deserialize(raw).ok()?;
    is_ready_version(&state.version).then_some(state)
}

/// Restarting into an installed update. An `Err` is logged, never shown.
pub type Restart = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// What the update check found.
#[derive(Clone)]
pub struct FoundUpdate {
    pub version: String,
    /// Set once the update is installed and waits for a restart.
    pub restart: Option<Restart>,
}

pub const NO_UPDATE_WAITING: &str = "There is no update waiting to be installed.";
pub const UPDATE_NOT_INSTALLED: &str =
    "The update could not be installed. Polaris installs it the next time it starts.";

type Changed = Box<dyn Fn(Option<&UpdateReady>) + Send + Sync>;

pub struct UpdateReadyState {
    ready: Option<(UpdateReady, Restart)>,
    /// Until when a restart already asked for may still end this process.
    restarting_until: Option<Instant>,
    /// The pages, by their window label, that draw the button now.
    offering: HashSet<String>,
    changed: Changed,
}

impl UpdateReadyState {
    pub fn new(changed: impl Fn(Option<&UpdateReady>) + Send + Sync + 'static) -> Self {
        Self {
            ready: None,
            restarting_until: None,
            offering: HashSet::new(),
            changed: Box::new(changed),
        }
    }

    /// What the update check found. Tells the pages only when what they show
    /// changes. A newer release that could only be downloaded from its page
    /// leaves an installed one in place: that one still opens on a restart.
    pub fn found(&mut self, update: &FoundUpdate) {
        let state = read_update_ready(&serde_json::json!({ "version": update.version }));
        let (Some(restart), Some(state)) = (update.restart.as_ref(), state) else {
            return;
        };
        if let Some((held, held_restart)) = &self.ready {
            if held.version == state.version && Arc::ptr_eq(held_restart, restart) {
                return;
            }
        }
        self.ready = Some((state, restart.clone()));
        self.restarting_until = None;
        (self.changed)(self.current());
    }

    /// A page saying it draws the button, or that it stopped.
    pub fn offer(&mut self, page: &str, on: bool) {
        if on {
            self.offering.insert(page.to_owned());
        } else {
            self.offering.remove(page);
        }
    }

    /// Whether this page draws the button: the app's notice is then not needed.
    pub fn offered_by(&self, page: Option<&str>) -> bool {
        page.is_some_and(|page| self.offering.contains(page))
    }

    /// Whether the app announces this update with a notice of its own: always for
    /// one that can only be downloaded, and for an installed one unless the page
    /// in front draws the button.
    pub fn needs_notice(&self, update: &FoundUpdate, front: Option<&str>) -> bool {
        update.restart.is_none() || !self.offered_by(front)
    }

    pub fn current(&self) -> Option<&UpdateReady> {
        self.ready.as_ref().map(|(state, _)| state)
    }

    /// Restart into the waiting update, once however often it is asked while that
    /// restart can still end this process. One that returned and left the app
    /// running, a quit somebody cancelled, can be asked for again.
    pub fn install(&mut self) -> Result<(), &'static str> {
        self.install_at(Instant::now())
    }

    /// [`Self::install`] at a given moment, for the tests.
    pub fn install_at(&mut self, now: Instant) -> Result<(), &'static str> {
        let Some((_, restart)) = &self.ready else {
            return Err(NO_UPDATE_WAITING);
        };
        if self.restarting_until.is_some_and(|until| now < until) {
            return Ok(());
        }
        self.restarting_until = Some(now + RESTART_BEFORE_OPENING);
        match restart() {
            Ok(()) => Ok(()),
            Err(error) => {
                self.restarting_until = None;
                eprintln!("polaris: update: {error}");
                Err(UPDATE_NOT_INSTALLED)
            }
        }
    }
}
