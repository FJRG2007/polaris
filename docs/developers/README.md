# Developer guide

Polaris is a monorepo with two pillars:

- **`dashboard/`** - the web control plane: an npm-workspaces monorepo (Next.js
  app, shared `@polaris/*` packages). This is the main product surface.
- **`plugins/`** + **`crates/`** - the Rust side: Home Assistant integrations
  and their on-device agents, plus the privileged `polaris-hostd` host daemon.
  These form one Cargo workspace.

The two are independent: you can work on the dashboard without a Rust toolchain,
and on a plugin without touching Node.

## Layout

```
polaris/
├── Cargo.toml                 # Rust workspace
├── rust-toolchain.toml        # pinned toolchain + musl cross targets
├── crates/
│   └── polaris-hostd/         # privileged host daemon (full edition)
├── plugins/
│   └── unifi-unas/            # a plugin: UniFi UNAS monitoring + fan control
│       ├── core/              # polaris-unas-core   (Rust lib, reusable)
│       ├── agent/             # polaris-unas-agent  (Rust bin, on-device)
│       └── homeassistant/     # HACS-installable integration (Python glue)
└── dashboard/
    ├── apps/web/              # the dashboard (Next.js App Router)
    ├── apps/landing, apps/demo
    ├── mdns/                  # polaris.local responder
    ├── packages/              # @polaris/{config,core,db,auth,storage,ui,...}
    ├── docker/                # Dockerfile, compose, Caddy
    └── scripts/               # install / update / dev
```

## Dashboard

Everything runs from the `dashboard/` workspace root.

```sh
cd dashboard
npm install

# Run it locally with no containers (SQLite, generates a dev env):
npm run dev:up            # http://localhost:3000

# Or the full stack in Docker:
docker compose -f docker/docker-compose.yml up -d
```

Per-package and whole-workspace checks:

```sh
npm run typecheck         # every package + the app
npm run lint
npm run test              # vitest across packages
npm run build             # build all packages, then the app

npm run db:generate       # regenerate the Prisma client
npm run db:migrate        # apply migrations (deploy)
```

Packages depend on each other's built `dist/`, so build in dependency order
(`config -> db -> core -> {auth, hostd-client} -> storage -> ui -> apps`) or run
the workspace `build`. Progress and what's in flight is tracked in
[`../../dashboard/ROADMAP.md`](../../dashboard/ROADMAP.md).

## Rust (plugins + host daemon)

```sh
cargo test                     # run all workspace tests
cargo clippy --all-targets     # lint (CI runs it with -D warnings)
cargo fmt --check
```

Each plugin has three execution contexts that share one domain crate
(`plugins/<name>/core/`):

1. **Home Assistant process** (`homeassistant/`) - loaded in-process by HA, so
   it is Python (config flow, MQTT-backed entities, deploying the agent).
2. **On-device agent** (`agent/`) - a single static `musl` binary that replaces
   interpreted scripts and removes runtime dependencies from the device.
3. **`polaris-hostd`** (`crates/`) - the privileged daemon that unlocks the
   dashboard's full edition (native mounts, host filesystem, Docker access).

Cross-plugin Rust graduates to `crates/` only once a second consumer needs it.

## Distribution

- **Plugins** install manually from GitHub Releases: a release workflow builds
  the on-device agent and attaches an installable ZIP. See each plugin's README.
- **Dashboard** ships as a container image published to GHCR on `dashboard-v*`
  tags, alongside the `polaris-hostd` static musl binaries.

## Conventions

Double quotes, semicolons, 4-space indentation, length-sorted imports,
kebab-case file names, and LF line endings (enforced by `.gitattributes`). Code,
comments and docs are in English. No emojis outside the commit-subject type.
