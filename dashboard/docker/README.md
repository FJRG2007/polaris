# Polaris Docker

Run the dashboard with Docker Compose. One image, two editions.

## Editions

- **Limited** (default) - `postgres` + `web` + `caddy`. Cloud/API and userspace
  storage providers work. Kernel mounts and host access are disabled.
- **Full** - adds the privileged `hostd` daemon, which unlocks SMB/NFS mounts,
  host filesystem access, container/systemd control and daemon-driven updates.
  The edition flips to `full` only when the daemon answers over the shared
  socket; the profile alone does not unlock it.

## Run

```sh
cp .env.example .env      # then generate the secrets it flags
docker compose up -d                 # limited
docker compose --profile full up -d  # full (starts hostd)
```

Or use the one-command installer, which generates `.env` for you:

```sh
curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.sh | sh
curl -fsSL .../install.sh | sh -s -- --full   # full edition
```

Windows: `irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.ps1 | iex`.

## Docker over SSH (Containers app)

So the container can view and manage the host's containers without mounting the
docker socket, the installer can provision a dedicated SSH access to the host
Engine:

```sh
curl -fsSL .../install.sh | sh -s -- --ssh
```

This runs [`scripts/setup-ssh-access.sh`](../scripts/setup-ssh-access.sh), which:

- generates a unique ed25519 key under `secrets/ssh/` (0600, never committed),
- authorizes it with a **forced command** `docker system dial-stdio` plus
  `restrict` and a source `from="..."` allowlist - the key can only talk to the
  Docker API, not open a shell or forward ports,
- pins the host's SSH host key into `known_hosts` (no blind trust-on-first-use),
- writes the `POLARIS_SSH_*` values into `.env`.

Compose mounts the key read-only at `/run/polaris-ssh` and adds a
`host.docker.internal` host entry so the connector reaches the host on Linux.

Point `POLARIS_SSH_USER` at a dedicated account in the `docker` group - the key
grants Docker access, which is root-equivalent on the host. Override the target
with `POLARIS_SSH_USER`, `POLARIS_SSH_HOST`, or `POLARIS_SSH_FROM` before running.

## Local access (polaris.local)

Like Home Assistant's `homeassistant.local`, the stack advertises itself on the
local network so you can reach it by name instead of an IP:

- **`polaris.local`** - resolved LAN-wide by the `mdns` service (mDNS/zeroconf),
  so any phone or laptop on the network reaches `http://polaris.local`.
- **`polaris`** - the installer adds a `127.0.0.1 polaris polaris.local` hosts
  entry on the machine running Polaris, so the local host resolves it too.

mDNS needs the host network, so the `mdns` service uses `network_mode: host`;
this works on Linux and WSL. Docker Desktop (macOS/Windows) restricts host
networking, so there `polaris.local` relies on the hosts-file entry on the local
machine. Change the advertised name with `POLARIS_MDNS_HOSTNAME`. Caddy serves
these names over plain HTTP (a `.local` name cannot get a public certificate),
and both are already trusted origins for authentication.

## Configuration

Every setting lives in `.env` (see [`.env.example`](.env.example)). Two values
must be freshly generated, never copied:

- `POLARIS_MASTER_KEY` - `openssl rand -base64 32`
- `POLARIS_AUTH_SECRET` - `openssl rand -base64 48`

Set `POLARIS_SITE_ADDRESS` to your domain for automatic HTTPS via Caddy, and
`POLARIS_APP_URL` to the origin users reach.

## Updates

Updating is the same one command as installing - re-run it and it pulls the
latest source, adds any new settings to `.env` for you, rebuilds, and restarts
(applying migrations). Nothing else to manage.

On the rolling `latest` tag, an update first waits (bounded to ~20 min, then
deploys anyway) for the registry's web image to be rebuilt from the source it
just pulled - CI takes a few minutes to publish `:latest` after a change lands.
This keeps the running build from landing a commit behind `HEAD`, which is what
left the dashboard showing "update available" after an update. A first install
and a pinned `POLARIS_IMAGE_TAG` both skip the wait.

```sh
curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.sh | sh
# or, from a checkout:
./scripts/update.sh
```

In the full edition the daemon can also update in-band via `POST /v1/update`,
staying inside the trust boundary. Either path must verify image digest and
provenance before deploying - pin `POLARIS_IMAGE_TAG` to a released version
rather than tracking a moving `latest`.
