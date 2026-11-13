//! Whether a start updates before it opens. Pure, for the tests: the shell hands
//! it the first update check and the steps that touch windows and settings.
//!
//! Holding the app back has to be safe for somebody with no terminal, so every way
//! out but a working restart ends in an app that opens. A version gets one start:
//! whatever became of it, it is not tried again before opening and stays with the
//! background install and the button.
//!
//! The Rust twin of `desktop/src/main/update-first.ts`.

use std::future::Future;
use std::time::Duration;
use tokio::time::{sleep, timeout};

/// How long the first check may hold the app back once it has been asked: a slow
/// answer updates in the background instead.
pub const CHECK_BEFORE_OPENING: Duration = Duration::from_millis(1_500);
/// The most a start waits to learn how this copy updates (macOS checks its
/// signature first), so that check does not eat the time of the one above.
pub const SETTLE_BEFORE_ASKING: Duration = Duration::from_millis(5_000);
/// The most a start waits for an update before opening the version it has.
pub const UPDATE_BEFORE_OPENING: Duration = Duration::from_secs(3 * 60);
/// How long a restart has to end this process. One that returned and left it
/// running opens the app, so nobody stays on the updating window.
pub const RESTART_BEFORE_OPENING: Duration = Duration::from_secs(30);

/// What the first update check of a start comes to, each part as it settles.
pub struct FirstCheck<Asked, Installing, Installed> {
    /// Settles once this copy knows how it updates and the question goes out.
    pub asked: Asked,
    /// The newer version it began installing, `None` when it will not.
    pub installing: Installing,
    /// Whether that install finished, so the app can restart into it.
    pub installed: Installed,
}

/// The steps that touch windows and settings.
pub trait OpeningSteps {
    /// The version a start last held the app back for, if any.
    fn attempted(&mut self) -> Option<String>;
    /// Remember the version this start is holding the app back for.
    fn attempt(&mut self, version: &str) -> Result<(), String>;
    /// Whether something already opened the app while it was held back.
    fn opened(&mut self) -> bool;
    /// Show the updating window; settles when it is closed.
    fn show_updating(&mut self) -> impl Future<Output = ()>;
    /// Restart into the installed update; false when that failed.
    fn restart(&mut self) -> bool;
}

/// `Open`: the caller opens the app. `Closed`: the updating window was closed, so
/// nothing opens by itself. A restart that works never returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opening {
    Open,
    Closed,
}

pub async fn update_before_opening<A, I, D, S>(first: FirstCheck<A, I, D>, steps: &mut S) -> Opening
where
    A: Future<Output = ()>,
    I: Future<Output = Option<String>>,
    D: Future<Output = bool>,
    S: OpeningSteps,
{
    let _ = timeout(SETTLE_BEFORE_ASKING, first.asked).await;
    let version = timeout(CHECK_BEFORE_OPENING, first.installing)
        .await
        .ok()
        .flatten();
    let Some(version) = version else {
        return Opening::Open;
    };
    if steps.attempted().as_deref() == Some(version.as_str()) || steps.opened() {
        return Opening::Open;
    }
    if steps.attempt(&version).is_err() {
        return Opening::Open;
    }

    enum Outcome {
        Closed,
        Installed,
        Open,
    }
    let outcome = {
        let closed = steps.show_updating();
        // In the order the Electron app races them: a window closed at the moment
        // the install ends is a closed window.
        tokio::select! {
            biased;
            () = closed => Outcome::Closed,
            done = first.installed => if done { Outcome::Installed } else { Outcome::Open },
            () = sleep(UPDATE_BEFORE_OPENING) => Outcome::Open,
        }
    };
    match outcome {
        Outcome::Closed => Opening::Closed,
        Outcome::Open => Opening::Open,
        Outcome::Installed => {
            if steps.restart() {
                sleep(RESTART_BEFORE_OPENING).await;
            }
            Opening::Open
        }
    }
}
