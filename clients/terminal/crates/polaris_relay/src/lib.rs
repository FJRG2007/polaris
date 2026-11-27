//! Polaris Terminal's side of the Polaris remote-control relay
//! (`/api/deploy/ws/terminal?role=instance`, `dashboard/apps/web/terminal-relay.mjs`).
//!
//! The terminal keeps one outbound socket to its instance. It says `hello`
//! within 10 seconds, answers `request` frames with the dispatcher local
//! control uses, and streams a pane's output only while somebody watches it:
//! `attach` starts a pane, `detach` stops it, and `output` frames carry base64
//! of the pane's raw bytes. This crate holds the frames and the pane-output
//! state; the socket itself belongs to the app.
//!
//! The relay meters each pane at 256 KiB of frame data per second with a 1 MiB
//! burst and drops whatever goes over (the watcher then sees a gap), so the
//! terminal meters itself the same way and coalesces instead of flooding:
//! bytes that cannot be sent yet wait, newest kept, oldest dropped when even
//! the wait is full.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};

/// The path under the instance's address the terminal dials.
pub const RELAY_PATH: &str = "/api/deploy/ws/terminal";

/// How long the relay waits for `hello` before dropping the socket.
pub const HELLO_DEADLINE: Duration = Duration::from_secs(10);

/// Panes one socket may have attached at once (`TERMINAL_LIMITS.watches`).
pub const MAX_ATTACHED_PANES: usize = 16;

/// The most raw bytes one `output` frame carries.
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;

/// The relay's per-pane meter, in bytes of frame data (the base64 text).
pub const OUTPUT_BYTES_PER_SECOND: u64 = 256 * 1024;
pub const OUTPUT_BURST_BYTES: u64 = 1024 * 1024;

/// Raw bytes a pane may have waiting to be sent before the oldest are dropped.
pub const MAX_PENDING_BYTES: usize = 1024 * 1024;

/// What the relay sends the terminal.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Incoming {
    /// The relay accepted `hello`.
    Ready {
        instance: String,
    },
    /// A controller's request, to answer with [`Outgoing::Response`] and the same id.
    Request {
        id: String,
        envelope: serde_json::Value,
    },
    /// Somebody started watching this pane.
    Attach {
        pane: String,
    },
    /// Nobody is watching this pane any more.
    Detach {
        pane: String,
    },
    Pong,
    /// A frame this build does not know; ignored rather than fatal, so a newer
    /// relay does not cut older terminals off.
    #[serde(other)]
    Unknown,
}

/// What the terminal sends the relay.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Outgoing {
    Hello {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        os: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    Response {
        id: String,
        envelope: serde_json::Value,
    },
    Output {
        pane: String,
        data: String,
    },
    Ping,
}

/// Reads one relay frame; `None` for anything that is not a frame at all.
pub fn parse_incoming(text: &str) -> Option<Incoming> {
    serde_json::from_str(text).ok()
}

/// Why an `attach` was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachRefused {
    /// [`MAX_ATTACHED_PANES`] are attached already.
    TooManyPanes,
}

#[derive(Debug)]
struct PaneStream {
    pending: VecDeque<u8>,
    tokens: f64,
    refilled_at: Duration,
}

/// The panes the relay has attached on this socket and their unsent output.
///
/// Time is passed in as the elapsed time since any fixed start, so the meter
/// can be tested without a clock. Nothing survives a reconnect: call
/// [`PaneOutput::reset`] when the socket closes, and the relay attaches every
/// still-watched pane again on the new one.
#[derive(Debug, Default)]
pub struct PaneOutput {
    panes: HashMap<String, PaneStream>,
}

impl PaneOutput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_attached(&self, pane: &str) -> bool {
        self.panes.contains_key(pane)
    }

    pub fn attached(&self) -> impl Iterator<Item = &str> {
        self.panes.keys().map(String::as_str)
    }

    /// Starts a pane, with its current screen as the first output so a new
    /// watcher is not looking at a blank pane. Attaching a pane already
    /// attached restarts it from the screen.
    pub fn attach(
        &mut self,
        pane: &str,
        screen: &[u8],
        now: Duration,
    ) -> Result<(), AttachRefused> {
        if !self.panes.contains_key(pane) && self.panes.len() >= MAX_ATTACHED_PANES {
            return Err(AttachRefused::TooManyPanes);
        }
        let mut stream = PaneStream {
            pending: VecDeque::new(),
            tokens: OUTPUT_BURST_BYTES as f64,
            refilled_at: now,
        };
        enqueue(&mut stream.pending, screen);
        self.panes.insert(pane.to_owned(), stream);
        Ok(())
    }

    /// Stops a pane and forgets what it had not sent.
    pub fn detach(&mut self, pane: &str) {
        self.panes.remove(pane);
    }

    /// The socket closed: no pane is attached on the next one until the relay says so.
    pub fn reset(&mut self) {
        self.panes.clear();
    }

    /// Bytes a pane's PTY produced. Dropped when the pane is not attached.
    pub fn push(&mut self, pane: &str, bytes: &[u8]) {
        if let Some(stream) = self.panes.get_mut(pane) {
            enqueue(&mut stream.pending, bytes);
        }
    }

    /// The `output` frames that may go out now, within each pane's meter.
    pub fn drain(&mut self, now: Duration) -> Vec<Outgoing> {
        let mut frames = Vec::new();
        let mut panes: Vec<String> = self.panes.keys().cloned().collect();
        panes.sort();
        for pane in panes {
            let stream = self.panes.get_mut(&pane).expect("listed above");
            let elapsed = now.saturating_sub(stream.refilled_at).as_secs_f64();
            stream.tokens = (stream.tokens + elapsed * OUTPUT_BYTES_PER_SECOND as f64)
                .min(OUTPUT_BURST_BYTES as f64);
            stream.refilled_at = now;
            while !stream.pending.is_empty() {
                let size = stream.pending.len().min(MAX_CHUNK_BYTES);
                if (encoded_len(size) as f64) > stream.tokens {
                    break;
                }
                let chunk: Vec<u8> = stream.pending.drain(..size).collect();
                let data = base64::engine::general_purpose::STANDARD.encode(&chunk);
                stream.tokens -= data.len() as f64;
                frames.push(Outgoing::Output {
                    pane: pane.clone(),
                    data,
                });
            }
        }
        frames
    }

    /// Whether any attached pane has output waiting.
    pub fn has_pending(&self) -> bool {
        self.panes.values().any(|stream| !stream.pending.is_empty())
    }
}

fn enqueue(pending: &mut VecDeque<u8>, bytes: &[u8]) {
    let bytes = &bytes[bytes.len().saturating_sub(MAX_PENDING_BYTES)..];
    let overflow = (pending.len() + bytes.len()).saturating_sub(MAX_PENDING_BYTES);
    pending.drain(..overflow);
    pending.extend(bytes);
}

/// The length of `size` bytes in padded base64.
fn encoded_len(size: usize) -> usize {
    size.div_ceil(3) * 4
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
