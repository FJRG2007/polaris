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
| 1c | `@polaris/ui` - shell, theme tokens, app switcher, primitives | pending |
| 1d | `@polaris/core` - Zod schemas, CIDR, tokens, permissions, path sanitize | done (10 tests) |
| - | Interface-freeze gate: StorageDriver, Prisma schema, hostd API v1 | StorageDriver + Prisma frozen; hostd API in progress |
| 2a | `@polaris/auth` - better-auth + Prisma adapter, roles, invites | pending |
| 2b | `@polaris/hostd-client` + `crates/polaris-hostd` skeleton | in progress (Rust daemon delegated) |
| 2c | `@polaris/storage` - interface, registry, credential crypto, in-process drivers | done: interface + crypto + registry + local driver (5 tests); other drivers pending |
| 3 | `apps/web` skeleton - App Router, auth, app switcher, Drive shell, capabilities | pending |
| 4a | Drive browser - list/nav/mkdir/move/rename/delete/search | pending |
| 4b | hostd-routed SMB/NFS + mount lifecycle + limited-edition degradation | pending |
| 4c | Chunked/resumable upload + range/streaming download | pending |
| 5a | Sharing - public links, password, download/expiry limits, invite users, logs | pending |
| 5b | File requests - token URL, anon+login upload, size/format/CIDR/expiry | pending |
| 5c | Admin - user management, roles, invites | pending |
| 6a | Docker - Dockerfile + compose (web + postgres + Caddy + hostd) | pending |
| 6b | One-command install (install.sh / install.ps1) + auto-update | pending |
| 6c | Landing (Astro) + demo (seeded Next) | pending |
| 7 | GitHub Actions (CI, release, deploy, agent maintenance) | pending |

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

Platform:
- [ ] User management, roles/permissions, invites
- [ ] Edition/capability boundary + graceful degradation
- [ ] Docker Compose stack + one-command install
- [ ] Auto-update (digest-verified, via hostd)
- [ ] CI / release / deploy / agent-maintenance workflows
- [ ] Marketing landing + demo

## Notes / deliberate decisions

- Polaris is a control plane, not a file mirror: the browser lists remote trees
  live via the driver. `Node` rows exist only for objects Polaris must track
  (shared or requested items), avoiding an unwinnable sync problem.
- Prisma schema stays SQLite-portable (no Postgres-only types/enums/arrays; JSON
  stored as stringified `String`; byte sizes as `BigInt`).
