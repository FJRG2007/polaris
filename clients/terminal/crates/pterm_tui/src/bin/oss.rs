//! OSS-channel `polaris-terminal-tui` binary and `default-run` target.
//!
//! This is what bare `cargo run -p pterm_tui` builds, so it hand-builds a
//! production config and needs no internal `polaris-terminal-channel-config` generator
//! (mirrors `app/src/bin/oss.rs`). It is a console application (no GUI window,
//! no app bundle), so unlike the GUI binaries it sets no `windows_subsystem`
//! attribute and embeds no `Info.plist`.

use anyhow::Result;
use pterm_core::AppId;
use pterm_core::channel::{Channel, ChannelConfig, ChannelState, OzConfig, PtermServerConfig};

fn main() -> Result<()> {
    let mut state = ChannelState::new(
        Channel::Oss,
        ChannelConfig {
            app_id: AppId::new("dev", "polaris", "PtermTui"),
            logfile_name: "polaris-terminal-tui.log".into(),
            server_config: PtermServerConfig::without_server(),
            oz_config: OzConfig::without_server(),
            telemetry_config: None,
            crash_reporting_config: None,
            autoupdate_config: None,
            mcp_static_config: None,
        },
    );
    if cfg!(debug_assertions) {
        state = state.with_additional_features(pterm_core::features::DEBUG_FLAGS);
    }
    ChannelState::set(state);

    pterm_tui::run()
}
