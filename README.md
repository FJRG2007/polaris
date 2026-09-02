<div align="center">
  <h1>Polaris</h1>
  <h3>Your home lab, one control plane.</h3>
  <img alt="License" src="https://img.shields.io/badge/License-Apache--2.0-blue?style=for-the-badge"/>
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
  <a href="#usage">Usage</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="docs/developers/README.md">Developers</a>
  <hr />
</div>

Polaris is a self-hosted workspace for everything you run yourself: your files,
your servers, the apps you deploy on them, the work you plan around them, and the
people you do it with. One install, one login, one dark interface with an app
switcher in the top-left corner.

It replaces the pile that usually grows around a home lab or a small team - a
file browser, a deployment tool, a task board, a chat client, a password manager,
an uptime monitor, an analytics script - with one control plane where those
things already know about each other. A deploy can be discussed in a channel, a
task can carry the file, and everybody in it has one account.

Polaris runs in Docker and reaches out from there: native mounts, the host's own
Docker engine, and the machines you enrol over SSH are all managed from the one
container. After the install, nothing needs a terminal - updates, new features
and repairs all happen from the interface.

## If you already pay for these

The fastest way to say what Polaris is: it is the tools you are already using,
on hardware you already own, sharing one account and one interface.

| What you use today                 | What Polaris runs instead                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway, Render, Fly               | Deploy from a repository or an image - onto their servers or onto your own machines                                                                              |
| Discord, Slack, WhatsApp, Telegram | One chat: channels and servers, direct messages, calls, meetings, voice notes, screen clips                                                                      |
| GitHub Actions                     | The same workflows on your own runners, so a private repository costs no minutes                                                                                 |
| CodeRabbit                         | Reviews and coding agents that run here, on your own model keys                                                                                                  |
| Pterodactyl and a pile of scripts  | Game servers - Minecraft, ARK and FiveM - with worlds, mods, resources, players and schedules                                                                    |
| ClickUp, Jira, Linear              | Spaces, lists, boards, sprints, goals, docs and time tracking - or connect your existing Linear or Jira and keep its issues mirrored in, with status pushed back |
| Home Assistant, a camera app       | Places and cameras: live views, detections, clips, and alerts that arrive in chat                                                                                |
| Your NAS vendor's web UI           | One file browser across every NAS you own, with sharing and drop points                                                                                          |
| Bitwarden, 1Password               | A vault your existing Bitwarden apps can point at, encrypted in the browser                                                                                      |
| Cloudflare's dashboard             | A firewall of your own: rules, country and network blocks, bot defences, bans                                                                                    |
| A backup tool and a database GUI   | Scheduled backups with restore, and Postgres, MySQL, MariaDB, MongoDB and Redis                                                                                  |
| Google Analytics, Plausible        | Cookieless analytics for the sites you host                                                                                                                      |

None of it is a fork of any of them. It is the same idea, built once, with the
half those products cannot give you: it is yours, it is on your hardware, and
every part of it knows about the others.

## Install

One command. It brings up the whole stack - dashboard, database, reverse proxy
and the privileged host daemon - generates its secrets, and needs no flags:

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

Updating is a button in Settings. There is a script behind it for anybody who
would rather drive it themselves.

## What's in it

Every app is switched on per account and per role, so somebody invited to help
with one thing does not get the rest.

**Files and secrets**

- **Drive** - a private drive for every account from the moment they open it, plus
  a shelf for every organization, reached by everybody on its roster; browsing,
  uploading, downloading and sharing across every NAS you own: local disks,
  SFTP, WebDAV, S3-compatible, SMB/NFS, and vendor APIs (Synology, QNAP,
  TrueNAS, UniFi UNAS). Streaming transfers, so multi-gigabyte files never
  buffer. Send a file or folder to a person or an organization, a copy by
  default or the file itself on a move, kept with the sender until accepted;
  share a file or folder with a person or group, with a role, a note and
  an expiry; public links with passwords and expiry; drop points for people who
  have no account; viewers and editors for documents, spreadsheets, PDFs and
  media; and a grid that shows the picture of an image or a document's first
  page instead of a generic icon.
- **Vault** - a password manager that speaks the Bitwarden client protocol, so
  the apps and extensions you already use point at your own instance. Everything
  is encrypted in the browser; the server never sees a master password.

**Running things**

- **Deploy** - deploy an app from a Git repository or an image, with databases,
  volumes, environment variables, logs, a terminal, a file browser and a domain.
  Public access through your own domain, a Cloudflare tunnel or DuckDNS.
- **Servers** - enrol a machine over SSH with one generated command, then use its
  terminal, files, metrics and Docker engine from here.
- **Containers** and **Backups** - what is running on every host, and scheduled
  backups of it with restore.
- **Marketplace** - one-press installs for the things people actually self-host,
  including **game servers** (Minecraft, ARK and FiveM, with worlds, mods,
  resources, players, schedules and crash detection).
- **Runners** - GitHub Actions compatible CI on your own machines, with per-repo
  policy and budgets.
- **Agents** - coding agents that work in a repository: headless runs that open
  pull requests and answer reviews with your own model keys, and live sessions
  that run the vendor's own CLI (Claude Code, Codex and others) in a real
  terminal you can watch and steer from anywhere. A task can be handed straight
  to one from its panel, and the agent reads and moves it back through
  Polaris's own MCP server.
- **Code** - the pull requests and issues you have open on GitHub, read as you.
- **Databases** - Postgres, MySQL, MariaDB, MongoDB and Redis: browse, query and
  back up what you deployed.

**Work and people**

- **Tasks** - spaces, lists, boards, sprints, goals, docs, custom fields,
  automations, forms and time tracking.
- **Chat** - servers and channels, direct messages and groups, with calls,
  meetings, screen sharing, voice messages, screen clips recorded in the browser,
  and messages written now and sent at an hour that suits.
- **Notes** - somewhere to write things down, nested the way a notebook is.
- **Inbox** - conversations that arrive from outside, across every channel you
  connect.
- **Organizations** - teams, rosters and per-organization roles, so a group of
  people can own work together.

**Keeping an eye on it**

- **Watch** - alarms on app health, spikes and outages, with webhooks.
- **Analytics** - cookieless web analytics for the sites you host.
- **Firewall** - a rule per protection: allow and deny lists, country and network
  rules, bot and scraper defences, injection scanning, and automatic bans.
- **Places** - the places you own and the cameras in them: live views, clips,
  events, detections and alerts that arrive as messages, plus a notice the
  moment a camera itself stops answering.

**The account itself**

Passwords, passkeys, two-factor, trusted devices, QR sign-in from another device,
sessions, API keys, access rules, privacy settings, notification preferences, and
a record of where your account stands.

What is built versus in progress is tracked in
[`dashboard/ROADMAP.md`](dashboard/ROADMAP.md).

## Usage

Once it is up, open the dashboard and create your account - **the first account
becomes the administrator**.

**Reach it by name**, Home-Assistant style: the stack advertises itself over mDNS,
so any device on your network can open **`http://polaris.local`**, and the machine
running Polaris also resolves bare **`http://polaris`**.

An install is one thing, with nothing to choose: the privileged host daemon that
lets Polaris manage the machine it runs on - mounts, the Docker engine, its own
updates - is part of it, along with the dedicated key it uses to reach that
machine's Docker engine and the `polaris` command for the host.

## Requirements

[Docker Engine](https://docs.docker.com/engine/install/) with the Compose v2
plugin. That's it. For local development without containers, see the
[developer guide](docs/developers/README.md).

**Run it on Linux** - Ubuntu Server is what it is developed and run against.
Polaris manages the machine it lives on, and that means privileged mounts, the
host's Docker engine and host networking, all of which are native there.

On Windows, Docker runs inside WSL, so the host Polaris would be managing is that
virtual machine rather than the machine you installed it on: privileged mounts
and host networking behave differently or not at all. It is not recommended as
the host. A Windows machine is a perfectly good **server to add** to a Polaris
running elsewhere, managed from it like any other.

## Contributing

The monorepo layout, the development loop, how to build and test the dashboard
and the Rust components, and the release flow all live in the
[developer guide](docs/developers/README.md).

## License

[Apache-2.0](LICENSE).
