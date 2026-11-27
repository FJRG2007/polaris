//! Permission checks for local control.
use ::local_control::{ActionKind, ControlError, ErrorCode, PROTOCOL_VERSION};
use ptermui::{ModelContext, SingletonEntity};

use crate::features::FeatureFlag;
use crate::local_control::LocalControlBridge;
use crate::settings::{LocalControlSettings, PolarisControlSettings};

pub(super) fn pterm_control_cli_enabled() -> bool {
    FeatureFlag::PtermControlCli.is_enabled()
}

pub(super) fn ensure_protocol_version(protocol_version: u32) -> Result<(), ControlError> {
    if protocol_version == PROTOCOL_VERSION {
        return Ok(());
    }
    Err(ControlError::new(
        ErrorCode::ProtocolVersionUnsupported,
        format!("unsupported protocol version {protocol_version}"),
    ))
}

pub(super) fn ensure_feature_enabled() -> Result<(), ControlError> {
    if pterm_control_cli_enabled() {
        return Ok(());
    }
    Err(ControlError::new(
        ErrorCode::LocalControlDisabled,
        "Polaris Terminal control CLI is disabled by feature flag",
    ))
}

#[cfg(test)]
pub(crate) fn capabilities() -> Vec<ActionKind> {
    ActionKind::implemented_metadata()
        .into_iter()
        .map(|metadata| metadata.kind)
        .collect()
}

pub(super) fn ensure_action_allowed(
    action: ActionKind,
    ctx: &mut ModelContext<LocalControlBridge>,
) -> Result<(), ControlError> {
    let settings = LocalControlSettings::as_ref(ctx);
    ensure_settings_allow_action(settings, action)
}

/// Actions that only read: lists, inspections and the app's own metadata. The
/// signed-in Polaris may run these through the relay with no further grant;
/// anything not named here changes the terminal and needs "Let Polaris control
/// this terminal". Settings reads are left out because a setting can hold a
/// path or a name the person did not mean to share.
pub(crate) fn is_read_only(action: ActionKind) -> bool {
    matches!(
        action,
        ActionKind::InstanceList
            | ActionKind::InstanceInspect
            | ActionKind::AppPing
            | ActionKind::AppVersion
            | ActionKind::AppActive
            | ActionKind::CapabilityList
            | ActionKind::CapabilityInspect
            | ActionKind::WindowList
            | ActionKind::WindowInspect
            | ActionKind::TabList
            | ActionKind::TabInspect
            | ActionKind::PaneList
            | ActionKind::PaneInspect
            | ActionKind::SessionList
            | ActionKind::SessionInspect
            | ActionKind::ThemeList
            | ActionKind::ThemeGet
            | ActionKind::AppearanceGet
            | ActionKind::KeybindingList
            | ActionKind::KeybindingGet
            | ActionKind::ActionList
            | ActionKind::ActionInspect
            | ActionKind::SurfaceList
    )
}

/// The check a relay request passes instead of the feature flag and Settings >
/// Scripting: read-only actions always, everything else only while the person
/// has turned on "Let Polaris control this terminal". The relay is connected
/// only while the terminal is signed in, so a request here comes from that
/// account's instance.
pub(super) fn ensure_relay_allows(
    action: ActionKind,
    ctx: &mut ModelContext<LocalControlBridge>,
) -> Result<(), ControlError> {
    let allows_changes = ctx.has_singleton_model::<PolarisControlSettings>()
        && PolarisControlSettings::as_ref(ctx).allows_changes();
    relay_allows(action, allows_changes)
}

pub(crate) fn relay_allows(action: ActionKind, allows_changes: bool) -> Result<(), ControlError> {
    if allows_changes || is_read_only(action) {
        return Ok(());
    }
    Err(ControlError::new(
        ErrorCode::LocalControlDisabled,
        format!(
            "{} needs \"Let Polaris control this terminal\" turned on in the terminal's Settings > Account",
            action.as_str()
        ),
    ))
}

pub(crate) fn ensure_settings_allow_action(
    settings: &LocalControlSettings,
    action: ActionKind,
) -> Result<(), ControlError> {
    if !settings.is_enabled() {
        return Err(ControlError::new(
            ErrorCode::LocalControlDisabled,
            format!("{} is disabled for local control", action.as_str()),
        ));
    }
    Ok(())
}
