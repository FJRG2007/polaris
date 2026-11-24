//! Local-channel `polaris-terminal-tui` binary (internal dev builds).
//!
//! Mirrors `app/src/bin/local.rs`: loads the internal `local` channel config
//! (via the `polaris-terminal-channel-config` generator) and layers the dev feature flags,
//! then hands off to the shared TUI entry point. Run it through
//! `./script/run-tui`, which installs the generator first; running it directly
//! without `polaris-terminal-channel-config` on PATH will panic with install instructions.

use anyhow::Result;
use pterm_core::channel::{Channel, ChannelState};
use pterm_core::features;

fn main() -> Result<()> {
    ChannelState::set(
        ChannelState::new(Channel::Local, pterm_channel_config::load_config!("local"))
            .with_additional_features(features::DEBUG_FLAGS)
            .with_additional_features(features::DOGFOOD_FLAGS)
            .with_additional_features(features::PREVIEW_FLAGS)
            .with_additional_features(features::LOCAL_FLAGS),
    );

    pterm_tui::run()
}
