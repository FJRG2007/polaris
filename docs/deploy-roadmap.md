# Deploy — feature roadmap (parity with Railway / Coolify / Dokploy)

Backlog of everything the reference PaaS tools (Railway, Coolify, Dokploy, OneShip)
offer that Polaris Deploy should have. This is intentionally larger than one work
session — pick items top-down by priority. Keep it updated as items land.

**Status:** ✅ done · 🟡 partial · ⬜ todo
**Priority:** P0 (core) · P1 (high) · P2 (nice-to-have)

Reference clones live in `references/repos/` (coolify, dokploy, openship) — gitignored.

---

## 1. Git integration & CI/CD (auto-deploy) — the current focus

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Connect GitHub (PAT) | ✅ | P0 | Integrations > GitHub |
| Connect GitHub (App, manifest flow) | ✅ | P0 | one-click create + install |
| Searchable, cached repo picker + refresh | ✅ | P0 | private lock on the right |
| Auto-detect Dockerfile | ✅ | P0 | via git tree API |
| Framework detection (Next.js, Python, Go, …) | ✅ | P1 | picks the default builder |
| Build without a Dockerfile (Nixpacks) | ✅ | P0 | hostd runs `nixpacks build` |
| **Auto-deploy on push (webhook)** | 🟡 | P0 | receiver + filters this session; needs a public URL |
| **Auto-deploy on push (polling fallback)** | ⬜ | P0 | LAN installs can't receive webhooks — poll the branch head |
| **Branch filter (include/exclude)** | 🟡 | P0 | deploy only from configured branch(es) |
| **Commit-message filter (e.g. `build:` anywhere)** | 🟡 | P1 | skip/require a substring or regex |
| **Path filter (monorepo: only deploy on changes under a dir)** | ⬜ | P1 | Railway "root directory" + watch paths |
| Deploy on PR / preview environments | ⬜ | P1 | ephemeral env per PR, auto-teardown on close |
| Manual "Deploy" + "Redeploy last" | ✅ | P0 | |
| Rollback to a previous deployment | 🟡 | P0 | deployments recorded; no one-click rollback UI |
| Build cache reuse across deploys | ⬜ | P1 | Docker layer / Nixpacks cache on the target |
| Commit SHA / message shown on a deployment | 🟡 | P1 | capture head commit at deploy time |
| GitLab / Bitbucket / Gitea sources | ⬜ | P2 | generalize the git provider seam |
| Deploy from a Docker Compose file in the repo | ⬜ | P1 | `compose` build method exists; not wired |
| Watch/auto-rebuild on base-image update | ⬜ | P2 | Coolify-style image-update checks |

### Auto-deploy design (being implemented incrementally)

1. **Per-application settings:** `autoDeploy` (bool), `deployBranch` (which branch
   triggers), `commitFilter` (substring/`regex:` the head commit message must
   match, e.g. `build:`), later `watchPaths`.
2. **Webhook receiver** `POST /api/deploy/github/webhook`: verify the HMAC-SHA256
   signature with the GitHub App's stored webhook secret, parse the `push` event
   (repo full name, `ref` → branch, `head_commit.message`), find applications whose
   `sourceConfig.repoUrl` matches and whose branch + commit filters pass, and
   enqueue a deploy for each. Needs the App's webhooks **active** and the instance
   reachable from GitHub (public domain) — see the free-subdomain/public-IP work in
   `domain-service`.
3. **Polling fallback** (LAN installs): a periodic job compares each auto-deploy
   app's tracked branch head SHA (GitHub API) against the last deployed SHA and
   deploys on change. Outbound-only, so it works behind NAT. Store `lastDeployedSha`.
4. **Filters:** branch must equal `deployBranch` (or the repo default); the commit
   message must contain `commitFilter` (or match `regex:...`); optional path filter.

---

## 2. Sources & builders

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Deploy a public/private Docker image | ✅ | P0 | registry examples in the UI |
| Private registry credentials + `docker login` | ✅ | P0 | per-host, encrypted |
| Build from Git + Dockerfile | ✅ | P0 | |
| Build from Git + Nixpacks | ✅ | P0 | |
| Buildpacks (Heroku/Paketo) builder | ⬜ | P2 | `buildpacks` method stub exists |
| Static-site builder (output dir → nginx) | ⬜ | P1 | `static` method stub exists |
| Dockerfile target stage / build args UI | 🟡 | P1 | `buildConfig` column exists; no UI |
| Custom install/build/start commands (Nixpacks overrides) | ⬜ | P1 | Railway lets you override the plan |
| Custom root directory (monorepo subdir build) | ⬜ | P1 | |
| Pre-deploy / release command (migrations) | ⬜ | P1 | run a one-off before the new version goes live |

## 3. Networking, domains & proxy

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Auto free subdomain (sslip.io/traefik.me) | ✅ | P0 | |
| Custom domain + Let's Encrypt | ✅ | P0 | Traefik |
| **Service-to-service private networking (the canvas links)** | ⬜ | P0 | canvas draws links; not wired to a shared network yet |
| Internal DNS names between services | ⬜ | P0 | reach `postgres` by name |
| Multiple domains per service | 🟡 | P1 | model allows; UI adds one at a time |
| Redirects / path-based routing / middlewares | ⬜ | P2 | Traefik middlewares |
| TCP/UDP (non-HTTP) port exposure | ⬜ | P2 | |
| Basic-auth / IP allowlist on a route | ⬜ | P2 | |

## 4. Environments & configuration

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Multiple environments (production, development, …) | ✅ | P0 | switcher + create/delete |
| Env vars (plain + secret, encrypted) | 🟡 | P0 | model + merge exist; no editor UI |
| Shared/environment-level variables + references | ⬜ | P1 | `${{shared.X}}` style references |
| Copy/clone an environment | ⬜ | P2 | |
| `.env` bulk import/export | ⬜ | P1 | |
| Config-as-code (railway.json / polaris.json in repo) | ⬜ | P2 | |
| Sealed/secret files mounted into the container | ⬜ | P2 | |

## 5. Observability

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Live deploy/build logs | ✅ | P0 | polling viewer |
| Runtime container logs (stream/follow) | 🟡 | P0 | ports support it; no dedicated UI |
| CPU/mem metrics badge | ✅ | P1 | |
| Historical metrics graphs | ⬜ | P1 | |
| Health checks + status | 🟡 | P0 | spec supports; surface state |
| Crash/restart detection + alerts | ⬜ | P1 | |
| Per-service "activity"/audit timeline | ⬜ | P2 | |

## 6. Scaling & runtime

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Compose runtime | ✅ | P0 | |
| Swarm runtime (replicas) | ✅ | P1 | |
| Horizontal replicas UI | 🟡 | P1 | `replicas` column; no UI control |
| Resource limits (CPU/mem) UI | ⬜ | P1 | |
| Restart policies UI | ⬜ | P2 | |
| Cron jobs / scheduled services | ⬜ | P1 | Coolify "scheduled tasks" |
| One-off jobs / run a command | 🟡 | P2 | exec exists |
| Zero-downtime / rolling deploy | 🟡 | P1 | swarm rolls; compose recreate has a gap |
| Autoscaling | ⬜ | P2 | |

## 7. Databases

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Postgres/MySQL/MariaDB/Mongo/Redis provisioning | ✅ | P0 | |
| Connection string / credentials surfaced | ⬜ | P0 | show + copy the DSN |
| Managed backups (scheduled dumps) | ⬜ | P0 | Coolify/Dokploy backups to S3 |
| Restore from backup | ⬜ | P1 | |
| DB metrics / size | ⬜ | P2 | |
| One-click DB web console | ⬜ | P2 | |
| More engines (ClickHouse, KeyDB, …) | ⬜ | P2 | |

## 8. Storage & volumes

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Named volumes | 🟡 | P0 | model supports; no UI |
| Bind mounts (confined) | 🟡 | P1 | hostd confines to volume root |
| Volume backup/restore | ⬜ | P1 | |
| Mount a config file into a container | ⬜ | P1 | |

## 9. Servers / targets (multi-host)

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Local host (hostd) target | ✅ | P0 | |
| Remote server over SSH (add/list) | ✅ | P0 | Servers app |
| Deploy to a remote server | 🟡 | P0 | SSH ports exist; exercise E2E |
| Remote terminal/file-browser/metrics | ⬜ | P1 | currently local-hostd only |
| Server resource dashboard | ⬜ | P2 | |
| Auto-install Docker on a fresh server | ⬜ | P2 | Coolify bootstrap |

## 10. Backups, templates, extras

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| One-click app templates / marketplace | ⬜ | P1 | Coolify/Railway templates |
| Deploy from a template repo | ⬜ | P1 | |
| Notifications (deploy success/fail) | 🟡 | P1 | in-app bell exists; wire deploy events |
| Slack/Discord/email/webhook notifications | ⬜ | P1 | |
| Team/RBAC on projects | 🟡 | P1 | perms exist; per-project sharing todo |
| Usage/cost estimates | ⬜ | P2 | |
| API + CLI to manage deploys | ⬜ | P1 | |
| Terraform/provider | ⬜ | P2 | |

---

## 11. CI / build-pipeline performance (this repo's own actions)

| Item | Status | Prio | Notes |
|------|--------|------|-------|
| Per-image gated jobs (skip unchanged) | ✅ | P0 | web-only push skips hostd |
| Parallel image jobs | ✅ | P0 | |
| npm-ci layer caching (manifests first) | ✅ | P1 | web image |
| **Native arm64 runners (drop QEMU for hostd)** | 🟡 | P0 | the ~7min QEMU build is the slowest step |
| Rust dependency caching in the hostd image | ⬜ | P1 | manifest-first `cargo build` |
| Skip publish when only docs/tests change | ⬜ | P2 | |

---

## Suggested order

1. Auto-deploy: settings + webhook + filters (started), then polling fallback.
2. Canvas links → real private networking + internal DNS (P0, currently visual).
3. Env-var editor UI + connection-string surfacing for DBs.
4. Managed DB backups (to S3) + restore.
5. Preview environments per PR.
6. Templates/marketplace + notifications wiring.
