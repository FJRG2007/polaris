// On Windows, we don't want to display a console window when the application is running in release
// builds. See https://doc.rust-lang.org/reference/runtime.html#the-windows_subsystem-attribute.
#![cfg_attr(feature = "release_bundle", windows_subsystem = "windows")]

use anyhow::Result;
use pterm_core::channel::{Channel, ChannelState};

// Simple wrapper around polaris_terminal::run() for stable channel builds.
fn main() -> Result<()> {
    ChannelState::set(ChannelState::new(
        Channel::Stable,
        pterm_channel_config::load_config!("stable"),
    ));

    polaris_terminal::run()
}
