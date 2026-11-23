# Polaris Terminal: integrating Rook

Rook (github `FJRG2007/rook`) is a Windows-tuned fork of Warp's open-source
terminal. It moves into this repository at `terminal/` and becomes Polaris
Terminal. This page records, per area, what Rook does today, what Polaris
already exposes for it, the gap, and the step that closes it. It was written
from a read-only study of Rook at `e27330095` (upstream Warp through
`f8223cef2`).

## Ground rules for the move

- **License.** Rook's workspace is `AGPL-3.0-only` (with Warp's MIT-licensed UI
  framework crates, kept under `LICENSE-MIT`). Polaris is `AGPL-3.0-only` too, so
  the code moves without relicensing. Keep `LICENSE-MIT` and `about.toml` /
  `about.hbs` (the `cargo about` third-party notice) inside `terminal/`. New
  crates written for the terminal on the Polaris side follow the workspace
  license field of the workspace they live in.
- **A separate Cargo workspace.** `terminal/` keeps its own `Cargo.toml`,
  `Cargo.lock` and `rust-toolchain.toml` (Rook pins `1.94.0` with rustfmt,
  clippy and rust-analyzer; the root pins `stable` plus the musl targets for
  hostd and the tunnel). Merging the two workspaces would put about 80 crates
  and Rook's dependency tree (wgpu, winit forks, diesel, ONNX runtime) into
  every hostd and tunnel build, and change the root `Cargo.lock` that the tunnel
  fingerprint check pins. The root `Cargo.toml` therefore needs
  `exclude = [..., "terminal"]` once the directory exists, so a `cargo` command
  run at the root never adopts it. Polaris crates the terminal consumes (for
  example `polaris-core`) are referenced by path from `terminal/`, not the other
  way round.
- **Keep Rook's `.gitattributes` rules, re-rooted.** Its terminal recordings
  (`app/src/terminal/ref_tests/data/** -text`) must stay byte-exact or seven
  reference tests fail on macOS and Linux only. Every pattern gains the
  `terminal/` prefix.
- **Preserve the executable bit** when copying (Rook's own CLAUDE.md: 60 files
  under `script/` landed as 644 once and broke every non-Windows CI job). Copy
  with `git archive` / `git read-tree --prefix=terminal/` (or a subtree merge,
  which also keeps history), never `robocopy`.

## Rename map

`script/rebrand.py` already turned `warp` into `rook`; the same script, with a
new target, does `rook` into the Polaris names. Its exception list (upstream
third-party forks, the five external crates carrying the upstream brand,
protobuf types reached through `api::`, binary assets, the tokenizer
vocabulary, `XWarpPointer`) carries over unchanged.

| Old | New | Notes |
| --- | --- | --- |
| crate `rook_*` (e.g. `rook_core`, `rook_terminal`, `rook_cli`) | `pterm_*` (`pterm_core`, `pterm_terminal`, `pterm_cli`) | 19 crates. |
| crate `rookui`, `rookui_core`, `rookui_extras` | `ptermui`, `ptermui_core`, `ptermui_extras` | |
| package `rook` (`app/`) | `polaris-terminal` | |
| binary `rook-oss` (released), `rook`, `dev`, `stable`, `preview`, `integration` | `polaris-terminal` (released), the others `polaris-terminal-<channel>` | Release asset names change with it. |
| `rookctrl` (the app binary run with `--rookctrl`) | `polaris terminal ...` (a CLI subcommand, see "CLI integration") | The app keeps a hidden `--control` flag for the bundled fallback. |
| URL scheme `rook`, `rookoss`, `rookdev`, ... | `polaris-terminal`, `polaris-terminal-dev`, ... | Must not collide with `polaris://`, which Desktop owns. |
| AppId `dev.rook.RookOss` | `dev.polaris.PolarisTerminal` | Changes the per-user data directories; see "User data". |
| home config dir `~/.rook-oss` (`~/.rook` for stable/preview, `~/.rook-<channel>`) | `~/.polaris-terminal` (`~/.polaris-terminal-<channel>`) | |
| per-repository dir `./.rook/` (workflows, skills, attachments) | `./.polaris/terminal/` | Read the old one too; see "User data". |
| `~/.rook/custom_model_routers/`, `~/.rook/skills/`, `~/.rook/.mcp.json` | under `~/.polaris-terminal/` | |
| SQLite `rook.sqlite` | `polaris-terminal.sqlite` | |
| env `ROOK_*` (162 distinct names, e.g. `ROOK_TERMINAL_SESSION_UUID`, `ROOK_FOCUS_URL`) | `POLARIS_TERMINAL_*` | Shell bootstrap scripts under `app/assets/bundled/bootstrap/` read them; rename in the same commit. Plugins under `plugins/` (Claude Code, Codex, OpenCode) read some of them too. |
| User-Agent `Rook-MCP-Client/1.0` | `Polaris-Terminal-MCP-Client/1.0` | |
| Installer display name `Rook`, identity `RookOss` | `Polaris Terminal`, `PolarisTerminal` | |
| Release tags `v0.YYYY.MM.DD.HH.MM.oss_NN` | `terminal-v0.YYYY.MM.DD.HH.MM.oss_NN` | See "Update channel". |

## Areas

### Workspace layout and toolchain

- **Rook today:** one workspace, `app/` plus 79 crates under `crates/`, nix
  flake, `deny.toml`, `diesel.toml`, `script/` (bundling per OS, `release_tag`,
  `rebrand.py`), `specs/`, `docs/`, `plugins/` (CLI-agent hooks), `resources/`.
  Toolchain `1.94.0`.
- **Polaris:** root Cargo workspace for hostd, tunnel, core and their bindings,
  toolchain `stable`.
- **Gap:** none beyond the separation above.
- **Step:** move the tree to `terminal/` unchanged except for the rename; add
  `"terminal"` to the root workspace `exclude`; keep `terminal/rust-toolchain.toml`
  (rustup picks the nearest one, so `cargo` inside `terminal/` gets 1.94.0).

### CI

- **Rook today:** `ci.yml` (clippy, nextest with `--no-fail-fast`, release-profile
  check on Windows, macOS, Linux; `cargo fmt --check` on Linux; unfiltered
  triggers with a `changes` job; a nightly schedule), `release.yml` (on `v*`
  tags: Windows `.exe`, macOS `.dmg`, Linux AppImage onto the GitHub release),
  `auto-release.yml` (tags main after a green CI with non-doc changes).
- **Polaris:** `.github/workflows/terminal.yml` (added with this page) is the
  path-filtered scaffold: unfiltered triggers, a `changes` job that looks for
  `terminal/**`, and a single `terminal` result job that always reports. While
  `terminal/` does not exist it reports green in seconds.
- **Gap:** the real build jobs.
- **Step:** port Rook's `ci.yml` jobs into `terminal.yml` behind
  `needs.changes.outputs.terminal == 'true'`, with `working-directory: terminal`
  and `Swatinem/rust-cache` `workspaces: terminal -> target`. Port `release.yml`
  as `terminal-release.yml` on `terminal-v*` tags. Do not port
  `auto-release.yml` as-is: it would tag every main push that touches anything
  outside docs, which in this repository is every dashboard change; restrict
  its diff to `terminal/`.

### LFS

- **Rook today:** seven LFS objects, about 130 MB: the ConPTY/OpenConsole
  `.pdb` symbols for x64 and arm64 (77 MB) and three ONNX input-classifier
  models `bert_tiny_v1..v3.onnx` (54 MB).
- **Polaris:** no LFS today.
- **Gap:** every clone of Polaris would pull 130 MB it does not use.
- **Step:** keep LFS scoped to `terminal/` only (`terminal/**/*.pdb`,
  `terminal/crates/input_classifier/models/**`), and have every non-terminal CI
  job check out with `lfs: false` (the default). Better still, check whether the
  `.pdb` files are needed in the repository at all - they are debug symbols for
  the bundled ConPTY and could be fetched by the bundling script from the
  Windows Terminal release they come from. Decide before the import, because an
  LFS object once pushed stays in the history.

### Auth and sign-in

- **Rook today:** Warp's Firebase flow, disabled. `AuthManager::sign_in_url` opens
  `{server_root_url}/login/remote?scheme=<url scheme>&state=<nonce>`, the browser
  redirects back to `rookoss://...` with a Firebase refresh token, and a "paste
  auth token" modal covers the case where the redirect does not arrive. The
  server URL is `https://server.rook.invalid`, so nothing signs in.
- **Polaris exposes:** the device-authorization grant (RFC 8628) behind
  `plr login`, the Stream Deck and Polaris TV (`lib/cli/sign-in.ts`), which mints
  an ordinary, scoped, revocable API key of the client's own kind, listed under
  Sessions. **Added with this page:** the `terminal` kind -
  `POST /api/terminal/authorize` (opens a request: device name, version,
  machine id, scopes from `TERMINAL_SCOPES`), `POST /api/terminal/authorize/claim`
  (poll; hands the key over exactly once), `DELETE /api/terminal/session` (the
  terminal signs itself out), and the approval page `/account/terminal?code=...`.
  The key carries `polar.use` and `polar.spend`, each narrowed to what the
  approving account holds.
- **Gap (terminal side):** replace the Firebase flow. `sign_in_url` becomes: POST
  `/api/terminal/authorize` with `deviceName` (hostname), `clientVersion`,
  `device.id` (the hashed machine id the CLI already computes), open
  `<instance>/<approvePath>` in the browser, poll `claim` every `pollMs`, store the
  token in the OS keychain (Rook already has a secure-storage path for its
  refresh token). Send `User-Agent: polaris-terminal/<version> (<platform>; <arch>)`
  so the approval screen names the OS. The URL-scheme redirect and the paste
  modal go away; the device grant needs neither.
- **Shared sign-in with Desktop (built on the Polaris side):** when Desktop is
  running, the terminal skips the browser. After opening its request it
  connects to Desktop's native-host socket - the named pipe
  `\\.\pipe\polaris-desktop-native-host-<user>` on Windows (user name
  lowercased, anything outside `[a-z0-9._-]` as `_`; check the pipe's server runs
  as the same user before writing, as `crates/polaris-native-host/src/ipc.rs`
  does), `~/Library/Application Support/Polaris/native-host/desktop.sock` on
  macOS, `$XDG_CONFIG_HOME/Polaris/native-host/desktop.sock` (default
  `~/.config`) on Linux - and sends one frame: a 32-bit little-endian length,
  then `{ "type": "terminal-sign-in", "server": "<instance origin>",
  "userCode": "BCDF-GHJK" }`. Desktop answers one frame, `{ "ok": true }` or
  `{ "ok": false, "reason" }` with `reason` one of `other-server` (Desktop shows
  another Polaris), `signed-out`, `refused` (the person said no, the server
  refused, or another question is already on screen), `unreachable` or
  `bad-request`, and closes. Desktop reads the request
  (`POST /api/terminal/authorize/describe`), asks in its own dialog naming the
  device, system, code and scopes, and answers it
  (`POST /api/terminal/authorize/answer`) over its own session, through the
  approval page's service (`lib/cli/approval.ts`). On `ok` the terminal's claim
  poll collects its key as usual; on anything else, or with no socket at all
  (an older Desktop answers `bad-request`), it opens the approval page instead.
  The terminal still holds its own key; Desktop never hands out its session.
  Desktop 0.1.62 carries it.
- **Instance address:** the terminal asks for the Polaris address once (the
  same field the CLI and Desktop take) and verifies it with `GET /api/instance`.
  The same-instance local fallback rule applies (`/api/instance` publishes
  `localCaSha256`; accept a LAN address only after it proves to be the same
  instance).

### AI providers (`agent_sdk`, `rook_agent_page`)

- **Rook today:** two separate things.
  1. Warp's built-in agent sends protobuf requests (`warp_multi_agent_api`) to
     `{server_root_url}/ai/multi-agent` and `/ai/passive-suggestions` as
     server-sent events. All tool orchestration lives on Warp's server, which
     does not exist here, so the built-in agent is inert. "Custom endpoints"
     (`app/src/ai/custom_endpoints.rs`: OpenAI-compatible `base_url` + key) and
     custom model routers (`~/.rook/custom_model_routers/*.yaml`) only describe
     models to that same server.
  2. `agent_sdk` drives third-party CLI agents (Claude Code, Codex, OpenCode)
     inside terminal panes, with per-agent hooks vendored under `plugins/`.
     This works locally and needs nothing from a server.
- **Polaris exposes:** Polar's compatible endpoints over an API key with
  `polar.use`: `/api/v1/chat/completions` (OpenAI), `/api/v1/messages` and
  `count_tokens` (Anthropic), `/api/v1/responses`, `/api/v1/models`, plus agent
  sessions at `/api/v1/sessions`. They run on Polar's own provider layer and
  routing, including the deployment's keys when the key has `polar.spend`.
- **Gap:** the built-in agent has no backend. Implementing Warp's
  `multi-agent` protobuf server inside Polaris means re-creating Warp's
  server-side agent (planning, tool-call loop, context, suggestions); that is a
  project of its own and is not started here.
- **Step:** in the terminal, replace `generate_multi_agent_output` with a
  client-side agent loop that calls Polar's OpenAI-compatible endpoint with the
  terminal's key (streaming, tool calls executed locally against the pane), and
  point "custom endpoints" at the same loop so a user's own provider key works
  too. Model lists come from `/api/v1/models`. Remove the server-only surfaces
  (credits, billing, Oz/cloud agents, ambient agents) rather than leaving them
  pointed at `.invalid`. Keep `agent_sdk`'s CLI-agent harness as it is.

### Remote control (`rookctrl`, local control, `remote_server`)

- **Rook today:**
  - `local_control` + `rookctrl`: a loopback HTTP endpoint (`127.0.0.1` only)
    per running instance, discovered through an owner-only directory of JSON
    records; a per-instance Unix-socket broker issues short-lived credentials
    scoped to one exact action after a peer-UID check. 89 actions
    (`window.*`, `tab.*`, `pane.*`, `session.*`, `input.insert`/`replace`,
    `setting.*`, `theme.*`, `surface.*`, ...), envelope
    `{ protocol_version, request_id, target, action }`. Off unless "Scripting"
    is enabled.
  - `remote_server`: Warp's SSH remote-server binary (code intelligence over
    SSH), unrelated to remote control of the app.
- **Polaris exposes:** nothing for controlling a terminal from elsewhere. The
  closest pieces are the deploy console's WebSocket sidecar (`apps/web/ws-server.mjs`,
  ticket over `Sec-WebSocket-Protocol`, routed by Traefik at `/api/deploy/ws`)
  and the agent runner protocol (`docs/runner-protocol.md`).
- **Built:** the relay, so one signed-in account reaches every terminal it
  owns:
  - **Transport:** the terminal keeps one outbound WebSocket to
    `wss://<instance>/api/deploy/ws/terminal?role=instance` with its `terminal`
    key as a Bearer token. The path sits under `/api/deploy/ws`, which the edge
    already routes to the sidecar (priority 100), so an existing install needs
    no new router. Outbound only, so it works behind NAT with no port opened on
    the PC. A controller (the CLI, a script, another terminal) dials the same
    path with `?role=controller` and any key holding `terminal.control`.
  - **Protocol:** JSON text frames. The terminal sends
    `{ "type": "hello", "name", "os", "version" }` within 10 s and gets
    `{ "type": "ready", "instance": <id> }`. A controller sends
    `{ "type": "request", "instance": <id>, "envelope": RequestEnvelope }`; the
    terminal receives `{ "type": "request", "id": <relay id>, "envelope" }` and
    answers `{ "type": "response", "id", "envelope": ResponseEnvelope }`; the
    controller receives `{ "type": "response", "instance", "request_id",
    "envelope" }`, or `{ "type": "error", "instance", "request_id", "code" }`
    with `code` one of `not_found` (unknown or not the caller's), `offline`,
    `busy` (64 in flight), `timeout` (60 s). `ping` -> `pong` on both sides.
    The relay never interprets the envelope, so the same 89 actions work
    locally and remotely.
  - **Checks:** the key is verified with the same network, client and device
    rules as any API call; a controller's key and the instance's owner are
    checked on every request; a held terminal whose key is revoked, switched
    off or expired, or whose owner is banned, is closed within a minute.
  - **Scope:** `terminal.control`, a new permission (area Terminal) seeded into
    the built-in `member` role and carried once into existing installs'
    `member` role; it is in `TERMINAL_SCOPES` and on the approval screen.
  - **Registry:** `TerminalInstance(id, userId, apiKeyId, name, os, version,
    relayNode, lastSeenAt)`, one row per terminal key; presence comes from the
    open socket, never polled.
  - **Several nodes:** a request for a terminal held on another node goes
    through the web app and `pg_notify` (`polaris_terminal`, base64 pieces
    under the NOTIFY limit, 256 KiB per frame) to that node's sidecar, and the
    answer comes back the same way.
  - **Live pane output:** a controller or viewer sends
    `{ "type": "watch", "instance", "pane" }` (and `unwatch`); the first watcher
    makes the relay send the terminal `{ "type": "attach", "pane" }`, the last
    one leaving `{ "type": "detach", "pane" }`. The terminal sends
    `{ "type": "output", "pane", "data" }` (base64 of the pane's bytes) only
    while attached; watchers get it with `instance` added, and `"gap": true` on
    the first frame after some were dropped. Answers: `watching`, or
    `watch_end` with `code` `not_found`, `offline` or `busy`. Caps: 16 panes per
    socket, 32 watchers per pane per node, 256 KiB/s per pane (1 MiB burst). A
    watcher on another node is one entry on the holding node (`/terminal/watch`,
    `/terminal/stream` over the same pg_notify path). The standing check ends a
    watch whose share was withdrawn.
  - **Web screen:** `/account/terminals` lists the account's terminals and the
    ones shared with it (online = open relay socket), with open (live output,
    pane picker, insert text via `input.insert` for control), rename (a `label`
    column the hello never overwrites), share (`terminal.instance` grant,
    `view`/`control`, people, or a watch-only link) and sign out (revokes
    the key, drops the row and its shares). It opens the relay as
    `?role=viewer` with a one-shot `DeployTicket` (mode `relay`) in
    `Sec-WebSocket-Protocol`, bound to that one terminal.
- **Code:** `apps/web/terminal-relay.mjs` (sidecar), `apps/web/ws-server.mjs`
  (wiring), `apps/web/src/lib/terminal/relay.ts` and
  `apps/web/src/app/api/terminal/relay/route.ts` (loopback),
  `test/terminal/relay.test.ts`.

### Session sharing (`drive`, shared sessions)

- **Rook today:** "Rook Drive" is Warp Drive: cloud objects (workflows,
  notebooks, environment variables, prompts) synced over GraphQL to the server,
  with sharing in `app/src/drive/sharing/`. Live shared sessions use
  `sessions.app.rook.dev` / the RTC endpoint. Both point at `.invalid`, so
  neither works.
- **Polaris exposes:** the share primitives every app uses - people (user, team,
  role via `AccessGrant`) and a link (`LinkAdvancedFields` + `checkLink`), the
  Places-style Share dialog (`docs/sharing-inventory.md`).
- **Gap:** an owner for terminal objects on the server.
- **Step:** (1) Drive objects become Polaris records owned by the account, synced
  through a small REST surface under `/api/terminal/objects` with the
  `terminal` key, and shared with the standard dialog - a row in the sharing
  inventory. (2) A shared live session is the remote-control relay with a grant:
  `AccessGrant` on a `TerminalInstance` or one pane, with `view` (output only)
  and `control` (input too) levels, and a link variant for view-only
  sharing with expiry. No separate RTC service. **Built:** people and link on
  `terminal.instance`. A link opens at `/k/<token>`, mints a viewer ticket
  carrying the link's grant id (`containerRef` `link:<id>`, mode `relay`), and
  the relay routes it with `linkId`: watch only, judged again on every frame and
  at the minute standing check (`linkGrantStands`), never read as the owner.
  Each open is a counted use and a line in the access log. A view share and a
  link may make the layout reads (`pane|tab|window` `.list`/`.inspect`);
  everything else needs control.

### CLI integration (`rookctrl` -> Polaris CLI)

- **Rook today:** `rookctrl` is the app binary itself with a hidden `--rookctrl`
  flag; Settings -> Scripting installs a wrapper at `/usr/local/bin/rookctrl`
  (macOS/Linux) from the bundle.
- **Polaris exposes:** the `plr` / `polaris` CLI (`dashboard/packages/cli`),
  served by every instance at `/cli/install.sh`, `/cli/install.ps1` and
  `/cli/polaris.mjs` with the instance address filled in, signed in through
  `plr login`.
- **Gap:** no `terminal` subcommand; Node is required by the CLI and is not
  guaranteed on a terminal user's machine.
- **Built:** `plr terminal list` and `plr terminal run ACTION [--params JSON]
  [--instance ID] [--window W] [--tab T] [--pane P]` (CLI 0.8.0,
  `packages/cli/src/commands/terminal.ts`, `src/terminal-local.ts`).
  - Local: reads the discovery records from
    `POLARIS_TERMINAL_LOCAL_CONTROL_DISCOVERY_DIR`, else
    `$XDG_RUNTIME_DIR/polaris-terminal/local-control`, else
    `~/.polaris-terminal/local-control`, and the same three with the Rook names
    (`ROOK_LOCAL_CONTROL_DISCOVERY_DIR`, `rook`, `~/.rook`), so a terminal from
    before the rename is found. A record is followed only with
    `protocol_version` 1, endpoint host `127.0.0.1`, broker socket
    `<instance_id>.broker.sock` and a live pid. Per request: the
    `CredentialRequest` to the broker socket (write, close the write half, read
    to EOF), then `POST http://127.0.0.1:<port>/v1/control` with the scoped
    bearer. Rook's broker is Unix-only, so on Windows a local terminal is
    reached through Polaris, and the CLI says so.
  - Remote: `GET /api/terminal/instances` (a key with `terminal.control`) for
    the list; one controller socket per `run`, with the CLI's key as a Bearer
    header (Node 22 or newer; older Node gets a sentence saying so).
  - `terminal.control` is in `CLI_SCOPES`; `plr login` asks for it, and asks
    again without it when an older Polaris refuses the scope with a 400.
- **Install-if-missing (terminal side):** when the user enables Scripting and
  neither `polaris` nor `plr` is on `PATH`, the terminal offers to install the
  CLI and, on yes, runs the instance's own line in a visible pane:
  `irm <instance>/cli/install.ps1 | iex` on Windows,
  `curl -fsSL <instance>/cli/install.sh | sh` elsewhere. The installer needs
  Node 20 or newer and says so itself when it is missing; the pane shows that
  sentence. The hidden `--control` flag stays as the fallback with no instance.

### Telemetry

- **Rook today:** RudderStack collector with a write key from the channel
  config; events queued to a file and flushed when the telemetry setting is on.
  Sentry crash reporting behind a feature. With no server and no keys, nothing
  is sent.
- **Polaris exposes:** `/api/telemetry` (the instance's own, opt-in).
- **Step:** delete the RudderStack destination and Sentry DSN wiring; if the
  operator wants crash reports, post them to their own instance's telemetry
  endpoint with the terminal key. Nothing leaves for a third party.

### Update channel

- **Rook today:** checks the GitHub releases API for a newer tag and reports it;
  does not download. Tags `v0.YYYY.MM.DD.HH.MM.oss_NN`, parsed by
  `ParsedVersion` in `crates/channel_versions`.
- **Polaris:** Desktop releases on `desktop-v*` tags; the instance serves its
  own update information for clients.
- **Step:** tags become `terminal-v0.YYYY.MM.DD.HH.MM.oss_NN`. `ParsedVersion`
  and `github::compare_release_tags` strip a leading `terminal-` before
  parsing, and the GitHub query filters the repository's releases to that prefix
  (the Polaris repository releases many products, so "latest release" is not the
  terminal's). `script/release_tag` and `script/update_plist` learn the prefix.
  Auto-tagging only for changes under `terminal/`.

### Settings storage and user data (`.rook`)

- **Rook today:** `settings.toml` in the home config dir (`~/.rook-oss` for the
  released channel); app state in `rook.sqlite` (diesel migrations) under the
  per-user data directory for AppId `dev.rook.RookOss`; MCP config
  `~/.rook-oss/.mcp.json`; skills and custom model routers under the same dir;
  per-repository `./.rook/` for workflows, skills and attachments; a
  `.rook` -> `.rook-preview` migration already exists
  (`app/src/preview_config_migration.rs`) and is the template.
- **Step:** on first launch, if `~/.polaris-terminal` does not exist and a Rook
  dir does (`~/.rook-oss`, then `~/.rook`), copy it (not move: a user can still
  run Rook side by side), then copy the data directory of `dev.rook.RookOss`
  into the new AppId's, renaming `rook.sqlite`. Keychain entries are re-read
  under the old service name once and written under the new one. Per-repository
  `./.rook/` is read as a fallback when `./.polaris/terminal/` is absent, never
  rewritten. Settings keys keep their names; only paths and env vars change.
  The migration writes a marker so it runs once, and logs what it copied.

### The rook.dev links

- **Rook today:** 536 mentions of `*.rook.dev` across tracked files (259 full
  URLs): `docs.rook.dev` 164, bare `rook.dev` 197, `app.rook.dev` 84,
  `www` 36, `staging` 16, `releases` 14, `oz` 12, plus `sessions`, `rtc`,
  `api`. 291 of them in `app/src`, 44 in `crates/editor`, the rest in
  `resources/linux`, `crates/rook_tui`, skills, plugins and specs. `rook.dev` is
  registered to somebody else and resolves, so every one of them is a live link
  to a site this project does not control.
- **Step:** do this in the rename commit, by category, not by blind replace:
  1. Server hosts (`app.`, `staging.`, `api.`, `rtc.`, `sessions.`, `oz.`,
     `releases.`) go away with the features they served, or become the
     configured Polaris instance address.
  2. Docs links (`docs.rook.dev/...`) point at pages that do not exist anywhere.
     Remove the link and keep the text, or point at a page in this repository
     (`docs/terminal/...`) when one is written. Never at upstream Warp's docs.
  3. Marketing and legal links (`rook.dev`, `www.`) go to the Polaris site.
  4. Email addresses (`@rook.dev`, e.g. the default agent commit email) become
     a placeholder the user's own git identity replaces.
  A test greps the tree for `rook\.dev` and fails on any hit, so none return
  with an upstream port.

## Built in Polaris for this

| What | Where |
| --- | --- |
| `terminal` sign-in kind (device grant, scopes `polar.use`, `polar.spend`) | `apps/web/src/lib/terminal/scopes.ts`, `lib/cli/sign-in.ts`, `packages/auth/src/api-keys.ts` |
| `POST /api/terminal/authorize`, `POST /api/terminal/authorize/claim`, `DELETE /api/terminal/session` | `apps/web/src/app/api/terminal/` |
| Approval page `/account/terminal` and Sessions label | `app/(app)/account/terminal/page.tsx`, `lib/device-sessions/kinds.ts` |
| CI scaffold for `terminal/**` | `.github/workflows/terminal.yml` |
| Remote-control relay at `/api/deploy/ws/terminal`, scope `terminal.control`, `TerminalInstance` | `apps/web/terminal-relay.mjs`, `apps/web/src/lib/terminal/relay.ts`, `app/api/terminal/relay/route.ts` |
| Live pane output, `/account/terminals`, `terminal.instance` shares (people and link) | `terminal-relay.mjs`, `lib/terminal/instances.ts`, `app/(app)/account/terminals/`, `/k/<token>` |
| `plr terminal list` / `run`, `GET /api/terminal/instances`, `terminal.control` in `CLI_SCOPES` | `packages/cli/src/commands/terminal.ts`, `packages/cli/src/terminal-local.ts`, `app/api/terminal/instances/` |
| Desktop shared sign-in, `POST /api/terminal/authorize/describe` and `/answer` | `desktop/src/main/native-host/terminal-sign-in.ts`, `lib/cli/approval.ts` |

Not built, with the design above: terminal objects (`/api/terminal/objects`).

## Import-time checklist (owner)

Done by the owner when Rook moves in; none of it can be done from the Polaris
side before the tree exists. In order:

1. **Decide LFS first.** Drop the ConPTY `.pdb` files (fetch them in the
   bundling script) or keep them under LFS, then add `.gitattributes` rules
   scoped to `terminal/**/*.pdb` and `terminal/crates/input_classifier/models/**`.
   An LFS object once pushed stays in the history.
2. **Bring the tree in with history and file modes:** `git subtree add
   --prefix=terminal <rook remote> main` (or `git read-tree --prefix=terminal/`),
   never a file copy. Check that `git ls-files -s terminal/script | grep -c 100755`
   matches Rook's count.
3. **Re-root `.gitattributes`:** every Rook pattern gains `terminal/`
   (`terminal/app/src/terminal/ref_tests/data/** -text` above all).
4. **Cargo:** add `"terminal"` to `exclude` in the root `Cargo.toml`; keep
   `terminal/Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` (1.94.0). Run
   `cargo metadata` at the root and confirm no terminal crate appears and the
   root `Cargo.lock` is unchanged (the tunnel fingerprint check pins it).
5. **Rename** with `script/rebrand.py` and the Polaris target, per the rename
   map above (crates `pterm_*`, binary `polaris-terminal`, env
   `POLARIS_TERMINAL_*`, AppId `dev.polaris.PolarisTerminal`, URL schemes
   `polaris-terminal*`), in one commit, bootstrap scripts and `plugins/` included.
6. **rook.dev sweep** by category (see "The rook.dev links"), then the test that
   greps `terminal/` for `rook\.dev` and fails on a hit.
7. **CI:** port Rook's `ci.yml` jobs into `.github/workflows/terminal.yml` behind
   `needs.changes.outputs.terminal == 'true'`, with `working-directory: terminal`
   and `Swatinem/rust-cache` `workspaces: terminal -> target`; keep the single
   `terminal` result job as the required check. Add `terminal-release.yml` on
   `terminal-v*` tags (Rook's `release.yml`, asset names renamed). Auto-tag only
   for diffs under `terminal/`.
8. **Update channel:** `ParsedVersion` and `github::compare_release_tags` strip a
   leading `terminal-`; the release query filters to that prefix;
   `script/release_tag` and `script/update_plist` learn it.
9. **Terminal-side code against what Polaris already serves:**
   - Sign-in: replace the Firebase flow with `POST /api/terminal/authorize`, then
     the Desktop socket (`terminal-sign-in`) or the approval page, then poll
     `POST /api/terminal/authorize/claim`; keep the key in the keychain; sign out
     with `DELETE /api/terminal/session`.
   - Relay: one socket to `/api/deploy/ws/terminal?role=instance` with the key,
     `hello` within 10 s, `request` frames answered by the same dispatcher local
     control uses, `ping` / `pong`.
   - **Live output (`attach` / `detach` / `output`):** on
     `{ "type": "attach", "pane" }` start forwarding that pane's PTY output as
     `{ "type": "output", "pane", "data": "<base64 of the raw bytes>" }`, in
     chunks of at most 64 KiB, sending the pane's current screen first so a new
     watcher is not looking at a blank pane; on `{ "type": "detach", "pane" }`
     stop. The relay caps a pane at 256 KiB/s with a 1 MiB burst and drops the
     excess (the watcher sees `gap: true`), so coalesce rather than flood. Never
     send output for a pane that is not attached; at most 16 attached panes per
     socket. After a reconnect the relay sends `attach` again for every pane
     still watched, so attachment state is not kept across sockets.
   - Polar: the assistant's provider is the instance's compatible endpoints
     (`/api/v1/chat/completions`, `/api/v1/messages`, `/api/v1/responses`,
     `/api/v1/models`) with the terminal key.
   - Telemetry: remove RudderStack and the Sentry DSN.
   - User data: the one-time copy from `~/.rook-oss` / `~/.rook` and the
     `dev.rook.RookOss` data directory, with a marker.
   - Scripting: install-if-missing for the CLI (see "CLI integration").
10. **Verify:** `cargo nextest run` in `terminal/` on the three systems through
    CI, `npm run build` in `dashboard/`, a sign-in from a fresh terminal against
    a real instance (browser path and Desktop path), `plr terminal run app.ping`
    locally and through the relay, and a pane watched from `/account/terminals`.
