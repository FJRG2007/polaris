//! Stable-channel `polaris-terminal-tui` binary.
//!
//! Mirrors `app/src/bin/stable.rs`: loads the `stable` channel config with no
//! additional feature flags, then hands off to the shared TUI entry point.

use anyhow::Result;
use pterm_core::channel::{Channel, ChannelState};

fn main() -> Result<()> {
    ChannelState::set(ChannelState::new(
        Channel::Stable,
        pterm_channel_config::load_config!("stable"),
    ));

    pterm_tui::run()
}
