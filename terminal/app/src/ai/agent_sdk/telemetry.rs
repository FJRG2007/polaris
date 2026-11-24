use rook_core::telemetry::{EnablementState, TelemetryEvent, TelemetryEventDesc};
use serde_json::{Value, json};
use strum_macros::{EnumDiscriminants, EnumIter};

use crate::features::FeatureFlag;

#[derive(Debug, EnumDiscriminants)]
#[strum_discriminants(derive(EnumIter))]
pub(super) enum CliTelemetryEvent {
    /// Executing `rook agent run`
    AgentRun {
        gui: bool,
        requested_mcp_servers: usize,
        has_environment: bool,
        /// Optional task ID when running against an ambient agent task.
        task_id: Option<String>,
        /// Which execution harness was selected (e.g. "oz", "claude").
        harness: String,
    },
    /// Executing `rook agent run-ambient`
    AgentRunAmbient,
    /// Executing `rook agent profile list`
    AgentProfileList,
    /// Executing `rook agent list`
    AgentList,
    /// Executing `rook agent get`
    AgentGet,
    /// Executing `rook agent create`
    AgentCreate,
    /// Executing `rook agent update`
    AgentUpdate,
    /// Executing `rook agent delete`
    AgentDelete,
    /// Executing `rook agent skills`
    AgentSkills,
    /// Executing `rook environment list`
    EnvironmentList,
    /// Executing `rook environment create`
    EnvironmentCreate,
    /// Executing `rook environment delete`
    EnvironmentDelete,
    /// Executing `rook environment update`
    EnvironmentUpdate,
    /// Executing `rook environment get`
    EnvironmentGet,
    /// Executing `rook environment image list`
    EnvironmentImageList,
    /// Executing `rook mcp list`
    MCPList,
    /// Executing `rook model list`
    ModelList,
    /// Executing `rook memory-store list`
    MemoryStoreList,
    /// Executing `rook memory list`
    MemoryStoreListMemories,
    /// Executing `rook memory create`
    MemoryStoreCreateMemory,
    /// Executing `rook memory update`
    MemoryStoreUpdateMemory,
    /// Executing `rook memory delete`
    MemoryStoreDeleteMemory,
    /// Executing `rook memory-store get`
    MemoryStoreGetStore,
    /// Executing `rook memory-store update`
    MemoryStoreUpdateStore,
    /// Executing `rook memory-store list-store-agents`
    MemoryStoreListStoreAgents,
    /// Executing `rook memory versions`
    MemoryStoreListVersions,
    /// Executing `rook task list`
    TaskList,
    /// Executing `rook task get`
    TaskGet,
    /// Executing `rook run conversation get`
    ConversationGet,
    /// Executing `rook run get <id> --conversation`
    RunConversationGet,
    /// Executing `rook run message watch`
    RunMessageWatch { harness: &'static str },
    /// Executing `rook run message send`
    RunMessageSend { harness: &'static str },
    /// Executing `rook run message list`
    RunMessageList { harness: &'static str },
    /// Executing `rook run message read`
    RunMessageRead { harness: &'static str },
    /// Executing `rook run message mark-delivered`
    RunMessageMarkDelivered { harness: &'static str },
    /// Executing `rook login`
    Login,
    /// Executing `rook logout`
    Logout,
    /// Executing `rook whoami`
    Whoami,
    /// Executing `rook provider setup`
    ProviderSetup,
    /// Executing `rook provider list`
    ProviderList,
    /// Executing `rook integration create`
    IntegrationCreate,
    /// Executing `rook integration update`
    IntegrationUpdate,
    /// Executing `rook integration list`
    IntegrationList,
    /// Executing `rook artifact upload`
    ArtifactUpload,
    /// Executing `rook artifact get`
    ArtifactGet,
    /// Executing `rook artifact download`
    ArtifactDownload,
    /// Executing `rook api-key list`
    ApiKeyList,
    /// Executing `rook api-key create`
    ApiKeyCreate,
    /// Executing `rook api-key expire`
    ApiKeyExpire,
    /// Executing `rook schedule create`
    ScheduleCreate,
    /// Executing `rook schedule list`
    ScheduleList,
    /// Executing `rook schedule get`
    ScheduleGet,
    /// Executing `rook schedule pause`
    SchedulePause,
    /// Executing `rook schedule unpause`
    ScheduleUnpause,
    /// Executing `rook schedule update`
    ScheduleUpdate,
    /// Executing `rook schedule delete`
    ScheduleDelete,
    /// Executing `rook secret create`
    SecretCreate,
    /// Executing `rook secret delete`
    SecretDelete,
    /// Executing `rook secret update`
    SecretUpdate,
    /// Executing `rook secret list`
    SecretList,
    /// Executing `rook federate issue-token`
    FederateIssueToken,
    /// Executing `rook federate issue-gcp-token`
    FederateIssueGcpToken,
    /// Executing `rook harness-support ping`
    HarnessSupportPing,
    /// Executing `rook harness-support report-artifact`
    HarnessSupportReportArtifact { artifact_type: &'static str },
    /// Executing `rook harness-support notify-user`
    HarnessSupportNotifyUser,
    /// Executing `rook harness-support finish-task`
    HarnessSupportFinishTask { success: bool },
    /// Executing `rook harness-support report-shutdown`
    HarnessSupportReportShutdown,
    /// Executing `rook runner list`
    RunnerList,
    /// Executing `rook runner create`
    RunnerCreate,
    /// Executing `rook runner update`
    RunnerUpdate,
    /// Executing `rook runner delete`
    RunnerDelete,
}

impl TelemetryEvent for CliTelemetryEvent {
    fn name(&self) -> &'static str {
        CliTelemetryEventDiscriminants::from(self).name()
    }

    fn payload(&self) -> Option<Value> {
        match self {
            CliTelemetryEvent::AgentRun {
                gui,
                requested_mcp_servers,
                has_environment,
                task_id,
                harness,
            } => Some(json!({
                "gui": gui,
                "requested_mcp_servers": requested_mcp_servers,
                "has_environment": has_environment,
                "task_id": task_id,
                "harness": harness,
            })),
            CliTelemetryEvent::AgentRunAmbient => None,
            CliTelemetryEvent::AgentProfileList => None,
            CliTelemetryEvent::AgentList => None,
            CliTelemetryEvent::AgentGet => None,
            CliTelemetryEvent::AgentCreate => None,
            CliTelemetryEvent::AgentUpdate => None,
            CliTelemetryEvent::AgentDelete => None,
            CliTelemetryEvent::AgentSkills => None,
            CliTelemetryEvent::EnvironmentList => None,
            CliTelemetryEvent::EnvironmentCreate => None,
            CliTelemetryEvent::EnvironmentDelete => None,
            CliTelemetryEvent::EnvironmentUpdate => None,
            CliTelemetryEvent::EnvironmentGet => None,
            CliTelemetryEvent::EnvironmentImageList => None,
            CliTelemetryEvent::MCPList => None,
            CliTelemetryEvent::ModelList => None,
            CliTelemetryEvent::MemoryStoreList => None,
            CliTelemetryEvent::MemoryStoreListMemories => None,
            CliTelemetryEvent::MemoryStoreCreateMemory => None,
            CliTelemetryEvent::MemoryStoreUpdateMemory => None,
            CliTelemetryEvent::MemoryStoreDeleteMemory => None,
            CliTelemetryEvent::MemoryStoreGetStore => None,
            CliTelemetryEvent::MemoryStoreUpdateStore => None,
            CliTelemetryEvent::MemoryStoreListStoreAgents => None,
            CliTelemetryEvent::MemoryStoreListVersions => None,
            CliTelemetryEvent::TaskList => None,
            CliTelemetryEvent::TaskGet => None,
            CliTelemetryEvent::ConversationGet => None,
            CliTelemetryEvent::RunConversationGet => None,
            CliTelemetryEvent::RunMessageWatch { harness } => Some(json!({ "harness": harness })),
            CliTelemetryEvent::RunMessageSend { harness } => Some(json!({ "harness": harness })),
            CliTelemetryEvent::RunMessageList { harness } => Some(json!({ "harness": harness })),
            CliTelemetryEvent::RunMessageRead { harness } => Some(json!({ "harness": harness })),
            CliTelemetryEvent::RunMessageMarkDelivered { harness } => {
                Some(json!({ "harness": harness }))
            }
            CliTelemetryEvent::Login => None,
            CliTelemetryEvent::Logout => None,
            CliTelemetryEvent::Whoami => None,
            CliTelemetryEvent::ProviderSetup => None,
            CliTelemetryEvent::ProviderList => None,
            CliTelemetryEvent::IntegrationCreate => None,
            CliTelemetryEvent::IntegrationUpdate => None,
            CliTelemetryEvent::IntegrationList => None,
            CliTelemetryEvent::ArtifactUpload => None,
            CliTelemetryEvent::ArtifactGet => None,
            CliTelemetryEvent::ArtifactDownload => None,
            CliTelemetryEvent::ApiKeyList => None,
            CliTelemetryEvent::ApiKeyCreate => None,
            CliTelemetryEvent::ApiKeyExpire => None,
            CliTelemetryEvent::ScheduleCreate => None,
            CliTelemetryEvent::ScheduleList => None,
            CliTelemetryEvent::ScheduleGet => None,
            CliTelemetryEvent::SchedulePause => None,
            CliTelemetryEvent::ScheduleUnpause => None,
            CliTelemetryEvent::ScheduleUpdate => None,
            CliTelemetryEvent::ScheduleDelete => None,
            CliTelemetryEvent::SecretCreate => None,
            CliTelemetryEvent::SecretDelete => None,
            CliTelemetryEvent::SecretUpdate => None,
            CliTelemetryEvent::SecretList => None,
            CliTelemetryEvent::FederateIssueToken => None,
            CliTelemetryEvent::FederateIssueGcpToken => None,
            CliTelemetryEvent::HarnessSupportPing => None,
            CliTelemetryEvent::HarnessSupportReportArtifact { artifact_type } => {
                Some(json!({ "artifact_type": artifact_type }))
            }
            CliTelemetryEvent::HarnessSupportNotifyUser => None,
            CliTelemetryEvent::HarnessSupportFinishTask { success } => {
                Some(json!({ "success": success }))
            }
            CliTelemetryEvent::HarnessSupportReportShutdown => None,
            CliTelemetryEvent::RunnerList => None,
            CliTelemetryEvent::RunnerCreate => None,
            CliTelemetryEvent::RunnerUpdate => None,
            CliTelemetryEvent::RunnerDelete => None,
        }
    }

    fn description(&self) -> &'static str {
        CliTelemetryEventDiscriminants::from(self).description()
    }

    fn enablement_state(&self) -> EnablementState {
        CliTelemetryEventDiscriminants::from(self).enablement_state()
    }

    fn contains_ugc(&self) -> bool {
        false
    }

    fn event_descs() -> impl Iterator<Item = Box<dyn TelemetryEventDesc>> {
        rook_core::telemetry::enum_events::<Self>()
    }
}

impl TelemetryEventDesc for CliTelemetryEventDiscriminants {
    fn name(&self) -> &'static str {
        match self {
            CliTelemetryEventDiscriminants::AgentRun => "CLI.Execute.Agent.Run",
            CliTelemetryEventDiscriminants::AgentRunAmbient => "CLI.Execute.Agent.RunAmbient",
            CliTelemetryEventDiscriminants::AgentProfileList => "CLI.Execute.Agent.Profile.List",
            CliTelemetryEventDiscriminants::AgentList => "CLI.Execute.Agent.List",
            CliTelemetryEventDiscriminants::AgentGet => "CLI.Execute.Agent.Get",
            CliTelemetryEventDiscriminants::AgentCreate => "CLI.Execute.Agent.Create",
            CliTelemetryEventDiscriminants::AgentUpdate => "CLI.Execute.Agent.Update",
            CliTelemetryEventDiscriminants::AgentDelete => "CLI.Execute.Agent.Delete",
            CliTelemetryEventDiscriminants::AgentSkills => "CLI.Execute.Agent.Skills",
            CliTelemetryEventDiscriminants::EnvironmentList => "CLI.Execute.Environment.List",
            CliTelemetryEventDiscriminants::EnvironmentCreate => "CLI.Execute.Environment.Create",
            CliTelemetryEventDiscriminants::EnvironmentDelete => "CLI.Execute.Environment.Delete",
            CliTelemetryEventDiscriminants::EnvironmentUpdate => "CLI.Execute.Environment.Update",
            CliTelemetryEventDiscriminants::EnvironmentGet => "CLI.Execute.Environment.Get",
            CliTelemetryEventDiscriminants::EnvironmentImageList => {
                "CLI.Execute.Environment.Image.List"
            }
            CliTelemetryEventDiscriminants::MCPList => "CLI.Execute.MCP.List",
            CliTelemetryEventDiscriminants::ModelList => "CLI.Execute.Model.List",
            CliTelemetryEventDiscriminants::MemoryStoreList => "CLI.Execute.MemoryStore.List",
            CliTelemetryEventDiscriminants::MemoryStoreListMemories => {
                "CLI.Execute.MemoryStore.ListMemories"
            }
            CliTelemetryEventDiscriminants::MemoryStoreCreateMemory => {
                "CLI.Execute.MemoryStore.CreateMemory"
            }
            CliTelemetryEventDiscriminants::MemoryStoreUpdateMemory => {
                "CLI.Execute.MemoryStore.UpdateMemory"
            }
            CliTelemetryEventDiscriminants::MemoryStoreDeleteMemory => {
                "CLI.Execute.MemoryStore.DeleteMemory"
            }
            CliTelemetryEventDiscriminants::MemoryStoreGetStore => {
                "CLI.Execute.MemoryStore.GetStore"
            }
            CliTelemetryEventDiscriminants::MemoryStoreUpdateStore => {
                "CLI.Execute.MemoryStore.UpdateStore"
            }
            CliTelemetryEventDiscriminants::MemoryStoreListStoreAgents => {
                "CLI.Execute.MemoryStore.ListStoreAgents"
            }
            CliTelemetryEventDiscriminants::MemoryStoreListVersions => {
                "CLI.Execute.MemoryStore.ListVersions"
            }
            CliTelemetryEventDiscriminants::TaskList => "CLI.Execute.Task.List",
            CliTelemetryEventDiscriminants::TaskGet => "CLI.Execute.Task.Get",
            CliTelemetryEventDiscriminants::ConversationGet => "CLI.Execute.Conversation.Get",
            CliTelemetryEventDiscriminants::RunConversationGet => {
                "CLI.Execute.Run.Conversation.Get"
            }
            CliTelemetryEventDiscriminants::RunMessageWatch => "CLI.Execute.Run.Message.Watch",
            CliTelemetryEventDiscriminants::RunMessageSend => "CLI.Execute.Run.Message.Send",
            CliTelemetryEventDiscriminants::RunMessageList => "CLI.Execute.Run.Message.List",
            CliTelemetryEventDiscriminants::RunMessageRead => "CLI.Execute.Run.Message.Read",
            CliTelemetryEventDiscriminants::RunMessageMarkDelivered => {
                "CLI.Execute.Run.Message.MarkDelivered"
            }
            CliTelemetryEventDiscriminants::Login => "CLI.Execute.Login",
            CliTelemetryEventDiscriminants::Logout => "CLI.Execute.Logout",
            CliTelemetryEventDiscriminants::Whoami => "CLI.Execute.Whoami",
            CliTelemetryEventDiscriminants::ProviderSetup => "CLI.Execute.Provider.Setup",
            CliTelemetryEventDiscriminants::ProviderList => "CLI.Execute.Provider.List",
            CliTelemetryEventDiscriminants::IntegrationCreate => "CLI.Execute.Integration.Create",
            CliTelemetryEventDiscriminants::IntegrationUpdate => "CLI.Execute.Integration.Update",
            CliTelemetryEventDiscriminants::IntegrationList => "CLI.Execute.Integration.List",
            CliTelemetryEventDiscriminants::ArtifactUpload => "CLI.Execute.Artifact.Upload",
            CliTelemetryEventDiscriminants::ArtifactGet => "CLI.Execute.Artifact.Get",
            CliTelemetryEventDiscriminants::ArtifactDownload => "CLI.Execute.Artifact.Download",
            CliTelemetryEventDiscriminants::ApiKeyList => "CLI.Execute.ApiKey.List",
            CliTelemetryEventDiscriminants::ApiKeyCreate => "CLI.Execute.ApiKey.Create",
            CliTelemetryEventDiscriminants::ApiKeyExpire => "CLI.Execute.ApiKey.Expire",
            CliTelemetryEventDiscriminants::ScheduleCreate => "CLI.Execute.Schedule.Create",
            CliTelemetryEventDiscriminants::ScheduleList => "CLI.Execute.Schedule.List",
            CliTelemetryEventDiscriminants::ScheduleGet => "CLI.Execute.Schedule.Get",
            CliTelemetryEventDiscriminants::SchedulePause => "CLI.Execute.Schedule.Pause",
            CliTelemetryEventDiscriminants::ScheduleUnpause => "CLI.Execute.Schedule.Unpause",
            CliTelemetryEventDiscriminants::ScheduleUpdate => "CLI.Execute.Schedule.Update",
            CliTelemetryEventDiscriminants::ScheduleDelete => "CLI.Execute.Schedule.Delete",
            CliTelemetryEventDiscriminants::SecretCreate => "CLI.Execute.Secret.Create",
            CliTelemetryEventDiscriminants::SecretDelete => "CLI.Execute.Secret.Delete",
            CliTelemetryEventDiscriminants::SecretUpdate => "CLI.Execute.Secret.Update",
            CliTelemetryEventDiscriminants::SecretList => "CLI.Execute.Secret.List",
            CliTelemetryEventDiscriminants::FederateIssueToken => "CLI.Execute.Federate.IssueToken",
            CliTelemetryEventDiscriminants::FederateIssueGcpToken => {
                "CLI.Execute.Federate.IssueGcpToken"
            }
            CliTelemetryEventDiscriminants::HarnessSupportPing => "CLI.Execute.HarnessSupport.Ping",
            CliTelemetryEventDiscriminants::HarnessSupportReportArtifact => {
                "CLI.Execute.HarnessSupport.ReportArtifact"
            }
            CliTelemetryEventDiscriminants::HarnessSupportNotifyUser => {
                "CLI.Execute.HarnessSupport.NotifyUser"
            }
            CliTelemetryEventDiscriminants::HarnessSupportFinishTask => {
                "CLI.Execute.HarnessSupport.FinishTask"
            }
            CliTelemetryEventDiscriminants::HarnessSupportReportShutdown => {
                "CLI.Execute.HarnessSupport.ReportShutdown"
            }
            CliTelemetryEventDiscriminants::RunnerList => "CLI.Execute.Runner.List",
            CliTelemetryEventDiscriminants::RunnerCreate => "CLI.Execute.Runner.Create",
            CliTelemetryEventDiscriminants::RunnerUpdate => "CLI.Execute.Runner.Update",
            CliTelemetryEventDiscriminants::RunnerDelete => "CLI.Execute.Runner.Delete",
        }
    }

    fn description(&self) -> &'static str {
        match self {
            CliTelemetryEventDiscriminants::AgentRun => "Ran an agent from the Rook CLI",
            CliTelemetryEventDiscriminants::AgentRunAmbient => {
                "Ran an ambient agent from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::AgentProfileList => {
                "Listed agent profiles from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::AgentList => "Listed agents from the Rook CLI",
            CliTelemetryEventDiscriminants::AgentGet => "Got agent details from the Rook CLI",
            CliTelemetryEventDiscriminants::AgentCreate => "Created an agent from the Rook CLI",
            CliTelemetryEventDiscriminants::AgentUpdate => "Updated an agent from the Rook CLI",
            CliTelemetryEventDiscriminants::AgentDelete => "Deleted an agent from the Rook CLI",
            CliTelemetryEventDiscriminants::AgentSkills => "Listed agent skills from the Rook CLI",
            CliTelemetryEventDiscriminants::EnvironmentList => {
                "Listed cloud environments from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentCreate => {
                "Created a cloud environment from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentDelete => {
                "Deleted a cloud environment from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentUpdate => {
                "Updated a cloud environment from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentGet => {
                "Got cloud environment details from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentImageList => {
                "Listed available base images from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MCPList => "Listed MCP servers from the Rook CLI",
            CliTelemetryEventDiscriminants::ModelList => "Listed models from the Rook CLI",
            CliTelemetryEventDiscriminants::MemoryStoreList => {
                "Listed memory stores from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreListMemories => {
                "Listed memories in a memory store from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreCreateMemory => {
                "Created a manual memory in a memory store from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreUpdateMemory => {
                "Updated a memory in a memory store from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreDeleteMemory => {
                "Deleted a memory from a memory store from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreGetStore => {
                "Got a memory store from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreUpdateStore => {
                "Updated a memory store from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreListStoreAgents => {
                "Listed agents attached to a memory store from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreListVersions => {
                "Listed version history of a memory from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::TaskList => "Listed tasks from the Rook CLI",
            CliTelemetryEventDiscriminants::TaskGet => "Got status of task from the Rook CLI",
            CliTelemetryEventDiscriminants::ConversationGet => {
                "Got conversation by ID from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::RunConversationGet => {
                "Got run conversation from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageWatch => {
                "Watched run messages from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageSend => {
                "Sent a run message from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageList => {
                "Listed run messages from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageRead => {
                "Read a run message from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageMarkDelivered => {
                "Marked a run message as delivered from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::Login => "Logged in via the Rook CLI",
            CliTelemetryEventDiscriminants::Logout => "Logged out via the Rook CLI",
            CliTelemetryEventDiscriminants::Whoami => "Printed current user info from the Rook CLI",
            CliTelemetryEventDiscriminants::ProviderSetup => "Set up a provider via the Rook CLI",
            CliTelemetryEventDiscriminants::ProviderList => "Listed providers from the Rook CLI",
            CliTelemetryEventDiscriminants::IntegrationCreate => {
                "Created an integration from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::IntegrationUpdate => {
                "Updated an integration from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::IntegrationList => {
                "Listed integrations from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ArtifactUpload => {
                "Uploaded an artifact from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ArtifactGet => {
                "Got artifact metadata from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ArtifactDownload => {
                "Downloaded an artifact from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ApiKeyList => "Listed API keys from the Rook CLI",
            CliTelemetryEventDiscriminants::ApiKeyCreate => "Created an API key from the Rook CLI",
            CliTelemetryEventDiscriminants::ApiKeyExpire => "Expired an API key from the Rook CLI",
            CliTelemetryEventDiscriminants::ScheduleCreate => {
                "Created a scheduled agent from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleList => {
                "Listed scheduled agents from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleGet => {
                "Got scheduled agent configuration from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::SchedulePause => {
                "Paused a scheduled agent from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleUnpause => {
                "Unpaused a scheduled agent from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleUpdate => {
                "Updated a scheduled agent from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleDelete => {
                "Deleted a scheduled agent from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::SecretCreate => "Created a secret from the Rook CLI",
            CliTelemetryEventDiscriminants::SecretDelete => "Deleted a secret from the Rook CLI",
            CliTelemetryEventDiscriminants::SecretUpdate => "Updated a secret from the Rook CLI",
            CliTelemetryEventDiscriminants::SecretList => "Listed secrets from the Rook CLI",
            CliTelemetryEventDiscriminants::FederateIssueToken => {
                "Issued a federated identity token from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::FederateIssueGcpToken => {
                "Issued a GCP federated identity token from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportPing => {
                "Pinged harness-support from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportReportArtifact => {
                "Reported an artifact via harness-support from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportNotifyUser => {
                "Sent a user notification via harness-support from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportFinishTask => {
                "Reported task completion via harness-support from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportReportShutdown => {
                "Reported agent shutdown via harness-support from the Rook CLI"
            }
            CliTelemetryEventDiscriminants::RunnerList => "Listed runners from the Rook CLI",
            CliTelemetryEventDiscriminants::RunnerCreate => "Created a runner from the Rook CLI",
            CliTelemetryEventDiscriminants::RunnerUpdate => "Updated a runner from the Rook CLI",
            CliTelemetryEventDiscriminants::RunnerDelete => "Deleted a runner from the Rook CLI",
        }
    }

    fn enablement_state(&self) -> EnablementState {
        match self {
            Self::FederateIssueToken | Self::FederateIssueGcpToken => {
                EnablementState::Flag(FeatureFlag::OzIdentityFederation)
            }
            Self::HarnessSupportPing
            | Self::HarnessSupportReportArtifact
            | Self::HarnessSupportNotifyUser
            | Self::HarnessSupportFinishTask => EnablementState::Flag(FeatureFlag::AgentHarness),
            Self::ArtifactUpload | Self::ArtifactGet | Self::ArtifactDownload => {
                EnablementState::Flag(FeatureFlag::ArtifactCommand)
            }
            Self::ApiKeyList | Self::ApiKeyCreate | Self::ApiKeyExpire => {
                EnablementState::Flag(FeatureFlag::APIKeyManagement)
            }
            Self::RunnerList | Self::RunnerCreate | Self::RunnerUpdate | Self::RunnerDelete => {
                EnablementState::Flag(FeatureFlag::CloudAgentRunners)
            }
            Self::RunMessageWatch
            | Self::RunMessageSend
            | Self::RunMessageList
            | Self::RunMessageRead
            | Self::RunMessageMarkDelivered => EnablementState::Always,
            _ => EnablementState::Always,
        }
    }
}

rook_core::register_telemetry_event!(CliTelemetryEvent);
