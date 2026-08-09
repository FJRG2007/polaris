# Apps marketplace + unified messaging

Design and build ledger for the "Apps" pillar (a marketplace that installs and
manages external apps Polaris runs) and the unified messaging system (a
multi-platform support inbox plus a channel-adapter abstraction reusable by AI
assistants).

Status: Phase 0 complete; Phase 1 (Telegram) code-complete and typechecked
(runtime verification pending an operator bot token + a running bridge). This
document is the source of truth; keep it current as phases land.

## Progress

- Phase 0 - DONE (commits 254a847, 76c920d, 0a9323a): app catalog, InstalledApp
  model, umbrella "Apps" pillar, marketplace + install wizard (Deploy target +
  storage picker), per-installed-app dashboard.
- Phase 1 - CODE DONE (bf73eaf, 97ac322, 118b272): Channel/Conversation/Message
  model; @polaris/messaging contracts; messaging-bridge service + Telegram
  adapter; web bridge-client + messaging-service + /api/inbox/ingest + the Inbox
  pillar (conversation list + thread + text/interactive composer, short-poll).
  To run live, set MESSAGING_BRIDGE_URL, MESSAGING_BRIDGE_TOKEN,
  MESSAGING_INGEST_KEY on the web and BRIDGE_TOKEN, WEB_INGEST_URL,
  WEB_INGEST_KEY on the bridge, and connect a Telegram bot token.
- Phase 2 - DONE (2e759e2, ab478fb): WhatsApp Cloud API (native buttons/lists,
  signed Meta webhook) and WhatsApp Web (whatsapp-web.js + Puppeteer, QR login,
  session on a volume, Poll selector). Operator picks the provider per channel.
- Phase 3 - DONE (d796002): Discord (discord.js gateway, native buttons) and
  Slack (Web API + Block Kit, signed Events webhook). Each also has a send-only
  incoming-webhook provider (`discord-webhook`/`slack-webhook`, no bot) for
  one-way alerts; the Discord bot resolves a DM username to a user id by server
  member search (Server Members intent + a shared server), falling back to the
  numeric User ID when either is missing.
- Phase 4 - PARTIAL (e119cfe): conversation assignment to a human agent + status
  (multi-agent support) is done. The AI-assistant auto-reply loop (OpenClaw/
  Hermes runtime + an LLM) is the remaining external piece - the substrate is
  ready (assistantId field + the bridge send/receive API any assistant reuses).
- Phase 5 - CODE DONE: one-click install and the Minecraft game-server app (see
  "Game servers" below). Not yet exercised against a live server.

To verify each channel live: Telegram bot token; WhatsApp Cloud (Meta app +
phone-number id + MESSAGING_WA_VERIFY_TOKEN/APP_SECRET + webhook); WhatsApp Web
(scan a QR); Discord bot token; Slack bot token + MESSAGING_SLACK_SIGNING_SECRET
+ Events webhook. All channels also need the bridge running (MESSAGING_BRIDGE_URL/
TOKEN, MESSAGING_INGEST_KEY) and the migrations applied.

## Known follow-ups (deferred, not silently dropped)

- Bridge as a marketplace install: the bridge manifest is `build`-only, so it is
  not yet installable via the image-only install path; it runs as an
  env-configured service for now. Add build-context install to deploy it from the
  marketplace.
- Inbox realtime is short-poll; a WS push via the existing sidecar is the upgrade.
- Inbox is gated by requireUser (per-owner); split out inbox.read/send/manage
  permissions when the IAM catalog is next touched.

## Goals (from the operator)

1. Marketplace to install and manage apps Polaris runs, in the fewest clicks -
   game servers (Minecraft, ...), self-hosted tools, AI assistants, the
   messaging bridge. Each installed app gets an adapted dashboard.
2. A unified messaging inbox inside Polaris: talk to many contacts at once
   (customer support), read and send from Polaris, offer buttons/selectors.
3. One adapter abstraction across WhatsApp, Telegram, Discord and Slack.
4. Deployable AI assistants (OpenClaw/Hermes) that reuse the same messaging
   system.
5. Free where possible (a phone number is the only unavoidable cost), scalable,
   secure, and with the fewest external-platform dependencies.
6. The dashboard must stay organized as it grows - no chaos.

## Decisions (agreed)

- **Navigation: umbrella "Apps" pillar.** One `Apps` pillar groups Marketplace +
  everything installed (Deploy, Containers, Servers, Backups, Assistants, the
  messaging bridge). `Inbox` appears once a channel is connected. `Integrations`
  (credentials/API keys) stays separate.
- **Messaging bridge runs as a Polaris-managed container**, not inside the web
  image. It is itself a marketplace app that Deploy provisions on a chosen
  target. This isolates Puppeteer/Chromium from the web process, scales and
  updates independently, and dogfoods the marketplace.
- **All four platforms**, built on a capability-based adapter. WhatsApp ships
  with **two selectable provider backends**; the operator picks per channel,
  told the trade-offs:
  - `whatsapp-web` - free, unofficial (whatsapp-web.js + Puppeteer). No native
    buttons (deprecated by WhatsApp) -> rendered as a native Poll or a numbered
    menu. Ban risk. Heavy (one Chromium per number).
  - `whatsapp-cloud` - official WhatsApp Business Cloud API (Meta). Paid/tiered.
    Native interactive buttons + list messages + templates, webhook-based, no
    browser, no ban risk within ToS.
- **Install reuses Deploy.** Installing an app is a Deploy of a curated compose
  template onto a chosen `DeployTarget` (local hostd or remote SSH host), with
  the same storage/volume picker (server-local volume vs NAS mount). No new
  installer, no new runtime.

## Reuse map (do not reinvent)

| Need | Reuse |
| --- | --- |
| Install/run an app | Deploy: compose templates on `DeployTarget` -> `RuntimePorts` (`lib/deploy/runtime.ts`), engine driver from `@polaris/deploy` |
| Server + storage picker | Deploy target picker + `Volume`/NAS `StorageMount` (`deploy-volume-service.ts`) |
| Store channel/provider secrets | `Integration` envelope-encryption pattern (AES-256-GCM, `encryptedSecret`/`secretNonce`/`secretKeyId`) |
| Catalog-as-code | `lib/integrations/registry.ts` shape (static typed array + DB row for install state) |
| Live inbox transport | Ticket-authed WebSocket sidecar (`ws-server.mjs` + `DeployTicket` + subprotocol token) |
| Generic app dashboard | Deploy panels: logs, metrics, terminal, files |
| Auth on routes/actions | `requirePermission()` from `lib/session.ts` |
| Input validation | Zod schemas in `packages/core/src/schemas/`, shared client+server |

## Architecture

### App catalog (manifest-driven)

A typed manifest (Zod) describes each marketplace app so the dashboard scales
without a monolith:

- `id`, `name`, `category`, `icon`, `summary`, `description`, `docsUrl`
- `installMethod`: `compose-template` | `builtin` | `integration`
- `capabilities`: e.g. `messaging-channel`, `ai-assistant`, `game-server`,
  `tool` - drive derived nav and which adapted dashboard to mount
- `configSchema`: a Zod schema for the app's config form
- `dashboard`: `builtin-component` (a lazy-loaded panel keyed by manifest) |
  `generic` (reuse Deploy panels) | `iframe`
- for `compose-template`: the template ref + declared volumes/env so the install
  wizard can render the target + storage picker

The catalog is code (`lib/apps/catalog.ts`); a DB row (`InstalledApp`) records
each install (target, config, status, secret). Nav pillars/rails are partly
derived from installed capabilities.

### Messaging domain model (normalized)

- `Channel` - a connected account on a platform (a WhatsApp number via a chosen
  provider, a Telegram bot, a Discord bot, a Slack app, or a send-only Discord/
  Slack webhook). Holds provider,
  capability flags, encrypted credentials/session ref, connection state.
- `Conversation` - a thread with one contact; assignable to a human agent or to
  an AI assistant; status open/closed/pending.
- `Message` - normalized: direction, text, media ref, interactive payload, acks,
  platform message id.
- `InteractivePrompt` - normalized "offer these options"; rendered per
  capability (native buttons/selects, or a WhatsApp Poll / numbered menu).
- `Contact` - a saved person for starting outbound chats, per owner (name +
  optional note), independent of platform.
- `ContactIdentity` - one of a contact's messaging handles on a single platform
  (a WhatsApp number, a Telegram chat id, ...), unique per owner + platform +
  peer id. The same person on WhatsApp and Telegram is one `Contact` with two
  identities.

### Channel adapter (the abstraction)

`ChannelAdapter` interface, one implementation per platform/provider under the
bridge service (`services/messaging-bridge/src/adapters/`):

- `connect()` / `disconnect()`, onboarding mode (`qr` | `code` | `token` |
  `oauth`)
- `sendMessage()`, `sendInteractive(prompt)`, `markRead()`
- `listTargets()` (optional) - enumerate addressable send targets grouped
  (server -> channels) for platforms whose recipients are discoverable (Discord),
  powering the inbox recipient picker; absent where recipients are entered by
  hand (a phone number, a Discord user to DM via `user:<id-or-username>` - a
  username is resolved to a user id by server member search, which needs the
  Server Members privileged intent and a shared server)
- capability flags: `nativeButtons`, `nativeSelects`, `polls`, `media`,
  `templates`, `banRisk`, `needsBrowser`
- emits normalized events: message, ack, reaction, vote (poll), connection-state

Capability matrix:

| Platform / provider | Native buttons | Native selects | Poll | Runtime | Cost |
| --- | --- | --- | --- | --- | --- |
| Telegram (Bot API) | yes | yes | yes | no browser | free |
| Discord (bot) | yes | yes | n/a | gateway | free |
| Discord `discord-webhook` | no (-> numbered text) | no | n/a | send-only HTTP | free |
| Slack (Block Kit) | yes | yes | n/a | Events API | free |
| Slack `slack-webhook` | no (-> numbered text) | no | n/a | send-only HTTP | free |
| WhatsApp `whatsapp-web` | no (-> Poll/menu) | no (-> Poll/menu) | yes | Puppeteer | free + number |
| WhatsApp `whatsapp-cloud` | yes | yes (list) | n/a | webhook | paid + number |

The `discord-webhook` and `slack-webhook` providers are send-only incoming-webhook
adapters (no bot, no gateway/socket, so no receive) for one-way alerts to a channel
(what the Watch app targets); an interactive prompt degrades to numbered text.

WhatsApp is optional in the bridge build so a Telegram-only operator never pulls
Chromium.

### Bridge service

`dashboard/services/messaging-bridge` - a Node service running the enabled
adapters behind a small typed HTTP + WS API (`@polaris/messaging-client`). The
web app is a thin client: it persists `Channel/Conversation/Message` in Postgres,
sends via the bridge API, and receives inbound events (bridge -> loopback route
-> store -> fan out to inbox clients over the WS sidecar). Session persistence
for `whatsapp-web` uses whatsapp-web.js `RemoteAuth` with a Postgres-backed store
so sessions survive restarts.

### Security

- All platform tokens and WhatsApp sessions envelope-encrypted like `Integration`.
- Bridge API bound to the internal network / authed with a file-based bearer
  token (hostd pattern); never public.
- Every inbound platform payload validated with Zod; webhook signatures verified
  (Slack signing secret, Discord ed25519, Telegram secret token, Meta Cloud
  app secret).
- Permissions `inbox.read` / `inbox.send` / `inbox.manage` via `requirePermission`.
- Per-number send throttle to reduce WhatsApp ban risk; rate limiting on webhooks.

## Navigation (target IA)

```
Apps            (pillar)
 |- Marketplace      browse + 1-click install (target + storage picker)
 |- Installed        Deploy, Containers, Servers (Minecraft...), Backups,
 |                   Assistants (OpenClaw/Hermes), Messaging bridge
 \- <app>            adapted dashboard (builtin panel or generic Deploy panels)
Inbox           (pillar; appears once a channel is connected)
Integrations . Management . Drive . Settings
```

## Phase plan

Each phase: own feature branch increment, verified before "done", driven through
the gate. Later phases need operator-supplied credentials to verify end to end;
those are named blockers, not silent skips.

- **Phase 0 - IA backbone (no external creds needed).** Manifest Zod schema +
  `lib/apps/catalog.ts` + `InstalledApp` Prisma model + migration; umbrella
  "Apps" pillar nav reorg; Marketplace page; install wizard reusing Deploy
  target + storage picker; generic app dashboard shell. Verify: typecheck +
  migrate + app renders + a `builtin`/`compose-template` app installs onto a
  target.
- **Phase 1 - Bridge scaffold + Telegram.** `services/messaging-bridge` +
  `ChannelAdapter` + Telegram adapter (native buttons, no browser) +
  `@polaris/messaging-client` + `Channel/Conversation/Message` models + Inbox UI
  (multi-conversation list, thread, send, native interactive) + WS realtime.
  Blocker to verify: a Telegram bot token.
- **Phase 2 - WhatsApp, both providers.** `whatsapp-web` (RemoteAuth ->
  Postgres, QR/code onboarding, Poll/menu fallback) and `whatsapp-cloud`
  (webhook, native interactive, templates), operator picks per channel. WhatsApp
  module optional in the bridge build. Blockers: a WhatsApp number; for cloud, a
  Meta Business app + phone-number id + token.
- **Phase 3 - Discord + Slack.** Native buttons/selects; webhook signature
  verification. Blockers: bot/app tokens.
- **Phase 4 - AI assistant apps.** OpenClaw/Hermes as marketplace apps that
  consume the bridge API; per-conversation assignment to an AI or a human, with
  handoff.
- **Phase 5 - One-click install + game servers.** Install from the card with the
  manifest's defaults; the Minecraft app with a native panel. Blocker to verify
  end to end: a host with Docker running the image.

## Game servers (Minecraft)

An installed app is expected to feel native, the way a Home Assistant add-on
does: Polaris components, Polaris navigation, no embedded foreign UI. The
Minecraft app is the reference for that, and the shape any later game server
follows.

**The marketplace installs a manager, not a server.** `minecraft-manager` is a
builtin app: installing it runs nothing and turns `/apps/games` into a real page.
Servers are created there, from two internal manifests (`minecraft`,
`minecraft-bedrock`) the marketplace never offers - which is why the catalog has
an `internal` flag at all. Each server is still an ordinary install underneath.

**What creating a server asks, and what it works out.** Who plays on it (Java,
Bedrock, or a Java world Bedrock joins through Geyser), what it plays (a
blueprint), and how many people will be on it at once. From that: the image, the
heap (`recommendedMemoryMb` - sized from concurrent players, not from the slot
count), the plugins the blueprint needs, whether a second UDP port has to be
published for crossplay, and the address. The machine picker shows what each
machine has free and what its game servers are already promised, so a server is
not put where it does not fit.

**Blueprints are presets, not content.** Each names real Modrinth projects the
image installs itself, with `?` so a Minecraft release they have no build for yet
warns instead of stopping the server. Polaris ships no worlds and no plugins of
its own.

**The address is a name.** `<label>.mc.<baseDomain>`, with an A record and - for
Java - a `_minecraft._tcp` SRV record, so players type a name and no port at all.
Bedrock clients do not resolve SRV, so theirs keeps the port. No domain
configured means the machine's own address, as before.

- **Both editions.** `minecraft` is Java (PC), `minecraft-bedrock` is Bedrock
  (phones, consoles, the Windows app). They are managed through one panel and
  differ underneath: Bedrock has no RCON, so its commands go through the image's
  `send-command` and its player list is read back out of the console log; it has
  an allow list rather than a whitelist, records operators by xuid, and has no
  ban command at all - so the screens offer only what the edition actually has.
- **Reachable on the port players type.** A game server is not reached through
  the proxy, so the manifest declares the host port its clients assume (25565
  TCP, 19132 UDP) and the install pins it, taking the next free one for a second
  server. Publishing a Bedrock server as TCP would answer nothing, hence the
  protocol on the port spec.
- **Closed by default.** Authentication required, whitelist enforced, command
  blocks off, secure profiles required, spawn protected - and an anticheat
  (grimac), block history to roll a raid back with (coreprotect) and the
  permission plugin both are administered through (luckperms) installed on the
  first boot. Each carries `?` so a Minecraft release they have no build for yet
  warns instead of stopping the server.
- **Its own permissions.** `games.read`, `games.moderate` and `games.manage`, so
  a moderator can kick and whitelist without being able to deploy anything.
  `deploy.manage` carries all three, which is what keeps roles written before
  they existed working.
- **And they can be scoped to one server.** A role only ever answers "may this
  account use game servers at all"; which server is answered by ownership or by a
  `ResourceGrant` written for that install (`install:<uuid>`, see
  `RESOURCE_KINDS`). The two are separate gates and both have to pass, because a
  role's grants compile to `resources: ["*"]` - feeding those into the second gate
  would make every holder of the seeded `member` role reach every other account's
  server. Pinned by the first test in `packages/auth/test/access/`.
  A grant is given from the server's own **Access** screen rather than from
  `/admin/roles`, so the person who runs a server can bring in a moderator
  without being an administrator. What they may hand out is exactly what they
  hold there, `canShare` only passes on from somebody who has it, and an end date
  is clamped to their own. Inviting an address that has no account is a further
  step, off by default, under **Who can invite** on `/admin/users`: Polaris has no
  public registration, and sharing a server must not quietly become a way around
  that. Everything one account may do, and where each permission comes from, is on
  `/admin/users/<id>`.
- **A bag that outlives the session.** `data get entity` only answers about a
  player who is standing on the server, and the question is nearly always asked
  about one who is not - somebody who logged off, or who was banned an hour ago.
  So every online player's inventory is copied on a ten-minute cadence
  (`PlayerInventorySnapshot`, `POST /api/cron/game-inventories`, plus a lazy sweep
  from the panel read), and every screen showing a copy says how old it is rather
  than drawing the same picture as a live one.
- **A bag that can be rearranged.** Drag to move a stack, Ctrl to move one of it,
  right-click to split it in half, and the item palette drags straight into a
  slot. Nothing is ever rebuilt from an id and a count: the stack's own data is
  read back and re-emitted verbatim, and where it cannot be - an unreadable
  component span, or an argument over the 512-character transport ceiling - the
  drag is refused and says which. Vanilla has no `/data modify` for players, so a
  move is two `item replace` writes and each re-reads its slot first; a stack the
  player moved underneath refuses instead of overwriting.
- **Decisions that wait.** Giving an item needs the player present; banning only
  needs the server up. Either way the decision gets made while they are asleep, so
  it is written down (`PlayerActionQueue`) and applied by the same passes that
  already sweep timeouts and firewall bans. It lapses after thirty days rather
  than surprising somebody months later, and the Players screen lists what is
  waiting with a way to cancel it.
- **A player is one name and several addresses.** Somebody who plays from home
  and from a laptop is one person, so the access rule is keyed on
  `(server, name, address)` and any one of their addresses lets them in. A join
  from an address they are not registered to offers to add it, straight from the
  history the log already carried.
- **The firewall reaches it.** Polaris' firewall is an HTTP guard and a game
  server is not HTTP, so its blocked addresses are handed to the server's own ban
  list - from the Players screen for right now, and from
  `POST /api/cron/game-firewall` (same secret as the other cron routes) so a ban
  added later reaches every running server without anyone pressing anything.
  Ranges stay behind: Minecraft bans one address at a time, and the screen says
  how many were left.
- **Hours, not a switch.** A server carries a schedule: windows over the week
  that each say be on, be off, or sleep when empty, and a default for the hours
  no window covers - so "quiet overnight unless somebody is playing, up the rest
  of the day" is one rule. Times are read in a named zone rather than the
  machine's, and sleeping never starts anything: a server woken at three in the
  morning would only find itself empty again. It is applied from
  `POST /api/cron/game-schedules` (same secret as the other cron routes) and,
  for an instance with no cron, from the Game servers page itself, which has
  already asked every server who is on.
  What is **not** here is waking on a connection attempt. Nothing listens on the
  game port while the container is down, so noticing that somebody tried needs a
  stand-in process holding the port and speaking enough of the protocol to
  answer a ping - a component of its own, not a setting.
- **Its files are Drive files.** The panel links the container's `/data` into the
  Drive explorer (`?c=container:<applicationId>`), which already browses a
  deployed container - so worlds, configs and plugin folders are read and edited
  where every other file in Polaris is.
- **UDP needed the daemon.** The compose spec's port carries a protocol now, and
  polaris-hostd had to learn it: its `PortSpec` is `deny_unknown_fields`, so a
  Bedrock server would have been refused by the local daemon. A host running an
  older daemon cannot publish UDP.

- **Install is one click.** The card installs on this server with the manifest's
  defaults and opens the app. `Configure` is the same install with the server,
  storage and settings exposed. The EULA is accepted by installing, which the
  card says before the click rather than in a dialog after it.
- **Control is RCON, over the container.** Every read and command runs
  `rcon-cli` inside the running container through `RuntimePorts.runIn` - the seam
  that already provisions databases - so it works on the local host (daemon) and
  on a registered server (SSH) with nothing published on the network. The
  password is minted per install (`generated` in the manifest) rather than left
  to the image's random one, which a `docker exec` could not then use.
- **The roster is read from the server's files.** `ops.json`, `whitelist.json`,
  `banned-players.json` and `server.properties` are a schema; console text is
  prose that changes between versions. Moderation still goes over RCON, so it
  applies to the running game.
- **Settings are the container's environment.** The image writes
  server.properties from it at boot, so applying a setting is a redeploy - the
  form says so, and says how many players it will disconnect.
- **Mods and plugins are `MODRINTH_PROJECTS`.** The image installs what the list
  names and removes what is taken off it, so the Mods screen edits that value
  instead of pushing files into a running container. Search is proxied through
  the web (`/api/apps/installed/[id]/minecraft/modrinth`) so the browser never
  calls Modrinth directly.

Panels the referenced projects have that this does not: world management,
scheduled tasks/restarts, per-world game rules, a file manager of its own (Deploy
already browses the container on local targets) and backups (the Backups app is
the place for that, not a second implementation here).

## Reference repos (local, gitignored under `references/repos/`)

- `whatsapp-web.js` (wwebjs/whatsapp-web.js, Apache-2.0) - base for the
  `whatsapp-web` provider. Buttons/lists deprecated; Polls (`vote_update`) and
  `RemoteAuth` are the relevant primitives.
- `wa-automate-nodejs` (open-wa, Hippocratic license) - reference only; not a
  dependency (non-OSI license, historically paywalled features).
