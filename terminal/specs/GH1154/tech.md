# Hide Rook Dock Icon — Tech Spec

## Summary

Add a macOS-only `show_dock_icon` appearance setting that switches Rook between regular and accessory AppKit activation policies. When disabled, Rook is hidden from the Dock and Cmd-Tab while continuing to run.

## Relevant existing code

- `app/src/settings/app_icon.rs` — app icon settings namespace and generated settings state.
- `app/src/settings_view/appearance_page.rs` — Appearance settings UI.
- `app/src/appearance.rs` — runtime appearance/app icon setting handling.
- `app/src/lib.rs` — macOS `AppBuilder` setup before `app_builder.run`.
- `crates/rookui_core/src/platform/mod.rs` and `crates/rookui_core/src/core/app.rs` — platform delegate API.
- `crates/rookui/src/platform/mac/app.rs` — macOS app builder/run wiring.
- `crates/rookui/src/platform/mac/delegate.rs` — macOS platform delegate implementation.
- `crates/rookui/src/platform/mac/objc/app.{h,m}` — AppKit delegate and activation-policy calls.

## Design

### 1. Add a macOS Dock visibility setting

Add a generated setting under `AppIconSettings`:

- Name: `show_dock_icon`
- Type: `bool`
- Default: `true`
- Platform support: `SupportedPlatforms::MAC`
- Sync: disabled, matching app icon settings behavior
- Storage key: `ShowDockIcon`
- TOML path: `appearance.icon.show_dock_icon`
- Description: whether Rook is shown in the macOS Dock and Cmd-Tab switcher.

Keep this as a separate field from `app_icon`. Do not add a hidden variant to `AppIcon`, because `AppIcon` still describes artwork when the Dock icon is visible.

### 2. Apply the saved preference during launch

In `app/src/lib.rs`, after public preferences are available and before `app_builder.run`, read the saved `ShowDockIcon` value from `prefs_for_public_settings` using the generated setting helper, following the same pre-app-read pattern used by `ForceX11`.

Extend `rookui::platform::mac::AppExt` with `set_show_dock_icon_on_launch`, store the value in the macOS backend, and apply it in `rook_app_will_finish_launching`.

Initializing it before launch lets the AppKit layer apply accessory mode as early as practical, reducing visible Dock flicker for users who have already hidden the Dock icon.

### 3. Apply runtime setting changes

Handle the generated changed event alongside `AppIconState` in `AppearanceManager`. On `ShowDockIcon` changes, call the platform delegate to update Dock visibility immediately.

Add a platform delegate method such as `set_dock_icon_visible(visible: bool)`. Non-macOS implementations should be no-ops. The macOS implementation should dispatch to the main queue and call the Objective-C AppKit bridge.

### 4. macOS AppKit bridge

Add `-[RookDelegate setDockIconVisible:]` in Objective-C. It should call:

- `NSApplicationActivationPolicyRegular` when `visible == YES`
- `NSApplicationActivationPolicyAccessory` when `visible == NO`

Return whether AppKit accepted the activation-policy change. If hiding fails, leave or restore the regular policy so Rook remains visible in the Dock.

### 5. Settings UI

Add a switch labelled "Show Rook in Dock" near the existing app icon controls in Appearance settings.

- Default checked state reflects `AppIconSettings::show_dock_icon`.
- Toggle dispatch updates `AppIconSettings.show_dock_icon`.
- Gate display/support via `is_supported_on_current_platform` from the setting metadata rather than compile-time `cfg` checks.
- Include search terms such as "dock", "cmd tab", and "app switcher".

## Behavior flows

### User hides the Dock icon

1. User opens Appearance settings and turns off Show Rook in Dock.
2. `AppIconSettings.show_dock_icon` is saved.
3. `AppearanceManager` receives the changed event.
4. The platform delegate applies accessory activation policy.
5. Rook disappears from the Dock and Cmd-Tab.

### User restores the Dock icon

1. User turns on Show Rook in Dock.
2. `AppIconSettings.show_dock_icon` is saved.
3. `AppearanceManager` receives the changed event.
4. The platform delegate applies regular activation policy.
5. Rook returns to the Dock and Cmd-Tab.

### Launch with hidden Dock icon

1. `app/src/lib.rs` reads `ShowDockIcon` before `app_builder.run`.
2. The macOS app builder stores `show_dock_icon_on_launch`.
3. `rook_app_will_finish_launching` applies the initial activation policy.

## Risks and mitigations

### Risk: users hide the Dock icon without a hotkey

Users can still reach existing visible windows, Mission Control, and other macOS window-management surfaces, but the main intended workflow is hotkey-driven.

Mitigation: keep the setting opt-in, default it to visible, and make the label explicit.

### Risk: AppKit rejects activation-policy changes

Mitigation: check the Objective-C return value. If hiding fails, leave or restore regular activation policy so Rook remains visible in the Dock.

### Risk: non-macOS no-op setting

Mitigation: mark the setting as macOS-only and gate the Appearance row with `is_supported_on_current_platform`.

## Test plan

Automated:

- Add settings/schema coverage ensuring `appearance.icon.show_dock_icon` exists, defaults to `true`, is macOS-only, and does not sync to cloud where practical.
- Add compile coverage for `rookui` macOS code paths in the existing macOS CI job.

Manual macOS:

- Toggle Show Rook in Dock off and verify Rook disappears from the Dock and Cmd-Tab.
- Verify configured global hotkeys still focus/show Rook while Dock visibility is disabled.
- Restart Rook with Show Rook in Dock disabled and verify the app starts in hidden-Dock mode.
- Toggle Show Rook in Dock back on and verify the Dock icon and Cmd-Tab entry return.
- Verify changing the selected app icon still updates Dock art when Show Rook in Dock is enabled.
- Verify non-macOS builds do not show an enabled no-op setting.

## Future considerations

- Consider a separate menu bar/status item recovery surface if user feedback indicates it is needed.
- Consider launch-at-login/background-start behavior as a separate feature for users who want Rook available only through hotkey after boot.
