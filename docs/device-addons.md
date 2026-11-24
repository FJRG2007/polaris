# Device add-ons

Support for a piece of hardware (the Hercules Stream 100 first) installed on one
device, the way an app is installed on a host - except that it belongs to the
device, works with any host, signed out, and offline once installed.

Technique: a Stream Deck SDK style manifest (one id, an entry per OS, a minimum
app version), VS Code style lazy activation and out-of-process hosting (each
add-on in its own Electron utility process), and a signed index in the manner
of Tauri's updater (Ed25519 over the exact bytes, public key in the app).

## Pieces

| Piece | Where |
|---|---|
| Manifest, catalog, settings schema (zod 3 and 4) | `dashboard/packages/core/src/device-addons.ts` |
| Catalog fetch, signature, stale-while-revalidate cache | `desktop/src/main/addons/catalog.ts`, `signature.ts` |
| Install, update, disable, uninstall, settings files | `desktop/src/main/addons/packages.ts` |
| One process per add-on, restart with backoff, permission gate | `desktop/src/main/addons/supervisor.ts`, `desktop/src/shared/addon-protocol.ts` |
| USB presence (plug events, no polling) | `desktop/src/main/addons/presence.ts`, `crates/polaris-core-usb` |
| Electron wiring and the page bridge `window.polarisDesktop.addons` | `desktop/src/main/addons/electron.ts` |
| Build, sign, publish | `scripts/device-addons/publish.mjs`, `.github/workflows/device-addons.yml` |
| Listed beside the apps, marked Add-on, with an All / Apps / Add-ons switch: the dashboard Marketplace (installs in the desktop app, offers the app in a browser) and the public site (a page per add-on, read from the manifests at build time) | `apps/web/src/app/(app)/apps/marketplace/marketplace-view.tsx` (`AddonsShelf`), `dashboard/apps/site/src/views/addon-page.tsx` |

## Trust

- The catalog is `catalog.json` + `catalog.json.sig` on the repository's
  `device-addons` release. CI signs it with the Ed25519 key in the
  `DEVICE_ADDONS_SIGNING_KEY` secret (key id `addons-2026-11`); the app trusts
  the public keys in `TRUSTED_KEYS`. A new key ships in a desktop release
  before the catalog moves to it.
- A catalog is never replaced by one issued earlier than the one held, so a
  withdrawn package cannot be brought back by replaying an old catalog.
- A package is downloaded only on install, must be exactly the size and SHA-256
  the catalog names, may not hold a path that leaves its folder, and its own
  `manifest.json` must agree with the catalog's id, version, entries, claims and
  permissions.
- The person accepts every permission an add-on asks for before it installs.

What the permissions do and do not do: they gate what the APP does for an add-on
(`polaris.action`, `polaris.state`). An add-on's own native code runs with the
user's rights; the utility process isolates crashes, it is not an OS sandbox.
That is why only packages from the signed catalog install.

## Cost

Nothing installed: one small file read 3 s after start (and one a minute later
and every 6 hours, to see whether anything is installed), no process, no fetch.
Installed with its device unplugged: no process (sleeping), woken by the plug
event. The catalog is fetched when the store is opened (refreshed at most every
6 hours behind the cached copy) or, where plugs can be heard, when a claimed
device is plugged in.

USB presence is heard on Linux (sysfs + inotify). On Windows and macOS the Rust
core's Node binding lists vendor and product ids and sleeps on the operating
system's own plug notification (`crates/polaris-core-usb`, the same
`nusb` as the Stream 100 crate; nothing is opened). Where that binding is missing
or older than USB presence, devices are "not known": an installed, enabled add-on
runs as if its device were present and watches for it itself, and the "found"
notice is not offered.

## Updates

`desktop/src/main/addons/updates.ts` decides, `manager.ts` acts. With anything
installed the catalog is looked at a minute after start and every 6 hours, a
failed look (offline, GitHub down) retried from 5 minutes, doubling up to the
6 hours; opening the store or plugging a claimed device in looks too.

- A newer version that fits this app goes in by itself, the way the app updates
  itself, through the same signed, hashed, manifest-checked install. The setting
  is `autoUpdate` in `installed.json`, for all and per add-on (absent: on), and
  the Device add-ons page and each add-on's page switch it.
- A version asking for a permission not accepted before never goes in by
  itself: it waits, the notice and the add-on's page say what it asks for, and
  Update reads out only the new permissions.
- An add-on whose status is `busy` is not updated until it says otherwise.
- The version an update replaced stays on disk (`previous`); when the new one
  stops after crashing, the app goes back to it, removes the failed one and
  never puts that version in by itself again (`failed`). One earlier version is
  kept, never more.
- Each version is announced once with a desktop notice (`notified`): updated,
  waiting for your OK, available (automatic updates off, or it failed before),
  or rolled back. The notice's text is the catalog entry's `changelog` (from the
  add-on's `listing.json`), first line. Clicking it opens the add-on's page.

Every field added to `installed.json` and to the snapshot is optional, so an
older app or page reads the files and answers of a newer one and the other way
round; an app older than automatic updates shows no switch and updates nothing
by itself.

## Settings

An add-on declares its settings (`toggle`, `choice`, `range`, `action`) with
labels in every language Polaris ships (`en-US`, `es-ES`); Polaris draws them
with its own components (`Switch`, `Select`, `ControlSlider`), whose lists open
above the page and follow its theme. Values are kept per device in
`addons/settings/<id>.json`, checked against the declaration on every read and
write.

`groups` lays them out: each is a titled section (`key`, `label`, optional
`hint`) with a `look` - `rows` (one row per setting), `dials` or `buttons` (a
tile per setting with a knob or a lit button drawn above its control, four
across, two on a phone). A setting joins one with `group`; those in none come
first. An app older than groups reads the same settings as one list.

An add-on may also name a `view` for what plain settings cannot draw, such as a
preview of the device's screen.

**A view shows; it never asks.** Every control is a declared setting. A select,
checkbox, slider or text box inside a frame is the browser's own - it matches
nothing around it, and the frame clips its list - so a view holds none:
`desktop/test/main/addons/view-rules.test.ts` fails on any form control or
control role in a repository add-on's view folder, and on a text missing a
language.

## Views

A view is a page in the package (`manifest.view`, e.g. `view/index.html`). The
desktop app serves the folder holding it as `polaris-addon://<id>/`
(`desktop/src/main/addons/view.ts`): only files of that folder, only web file
types, under a policy that loads nothing from elsewhere and reaches no network.
The add-on's page in Settings frames it with `sandbox="allow-scripts"` (no same
origin) and speaks `postMessage` (`apps/web/src/lib/device-addon-view.ts`):

- the view sends `{type: "ready"}`, and gets `{type: "hello", locale, theme, tokens}`
  (the page's design tokens, e.g. `--background`, `--primary`, `--radius`); the same
  message comes again whenever the theme, a token or the language changes while the
  view is open, so a view redraws on every `hello`, not only the first;
- `{type: "settings", values}` comes after ready and whenever the add-on's settings change
  outside the view (the list above it, another window);
- `{type: "resize", height}` sets the frame's height (120 to 1600 px). The frame
  has no edge and no scrollbar of its own, so a view reports the height of what
  it draws (its root element's box, never `document.scrollHeight`, which is at
  least the frame's and can never shrink), uses the page's `--background` and no
  padding of its own, and reads as part of the page;
- `{type: "call", id, method, params}` gets `{type: "reply", id, ok, value | error}`.
  The methods are the process's own (`settings.get`, `polaris.state`,
  `polaris.action`, judged against the granted permissions) and `settings.set`
  (`{key, value}`, checked against the declared settings), which only a view has.

## Ways in

The store's Installed tab, the "found" notice, a launcher row "Configure <name>"
for every installed add-on, a tray item while its device is plugged in
(`addons/ways-in.ts`; Windows and Linux, which have the tray), and a Device
add-ons page in the app's own settings that lists them and turns them on and
off offline.

## Publishing an add-on

`device-addons/<id>/manifest.json`, optional `listing.json` (`icon`,
`screenshots`, `changelog`), and the files under `any/` and `<platform>/` (a
platform's own files laid over `any/`). A native module is not committed: the
workflow builds it per platform into `<platform>/` before packaging (the
`native` job). A push to main touching `device-addons/**` publishes the catalog.
