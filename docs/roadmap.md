# Roadmap

[Leer en español](roadmap.es.md) - [Back to the README](../README.md)

Where Polaris is going: the platform decisions that shape every client, and a
summary of each area's own roadmap with a link to the full file. The per-area
files hold the detail; this page is the index.

## Platform direction

Decided on 2026-11-13.

### The desktop app stays on Electron

Decided on 2026-11-15, replacing the 2026-11-13 plan to move it to Tauri 2.
The Tauri beta (`desktop-tauri/`, with the Rust client core it carried) was
removed; it never reached anybody. It is in the git history at `909b1a0f41`
and the commits after it.

Why Electron:

- **The same engine everywhere.** Electron ships its own Chromium, so the
  desktop app draws and behaves exactly like the dashboard in Chrome, Brave or
  Edge, on Windows, macOS and Linux. Tauri uses each system's web view: WebView2
  (Chromium) on Windows, WebKit on macOS and WebKitGTK on Linux. CSS and web
  APIs differ between them, so one UI would need checking three times.
- **Calls and media.** Polaris leans on WebRTC calls, screen sharing, virtual
  backgrounds and noise suppression. Those are where the system web views
  differ most, WebRTC and screen capture on WebKitGTK above all. With its own
  Chromium they work in the desktop app wherever they work in the browser.
- **No feature or permission left behind.** Everything the app does today
  (tray, notifications, game detection, the voice widget, TV install, the VPN
  helper, updates and signing) is already built and running on Electron.
  Moving meant redoing it module by module for no change the user would see.
- **Maturity.** Updating, signing and crash handling on Electron have years of
  use behind them in apps the size of VS Code, Discord and Slack.
- **Two desktop apps halve the effort.** Keeping a beta in step with the
  shipped app costs every desktop change twice.

What Electron costs, accepted: more memory and a larger installer. Measured on
the operator's machine on 2026-11-15 with 0.1.32: about 770 MB across the
app's processes, 350 MB of it the window. The lag reported in November was not
Electron: the page piled up event listeners on every navigation (`PageTiming`,
fixed in `04551960b6`), which would have happened under Tauri too.

Rust stays where it earns its place: small native helpers beside the app, as
the VPN helper (`desktop/vpn-helper`) already is, not a second shell.

### A native GPUI rewrite is not planned

GPUI (Zed's GPU UI framework, which Discord announced on 2026-11-04 for its
desktop rewrite) was evaluated for a full native UI and is not planned:

- It means rewriting every screen, and users would see the change.
- The web dashboard, the browser extension and mobile would still need the
  current UI, so Polaris would maintain two UIs.
- GPUI has no stable 1.0 release.

Revisit it only if a measured hot screen stays slow in the desktop app, and then only
for that screen.

## Scale and the app platform

Decided on 2026-11-13. The target is the same Polaris from one home server up
to governments and companies with millions or billions of users, with hundreds
or thousands of official apps and, as in Home Assistant, potentially millions of
community apps.

### Client speed: one Rust core in every client (planned)

A Rust core shared by every client - native in mobile apps, and compiled to
WebAssembly in the browser for the heavy client work (sync, the local cache and
search index, crypto and offline use) - so the web and native clients run the
same code. None of this exists: the first crate went with the Tauri beta (see
above), and it is started again only when a measured client bottleneck needs
it.

### App UI stays web-based and sandboxed (partly planned)

Community apps cannot ship native code into every user's client: at that scale
it is a security boundary nobody can review, and every author would have to
write Rust. Zed, which is built on GPUI, keeps its extensions to WebAssembly
with limited UI for the same reason.

What exists today:

- The marketplace catalogue is a fixed set of apps defined in code
  (`dashboard/apps/web/src/lib/apps/catalog.ts`). There are no community apps
  yet.
- Installable first-party apps (Game servers, Places, Calendar, CRM and others)
  are bundles built by `dashboard/packages/app-host/bundler`, published by CI
  and downloaded only when installed. They are loaded into the dashboard's own
  process and checked against a versioned host API before any of their code
  runs; see [the app bundle contract](app-bundles-contract.md) and
  [the installable apps plan](installable-apps-plan.md).
- The dashboard core reaches an app only through its extension registry
  (`dashboard/apps/web/src/lib/app-extensions/registry.ts`), and a build test
  fails if core imports app code directly.
- Apps that are a service of their own (a `compose-template` app) install as a
  compose stack through Deploy, in their own containers.

Planned, beyond that: third-party UI renders in an isolated web surface, with a
manifest, declared permissions and an SDK, and the server side of a community
app runs in its own container.

### Hot first-party screens (planned)

Chat and mail lists, the calendar grid and large tables get virtualization,
workers and the WebAssembly core first. A native renderer (GPUI on desktop,
SwiftUI or Jetpack Compose on mobile) is considered per screen, and only when a
measurement shows the web version cannot meet its budget.

### Mobile (planned)

Native shells, SwiftUI on iOS and Kotlin with Jetpack Compose on Android, over
the same Rust core. That is the part of Discord's direction that fits Polaris.

### Server scale is a separate track

What exists today:

- Scheduled jobs that two runners must not do at once take a database lease
  (`dashboard/apps/web/src/lib/cron/lease.ts`), because two web containers
  serve at once during a rollover.
- Live updates for Chat, Tasks, Mail, Office and other screens ride an
  in-process bus, so one dashboard container serves them all.
- Deployed services scale to up to ten copies on one server, with autoscaling
  on that server.

What is planned is written in the
[Deploy roadmap's scale-out section](deploy-roadmap.md#12-scale-out-for-a-customer-leaving-vercel-assessed-2026-10-08):
copies of a service on several servers, a load-balanced entry across them,
edge caching without Cloudflare, per-customer quotas, and Polaris itself in more
than one container by moving the live-update bus to Postgres `LISTEN/NOTIFY`.

## Per-area roadmaps

Each summary is taken from the linked file. Where an area's file has no list of
things it will not do, the summary says so.

### Agents

Source: [docs/agents-roadmap.md](agents-roadmap.md)

- **Done:** background runs on GitHub repositories (mention, issue, pull
  request, review and failed-check triggers; runtime modes; push and shell
  policies per repository, account and deployment; the quality gate before a
  push; a model fallback chain; usage limits). Live sessions of a vendor CLI in
  a container, on your own server or on a shared machine, with a fresh branch
  each, a "Needs you" state from the tool's hooks, terminal takeover in the
  browser, and Polaris's MCP server for starting and prompting other sessions.
- **Next, in order:** a notification when an agent needs you or ends; work that
  survives Stop; the session's diff; pushing and opening a pull request from the
  session; diff comments and failed CI sent back to the agent; a board for
  sessions; a repository setup script; one task to several agents; tokens and
  cost per session; a button to answer a permission prompt; variables and
  secrets for sessions.
- **Later:** a live preview of the app being built, a plan-first switch, pause
  and resume, scheduled automations, starting from Chat, a network egress
  policy, extra MCP servers per repository, allowed CLIs and models, and files
  in a prompt.
- **Not planned:** the file lists nothing as not planned.

### Chat

Source: [docs/chat-roadmap.md](chat-roadmap.md)

- **Done:** spaces, channels, direct messages, groups, threads, reactions,
  search, voice notes and calls with screen sharing; slowmode; timeout, kick and
  ban; blocking; mark unread; Polaris links drawn as the thing they point at;
  custom emoji per space; a quick switcher; resizable panels. In calls:
  per-person volume, recording, combined audio for devices in one room, raised
  hands and reactions, stream volume and pop-out, backgrounds, and seeing a
  call without joining it.
- **Next:** bots (P0), with webhooks first; a "talking while muted" warning and
  following a device change mid-call (P0); a space audit log, trusted link
  domains, message retention, disappearing messages, push to talk, keeping the
  screen awake, connection warnings and a device check before joining (P1).
  End-to-end encryption is P1 and XL, direct messages and groups first, opt-in
  per conversation. Recording consent is still open as an administrator
  setting.
- **Not planned:** quality by head count and grid pagination (calls are capped
  at 8), live transcription, breakout rooms, SIP dial-in and server-side
  recording. A bot's first version has no event gateway, slash commands or
  interactions.

### CRM

Source: [docs/crm-roadmap.md](crm-roadmap.md)

- **Done:** companies, people and opportunities with custom fields; table,
  saved views and a Kanban board over 100k+ records; bulk edit, merge and
  restore; a timeline with notes and tasks; workflows, dashboards, a forecast
  and an audit log; roles with row scope and hidden fields; CSV import and
  export; duplicate warnings.
- **Next:** custom objects, calendar sync and a public API with keys (P0
  missing); fuller relations and email on the record (P0 partial); rollup
  fields, email templates and sequences, and outbound webhooks (P1).
- **Not planned:** the file lists nothing as not planned; its P2 items include
  a calendar view, approvals, territories, enrichment, multi-currency
  conversion and a native mobile app.

### Deploy

Source: [docs/deploy-roadmap.md](deploy-roadmap.md)

- **Done:** GitHub sources with auto-deploy, previews per pull request and
  rollback; Dockerfile, Nixpacks, static and stack-detected builds; domains,
  certificates, private networking, load balancing and TCP proxies;
  environments and shared variables; logs, metrics, health checks and alarms;
  copies and autoscaling on one server; managed databases with backups,
  restore and upgrades; remote servers over SSH; notifications, RBAC, usage
  and cost estimates, an API and a CLI.
- **Next, in the file's suggested order:** zero-downtime deploys for services
  with a published port; a pre-deploy command, then build cache reuse;
  deploying from a Compose file in the repository; target stage and build
  argument fields, `.env` export and restart policies; GitLab and Gitea
  sources. The scale-out plan (copies across servers, a cross-server entry,
  edge caching, quotas, Polaris in several containers) is in four phases.
- **Not planned:** the file lists nothing as not planned.

### Drive

Source: [docs/drive-roadmap.md](drive-roadmap.md)

- **Done:** storage connections from local disks to S3, NAS vendors and cloud
  drives; a private drive per account and a drive per organization; sending
  and sharing items with roles, notes and expiry; public links with passwords,
  limits and access logs; drop points, snippets, a recycle bin, scheduled
  deletions, an in-place spreadsheet editor and PDF annotation.
- **Next:** a WebDAV endpoint first, then file versioning (P0); file locking,
  full-text search, re-sharing and per-account quota (P1); a desktop sync
  client once WebDAV exists.
- **Not planned:** a mirrored file index and a database row per file. Mobile
  clients, federation and end-to-end encrypted folders stay P2.

### Game servers

Source: [docs/game-servers-roadmap.md](game-servers-roadmap.md)

- **Done:** Polaris's anti-cheat on Paper and its family from 1.17, and on
  NeoForge 1.21.4; where it runs it takes over the game's flight check.
- **In progress:** the anti-cheat on Forge, for every release with a real
  player base.
- **Next:** NeoForge's other releases, Fabric and Quilt, and Paper before 1.17,
  so it runs the same whatever the server is, with nothing to set up.
- **Not planned:** Bedrock.

### Mail

Source: [docs/mail-roadmap.md](mail-roadmap.md)

- **Done:** a local junk filter with per-mailbox learning; `.mbox` and `.eml`
  import and export; forwarding as a filter action; folder colours; shared
  mailboxes handed out by an organization.
- **Next, in order:** IMAP migration, message templates, webhooks with a
  delivery log, a contacts screen, and a standing forwarding address.
- **Not planned:** anything that belongs to being the mail server (connecting
  domains, routing and rejecting at SMTP, outbound jobs), and delegated access
  to another account's mailbox.

### Office

Source: [docs/office-roadmap.md](office-roadmap.md)

- **The plan, in order:** the shared document model, sharing and Yjs transport;
  Docs; Sheets on Univer with GenOffice's pivots, charts and `.xlsx` gateway;
  Diagrams; a structured Comparison document kind; Slides last. The file is the
  plan and the record of decisions; it does not mark which steps have landed.
- **Not planned:** tldraw (its licence needs a paid commercial licence or a
  watermark); GenOffice's Electron shells and packaging. Desktop and mobile
  Office apps are out of scope for now. draw.io may come later as a second
  diagram kind.

### Telemetry

Source: [docs/telemetry-roadmap.md](telemetry-roadmap.md)

- **Done:** Sentry-compatible ingest with per-project keys, reporter rules and
  retention; issue grouping, search syntax, resolve, regression and timed
  ignores; assignees, bulk actions, comments; event stacks, breadcrumbs and
  contexts; releases and environments lists; alert rules delivered as Polaris
  notifications.
- **Next:** teams as owners, rate limits and inbound filters; merge and
  unmerge, saved searches and ownership rules; source maps, attachments and
  user feedback; release details and health; metric alerts, webhook actions
  and a weekly digest.
- **Not planned here:** performance monitoring, uptime checks and session
  replay, which belong to other apps.

### Watch

Source: [docs/watch-roadmap.md](watch-roadmap.md)

- **Done:** raw and hourly metric rollups, container watching, an edge that
  republishes its own routes, and internet outage history with uptime,
  heatmap and CSV export.
- **Next:** the two pollers under the leased scheduler, a check-result history
  table, uptime over 24h, 7d and 30d, and keyword and status-code checks (P0);
  certificate expiry warnings, per-monitor intervals, maintenance windows, TCP
  and DNS monitors, and a heartbeat URL (P1); incidents, a public status page,
  muting one monitor and host metrics read over SSH (P2).
- **Not planned:** an agent installed by piping a script into a shell, probes
  from several regions, per-metric message templates, and alerts without a
  repeat interval or cooldown.

### Dashboard coverage ledger

Source: [dashboard/ROADMAP.md](../dashboard/ROADMAP.md)

- **Done:** the build phases from workspace scaffolding to CI workflows; the
  Drive explorer's interactions; snippets and text drop points; the
  Bitwarden-compatible Vault; the Containers and Servers apps; the edition
  boundary, the full edition by default and in-band updates through hostd; the
  `plr` CLI; Consumption; Tasks, Agents, Notes, Chat, Code and Telemetry.
- **Open in the ledger:** Vault emergency access, live sync and the
  breached-password report; container logs, images and compose stacks;
  OpenSSH certificate sign-in and editing a server; Kubernetes (stubs only);
  signature-verified images for updates; task attachments; Code's issue
  linking, diff comments and opening pull requests; Telemetry source maps and
  performance traces; live end-to-end runs against real NAS, Docker and SSH
  hosts. Some early checklist lines (Drive storage, sharing, file requests)
  are still unchecked there although the Drive roadmap lists them as shipped;
  the per-area file is the newer record.
- **Not planned:** whiteboards, mind maps, clips, AI, email-in, proofing, map
  and workload views and portfolios in Tasks.

## How this roadmap is kept

- The per-area files are the detail; this page is the index.
- This page is updated in the same change that lands or drops an item, so it
  never lags behind the area file it summarizes.
- A decision that changes the platform direction is added here with its date.
