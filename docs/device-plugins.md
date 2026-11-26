# Device plugins

Support for a piece of hardware (the Hercules Stream 100 first) installed on one
device, the way an app is installed on a host - except that it belongs to the
device, works with any host, signed out, and offline once installed.

Technique: a Stream Deck SDK style manifest (one id, an entry per OS, a minimum
app version), VS Code style lazy activation and out-of-process hosting (each
plugin in its own Electron utility process), and a signed index in the manner
of Tauri's updater (Ed25519 over the exact bytes, public key in the app).

## Pieces

| Piece | Where |
|---|---|
| Manifest, catalog, settings schema (zod 3 and 4) | `dashboard/packages/core/src/device-plugins.ts` |
| Catalog fetch, signature, stale-while-revalidate cache | `clients/desktop/src/main/plugins/catalog.ts`, `signature.ts` |
| Install, update, disable, uninstall, settings files | `clients/desktop/src/main/plugins/packages.ts` |
| One process per plugin, restart with backoff, permission gate | `clients/desktop/src/main/plugins/supervisor.ts`, `clients/desktop/src/shared/plugin-protocol.ts` |
| USB presence (plug events, no polling) | `clients/desktop/src/main/plugins/presence.ts`, `crates/polaris-core-usb` |
| Electron wiring and the page bridge `window.polarisDesktop.plugins` | `clients/desktop/src/main/plugins/electron.ts` |
| Build, sign, publish | `clients/device-plugins/scripts/publish.mjs`, `version-guard.mjs`, `json.mjs`, `.github/workflows/device-plugins.yml` |
| Listed beside the apps, marked Plugin, with an All / Apps / Plugins switch: the dashboard Marketplace (installs in the desktop app, offers the app in a browser) and the public site (a page per plugin, read from the manifests at build time) | `apps/web/src/app/(app)/apps/marketplace/marketplace-view.tsx` (`PluginsShelf`), `dashboard/apps/site/src/views/plugin-page.tsx` |

## Trust

- The catalog is `catalog.json` + `catalog.json.sig` on the repository's
  `device-plugins` release. CI signs it with the Ed25519 key in the
  `DEVICE_ADDONS_SIGNING_KEY` secret (key id `addons-2026-11`); the app trusts
  the public keys in `TRUSTED_KEYS`. A new key ships in a desktop release
  before the catalog moves to it.
- A catalog is never replaced by one issued earlier than the one held, so a
  withdrawn package cannot be brought back by replaying an old catalog.
- A package is downloaded only on install, must be exactly the size and SHA-256
  the catalog names, may not hold a path that leaves its folder, and its own
  `manifest.json` must agree with the catalog's id, version, entries, claims and
  permissions.
- The person accepts every permission a plugin asks for before it installs.

What the permissions do and do not do: they gate what the APP does for a plugin
(`polaris.action`, `polaris.state`). A plugin's own native code runs with the
user's rights; the utility process isolates crashes, it is not an OS sandbox.
That is why only packages from the signed catalog install.

## Cost

Nothing installed: one small file read 3 s after start (and one a minute later
and every 6 hours, to see whether anything is installed), no process, no fetch.
Installed with its device unplugged: no process (sleeping), woken by the plug
event. The catalog is looked at behind the cached copy whenever the store is opened
(conditionally, with the held list's ETag; one look per 30 s burst of reads),
every hour while the app runs, at once from the store's Check for updates
(which answers whether the list was reached, so it never says "up to date"
without having looked), or, where plugs can be heard, when a claimed device is
plugged in.

USB presence is heard on Linux (sysfs + inotify). On Windows and macOS the Rust
core's Node binding lists vendor and product ids and sleeps on the operating
system's own plug notification (`crates/polaris-core-usb`, the same
`nusb` as the Stream 100 crate; nothing is opened). Where that binding is missing
or older than USB presence, devices are "not known": an installed, enabled plugin
runs as if its device were present and watches for it itself, and the "found"
notice is not offered.

## Updates

`clients/desktop/src/main/plugins/updates.ts` decides, `manager.ts` acts. With anything
installed the catalog is looked at a minute after start and every 6 hours, a
failed look (offline, GitHub down) retried from 5 minutes, doubling up to the
6 hours; opening the store or plugging a claimed device in looks too.

- A newer version that fits this app goes in by itself, the way the app updates
  itself, through the same signed, hashed, manifest-checked install. The setting
  is `autoUpdate` in `installed.json`, for all and per plugin (absent: on), and
  the Device plugins page and each plugin's page switch it.
- A version asking for a permission not accepted before never goes in by
  itself: it waits, the notice and the plugin's page say what it asks for, and
  Update reads out only the new permissions.
- A plugin whose status is `busy` is not updated until it says otherwise.
- The version an update replaced stays on disk (`previous`); when the new one
  stops after crashing, the app goes back to it, removes the failed one and
  never puts that version in by itself again (`failed`). One earlier version is
  kept, never more.
- Each version is announced once with a desktop notice (`notified`): updated,
  waiting for your OK, available (automatic updates off, or it failed before),
  or rolled back. The notice's text is the catalog entry's `changelog` (from the
  plugin's `listing.json`), first line. Clicking it opens the plugin's page.

Every field added to `installed.json` and to the snapshot is optional, so an
older app or page reads the files and answers of a newer one and the other way
round; an app older than automatic updates shows no switch and updates nothing
by itself.

## Settings

A plugin declares its settings (`toggle`, `choice`, `range`, `action`) with
labels in every language Polaris ships (`en-US`, `es-ES`); Polaris draws them
with its own components (`Switch`, `Select`, `ControlSlider`), whose lists open
above the page and follow its theme. Values are kept per device in
`plugins/settings/<id>.json`, checked against the declaration on every read and
write.

`groups` lays them out: each is a titled section (`key`, `label`, optional
`hint`) with a `look` - `rows` (one row per setting), `dials` or `buttons` (a
tile per setting with a knob or a lit button drawn above its control, four
across, two on a phone). A setting joins one with `group`; those in none come
first. An app older than groups reads the same settings as one list.

A plugin may also name a `view` for what plain settings cannot draw, such as a
preview of the device's screen.

**A view shows; it never asks.** Every control is a declared setting. A select,
checkbox, slider or text box inside a frame is the browser's own - it matches
nothing around it, and the frame clips its list - so a view holds none:
`clients/desktop/test/main/plugins/view-rules.test.ts` fails on any form control or
control role in a repository plugin's view folder, and on a text missing a
language.

## Status

A running plugin reports how its device is (`state`), with an English sentence
(`detail`) and a name for it (`code`). The page says it in the reader's language:

1. the plugin's own `statusTexts[code]` (`en-US`, `es-ES`, ...), from the installed
   version's manifest, then the catalog's newer one;
2. Polaris's sentence for a code any plugin may use (`otherProgram`, `noAccess`,
   `unsupported`, `stopped`, `unplugged`, `noControls`), with the plugin's name in it;
3. the plugin's `detail`, as it sent it.

**A plugin's words live in its package, never in the dashboard.** A sentence,
name or code of one plugin written into the dashboard means a release of that
plugin changes the dashboard too, which publishes a web image and offers every
deployment a Polaris update for a plugin change.
`dashboard/apps/web/test/updates/plugin-free-dashboard.test.ts` fails on any
repository plugin's id, name, device or status code in the dashboard's sources,
messages or packages. A desktop app older than `statusTexts` drops them, so the
plugin's English `detail` shows there until it updates.

## Views

A view is a page in the package (`manifest.view`, e.g. `view/index.html`). The
desktop app serves the folder holding it as `polaris-plugin://<id>/`
(`clients/desktop/src/main/plugins/view.ts`): only files of that folder, only web file
types, under a policy that loads nothing from elsewhere and reaches no network.
The plugin's page in Settings frames it with `sandbox="allow-scripts"` (no same
origin) and speaks `postMessage` (`apps/web/src/lib/device-plugin-view.ts`):

- the view sends `{type: "ready"}`, and gets `{type: "hello", locale, theme, tokens}`
  (the page's design tokens, e.g. `--background`, `--primary`, `--radius`); the same
  message comes again whenever the theme, a token or the language changes while the
  view is open, so a view redraws on every `hello`, not only the first;
- `{type: "settings", values}` comes after ready and whenever the plugin's settings change
  outside the view (the list above it, another window);
- `{type: "resize", height}` sets the frame's height (120 to 1600 px). The frame
  has no edge and no scrollbar of its own, so a view reports the height of what
  it draws (its root element's box, never `document.scrollHeight`, which is at
  least the frame's and can never shrink), uses the page's `--background` and no
  padding of its own, and reads as part of the page;
- `{type: "call", id, method, params}` gets `{type: "reply", id, ok, value | error}`.
  The methods are the process's own (`settings.get`, `polaris.state`,
  `polaris.action`, judged against the granted permissions) and `settings.set`
  (`{key, value}`, checked against the declared settings), which only a view has;
  so is `driver.look`, the state of the device's own driver and why its last
  change did not go through, which the app answers per plugin (`null` for one
  with no driver of its own). The setup itself is a requirement (below), not a
  setting.

## Requirements and host actions

A manifest may list, per platform, what the client sets up for the plugin to
work fully (`requires`, e.g. a driver on `win32-x64`): a key and the plugin's
own words (`label`, `hint`, `missing`, `restored`). The install and update
consent lists each one beside the permissions, and the install sends the keys
it listed (`plugins.install(id, accepted, requires)`); that is the consent.
The desktop app (`plugins/requirements.ts`) sets each one up right after the
install, puts it back by itself on start and on a USB change when something
else undid it, and never sets up one that was not consented to. One that is
missing and will not be set up by itself (never consented to, or its last
setup was declined or failed) is listed in the snapshot as a host action
(`InstalledPlugin.actions`: id, label, detail), which the page draws next to
Uninstall and runs through `plugins.runAction(id, action)`. Both fields are
optional: an older client drops `requires` and lists no actions, an older page
draws neither and sends no keys, so nothing is set up without a consent.

## Ways in

The store's Installed tab, the "found" notice, a launcher row "Configure <name>"
for every installed plugin, a tray item while its device is plugged in
(`plugins/ways-in.ts`; Windows and Linux, which have the tray), and a Device
plugins page in the app's own settings that lists them and turns them on and
off offline.

## Publishing a plugin

`clients/device-plugins/<id>/manifest.json`, optional `listing.json` (`icon`,
`screenshots`, `changelog`), and the files under `any/` and `<platform>/` (a
platform's own files laid over `any/`). A native module is not committed: the
workflow builds it per platform into `<platform>/` before packaging (the
`native` job). A push to main touching `clients/device-plugins/**` publishes the catalog.

**Any change to what a package holds needs a new version.** An app compares
versions, not bytes: a package republished under a version it already holds is
never taken (0.1.4 of the Stream 100 went out twice, and the computers that had
the first one kept it). `clients/device-plugins/scripts/version-guard.mjs` fails the
workflow when a packaged file (`manifest.json`, `any/`, `<platform>/`, or a
native module's crate) changed since the commit the published catalog names
(`commit`) and the version did not.

The catalog and each package's `manifest.json` are written as ASCII JSON, every
other character as a `\uXXXX` escape (`clients/device-plugins/scripts/json.mjs`). GitHub
serves release files with no charset, and a reader that falls back to Latin-1
showed "botón" as "botÃ³n"; escaped, the bytes read the same either way.

## Names from before the rename

Plugins were called add-ons until desktop 0.1.124. Desktop apps and hosts
update on their own schedules, so both names are still honoured:

| Old name | Kept as |
|---|---|
| `device-addons` release | CI publishes the same signed catalog and packages there too; clients fall back to it |
| catalog field `addons` | written beside `plugins`; read when `plugins` is absent |
| `window.polarisDesktop.addons`, `polarisLauncher.addons()` | the same objects as `plugins` |
| IPC `desktop:addons-*`, `launcher:addons` | answered beside the new channels |
| `polaris-addon://` | still the view address (older hosts frame only it); `polaris-plugin://` is served too |
| `/account/addons`, `/api/addons/catalog`, site `marketplace/addons/<id>/` | alias routes; the desktop still opens `/account/addons`, which every host serves |
| `addons/` data folder, `installed.json` `addons` | moved and read once, saved under the new name |

All of it can go once no supported desktop app or host predates 0.1.124.
