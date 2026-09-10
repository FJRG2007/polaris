# Deploy - feature roadmap (parity with Railway / Coolify / Dokploy / openship)

Backlog of what the reference PaaS tools offer that Polaris Deploy should have.
Statuses were checked against the code on 2026-09-10; keep them updated as items
land. What a user can find today is listed, screen by screen, on the Deploy
Capabilities page (`apps/web/src/lib/deploy/capabilities.ts`).

**Status:** done - a user can do it from the dashboard (or the CLI/API row from
there) - partial - todo.
**Priority:** P0 (core) - P1 (high) - P2 (nice-to-have)

Reference clones live in `references/repos/` (coolify, dokploy, openship) - gitignored.

---

## 1. Git integration & CI/CD

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Connect GitHub (PAT) | done | P0 | Integrations > GitHub |
| Connect GitHub (App, manifest flow) | done | P0 | one-click create + install |
| Searchable, cached repo picker + refresh | done | P0 | |
| Auto-detect Dockerfile | done | P0 | git tree API |
| Stack detection | done | P1 | Node, Python, Go, Rust, PHP, Ruby, Java, Elixir, static sites (`packages/deploy/src/detect-languages.ts`) |
| Build without a Dockerfile | done | P0 | generated Dockerfile per stack; Nixpacks kept for services already on it |
| Auto-deploy on push (webhook) | done | P0 | HMAC-verified receiver, branch and commit filters |
| Auto-deploy on push (polling fallback) | done | P0 | `lib/deploy/auto-deploy-poller.ts`, for installs GitHub cannot reach |
| Branch filter | done | P0 | tracked branch per service |
| Commit-message filter | done | P1 | substring or `regex:` |
| Path filter (watch paths) | done | P1 | monorepo services deploy only on changes under their globs |
| Preview environments per PR | done | P1 | project feature flag; torn down when the PR closes, forks skipped |
| Manual deploy + redeploy | done | P0 | |
| Rollback to a previous deployment | done | P0 | kept images, no rebuild; pinned releases |
| Build cache reuse across deploys | todo | P1 | no `--cache-from` in the builders |
| Commit SHA / message on a deployment | done | P1 | |
| GitLab / Bitbucket / Gitea sources | todo | P2 | |
| Deploy from a Docker Compose file in the repo | todo | P1 | `compose` build method is a no-op and not selectable |
| Newer base image noticed | partial | P2 | `update-scan` job reports a moved tag digest or a branch it is behind; redeploy is a press, not automatic |
| Smart fixes for failed deploys | done | P1 | likely cause read from the log, one-press fix and redeploy |
| Build on another machine / locally | done | P1 | build machine per service; `polaris deploy --local` from the CLI |
| GitHub deployments and check runs | done | P1 | reported on the commit |

## 2. Sources & builders

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Deploy a public/private Docker image | done | P0 | |
| Private registry credentials | done | P0 | per host, encrypted |
| Build from Git + Dockerfile | done | P0 | |
| Build from Git + Nixpacks | done | P0 | |
| Buildpacks (Heroku/Paketo) builder | todo | P2 | `pack build` case exists in the builders but nothing selects it |
| Static sites | done | P1 | detected and served; output directory setting |
| Dockerfile target stage / build args UI | partial | P1 | builders take `targetStage`/`buildArgs`; no field on screen |
| Custom install/build/start commands | done | P1 | plus runtime version |
| Custom root directory (monorepo) | done | P1 | |
| Settings from railway/render/netlify/vercel/Procfile/app.json | done | P2 | read when a service is created from GitHub |
| Deploy an uploaded folder | done | P1 | folder or zip, built like a repository |
| One-click templates | done | P1 | 19 apps: plain images, plus a managed database (Ghost, Umami), a companion service (Kafka) or setup run inside once serving (Gitea, FreshRSS, MinIO); ClickHouse, Convex, PostHog and Supabase are left out |
| Pre-deploy / release command (migrations) | todo | P1 | |

## 3. Networking, domains & proxy

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Free subdomain | done | P0 | |
| Custom domain + Let's Encrypt | done | P0 | or a certificate you supply |
| Wildcard certificates | done | P1 | owner domains |
| DNS records managed | done | P1 | Cloudflare zone editor |
| Private networking between services | done | P0 | per-environment network, reached by service name |
| Multiple domains per service | done | P1 | added one at a time |
| Redirects / rewrites | done | P2 | Service > Settings |
| Load balancing (copies, sticky, health) | done | P1 | |
| Weighted traffic to a kept release | done | P2 | 10% or 50%, sticky per visitor |
| TCP/UDP (non-HTTP) exposure | partial | P2 | a service's port can be opened on the machine's address; no UDP, no extra ports |
| Login required / IP allowlist on a route | done | P2 | Firewall > access rules |
| CDN | done | P2 | Cloudflare proxy, cache purged after deploys |

## 4. Environments & configuration

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Multiple environments | done | P0 | |
| Env vars (plain + secret, encrypted) | done | P0 | reveals recorded in the audit log |
| Shared variables + references | done | P1 | `${{shared.X}}`, `${{postgres.DATABASE_URL}}` |
| Copy/clone an environment | done | P2 | |
| `.env` bulk import/export | partial | P1 | paste or upload; no export |
| Sealed/secret files mounted into the container | todo | P2 | |

## 5. Observability

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Live deploy/build logs | done | P0 | step progress over the log |
| Runtime logs (stream, search) | done | P0 | project-wide stream kept a week |
| CPU/mem/network/disk metrics with history | done | P1 | |
| Health checks + status | done | P0 | |
| Alarms (health, spikes, outages, disk, network) | done | P1 | Watch > Alarms |
| Crash-loop detection for services | partial | P1 | outages alarm; no restart-loop signal like game servers have |
| Per-service activity timeline | done | P2 | |

## 6. Scaling & runtime

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Compose runtime | done | P0 | |
| Swarm runtime | done | P1 | |
| Copies (replicas) UI | done | P1 | up to ten |
| Autoscaling | done | P2 | follows CPU between a minimum and maximum |
| Resource limits (CPU/mem) UI | done | P1 | services and databases |
| Sleep when idle | done | P2 | wakes on the next visit; one local copy only |
| Restart policies UI | todo | P2 | |
| Scheduled jobs | done | P1 | Service > Cron |
| One-off command | done | P2 | Service > Console |
| Zero-downtime deploys | partial | P1 | swarm starts first and rolls back; compose changes over for a service with no published port or volume, every copy, on this host or on a server whose edge takes pushed routes; a published port, a volume, a compose file, a second host port or a label-only server edge are recreated |

## 7. Databases

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Postgres/MySQL/MariaDB/Mongo/Redis | done | P0 | |
| Redis Cluster | partial | P2 | 3/5/7 masters with one replica each, on one server; nodes in `REDIS_CLUSTER_NODES`; backups take every master's RDB; restore, upgrade and copy-in refuse a cluster; no resharding or nodes spread over servers |
| Connection string surfaced | done | P0 | |
| Scheduled backups | done | P0 | encrypted before they leave |
| Restore from backup | done | P1 | safety copy first |
| Upgrades with a way back, PostgreSQL point-in-time recovery | done | P1 | |
| DB metrics / size | done | P2 | |
| DB web console | done | P2 | |
| Object storage (S3-compatible) | done | P1 | |
| More engines (ClickHouse, KeyDB, ...) | todo | P2 | |

## 8. Storage & volumes

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Named volumes | done | P0 | |
| Bind mounts (confined) | done | P1 | |
| Volume backup/restore | done | P1 | |
| Mount a config file into a container | todo | P1 | |

## 9. Servers / targets

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Local host (hostd) target | done | P0 | |
| Remote server over SSH | done | P0 | one-command enrollment |
| Deploy to a remote server | done | P0 | |
| Remote terminal / files / metrics | done | P1 | |
| Server resource dashboard | done | P2 | |
| Auto-install Docker on a fresh server | todo | P2 | enrollment only warns when Docker is missing |
| Move a whole instance to another machine | done | P2 | sealed export and import |

## 10. Extras

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Notifications on deploy success/fail | done | P1 | |
| Slack/Discord/Teams/Telegram/email/webhook | done | P1 | |
| Team/RBAC on projects | done | P1 | capability sets, per-environment scope, expiry |
| Usage per project | done | P2 | |
| Cost estimates | todo | P2 | |
| API + CLI | done | P1 | `/api/v1/deploy`, `dashboard/cli` |
| Installable desktop app | done | P2 | |
| Terraform provider | todo | P2 | |

---

## 11. CI / build-pipeline performance (this repo's own actions)

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Per-image gated jobs (skip unchanged) | done | P0 | |
| Parallel image jobs | done | P0 | |
| npm-ci layer caching | done | P1 | |
| Native arm64 runners for hostd | done | P0 | `ubuntu-24.04-arm` |
| Rust dependency caching in the hostd image | todo | P1 | Dockerfile copies everything before `cargo build` |
| Skip publish when only tests change | partial | P2 | docs-only pushes are skipped already |

---

## Suggested order

1. Zero-downtime for services with a published port or a volume.
2. Pre-deploy command, then build cache reuse.
3. Deploy from a Compose file in the repository.
4. Target stage / build args fields, `.env` export, restart policy.
5. GitLab and Gitea sources.
