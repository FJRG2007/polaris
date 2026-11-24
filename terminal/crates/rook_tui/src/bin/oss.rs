//! OSS-channel `rook-tui` binary and `default-run` target.
//!
//! This is what bare `cargo run -p rook_tui` builds, so it hand-builds a
//! production config and needs no internal `rook-channel-config` generator
//! (mirrors `app/src/bin/oss.rs`). It is a console application (no GUI window,
//! no app bundle), so unlike the GUI binaries it sets no `windows_subsystem`
//! attribute and embeds no `Info.plist`.

use anyhow::Result;
use rook_core::AppId;
use rook_core::channel::{Channel, ChannelConfig, ChannelState, OzConfig, RookServerConfig};

fn main() -> Result<()> {
    let mut state = ChannelState::new(
        Channel::Oss,
        ChannelConfig {
            app_id: AppId::new("dev", "rook", "RookTui"),
            logfile_name: "rook-tui.log".into(),
            server_config: RookServerConfig::without_server(),
            oz_config: OzConfig::without_server(),
            telemetry_config: None,
            crash_reporting_config: None,
            autoupdate_config: None,
            mcp_static_config: None,
        },
    );
    if cfg!(debug_assertions) {
        state = state.with_additional_features(rook_core::features::DEBUG_FLAGS);
    }
    ChannelState::set(state);

    rook_tui::run()
}
