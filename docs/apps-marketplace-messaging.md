# Apps marketplace + unified messaging

Design and build ledger for the "Apps" pillar (a marketplace that installs and
manages external apps Polaris runs) and the unified messaging system (a
multi-platform support inbox plus a channel-adapter abstraction reusable by AI
assistants).

Status: design agreed, Phase 0 in progress. This document is the source of
truth; keep it current as phases land.

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
  provider, a Telegram bot, a Discord bot, a Slack app). Holds provider,
  capability flags, encrypted credentials/session ref, connection state.
- `Conversation` - a thread with one contact; assignable to a human agent or to
  an AI assistant; status open/closed/pending.
- `Message` - normalized: direction, text, media ref, interactive payload, acks,
  platform message id.
- `InteractivePrompt` - normalized "offer these options"; rendered per
  capability (native buttons/selects, or a WhatsApp Poll / numbered menu).

### Channel adapter (the abstraction)

`ChannelAdapter` interface, one implementation per platform/provider under the
bridge service (`services/messaging-bridge/src/adapters/`):

- `connect()` / `disconnect()`, onboarding mode (`qr` | `code` | `token` |
  `oauth`)
- `sendMessage()`, `sendInteractive(prompt)`, `markRead()`
- capability flags: `nativeButtons`, `nativeSelects`, `polls`, `media`,
  `templates`, `banRisk`, `needsBrowser`
- emits normalized events: message, ack, reaction, vote (poll), connection-state

Capability matrix:

| Platform / provider | Native buttons | Native selects | Poll | Runtime | Cost |
| --- | --- | --- | --- | --- | --- |
| Telegram (Bot API) | yes | yes | yes | no browser | free |
| Discord (bot) | yes | yes | n/a | gateway | free |
| Slack (Block Kit) | yes | yes | n/a | Events API | free |
| WhatsApp `whatsapp-web` | no (-> Poll/menu) | no (-> Poll/menu) | yes | Puppeteer | free + number |
| WhatsApp `whatsapp-cloud` | yes | yes (list) | n/a | webhook | paid + number |

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

## Reference repos (local, gitignored under `references/repos/`)

- `whatsapp-web.js` (wwebjs/whatsapp-web.js, Apache-2.0) - base for the
  `whatsapp-web` provider. Buttons/lists deprecated; Polls (`vote_update`) and
  `RemoteAuth` are the relevant primitives.
- `wa-automate-nodejs` (open-wa, Hippocratic license) - reference only; not a
  dependency (non-OSI license, historically paywalled features).
