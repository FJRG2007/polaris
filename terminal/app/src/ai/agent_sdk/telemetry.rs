use pterm_core::telemetry::{EnablementState, TelemetryEvent, TelemetryEventDesc};
use serde_json::{Value, json};
use strum_macros::{EnumDiscriminants, EnumIter};

use crate::features::FeatureFlag;

#[derive(Debug, EnumDiscriminants)]
#[strum_discriminants(derive(EnumIter))]
pub(super) enum CliTelemetryEvent {
    /// Executing `polaris-terminal agent run`
    AgentRun {
        gui: bool,
        requested_mcp_servers: usize,
        has_environment: bool,
        /// Optional task ID when running against an ambient agent task.
        task_id: Option<String>,
        /// Which execution harness was selected (e.g. "oz", "claude").
        harness: String,
    },
    /// Executing `polaris-terminal agent run-ambient`
    AgentRunAmbient,
    /// Executing `polaris-terminal agent profile list`
    AgentProfileList,
    /// Executing `polaris-terminal agent list`
    AgentList,
    /// Executing `polaris-terminal agent get`
    AgentGet,
    /// Executing `polaris-terminal agent create`
    AgentCreate,
    /// Executing `polaris-terminal agent update`
    AgentUpdate,
    /// Executing `polaris-terminal agent delete`
    AgentDelete,
    /// Executing `polaris-terminal agent skills`
    AgentSkills,
    /// Executing `polaris-terminal environment list`
    EnvironmentList,
    /// Executing `polaris-terminal environment create`
    EnvironmentCreate,
    /// Executing `polaris-terminal environment delete`
    EnvironmentDelete,
    /// Executing `polaris-terminal environment update`
    EnvironmentUpdate,
    /// Executing `polaris-terminal environment get`
    EnvironmentGet,
    /// Executing `polaris-terminal environment image list`
    EnvironmentImageList,
    /// Executing `polaris-terminal mcp list`
    MCPList,
    /// Executing `polaris-terminal model list`
    ModelList,
    /// Executing `polaris-terminal memory-store list`
    MemoryStoreList,
    /// Executing `polaris-terminal memory list`
    MemoryStoreListMemories,
    /// Executing `polaris-terminal memory create`
    MemoryStoreCreateMemory,
    /// Executing `polaris-terminal memory update`
    MemoryStoreUpdateMemory,
    /// Executing `polaris-terminal memory delete`
    MemoryStoreDeleteMemory,
    /// Executing `polaris-terminal memory-store get`
    MemoryStoreGetStore,
    /// Executing `polaris-terminal memory-store update`
    MemoryStoreUpdateStore,
    /// Executing `polaris-terminal memory-store list-store-agents`
    MemoryStoreListStoreAgents,
    /// Executing `polaris-terminal memory versions`
    MemoryStoreListVersions,
    /// Executing `polaris-terminal task list`
    TaskList,
    /// Executing `polaris-terminal task get`
    TaskGet,
    /// Executing `polaris-terminal run conversation get`
    ConversationGet,
    /// Executing `polaris-terminal run get <id> --conversation`
    RunConversationGet,
    /// Executing `polaris-terminal run message watch`
    RunMessageWatch { harness: &'static str },
    /// Executing `polaris-terminal run message send`
    RunMessageSend { harness: &'static str },
    /// Executing `polaris-terminal run message list`
    RunMessageList { harness: &'static str },
    /// Executing `polaris-terminal run message read`
    RunMessageRead { harness: &'static str },
    /// Executing `polaris-terminal run message mark-delivered`
    RunMessageMarkDelivered { harness: &'static str },
    /// Executing `polaris-terminal login`
    Login,
    /// Executing `polaris-terminal logout`
    Logout,
    /// Executing `polaris-terminal whoami`
    Whoami,
    /// Executing `polaris-terminal provider setup`
    ProviderSetup,
    /// Executing `polaris-terminal provider list`
    ProviderList,
    /// Executing `polaris-terminal integration create`
    IntegrationCreate,
    /// Executing `polaris-terminal integration update`
    IntegrationUpdate,
    /// Executing `polaris-terminal integration list`
    IntegrationList,
    /// Executing `polaris-terminal artifact upload`
    ArtifactUpload,
    /// Executing `polaris-terminal artifact get`
    ArtifactGet,
    /// Executing `polaris-terminal artifact download`
    ArtifactDownload,
    /// Executing `polaris-terminal api-key list`
    ApiKeyList,
    /// Executing `polaris-terminal api-key create`
    ApiKeyCreate,
    /// Executing `polaris-terminal api-key expire`
    ApiKeyExpire,
    /// Executing `polaris-terminal schedule create`
    ScheduleCreate,
    /// Executing `polaris-terminal schedule list`
    ScheduleList,
    /// Executing `polaris-terminal schedule get`
    ScheduleGet,
    /// Executing `polaris-terminal schedule pause`
    SchedulePause,
    /// Executing `polaris-terminal schedule unpause`
    ScheduleUnpause,
    /// Executing `polaris-terminal schedule update`
    ScheduleUpdate,
    /// Executing `polaris-terminal schedule delete`
    ScheduleDelete,
    /// Executing `polaris-terminal secret create`
    SecretCreate,
    /// Executing `polaris-terminal secret delete`
    SecretDelete,
    /// Executing `polaris-terminal secret update`
    SecretUpdate,
    /// Executing `polaris-terminal secret list`
    SecretList,
    /// Executing `polaris-terminal federate issue-token`
    FederateIssueToken,
    /// Executing `polaris-terminal federate issue-gcp-token`
    FederateIssueGcpToken,
    /// Executing `polaris-terminal harness-support ping`
    HarnessSupportPing,
    /// Executing `polaris-terminal harness-support report-artifact`
    HarnessSupportReportArtifact { artifact_type: &'static str },
    /// Executing `polaris-terminal harness-support notify-user`
    HarnessSupportNotifyUser,
    /// Executing `polaris-terminal harness-support finish-task`
    HarnessSupportFinishTask { success: bool },
    /// Executing `polaris-terminal harness-support report-shutdown`
    HarnessSupportReportShutdown,
    /// Executing `polaris-terminal runner list`
    RunnerList,
    /// Executing `polaris-terminal runner create`
    RunnerCreate,
    /// Executing `polaris-terminal runner update`
    RunnerUpdate,
    /// Executing `polaris-terminal runner delete`
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
        pterm_core::telemetry::enum_events::<Self>()
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
            CliTelemetryEventDiscriminants::AgentRun => {
                "Ran an agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::AgentRunAmbient => {
                "Ran an ambient agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::AgentProfileList => {
                "Listed agent profiles from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::AgentList => {
                "Listed agents from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::AgentGet => {
                "Got agent details from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::AgentCreate => {
                "Created an agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::AgentUpdate => {
                "Updated an agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::AgentDelete => {
                "Deleted an agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::AgentSkills => {
                "Listed agent skills from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentList => {
                "Listed cloud environments from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentCreate => {
                "Created a cloud environment from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentDelete => {
                "Deleted a cloud environment from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentUpdate => {
                "Updated a cloud environment from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentGet => {
                "Got cloud environment details from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::EnvironmentImageList => {
                "Listed available base images from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MCPList => {
                "Listed MCP servers from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ModelList => {
                "Listed models from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreList => {
                "Listed memory stores from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreListMemories => {
                "Listed memories in a memory store from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreCreateMemory => {
                "Created a manual memory in a memory store from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreUpdateMemory => {
                "Updated a memory in a memory store from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreDeleteMemory => {
                "Deleted a memory from a memory store from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreGetStore => {
                "Got a memory store from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreUpdateStore => {
                "Updated a memory store from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreListStoreAgents => {
                "Listed agents attached to a memory store from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::MemoryStoreListVersions => {
                "Listed version history of a memory from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::TaskList => {
                "Listed tasks from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::TaskGet => {
                "Got status of task from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ConversationGet => {
                "Got conversation by ID from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunConversationGet => {
                "Got run conversation from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageWatch => {
                "Watched run messages from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageSend => {
                "Sent a run message from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageList => {
                "Listed run messages from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageRead => {
                "Read a run message from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunMessageMarkDelivered => {
                "Marked a run message as delivered from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::Login => "Logged in via the Polaris Terminal CLI",
            CliTelemetryEventDiscriminants::Logout => "Logged out via the Polaris Terminal CLI",
            CliTelemetryEventDiscriminants::Whoami => {
                "Printed current user info from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ProviderSetup => {
                "Set up a provider via the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ProviderList => {
                "Listed providers from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::IntegrationCreate => {
                "Created an integration from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::IntegrationUpdate => {
                "Updated an integration from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::IntegrationList => {
                "Listed integrations from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ArtifactUpload => {
                "Uploaded an artifact from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ArtifactGet => {
                "Got artifact metadata from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ArtifactDownload => {
                "Downloaded an artifact from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ApiKeyList => {
                "Listed API keys from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ApiKeyCreate => {
                "Created an API key from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ApiKeyExpire => {
                "Expired an API key from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleCreate => {
                "Created a scheduled agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleList => {
                "Listed scheduled agents from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleGet => {
                "Got scheduled agent configuration from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::SchedulePause => {
                "Paused a scheduled agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleUnpause => {
                "Unpaused a scheduled agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleUpdate => {
                "Updated a scheduled agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::ScheduleDelete => {
                "Deleted a scheduled agent from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::SecretCreate => {
                "Created a secret from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::SecretDelete => {
                "Deleted a secret from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::SecretUpdate => {
                "Updated a secret from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::SecretList => {
                "Listed secrets from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::FederateIssueToken => {
                "Issued a federated identity token from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::FederateIssueGcpToken => {
                "Issued a GCP federated identity token from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportPing => {
                "Pinged harness-support from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportReportArtifact => {
                "Reported an artifact via harness-support from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportNotifyUser => {
                "Sent a user notification via harness-support from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportFinishTask => {
                "Reported task completion via harness-support from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::HarnessSupportReportShutdown => {
                "Reported agent shutdown via harness-support from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunnerList => {
                "Listed runners from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunnerCreate => {
                "Created a runner from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunnerUpdate => {
                "Updated a runner from the Polaris Terminal CLI"
            }
            CliTelemetryEventDiscriminants::RunnerDelete => {
                "Deleted a runner from the Polaris Terminal CLI"
            }
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

pterm_core::register_telemetry_event!(CliTelemetryEvent);
