# Polaris Dashboard - coverage ledger

The web control-plane pillar. This file tracks every work unit and its status so
nothing is silently dropped. Update it as phases land.

## Architecture

A single dashboard image with two runtime editions (limited / full). The web app
(Next.js App Router) talks to shared packages behind stable contracts so the
work parallelizes cleanly. Host access in the full edition is brokered by the
privileged `crates/polaris-hostd` daemon over a unix socket with a bearer token.
See [`README.md`](README.md) and the plan for the full rationale.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 0 | Workspace scaffolding, tsconfig/prettier presets, gitignore, package skeletons | done |
| 1a | `@polaris/config` - edition + capability flags, Zod env schema | done (3 tests) |
| 1b | `@polaris/db` - Prisma schema (all models), client, PG + SQLite portable | done (schema validates, client generates, init migration laid down) |
| 1c | `@polaris/ui` - shell, theme tokens, app switcher, primitives | done (dark token system, Radix primitives, capability context) |
| 1d | `@polaris/core` - Zod schemas, CIDR, tokens, permissions, path sanitize | done (10 tests); tokens split to `@polaris/core/tokens` for client safety |
| - | Interface-freeze gate: StorageDriver, Prisma schema, hostd API v1 | done - all three frozen |
| 2a | `@polaris/auth` - better-auth + Prisma adapter, roles, invites | done: email/password, roles, first-user admin bootstrap (invites model exists; invite UI pending) |
| 2b | `@polaris/hostd-client` + `crates/polaris-hostd` | done: Rust daemon (12 tests) + TS client (health probe + mounts) |
| 2c | `@polaris/storage` - interface, registry, credential crypto, in-process drivers | done: interface + crypto + registry + local driver (5 tests); SFTP/WebDAV/S3/SMB/NFS/vendor drivers pending |
| 3 | `apps/web` skeleton - App Router, auth, app switcher, Drive shell, capabilities | done (`next build` green) |
| 4a | Drive browser - list/nav/mkdir/move/rename/delete/search | done for local driver (search UI pending) |
| 4b | hostd-routed SMB/NFS + mount lifecycle + limited-edition degradation | partial: registry routing + local-on-mount path; mount activation lifecycle (HostdClient.createMount wiring) pending |
| 4c | Chunked/resumable upload + range/streaming download | streaming upload + range download done; chunked/tus resumable UI + UploadSession wiring pending |
| 5a | Sharing - public links, password, download/expiry limits, invite users, logs | models + schemas done; endpoints + UI pending |
| 5b | File requests - token URL, anon+login upload, size/format/CIDR/expiry | models + schemas + constraint checks done; endpoints + UI pending |
| 5c | Admin - user management, roles, invites | roles/permissions engine done; admin UI pending |
| 6a | Docker - Dockerfile + compose (web + postgres + Caddy + hostd) | done (files written + syntax-validated; runtime `docker compose up` not yet exercised) |
| 6b | One-command install (install.sh / install.ps1) + auto-update | done (scripts written + syntax-validated; not yet run end-to-end) |
| 6c | Landing (Astro) + demo (seeded Next) | pending |
| 7 | GitHub Actions (CI, release, deploy, agent maintenance) | done (dashboard-ci, dashboard-release, dashboard-agent-maintenance) |

## Feature parity checklist

Drive (storage):
- [ ] Storage-provider abstraction (streaming `StorageDriver` interface)
- [ ] Drivers: local, SFTP, WebDAV, S3-compatible, SMB, NFS, Synology, QNAP, TrueNAS, UniFi UNAS
- [ ] Credential encryption at rest (envelope AES-256-GCM, key rotation)
- [ ] File browser: list, navigate, mkdir, move, rename, delete, search
- [ ] Chunked/resumable upload; range/streaming download
- [ ] hostd routing for kernel mounts (SMB/NFS) in the full edition

Sharing:
- [ ] Public share links (hashed token)
- [ ] Link password (argon2), download limit, expiration
- [ ] Invite specific users
- [ ] Access log + audit

File requests (upload-in):
- [ ] Token URL; upload with or without login
- [ ] Per-request max size, destination, allowed formats, allowed CIDRs, expiry
- [ ] Anonymous-upload hardening (streamed size limit, sniffed MIME, rate limit)

Containers app (Docker):
- [x] Secure per-install SSH access provisioning (`install.sh --ssh`, REMOTE hosts only now): unique key, forced-command `docker system dial-stdio`, `restrict` + `from=`, pinned known_hosts
- [x] Modular `@polaris/docker` connector: transports (socket / SSH / TCP) behind a `DockerRpc` seam, driver, registry (4 tests)
- [x] Containers app: host overview (CPU/mem/counts), container table with live stats, start/stop/restart; DockerConnection model
- [x] Local host with NO flags: auto-registered, reached through hostd's allowlisted `POST /v1/docker` proxy (ping/info/list/stats/start/stop/restart only) - the web container never mounts the socket. Gated on `system.manage` + full edition
- [ ] Live end-to-end run against a real Docker host (built + unit-tested; hostd proxy + local host not yet exercised on this Docker-off dev machine)
- [ ] Remote-host SSH host-key pinning per connection, TLS-cert/pasted-key credential paths (encryption wired; UI present)
- [ ] Container logs, images, compose stacks, and Kubernetes (future apps)

Platform:
- [ ] User management, roles/permissions, invites
- [x] Edition/capability boundary + graceful degradation (fixed: the capability refresh loop now actually runs from `instrumentation.register()`, so the edition flips to full when hostd answers - it was never started before)
- [x] Full edition is the installer default (opt out with `install.sh --limited`): hostd runs by default so in-band updates and the local Docker host work with no flags. hostd + updater container images now build and publish (were missing entirely)
- [x] Auto-update via hostd: `POST /v1/update` runs a one-shot `polaris-updater` container that re-runs `install.sh` (git pull -> reconcile .env -> pull images -> migrate -> redeploy -> verify)
- [ ] Digest/signature-verified image provenance for updates (still trusts the `latest` tag, as before - pre-existing accepted risk)
- [ ] CI / release / deploy / agent-maintenance workflows
- [ ] Marketing landing + demo

## Notes / deliberate decisions

- Polaris is a control plane, not a file mirror: the browser lists remote trees
  live via the driver. `Node` rows exist only for objects Polaris must track
  (shared or requested items), avoiding an unwinnable sync problem.
- Prisma schema stays SQLite-portable (no Postgres-only types/enums/arrays; JSON
  stored as stringified `String`; byte sizes as `BigInt`).
- Accepted dependency risk: two moderate advisories remain against `postcss@8.4.31`
  bundled inside Next.js's private build toolchain (an XSS-in-CSS-stringify path
  that our app never exercises - build-time only, no untrusted CSS). The direct
  postcss is pinned to a patched version via an npm override; npm cannot rewrite
  Next's internal copy, and the only "fix" npm offers is an absurd next@9
  downgrade. Re-evaluate when Next bumps its bundled postcss.
