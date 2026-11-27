//! Signing this terminal in to a Polaris instance (docs/terminal-integration.md,
//! "Auth and sign-in").
//!
//! The device-authorization grant (RFC 8628), the same one `plr login` uses:
//! the terminal checks the address with `GET /api/instance`, opens a request at
//! `POST /api/terminal/authorize`, asks a running Polaris Desktop to approve it
//! (falling back to the approval page in the browser), and polls
//! `POST /api/terminal/authorize/claim` until the key is handed over. The key
//! and the address go to the OS keychain through [`crate::polaris_account`],
//! and the relay socket restarts with them. Signing out deletes the key on the
//! instance (`DELETE /api/terminal/session`) before forgetting it here.

mod desktop;

use std::time::Duration;

use ptermui::r#async::Timer;
use ptermui::{AppContext, Entity, ModelContext, SingletonEntity};
use serde::{Deserialize, Serialize};

use crate::polaris_account::{self, PolarisAccount};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// The poll interval when the instance does not say, and the floor for one it does.
const DEFAULT_POLL: Duration = Duration::from_secs(2);
const LONGEST_POLL: Duration = Duration::from_secs(30);
/// Consecutive failed polls (network, server errors) before giving up.
const POLL_FAILURES_ALLOWED: u32 = 10;

/// Where a sign-in stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignInState {
    /// Nothing in progress.
    Idle,
    /// Checking the address and opening the request.
    Checking,
    /// The request is open; somebody has to approve `user_code`.
    Waiting {
        user_code: String,
        /// Where the approval page is, for the button that opens it again.
        approve_url: String,
    },
    /// The last attempt ended without a key, with the reason to show.
    Failed(String),
}

pub enum PolarisSignInEvent {
    Changed,
}

/// The sign-in flow and the account it ends in.
pub struct PolarisSignIn {
    state: SignInState,
    /// Bumped by every start, cancel and sign-out, so a late answer from an
    /// abandoned attempt is ignored.
    attempt: u64,
}

impl Entity for PolarisSignIn {
    type Event = PolarisSignInEvent;
}

impl SingletonEntity for PolarisSignIn {}

/// An open request, as the claim poll needs it.
struct Pending {
    attempt: u64,
    origin: String,
    device_code: String,
    poll: Duration,
    failures: u32,
}

impl PolarisSignIn {
    pub fn new(_ctx: &mut ModelContext<Self>) -> Self {
        Self {
            state: SignInState::Idle,
            attempt: 0,
        }
    }

    pub fn state(&self) -> &SignInState {
        &self.state
    }

    /// The account this terminal is signed in to, if any.
    pub fn account(ctx: &AppContext) -> Option<PolarisAccount> {
        polaris_account::stored(ctx)
    }

    fn set_state(&mut self, state: SignInState, ctx: &mut ModelContext<Self>) {
        self.state = state;
        ctx.emit(PolarisSignInEvent::Changed);
        ctx.notify();
    }

    /// Starts a sign-in to the Polaris at `address`, as the person typed it.
    pub fn sign_in(&mut self, address: &str, ctx: &mut ModelContext<Self>) {
        let origin = match normalize_address(address) {
            Ok(origin) => origin,
            Err(reason) => {
                self.set_state(SignInState::Failed(reason.to_owned()), ctx);
                return;
            }
        };
        self.attempt += 1;
        let attempt = self.attempt;
        self.set_state(SignInState::Checking, ctx);
        let asked = origin.clone();
        ctx.spawn(open_request(asked), move |me, opened, ctx| {
            if me.attempt != attempt {
                return;
            }
            let opened = match opened {
                Ok(opened) => opened,
                Err(reason) => {
                    me.set_state(SignInState::Failed(reason), ctx);
                    return;
                }
            };
            let Some(approve_url) = approve_url(&origin, &opened.approve_path) else {
                me.set_state(
                    SignInState::Failed(
                        "This Polaris answered with an approval page that is not its own."
                            .to_owned(),
                    ),
                    ctx,
                );
                return;
            };
            me.set_state(
                SignInState::Waiting {
                    user_code: opened.user_code.clone(),
                    approve_url: approve_url.clone(),
                },
                ctx,
            );
            me.ask_desktop(attempt, origin.clone(), opened.user_code, approve_url, ctx);
            me.poll(
                Pending {
                    attempt,
                    origin,
                    device_code: opened.device_code,
                    poll: poll_interval(opened.poll_ms),
                    failures: 0,
                },
                ctx,
            );
        });
    }

    /// Asks a running Polaris Desktop to approve the request in its own dialog;
    /// opens the approval page in the browser when there is no Desktop, it is
    /// on another Polaris, or it did not approve.
    fn ask_desktop(
        &mut self,
        attempt: u64,
        origin: String,
        user_code: String,
        approve_url: String,
        ctx: &mut ModelContext<Self>,
    ) {
        ctx.spawn(
            blocking::unblock(move || desktop::ask(&origin, &user_code)),
            move |me, approved, ctx| {
                if me.attempt != attempt || approved {
                    return;
                }
                if matches!(me.state, SignInState::Waiting { .. }) {
                    ctx.open_url(&approve_url);
                }
            },
        );
    }

    fn poll(&mut self, pending: Pending, ctx: &mut ModelContext<Self>) {
        let origin = pending.origin.clone();
        let device_code = pending.device_code.clone();
        let wait = pending.poll;
        ctx.spawn(
            async move {
                Timer::after(wait).await;
                claim(&origin, &device_code).await
            },
            move |me, claimed, ctx| {
                if me.attempt != pending.attempt {
                    return;
                }
                match claimed {
                    Claimed::Pending => me.poll(
                        Pending {
                            failures: 0,
                            ..pending
                        },
                        ctx,
                    ),
                    Claimed::SlowDown => me.poll(
                        Pending {
                            poll: (pending.poll * 2).min(LONGEST_POLL),
                            ..pending
                        },
                        ctx,
                    ),
                    Claimed::Failed if pending.failures + 1 < POLL_FAILURES_ALLOWED => me.poll(
                        Pending {
                            failures: pending.failures + 1,
                            ..pending
                        },
                        ctx,
                    ),
                    Claimed::Failed => me.set_state(
                        SignInState::Failed(format!(
                            "Lost touch with {} while waiting for the approval. Sign in again.",
                            pending.origin
                        )),
                        ctx,
                    ),
                    Claimed::Denied => me.set_state(
                        SignInState::Failed("The sign-in was declined.".to_owned()),
                        ctx,
                    ),
                    Claimed::Expired => me.set_state(
                        SignInState::Failed(
                            "The code expired before it was approved. Sign in again.".to_owned(),
                        ),
                        ctx,
                    ),
                    Claimed::Approved(key) => {
                        me.attempt += 1;
                        let account = PolarisAccount {
                            origin: pending.origin,
                            key,
                        };
                        if let Err(error) = polaris_account::store(&account, ctx) {
                            log::warn!("Could not save the Polaris account: {error:#}");
                            me.set_state(
                                SignInState::Failed(
                                    "Signed in, but this computer's keychain refused to keep the key. Unlock the keychain and sign in again."
                                        .to_owned(),
                                ),
                                ctx,
                            );
                            return;
                        }
                        restart_relay(ctx);
                        me.set_state(SignInState::Idle, ctx);
                    }
                }
            },
        );
    }

    /// Abandons a sign-in in progress.
    pub fn cancel(&mut self, ctx: &mut ModelContext<Self>) {
        self.attempt += 1;
        self.set_state(SignInState::Idle, ctx);
    }

    /// Deletes this terminal's key on the instance, forgets it here and closes
    /// the relay. Forgetting does not wait for the instance: a key the
    /// instance could not be told about stays listed under its Sessions, where
    /// it can be revoked.
    pub fn sign_out(&mut self, ctx: &mut ModelContext<Self>) {
        self.attempt += 1;
        if let Some(account) = polaris_account::stored(ctx) {
            ctx.spawn(end_session(account), |_, _, _| {});
        }
        polaris_account::clear(ctx);
        restart_relay(ctx);
        self.set_state(SignInState::Idle, ctx);
    }
}

/// Reconnects the relay with the account as it now stands. The relay exists
/// only where local control does (Settings > Scripting).
fn restart_relay(ctx: &mut ModelContext<PolarisSignIn>) {
    if crate::features::FeatureFlag::PtermControlCli.is_enabled() {
        crate::local_control::PolarisRelay::handle(ctx)
            .update(ctx, |relay, ctx| relay.restart(ctx));
    }
}

/// The origin of the Polaris the person typed: `polaris.example.com`,
/// `https://polaris.example.com/home` and `http://192.168.1.10:3000` are all
/// accepted, and reduce to `scheme://host[:port]`. No scheme means https.
fn normalize_address(address: &str) -> Result<String, &'static str> {
    let address = address.trim();
    if address.is_empty() {
        return Err("Type the address of your Polaris.");
    }
    let with_scheme = if address.contains("://") {
        address.to_owned()
    } else {
        format!("https://{address}")
    };
    let url = url::Url::parse(&with_scheme)
        .map_err(|_| "That is not a web address. It looks like polaris.example.com.")?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("The address has to start with https:// or http://.");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the address.");
    }
    Ok(url.origin().ascii_serialization())
}

/// The approval page on the same instance, refusing anything that would leave it.
fn approve_url(origin: &str, path: &str) -> Option<String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return None;
    }
    let url = url::Url::parse(origin).ok()?.join(path).ok()?;
    (url.origin().ascii_serialization() == origin).then(|| url.to_string())
}

fn poll_interval(poll_ms: Option<u64>) -> Duration {
    poll_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_POLL)
        .clamp(DEFAULT_POLL, LONGEST_POLL)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizeBody {
    device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    user_code: String,
    device_code: String,
    poll_ms: Option<u64>,
    approve_path: String,
}

#[derive(Deserialize)]
struct Refusal {
    error: Option<String>,
}

#[derive(Deserialize)]
struct InstanceIdentity {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimBody<'a> {
    device_code: &'a str,
}

#[derive(Deserialize)]
struct ClaimAnswer {
    status: String,
    token: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum Claimed {
    Pending,
    SlowDown,
    Denied,
    Expired,
    Approved(String),
    Failed,
}

fn user_agent() -> String {
    crate::local_control::user_agent()
}

/// The release, in the form the instance accepts (`[0-9A-Za-z._+-]`, at most 40).
fn client_version() -> Option<String> {
    pterm_core::channel::ChannelState::app_version()
        .filter(|version| {
            version.len() <= 40
                && version
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
        })
        .map(str::to_owned)
}

/// The computer's name for the approval screen, within the instance's limit.
fn device_name() -> String {
    let name = gethostname::gethostname()
        .into_string()
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect::<String>();
    if name.is_empty() {
        "Polaris Terminal".to_owned()
    } else {
        name
    }
}

async fn open_request(origin: String) -> Result<Opened, String> {
    let client = http_client::Client::new();
    let unreachable = || {
        format!("Could not reach {origin}. Check the address and that this computer can open it.")
    };
    let instance = client
        .get(format!("{origin}/api/instance"))
        .header("user-agent", user_agent())
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| unreachable())?;
    let not_polaris = || format!("{origin} is not a Polaris. Check the address.");
    if !instance.status().is_success() {
        return Err(not_polaris());
    }
    let identity: InstanceIdentity = instance.json().await.map_err(|_| not_polaris())?;
    if identity.id.trim().is_empty() {
        return Err(not_polaris());
    }

    let response = client
        .post(format!("{origin}/api/terminal/authorize"))
        .header("user-agent", user_agent())
        .json(&AuthorizeBody {
            device_name: device_name(),
            client_version: client_version(),
        })
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| unreachable())?;
    let status = response.status().as_u16();
    if status == 404 {
        return Err(
            "This Polaris cannot sign in a terminal yet. Update it from its Settings, then try again."
                .to_owned(),
        );
    }
    if !(200..300).contains(&status) {
        // The instance words its refusals for the reader; show them as they are.
        let said = response
            .json::<Refusal>()
            .await
            .ok()
            .and_then(|refusal| refusal.error)
            .filter(|error| !error.trim().is_empty());
        return Err(said.unwrap_or_else(|| {
            format!("{origin} could not open a sign-in right now. Try again in a minute.")
        }));
    }
    response
        .json::<Opened>()
        .await
        .map_err(|_| format!("{origin} answered the sign-in in a way this terminal does not understand. Update Polaris Terminal."))
}

async fn claim(origin: &str, device_code: &str) -> Claimed {
    let response = http_client::Client::new()
        .post(format!("{origin}/api/terminal/authorize/claim"))
        .header("user-agent", user_agent())
        .json(&ClaimBody { device_code })
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await;
    let Ok(response) = response else {
        return Claimed::Failed;
    };
    let status = response.status().as_u16();
    if status == 429 {
        return Claimed::SlowDown;
    }
    if !(200..300).contains(&status) {
        return Claimed::Failed;
    }
    match response.json::<ClaimAnswer>().await {
        Ok(answer) => read_claim(answer),
        Err(_) => Claimed::Failed,
    }
}

fn read_claim(answer: ClaimAnswer) -> Claimed {
    match answer.status.as_str() {
        "pending" => Claimed::Pending,
        "denied" => Claimed::Denied,
        "expired" => Claimed::Expired,
        "approved" => match answer.token.filter(|token| !token.trim().is_empty()) {
            Some(token) => Claimed::Approved(token.trim().to_owned()),
            None => Claimed::Failed,
        },
        _ => Claimed::Failed,
    }
}

async fn end_session(account: PolarisAccount) {
    let result = http_client::Client::new()
        .delete(format!("{}/api/terminal/session", account.origin))
        .header("user-agent", user_agent())
        .bearer_auth(&account.key)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() || response.status().as_u16() == 401 => {}
        Ok(response) => log::warn!(
            "Polaris did not delete this terminal's key ({}); it stays under Sessions until revoked there",
            response.status()
        ),
        Err(error) => log::warn!(
            "Could not reach Polaris to delete this terminal's key: {error}; it stays under Sessions until revoked there"
        ),
    }
}

#[cfg(test)]
#[path = "polaris_sign_in_tests.rs"]
mod tests;
