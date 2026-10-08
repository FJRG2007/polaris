# Deploy - feature roadmap (parity with Railway / Coolify / Dokploy / openship)

Backlog of what the reference PaaS tools offer that Polaris Deploy should have.
Statuses were checked against the code on 2026-10-02; keep them updated as items
land.

**Status:** done - a user can do it from the dashboard (or the CLI/API row from
there) - partial - todo.
**Priority:** P0 (core) - P1 (high) - P2 (nice-to-have)

Reference clones live in `references/repos/` (coolify, dokploy, openship) - gitignored.

---

## 1. Git integration & CI/CD

| Item                                          | Status  | Prio | Notes                                                                                                                                                 |
| --------------------------------------------- | ------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect GitHub (PAT)                          | done    | P0   | Integrations > GitHub                                                                                                                                 |
| Connect GitHub (App, manifest flow)           | done    | P0   | one-click create + install                                                                                                                            |
| Searchable, cached repo picker + refresh      | done    | P0   |                                                                                                                                                       |
| Auto-detect Dockerfile                        | done    | P0   | git tree API                                                                                                                                          |
| Stack detection                               | done    | P1   | Node, Python, Go, Rust, PHP, Ruby, Java, Elixir, static sites (`packages/deploy/src/detect-languages.ts`)                                             |
| Build without a Dockerfile                    | done    | P0   | generated Dockerfile per stack; Nixpacks kept for services already on it                                                                              |
| Auto-deploy on push (webhook)                 | done    | P0   | HMAC-verified receiver, branch and commit filters                                                                                                     |
| Auto-deploy on push (polling fallback)        | done    | P0   | `lib/deploy/auto-deploy-poller.ts`, for installs GitHub cannot reach                                                                                  |
| Branch filter                                 | done    | P0   | tracked branch per service                                                                                                                            |
| Commit-message filter                         | done    | P1   | substring or `regex:`                                                                                                                                 |
| Path filter (watch paths)                     | done    | P1   | monorepo services deploy only on changes under their globs                                                                                            |
| Preview environments per PR                   | done    | P1   | project feature flag; torn down when the PR closes, forks skipped                                                                                     |
| Manual deploy + redeploy                      | done    | P0   |                                                                                                                                                       |
| Rollback to a previous deployment             | done    | P0   | kept images, no rebuild; pinned releases                                                                                                              |
| Build cache reuse across deploys              | todo    | P1   | no `--cache-from` in the builders                                                                                                                     |
| Commit SHA / message on a deployment          | done    | P1   |                                                                                                                                                       |
| GitLab / Bitbucket / Gitea sources            | todo    | P2   |                                                                                                                                                       |
| Deploy from a Docker Compose file in the repo | todo    | P1   | `compose` build method is a no-op and not selectable                                                                                                  |
| Newer base image noticed                      | partial | P2   | `update-scan` job reports a moved tag digest or a branch it is behind; redeploy is a press, not automatic                                             |
| Smart fixes for failed deploys                | done    | P1   | likely cause read from the log, one-press fix and redeploy                                                                                            |
| Build on another machine / locally            | done    | P1   | build machine per service, or a runner pool followed by machine; `polaris deploy --local` from the CLI; build machine kept per deployment (`builtOn`) |
| GitHub deployments and check runs             | done    | P1   | reported on the commit                                                                                                                                |

## 2. Sources & builders

| Item                                                          | Status  | Prio | Notes                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy a public/private Docker image                          | done    | P0   |                                                                                                                                                                                                             |
| Private registry credentials                                  | done    | P0   | per host, encrypted                                                                                                                                                                                         |
| Build from Git + Dockerfile                                   | done    | P0   |                                                                                                                                                                                                             |
| Build from Git + Nixpacks                                     | done    | P0   |                                                                                                                                                                                                             |
| Buildpacks (Heroku/Paketo) builder                            | todo    | P2   | `pack build` case exists in the builders but nothing selects it                                                                                                                                             |
| Static sites                                                  | done    | P1   | detected and served; output directory setting                                                                                                                                                               |
| Dockerfile target stage / build args UI                       | partial | P1   | builders take `targetStage`/`buildArgs`; no field on screen                                                                                                                                                 |
| Custom install/build/start commands                           | done    | P1   | plus runtime version                                                                                                                                                                                        |
| Custom root directory (monorepo)                              | done    | P1   |                                                                                                                                                                                                             |
| Settings from railway/render/netlify/vercel/Procfile/app.json | done    | P2   | read when a service is created from GitHub                                                                                                                                                                  |
| Deploy an uploaded folder                                     | done    | P1   | folder or zip, built like a repository                                                                                                                                                                      |
| One-click templates                                           | done    | P1   | 19 apps: plain images, plus a managed database (Ghost, Umami), a companion service (Kafka) or setup run inside once serving (Gitea, FreshRSS, MinIO); ClickHouse, Convex, PostHog and Supabase are left out |
| Pre-deploy / release command (migrations)                     | todo    | P1   |                                                                                                                                                                                                             |

## 3. Networking, domains & proxy

| Item                                     | Status | Prio | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free subdomain                           | done   | P0   | generated name editable in place, checked for availability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Custom domain + Let's Encrypt            | done   | P0   | or a certificate you supply; issued keys are ECDSA (EC256), like Railway                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Wildcard certificates                    | done   | P1   | owner domains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DNS records managed                      | done   | P1   | Cloudflare zone editor; a custom domain's panel reads its DNS live and tells a Cloudflare-proxied record from one pointed elsewhere                                                                                                                                                                                                                                                                                                                                                                                                            |
| Private networking between services      | done   | P0   | Railway-style: each service answers to `<name>.polaris.internal` and its bare name on a network of its own (dual stack where the engine gives it one), port-less via a port-80 forwarder; editable endpoint name with an availability check and a 7-day grace period for the old one, extra aliases; `POLARIS_PRIVATE_DOMAIN` and service variable references follow renames; opt-in links (up to 64 per service, compose targets only) let one service of another project on the same server call it by name, closed at once from either side |
| Multiple domains per service             | done   | P1   | added one at a time; each domain can pin its own target port (Railway's per-domain port), independent of the service's own                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Redirects / rewrites                     | done   | P2   | Service > Settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Load balancing (copies, sticky, health)  | done   | P1   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Weighted traffic to a kept release       | done   | P2   | 10% or 50%, sticky per visitor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| TCP/UDP (non-HTTP) exposure              | done   | P2   | up to 8 raw TCP proxies per service, each a container port published on a public port from a dedicated range; still no UDP                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Login required / IP allowlist on a route | done   | P2   | Firewall > access rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| CDN                                      | done   | P2   | Cloudflare proxy, cache purged after deploys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 4. Environments & configuration

| Item                                           | Status  | Prio | Notes                                         |
| ---------------------------------------------- | ------- | ---- | --------------------------------------------- |
| Multiple environments                          | done    | P0   |                                               |
| Env vars (plain + secret, encrypted)           | done    | P0   | reveals recorded in the audit log             |
| Shared variables + references                  | done    | P1   | `${{shared.X}}`, `${{postgres.DATABASE_URL}}` |
| Copy/clone an environment                      | done    | P2   |                                               |
| `.env` bulk import/export                      | partial | P1   | paste or upload; no export                    |
| Sealed/secret files mounted into the container | todo    | P2   |                                               |

## 5. Observability

| Item                                            | Status  | Prio | Notes                                                        |
| ----------------------------------------------- | ------- | ---- | ------------------------------------------------------------ |
| Live deploy/build logs                          | done    | P0   | step progress over the log                                   |
| Runtime logs (stream, search)                   | done    | P0   | project-wide stream kept a week                              |
| CPU/mem/network/disk metrics with history       | done    | P1   |                                                              |
| Health checks + status                          | done    | P0   |                                                              |
| Alarms (health, spikes, outages, disk, network) | done    | P1   | Watch > Alarms                                               |
| Crash-loop detection for services               | partial | P1   | outages alarm; no restart-loop signal like game servers have |
| Per-service activity timeline                   | done    | P2   |                                                              |

## 6. Scaling & runtime

| Item                         | Status  | Prio | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose runtime              | done    | P0   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Swarm runtime                | done    | P1   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Copies (replicas) UI         | done    | P1   | up to ten                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Autoscaling                  | done    | P2   | follows CPU, and optionally requests per copy, between a minimum and maximum; ten idle minutes drop it straight to the fewest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Resource limits (CPU/mem) UI | done    | P1   | services and databases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Sleep when idle              | done    | P2   | wakes on the next visit; one local copy only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Restart policies UI          | todo    | P2   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Scheduled jobs               | done    | P1   | Service > Cron                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| One-off command              | done    | P2   | Service > Console                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Zero-downtime deploys        | partial | P1   | swarm starts first and rolls back; compose starts the new release beside the old one, gates the switch on it passing its healthcheck and opening its port (`waitUntilListening`), then writes the edge to the new release and drains the old one - for a service with no published port, no second host port, not a compose file of the owner's own, on this host or a server whose edge takes pushed routes; a service with volumes opts in per-service (`overlapVolumes`) and still restarts in place once more after a volume was just added; a published port, a compose file, a second host port, a label-only server edge, or volumes left off restart in place, each reason shown on the service's Deploys section |

## 7. Databases

| Item                                                        | Status  | Prio | Notes                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres/MySQL/MariaDB/Mongo/Redis                          | done    | P0   |                                                                                                                                                                                                                |
| Redis Cluster                                               | partial | P2   | 3/5/7 masters with one replica each, on one server; nodes in `REDIS_CLUSTER_NODES`; backups take every master's RDB; restore, upgrade and copy-in refuse a cluster; no resharding or nodes spread over servers |
| Connection string surfaced                                  | done    | P0   | Connect tab: private `${{name.DATABASE_URL}}` reference plus host/port/url, a masked public URL once a port is published, and the matching client command                                                      |
| Scheduled backups                                           | done    | P0   | encrypted before they leave                                                                                                                                                                                    |
| Restore from backup                                         | done    | P1   | safety copy first                                                                                                                                                                                              |
| Upgrades with a way back, PostgreSQL point-in-time recovery | done    | P1   |                                                                                                                                                                                                                |
| MongoDB replica sets (3 or 5 members)                       | done    | P1   | one server; keyfile auth; backups from a secondary; rolling upgrades                                                                                                                                           |
| MongoDB sharded clusters                                    | partial | P2   | config set of 3, 2-4 shards of 3, a router; backups and upgrades refused, not yet offered                                                                                                                      |
| MySQL read replicas (1-2, GTID)                             | done    | P2   | read URI on the reference; MariaDB replicas not offered                                                                                                                                                        |
| Replica members across several servers                      | todo    | P2   | every member runs on the database's one server today                                                                                                                                                           |
| DB metrics / size                                           | done    | P2   | Databases app shows live stats; Deploy's Stats tab adds a cached report - sizes, connections, vacuum, indexes, statement stats                                                                                 |
| DB web console                                              | done    | P2   | Database tab on the service: Data is the Databases app's workbench bound to the instance - browse, run a statement, create a table, edit or remove rows; opens read-only, confirmed per visit                  |
| Object storage (S3-compatible)                              | done    | P1   |                                                                                                                                                                                                                |
| More engines (ClickHouse, KeyDB, ...)                       | todo    | P2   |                                                                                                                                                                                                                |

## 8. Storage & volumes

| Item                                 | Status | Prio | Notes |
| ------------------------------------ | ------ | ---- | ----- |
| Named volumes                        | done   | P0   |       |
| Bind mounts (confined)               | done   | P1   |       |
| Volume backup/restore                | done   | P1   |       |
| Mount a config file into a container | todo   | P1   |       |

## 9. Servers / targets

| Item                                     | Status | Prio | Notes                                                                                                                                                                                    |
| ---------------------------------------- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local host (hostd) target                | done   | P0   |                                                                                                                                                                                          |
| Remote server over SSH                   | done   | P0   | one-command enrollment                                                                                                                                                                   |
| Deploy to a remote server                | done   | P0   |                                                                                                                                                                                          |
| Remote terminal / files / metrics        | done   | P1   |                                                                                                                                                                                          |
| Server resource dashboard                | done   | P2   |                                                                                                                                                                                          |
| Auto-install Docker on a fresh server    | done   | P2   | a Linux server enrolled with root sets itself up right after enrollment - Docker, the builder and its own edge - unless it already runs one; other servers still need Set this server up |
| Move a whole instance to another machine | done   | P2   | sealed export and import                                                                                                                                                                 |

## 10. Extras

| Item                                       | Status | Prio | Notes                                                                                                                                                                                                                      |
| ------------------------------------------ | ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notifications on deploy success/fail       | done   | P1   |                                                                                                                                                                                                                            |
| Slack/Discord/Teams/Telegram/email/webhook | done   | P1   |                                                                                                                                                                                                                            |
| Team/RBAC on projects                      | done   | P1   | capability sets, per-environment scope, expiry                                                                                                                                                                             |
| Compliance evidence (SOC 2 / ISO 27001)    | done   | P2   | Management > Evidence: controls in force, JSON + printable report, SHA-256 in the audit trail; see `docs/compliance.md`                                                                                                    |
| Usage per project                          | done   | P2   |                                                                                                                                                                                                                            |
| Usage/cost estimates                       | done   | P2   | Management > Billing and Organization > Billing: monthly statement per project and owner, admin-set rates (vCPU-hour, GB-hour, GB-month, GB out), CSV/JSON export, org budgets alerted at 80%/100% (`billing-budgets` job) |
| API + CLI                                  | done   | P1   | `/api/v1/deploy`, `dashboard/cli`                                                                                                                                                                                          |
| Installable desktop app                    | done   | P2   |                                                                                                                                                                                                                            |
| Terraform provider                         | todo   | P2   |                                                                                                                                                                                                                            |

---

## 11. CI / build-pipeline performance (this repo's own actions)

| Item                                       | Status  | Prio | Notes                                             |
| ------------------------------------------ | ------- | ---- | ------------------------------------------------- |
| Per-image gated jobs (skip unchanged)      | done    | P0   |                                                   |
| Parallel image jobs                        | done    | P0   |                                                   |
| npm-ci layer caching                       | done    | P1   |                                                   |
| Native arm64 runners for hostd             | done    | P0   | `ubuntu-24.04-arm`                                |
| Rust dependency caching in the hostd image | todo    | P1   | Dockerfile copies everything before `cargo build` |
| Skip publish when only tests change        | partial | P2   | docs-only pushes are skipped already              |

---

## 12. Scale-out for a customer leaving Vercel (assessed 2026-10-08)

What a team moving a production app off Vercel expects, against what Deploy does
today. Checked against the code, not the UI copy.

### What exists

- **Copies of a service** - up to `REPLICAS_MAX` (10), on the one server the
  service is deployed to (`packages/core/src/scaling.ts`). The edge balances over
  them with health checks and optional sticky sessions.
- **Autoscaling** - a once-a-minute loop (`lib/deploy/autoscaler.ts`, job
  `service-autoscale`, under the cron lease) holds an average CPU and optionally
  requests per copy between a min and max; up after 3 readings, down after 10,
  idle straight to the minimum, 5-minute cooldown. Compose runtime only: swarm
  tasks are not read. Streaks live in memory and reset on restart.
- **Who may run copies** - not a service with a volume, one deployed from its own
  compose file, or one that keeps previous releases (`singleCopyReason`).
- **Zero-downtime deploys** - swarm start-first with rollback; compose starts the
  new release beside the old one and switches the edge after it is healthy and
  listening, with the exceptions listed in section 6.
- **Edge** - Traefik per server (per-server edge, so the control plane is not in
  the request path); CDN only through a Cloudflare-proxied record, purged after a
  deploy.
- **Polaris itself** - one compose project: one dashboard container, one
  Postgres, one Traefik, hostd. The cron scheduler already takes a database
  lease, but live updates (Chat, Tasks) ride an in-process bus, so a second
  dashboard container would not see the first one's events.

### Gaps

| #   | Gap                                                                           | Why a Vercel customer needs it                                                                                                                    | Prio |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| G1  | Copies of one service on several servers                                      | One machine is still one failure and one ceiling; Vercel runs functions across a fleet                                                            | P0   |
| G2  | Load-balanced entry across servers                                            | With G1, a domain has to reach copies on more than one machine and survive one of them going away                                                 | P0   |
| G3  | Autoscaling past one machine, and on swarm                                    | The loop only adds copies on the same host and skips swarm                                                                                        | P1   |
| G4  | Faster scale-up signal                                                        | One-minute polling and 3 readings is 3+ minutes to react; a launch spike is over by then                                                          | P1   |
| G5  | Zero-downtime for every service                                               | Published ports, owner compose files, label-only server edges and volumes still restart in place                                                  | P1   |
| G6  | Edge caching that does not need Cloudflare                                    | Vercel caches static assets and ISR pages at its edge; here only a Cloudflare-proxied record caches                                               | P1   |
| G7  | Per-customer quotas (copies, services, servers)                               | A hosting company granting `games.manage` / `deploy.manage` cannot cap what one customer creates (see the tenancy audit)                          | P1   |
| G8  | Polaris in more than one container                                            | An update or crash of the one dashboard container stops the control plane; needs a cross-process event transport and sticky or stateless sessions | P2   |
| G9  | Preview environments per pull request with their own copies and scale-to-zero | Vercel's default workflow                                                                                                                         | P2   |
| G10 | Request-level metrics (p95 latency, error rate) as scaling signals            | CPU and request count miss slow-but-idle services                                                                                                 | P2   |

### Phased plan

Estimates are agent wall-clock for a change of this shape, including tests, not
calendar time.

1. **Phase 1 - one machine, done properly** (about 1 day)
   - G4: read the edge's access log incrementally every 15 s instead of a
     one-minute window; keep the decision pure in `autoscaleStep`.
   - G3 (swarm half): read swarm task stats by service label and scale with
     `docker service scale`.
   - G5: zero-downtime for a published port by moving the port onto the edge
     (TCP router) so the container no longer owns it.
   - G7: a quota row per user/org (max services, copies, servers), enforced in
     the create/scale actions and shown in the UI from the same check.
2. **Phase 2 - several machines** (about 2-3 days)
   - G1: a service may name a pool of servers rather than one target; copies are
     placed round-robin with a spread constraint; the release is built once and
     pulled on each server from the registry.
   - G2: the per-server edges each route to their local copies, and the domain's
     DNS gets one record per server (Cloudflare or Domain Connect, both already
     integrated), health-checked so a dead server's record is withdrawn; an
     optional paid load balancer is a later option, not a requirement.
   - G3 (multi-host half): the autoscaler adds a copy on the least-loaded server
     of the pool.
3. **Phase 3 - edge caching** (about 1 day)
   - G6: Traefik has no HTTP cache, so put a cache in front of chosen routes
     (a Souin-style middleware or a small Varnish/nginx sidecar per server edge),
     honouring the app's `Cache-Control`, purged on deploy like the Cloudflare
     path is today.
4. **Phase 4 - Polaris itself** (about 2 days)
   - G8: replace the in-process bus behind Chat and Tasks with Postgres
     `LISTEN/NOTIFY` (no new dependency), make the autoscaler's streaks
     persistent, and allow `web` to run with more than one replica behind the
     existing Traefik.
5. **Later** - G9 and G10 once the above exist; each is roughly a day.

Nothing here was built in this pass: none of the gaps is both small and
self-contained enough to land without its phase (a faster signal without the
incremental log reader would only re-read the whole log more often).

---

## Suggested order

1. Zero-downtime for services with a published port.
2. Pre-deploy command, then build cache reuse.
3. Deploy from a Compose file in the repository.
4. Target stage / build args fields, `.env` export, restart policy.
5. GitLab and Gitea sources.
