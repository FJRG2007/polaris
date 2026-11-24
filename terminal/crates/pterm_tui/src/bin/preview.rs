//! Preview-channel `polaris-terminal-tui` binary.
//!
//! Mirrors `app/src/bin/preview.rs`: loads the `preview` channel config and
//! enables the preview feature flags (plus forced login), then hands off to the
//! shared TUI entry point.

use anyhow::Result;
use pterm_core::channel::{Channel, ChannelState};
use pterm_core::features;

fn main() -> Result<()> {
    ChannelState::set(
        ChannelState::new(
            Channel::Preview,
            pterm_channel_config::load_config!("preview"),
        )
        .with_additional_features(features::PREVIEW_FLAGS)
        .with_additional_features(&[features::FeatureFlag::ForceLogin]),
    );

    pterm_tui::run()
}
