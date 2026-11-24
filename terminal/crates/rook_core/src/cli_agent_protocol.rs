use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

/// Sentinel title that identifies structured CLI-agent events sent via OSC 777.
pub const CLI_AGENT_NOTIFICATION_SENTINEL: &str = "rook://cli-agent";

/// Whether an OSC 777 title marks a structured CLI-agent event.
///
/// Only Rook's own sentinel is accepted. The upstream plugins send a different one and
/// are deliberately not recognised: they carry the per-hook cost this repository's
/// copies were rewritten to remove, so accepting them would silently leave a user on
/// the slow ones. `plugins/` holds the versions Rook installs.
pub fn is_cli_agent_notification(title: &str) -> bool {
    title == CLI_AGENT_NOTIFICATION_SENTINEL
}

/// Schema version emitted by the current CLI-agent notification protocol.
pub const CLI_AGENT_PROTOCOL_VERSION: u32 = 1;

/// Environment variable that advertises the host's CLI-agent protocol version.
pub const ROOK_CLI_AGENT_PROTOCOL_VERSION_ENV: &str = "ROOK_CLI_AGENT_PROTOCOL_VERSION";

/// Environment variable that identifies the hosting Rook client version.
pub const ROOK_CLIENT_VERSION_ENV: &str = "ROOK_CLIENT_VERSION";

/// Wire representation of a structured CLI-agent notification.
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CLIAgentNotification {
    pub v: Option<u32>,
    pub agent: Option<String>,
    pub event: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub query: Option<String>,
    pub response: Option<String>,
    pub transcript_path: Option<String>,
    pub summary: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    pub plugin_version: Option<String>,
    pub error_type: Option<String>,
}

impl CLIAgentNotification {
    pub fn new(agent: impl Into<String>, event: impl Into<String>) -> Self {
        Self {
            v: Some(CLI_AGENT_PROTOCOL_VERSION),
            agent: Some(agent.into()),
            event: event.into(),
            session_id: None,
            cwd: None,
            project: None,
            query: None,
            response: None,
            transcript_path: None,
            summary: None,
            tool_name: None,
            tool_input: None,
            plugin_version: None,
            error_type: None,
        }
    }
}
