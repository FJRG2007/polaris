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
| USB presence (plug events, no polling) | `desktop/src/main/addons/presence.ts`, `crates/polaris-core-node/src/usb.rs` |
| Electron wiring and the page bridge `window.polarisDesktop.addons` | `desktop/src/main/addons/electron.ts` |
| Build, sign, publish | `scripts/device-addons/publish.mjs`, `.github/workflows/device-addons.yml` |

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

Nothing installed: one small file read 3 s after start, no process, no fetch.
Installed with its device unplugged: no process (sleeping), woken by the plug
event. The catalog is fetched when the store is opened (refreshed at most every
6 hours behind the cached copy) or, where plugs can be heard, when a claimed
device is plugged in.

USB presence is heard on Linux (sysfs + inotify). On Windows and macOS the Rust
core's Node binding lists vendor and product ids and sleeps on the operating
system's own plug notification (`crates/polaris-core-node/src/usb.rs`, the same
`nusb` as the Stream 100 crate; nothing is opened). Where that binding is missing
or older than USB presence, devices are "not known": an installed, enabled add-on
runs as if its device were present and watches for it itself, and the "found"
notice is not offered.

## Settings

An add-on declares its settings (`toggle`, `choice`, `range`, `action`) with
English labels and any other languages it ships; Polaris draws them with its own
controls. Values are kept per device in `addons/settings/<id>.json`, checked
against the declaration on every read and write. An add-on may also name a
`view` for what plain settings cannot draw, shown in a sandboxed frame.

## Views

A view is a page in the package (`manifest.view`, e.g. `view/index.html`). The
desktop app serves the folder holding it as `polaris-addon://<id>/`
(`desktop/src/main/addons/view.ts`): only files of that folder, only web file
types, under a policy that loads nothing from elsewhere and reaches no network.
The add-on's page in Settings frames it with `sandbox="allow-scripts"` (no same
origin) and speaks `postMessage` (`apps/web/src/lib/device-addon-view.ts`):

- the view sends `{type: "ready"}`, and gets `{type: "hello", locale, theme, tokens}`
  (the page's design tokens, e.g. `--background`, `--primary`, `--radius`);
- `{type: "resize", height}` sets the frame's height (120 to 1600 px);
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
