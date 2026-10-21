# Stream Deck - plan

Polaris on a Stream Deck: keys and dials that run Polaris actions and show live
Polaris state. One more surface of the product, like the browser extension, and
built the same way: the dashboard owns the logic and the device holds a scoped
credential and draws what it is told.

## Prior art

- **Home Assistant plugin** (Elgato Marketplace, Christoph Giesche): any service
  on key press, long press, touch tap or dial turn; keys show live entity state
  with icons and colours that follow it; templated titles; global display themes.
  Setup is a base URL and a long-lived token. The token paste is the part not to
  copy: Polaris already has a device sign-in.
- **Elgato Stream Deck SDK** (docs.elgato.com/streamdeck/sdk): TypeScript on
  Node.js, `@elgato/streamdeck` for the plugin and `@elgato/cli` for
  `streamdeck create | validate | pack`. `manifest.json` declares the plugin
  (`UUID` reverse-DNS, fixed after publication), its actions (`Controllers`
  `Keypad`/`Encoder`, `States`, `PropertyInspectorPath`, `Encoder.layout`),
  `CodePath`, `Nodejs.Version` (20, 24 or 26), `SDKVersion` (2 or 3),
  `Software.MinimumVersion` and `OS` (mac, windows). Settings screens are HTML
  property inspectors. `streamdeck pack <dir>.sdPlugin --output dist/ --version x
  --no-update-check` produces the `.streamDeckPlugin` installer.
- **OpenDeck** (github.com/nekename/OpenDeck): Linux, Windows and macOS host that
  runs plugins written for the Elgato SDK and the OpenAction API. A Node.js plugin
  needs a native Node.js there (not the Flatpak one). One plugin serves both.
- **Bitfocus Companion**: its own module system (`@companion-module/base`:
  actions, feedbacks, variables, presets). A second, separate module, after the
  Elgato plugin.
- **Elgato Marketplace**: submitted through Maker Console by a maker account;
  validate and pack with the CLI first; the name must not contain "Plugin" or
  "Stream Deck"; icon 256x256 and 512x512 PNG; Elgato may ask for changes.

## Shape

### Connecting (no token paste)

The plugin's settings screen shows "Connect to Polaris": it asks for the Polaris
address, opens a device-authorization request (RFC 8628) and shows the short
code; the person approves it in a signed-in browser. This is the grant the CLI
(`lib/cli/sign-in.ts`) and the extension already use, and what it hands back is
an ordinary API key of a new kind `streamdeck`: scoped, narrowed to what its
owner holds at every call, listed on the API keys screen and revocable there.
The key is stored in the plugin's global settings, never in a key's own settings.

### Polaris side

- `GET /api/deck/actions`: the catalogue of what this person can put on a key,
  already filtered by permission and by which apps are installed. Each entry:
  id, kind (`run`, `toggle`, `state`, `dial`), label, icon, the options it takes
  (validated with Zod), and whether it has live state.
- `POST /api/deck/run`: run one action with its options. Zod-validated,
  permission-checked, rate limited per key, idempotent where the action allows.
- `GET /api/deck/state` (SSE): live state for the actions on the person's keys,
  pushed on change (the existing event buses: chat unread, calls, watch,
  places), with a heartbeat; the plugin subscribes once for all its keys.
- Account -> Downloads gets a Stream Deck section next to the extension:
  download, what it does, and the connected decks with "Disconnect".

### First actions

| Area | Keys | Dials |
| --- | --- | --- |
| Chat | send a saved message to a channel or DM; unread count on the key; open Polaris on a channel | - |
| Calls | join a room, leave, mute/unmute (state on the key), camera, raise hand | volume |
| Status | set a status / Do not disturb (state on the key) | - |
| Watch | a monitor's up/down and latency on the key; acknowledge an alarm | - |
| Deploy | redeploy a service; its last deployment state on the key | - |
| Places | toggle a device; its state on the key; run a scene/automation | brightness, temperature |
| Timers | start/pause/reset a countdown or stopwatch (runs in the plugin, mirrored to Polaris when asked) | set the time |
| Polaris | notification count; open a Polaris page | - |

Each key draws a rendered SVG (state colour, icon, short value) so the look does
not depend on bundled per-state images.

### Repository

- `dashboard/apps/streamdeck/` - the plugin: `io.github.fjrg2007.polaris.sdPlugin/` (plugin UUID `io.github.fjrg2007.polaris`: reverse-DNS of the GitHub account that owns the repository, fixed once published)
  (manifest, assets, property inspectors), `src/` (actions, API client, SSE),
  rollup build. Its own `package.json`; dependency vetted and pinned in the
  lockfile (regenerate with `npx npm@10 --package-lock-only`).
- CI: build, test, `streamdeck validate` and `streamdeck pack` on every change to
  that folder; a `streamdeck-v*` tag publishes the `.streamDeckPlugin` to a GitHub
  release, which the Downloads page links, the same as the extension.

### Not Polaris's to do

Publishing on the Elgato Marketplace needs a maker account and a submission in
Maker Console. Until then the plugin installs from the Downloads page.

## Phases

1. Polaris API (catalogue, run, live state), `streamdeck` key kind on the device
   grant, Downloads section.
2. The plugin: connect, chat, calls, status, watch, places, timers; keys and dials.
3. CI pack and release.
4. Bitfocus Companion module over the same API.
