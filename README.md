<div align="center">
  <h1>Polaris</h1>
  <h3>Your home lab, one control plane.</h3>
  <img alt="License" src="https://img.shields.io/badge/License-Apache--2.0-blue?style=for-the-badge"/>
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white"/>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white"/>
  <br />
  <br />
  <a href="#install">Install</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#usage">Usage</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="docs/developers/README.md">Developers</a>
  <hr />
</div>

Polaris is a self-hosted dashboard for everything in your home lab. It starts
with an advanced **Drive** - browse, upload, download and share files across any
NAS - and a **Containers** app to monitor and manage Docker. A single minimalist,
dark interface with a top-left app switcher, ready to grow into servers, VMs and
home automation.

Polaris runs in Docker and reaches out from there: native mounts, the host's own
Docker engine, and the machines you enrol over SSH are all managed from the one
container.

## Install

One command. It brings up the whole stack - dashboard, database, reverse proxy
and the privileged host daemon - generates its secrets, and needs no flags:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.ps1 | iex
```

Prefer to do it by hand? Clone the repo and run Compose directly:

```bash
git clone https://github.com/FJRG2007/polaris.git
cd polaris/dashboard/docker
cp .env.example .env                  # then set the two secrets it flags
docker compose --profile full up -d
```

Updating is one command: `./dashboard/scripts/update.sh`, and the dashboard has a
button for it.

## Usage

Once it is up, open the dashboard and create your account - **the first account
becomes the administrator**.

**Reach it by name**, Home-Assistant style: the stack advertises itself over mDNS,
so any device on your network can open **`http://polaris.local`**, and the machine
running Polaris also resolves bare **`http://polaris`**.

- **Drive** - add a storage connection (a local folder or a NAS) and browse it.
  Upload and download stream straight through, so multi-gigabyte files never
  buffer. Connect any NAS - local, SFTP, WebDAV, S3-compatible, SMB/NFS, and
  vendor APIs (Synology, QNAP, TrueNAS, UniFi UNAS).
- **Containers** - add a Docker host (the local socket, a remote host over SSH,
  or TCP/TLS) and see a live overview of container CPU and memory, with
  start/stop/restart controls.
- **Users** - invite people and assign roles; every action is authorized on the
  server.

What is built versus in progress is tracked in
[`dashboard/ROADMAP.md`](dashboard/ROADMAP.md).

## Requirements

[Docker Engine](https://docs.docker.com/engine/install/) with the Compose v2
plugin. That's it. For local development without containers, see the
[developer guide](docs/developers/README.md).

## Contributing

The monorepo layout, the development loop, how to build and test the dashboard
and the Rust components, and the release flow all live in the
[developer guide](docs/developers/README.md).

## License

[Apache-2.0](LICENSE).
