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
| USB presence (plug events, no polling) | `desktop/src/main/addons/presence.ts` |
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

USB presence is heard on Linux (sysfs + inotify). On Windows and macOS there is
no device list without native code yet, so an installed, enabled add-on runs as
if its device were present and watches for it itself, and the "found" notice is
not offered there.

## Settings

An add-on declares its settings (`toggle`, `choice`, `range`, `action`) with
English labels and any other languages it ships; Polaris draws them with its own
controls. Values are kept per device in `addons/settings/<id>.json`, checked
against the declaration on every read and write. An add-on may also name a
`view` for what plain settings cannot draw, shown in a sandboxed frame.

## Publishing an add-on

`device-addons/<id>/manifest.json`, optional `listing.json` (`icon`,
`screenshots`, `changelog`), and the files under `any/` and `<platform>/` (a
platform's own files laid over `any/`). A native module is not committed: the
workflow builds it per platform into `<platform>/` before packaging (the
`native` job). A push to main touching `device-addons/**` publishes the catalog.
