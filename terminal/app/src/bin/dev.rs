// On Windows, we don't want to display a console window when the application is running in release
// builds. See https://doc.rust-lang.org/reference/runtime.html#the-windows_subsystem-attribute.
#![cfg_attr(feature = "release_bundle", windows_subsystem = "windows")]

use anyhow::Result;
use pterm_core::channel::{Channel, ChannelState};
use pterm_core::features;

// Simple wrapper around polaris_terminal::run() for dev channel builds.
fn main() -> Result<()> {
    ChannelState::set(
        ChannelState::new(Channel::Dev, pterm_channel_config::load_config!("dev"))
            .with_additional_features(features::DEBUG_FLAGS)
            .with_additional_features(features::DOGFOOD_FLAGS)
            .with_additional_features(features::PREVIEW_FLAGS),
    );

    polaris_terminal::run()
}
