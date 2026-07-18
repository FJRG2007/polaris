# Polaris Dashboard

The Polaris web control plane. A minimalist, dark, unifi.ui.com-style dashboard
that grows app by app behind a top-left app switcher. The first app is an
advanced **Drive**; future apps (Docker/Kubernetes, servers, VMs, home
automation, deploys) plug into the same shell.

This pillar is a self-contained npm-workspaces monorepo living beside the Rust
plugins. The privileged host daemon that unlocks host access lives in the root
Cargo workspace as [`crates/polaris-hostd`](../crates/polaris-hostd).

## Editions

One image, two editions determined at runtime:

- **Limited** - the container alone. Cloud/API and userspace storage providers
  work (SFTP, WebDAV, S3, Synology/QNAP/TrueNAS APIs). Kernel mounts (NFS) and
  arbitrary host access are disabled and shown as "unlock host access".
- **Full** - additionally runs `polaris-hostd`, a privileged daemon that grants
  native SMB/NFS mounts, host filesystem access, Docker/Kubernetes/systemd
  control and auto-update. The edition flips to `full` only when the daemon
  actually answers with a valid token; an env var alone never unlocks it.

## Layout

```
dashboard/
├── apps/
│   ├── web/        # the dashboard (Next.js App Router)
│   ├── landing/    # marketing site (Astro)
│   └── demo/       # seeded, read-only demo of web
└── packages/
    ├── config/         # @polaris/config       edition + capability flags, env schema
    ├── db/             # @polaris/db           Prisma schema, client, migrations
    ├── core/           # @polaris/core         pure domain: schemas, CIDR, tokens, permissions
    ├── auth/           # @polaris/auth         better-auth + roles + invites
    ├── storage/        # @polaris/storage      storage-provider drivers + registry + crypto
    ├── hostd-client/   # @polaris/hostd-client typed client for polaris-hostd
    └── ui/             # @polaris/ui           self-hosted component system + shell
```

Dependency order: `config -> db -> core -> {auth, hostd-client} -> storage -> ui -> apps`.
App code owns only routing and composition; anything a second app could reuse
lives in a package.

## Development

```sh
npm install            # from this directory (dashboard/ is the workspace root)
npm run db:generate    # generate the Prisma client
npm run typecheck
npm run lint
npm run test
npm run web:dev        # start the dashboard
```

Docker, one-command install, and auto-update live in
[`docker/`](docker) and [`scripts/`](scripts). Progress is tracked in
[`ROADMAP.md`](ROADMAP.md).
