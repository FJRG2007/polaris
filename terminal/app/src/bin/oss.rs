// On Windows, we don't want to display a console window when the application is running in release
// builds. See https://doc.rust-lang.org/reference/runtime.html#the-windows_subsystem-attribute.
#![cfg_attr(feature = "release_bundle", windows_subsystem = "windows")]

use anyhow::Result;
use pterm_core::AppId;
use pterm_core::channel::{
    AutoupdateConfig, Channel, ChannelConfig, ChannelState, OzConfig, PtermServerConfig,
};

// Simple wrapper around polaris_terminal::run() for Polaris Terminal OSS builds.
fn main() -> Result<()> {
    let mut state = ChannelState::new(
        Channel::Oss,
        ChannelConfig {
            app_id: AppId::new("dev", "polaris", "PolarisTerminal"),
            logfile_name: "polaris-terminal.log".into(),
            server_config: PtermServerConfig::without_server(),
            oz_config: OzConfig::without_server(),
            telemetry_config: None,
            crash_reporting_config: None,
            // Polaris Terminal updates from GitHub releases, so the autoupdate menus have
            // something to offer. `show_autoupdate_menu_items` gates every one
            // of them - the tab-bar pill's menu, the avatar entries and the
            // resource centre's version line - and with it off the pill opened
            // an empty menu and "Update and relaunch Polaris Terminal" was never drawn, so
            // a downloaded update could not be applied from the UI at all. The
            // branches those menus already carry for `Channel::Oss` were dead
            // code. No base URL: `release_assets_directory_url` hardcodes the
            // GitHub one for this channel, and leaving it empty is what the
            // build already did.
            autoupdate_config: Some(AutoupdateConfig {
                releases_base_url: "".into(),
                show_autoupdate_menu_items: true,
            }),
            mcp_static_config: None,
        },
    );
    if cfg!(debug_assertions) {
        state = state.with_additional_features(pterm_core::features::DEBUG_FLAGS);
    }
    ChannelState::set(state);

    polaris_terminal::run()
}

// If we're not using an external plist, embed the following as the Info.plist.
#[cfg(all(not(feature = "extern_plist"), target_os = "macos"))]
embed_plist::embed_info_plist_bytes!(r#"
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>English</string>
    <key>CFBundleDisplayName</key>
    <string>PolarisTerminal</string>
    <key>CFBundleExecutable</key>
    <string>polaris-terminal</string>
    <key>CFBundleIdentifier</key>
    <string>dev.polaris.PolarisTerminal</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>PolarisTerminal</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.developer-tools</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>UIDesignRequiresCompatibility</key>
    <true/>
    <key>CFBundleURLTypes</key>
    <array><dict><key>CFBundleURLName</key><string>Custom App</string><key>CFBundleURLSchemes</key><array><string>polaris-terminal</string></array></dict></array>
    <key>NSHumanReadableCopyright</key>
    <string>© 2026, Denver Technologies, Inc</string>
    </dict>
    </plist>
"#.as_bytes());
