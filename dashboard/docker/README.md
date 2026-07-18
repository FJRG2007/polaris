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

## Configuration

Every setting lives in `.env` (see [`.env.example`](.env.example)). Two values
must be freshly generated, never copied:

- `POLARIS_MASTER_KEY` - `openssl rand -base64 32`
- `POLARIS_AUTH_SECRET` - `openssl rand -base64 48`

Set `POLARIS_SITE_ADDRESS` to your domain for automatic HTTPS via Caddy, and
`POLARIS_APP_URL` to the origin users reach.

## Updates

```sh
./scripts/update.sh   # pull newest images, redeploy, prune old layers
```

In the full edition the daemon can also update in-band via `POST /v1/update`,
staying inside the trust boundary. Either path must verify image digest and
provenance before deploying - pin `POLARIS_IMAGE_TAG` to a released version
rather than tracking a moving `latest`.
