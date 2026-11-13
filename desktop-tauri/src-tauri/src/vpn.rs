//! This computer's VPN (`desktop/src/main/vpn.ts` and its handlers in
//! `ipc.ts`): the commands the dashboard calls through `polarisDesktop.vpn` -
//! deviceName, key, up, down, status and joinNetwork - over
//! `polaris_client::vpn`, which installs and drives the service in
//! `desktop/vpn-helper`.
//!
//! Only a Polaris window on the configured Polaris may call them, as
//! `fromPolaris` allows in the Electron app; anything else is answered as the
//! Electron handlers answer it (`null`, `{ nodeId: null }` or the refusal).

use crate::ipc::{from_polaris, REFUSAL};
use crate::Outcome;
use polaris_client::vpn::{join_network, ElevatedInstaller, Vpn};
use polaris_client::vpn_helper::{
    device_name_from, read_join, tailscale_path, this_platform, VpnConnection,
};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// The service this app drives, with the secret it was installed with.
pub struct VpnService(Vpn<ElevatedInstaller>);

impl VpnService {
    /// The secret sits beside the settings, as `vpn-secret` sits in Electron's
    /// `userData`. The helper is the one the app ships (`vpn-helper/` in its
    /// resources); the beta bundles none yet, so its install fails and a
    /// connect is `denied`, as it is when the helper cannot be started.
    pub fn new(app: &AppHandle, config: &Path) -> Self {
        let name = if cfg!(windows) {
            "polaris-vpn-helper.exe"
        } else {
            "polaris-vpn-helper"
        };
        let resources = app.path().resource_dir().unwrap_or_default();
        let own = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| config.to_path_buf());
        let installer = ElevatedInstaller {
            bundled: resources.join("vpn-helper").join(name),
            own_folder: own.join("vpn-helper"),
            platform: this_platform(),
        };
        Self(Vpn::new(config.join("vpn-secret"), installer))
    }
}

fn refused() -> Outcome {
    Outcome::error(REFUSAL)
}

fn outcome(result: Result<(), String>) -> Outcome {
    result.map_or_else(Outcome::error, |()| Outcome::ok())
}

/// What `status` answers (`DesktopVpnStatus`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatus {
    node_id: Option<String>,
}

#[tauri::command]
pub fn vpn_device_name(app: AppHandle, window: WebviewWindow) -> Option<String> {
    from_polaris(&app, &window).then(|| {
        let hostname = sysinfo::System::host_name().unwrap_or_default();
        device_name_from(&hostname)
    })
}

#[tauri::command]
pub async fn vpn_key(
    app: AppHandle,
    window: WebviewWindow,
    vpn: State<'_, VpnService>,
) -> Result<Option<String>, ()> {
    if !from_polaris(&app, &window) {
        return Ok(None);
    }
    Ok(vpn.0.key().await)
}

/// `input` is read with `connectionSchema`'s limits and no other keys.
#[tauri::command]
pub async fn vpn_up(
    app: AppHandle,
    window: WebviewWindow,
    vpn: State<'_, VpnService>,
    input: Value,
) -> Result<Outcome, ()> {
    let connection = VpnConnection::read(&input);
    let Some(connection) = connection.filter(|_| from_polaris(&app, &window)) else {
        return Ok(refused());
    };
    Ok(outcome(vpn.0.up(&connection).await))
}

#[tauri::command]
pub async fn vpn_down(
    app: AppHandle,
    window: WebviewWindow,
    vpn: State<'_, VpnService>,
) -> Result<Outcome, ()> {
    if !from_polaris(&app, &window) {
        return Ok(refused());
    }
    Ok(outcome(vpn.0.down().await))
}

/// Never installs anything: opening the screen raises no prompt.
#[tauri::command]
pub async fn vpn_status(
    app: AppHandle,
    window: WebviewWindow,
    vpn: State<'_, VpnService>,
) -> Result<VpnStatus, ()> {
    if !from_polaris(&app, &window) {
        return Ok(VpnStatus { node_id: None });
    }
    Ok(VpnStatus {
        node_id: vpn.0.status().await,
    })
}

/// Signs this computer into a private network, with a key that works once. A
/// request that does not read is `failed`, as `joinSchema` refuses it.
#[tauri::command]
pub async fn vpn_join(app: AppHandle, window: WebviewWindow, input: Value) -> Outcome {
    if !from_polaris(&app, &window) {
        return refused();
    }
    let Some(input) = read_join(&input) else {
        return Outcome::error("failed");
    };
    let client = PathBuf::from(tailscale_path(this_platform()));
    outcome(join_network(&client, &input).await)
}

#[cfg(test)]
mod tests {
    use crate::ipc::POLARIS_COMMANDS;

    const COMMANDS: [&str; 6] = [
        "vpn_device_name",
        "vpn_key",
        "vpn_up",
        "vpn_down",
        "vpn_status",
        "vpn_join",
    ];

    #[test]
    fn every_vpn_command_is_a_permission_granted_to_a_polaris_window() {
        let manifest = include_str!("../build.rs");
        for command in COMMANDS {
            assert!(manifest.contains(&format!("\"{command}\"")), "{command}");
            let permission = command.replace('_', "-");
            assert!(POLARIS_COMMANDS.contains(&permission.as_str()), "{command}");
        }
    }
}
