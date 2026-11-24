//! Dev-channel `polaris-terminal-tui` binary (internal nightly builds).
//!
//! Mirrors `app/src/bin/dev.rs`: loads the internal `dev` channel config and
//! layers the dev feature flags, then hands off to the shared TUI entry point.

use anyhow::Result;
use pterm_core::channel::{Channel, ChannelState};
use pterm_core::features;

fn main() -> Result<()> {
    ChannelState::set(
        ChannelState::new(Channel::Dev, pterm_channel_config::load_config!("dev"))
            .with_additional_features(features::DEBUG_FLAGS)
            .with_additional_features(features::DOGFOOD_FLAGS)
            .with_additional_features(features::PREVIEW_FLAGS),
    );

    pterm_tui::run()
}
