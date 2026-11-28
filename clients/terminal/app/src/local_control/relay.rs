//! The terminal's outbound socket to its Polaris instance's remote-control relay
//! (docs/terminal-integration.md, "Remote control"; frames and pane metering in
//! `crates/polaris_relay`).
//!
//! One socket per signed-in terminal, dialled out so it works behind NAT. A
//! controller's `request` runs through the same bridge and handlers as a
//! local-control request, but under its own grant: read-only actions always,
//! anything that changes the terminal only while "Let Polaris control this
//! terminal" (Settings > Account) is on. Settings > Scripting and the control
//! CLI flag govern only the loopback server. `attach`
//! streams a pane's PTY bytes until `detach`. The socket reconnects with
//! backoff; a handshake the instance refuses (a revoked or expired key) stops
//! it until the next sign-in calls [`PolarisRelay::restart`].
//!
//! When the address the terminal signed in to stops answering, each dial tries
//! the instance's other addresses (`crates/polaris_instance`): an alternate is
//! sent the key only after it signs a fresh challenge with the instance's key,
//! and its certificate may chain to the instance's own local CA. The socket
//! goes back to the usual address the next time it reconnects after the hold.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ::local_control::{ControlError, ErrorCode, ErrorResponseEnvelope, RequestEnvelope};
use futures::{SinkExt as _, StreamExt as _};
use instant::Instant;
use polaris_instance::{AlternateVerdict, FailoverState, InstanceRecord};
use polaris_relay::{Incoming, Outgoing, PaneOutput, parse_incoming};
use pterm_core::channel::ChannelState;
use ptermui::{Entity, ModelContext, ModelSpawner, SingletonEntity};
use tokio::sync::mpsc;
use websocket::{Message, WebSocket, WebsocketMessage as _};

use super::LocalControlBridge;

const PING_EVERY: Duration = Duration::from_secs(30);
/// No frame at all for this long means the socket is dead even if TCP has not noticed.
const SILENCE_LIMIT: Duration = Duration::from_secs(90);
const FLUSH_EVERY: Duration = Duration::from_millis(50);
const FIRST_RETRY: Duration = Duration::from_secs(1);
const LAST_RETRY: Duration = Duration::from_secs(60);
/// A socket that stayed up this long starts the backoff over.
const STABLE_FOR: Duration = Duration::from_secs(60);

/// Which address the relay is on, for Settings > Account.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelayAddress {
    /// The alternate in use while the usual address does not answer.
    pub local: Option<String>,
    /// Alternates that answered as another Polaris and were never sent the key.
    pub refused: Vec<String>,
    /// Alternates whose certificate this computer does not trust.
    pub untrusted: Vec<String>,
}

impl RelayAddress {
    fn of(failover: &FailoverState) -> Self {
        Self {
            local: failover.is_local().then(|| failover.current().to_owned()),
            refused: failover.refused().map(str::to_owned).collect(),
            untrusted: failover.untrusted().map(str::to_owned).collect(),
        }
    }
}

/// Holds the relay socket's runtime; dropping it closes the socket.
pub struct PolarisRelay {
    runtime: Option<tokio::runtime::Runtime>,
    address: RelayAddress,
}

impl Entity for PolarisRelay {
    type Event = ();
}

impl SingletonEntity for PolarisRelay {}

impl PolarisRelay {
    pub fn new(ctx: &mut ModelContext<Self>) -> Self {
        let mut relay = Self {
            runtime: None,
            address: RelayAddress::default(),
        };
        relay.restart(ctx);
        relay
    }

    /// The address the relay is on, as last dialled.
    pub fn address(&self) -> &RelayAddress {
        &self.address
    }

    fn set_address(&mut self, address: RelayAddress, ctx: &mut ModelContext<Self>) {
        if self.address != address {
            self.address = address;
            ctx.emit(());
            ctx.notify();
        }
    }

    /// Closes any open socket and dials again with the stored account; stays
    /// offline when the terminal is not signed in. Sign-in and sign-out call it.
    pub fn restart(&mut self, ctx: &mut ModelContext<Self>) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
        self.set_address(RelayAddress::default(), ctx);
        let Some(account) = crate::polaris_account::stored(ctx) else {
            return;
        };
        if crate::polaris_account::relay_url(&account.origin).is_none() {
            log::warn!("Polaris relay: the stored instance address is not http(s); not connecting");
            return;
        }
        let failover = FailoverState::new(&account.origin, account.instance.clone());
        let bridge = LocalControlBridge::handle(ctx).update(ctx, |_, ctx| ctx.spawner());
        let me = ctx.spawner();
        let hello = Outgoing::Hello {
            name: gethostname::gethostname().into_string().ok(),
            os: Some(std::env::consts::OS.to_owned()),
            version: ChannelState::app_version().map(str::to_owned),
        };
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("polaris-relay")
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                log::warn!("Polaris relay: could not start its runtime: {error}");
                return;
            }
        };
        runtime.spawn(run(failover, account.key, hello, bridge, me));
        self.runtime = Some(runtime);
    }
}

impl Drop for PolarisRelay {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

/// The User-Agent the instance shows on its terminal list and approval screen.
pub(crate) fn user_agent() -> String {
    format!(
        "polaris-terminal/{} ({}; {})",
        ChannelState::app_version().unwrap_or("dev"),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

enum SessionEnd {
    /// The socket closed or failed; dial again.
    Dropped(anyhow::Error),
    /// The instance refused the key; wait for a new sign-in.
    Refused(u16),
}

async fn run(
    mut failover: FailoverState,
    key: String,
    hello: Outgoing,
    bridge: ModelSpawner<LocalControlBridge>,
    me: ModelSpawner<PolarisRelay>,
) {
    let mut retry = FIRST_RETRY;
    loop {
        let started = Instant::now();
        let dialled = dial(&mut failover, &key).await;
        let address = RelayAddress::of(&failover);
        let _ = me
            .spawn(move |relay, ctx| relay.set_address(address, ctx))
            .await;
        let end = match dialled {
            Ok(socket) => session(socket, &hello, &bridge).await,
            Err(end) => end,
        };
        match end {
            SessionEnd::Refused(status) => {
                log::warn!(
                    "Polaris relay: the instance refused this terminal's key ({status}); sign in again to reconnect"
                );
                return;
            }
            SessionEnd::Dropped(error) => {
                log::info!("Polaris relay: socket closed: {error:#}");
            }
        }
        if started.elapsed() >= STABLE_FOR {
            retry = FIRST_RETRY;
        }
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(LAST_RETRY);
    }
}

/// Milliseconds on a monotonic clock, for the failover's hold and verification windows.
fn now_ms() -> u64 {
    static START: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);
    u64::try_from(START.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Opens the socket on the first address that answers: the one held, the usual
/// one, then each alternate that proves it is this instance. A real answer (a
/// refused key included) ends the walk; no answer or a gateway status moves on.
async fn dial(failover: &mut FailoverState, key: &str) -> Result<WebSocket, SessionEnd> {
    let mut last = anyhow::anyhow!("no address to dial");
    for origin in failover.order(now_ms()) {
        let Some(url) = crate::polaris_account::relay_url(&origin) else {
            continue;
        };
        let tls = if origin == failover.primary() {
            None
        } else {
            let Some(record) = failover.instance().cloned() else {
                continue;
            };
            let config = match polaris_instance::local_ca_client_config(&record.local_ca_sha256) {
                Ok(config) => Arc::new(config),
                Err(error) => {
                    log::warn!("Polaris relay: no TLS configuration for {origin}: {error}");
                    continue;
                }
            };
            if !failover.is_verified(&origin, now_ms()) {
                let verdict = challenge(&record, &origin, &config).await;
                failover.record_verdict(&origin, verdict, now_ms());
                if verdict != AlternateVerdict::Same {
                    continue;
                }
            }
            Some(config)
        };
        let headers = vec![
            ("Authorization", format!("Bearer {key}")),
            ("User-Agent", user_agent()),
        ];
        let connected = match tls.clone() {
            None => WebSocket::connect_with_headers(&url, std::iter::empty(), headers).await,
            Some(config) => {
                WebSocket::connect_with_headers_and_tls_config(&url, headers, config).await
            }
        };
        let error = match connected {
            Ok(socket) => {
                failover.settle(&origin, now_ms());
                return Ok(socket);
            }
            Err(error) => error,
        };
        if let Some(status) = websocket::connect_error_http_response(&error)
            .map(|response| response.status().as_u16())
        {
            if matches!(status, 401 | 403) {
                return Err(SessionEnd::Refused(status));
            }
            if !polaris_instance::is_gateway_failure(status) {
                failover.settle(&origin, now_ms());
                return Err(SessionEnd::Dropped(error));
            }
        } else if tls.is_some() && polaris_instance::is_certificate_failure(&*error) {
            failover.record_verdict(
                &origin,
                AlternateVerdict::Unreachable { certificate: true },
                now_ms(),
            );
        }
        failover.record_failure(&origin);
        last = error;
    }
    Err(SessionEnd::Dropped(last))
}

/// Asks `origin` to sign a fresh nonce (`POST /api/instance/challenge`). No
/// credential goes with it.
async fn challenge(
    record: &InstanceRecord,
    origin: &str,
    config: &Arc<rustls::ClientConfig>,
) -> AlternateVerdict {
    let builder = reqwest::Client::builder()
        .tls_backend_preconfigured(rustls::ClientConfig::clone(config))
        .no_proxy();
    let Ok(client) = http_client::Client::from_client_builder(builder) else {
        return AlternateVerdict::Unreachable { certificate: false };
    };
    let nonce = polaris_instance::fresh_nonce();
    let response = client
        .post(format!("{origin}{}", polaris_instance::CHALLENGE_PATH))
        .header("user-agent", user_agent())
        .json(&polaris_instance::challenge_body(&nonce))
        .timeout(Duration::from_millis(polaris_instance::DEFAULT_TIMEOUT_MS))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return AlternateVerdict::Unreachable {
                certificate: polaris_instance::is_certificate_failure(&error),
            };
        }
    };
    let status = response.status().as_u16();
    let body = response.json::<serde_json::Value>().await.ok();
    polaris_instance::judge_challenge(record, origin, &nonce, status, body.as_ref())
}

async fn session(
    socket: WebSocket,
    hello: &Outgoing,
    bridge: &ModelSpawner<LocalControlBridge>,
) -> SessionEnd {
    let (mut sink, mut stream) = socket.split().await;
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outgoing>();
    let (bytes_tx, mut bytes_rx) = mpsc::unbounded_channel::<(String, Arc<Vec<u8>>)>();
    let mut forwarders: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
    let mut panes = PaneOutput::new();
    let clock = Instant::now();
    let mut last_heard = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut flush = tokio::time::interval(FLUSH_EVERY);

    let end = 'socket: {
        if let Err(error) = send(&mut sink, hello).await {
            break 'socket SessionEnd::Dropped(error);
        }
        loop {
            tokio::select! {
                message = stream.next() => {
                    let message = match message {
                        Some(Ok(message)) => message,
                        Some(Err(error)) => break 'socket SessionEnd::Dropped(error.into()),
                        None => break 'socket SessionEnd::Dropped(anyhow::anyhow!("closed by the instance")),
                    };
                    last_heard = Instant::now();
                    let Some(frame) = message.text().and_then(parse_incoming) else {
                        continue;
                    };
                    match frame {
                        Incoming::Ready { instance } => {
                            log::info!("Polaris relay: connected as terminal {instance}");
                        }
                        Incoming::Request { id, envelope } => {
                            let bridge = bridge.clone();
                            let out_tx = out_tx.clone();
                            tokio::spawn(async move {
                                let envelope = dispatch(&bridge, envelope).await;
                                let _ = out_tx.send(Outgoing::Response { id, envelope });
                            });
                        }
                        Incoming::Attach { pane } => {
                            attach(&pane, bridge, &mut panes, &mut forwarders, &bytes_tx, clock).await;
                        }
                        Incoming::Detach { pane } => {
                            panes.detach(&pane);
                            if let Some(forwarder) = forwarders.remove(&pane) {
                                forwarder.abort();
                            }
                        }
                        Incoming::Pong | Incoming::Unknown => {}
                    }
                }
                Some((pane, bytes)) = bytes_rx.recv() => panes.push(&pane, &bytes),
                Some(frame) = out_rx.recv() => {
                    if let Err(error) = send(&mut sink, &frame).await {
                        break 'socket SessionEnd::Dropped(error);
                    }
                }
                _ = flush.tick(), if panes.has_pending() => {
                    for frame in panes.drain(clock.elapsed()) {
                        if let Err(error) = send(&mut sink, &frame).await {
                            break 'socket SessionEnd::Dropped(error);
                        }
                    }
                }
                _ = ping.tick() => {
                    if last_heard.elapsed() >= SILENCE_LIMIT {
                        break 'socket SessionEnd::Dropped(anyhow::anyhow!("no frame from the instance in {SILENCE_LIMIT:?}"));
                    }
                    if let Err(error) = send(&mut sink, &Outgoing::Ping).await {
                        break 'socket SessionEnd::Dropped(error);
                    }
                }
            }
        }
    };
    for forwarder in forwarders.into_values() {
        forwarder.abort();
    }
    end
}

/// Starts streaming a pane: its current screen first, then every PTY read.
async fn attach(
    pane: &str,
    bridge: &ModelSpawner<LocalControlBridge>,
    panes: &mut PaneOutput,
    forwarders: &mut HashMap<String, tokio::task::JoinHandle<()>>,
    bytes_tx: &mpsc::UnboundedSender<(String, Arc<Vec<u8>>)>,
    clock: Instant,
) {
    let owned = pane.to_owned();
    let Ok(Some((screen, mut reads))) = bridge
        .spawn(move |bridge, ctx| bridge.relay_attach(&owned, ctx))
        .await
    else {
        log::info!("Polaris relay: pane {pane} cannot be watched here");
        return;
    };
    if panes
        .attach(pane, screen.as_bytes(), clock.elapsed())
        .is_err()
    {
        log::info!("Polaris relay: too many panes watched at once; not attaching {pane}");
        return;
    }
    let pane_id = pane.to_owned();
    let bytes_tx = bytes_tx.clone();
    let forwarder = tokio::spawn(async move {
        loop {
            match reads.recv().await {
                Ok(bytes) => {
                    if bytes_tx.send((pane_id.clone(), bytes)).is_err() {
                        return;
                    }
                }
                // Fell behind the PTY: skip what was missed and keep streaming.
                Err(async_broadcast::RecvError::Overflowed(_)) => {}
                Err(async_broadcast::RecvError::Closed) => return,
            }
        }
    });
    if let Some(previous) = forwarders.insert(pane.to_owned(), forwarder) {
        previous.abort();
    }
}

/// Runs one controller request through the local-control bridge.
async fn dispatch(
    bridge: &ModelSpawner<LocalControlBridge>,
    envelope: serde_json::Value,
) -> serde_json::Value {
    let request = match serde_json::from_value::<RequestEnvelope>(envelope) {
        Ok(request) => request,
        Err(error) => {
            return to_value(&ErrorResponseEnvelope::new(ControlError::with_details(
                ErrorCode::InvalidRequest,
                "failed to decode local-control request",
                error.to_string(),
            )));
        }
    };
    match bridge
        .spawn(move |bridge, ctx| bridge.handle_relay_request(request, ctx))
        .await
    {
        Ok(response) => to_value(&response),
        Err(_) => to_value(&ErrorResponseEnvelope::new(ControlError::new(
            ErrorCode::BridgeUnavailable,
            "local-control app bridge is unavailable",
        ))),
    }
}

fn to_value(value: &impl serde::Serialize) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

async fn send(sink: &mut impl websocket::Sink, frame: &Outgoing) -> anyhow::Result<()> {
    let text = serde_json::to_string(frame)?;
    sink.send(Message::new_text(text)).await?;
    Ok(())
}
