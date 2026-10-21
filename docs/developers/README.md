# Developer guide

Polaris is a monorepo with three pillars:

- **`dashboard/`** - the web control plane: an npm-workspaces monorepo (Next.js
  app, shared `@polaris/*` packages). This is the main product surface.
- **`crates/`** - the Rust side: the privileged `polaris-hostd` host daemon,
  in one Cargo workspace.
- **`desktop/`** - the native desktop app (Electron): its own npm workspace,
  independent of `dashboard/`. See [`../../desktop/README.md`](../../desktop/README.md).

The three are independent: you can work on the dashboard without a Rust
toolchain, on the host daemon without touching Node, and on the desktop app
without either.

## Layout

```
polaris/
├── Cargo.toml                 # Rust workspace
├── rust-toolchain.toml        # pinned toolchain + musl cross targets
├── crates/
│   └── polaris-hostd/         # privileged host daemon (full edition)
├── dashboard/
│   ├── apps/web/              # the dashboard (Next.js App Router)
│   ├── apps/places/           # an installable app, kept out of core (see docs/installable-apps-plan.md)
│   ├── apps/landing, apps/demo
│   ├── mdns/                  # polaris.local responder
│   ├── packages/              # @polaris/{config,core,db,auth,storage,ui,app-host,...}
│   ├── docker/                # Dockerfile, compose, Caddy
│   └── scripts/               # install / update / dev
└── desktop/                   # native desktop app (Electron, own npm workspace)
```

## Dashboard

Everything runs from the `dashboard/` workspace root.

npm, not pnpm or yarn: the lockfile and the workspace layout are npm's, and the
scripts resolve their tools out of it.

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

Packages depend on each other's built `dist/`. `npm run build:packages` reads that
order out of the manifests and builds everything a wave at a time, in parallel
within each wave, so building one by one is never necessary. Progress and what's in
flight is tracked in [`../../dashboard/ROADMAP.md`](../../dashboard/ROADMAP.md).

Adding an MCP tool, a `polaris_search` provider or a scope category:
[`mcp.md`](mcp.md).

## Rust (host daemon)

```sh
cargo test                     # run all workspace tests
cargo clippy --all-targets     # lint (CI runs it with -D warnings)
cargo fmt --check
```

`polaris-hostd` (`crates/`) is the privileged daemon that unlocks the
dashboard's full edition (native mounts, host filesystem, Docker access).

## Desktop app

Its own npm workspace, not part of the `dashboard/` one. See
[`../../desktop/README.md`](../../desktop/README.md) for development and release
commands.

## Distribution

- **Dashboard** ships as a container image published to GHCR on `dashboard-v*`
  tags, alongside the `polaris-hostd` static musl binaries.
- **Desktop app** ships as platform installers attached to a GitHub release on
  `desktop-v*` tags (`.github/workflows/desktop.yml`). See
  [`../../desktop/README.md`](../../desktop/README.md).
- **Stream Deck plugin** ships as a `.streamDeckPlugin` file attached to a
  `streamdeck-v*` release, cut by itself whenever a push to `main` changes what
  the plugin ships (`.github/workflows/streamdeck.yml`). The Elgato Marketplace
  listing is uploaded by hand: [`../streamdeck-publishing.md`](../streamdeck-publishing.md).

## Conventions

Double quotes, semicolons, 4-space indentation, length-sorted imports,
kebab-case file names, and LF line endings (enforced by `.gitattributes`). Code,
comments and docs are in English. No emojis outside the commit-subject type.
