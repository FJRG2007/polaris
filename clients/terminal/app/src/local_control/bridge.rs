//! Bridge between protocol-level control requests and Polaris Terminal application models.
//!
//! The bridge validates protocol version, selectors, credentials, and settings
//! before routing each supported action to an app-side handler.

use ::local_control::auth::CredentialGrant;
use ::local_control::{
    Action, ActionKind, ControlError, ErrorCode, InstanceId, RequestEnvelope, ResponseEnvelope,
};
use ptermui::{Entity, ModelContext, SingletonEntity};

use crate::local_control::handlers::{
    app_state, close, metadata, metadata_config, settings_surfaces,
};
use crate::local_control::permissions::{
    ensure_action_allowed, ensure_feature_enabled, ensure_protocol_version, ensure_relay_allows,
};
use crate::local_control::resolver::{validate_action_params, validate_action_target};

/// Where a request came from, which decides the grant it is checked against.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Origin {
    /// The loopback server: the feature flag and Settings > Scripting.
    Local,
    /// The Polaris relay: read-only, or "Let Polaris control this terminal".
    Relay,
}

/// PtermUI model that executes already-authenticated local-control actions.
pub struct LocalControlBridge {
    instance_id: Option<InstanceId>,
}

impl Entity for LocalControlBridge {
    type Event = ();
}

impl SingletonEntity for LocalControlBridge {}

impl LocalControlBridge {
    pub fn new(_ctx: &mut ModelContext<Self>) -> Self {
        Self { instance_id: None }
    }

    pub(super) fn set_instance_id(&mut self, instance_id: InstanceId) {
        self.instance_id = Some(instance_id);
    }

    /// The identity relay requests run under; local control's when it is
    /// published, else one made for this run (local control is not published
    /// on Windows, the relay is).
    fn ensure_instance_id(&mut self) -> InstanceId {
        self.instance_id.get_or_insert_with(InstanceId::new).clone()
    }

    /// Runs a request that arrived over the Polaris relay. The relay already
    /// checked the controller's key (`terminal.control`) and that it may reach
    /// this terminal, so the request carries a grant for exactly its own
    /// action. Instead of the local-control flag and Settings > Scripting, it
    /// passes [`ensure_relay_allows`]: read-only actions, or any action while
    /// "Let Polaris control this terminal" is on.
    pub(super) fn handle_relay_request(
        &mut self,
        request: RequestEnvelope,
        ctx: &mut ModelContext<Self>,
    ) -> ResponseEnvelope {
        let grant = CredentialGrant::new(
            self.ensure_instance_id(),
            request.action.kind,
            chrono::Duration::seconds(60),
        );
        self.run(request, grant, Origin::Relay, ctx)
    }

    /// A pane's current screen and a live receiver of its PTY bytes, for the
    /// relay's `attach`. `None` when the pane is not a local terminal here.
    /// Watching only reads, so it needs no grant beyond being signed in.
    pub(super) fn relay_attach(
        &mut self,
        pane: &str,
        ctx: &mut ModelContext<Self>,
    ) -> Option<(String, async_broadcast::Receiver<std::sync::Arc<Vec<u8>>>)> {
        let view = metadata::pane_terminal_view(pane, ctx)?;
        view.read(ctx, |view, ctx| {
            Some((view.relay_screen_text(), view.relay_pty_reads(ctx)?))
        })
    }

    pub(super) fn handle_request(
        &mut self,
        request: RequestEnvelope,
        grant: CredentialGrant,
        ctx: &mut ModelContext<Self>,
    ) -> ResponseEnvelope {
        self.run(request, grant, Origin::Local, ctx)
    }

    fn run(
        &mut self,
        request: RequestEnvelope,
        grant: CredentialGrant,
        origin: Origin,
        ctx: &mut ModelContext<Self>,
    ) -> ResponseEnvelope {
        let gate = match origin {
            Origin::Local => ensure_feature_enabled(),
            Origin::Relay => ensure_relay_allows(request.action.kind, ctx),
        };
        if let Err(error) = gate {
            return ResponseEnvelope::error(request.request_id, error);
        }
        if let Err(error) = ensure_protocol_version(request.protocol_version) {
            return ResponseEnvelope::error(request.request_id, error);
        }
        let Some(instance_id) = &self.instance_id else {
            return ResponseEnvelope::error(
                request.request_id,
                ControlError::new(
                    ErrorCode::BridgeUnavailable,
                    "local-control bridge has no active instance identity",
                ),
            );
        };
        if let Err(error) = validate_request_authority(instance_id, &request.action, &grant) {
            return ResponseEnvelope::error(request.request_id, error);
        }
        if origin == Origin::Local
            && let Err(error) = ensure_action_allowed(request.action.kind, ctx)
        {
            return ResponseEnvelope::error(request.request_id, error);
        }
        if let Err(error) = validate_action_target(request.action.kind, &request.target) {
            return ResponseEnvelope::error(request.request_id, error);
        }
        let result = match request.action.kind {
            ActionKind::InstanceList => metadata::instance(&self.instance_id),
            ActionKind::InstanceInspect => metadata::inspect(&self.instance_id, ctx),
            ActionKind::AppPing => metadata::ping(&self.instance_id),
            ActionKind::AppVersion => metadata::version(&self.instance_id),
            ActionKind::AppActive => metadata::active(&self.instance_id, ctx),
            ActionKind::CapabilityList => Ok(metadata::capability_list()),
            ActionKind::CapabilityInspect => metadata::capability_inspect(&request.action),
            ActionKind::ActionList => Ok(metadata::action_list()),
            ActionKind::ActionInspect => metadata::action_inspect(&request.action),
            ActionKind::SurfaceList => metadata::surface_list(ctx),
            ActionKind::WindowList => metadata::window_list(&request.target, ctx),
            ActionKind::WindowInspect => metadata::window_inspect(&request.target, ctx),
            ActionKind::TabList => metadata::tab_list(&request.target, ctx),
            ActionKind::TabInspect => metadata::tab_inspect(&request.target, ctx),
            ActionKind::AppFocus
            | ActionKind::WindowCreate
            | ActionKind::WindowFocus
            | ActionKind::TabCreate
            | ActionKind::TabActivate
            | ActionKind::TabMove
            | ActionKind::PaneSplit
            | ActionKind::PaneFocus
            | ActionKind::PaneNavigate
            | ActionKind::PaneResize
            | ActionKind::PaneMaximize
            | ActionKind::PaneUnmaximize
            | ActionKind::SessionActivate
            | ActionKind::SessionPrevious
            | ActionKind::SessionNext
            | ActionKind::SessionReopenClosed
            | ActionKind::InputInsert
            | ActionKind::InputReplace
            | ActionKind::SurfaceSettingsOpen
            | ActionKind::SurfaceCommandPaletteOpen
            | ActionKind::SurfaceCommandSearchOpen
            | ActionKind::SurfaceThemePickerOpen
            | ActionKind::SurfaceKeybindingsOpen
            | ActionKind::SurfacePtermDriveOpen
            | ActionKind::SurfacePtermDriveToggle
            | ActionKind::SurfaceResourceCenterToggle
            | ActionKind::SurfaceAiAssistantToggle
            | ActionKind::SurfaceCodeReviewOpen
            | ActionKind::SurfaceCodeReviewToggle
            | ActionKind::SurfaceProjectExplorerOpen
            | ActionKind::SurfaceGlobalSearchOpen
            | ActionKind::SurfaceConversationListOpen
            | ActionKind::SurfaceLeftPanelToggle
            | ActionKind::SurfaceRightPanelToggle
            | ActionKind::SurfaceVerticalTabsOpen
            | ActionKind::SurfaceVerticalTabsToggle
            | ActionKind::SurfaceAgentManagementOpen
            | ActionKind::FileOpen => app_state::handle(
                &self.instance_id,
                request.action.kind,
                &request.action.params,
                &request.target,
                ctx,
            ),
            ActionKind::TabRename => metadata_config::tab_rename(
                &self.instance_id,
                &request.target,
                &request.action,
                ctx,
            ),
            ActionKind::TabResetName => {
                metadata_config::tab_reset_name(&self.instance_id, &request.target, ctx)
            }
            ActionKind::TabColorSet => metadata_config::tab_color_set(
                &self.instance_id,
                &request.target,
                &request.action,
                ctx,
            ),
            ActionKind::TabColorClear => {
                metadata_config::tab_color_clear(&self.instance_id, &request.target, ctx)
            }
            ActionKind::PaneList => metadata::pane_list(&request.target, ctx),
            ActionKind::PaneInspect => metadata::pane_inspect(&request.target, ctx),
            ActionKind::PaneRename => metadata_config::pane_rename(
                &self.instance_id,
                &request.target,
                &request.action,
                ctx,
            ),
            ActionKind::PaneResetName => {
                metadata_config::pane_reset_name(&self.instance_id, &request.target, ctx)
            }
            ActionKind::SessionList => metadata::session_list(&request.target, ctx),
            ActionKind::SessionInspect => metadata::session_inspect(&request.target, ctx),
            ActionKind::ThemeList => settings_surfaces::theme_list(ctx),
            ActionKind::ThemeGet => settings_surfaces::theme_get(ctx),
            ActionKind::ThemeSet
            | ActionKind::ThemeSystemSet
            | ActionKind::ThemeLightSet
            | ActionKind::ThemeDarkSet => metadata_config::theme_set(
                &self.instance_id,
                request.action.kind,
                &request.action,
                ctx,
            ),
            ActionKind::AppearanceGet => settings_surfaces::appearance_get(ctx),
            ActionKind::AppearanceFontSizeIncrease
            | ActionKind::AppearanceFontSizeDecrease
            | ActionKind::AppearanceFontSizeReset
            | ActionKind::AppearanceZoomIncrease
            | ActionKind::AppearanceZoomDecrease
            | ActionKind::AppearanceZoomReset => {
                metadata_config::appearance_mutation(&self.instance_id, request.action.kind, ctx)
            }
            ActionKind::SettingList => settings_surfaces::setting_list(&request.action, ctx),
            ActionKind::SettingGet => settings_surfaces::setting_get(&request.action, ctx),
            ActionKind::SettingSet => metadata_config::setting_set(&request.action, ctx),
            ActionKind::SettingToggle => metadata_config::setting_toggle(&request.action, ctx),
            ActionKind::KeybindingList => settings_surfaces::keybinding_list(ctx),
            ActionKind::KeybindingGet => settings_surfaces::keybinding_get(&request.action, ctx),
            ActionKind::WindowClose => close::window_close(&self.instance_id, &request, ctx),
            ActionKind::TabClose => close::tab_close(&self.instance_id, &request, ctx),
            ActionKind::PaneClose => close::pane_close(&self.instance_id, &request, ctx),
        };
        match result {
            Ok(data) => ResponseEnvelope::ok(request.request_id, data),
            Err(error) => ResponseEnvelope::error(request.request_id, error),
        }
    }
}

pub(crate) fn validate_request_authority(
    instance_id: &InstanceId,
    action: &Action,
    grant: &CredentialGrant,
) -> Result<(), ControlError> {
    grant.verify_for_action(instance_id, action.kind)?;
    if !action.kind.is_implemented() {
        return Err(ControlError::new(
            ErrorCode::UnsupportedAction,
            format!(
                "{} is not implemented by this local-control bridge",
                action.kind.as_str()
            ),
        ));
    }
    validate_action_params(action)
}
