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
| `polaris-client`: failover, streamed upload, docker, push, folder zip, install tools, games | scaffolded |
| Tauri shell: single instance, servers page, Polaris window with navigation, permissions, failover and local CA pin, tray, `polaris://` links, OS switches, notices, push and developer commands | scaffolded |
| Everything else in the tables below | todo |
| Startup / memory measurement against Electron | scaffolded: beta measured hidden by `tools/measure-startup`; Electron by hand only (see [Startup and memory](#startup-and-memory)) |

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
| tauri (features `image-png`, `tray-icon`) | 2.12.5 | yes |
| tauri-build | 2.7.4 | yes |
| tauri-plugin-single-instance (feature `deep-link`) | 2.5.5 | yes |
| tauri-plugin-window-state | 2.5.0 | yes |
| tauri-plugin-deep-link | 2.6.3 | yes |
| tauri-plugin-notification | 2.8.1 | yes |
| tauri-plugin-global-shortcut | 2.4.1 | yes |
| rustls / rustls-platform-verifier | 0.23.46 / 0.7.1 | yes (the local CA pin verifier; the versions reqwest uses) |
| tokio (shell, `sync`, `time`, `fs`) | 1.54.1 | yes |
| url | 2.5.8 | yes (shell: window addresses) |
| webview2-com / windows-core (Windows) | 0.39.1 / 0.62.2 | yes (the versions wry 0.57 uses) |
| tauri-plugin-updater | 2.14.1 | registered with no endpoint and no key: never checks (see `updates`) |
| tauri-plugin-autostart | 2.7.0 | yes |
| keyring (default `v1` stores) | 4.2.0 | yes, in `polaris-client` |
| qrcodegen | 1.8.0 | yes, in `polaris-client` |
| base64 | 0.23.1 | yes, in `polaris-client` |
| winreg (Windows only) | 0.56.0 | yes |
| tauri-plugin-window-state | 2.5.0 | no (planned) |
| reqwest (features `rustls`, `json`) | 0.13.5 | yes; `rustls` uses rustls-platform-verifier, so the system trust store |
| nusb | 0.2.9 | yes, in `polaris-client` (TV over USB) |
| if-addrs | 0.15.0 | yes, in `polaris-client` (already in the lock through mdns-sd) |
| wiremock (tests only) | 0.6.5 | yes |
| aws-lc-rs | 1.19.0 | yes; Ed25519 and random bytes, already built for rustls |
| base64 | 0.23.1 | yes |
| flate2 | 1.1.11 | yes; gzip of `docker save` |
| zip (feature `deflate`) | 9.5.1 | yes |
| sysinfo (feature `system`) | 0.40.3 | yes |
| tempfile | 3.27.0 | yes; the push's private scratch folder |
| tokio-util | 0.7.20 | yes; streamed bodies, cancellation |
| tauri-plugin-dialog | 2.8.4 | yes; folder picker, install confirmation, the link switch question |
| tauri-plugin-clipboard-manager | 2.5.0 | yes |
| tauri-plugin-opener | 2.7.3 | yes; external links (http, https, mailto) and `reveal_item_in_dir` |

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

### Cutover plan

Nothing below is built yet, and no workflow changes for it now: it is the plan the
release rows (`releases`, `updates`, `update-first`, `update-ready`, `appimage`,
`squirrel`, `mac-signature`) are ported for. Read against `.github/workflows/desktop.yml`
and `desktop/README.md` as they are on 2026-11-13.

**Tags.** The Tauri app is released under `desktop-tauri-v<version>`
(`polaris_client::releases::BETA_TAG_PREFIX`), which the Electron app's
`newerRelease` never matches (it reads `startsWith("desktop-v")`), so no Tauri
release can be offered to an Electron install as one of its own. A test holds that
neither prefix starts with the other. While it is a beta, every such release is a
prerelease and has no updater endpoint pointing at it.

**Handing over, exactly once, with nothing typed.** Two ordinary Electron
updates, published by `desktop.yml` as today (criterion 5):

1. *Bridge* (`desktop-vN`, Electron). On its first start it writes what only
   Electron can read into places the Tauri app reads: each saved API key, decrypted
   with `safeStorage`, into the OS credential store under the Tauri app's service
   name (`polaris_client::keys`), and a `handover.json` marker in its `userData`
   saying the keys were copied. `settings.json`, `instances.json` and the server list
   need no copy: the Tauri app already imports them once from Electron's `userData`
   (`import_from_electron` in `main.rs`) and never writes there, so Electron's folder
   stays as it was, a backup of the old state.
2. *Switch* (`desktop-vN+1`, still an Electron update from the installed app's point
   of view). It carries the Tauri installers next to the Electron ones, listed in
   `SHA256SUMS`, and installs the Tauri app the way each platform already updates:
   - **Windows (Squirrel).** The Electron app downloads the Tauri NSIS setup from
     the release, checks its size and digest against `SHA256SUMS` (as `appimage.ts`
     does today), runs it per-user and passive with an argument array, and quits only
     when it exited 0 and the Tauri executable answers. The Tauri app's first start
     imports settings and servers, finds the keys already in the credential store,
     then runs Squirrel's `Update.exe --uninstall` for the old install. That runs
     Electron's `--squirrel-uninstall` hook, which removes `polaris://`, the login
     item and the mail handler, so the Tauri app re-registers all three after it, and
     only then writes its own "handed over" marker.
   - **macOS (Squirrel.Mac).** The switch release's `RELEASES-darwin-<arch>.json`
     feed names a zip of the Tauri `Polaris.app`, with the same bundle identifier
     (`io.github.fjrg2007.polaris`, the open identity decision in Beta identity, must
     be settled this way for macOS) and the same Developer ID team, so Squirrel.Mac's
     designated-requirement check accepts it and swaps the bundle like any update.
     Unsigned Mac apps never updated themselves (`mac-signature`) and keep getting the
     release page, as now.
   - **Linux (AppImage).** The Electron app's own `replaceAppImage` puts the Tauri
     AppImage in place of the running one (same path, same checksum check, atomic
     rename). The .deb keeps getting the release page.

   "Exactly once": every step is idempotent and gated on a marker - the switch does
   nothing until the bridge's key marker exists, the Tauri import runs once (its own
   marker), the Squirrel removal only when Squirrel's `Update.exe` is still there,
   and the Tauri installer is attempted once per version through the same
   one-start rule as `update-first` (`attempted`). A key that could not be copied
   (no credential store) is asked for once by the Tauri app, as the `api-key-store`
   row already says.

**Signing keeps working, with no workflow changed now.** SignPath stays optional for
good (`windows-signpath` is `continue-on-error: true` and only runs when its secret
and three variables exist). For the Tauri build it signs the same two files it signs
today, so the SignPath project's artifact configuration and policy stay unchanged:
the Tauri executable is built as `polaris.exe` (`mainBinaryName`) and the NSIS setup
renamed to `Polaris-Setup.exe` in the zip sent, both still `min-matches="0"`. The
Tauri updater's minisign signature is a second, separate step that must run after
Authenticode (it covers the final bytes), on the signed files when SignPath ran and
on the unsigned ones when it did not, so an unsigned release still updates. Its
private key is generated once, kept as a repository secret with a password and backed
up offline like the TV signing key; only its public key goes into `tauri.conf.json`
at release, together with the endpoint. macOS keeps `APPLE_*` and notarization as
now. When the Tauri build is added it goes into `desktop.yml`'s existing tag-only
jobs, so CI on every push stays exactly as fast.

**A broken update always ends in an app that opens.**
- Nothing is installed until it is verified: the plugin checks the minisign
  signature before it runs or unpacks anything, and the switch checks `SHA256SUMS`.
- The installed app is never left half-replaced where that can be avoided: the plugin
  moves the macOS bundle and the AppImage with renames and restores the previous one
  on failure (2.14.1 source, `replace_bundle` and `install_appimage`); on Windows the
  NSIS setup overwrites a single executable (resources are embedded and WebView2's
  loader is linked in), which is the one window left, kept short.
- The start never loops: `update_first` remembers the version before it restarts and
  never holds a start for the same version again, and every outcome but a working
  restart (slow answer, failed install, closed window, failed or returning restart,
  an attempt that could not be remembered) opens the app. Ported with its tests.
- During the cutover there is always one working app: Electron is removed only by the
  Tauri app after the Tauri app has opened, and Electron's `userData` is not deleted,
  so a failed Tauri install leaves Electron opening as before and offering the switch
  again in the background, never before opening twice.

## Startup and memory

**Tool.** `desktop-tauri/tools/measure-startup` (a workspace bin) serves a static
page on 127.0.0.1, starts the beta built with the `measure` feature
(`src-tauri/src/measure.rs`) against it, and prints JSON: per run, the time from
spawning the process to the page's load event, and the working set of the whole
process tree (the app and every WebView process under it) after a settle (5 s).

    cargo build --release -p polaris-desktop-beta --features measure
    cargo run --release -p measure-startup -- --runs 3

The measured start never shows anything: its one window is created hidden,
off-screen and off the taskbar, no tray icon is added, the one-instance plugin is
left out (a running beta is not woken), the process is started with
`CREATE_NO_WINDOW`, and no settings are read or written. It runs the same Tauri
runtime, WebView and plugins as a normal start, but not the settings load, the
Electron import, the tray or the failover probe, so it is a lower bound for the
beta's own start. The `measure` feature is in no build anybody runs.

**Electron, by hand.** Not automated, because it cannot be without changing
`desktop/`: the app opens only its saved server (no way to give it a page), a
static page is refused by its servers page (it must prove it is a Polaris), its
`--hidden` start uses the owner's own settings, and a second launch hands over to a
running Electron app, which then shows its window. To compare on one machine, with
the same Polaris server in both:
1. Quit both apps (tray > Quit) and wait 30 s.
2. Start Electron (`%LOCALAPPDATA%\polaris\polaris.exe`), stopwatch from launch to
   the dashboard drawn; after 5 s more, in PowerShell:
   `(Get-Process polaris | Measure-Object WorkingSet64 -Sum).Sum / 1MB`
   (Electron's own processes are all named `polaris`).
3. The same for the beta with its normal start, adding the WebView processes:
   the beta's process plus every `msedgewebview2` whose parent chain leads to it
   (`Get-CimInstance Win32_Process` gives `ParentProcessId`), or run the tool above
   for the lower bound.
4. Three runs each; the first after a reboot is the cold one. Then again in a call.

**Numbers.**

Beta, hidden start (`measure` feature, release build), 2026-11-13, Windows 11 Pro
26200, AMD Ryzen 9 9950X3D, 125 GB RAM, WebView2 Runtime 157.0.4341.46, local static
page, 5 s settle, 7 processes in the tree each run:

| Run | Spawn to page loaded | Working set, whole tree |
| --- | --- | --- |
| 1 (first after the build, cold) | 1292 ms | 322 MiB |
| 2 (warm) | 367 ms | 303 MiB |
| 3 (warm) | 371 ms | 301 MiB |

Electron: not measured (see above). Criterion 3 stays open until it is, on this
machine, against the same Polaris, idle and in a call.

## Electron main process (`desktop/src/main`)

| Module | What it does | Tauri 2 / Rust equivalent | Status | Risks |
| --- | --- | --- | --- | --- |
| adb-client | ADB wire protocol over TCP (connect, auth, shell, push) for installing on a TV | `polaris-client::adb_client` (`tokio` TCP, `rsa` auth, A_STLS over `tokio-rustls`); link trait shared with USB | scaffolded | tested against an in-process fake adbd (auth, prompt, shell, push, STLS, TLS refused); key format and token signature byte-identical to the TS module (fixture); never run against a real TV; a cancel drops the open instead of `close()` racing it |
| adb-pairing | Android 11+ Wireless debugging pairing (TLS + SPAKE2 + six-digit code) | `polaris-client::adb_pairing` (`rustls` TLS 1.3, `export_keying_material`, `aes-gcm`, `hkdf`) | scaffolded | exchange tested over a real in-memory TLS 1.3 session (both ends export the same material) and a scripted TV; certificate bytes identical to the TS module (fixture); never paired with a real TV |
| adb-spake2 | SPAKE2 over Ed25519 exactly as BoringSSL's spake25519 | `polaris-client::adb_spake2`, own implementation over `curve25519-dalek` | scaffolded | meets the cross-implementation vectors the TS tests pin (`spake2-vectors.py`); BoringSSL publishes none, so no real adbd has checked it |
| annotate-overlay | See-through window over the shared display showing call strokes | `src-tauri/src/share.rs`: transparent, undecorated, unfocusable, always-on-top, content-protected window (`overlay`, page `ui/overlay.html`) over the shared monitor, `set_ignore_cursor_events(true)`; strokes as `polaris://overlay-stroke`, held while it loads (256), closed 30 s after the last one or on `stop_drawing`; commands `draw_on_share`, `can_draw_on_share`, `stop_drawing` (Polaris windows only); rules in `polaris-client::annotate` (tested) | blocked: only a share this app picked names its display, and no engine lets the app pick it (see screen-share), so both commands answer false - as Electron does for a system-picker share; the window code is in place but has never opened | macOS transparency needs `macos-private-api`; exclusive full-screen games cover it; Electron's `screen-saver` level and Windows-build check for content protection not ported |
| api-key-store | API key encrypted by the OS (`safeStorage`), never in plain text | `polaris-client::keys` (`KeyRing` over `keyring` 4.2.0: Credential Manager, Keychain, Secret Service), one entry per server under the beta's own service name | scaffolded | no store (Linux without a secret service): held in memory for the run, as Electron; Electron's Chromium-encrypted file cannot be migrated, so the beta asks once; only the Windows store was compiled |
| app-badge | Waiting count on the taskbar/Dock/launcher icon | `polaris-client::app_badge` (same schema and per-system plan, tests ported) + `set_app_badge` command, Polaris windows only (remote capability + `from_polaris`): `set_overlay_icon` (Windows), `set_badge_label` (macOS), `set_badge_count` (Linux) | scaffolded | `window.polarisDesktop` (preload app) is not defined yet, so no page calls it |
| appimage | Replaces a running AppImage with a verified newer one | `polaris_client::releases::{app_image_asset, parse_checksums}` (which file, which digest) + `tauri-plugin-updater` (the replace: backup rename, new file, restore on failure) | scaffolded | asset choice and `SHA256SUMS` reading ported with their tests; the replace is the plugin's, verified by its minisign signature instead of `SHA256SUMS`; the updater has no endpoint in the beta, so it never runs |
| call-hotkeys | Holds mute/deafen keys system-wide during a call, one window at a time | `set_call_hotkeys` over `tauri-plugin-global-shortcut`, granted to the Polaris window by the remote capability and checked with `ipc::from_polaris`; presses go to the holding window as `polaris://call-hotkey`; let go on `null` and when the window is destroyed | scaffolded | not released on a navigation; `window.polarisDesktop` (preload app) is not defined yet, so no page calls it; Wayland has no global shortcuts without a portal |
| context-menu | Right-click menu (copy, paste, links) in every window | `polaris-client::context_menu` (same items, link allow-list and tests) | blocked: Tauri 2 raises no right-click event from the webview to Rust, and getting one means a script with IPC in the remote page, which its capability forbids; WebView2/WebKit draw their own menu (copy, paste, links) meanwhile | menus differ per engine |
| deep-links | What a `polaris://` link does once it arrives (queued until ready) | `polaris-client::deep_link` (`read_deep_link`, `deep_link_in`, `deep_link_route`, `DeepLinks` queue) + `tauri-plugin-deep-link` `on_open_url`/`get_current` + single-instance `deep-link` feature | scaffolded | ported with tests (same 2048 limit, path rules, newest-wins queue, one question at a time); the switch question is a native dialog (`tauri-plugin-dialog`). Not exercised on a running app; the `mailto:` link mail-handler is handed is not opened yet |
| deploy-outcome | Words for a finished deployment notice (pure) | `polaris_client::deploy_outcome` | scaffolded | ported with its tests; the notice itself waits on `notices` |
| docker | Local Docker run with argument lists, never a shell | `polaris_client::docker` (tokio `Command`, argument lists, PATH additions on macOS/Linux, `kill_on_drop`) | scaffolded | tested with a fake program (the test binary); real Docker never run in tests |
| folder-zip | Zips a folder for "Upload a folder" (skips `node_modules`, `.git`) | `polaris_client::folder_zip` (`zip` crate, own walk with the same link rules), streamed into any `Write + Seek`; shell `upload_folder` (app picker, framed bytes answer) | scaffolded | zip times are written in UTC (fflate writes local time); the dashboard bridge that reads the answer is the `app` preload row |
| game-detect | Which known game is running, from the process list | `polaris_client::game_detect` over `sysinfo`; shell `running_game`, `set_custom_games`, `running_programs`, Polaris windows only | scaffolded | telling the dashboard on a change is the `ipc` row; Linux reads command lines as before |
| host-transfer | Host list to/from a file, clipboard or QR code | `polaris-client::host_list` (port of core `host-list.ts`: code, link, file, merge; QR via `qrcodegen` 1.8.0, the Nayuki encoder `qr.ts` follows, byte mode, level M) + commands `copy_hosts`, `import_hosts`, `save_hosts_file`, `import_hosts_file`, `hosts_qr` over `tauri-plugin-dialog` and `tauri-plugin-clipboard-manager`, servers page only (`ipc::is_servers`, `capabilities/local.json`), pasted text capped at 65536 as the zod schema | scaffolded | the list is the servers page's own (`Settings::servers`); the servers page has no buttons for it yet; reading a QR with the camera is the settings page's (renderer, not ported); the QR is checked for size, not decoded by a reader in a test |
| index | App entry: windows, server list, first-run, failover, updates, notices, wiring | `src-tauri/src/main.rs` | scaffolded | servers page (first run and list: add, rename, remove, switch, live check, load error), offline page (service-worker title) and failed loads -> failover or the servers page; Electron settings/instances imported once; one `Settings` (`polaris_client::settings`) for the servers and the OS switches; one tray (`tray.rs`) whose Settings opens the servers page and whose Switch to goes through the servers page's switch. Not here yet: updates, menu Back on Windows/Linux, window place, call holding before moving windows (call-holder). Pages in English and Spanish (`ui/i18n.js`, the system language) |
| install-tool | Installs an allow-listed tool after the app's own confirmation dialog | `polaris_client::install_tools` (table, launches, output reading) + shell `install_tool` (`tauri-plugin-dialog` confirm, clipboard, reveal) | scaffolded | allow-list and every launch are Rust; the page sends `{tool, browser?}` only; Squirrel uninstall cleanup is the `squirrel` row |
| instance-store | Persists what each server said about itself (id, local addresses, CA pin) | `polaris-client::instance_store` (`instances.json`, same format, atomic, 0600 on Unix) | scaffolded | ported with tests; the Electron file is imported once, read only |
| ipc | Every page request checked by window kind, origin and schema | `src-tauri/src/ipc.rs`: commands with `deny_unknown_fields` inputs and the zod limits; `build.rs` app manifest makes each command a permission; `capabilities/local.json` (servers page: `connect_*`, host transfer), `capabilities/api-key.json` (the key form's four) and a remote capability per configured origin added at run time (`add_capability`) granting `ipc::POLARIS_COMMANDS` (open servers/window, notices, badge, call keys, push, upload, install, games) | scaffolded | a capability cannot be removed, so each command re-checks the window label and its current URL against the active origin (`from_polaris`), or the app page and window label (`from_local`). Tauri gives a command the window, not the frame: the main-frame check rests on that URL check. `window.polarisDesktop` (preload app) is not defined yet |
| key-flow | Gets the push API key, checks it with `GET /api/v1/me`, keeps it | `polaris-client::keys::check_key` (`ApiClient::me`, 401 -> the same sentence) + `key_flow.rs`: one shared form window (`ui/api-key.html`), every push waiting on it, kept in the keyring | scaffolded | no push is ported yet, so `api_key_for` has no caller |
| known-games | The table of recognized game executables | `polaris_client::known_games` | scaffolded | `desktop/src/main/known-games.ts` stays the one place it is edited (hand-written, not generated from core); a test fails when the Rust table differs |
| local-ca-pin | Trusts the same Polaris's local CA on its proven local address | `polaris-client::local_ca_pin`: `PinVerifier` (rustls `ServerCertVerifier` over rustls-platform-verifier, pin only on `UnknownIssuer` for in-scope hosts; webpki checks the chain with the pinned CA as sole anchor, its dates and CA flag read from DER); webview: WebView2 `ServerCertificateErrorDetected` (`ICoreWebView2_14`) | scaffolded | ported with the Electron fixtures as tests. Windows webview only; macOS (WKWebView) and Linux (WebKitGTK) blocked: wry exposes no certificate-error hook, so a local alternate with Polaris's own CA is refused there (the window then says why) |
| login-item | Open with the computer (Squirrel launcher on Windows, autostart file on Linux) | `tauri-plugin-autostart` with `--hidden`; tray switch "Open with the computer", kept as `Settings::open_at_login` (off by default in the beta, unlike Electron, so the two never both start with the computer), re-applied every start; a debug build never writes it | scaffolded | entry is named after the beta, never Electron's; the Squirrel entry has to be removed at cutover |
| mac-signature | Whether the macOS app has a Developer ID (Squirrel.Mac needs it) | `polaris_client::mac_signature` (`team_identifier`, `developer_signed` through `/usr/bin/codesign`, argument array, 30 s limit) | scaffolded | tests ported; the beta's own updates do not need it (minisign), it is kept for the cutover, which reaches Mac users only through Squirrel.Mac and so only signed ones; never run on macOS; Gatekeeper still wants notarization for a clean first open |
| mail-handler | Registers on Windows as a `mailto:` handler (Capabilities registry keys) | `mail_handler.rs` with `winreg` 0.56.0, under the beta's own names (`Polaris Beta`, `Polaris.Beta.Url.mailto`); only after the tray switch "Offer this beta for email links", kept as `Settings::mail_handler` (`mailHandler`, off by default); switching it off, or any start with it off, deletes every key it wrote | scaffolded | the beta has no installer, so "uninstall" is that switch; opening the `mailto:` link it is handed is the deep-link module's |
| menu | Application menu (File, Edit, View, Window, Help + update offer) | Tauri `menu` API in `tray.rs`, set on macOS only; the update line is there and disabled (the beta never updates) | scaffolded | Windows/Linux draw a Tauri menu as a strip on every window, so there the engine's own keys and the tray stand in, as Electron hides its bar; devtools item left out of release builds |
| navigation | Where a window may go; keeps the bridge on the configured origin | `polaris-client::navigation` (pure, tested) + `on_navigation`/`on_new_window` on every Polaris window; external links through `tauri-plugin-opener` (http, https, mailto only) | scaffolded | provider round trip kept (ends on the next Polaris page load); Back (`backIndex`) ported but no menu calls it yet |
| notice-layout | Notice title/body per system (pure) | `polaris-client::notice::notice_layout`, `icon_acceptable` (tests ported) | scaffolded | none |
| notice-once | Which `once` notices repeat one already shown (pure) | `polaris-client::notice::OnceNotices` (tests ported) | scaffolded | none |
| notices | OS notices, replaced by tag | `show_notice` over `tauri-plugin-notification`, laid out and de-duplicated by `polaris-client::notice`; Polaris windows only (remote capability + `from_polaris`) | scaffolded | the plugin on desktop has no click, reply, buttons, insistent or replace-by-tag, and takes no per-notice picture |
| permissions | Deny-by-default browser permissions, only for the configured Polaris | `polaris-client::permissions` (pure, tested) + WebView2 `PermissionRequested` through `with_webview` | scaffolded | Windows only. macOS and Linux keep the engine default (wry: WKWebView asks the person; WebKitGTK denies) - not ported, no hook in wry. WebView2 has no fullscreen or display-capture permission kinds (fullscreen is allowed by the engine; screen sharing is screen-share's) |
| polaris-api | API-key calls, Bearer header, refusals, local-address failover | `polaris_client::ApiClient` + `polaris_client::instance` (port of core `instance-fallback`: signed challenge over `aws-lc-rs` Ed25519, hold, gateway statuses) | scaffolded | failover and streamed `send_file` ported and tested; keeping learned records on disk is the `instance-store` row; Chromium `net` used the window's proxy, reqwest uses the system proxy |
| push-local | Build with local Docker, upload the image, follow the deployment log | `polaris_client::push_local` + shell `push_choose_folder`, `push_start` (events on a `Channel`), `push_cancel`, Polaris windows only | scaffolded | bounded memory: chunked gzip and upload, capped lines, batched events; the Polaris in use and its key from the key store, as Electron (the page sends only the service, its name and the platform); the push page is `ui/push.html` (folder, platform, the build/upload/deployment log over a `Channel`, open the service); its notice is not built; the server a push names is not yet checked against the one in use |
| reachability | Network error codes into sentences; offline-page detection | `polaris-client::net` (`NetFailure`) | scaffolded | reqwest has no typed DNS/TLS error, so those two are read from the error text |
| releases | Highest published `desktop-v` release newer than this one (pure) | `polaris_client::releases` (`newer_release` with a prefix, `parse_version`, `release_source`, `mac_feed_name`, `CHECKSUMS`); `BETA_TAG_PREFIX` = `desktop-tauri-v` | scaffolded | tests ported, plus: neither prefix starts with the other, and no workflow names the beta's prefix (read, not changed); see the release section |
| same-instance | Whether a typed address is a server already listed (by signature) | `polaris-client::same_instance` over `polaris-client::instance` (the core instance-fallback port: Ed25519 via aws-lc-rs) | scaffolded | ported with tests (30 s cache, 50 entries); an untrusted certificate is accepted for that one host by a client built for the question (`AcceptHost`), with no cookie or key |
| screen-share | Screen/window list with thumbnails for the dashboard's own picker | `polaris-client::screen_share` (source id check, pick held 15 s, sound only on Windows, list shape: screens then 40 windows, names 200; tested) + `share_sources` (answers `null`) and `choose_share` in `src-tauri/src/share.rs`, Polaris windows only | blocked on all three: the page's `getDisplayMedia` is answered by the engine's own picker. Windows: WebView2's `ScreenCaptureStarting` can only cancel or defer, it cannot choose the source; `windows-capture`/`xcap` can list and thumbnail, but their frames cannot become the page's capture stream without re-encoding through a canvas, a stand-in not taken. macOS: Electron itself gives no list there (system picker), so `null` is parity. Linux: WebKitGTK goes through the desktop portal, which asks the person; wry has no hook | the 'only the configured Polaris may share' rule is not enforced on WebView2 yet (a `ScreenCaptureStarting` cancel for other origins is the next step); clip recording uses the same picker |
| settings | JSON settings: server, server list, per-service push folder | `polaris-client::settings` + `servers` (every field of the Electron schema, read field by field) | scaffolded | ported with tests; Electron's `settings.json` (`<config dir>/Polaris`, its `productName`) imported once when the beta has none, never written |
| squirrel | Squirrel install/update/uninstall hooks (shortcuts) | none in the beta: the Tauri installer's own hooks, and the cutover steps in the release section | blocked: no installer is built (`bundle.active: false` by rule), so there is nothing to hook | the Electron hooks stay in `desktop/`; the cutover removes the Squirrel install from the Tauri app after its first good start and re-registers `polaris://`, the login item and the mail handler, which the Squirrel uninstall hook removes |
| tray | Tray icon menu (servers, API key, update) on Windows/Linux | Tauri `tray-icon` in `tray.rs`: Open, update line (disabled), Settings... opens the servers page, Switch to (two or more kept hosts, through the servers page's switch), API keys, Install on a TV (disabled until tv-install is ported), Forget the saved API key, Open in the browser (`tauri-plugin-opener`), the two OS switches, Quit | scaffolded | none |
| tv-install | Installs Polaris TV on a set, step by step, with a backup first | `polaris-client::tv_install` over adb-*, tv-* and usb-link (same steps, checks, backup reads, grants, Home and control levels, link screen, debugging off, outcomes); commands `tv_state`, `tv_find`, `tv_find_usb`, `tv_cancel`, `tv_start` and the `tv-event` event in `src-tauri/src/tv.rs`, answered only for the main window on its saved Polaris; `tv_start` input read by `read_start` (`deny_unknown_fields`, private address, listed USB id, six-digit code) | scaffolded | TS tests ported; the steps after the connection run against a scripted TV and the release lookup against recorded GitHub answers (wiremock); never run against a real TV. The ADB key is in the system credential store (memory for the run where there is none) instead of a 0600 file. Blocked for the dashboard: a remote page reaches no app command until the beta declares an app ACL manifest (`tauri_build` `AppManifest`), which then gates every command, so it belongs with the `app` bridge row, not here; the tray entry stays disabled |
| tv-mdns | Finds TVs over multicast DNS / DNS-SD | `polaris-client::tv_mdns` over the `mdns-sd` crate; collecting, merging and naming ported as pure functions | scaffolded | collecting tested on resolved records; the browse itself never ran on a real network or TV; Windows firewall prompt not checked; the TS packet-parser tests do not apply (the crate parses) |
| tv-path | Which install path a TV takes, from core's tv-compat data | `polaris-client::tv_path` (pure), core's `models.json` / `debugging.json` compiled in with `include_str!` | scaffolded | every listed model's path tested from the same data as the TS test |
| tv-wait | Waits for the TV's debugging port instead of asking to retry | `polaris-client::tv_wait` (async, hooks trait) | scaffolded | TS cases ported against a scripted clock and port |
| update-first | Whether a start updates before it opens (pure) | `polaris_client::update_first` (`update_before_opening` over an `OpeningSteps` trait, tokio timers, the same four limits) | scaffolded | all TS tests ported on a paused clock, plus a late answer that must open; not called by the shell, since the beta has no endpoint and so never finds an update |
| update-ready | The downloaded update waiting for a restart (pure) | `polaris_client::update_ready::UpdateReadyState` (pages by window label, one restart per 30 s window, the same two sentences) | scaffolded | TS tests ported; not wired to a command or event until the beta can find an update |
| updates | Self-update from GitHub releases every few hours | `tauri-plugin-updater` 2.14.1 registered in `src-tauri/src/updater.rs` with `endpoints: []` and an empty `pubkey` | scaffolded | disabled for good in the beta, held by tests: the plugin config has no endpoint or key, `bundle` builds no update artifacts, no capability or page grants `updater:` commands, and no shell code calls `updater_builder`, `.endpoints(` or `.check()`; the check loop (every 6 h, after Squirrel's first run) is not written, there being nothing to check |
| usb-link | TV USB connection through a hidden WebUSB page | `polaris-client::usb_link` over `nusb` 0.2.9, no hidden page: lists devices offering the ADB triple, opens one by its listed id, maps not-found/disconnected to gone and the rest to busy | scaffolded | never opened a real device; WinUSB driver binding on Windows (a TV without it answers busy, as with WebUSB); the hidden-window lifetime tests do not apply (no window) |
| voice-widget | Always-on-top voice widget over games | `src-tauri/src/voice_widget.rs`: transparent, undecorated, unfocusable, always-on-top, content-protected window (`voice-widget`) at the kept place or the main screen's corner; click-through until the lock key (global shortcut, Shift+` only while a game runs) unlocks it; `set_voice_state` (Polaris windows) and `voice_widget_act` (widget page only); events `polaris://widget-view` and `polaris://voice-action`; switches 'Show the call over other windows' and 'Only while a game is running' in the tray (`voiceWidget`, `voiceWidgetGameOnly`); the game watcher now tells it when a game starts or stops | scaffolded | exclusive full-screen games cover it, as now; never opened (GUI not launched); the place is kept in physical pixels (Electron kept DIPs: an imported place on a scaled display may land elsewhere, and falls back to the corner when off screen); a `polaris-*` window that navigates mid-call is only let go when it closes |
| vpn-helper-client | Talks to the VPN service over loopback with mutual challenge | `polaris_client::vpn_helper` (tokio TCP, `hmac` + `sha2`): `ask_helper` with the same line order, service-first HMAC proof checked in constant time before any order is sent, 20 s idle timeout, 4096-byte reply cap, `replySchema` read; `elevated_install`, `read_join` (`joinSchema`), `tailscale_path`, `device_name_from`, and `VpnConnection::read` (`connectionSchema` in `ipc.ts`, plus `deny_unknown_fields`) | scaffolded | TS tests ported to `polaris-client/tests/vpn`, plus a stand-in service that is `desktop/vpn-helper`'s `server.rs`/`auth.rs` with the tunnel left out (the helper is a binary crate of its own workspace, so its types are copied, not shared; it is unchanged) and the helper's own proof vector; never run against the real service. Order keys go out sorted, not in spread order (the service reads JSON, not bytes) |
| vpn | Installs and drives the VPN service | `polaris_client::vpn` (`Vpn` over an `Installer`: secret file, status/install/wait 15 s, key, up, down, status, `join_network`; `ElevatedInstaller` runs PowerShell `RunAs`, `osascript ... with administrator privileges` or `pkexec` with argument arrays and paths in the environment, the Linux copy 0700) + commands `vpn_device_name`, `vpn_key`, `vpn_up`, `vpn_down`, `vpn_status`, `vpn_join` in `src-tauri/src/vpn.rs`, answered only for a Polaris window on the configured Polaris (`ipc::from_polaris`) and granted through `POLARIS_COMMANDS` | scaffolded | install, reinstall of an older service, a refused prompt (`denied`), up/down/status and `noClient` tested against fakes; nothing installed or elevated in tests, and no real prompt, service or tunnel exercised. The beta bundles no helper yet (`resource_dir()/vpn-helper/`), so a connect there is `denied` until the bundle carries it. The secret is a 0600 file (`vpn-secret` beside the settings) because the unchanged helper's `install` reads it from one; it is the beta's own, so after the beta installs the service the Electron app reinstalls it (one prompt) on its next connect, and the reverse |
| window-failover | When the window switches to the local address and back (pure) | `polaris-client::window_failover` + `instance::Failover` + webview `navigate` | scaffolded | ported with tests; WebView2 failed loads mapped to Chromium codes. macOS/Linux have no failed-load hook, so only the offline page triggers it there |
| windows | Window kinds and their rules (Polaris windows vs own pages) | `WebviewWindowBuilder` + capabilities per window | scaffolded | one main window only |
| zip-rules | What goes into an uploaded folder, and limits (pure) | `polaris_client::zip_rules` | scaffolded | a test reads the browser zipper and the Electron copy and fails when they drift |

## Preload bridges (`desktop/src/preload`)

| Module | What it does | Tauri 2 / Rust equivalent | Status | Risks |
| --- | --- | --- | --- | --- |
| app | `window.polarisDesktop` for the dashboard, one IPC per function | `src-tauri/src/bridge.js`, an initialization script given only to the Polaris windows (`main`, `polaris-*`, built by `polaris_builder`) with the origins it may define itself on baked in (`bridge::bridge_origins`: the server in use plus the addresses its stored instance record names); it defines nothing in a frame or on any other origin, and the object is frozen. Calls `__TAURI_INTERNALS__.invoke`, which only the remote capability for the configured origin lets through (`ipc::allow_origin`, with `core:event:allow-listen`/`allow-unlisten` for the events), and every command checks `from_polaris` again. Mapping: `notify` -> `show_notice` (`silent: !sound`, `once` for `notification:` tags; `icon`, `href`, `insistent`, `reply`, `actions` dropped: the plugin draws none of them), `pickFolder` -> `upload_folder` (framed bytes read back to `{ok,name,files,zip}`), `openWindow` -> `open_window`, `gameActivity` -> `running_game` (+ `reporter` = main window), `onGameActivity` -> `running_game` polled every 15 s (no game event yet; a change at once, a running game once a minute, main window only), `setCustomGames` -> `set_custom_games`, `runningPrograms` -> `running_programs`, `installTool` -> `install_tool`, `tv.*` -> `tv_*` + `tv-event`, `setCallHotkeys` -> `set_call_hotkeys`, `onCallHotkey` -> `polaris://call-hotkey`, `openServers` -> `open_servers`, `setAppBadge` -> `set_app_badge`, `vpn.*` -> `vpn_device_name`, `vpn_key`, `vpn_up`, `vpn_down`, `vpn_status`, `vpn_join`, `setVoiceState` -> `set_voice_state`, `onVoiceAction` -> `polaris://voice-action`, `shareSources` -> `share_sources` (answers null today: the webview's own picker), `chooseShare` -> `choose_share`, `drawOnShare` -> `draw_on_share`, `canDrawOnShare` -> `can_draw_on_share`, `stopDrawing` -> `stop_drawing`; the account's text size -> `text_size_seen`. Answered in `src-tauri/src/pages.rs` and `developer.rs`: `pushLocal` -> `push_local` (opens or brings forward the push window `push-<service>`, whose own capability `capabilities/push.json` grants `push_state`, `push_choose_folder`, `push_start`, `push_cancel`, `push_open_service`), `openTvInstall` -> `open_tv_install` (the `tv` window, `capabilities/tv.json`: `tv_state`, `tv_find`, `tv_find_usb`, `tv_cancel`, `tv_start`), `openMailDefaults` -> `open_mail_defaults` (`ms-settings:defaultapps?registeredAppUser=Polaris%20Beta`, Windows only, false elsewhere), `defaultBrowser` -> `default_browser` (the http handler named as Electron's `browserFromName`), `systemIdle` -> `system_idle` (idle after 120 s without input, `GetLastInputInfo` on Windows, `unknown` elsewhere), `closeNotice` -> `close_notice` (reads the tag; the plugin cannot take a notice back on desktop), `onNoticeReply`/`onNoticeAction` listen on `polaris://notice-reply`/`notice-action` (never sent: the plugin draws no reply box or buttons), `updateReady` -> `update_ready` (always null), `onUpdateReady` listens on `polaris://update-ready` (never sent), `installUpdate` -> `install_update` (no update waiting: the beta's updater has no endpoint, so the updating page is never reached). No command: `checkForUpdates` (`{kind:"unsupported"}`, Electron's own answer for a build that does not update itself), `noticeFeatures` (`[]`, `["subtitle"]` on macOS) | scaffolded | tests in `bridge.rs` read `desktop/src/preload/app.ts` and `dashboard/apps/web/src/lib/desktop-bridge.ts` at test time: the script's members must equal the preload's and cover every member the dashboard reads, including `METHODS`; every command the script calls must be a Polaris command and every Polaris command must be called, and the push and TV pages must call exactly what their own capabilities grant; only `polaris_builder` injects it. Never run in a webview: injection order with Tauri's own scripts and the event listen calls are unverified |
| local | `window.polarisLocal` for the app's own pages, per window kind | Tauri commands from local pages | scaffolded | only `connect` exists |
| text-size | Carries the account's text size both ways | `bridge.js` reports `--app-text-size` on load and on every root style change to `text_size_seen` (Polaris windows only; `read_text_size`; kept in settings); the servers and API key pages are built with `bridge::text_size_script` and get the new size by `eval` when it changes; the voice widget sizes itself from the same setting | scaffolded | never run in a webview |
| usb | Byte bridge for the hidden WebUSB page | removed: `nusb` in Rust (`usb_link`) | done (not needed) | none |

## Shared modules (`desktop/src/shared`)

| Module | What it does | Equivalent | Status | Risks |
| --- | --- | --- | --- | --- |
| annotate | Stroke schema for the overlay | `polaris-client::annotate::read_stroke` (same key, color, unit and 64-point rules; tests ported); fading and the 200-stroke board in `ui/overlay.js`, as in the Electron renderer | scaffolded | none |
| api-key | API key shape `plk_<8>.<secret>` | `polaris-client::ApiKey` | scaffolded | same regex and sentences; `Debug` redacts |
| bridge | Bridge channel names and types | the Tauri command names, mapped member by member in `bridge.js` (see the `app` preload row); `ipc::POLARIS_COMMANDS` + `POLARIS_CORE` | scaffolded | the mapping is asserted against the preload, the dashboard and `ipc::POLARIS_COMMANDS` by tests in `bridge.rs` |
| call-hotkeys | Dashboard key spelling to OS accelerators | `polaris-client::hotkeys` (`to_accelerator`, `call_accelerators`, schema; tests ported); `Plus` spelled `Equal` for the shortcut parser | scaffolded | none |
| deep-link | `polaris://open?server=&path=` parsing and limits | `polaris_client::deep_link` (see the `deep-links` row) | scaffolded | any website can start such a link: same limits, ported with tests |
| install-tools | Allow-listed tools and how to start them | `polaris_client::install_tools` (Rust table) | scaffolded | tests read the official scripts' end markers |
| mailto | `mailto:` to the Mail composer path | `polaris_client::mailto` (`mailto_path`, `mailto_in`, same 8192 limit and control-character refusal, `encodeURIComponent` spelling); read from the start arguments and from a second start (single-instance) | scaffolded | tests ported (`tests/mailto`); a mailto arriving through macOS `open-url` is not handled (the deep-link plugin takes only `polaris`), and the beta registers for mailto on Windows only |
| server-address | Address normalization and refusals | `polaris-client::InstanceUrl` | scaffolded | same rules and sentences, unit-tested |
| server-identity | Is this a Polaris (identity, instance, health; 4 KiB cap; 5 s) | `polaris-client::identity::probe` | scaffolded | probe ported and tested; the 30 s verdict cache is not |
| servers | The list of known servers | `polaris_client::servers` (`read_servers`, `with_server`, `rename_server`, `replace_server`, `without_server`, `list_servers`) | scaffolded | ported with tests (`tests/servers`) |
| text-size | Text size schema | `polaris_client::settings` (`TEXT_SIZES`, `DEFAULT_TEXT_SIZE`, `read_text_size`, `text_size`/`remember_text_size`); `textScale` in `polaris_client::voice_widget` | scaffolded | none |
| title-bar | Window button colours over the page header | none: the beta keeps native decorations | blocked: Windows has no title-bar overlay in Tauri 2 (no `titleBarOverlay` / Window Controls Overlay, and the caption cannot be painted through Tauri's API), so the buttons cannot sit on the page's header and take its colours; doing it means `decorations(false)` with buttons the dashboard draws itself, a dashboard change. macOS could use `TitleBarStyle::Overlay`. The bridge does not report the colours |
| tv-address | TV address parsing | `polaris-client::tv_address` | scaffolded | none |
| update-check | "Check for updates" sentences (pure) | `checkForUpdates` in `bridge.js` answers `{kind:"unsupported"}`, Electron's answer for a build that does not update itself, and `updateReady` null: the beta never updates | scaffolded | `describeUpdateCheck` is not ported: no page of the beta shows it until the updater exists |
| update-ready | Update-ready state as the dashboard sees it | `polaris_client::update_ready::{UpdateReady, read_update_ready}` (`deny_unknown_fields`, the same version pattern, 64 characters at most) | scaffolded | tests ported with the main-process ones |
| usb-adb | ADB over WebUSB bulk endpoints | `polaris-client::usb_adb`: interface choice, device naming, header/payload framing, the zero-length packet, as an `AdbLink`; a read dropped part way resumes | scaffolded | tested against an in-process fake TV speaking adbd's USB framing (`tests/tv/usb.rs`); no real device |
| voice-widget | Voice widget state schema | `polaris-client::voice_widget` (state and action schemas, visibility, height and text-size scaling, initials, face color, lock keys, start place; tests ported) | scaffolded | none |
| window-place | Restores the window where it was, unless that display is gone | `tauri-plugin-window-state` 2.5.0 (main window only; size, position, maximized) + `bridge::keep_reachable`, which applies `polaris_client::window_place::restored_place` after the plugin's restore: the plugin moves the window back when any corner is on a monitor, so a title bar off every display opens at a size that fits the primary work area, centred | scaffolded | tests ported (`tests/window`); never run against real monitors |

## App pages (`desktop/src/renderer`)

| Page | What it does | Status |
| --- | --- | --- |
| connect | Settings and first run: the server list, add, rename, remove, open | scaffolded (`ui/index.html`, `ui/main.js`: list with open/show, rename, change address, remove asked twice on the row, add with a live address check, share the list by copy, file and QR; Electron's other settings sections are not on it) |
| api-key | Paste and check the push key | scaffolded (`ui/api-key.html`) |
| push | Pick folder and platform, follow build, upload and deployment | scaffolded (`ui/push.html`, `ui/push.js`, one window per service opened by `pushLocal`; a test keeps its calls equal to `capabilities/push.json`) |
| tv | Find a TV and install Polaris TV | scaffolded (`ui/tv.html`, `ui/tv.js`: network search and stop, USB list, pairing code, system or app mode, steps, outcomes, control levels, backup; opened by `openTvInstall`; a test keeps its calls equal to `capabilities/tv.json`) |
| usb | Hidden WebUSB holder | replaced by `nusb` (`usb_link`) |
| overlay | Strokes over a shared display | scaffolded (`ui/overlay.html`, `ui/overlay.js`; never shown, see annotate-overlay) |
| voice-widget | The call's people over other windows | scaffolded (`ui/voice-widget.html`, `ui/voice-widget.js`, English only like the Electron page) |
| updating | Shown while an update installs before the app opens | scaffolded (`ui/updating.html`, `ui/updating.js`; opened only by `install_update` for a ready update, which the beta never has) |
| dom, styles, fonts, mark | Shared page helpers, styles and assets | scaffolded (`ui/dom.js`; `ui/page.css`, `ui/fonts/*`, `ui/mark.svg` copied from Electron's renderer, a test keeps them byte-identical; the servers and key pages keep `ui/styles.css`) |

Every page of the beta's own (servers, API key, push, TV, updating) takes its text from
`ui/i18n.js` in English and Spanish by the system language; a test keeps both tables
with the same keys and every key a page names in both. The voice widget and overlay
stay English only, like Electron's.

## Verified in this phase

On Windows 11 (MSVC toolchain), in `desktop-tauri/`:
`cargo check --workspace`, `cargo build -p polaris-desktop-beta` (links),
`cargo test -p polaris-client` (unit and wiremock tests, no network),
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`.
The beta was not launched in this phase, and nothing was built on macOS or Linux.
