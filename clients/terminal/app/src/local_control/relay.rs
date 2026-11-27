//! The terminal's outbound socket to its Polaris instance's remote-control relay
//! (docs/terminal-integration.md, "Remote control"; frames and pane metering in
//! `crates/polaris_relay`).
//!
//! One socket per signed-in terminal, dialled out so it works behind NAT. A
//! controller's `request` runs through the same bridge, checks and handlers as
//! a local-control request, so Settings > Scripting governs both. `attach`
//! streams a pane's PTY bytes until `detach`. The socket reconnects with
//! backoff; a handshake the instance refuses (a revoked or expired key) stops
//! it until the next sign-in calls [`PolarisRelay::restart`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ::local_control::{ControlError, ErrorCode, ErrorResponseEnvelope, RequestEnvelope};
use futures::{SinkExt as _, StreamExt as _};
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

/// Holds the relay socket's runtime; dropping it closes the socket.
pub struct PolarisRelay {
    runtime: Option<tokio::runtime::Runtime>,
}

impl Entity for PolarisRelay {
    type Event = ();
}

impl SingletonEntity for PolarisRelay {}

impl PolarisRelay {
    pub fn new(ctx: &mut ModelContext<Self>) -> Self {
        let mut relay = Self { runtime: None };
        relay.restart(ctx);
        relay
    }

    /// Closes any open socket and dials again with the stored account; stays
    /// offline when the terminal is not signed in. Sign-in and sign-out call it.
    pub fn restart(&mut self, ctx: &mut ModelContext<Self>) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
        let Some(account) = crate::polaris_account::stored(ctx) else {
            return;
        };
        let Some(url) = crate::polaris_account::relay_url(&account.origin) else {
            log::warn!("Polaris relay: the stored instance address is not http(s); not connecting");
            return;
        };
        let bridge = LocalControlBridge::handle(ctx).update(ctx, |_, ctx| ctx.spawner());
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
        runtime.spawn(run(url, account.key, hello, bridge));
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

async fn run(url: String, key: String, hello: Outgoing, bridge: ModelSpawner<LocalControlBridge>) {
    let mut retry = FIRST_RETRY;
    loop {
        let started = Instant::now();
        match session(&url, &key, &hello, &bridge).await {
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

async fn session(
    url: &str,
    key: &str,
    hello: &Outgoing,
    bridge: &ModelSpawner<LocalControlBridge>,
) -> SessionEnd {
    let headers = vec![
        ("Authorization", format!("Bearer {key}")),
        ("User-Agent", user_agent()),
    ];
    let socket = match WebSocket::connect_with_headers(url, std::iter::empty(), headers).await {
        Ok(socket) => socket,
        Err(error) => {
            if let Some(response) = websocket::connect_error_http_response(&error) {
                let status = response.status().as_u16();
                if matches!(status, 401 | 403) {
                    return SessionEnd::Refused(status);
                }
            }
            return SessionEnd::Dropped(error);
        }
    };
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
