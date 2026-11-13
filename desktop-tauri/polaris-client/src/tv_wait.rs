//! Waiting for the TV instead of asking the person to retry: while debugging is
//! off the port is polled, and when it opens the connection is tried; a prompt
//! nobody answered, or one answered No, shows again on the next attempt. The
//! person reads one instruction and acts on the TV; this notices on its own.
//!
//! The Rust twin of `desktop/src/main/tv-wait.ts`.

use std::future::Future;
use std::time::Duration;

/// What the person is being asked to do while this waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvWaitStep {
    Debugging,
    Prompt,
}

/// Whether the debugging port answers now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortState {
    Open,
    Refused,
    Silent,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TvWaitResult<T> {
    Connected(T),
    Cancelled,
    Timeout(TvWaitStep),
    /// How the attempt failed, as `classify` named it.
    Failed(String),
}

/// What waiting needs from the installer; a fake one drives it in tests.
pub trait TvWaitHooks {
    type Connection;
    type Error;
    fn probe(&mut self) -> impl Future<Output = PortState>;
    /// One connection attempt; fails with what `classify` reads.
    fn connect(&mut self) -> impl Future<Output = Result<Self::Connection, Self::Error>>;
    /// The failure's name: "adb-off", "unreachable", "not-allowed", or another outcome.
    fn classify(&self, error: &Self::Error) -> String;
    fn on_step(&mut self, step: TvWaitStep);
    fn cancelled(&self) -> bool;
    fn sleep(&mut self, duration: Duration) -> impl Future<Output = ()>;
    /// Time since any fixed point.
    fn now(&self) -> Duration;
}

/// The step a failed attempt leaves the person at, or None when waiting cannot help.
pub fn step_after(failure: &str) -> Option<TvWaitStep> {
    match failure {
        "not-allowed" => Some(TvWaitStep::Prompt),
        "adb-off" | "unreachable" => Some(TvWaitStep::Debugging),
        _ => None,
    }
}

/// Polls and connects until the TV lets this computer in, it is cancelled, or time runs out.
pub async fn wait_for_tv<H: TvWaitHooks>(
    hooks: &mut H,
    interval: Duration,
    timeout: Duration,
) -> TvWaitResult<H::Connection> {
    let deadline = hooks.now() + timeout;
    let mut step: Option<TvWaitStep> = None;
    let show = |hooks: &mut H, step: &mut Option<TvWaitStep>, next: TvWaitStep| {
        if *step != Some(next) {
            *step = Some(next);
            hooks.on_step(next);
        }
    };
    let mut first = true;
    loop {
        if hooks.cancelled() {
            return TvWaitResult::Cancelled;
        }
        if hooks.now() >= deadline {
            return TvWaitResult::Timeout(step.unwrap_or(TvWaitStep::Debugging));
        }
        if !first {
            hooks.sleep(interval).await;
        }
        first = false;
        if hooks.cancelled() {
            return TvWaitResult::Cancelled;
        }
        if hooks.probe().await != PortState::Open {
            // A prompt already shown stays the instruction until the port really closes.
            let next = if step == Some(TvWaitStep::Prompt) {
                TvWaitStep::Prompt
            } else {
                TvWaitStep::Debugging
            };
            show(hooks, &mut step, next);
            continue;
        }
        match hooks.connect().await {
            Ok(connection) => return TvWaitResult::Connected(connection),
            Err(error) => {
                // A cancel closes the attempt under way; that is not the TV failing.
                if hooks.cancelled() {
                    return TvWaitResult::Cancelled;
                }
                let failure = hooks.classify(&error);
                match step_after(&failure) {
                    Some(next) => show(hooks, &mut step, next),
                    None => return TvWaitResult::Failed(failure),
                }
            }
        }
    }
}
