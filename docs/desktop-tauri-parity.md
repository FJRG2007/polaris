# Desktop: Tauri parity ledger

The Polaris desktop app moves from Electron (`desktop/`) to a shared Rust core
(`desktop-tauri/polaris-client`) under a light native shell (`desktop-tauri/src-tauri`,
Tauri 2). This file is the inventory that decides when that can happen. Every
module of the Electron app has one row; a row is `done` only when the Tauri app
does the same thing, verified, on Windows, macOS and Linux.

## Acceptance criteria for removing Electron

All of these hold, measured, before the Electron app stops being the shipped one:

1. **End users notice nothing.** The shipped desktop app stays Electron, untouched,
   until every row below is `done`. The Tauri beta is not installed, offered or
   auto-updated to anybody: no release, no installer, no update feed, no link to it.
   The web dashboard, the browser extension and the server behave exactly as before;
   nothing outside `desktop-tauri/` and this file changes for the beta.
2. **CI/CD stays exactly as fast.** No new workflow, no new job, and no Rust step in
   an existing workflow. The beta lives in its own Cargo workspace so no existing
   job builds it (see [Workspace and CI](#workspace-and-ci)).
3. **Startup time and memory no worse than Electron, measured** on the same machine,
   same Polaris, cold and warm start, idle and in a call - numbers recorded here.
4. **Every row below is `done`**, including the release, update and signing pipeline,
   and the move of an installed Electron app (settings, server list, API key) to the
   Tauri app happens from the Update button with nothing typed.
5. The cutover release is itself an ordinary Electron update: an installed app is
   never asked to download something by hand.

## Status

| Part | Status |
| --- | --- |
| `polaris-client`: address, API key, identity probe, API-key calls, unit tests | scaffolded |
| Tauri shell: single instance, first-run page, saved server in the window, tray Open/Quit, `polaris://` registration | scaffolded |
| Everything else in the tables below | todo |
| Startup / memory measurement against Electron | todo |

Statuses: `todo` (nothing yet), `scaffolded` (exists in the beta, not at parity),
`done` (at parity, verified on all three systems).

## Workspace and CI

`desktop-tauri/` is its own Cargo workspace (`desktop-tauri/Cargo.toml`, its own
`Cargo.lock` and `rust-toolchain.toml`), not a member of the root one, and the
client core is `desktop-tauri/polaris-client`, not `crates/polaris-client`. Why:

- `.github/workflows/ci.yml` runs `cargo clippy --all-targets` and `cargo test --all`
  over the root workspace and is triggered by `crates/**`, `Cargo.toml` and
  `Cargo.lock`. A member there would add a WebView toolchain (WebKitGTK on the
  Ubuntu runner) and minutes to every run, and a file under `crates/` would start a
  run that checks nothing of it.
- `dashboard-publish.yml` rebuilds and republishes the host daemon image when
  `crates/polaris-hostd/` or the root `Cargo.toml`/`Cargo.lock` change. A new
  member changes the root lockfile, which would rebuild hostd for nothing.
- `desktop.yml` watches `desktop/**`; `desktop-tauri/**` does not match it.
- The root `.dockerignore` keeps `**/target`, so a local beta build never enters the
  hostd build context.

The same pattern is already used by `desktop/vpn-helper` (its own workspace). When
the Tauri app replaces Electron, its CI is added to `desktop.yml` in place of the
Electron build, not beside it.

`polaris-client` is meant to be shared by every native shell later (TV, a CLI);
moving it then is a path change in one `Cargo.toml`.

## Versions in use

Verified on crates.io on 2026-11-13; latest stable 2.x (the 3.0 alphas are not used).
Pinned with `=` in the manifests; `desktop-tauri/Cargo.lock` is committed.

| Crate | Version | Used now |
| --- | --- | --- |
| tauri (feature `tray-icon`) | 2.12.5 | yes |
| tauri-build | 2.7.4 | yes |
| tauri-plugin-single-instance (feature `deep-link`) | 2.5.5 | yes |
| tauri-plugin-deep-link | 2.6.3 | yes |
| tauri-plugin-notification | 2.8.1 | no (planned) |
| tauri-plugin-global-shortcut | 2.4.1 | no (planned) |
| tauri-plugin-updater | 2.14.1 | no (planned) |
| tauri-plugin-autostart | 2.7.0 | no (planned) |
| tauri-plugin-window-state | 2.5.0 | no (planned) |
| reqwest (features `rustls`, `json`) | 0.13.5 | yes; `rustls` uses rustls-platform-verifier, so the system trust store |
| wiremock (tests only) | 0.6.5 | yes |

The Tauri plugins need Rust 1.90, so the beta workspace says `rust-version = "1.90"`.

## Beta identity

| | Electron (shipped) | Tauri beta |
| --- | --- | --- |
| Identifier / bundle id | `io.github.fjrg2007.polaris` | `io.github.fjrg2007.polaris.beta` |
| Product name | Polaris | Polaris Beta |
| Data folder | Electron `userData` | the beta's own config dir (`settings.json`) |
| Bundling | Electron Forge makers | `bundle.active: false` - no installer is built |
| `polaris://` | registered by the installer and at start | in `tauri.conf.json`; registered at run time only in debug builds (Windows/Linux). Running a debug beta takes `polaris://` from the Electron app on that machine until Electron starts again and registers itself |

Both can be installed side by side. The final identifier at cutover is an open
decision: reusing `io.github.fjrg2007.polaris` keeps the macOS identity, a new one
keeps the beta's data apart.

## Release, update and signing pipeline (must keep working)

Electron stays the shipped app until full parity, and nothing in `desktop/` or its
workflow changes for the beta:

- `.github/workflows/desktop.yml` typechecks and tests `desktop/**`, and builds and
  publishes installers only on a pushed `desktop-v<version>` tag (or by hand). A
  merged version bump publishes nothing until the tag is pushed.
- The installed app updates itself from GitHub releases (`releases.ts`,
  `updates.ts`): the highest non-draft, non-prerelease tag starting `desktop-v`.
  A Tauri release, when one exists, must never use the `desktop-v` prefix and must be
  a prerelease, or every Electron install would try to update to it.
- Signing is optional and must never break updates: an unsigned or failed signing
  still publishes, and no Windows or Linux update path may require a publisher or a
  signature (SignPath, `WINDOWS_CERTIFICATE_*`, `APPLE_*` secrets, see
  `desktop/README.md` and `desktop/CODE_SIGNING.md`). On macOS, Squirrel.Mac checks an
  update against the running app's signature, so an identity change there is real.
- The Tauri updater (`tauri-plugin-updater`) always verifies its own minisign
  signature with a key Polaris generates. That is not third-party signing, but its
  private key must be kept and backed up like the TV signing key: losing it strands
  every install. Code signing (Authenticode, Developer ID) stays optional, as now.
- The switch itself: Electron installs through Squirrel (Windows), a zip/dmg (macOS),
  deb/AppImage (Linux). Tauri bundles NSIS/MSI, app/dmg, deb/rpm/AppImage. The last
  Electron update has to install the Tauri app and remove the Squirrel install,
  carrying `settings.json`, `instances.json` and the server list over, and the API key
  (Electron `safeStorage`) or ask for it once.

## Electron main process (`desktop/src/main`)

| Module | What it does | Tauri 2 / Rust equivalent | Status | Risks |
| --- | --- | --- | --- | --- |
| adb-client | ADB wire protocol over TCP (connect, auth, shell, push) for installing on a TV | `polaris-client::adb_client` (`tokio` TCP, `rsa` auth, A_STLS over `tokio-rustls`); link trait shared with USB | scaffolded | tested against an in-process fake adbd (auth, prompt, shell, push, STLS, TLS refused); key format and token signature byte-identical to the TS module (fixture); never run against a real TV; a cancel drops the open instead of `close()` racing it |
| adb-pairing | Android 11+ Wireless debugging pairing (TLS + SPAKE2 + six-digit code) | `polaris-client::adb_pairing` (`rustls` TLS 1.3, `export_keying_material`, `aes-gcm`, `hkdf`) | scaffolded | exchange tested over a real in-memory TLS 1.3 session (both ends export the same material) and a scripted TV; certificate bytes identical to the TS module (fixture); never paired with a real TV |
| adb-spake2 | SPAKE2 over Ed25519 exactly as BoringSSL's spake25519 | `polaris-client::adb_spake2`, own implementation over `curve25519-dalek` | scaffolded | meets the cross-implementation vectors the TS tests pin (`spake2-vectors.py`); BoringSSL publishes none, so no real adbd has checked it |
| annotate-overlay | See-through window over the shared display showing call strokes | shell: transparent, always-on-top window, `set_ignore_cursor_events` | todo | macOS transparency needs `macos-private-api`; full-screen games |
| api-key-store | API key encrypted by the OS (`safeStorage`), never in plain text | `keyring` crate (Credential Manager, Keychain, Secret Service) | todo | Linux without a secret service: keep it in memory only, as now; migrating Electron's encrypted key |
| app-badge | Waiting count on the taskbar/Dock/launcher icon | `Window::set_badge_count` (macOS/Linux), `set_overlay_icon` (Windows) | todo | Windows overlay icon has to be drawn per count |
| appimage | Replaces a running AppImage with a verified newer one | `tauri-plugin-updater` (handles AppImage) | todo | SHA256SUMS check moves to the updater's signature |
| call-hotkeys | Holds mute/deafen keys system-wide during a call, one window at a time | `tauri-plugin-global-shortcut` | todo | Wayland has no global shortcuts without a portal |
| context-menu | Right-click menu (copy, paste, links) in every window | WebView2/WebKit draw their own; custom items via the Tauri menu API | todo | menus differ per engine |
| deep-links | What a `polaris://` link does once it arrives (queued until ready) | `tauri-plugin-deep-link` `on_open_url` + single-instance `deep-link` feature | scaffolded | beta only registers the scheme and brings the window forward; the page a link names is not opened yet |
| deploy-outcome | Words for a finished deployment notice (pure) | `polaris-client` (pure function) | todo | none |
| docker | Local Docker run with argument lists, never a shell | `std::process::Command` with args | todo | none |
| folder-zip | Zips a folder for "Upload a folder" (skips `node_modules`, `.git`) | `zip` crate + `walkdir`, in `polaris-client` | todo | streaming large folders |
| game-detect | Which known game is running, from the process list | `sysinfo` crate | todo | per-platform process names |
| host-transfer | Host list to/from a file, clipboard or QR code | `tauri-plugin-dialog`, `tauri-plugin-clipboard-manager` | todo | none |
| index | App entry: windows, server list, first-run, failover, updates, notices, wiring | `src-tauri/src/main.rs` | scaffolded | first run and saved server only; no offline page or server list yet |
| install-tool | Installs an allow-listed tool after the app's own confirmation dialog | `std::process::Command` + `tauri-plugin-dialog` | todo | keep the allow-list in Rust, never page-supplied |
| instance-store | Persists what each server said about itself (id, local addresses, CA pin) | `polaris-client` + a JSON file in the config dir | todo | none |
| ipc | Every page request checked by window kind, origin and schema | Tauri commands + capabilities (remote capability scoped to the configured origin, added at run time with `add_capability`) | todo | the page bridge must stay the same `window.polarisDesktop` so the dashboard does not change |
| key-flow | Gets the push API key, checks it with `GET /api/v1/me`, keeps it | `polaris-client::ApiClient::me` + api-key-store | scaffolded | `me()` and the key shape exist; no window yet |
| known-games | The table of recognized game executables | data module in `polaris-client` | todo | none |
| local-ca-pin | Trusts the same Polaris's local CA on its proven local address | custom `rustls` `ServerCertVerifier`; webview side via WebView2/WebKit certificate events | todo | wry exposes no certificate-error hook; may need platform code per engine |
| login-item | Open with the computer (Squirrel launcher on Windows, autostart file on Linux) | `tauri-plugin-autostart` | todo | the Squirrel entry has to be removed at cutover |
| mac-signature | Whether the macOS app has a Developer ID (Squirrel.Mac needs it) | not needed with `tauri-plugin-updater` | todo | Gatekeeper still wants notarization for a clean first open |
| mail-handler | Registers on Windows as a `mailto:` handler (Capabilities registry keys) | `winreg` crate in the shell; deep-link plugin for the scheme | todo | registry keys must be removed on uninstall |
| menu | Application menu (File, Edit, View, Window, Help + update offer) | Tauri `menu` API | todo | macOS only draws it, as now |
| navigation | Where a window may go; keeps the bridge on the configured origin | `on_navigation` / `on_new_window` handlers on the webview | todo | the beta does not restrict navigation yet; the remote page gets no IPC (no `remote` capability) |
| notice-layout | Notice title/body per system (pure) | `polaris-client` (pure) | todo | none |
| notice-once | Which `once` notices repeat one already shown (pure) | `polaris-client` (pure) | todo | none |
| notices | OS notices, replaced by tag | `tauri-plugin-notification` | todo | replacing by tag is not supported on every platform |
| permissions | Deny-by-default browser permissions, only for the configured Polaris | WebView2 `PermissionRequested`, WebKit permission signals via `with_webview` | todo | no cross-platform Tauri API; platform code per engine |
| polaris-api | API-key calls, Bearer header, refusals, local-address failover | `polaris-client::ApiClient` | scaffolded | failover and the upload (`sendFile`) are not ported; Chromium `net` used the window's proxy, reqwest uses the system proxy |
| push-local | Build with local Docker, upload the image, follow the deployment log | `polaris-client` + `docker` module | todo | streaming upload with chunked encoding; types (`ImageTarget`, `Started`, `DeploymentState`) exist |
| reachability | Network error codes into sentences; offline-page detection | `polaris-client::net` (`NetFailure`) | scaffolded | reqwest has no typed DNS/TLS error, so those two are read from the error text |
| releases | Highest published `desktop-v` release newer than this one (pure) | `tauri-plugin-updater` endpoint | todo | see the release section |
| same-instance | Whether a typed address is a server already listed (by signature) | `polaris-client` | todo | needs the instance signature check from core |
| screen-share | Screen/window list with thumbnails for the dashboard's own picker | platform capture (`windows-capture`/ScreenCaptureKit/PipeWire) or the engine's own picker | todo | biggest gap: no `setDisplayMediaRequestHandler` equivalent; WebKitGTK screen share is limited |
| settings | JSON settings: server, server list, per-service push folder | JSON in the config dir | scaffolded | only `server` exists; no migration of Electron's file yet |
| squirrel | Squirrel install/update/uninstall hooks (shortcuts) | NSIS/MSI bundler | todo | cutover must uninstall Squirrel cleanly |
| tray | Tray icon menu (servers, API key, update) on Windows/Linux | Tauri `tray-icon` | scaffolded | only Open and Quit |
| tv-install | Installs Polaris TV on a set, step by step, with a backup first | `polaris-client` module over adb-* | todo | long; needs real sets to verify |
| tv-mdns | Finds TVs over multicast DNS / DNS-SD | `mdns-sd` crate | todo | firewall prompts on Windows |
| tv-path | Which install path a TV takes, from core's tv-compat data | `polaris-client` (pure) | todo | data must stay generated from core |
| tv-wait | Waits for the TV's debugging port instead of asking to retry | `polaris-client` (tokio) | todo | none |
| update-first | Whether a start updates before it opens (pure) | shell + updater plugin | todo | must always end in an app that opens |
| update-ready | The downloaded update waiting for a restart (pure) | shell state + updater plugin | todo | none |
| updates | Self-update from GitHub releases every few hours | `tauri-plugin-updater` | todo | see the release section; never enabled in the beta |
| usb-link | TV USB connection through a hidden WebUSB page | `nusb` crate, no hidden page | todo | WinUSB driver binding on Windows |
| voice-widget | Always-on-top voice widget over games | transparent always-on-top window | todo | exclusive full-screen games cover it, as now |
| vpn-helper-client | Talks to the VPN service over loopback with mutual challenge | `polaris-client` module (tokio TCP + HMAC) | todo | the service (`desktop/vpn-helper`) is already Rust and stays |
| vpn | Installs and drives the VPN service | shell + vpn-helper-client | todo | elevation prompt per platform |
| window-failover | When the window switches to the local address and back (pure) | `polaris-client` (pure) + webview `navigate` | todo | none |
| windows | Window kinds and their rules (Polaris windows vs own pages) | `WebviewWindowBuilder` + capabilities per window | scaffolded | one main window only |
| zip-rules | What goes into an uploaded folder, and limits (pure) | `polaris-client` (pure) | todo | must stay identical to the dashboard's browser zipper |

## Preload bridges (`desktop/src/preload`)

| Module | What it does | Tauri 2 / Rust equivalent | Status | Risks |
| --- | --- | --- | --- | --- |
| app | `window.polarisDesktop` for the dashboard, one IPC per function | initialization script defining the same object over `invoke`, remote capability for the configured origin only | todo | the object's shape is a contract with `dashboard/apps/web/src/lib/desktop-bridge.ts`; it must not change |
| local | `window.polarisLocal` for the app's own pages, per window kind | Tauri commands from local pages | scaffolded | only `connect` exists |
| text-size | Carries the account's text size both ways | initialization script + event | todo | none |
| usb | Byte bridge for the hidden WebUSB page | removed: `nusb` in Rust | todo | none |

## Shared modules (`desktop/src/shared`)

| Module | What it does | Equivalent | Status | Risks |
| --- | --- | --- | --- | --- |
| annotate | Stroke schema for the overlay | serde types | todo | none |
| api-key | API key shape `plk_<8>.<secret>` | `polaris-client::ApiKey` | scaffolded | same regex and sentences; `Debug` redacts |
| bridge | Bridge channel names and types | command names | todo | none |
| call-hotkeys | Dashboard key spelling to OS accelerators | parser for global-shortcut | todo | none |
| deep-link | `polaris://open?server=&path=` parsing and limits | `polaris-client` module | todo | any website can start such a link: same limits |
| install-tools | Allow-listed tools and how to start them | Rust table | todo | none |
| mailto | `mailto:` to the Mail composer path | `polaris-client` (pure) | todo | none |
| server-address | Address normalization and refusals | `polaris-client::InstanceUrl` | scaffolded | same rules and sentences, unit-tested |
| server-identity | Is this a Polaris (identity, instance, health; 4 KiB cap; 5 s) | `polaris-client::identity::probe` | scaffolded | probe ported and tested; the 30 s verdict cache is not |
| servers | The list of known servers | `polaris-client` | todo | none |
| text-size | Text size schema | serde type | todo | none |
| title-bar | Window button colours over the page header | `decorations(false)` + own buttons, or macOS `titleBarStyle` | todo | Windows has no title-bar overlay in Tauri |
| tv-address | TV address parsing | `polaris-client` | todo | none |
| update-check | "Check for updates" sentences (pure) | `polaris-client` | todo | none |
| update-ready | Update-ready state as the dashboard sees it | serde type | todo | none |
| usb-adb | ADB over WebUSB bulk endpoints | `nusb` | todo | none |
| voice-widget | Voice widget state schema | serde types | todo | none |
| window-place | Restores the window where it was, unless that display is gone | `tauri-plugin-window-state` | todo | the plugin must fall back when a monitor is gone |

## App pages (`desktop/src/renderer`)

| Page | What it does | Status |
| --- | --- | --- |
| connect | Settings and first run: the server list, add, rename, remove, open | scaffolded (`desktop-tauri/ui`: one address field) |
| api-key | Paste and check the push key | todo |
| push | Pick folder and platform, follow build, upload and deployment | todo |
| tv | Find a TV and install Polaris TV | todo |
| usb | Hidden WebUSB holder | replaced by `nusb` (todo) |
| overlay | Strokes over a shared display | todo |
| voice-widget | The call's people over other windows | todo |
| updating | Shown while an update installs before the app opens | todo |
| dom, styles, fonts, mark | Shared page helpers, styles and assets | todo (beta uses system fonts) |

The beta's first-run page is English only; the shipped app's pages are bilingual and
the Tauri pages must be too before cutover.

## Verified in this phase

On Windows 11 (MSVC toolchain), in `desktop-tauri/`:
`cargo check --workspace`, `cargo build -p polaris-desktop-beta` (links),
`cargo test -p polaris-client` (unit and wiremock tests, no network),
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`.
The beta was not launched in this phase, and nothing was built on macOS or Linux.
