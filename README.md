<div align="center">
  <h1>Polaris</h1>
  <h3>Your home lab, one control plane.</h3>
  <img alt="License" src="https://img.shields.io/badge/License-AGPL--3.0-blue?style=for-the-badge"/>
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white"/>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white"/>
  <br />
  <br />
  <a href="#if-you-already-pay-for-these">Why</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#install">Install</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#whats-in-it">What's in it</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#everything-connects">Integrations</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#usage">Usage</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="docs/developers/README.md">Developers</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="README.es.md">Español</a>
  <hr />
</div>

Polaris is a self-hosted platform to run your servers and your team from one
place: deploy apps and databases to your own machines, manage files across every
NAS and cloud drive, host game servers, and work together with chat, calls,
tasks, calendar, mail and documents.

It replaces the separate tools a home lab or a small team ends up running -
deployments, file sharing, a password manager, uptime checks, analytics, chat, a
task tracker - with one install and one set of accounts. The apps share data: a
task links the deploy it is about, and a file in Drive attaches to a message
without being uploaded again.

It runs in Docker and manages the host it is installed on plus any machine you
add over SSH. After the install, updates and settings are handled from the web
interface.

## A look inside

Screenshots of the real interface with sample data. Most link to a page with
the full feature list. Mobile versions are in
[docs/assets/media](docs/assets/media).

### Talk

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/chat.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/chat-light-en-desktop.webp">
        <img src="docs/assets/media/chat-dark-en-desktop.webp" alt="Chat: spaces, channels, threads and direct messages">
      </picture>
      </a>
      <br><sub><a href="docs/features/chat.md"><b>Chat</b></a>: spaces, channels, threads and direct messages</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/features/calls.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/in-call-light-en-desktop.webp">
        <img src="docs/assets/media/in-call-dark-en-desktop.webp" alt="Calls: voice channels, meetings and calls in any chat">
      </picture>
      </a>
      <br><sub><a href="docs/features/calls.md"><b>Calls</b></a>: voice channels, meetings and calls in any chat</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/calls.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/call-direct-light-en-desktop.webp">
        <img src="docs/assets/media/call-direct-dark-en-desktop.webp" alt="A video call in a direct message">
      </picture>
      </a>
      <br><sub><a href="docs/features/calls.md"><b>Direct call</b></a>: face to face from any direct message</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/features/calls.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/call-group-light-en-desktop.webp">
        <img src="docs/assets/media/call-group-dark-en-desktop.webp" alt="A group call with a shared screen, being recorded">
      </picture>
      </a>
      <br><sub><a href="docs/features/calls.md"><b>Group call</b></a>: cameras, a shared screen and a recording</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/calls.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/soundboard-light-en-desktop.webp">
        <img src="docs/assets/media/soundboard-dark-en-desktop.webp" alt="The soundboard in a call: Polaris's own sounds and the space's">
      </picture>
      </a>
      <br><sub><a href="docs/features/calls.md"><b>Soundboard</b></a>: Polaris's own sounds and the space's, played into the call</sub>
    </td>
  </tr>
</table>

### Work

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/tasks.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/tasks-light-en-desktop.webp">
        <img src="docs/assets/media/tasks-dark-en-desktop.webp" alt="Tasks: lists, boards, sprints and goals">
      </picture>
      </a>
      <br><sub><a href="docs/features/tasks.md"><b>Tasks</b></a>: lists, boards, sprints and goals</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/features/calendar.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/calendar-light-en-desktop.webp">
        <img src="docs/assets/media/calendar-dark-en-desktop.webp" alt="Calendar: every calendar you have, synced both ways">
      </picture>
      </a>
      <br><sub><a href="docs/features/calendar.md"><b>Calendar</b></a>: every calendar you have, synced both ways</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/mail.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/mail-light-en-desktop.webp">
        <img src="docs/assets/media/mail-dark-en-desktop.webp" alt="Mail: every mailbox in one inbox">
      </picture>
      </a>
      <br><sub><a href="docs/features/mail.md"><b>Mail</b></a>: every mailbox in one inbox</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/features/office.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/office-light-en-desktop.webp">
        <img src="docs/assets/media/office-dark-en-desktop.webp" alt="Office: documents, sheets, slides and diagrams">
      </picture>
      </a>
      <br><sub><a href="docs/features/office.md"><b>Office</b></a>: documents, sheets, slides and diagrams</sub>
    </td>
  </tr>
</table>

### Files and secrets

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/drive.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/drive-light-en-desktop.webp">
        <img src="docs/assets/media/drive-dark-en-desktop.webp" alt="Drive: your drive and every storage you own">
      </picture>
      </a>
      <br><sub><a href="docs/features/drive.md"><b>Drive</b></a>: your drive and every storage you own</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/features/vault.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/vault-light-en-desktop.webp">
        <img src="docs/assets/media/vault-dark-en-desktop.webp" alt="Vault: passwords and one-time codes, Bitwarden compatible">
      </picture>
      </a>
      <br><sub><a href="docs/features/vault.md"><b>Vault</b></a>: passwords and one-time codes, Bitwarden compatible</sub>
    </td>
  </tr>
</table>

### Running things

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/deploy.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/deploy-project-light-en-desktop.webp">
        <img src="docs/assets/media/deploy-project-dark-en-desktop.webp" alt="Deploy: apps, databases and domains on your machines">
      </picture>
      </a>
      <br><sub><a href="docs/features/deploy.md"><b>Deploy</b></a>: apps, databases and domains on your machines</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/features/marketplace.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/marketplace-light-en-desktop.webp">
        <img src="docs/assets/media/marketplace-dark-en-desktop.webp" alt="Marketplace: apps installed with one press">
      </picture>
      </a>
      <br><sub><a href="docs/features/marketplace.md"><b>Marketplace</b></a>: apps installed with one press</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/game-servers.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/games-light-en-desktop.webp">
        <img src="docs/assets/media/games-dark-en-desktop.webp" alt="Game servers: Minecraft, ARK and FiveM on your own machines">
      </picture>
      </a>
      <br><sub><a href="docs/features/game-servers.md"><b>Game servers</b></a>: Minecraft, ARK and FiveM on your own machines</sub>
    </td>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/places-light-en-desktop.webp">
        <img src="docs/assets/media/places-dark-en-desktop.webp" alt="Places: a place's cameras beside each room's locks, lights and climate">
      </picture>
      <br><sub><b>Places</b>: cameras and device controls for each place</sub>
    </td>
  </tr>
</table>

### Getting around

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/launcher.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/launcher-light-en-desktop.webp">
        <img src="docs/assets/media/launcher-dark-en-desktop.webp" alt="App launcher: every app, and what is waiting in each">
      </picture>
      </a>
      <br><sub><a href="docs/features/launcher.md"><b>App launcher</b></a>: every app, and what is waiting in each</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/features/settings.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/settings-light-en-desktop.webp">
        <img src="docs/assets/media/settings-dark-en-desktop.webp" alt="Settings: the deployment's, and your own account's">
      </picture>
      </a>
      <br><sub><a href="docs/features/settings.md"><b>Settings</b></a>: the deployment's, and your own account's</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/features/settings.md">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/media/settings-users-light-en-desktop.webp">
        <img src="docs/assets/media/settings-users-dark-en-desktop.webp" alt="People: every account with its roles, limits and invitations">
      </picture>
      </a>
      <br><sub><a href="docs/features/settings.md"><b>People and access</b></a>: who is in, their roles and what limits them</sub>
    </td>
  </tr>
</table>

## If you already pay for these

What Polaris replaces, on your own hardware and with one account:

| What you use today                 | What Polaris runs instead                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway, Render, Fly               | Deploy from a repository or an image - onto their servers or onto your own machines                                                                                                 |
| Discord, Slack, WhatsApp, Telegram | One chat: channels and servers, direct messages, calls, meetings, voice notes, screen clips                                                                                         |
| GitHub Actions                     | The same workflows on your own runners, so a private repository costs no minutes                                                                                                    |
| CodeRabbit                         | Reviews and coding agents that run here, on your own model keys                                                                                                                     |
| Pterodactyl and a pile of scripts  | Game servers - Minecraft, ARK and FiveM - with worlds, mods, resources, players and schedules                                                                                       |
| ClickUp, Jira, Linear              | Spaces, lists, boards, sprints, goals, docs and time tracking - or connect your existing Linear or Jira and keep its issues mirrored in, with status pushed back                    |
| Google Calendar, Proton Calendar   | Day to year views, sharing and public links, two-way sync with Google, Microsoft and any CalDAV server, reminders, invitations and booking pages other people can reserve a slot on |
| Home Assistant, a camera app       | Places: cameras with live views, detections, clips and alerts, plus switches, plugs, lights, locks, air conditioners and purifiers from a dozen brands, with automations            |
| Your NAS vendor's web UI           | One file browser across every NAS you own, with sharing and drop points                                                                                                             |
| Bitwarden, 1Password               | A vault your existing Bitwarden apps can point at, encrypted in the browser                                                                                                         |
| Cloudflare's dashboard             | A firewall of your own: rules, country and network blocks, bot defences, bans                                                                                                       |
| A backup tool and a database GUI   | Scheduled backups with restore, and Postgres, MySQL, MariaDB, MongoDB and Redis                                                                                                     |
| Google Analytics, Plausible        | Cookieless analytics for the sites you host                                                                                                                                         |

## Install

One command installs the dashboard, database, reverse proxy and host daemon,
and generates the secrets:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.ps1 | iex
```

Linux is the recommended host - Ubuntu Server is what Polaris is run against.
Windows works, but Docker there runs inside WSL and the host Polaris manages is
that virtual machine rather than the machine itself; see
[Requirements](#requirements).

Prefer to do it by hand? Clone the repo and run Compose directly:

```bash
git clone https://github.com/FJRG2007/polaris.git
cd polaris/dashboard/docker
cp .env.example .env                  # then replace every REPLACE_ME value in it
docker network create polaris-proxy   # compose expects both to exist already
docker network create polaris-hub
docker compose --profile full up -d
```

Then open `https://127.0.0.1/oauth/setup?token=` followed by the
`POLARIS_SETUP_TOKEN` you put in `.env`, and create the administrator. The
certificate is self-signed until a domain points here, so the browser warns once.

To update, use the Update button in Settings.

## What's in it

Each app is enabled per account and per role.

**Files and secrets**

- **Drive** - a private drive per account and a shared one per organization,
  across local disks, SFTP, S3-compatible storage, SMB/NFS, UniFi UNAS, Google
  Drive, OneDrive and Dropbox (WebDAV, Synology, QNAP and TrueNAS are coming).
  Streaming transfers for large files; sharing with people and groups by role
  and expiry; public links with password and expiry; drop points for people
  without an account; viewers and editors for documents, spreadsheets, PDFs and
  media; thumbnails in the grid.
- **Vault** - a password manager compatible with the Bitwarden apps and
  extensions. Encrypted in the browser; the server never sees the master
  password.

**Running things**

- **Deploy** - deploy an app from a Git repository or an image, with databases,
  volumes, environment variables, logs, a terminal, a file browser and a domain.
  Public access through your own domain, a Cloudflare tunnel or DuckDNS.
- **Servers** - enrol a machine over SSH with one generated command, then use its
  terminal, files, metrics and Docker engine from here.
- **Containers** and **Backups** - what is running on every host, and scheduled
  backups of it with restore.
- **Marketplace** - one-click installs: Polaris's own apps from Management >
  Polaris apps, other developers' software from Apps > Marketplace.
- **Game servers** - Minecraft, ARK and FiveM, with worlds, mods, resources,
  players, schedules, crash detection, and Minecraft challenges (daily, weekly,
  season pass, bingo and community goals). Worlds can live on a NAS.
- **Runners** - GitHub Actions compatible CI on your own machines, with per-repo
  policy and budgets.
- **Agents** - coding agents on your repositories: headless runs that open pull
  requests and answer reviews with your own model keys, and live sessions of
  Claude Code, Codex and other CLIs in a terminal you can watch and steer. A
  task can be assigned to an agent, which updates it through Polaris's MCP
  server.
- **Code** - the pull requests and issues you have open on GitHub, read as you.
- **Databases** - Postgres, MySQL, MariaDB, MongoDB and Redis: browse, query and
  back up what you deployed, or connect to one elsewhere - directly or through an
  SSH tunnel, via a registered server or a login typed into the connection.

**Work and people**

- **Tasks** - spaces, lists, boards, sprints, goals, docs, custom fields,
  automations, forms and time tracking.
- **Calendar** - day, week, month and year views, sharing and public links,
  two-way sync with Google, Microsoft 365 and any CalDAV server or ICS feed,
  reminders, invitations, free/busy, meeting rooms and booking pages other
  people can reserve a slot on, plus a Time area with alarms, timers, focus
  cycles, a stopwatch and a world clock.
- **Chat** - servers and channels, direct messages and groups, calls, meetings,
  screen sharing and recording, a soundboard, voice messages, screen clips and
  scheduled messages.
- **Notes** - nested notes; imports an Obsidian vault or a folder of Markdown.
- **Inbox** - Telegram, WhatsApp, Discord and Slack conversations in one place.
- **Organizations** - teams with their own members and roles.

**Keeping an eye on it**

- **Watch** - alerts on app health, spikes and outages, with webhooks, plus
  uptime history and a 90-day heatmap.
- **Analytics** - cookieless web analytics for the sites you host.
- **Firewall** - a rule per protection: allow and deny lists, country and network
  rules, bot and scraper defences, injection scanning, and automatic bans.
- **Domain security** - every domain Polaris knows, audited for spoofable mail
  (SPF, DKIM, DMARC, MTA-STS), DNS exposure (DNSSEC, CAA, open zone transfers,
  dangling records), registration (expiry, transfer lock) and web hardening
  (TLS, HSTS, security headers), with one-click fixes where Polaris manages the
  domain and an alert when the daily check finds a regression.
- **Places** - cameras and smart devices per location: live views, clips,
  detections and alerts delivered as messages; switches, plugs, lights, locks,
  air conditioners and purifiers from Tuya, TP-Link, Shelly, Hue, IKEA, Gree,
  Philips (Air+, HomeID and Dynalite), Home Assistant and SwitchBot; automations
  across all of them; an alert when a camera goes offline.

**The account itself**

Passwords, passkeys, two-factor, trusted devices, QR sign-in from another device,
sessions, API keys, access rules, privacy and notification settings. Claude,
ChatGPT, Cursor, VS Code and any other MCP client can connect as you, limited to
what you approve - see
[`docs/connecting-ai-assistants.md`](docs/connecting-ai-assistants.md).

What is built versus in progress is tracked in
[`dashboard/ROADMAP.md`](dashboard/ROADMAP.md).

## Where it runs

The interface is in English and Spanish ([en español](README.es.md)), and each account picks its own.

| Client                                                                        | Status                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app, installable from the browser                                         | Available                                                                                                                                                   |
| Browser extension for Chrome and Firefox: fills sign-in forms from your vault | Available ([releases](https://github.com/FJRG2007/polaris/releases?q=extension))                                                                            |
| MCP server for Claude, ChatGPT, Cursor, VS Code and other AI clients          | Available ([setup](docs/connecting-ai-assistants.md))                                                                                                       |
| Developer CLI (`plr`): deploy, logs, restarts                                 | Available ([releases](https://github.com/FJRG2007/polaris/releases?q=cli))                                                                                  |
| Stream Deck plugin (Stream Deck app, OpenDeck) and Bitfocus Companion module  | Available ([Stream Deck](https://github.com/FJRG2007/polaris/releases?q=streamdeck), [Companion](https://github.com/FJRG2007/polaris/releases?q=companion)) |
| Desktop app for Windows, macOS and Linux                                      | Coming: in the repo, not released yet                                                                                                                       |
| iOS and Android apps                                                          | Coming                                                                                                                                                      |

## Everything connects

The services Polaris already talks to. Each one is switched on from the interface.

|                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/assets/logos/google.svg" width="28" height="28" alt="Google" title="Google">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **Google**: sign in, two-way Calendar and Tasks sync, Gmail as a mailbox, Google Drive as storage, Docs and Sheets imported into Office                  |
| <img src="docs/assets/logos/microsoft.svg" width="28" height="28" alt="Microsoft" title="Microsoft">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Microsoft 365**: Outlook calendar sync, Outlook mail, OneDrive as storage                                                                              |
| <img src="docs/assets/logos/github.svg" width="28" height="28" alt="GitHub" title="GitHub"> <img src="docs/assets/logos/github-copilot.svg" width="28" height="28" alt="GitHub Copilot" title="GitHub Copilot">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **GitHub**: sign in, deploy repositories, run Actions on your own runners, read pull requests and issues                                                 |
| <img src="docs/assets/logos/linear.svg" width="28" height="28" alt="Linear" title="Linear"> <img src="docs/assets/logos/jira.svg" width="28" height="28" alt="Jira" title="Jira">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **Linear and Jira**: issues mirrored into Tasks, status pushed back                                                                                      |
| <img src="docs/assets/logos/icloud.svg" width="28" height="28" alt="iCloud" title="iCloud"> <img src="docs/assets/logos/nextcloud.svg" width="28" height="28" alt="Nextcloud" title="Nextcloud">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **CalDAV**: iCloud, Nextcloud, Fastmail, Yahoo or any CalDAV server, plus ICS feeds                                                                      |
| <img src="docs/assets/logos/telegram.svg" width="28" height="28" alt="Telegram" title="Telegram"> <img src="docs/assets/logos/whatsapp.svg" width="28" height="28" alt="WhatsApp" title="WhatsApp"> <img src="docs/assets/logos/discord.svg" width="28" height="28" alt="Discord" title="Discord"> <img src="docs/assets/logos/slack.svg" width="28" height="28" alt="Slack" title="Slack">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **Inbox**: conversations from Telegram, WhatsApp, Discord and Slack in one place                                                                         |
| <img src="docs/assets/logos/dropbox.svg" width="28" height="28" alt="Dropbox" title="Dropbox"> <img src="docs/assets/logos/ubiquiti.svg" width="28" height="28" alt="Ubiquiti UniFi" title="Ubiquiti UniFi"> <img src="docs/assets/logos/docker.svg" width="28" height="28" alt="Docker" title="Docker">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **Storage and hosts**: Dropbox, UniFi UNAS, S3, SFTP, SMB and NFS in Drive; the Docker engine of every server you enrol                                  |
| <img src="docs/assets/logos/vercel.svg" width="28" height="28" alt="Vercel" title="Vercel"> <img src="docs/assets/logos/railway.svg" width="28" height="28" alt="Railway" title="Railway"> <img src="docs/assets/logos/aws.svg" width="28" height="28" alt="AWS" title="AWS">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Deploy elsewhere**: Vercel, Railway and AWS (ECS, Amplify) projects next to your own                                                                   |
| <img src="docs/assets/logos/cloudflare.svg" width="28" height="28" alt="Cloudflare" title="Cloudflare"> <img src="docs/assets/logos/ngrok.svg" width="28" height="28" alt="ngrok" title="ngrok"> <img src="docs/assets/logos/duckdns.svg" width="28" height="28" alt="DuckDNS" title="DuckDNS">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **Networking**: DNS records and tunnels with Cloudflare, ngrok tunnels, DuckDNS names                                                                    |
| <img src="docs/assets/logos/anthropic.svg" width="28" height="28" alt="Anthropic" title="Anthropic"> <img src="docs/assets/logos/openai.svg" width="28" height="28" alt="OpenAI" title="OpenAI"> <img src="docs/assets/logos/gemini.svg" width="28" height="28" alt="Google Gemini" title="Google Gemini"> <img src="docs/assets/logos/xai.svg" width="28" height="28" alt="xAI" title="xAI"> <img src="docs/assets/logos/deepseek.svg" width="28" height="28" alt="DeepSeek" title="DeepSeek"> <img src="docs/assets/logos/moonshot.svg" width="28" height="28" alt="Moonshot AI" title="Moonshot AI"> <img src="docs/assets/logos/groq.svg" width="28" height="28" alt="Groq" title="Groq"> <img src="docs/assets/logos/cerebras.svg" width="28" height="28" alt="Cerebras" title="Cerebras"> <img src="docs/assets/logos/openrouter.svg" width="28" height="28" alt="OpenRouter" title="OpenRouter">                                                                               | **Models**: your own keys for these and over 50 more providers                                                                                           |
| <img src="docs/assets/logos/claude.svg" width="28" height="28" alt="Claude" title="Claude"> <img src="docs/assets/logos/cursor.svg" width="28" height="28" alt="Cursor" title="Cursor"> <img src="docs/assets/logos/opencode.svg" width="28" height="28" alt="OpenCode" title="OpenCode"> <img src="docs/assets/logos/vscode.svg" width="28" height="28" alt="Visual Studio Code" title="Visual Studio Code">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Coding agents**: Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor CLI, OpenCode and 9 more in live sessions; MCP clients connect as you             |
| <img src="docs/assets/logos/tuya.svg" width="28" height="28" alt="Tuya" title="Tuya"> <img src="docs/assets/logos/tp-link.svg" width="28" height="28" alt="TP-Link" title="TP-Link"> <img src="docs/assets/logos/shelly.svg" width="28" height="28" alt="Shelly" title="Shelly"> <img src="docs/assets/logos/philips-hue.svg" width="28" height="28" alt="Philips Hue" title="Philips Hue"> <img src="docs/assets/logos/ikea.svg" width="28" height="28" alt="IKEA" title="IKEA"> <img src="docs/assets/logos/gree.svg" width="28" height="28" alt="Gree" title="Gree"> <img src="docs/assets/logos/philips.svg" width="28" height="28" alt="Philips" title="Philips"> <img src="docs/assets/logos/home-assistant.svg" width="28" height="28" alt="Home Assistant" title="Home Assistant"> <img src="docs/assets/logos/switchbot.svg" width="28" height="28" alt="SwitchBot" title="SwitchBot"> <img src="docs/assets/logos/nuki.svg" width="28" height="28" alt="Nuki" title="Nuki"> | **Places**: plugs, lights, locks and climate from these brands; cameras from Tapo, VIGI, Reolink, Hikvision, Dahua, Amcrest, or any ONVIF or RTSP camera |
| <img src="docs/assets/logos/steam.svg" width="28" height="28" alt="Steam" title="Steam"> <img src="docs/assets/logos/epic-games.svg" width="28" height="28" alt="Epic Games" title="Epic Games"> <img src="docs/assets/logos/minecraft.svg" width="28" height="28" alt="Minecraft" title="Minecraft"> <img src="docs/assets/logos/discord.svg" width="28" height="28" alt="Discord" title="Discord">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Game servers**: players link their game accounts so servers recognise them                                                                             |
| <img src="docs/assets/logos/spotify.svg" width="28" height="28" alt="Spotify" title="Spotify"> <img src="docs/assets/logos/tenor.svg" width="28" height="28" alt="Tenor" title="Tenor"> <img src="docs/assets/logos/giphy.svg" width="28" height="28" alt="GIPHY" title="GIPHY">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Chat**: listen along on Spotify, GIFs from Tenor and GIPHY, Krisp noise filtering in calls                                                             |
| <img src="docs/assets/logos/virustotal.svg" width="28" height="28" alt="VirusTotal" title="VirusTotal"> <img src="docs/assets/logos/criminal-ip.svg" width="28" height="28" alt="Criminal IP" title="Criminal IP">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **Security**: uploads scanned by VirusTotal, known-bad addresses blocked with Criminal IP or Dymo                                                        |
| <img src="docs/assets/logos/bitwarden.svg" width="28" height="28" alt="Bitwarden" title="Bitwarden"> <img src="docs/assets/logos/keepassxc.svg" width="28" height="28" alt="KeePassXC" title="KeePassXC">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Vault**: Bitwarden apps and extensions point at it; imports from Bitwarden, KeePass or any CSV                                                         |
| <img src="docs/assets/logos/obsidian.svg" width="28" height="28" alt="Obsidian" title="Obsidian">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **Notes**: an Obsidian vault, or any folder of Markdown, imported with its links                                                                         |
| <img src="docs/assets/logos/postgresql.svg" width="28" height="28" alt="PostgreSQL" title="PostgreSQL"> <img src="docs/assets/logos/mysql.svg" width="28" height="28" alt="MySQL" title="MySQL"> <img src="docs/assets/logos/mariadb.svg" width="28" height="28" alt="MariaDB" title="MariaDB"> <img src="docs/assets/logos/mongodb.svg" width="28" height="28" alt="MongoDB" title="MongoDB"> <img src="docs/assets/logos/redis.svg" width="28" height="28" alt="Redis" title="Redis">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Databases**: deployed or external, browsed, queried and backed up                                                                                      |

Mail also takes any IMAP account and imports `.mbox` and `.eml` archives.

## The apps link to each other

Something made in one app is reachable from the others without copying it.

- **Mention it.** Type `#` in a chat message, an email, a task or a note to link a task, a doc or a note. A pasted link to a task, event, channel or message becomes a card that shows its current state.
- **Attach from Drive.** Chat, Mail, Tasks and Office take a file straight from Drive, with no download and re-upload.
- **Plan it in Calendar.** Create a task due at a slot, or give an event a Polaris meeting link.
- **Hand it to an agent.** A task goes to a coding agent from its panel; the agent reads it and moves it through Polaris's MCP server.
- **Hear about it in Chat.** Camera and device alerts from Places arrive as messages.

```mermaid
flowchart LR
    Drive -- attach --> Chat
    Drive -- attach --> Mail
    Drive -- attach --> Tasks
    Drive -- open as a document --> Office
    Chat -- "mention with #" --> Tasks
    Mail -- "mention with #" --> Tasks
    Notes -- "mention with #" --> Tasks
    Calendar -- new task due here --> Tasks
    Calendar -- meeting link --> Chat
    Tasks -- hand to agent --> Agents
```

## Built in for every app you deploy

These work for any service Polaris deploys, with no SDK, agent or change to the app's code: they run at the edge or on the host.

|                                                                                                                                                                                                                                                    | Instead of                               | Polaris                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/assets/logos/google-analytics.svg" width="28" height="28" alt="Google Analytics" title="Google Analytics"> <img src="docs/assets/logos/plausible.svg" width="28" height="28" alt="Plausible Analytics" title="Plausible Analytics"> | Google Analytics, Plausible              | **Analytics** read from the edge's access log, with no script tag                                                                     |
| <img src="docs/assets/logos/cloudflare.svg" width="28" height="28" alt="Cloudflare" title="Cloudflare">                                                                                                                                            | Cloudflare WAF and Access                | **Firewall** in front of every route: country and network rules, bot defences, injection scanning, bans, and an optional sign-in wall |
| <img src="docs/assets/logos/beekeeper-studio.svg" width="28" height="28" alt="Beekeeper Studio" title="Beekeeper Studio">                                                                                                                          | Beekeeper Studio and other database GUIs | **Databases**: browse and query Postgres, MySQL, MariaDB, MongoDB and Redis                                                           |
| <img src="docs/assets/logos/uptime-kuma.svg" width="28" height="28" alt="Uptime Kuma" title="Uptime Kuma">                                                                                                                                         | Uptime Kuma and other uptime checkers    | **Watch**: every domain probed, a sustained outage alerted                                                                            |
| <img src="docs/assets/logos/datadog.svg" width="28" height="28" alt="Datadog" title="Datadog">                                                                                                                                                     | Datadog and other metrics agents         | **Metrics** for every container and server, read over SSH and Docker                                                                  |
| <img src="docs/assets/logos/lets-encrypt.svg" width="28" height="28" alt="Let's Encrypt" title="Let's Encrypt">                                                                                                                                    | Certbot                                  | **HTTPS**: Let's Encrypt certificates issued and renewed for each public domain                                                       |

<img src="docs/assets/logos/sentry.svg" width="20" height="20" alt="Sentry" title="Sentry"> Error tracking is the exception: **Telemetry** takes events from the Sentry SDK your app already uses, so the one change is the DSN.

## How it works

### Updating

The Update button in Settings is how an installed Polaris is updated. The limited edition has no host daemon, so there the button reports that updates are unavailable.

```mermaid
flowchart LR
    A[Update button] --> B[dashboard]
    B -- full edition: POST /v1/update --> C[polaris-hostd]
    B -- limited edition: no hostd --> Y[updates unavailable]
    C -- update command set --> D[polaris-updater]
    D --> E[scripts/update.sh]
    E --> F[pull the release]
    F --> G[add new settings to .env]
    G --> H[start the new dashboard, retire the old one]
    C -- no update command --> X[501: not available]
```

### A request through the edge

Every router has an explicit priority, highest first. Routes with firewall rules pass through the guard before reaching the app.

```mermaid
flowchart LR
    R[request] --> T[Traefik]
    T -- "110: call path, guarded" --> L[LiveKit]
    T -- "100: /livekit, /api/deploy/ws" --> P[LiveKit, terminal]
    T -- "50: dashboard hostnames" --> D[dashboard]
    T -- "40: deployed app hostnames" --> G{firewall guard}
    G -- allowed --> S[app container]
    G -- denied --> B[block page]
    T -- "10: catch-all" --> D
    T -- "1: unrouted name" --> V[vacant page]
```

### Deploying an app

```mermaid
flowchart LR
    A[Git repository] --> B[build on the server or a chosen build machine]
    U[upload] --> B
    I[image] --> C
    B --> C
    C[container on the Polaris host or an enrolled server] --> E[that server's Traefik: route and firewall]
    E --> F[your domain, a Cloudflare or ngrok tunnel, or DuckDNS]
```

### Repository layout

```mermaid
flowchart TB
    subgraph dashboard
        web[apps/web: Next.js dashboard]
        apps[apps/calendar, places, game-servers, crm]
        ext[apps/extension: browser extension]
        pkgs[packages: core, db, ui, storage, deploy, ...]
        svc[services: edge-guard, messaging-bridge, camera-relay, vision, face, hytale]
        cli[packages/cli: developer CLI]
    end
    hostd[crates/polaris-hostd: Rust host daemon]
    desk[desktop: Electron app]
    web --> pkgs
    apps --> pkgs
    cli --> web
    desk --> web
    ext --> web
    web -- unix socket --> hostd
```

## Usage

Once it is up, open the dashboard and create your account - **the first account
becomes the administrator**.

On your local network it is also reachable at **`http://polaris.local`** (mDNS),
and at **`http://polaris`** from the machine running it.

The desktop app (Windows, macOS, Linux) opens an instance in its own window with
system notifications; see [`desktop/README.md`](desktop/README.md).

## Requirements

[Docker Engine](https://docs.docker.com/engine/install/) with the Compose v2
plugin. For local development without containers, see the
[developer guide](docs/developers/README.md).

**Run it on Linux** (Ubuntu Server is the tested target). Polaris uses
privileged mounts, the host's Docker engine and host networking, which are
native there.

Windows is not recommended as the host: Docker runs inside WSL, so Polaris
manages that virtual machine instead of the machine itself, and mounts and host
networking behave differently or not at all. A Windows machine works fine as an
additional **server** managed from a Linux install.

## Contributing

How to report a bug, propose a change and open a pull request is in
[CONTRIBUTING.md](CONTRIBUTING.md); everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md). The monorepo layout, the development
loop, how to build and test the dashboard and the Rust components, and the
release flow all live in the [developer guide](docs/developers/README.md).

## License

Polaris is licensed under the [GNU AGPL-3.0](LICENSE) with the additional terms
in [NOTICE.md](NOTICE.md):

- Use it, change it and share it, commercially too, under the AGPL-3.0.
- A modified version - distributed, or offered to people over a network - must
  publish its full source under the same license. Closed-source forks are not
  allowed.
- A modified version must say visibly that it is based on Polaris.

To use Polaris outside those terms, for example in a closed-source product or a
hosted service whose source you do not publish, ask for a commercial license
(see [NOTICE.md](NOTICE.md)). Releases published before this change remain
under Apache-2.0.

To cite Polaris, use [CITATION.cff](CITATION.cff).
