//! Local-channel `rook-tui` binary (internal dev builds).
//!
//! Mirrors `app/src/bin/local.rs`: loads the internal `local` channel config
//! (via the `rook-channel-config` generator) and layers the dev feature flags,
//! then hands off to the shared TUI entry point. Run it through
//! `./script/run-tui`, which installs the generator first; running it directly
//! without `rook-channel-config` on PATH will panic with install instructions.

use anyhow::Result;
use rook_core::channel::{Channel, ChannelState};
use rook_core::features;

fn main() -> Result<()> {
    ChannelState::set(
        ChannelState::new(Channel::Local, rook_channel_config::load_config!("local"))
            .with_additional_features(features::DEBUG_FLAGS)
            .with_additional_features(features::DOGFOOD_FLAGS)
            .with_additional_features(features::PREVIEW_FLAGS)
            .with_additional_features(features::LOCAL_FLAGS),
    );

    rook_tui::run()
}
