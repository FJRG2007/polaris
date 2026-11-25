# Polar Code: the session is the agent's own machine

Why a session agent used to say "no root", "no browser", "trying a temporary
folder", what the hosted agent sandboxes do instead, what Polaris does now, and
what the hosted cloud-session products offer that Polaris does not yet.

## What was wrong

- Sessions ran the stock `node:24` image (`SESSION_IMAGE` in
  `dashboard/apps/web/src/lib/agents/session-commands.ts`). It has no Chromium
  and none of the libraries a downloaded browser needs, so the worker browser
  (`session-browser-mcp.ts`) and any screenshot or 3D render check failed.
- The agent already had passwordless sudo (the `AGENT_ACCOUNT` preamble), but
  nothing told it so. Facing an unknown box it assumed the worst and narrated
  workarounds to the person.

## Research: how agent sandboxes give an agent a full machine

Ranked by fit for Polaris, which runs sessions on the operator's own hosts
through hostd and must never ask the operator for a terminal.

| # | Option | Root | Browser | Persistence | Isolation | Self-hostable / cost |
|---|---|---|---|---|---|---|
| 1 | Own image on the existing Docker (devcontainer pattern; Claude Code on the web toolset) | non-root user + NOPASSWD sudo | preinstalled | home and workspace on the box | container, as before | yes; a larger image, no host change |
| 2 | gVisor `runsc` (Modal) | root under a user-space kernel | not benchmarked | same | syscalls intercepted | yes; runsc on the host and a Docker daemon restart. Ant reports under 3% overhead for 95% of its apps |
| 3 | Sysbox (behind Docker Desktop's Enhanced Container Isolation) | root mapped to an unprivileged host user | as 1 | same | user namespace | yes; a runtime installed on the host |
| 4 | Firecracker / Kata microVM (E2B, Vercel Sandbox, Fly, Cloudflare) | Vercel: `vercel-sandbox` with sudo; Daytona: `daytona` with NOPASSWD sudo; E2B: `user` | per template | snapshots | VM with its own kernel | needs KVM; self-hosted E2B is Terraform + Nomad + Consul |
| 5 | Hosted (Cloudflare Sandbox/Containers, E2B, Daytona, Modal, Vercel) | yes | bring your own image | varies | VM per sandbox (Cloudflare) | not self-hostable; billed per vCPU-second, Cloudflare caps 4 vCPU / 12 GiB / 20 GB |

Notes from the sources:

- Claude Code on the web: an Ubuntu 24.04 VM per session; Python, Node 20-22,
  Ruby, PHP, Java, Go, Rust, C/C++, Docker, PostgreSQL 16, Redis 7, Chrome for
  Testing at `/usr/bin/google-chrome` with `CHROME_PATH`; setup scripts run as
  root and are snapshotted; network Limited by default with an allowlist;
  GitHub credentials never enter the VM (a proxy attaches them).
- Codex cloud: the `codex-universal` image plus a setup script with internet;
  the agent phase has internet off by default (limited or unrestricted on
  request), all traffic through a proxy, secrets removed before the agent
  phase, the container cached up to 12 hours.
- Cloudflare Sandbox: one VM per sandbox, bring your own image, "install
  everything the agent needs in the image"; Claude Code needs `IS_SANDBOX=1` to
  run as root - which is why Polaris keeps the agent non-root with sudo.
- Playwright: `npx playwright install --with-deps`; Chromium needs `--ipc=host`
  or it runs out of shared memory; root disables the Chromium sandbox.

Sources: developers.cloudflare.com/sandbox/sdk/concepts/security,
developers.cloudflare.com/containers/platform/pricing,
code.claude.com/docs/en/cloud-environments,
learn.chatgpt.com/docs/environments/cloud-environment,
vercel.com/docs/sandbox/concepts/runtimes, docs.e2b.dev/template/user-and-workdir,
github.com/e2b-dev/infra (self-host.md), modal.com/blog/modal-gvisor-maintainer,
gvisor.dev/docs/architecture_guide/performance,
gvisor.dev/blog/2021/12/02/running-gvisor-in-production-at-scale-in-ant,
github.com/nestybox/sysbox, playwright.dev/docs/docker,
code.visualstudio.com/remote/advancedcontainers/add-nonroot-user. Not
confirmed: whether E2B's default user has sudo, and Daytona's isolation layer.

## What Polaris does now (option 1)

- **The image.** `dashboard/services/agent-session/Dockerfile`: `node:24-bookworm`
  with tmux, sudo (NOPASSWD for `node`, baked in), Debian Chromium
  (`CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`), fonts (Liberation, Noto emoji
  and CJK), Mesa and Xvfb, python3 with pip, venv and pipx, jq, ripgrep,
  zip/unzip, and on amd64 Playwright 1.64.1's Chromium and system libraries in
  `/ms-playwright`. Built for amd64 and arm64 by `dashboard-publish.yml` (the
  `session` job) into the public dashboard package as
  `latest-service-agent-session`, kept by `ghcr-prune.yml`.
- **Rollout with no setup.** `upWithSessionImage` (`session-image.ts`) starts a
  session on the machine image with pull policy `never`. A box that has not
  pulled it starts on `node:24` exactly as before, and the daily refresh - now
  of the machine image - pulls it behind the session. The Update button is the
  whole delivery: no `.env` key, no hostd change.
- **Old sessions.** A container recreated on the new image reopens on the same
  home and checkout: both are bind mounts on the box (`AGENT_HOME`,
  `SESSION_ROOT`). The boot's own tmux and sudo installs are no-ops there.
- **What the agent is told.** `MACHINE_PROMPT` (`session-commands.ts`), appended
  to Claude Code's system prompt only when the image's marker
  (`/etc/polaris-agent-machine`) is present: its own computer, sudo, what is
  installed, the Chromium flags (`--headless --no-sandbox
  --disable-dev-shm-usage`, SwiftShader for WebGL), and not to narrate the
  environment to the person.
- **Git as the person.** `gitIdentityFor` (`session-git-identity-source.ts`)
  resolves, on every start, the linked GitHub account for the repository's
  owner (else the first linked): its display name or login, and its public
  address or `<id>+<login>@users.noreply.github.com`; with no GitHub link, the
  Polaris account's name and address. The boot (`SET_GIT_IDENTITY`) writes it to
  the home's global config where the home is the person's own, to the checkout
  only in a shared home, and on an enrolled server only when that machine has
  no identity of its own. `git push` and `gh` already go through the session's
  credential helper (`gitCredentialScript`, `INSTALL_GH`), which mints a token
  scoped to the session's one repository per use, so no token is in the
  environment or in a file. `GIT_PROMPT` and `GH_PROMPT` tell Claude Code both
  are set up, only when they are.

## Isolation

Unchanged for the host. The container still starts as root without a user
namespace (as it always has), with Docker's default capabilities and seccomp
profile, no `privileged`, no host network, no Docker socket, bind mounts
confined to hostd's volume root, and the CPU and memory limits from
`sessionLimits`. Sudo only lets the `node` account reach the root it was
already one `su` away from inside the same container.

Stronger isolation, not added blind:

- **gVisor**: needs runsc on each host, a `runtime` field in hostd's
  `DeploySpec` (which rejects unknown fields, so the dashboard may only send it
  to a hostd that advertises it), and the update script to install runsc - the
  limited edition has none. Chromium and WebGL under gVisor need a benchmark on
  a real box first.
- **Sysbox**: the same delivery problem, plus a kernel requirement.
- **Per-container user namespaces**: not expressible in compose; daemon-wide
  `userns-remap` changes the ownership of every existing volume.

## Follow-ups, with the reason they are not in this change

- **Shared memory.** Docker's 64 MB `/dev/shm` is why Chromium is told
  `--disable-dev-shm-usage`. `shm_size` is a hostd field that old daemons reject.
- **Egress limits.** Sessions install from npm, PyPI, apt, GitHub and the
  vendors' own hosts, and may reach a preview or a service the person runs. An
  allowlist (the Claude Code and Codex model: a proxy with None / Limited /
  Full levels) needs a proxy container per box and a setting per session;
  switched on by default it would break current sessions.
- **Credentials outside the sandbox.** Codex and Claude Code keep the git
  credential on a proxy. Here the agent's own sign-in lives in its kept home by
  design (that is what makes the second session start signed in); the GitHub
  token could move to a proxy like theirs.
- **Other agents' briefing.** Only Claude Code takes an appended system prompt
  today; Codex, Gemini and OpenCode read their own instruction files.

## Parity ledger: hosted cloud sessions

Polaris column from this repository's code (file presence, depth not audited
in this run); Claude Code and Codex columns from the sources above; Cursor
background agents, Jules and Devin not re-verified in this run ("?" where
unsure). Size: S under a day, M a few days, L a week or more.

| Feature | Claude Code web | Codex cloud | Cursor BG | Jules | Devin | Polaris | Size |
|---|---|---|---|---|---|---|---|
| Preinstalled toolchains | yes, listed | yes (`codex-universal`) | yes | yes | yes | partial: this image (Node, Python, C, browser); no Go, Rust, Java or databases | M |
| Setup script per repo | yes, root, snapshotted | yes, with internet | yes | yes | yes | partial: `agent-repo-service.ts` has one; its result is not snapshotted | M |
| Cached / warm environment | snapshot of setup | container cached 12 h | ? | ? | snapshots | partial: warm spares (`session-spares.ts`), kept home | M |
| Env vars per environment | yes | yes | yes | ? | yes | partial: per-account secrets (`sessionSecretsFor`) | S |
| Secrets kept out of the sandbox | yes (proxy) | removed before the agent phase | ? | ? | ? | no | L |
| Network levels + allowlist | None / Limited / Full | Off / On + allowlist | ? | ? | ? | no (own network only, `session-network.ts`) | L |
| Persistent vs ephemeral | ephemeral VM, resumable | ephemeral, cached | ? | ephemeral | persistent machine | persistent home and checkout | - |
| Snapshots / resume | yes | yes | ? | ? | yes | partial: `session-snapshots.ts`, fork (`session-fork.ts`) | M |
| Browser / computer use | Chrome for Testing | no | yes | yes | yes | partial: worker browser (`session-browser*.ts`), Chromium now in the image | M |
| Parallel tasks | yes | yes | yes | yes | yes | yes (a container per session) | - |
| PR creation | yes, auto-fix | yes | yes | yes | yes | partial: `session-gh.ts`, `session-pr-*.ts`, review loop | M |
| Continue locally (teleport) | `--teleport` | yes | yes | ? | ? | partial: handoff (`session-handoff*.ts`) | M |
| Docker inside the session | yes | ? | ? | ? | ? | no (no socket by design; needs Sysbox or a VM) | L |
| Databases preinstalled | PostgreSQL, Redis | ? | ? | ? | ? | no | S |
| Scheduled / triggered runs | routines | ? | ? | ? | ? | partial: `session-schedules.ts` | S |
