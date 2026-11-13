//! Waiting on the TV: the port is polled while debugging is off, a prompt
//! nobody answered comes back on its own, and the wait ends on a connection, a
//! cancel, the deadline, or a failure waiting cannot fix - never on a "retry" press.

use std::time::Duration;

use polaris_client::tv_wait::*;

#[derive(Clone, Copy)]
enum Tick {
    Port(PortState),
    Open(&'static str),
}

use PortState::{Open, Refused, Silent};
use Tick::Port;

struct Script {
    ticks: Vec<Tick>,
    at: usize,
    clock: Duration,
    steps: Vec<TvWaitStep>,
    attempts: usize,
    polls: usize,
    cancel_after_polls: Option<usize>,
    cancel_on_connect: bool,
    stopped: bool,
}

impl Script {
    fn new(ticks: Vec<Tick>) -> Self {
        Self {
            ticks,
            at: 0,
            clock: Duration::ZERO,
            steps: Vec::new(),
            attempts: 0,
            polls: 0,
            cancel_after_polls: None,
            cancel_on_connect: false,
            stopped: false,
        }
    }

    fn current(&self) -> Tick {
        self.ticks[(self.at.max(1) - 1).min(self.ticks.len() - 1)]
    }

    async fn run(&mut self, timeout: Duration) -> TvWaitResult<&'static str> {
        wait_for_tv(self, Duration::from_secs(2), timeout).await
    }
}

impl TvWaitHooks for Script {
    type Connection = &'static str;
    type Error = &'static str;

    async fn probe(&mut self) -> PortState {
        self.at += 1;
        self.polls += 1;
        match self.current() {
            Port(state) => state,
            Tick::Open(_) => Open,
        }
    }

    async fn connect(&mut self) -> Result<&'static str, &'static str> {
        self.attempts += 1;
        if self.cancel_on_connect {
            self.stopped = true;
            return Err("unreachable");
        }
        match self.current() {
            Tick::Open("ok") | Port(_) => Ok("connection"),
            Tick::Open(failure) => Err(failure),
        }
    }

    fn classify(&self, error: &&'static str) -> String {
        error.to_string()
    }

    fn on_step(&mut self, step: TvWaitStep) {
        self.steps.push(step);
    }

    fn cancelled(&self) -> bool {
        self.stopped
            || self
                .cancel_after_polls
                .is_some_and(|polls| self.polls >= polls)
    }

    async fn sleep(&mut self, duration: Duration) {
        self.clock += duration;
    }

    fn now(&self) -> Duration {
        self.clock
    }
}

const MINUTE: Duration = Duration::from_secs(60);

#[tokio::test]
async fn connects_at_once_when_debugging_is_already_on_with_no_instruction() {
    let mut wait = Script::new(vec![Port(Open)]);
    assert_eq!(
        wait.run(MINUTE).await,
        TvWaitResult::Connected("connection")
    );
    assert!(wait.steps.is_empty());
}

#[tokio::test]
async fn shows_the_debugging_instruction_once_and_polls_until_the_port_opens() {
    let mut wait = Script::new(vec![Port(Refused), Port(Refused), Port(Silent), Port(Open)]);
    assert_eq!(
        wait.run(MINUTE).await,
        TvWaitResult::Connected("connection")
    );
    assert_eq!(wait.steps, vec![TvWaitStep::Debugging]);
    assert_eq!(wait.clock, Duration::from_secs(6));
}

#[tokio::test]
async fn asks_again_for_the_prompt_nobody_answered_then_connects() {
    let mut wait = Script::new(vec![
        Tick::Open("not-allowed"),
        Tick::Open("not-allowed"),
        Tick::Open("ok"),
    ]);
    assert_eq!(
        wait.run(MINUTE).await,
        TvWaitResult::Connected("connection")
    );
    assert_eq!(wait.steps, vec![TvWaitStep::Prompt]);
    assert_eq!(wait.attempts, 3);
}

#[tokio::test]
async fn keeps_the_prompt_step_while_the_port_blinks_and_goes_back_to_debugging_when_it_refuses() {
    let mut wait = Script::new(vec![
        Tick::Open("not-allowed"),
        Port(Silent),
        Tick::Open("adb-off"),
        Port(Open),
    ]);
    assert_eq!(
        wait.run(MINUTE).await,
        TvWaitResult::Connected("connection")
    );
    assert_eq!(wait.steps, vec![TvWaitStep::Prompt, TvWaitStep::Debugging]);
}

#[tokio::test]
async fn stops_on_a_failure_waiting_cannot_fix() {
    let mut wait = Script::new(vec![Tick::Open("usb-busy")]);
    assert_eq!(
        wait.run(MINUTE).await,
        TvWaitResult::Failed("usb-busy".into())
    );
}

#[tokio::test]
async fn ends_at_the_deadline_saying_which_step_it_was_on() {
    let ten = Duration::from_secs(10);
    let mut wait = Script::new(vec![Port(Refused)]);
    assert_eq!(
        wait.run(ten).await,
        TvWaitResult::Timeout(TvWaitStep::Debugging)
    );
    let mut prompt = Script::new(vec![Tick::Open("not-allowed")]);
    assert_eq!(
        prompt.run(ten).await,
        TvWaitResult::Timeout(TvWaitStep::Prompt)
    );
}

#[tokio::test]
async fn stops_when_cancelled_without_another_attempt() {
    let mut wait = Script::new(vec![Port(Refused)]);
    wait.cancel_after_polls = Some(2);
    assert_eq!(wait.run(MINUTE).await, TvWaitResult::Cancelled);
    assert_eq!(wait.polls, 2);
}

#[tokio::test]
async fn ends_as_cancelled_when_a_cancel_closes_the_attempt_under_way_with_no_step_shown_for_it() {
    let mut wait = Script::new(vec![Port(Open)]);
    wait.cancel_on_connect = true;
    assert_eq!(wait.run(MINUTE).await, TvWaitResult::Cancelled);
    assert!(wait.steps.is_empty());
}

#[test]
fn reads_each_failure_as_the_step_it_leaves_the_person_at() {
    assert_eq!(step_after("not-allowed"), Some(TvWaitStep::Prompt));
    assert_eq!(step_after("adb-off"), Some(TvWaitStep::Debugging));
    assert_eq!(step_after("unreachable"), Some(TvWaitStep::Debugging));
    assert_eq!(step_after("usb-gone"), None);
}
