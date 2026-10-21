# Agents - feature roadmap (parity with agent managers and cloud coding agents)

What the established agent managers and hosted coding agents offer that the
Polaris Agents app does not, with a size against each. Statuses were checked
against the code on 2026-10-21 (`origin/main` at `e36622d5df`); keep them updated
as items land.

**Status:** done - partial - todo
**Priority:** P0 (core) - P1 (high) - P2 (nice-to-have)
**Size:** agent wall-clock for one focused agent, including tests: S (under 2 h) -
M (half a day) - L (one to two days) - XL (several days, touches other apps)

Every claim about another product links the page it was checked against.
Anything that could only be found in third-party write-ups is marked
**(unverified)** and listed again at the end. The local reference clone is
`references/repos/orca` (gitignored).

---

## References

| Tool                                     | Kind                         | Checked against                                                                                                                                                                                                                       |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orca                                     | OSS desktop + mobile, MIT    | `references/repos/orca/README.md`, [github.com/stablyai/orca](https://github.com/stablyai/orca)                                                                                                                                       |
| Claude Squad                             | OSS terminal app             | [github.com/smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)                                                                                                                                                            |
| Vibe Kanban                              | OSS web app, **sunsetting**  | [github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)                                                                                                                                                              |
| Conductor                                | Commercial desktop app       | [conductor.build/docs](https://www.conductor.build/docs/), [workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches), [parallel agents](https://www.conductor.build/docs/concepts/parallel-agents)               |
| Crystal, now Nimbalyst                   | OSS desktop, deprecated 2026 | [github.com/stravu/crystal](https://github.com/stravu/crystal)                                                                                                                                                                        |
| Sculptor (Imbue)                         | OSS desktop                  | [github.com/imbue-ai/sculptor](https://github.com/imbue-ai/sculptor)                                                                                                                                                                  |
| Orchestrator (Composio)                  | OSS desktop, Apache-2.0      | [github.com/ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)                                                                                                                                          |
| Terragon                                 | OSS snapshot, shut down      | [github.com/terragon-labs/terragon-oss](https://github.com/terragon-labs/terragon-oss)                                                                                                                                                |
| OpenHands                                | OSS, MIT core                | [github.com/All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands)                                                                                                                                                        |
| Omnara                                   | OSS                          | [github.com/omnara-ai/omnara](https://github.com/omnara-ai/omnara)                                                                                                                                                                    |
| Happy                                    | OSS mobile + CLI, MIT        | [github.com/slopus/happy](https://github.com/slopus/happy), [happy.engineering](https://happy.engineering/)                                                                                                                           |
| Coder Tasks                              | Self-hosted, commercial      | [coder.com/docs/ai-coder/tasks](https://coder.com/docs/ai-coder/tasks), [core principles](https://coder.com/docs/ai-coder/tasks-core-principles)                                                                                      |
| GitHub Copilot cloud agent and Agent HQ  | Commercial                   | [about the coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent), [Agent HQ announcement](https://github.blog/news-insights/company-news/welcome-home-agents/)                            |
| Cursor cloud agents                      | Commercial                   | [cursor.com/docs/cloud-agent](https://cursor.com/docs/cloud-agent)                                                                                                                                                                    |
| Codex cloud                              | Commercial                   | [learn.chatgpt.com/docs/cloud](https://learn.chatgpt.com/docs/cloud)                                                                                                                                                                  |
| Jules                                    | Commercial                   | [jules.google/docs](https://jules.google/docs)                                                                                                                                                                                        |
| Devin                                    | Commercial                   | [docs.devin.ai](https://docs.devin.ai/)                                                                                                                                                                                               |

Commercial tools are listed for reference only: what users of agent tooling now
expect, not code to copy.

---

## What Polaris already has

Two shapes of agent work, both from the dashboard, neither needing a terminal.

**Background runs on GitHub repositories** (the vendored runtime,
`dashboard/packages/agent-runtime`, see its `VENDOR.md`).

- A repository is connected through the GitHub App and given an execution place:
  GitHub Actions, a Polaris runner pool, or a container on the Polaris box with no
  workflow file. Polaris recommends the cheapest place that fits
  (`recommendExecution`, `packages/core/src/agents.ts`; `repos/execution-picker.tsx`).
- Triggers: a mention (always on), issue opened or labeled, pull request opened,
  review requested or submitted, checks failed, and a manual start with a prompt
  (`AGENT_TRIGGERS`, `packages/core/src/agents.ts`). Rules per repository add
  label and base-branch filters and their own instructions
  (`automations/automations-view.tsx`, `AgentAutomation` in the schema).
- Modes from the runtime: Build, AddressReviews, Review, IncrementalReview, Plan,
  Fix, ResolveConflicts, Task (`packages/agent-runtime/modes.ts`).
- Policies per repository, per account and per deployment, resolved through
  tiers: push (read-only, feature branches only, full), shell (none, without
  secrets, full; public repositories default to no secrets), visibility switches,
  and the Enigma quality gate before the push (off, checks, full)
  (`resolveAgentPolicy`, `agent-defaults-service.ts`, `settings/settings-view.tsx`).
- Model picker from a refreshed catalogue with prices, a fallback chain of up to
  five models retried on failures worth retrying (`model-catalog.ts`,
  `agent-fallback.ts`, `AGENT_FALLBACK_MAX`), and bring-your-own provider keys with
  expiry checks (`model-keys.ts`, `model-key-expiry.ts`, `provider-key-check.ts`).
- Usage limits on runs or tokens per day, week or month, for everyone, a user, a
  role, a group, a repository or an org (`agent-usage-limits.ts`,
  `AgentUsageLimit`). Runs record `tokensIn` and `tokensOut`.
- Runs list with state, where it ran, a link to the job, stop, and the gate's
  steps (`runs/runs-view.tsx`); a setup checklist (`setup/page.tsx`).

**Live sessions** (modelled on Orca).

- A vendor CLI running in tmux: Claude Code, Codex, OpenCode, Gemini, Copilot,
  Cursor, Amp, Goose, Aider, Droid, Qwen, Crush, Cline, OpenHands, OpenClaw, or a
  custom command (`AGENT_CLIS`, `packages/core/src/agent-clis.ts`).
- Placed in a container on the box, on one of the user's own servers, or on a
  shared machine an administrator opened (`startSessionAction`,
  `sessions/actions.ts`; `session-capacity.ts`).
- Each session gets a fresh shallow clone on its own branch
  (`sessionBranchName`), or a kept workspace with no repository; the agent's home
  is kept so installs and sign-ins happen once (`PREPARE_WORKTREE`,
  `session-commands.ts`).
- Observed through the tool's own hooks, normalised into one vocabulary:
  starting, working, waiting ("Needs you"), idle, stopped, failed
  (`packages/core/src/agent-sessions.ts`, `session-hooks.ts`).
- Steered by pasting into the terminal, interrupted, stopped; the screen can be
  watched, and the real terminal taken over in the browser
  (`session-detail.tsx`, `TerminalPanel`).
- Polaris's own MCP server is written into the worktree, and an agent can list,
  start, read and prompt other sessions through it
  (`mcpConfig`, `lib/mcp/tools/sessions.ts`).
- Ceilings: 3 live sessions per account and 12 per instance by default
  (`DEFAULT_PER_ACCOUNT`, `DEFAULT_TOTAL`); sessions silent for six hours are
  swept (`sweepSilentSessions`).
- A session can be started for a task, which leaves a note on the task with the
  branch and a link (`noteOnTask`, `sessions/actions.ts`).
- Polar's Code mode starts and follows sessions from the assistant panel
  (`components/polar/polar-code.tsx`, `app/(app)/polar/code-actions.ts`). At the
  time of writing this is on `feat/polar-code-mode`, not yet on `main`.

---

## 1. Isolation and where agents run

| Item                                         | Status  | Prio | Who has it                                                                                                                                       | Notes                                                                                                                         |
| -------------------------------------------- | ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| One isolated checkout and branch per task    | done    | P0   | Claude Squad, Conductor, Orca, Orchestrator, Crystal (git worktrees); Sculptor, Terragon (containers)                                            | A clone per session rather than a worktree, which costs a clone and buys a container boundary.                                |
| Run on a remote machine of your own          | done    | P0   | Orca (SSH worktrees), Sculptor (remote, experimental), Coder (workspaces)                                                                        | "On a server" place.                                                                                                          |
| Hosted runs that keep going with no laptop   | done    | P0   | Cursor, Codex cloud, Jules, Copilot, OpenHands Cloud                                                                                             | Runs and container sessions live on the box.                                                                                  |
| Any terminal agent                           | done    | P0   | Orca, Sculptor, Claude Squad                                                                                                                     | Custom command option.                                                                                                        |
| Repository setup script                      | todo    | P1   | Conductor, Codex cloud (install script), Jules, Cursor (`environment.json`)                                                                      | The vendored runtime already carries `setupScript`; Polaris always sends `null` (`agent-run-context.ts`). Sessions have none. |
| Cached environment snapshot                  | todo    | P2   | Cursor (snapshot), Jules **(unverified)**                                                                                                        | Kept home covers tool installs, not project dependencies.                                                                     |
| Network egress policy per repository         | todo    | P2   | Codex cloud (allow, block, allowed domains)                                                                                                      | Polaris's guarded fetch and firewall exist for the edge, not for agent containers.                                            |
| Pause and resume a session                   | todo    | P2   | Claude Squad (pause on checkout, `r` to resume), Coder (pause at idle timeout)                                                                   | Polaris sweeps after six silent hours and the session is over.                                                                |

## 2. Watching and steering

| Item                                           | Status  | Prio | Who has it                                                                                                     | Notes                                                                                     |
| ---------------------------------------------- | ------- | ---- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Live state including "needs you"               | done    | P0   | Orchestrator (Working, Needs you, In review, Ready to merge), Coder (task reporting) **(unverified)**          | Hook-driven state machine.                                                                |
| Send a follow-up, interrupt, take the terminal | done    | P0   | Claude Squad, Orca, Cursor (remote desktop takeover), Devin (take over in its IDE)                             |                                                                                           |
| Answer a permission prompt as a button         | todo    | P1   | Omnara (approve or deny in Slack, Discord, dashboard)                                                          | Polaris records the `permission` event with its detail but the answer is typed.           |
| Plan first, approve, then code                 | partial | P2   | Jules                                                                                                          | Runs have a Plan mode; a session has no plan-first switch.                                |
| Attach files or images to a prompt             | todo    | P2   | Orca (drag files and images into a prompt), Coder Agents (attachments)                                         |                                                                                           |
| Shared, read-only view of a session            | partial | P2   | Copilot (shared sessions), Cursor (teammates read-only, team follow-ups)                                       | Reaching the repository is reaching the session; no per-session share.                    |

## 3. Review and shipping

| Item                                          | Status  | Prio | Who has it                                                                                                                                   | Notes                                                                                                                                                           |
| --------------------------------------------- | ------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diff of the session's work                    | todo    | P0   | Claude Squad (diff tab), Vibe Kanban, Conductor (diff viewer), Codex cloud, Orca                                                             | Nothing on the session page shows what changed.                                                                                                                 |
| Comment on diff lines and send them back      | todo    | P1   | Vibe Kanban (inline comments to the agent), Orca (annotate AI diffs)                                                                         |                                                                                                                                                                 |
| Push the branch and open a pull request       | partial | P0   | Claude Squad (push), Vibe Kanban, Conductor, Cursor, Codex cloud, Terragon, Jules **(unverified)**                                           | Runs open pull requests through the runtime. A session only pushes if the agent decides to.                                                                    |
| Work survives Stop                            | todo    | P0   | Claude Squad (checkout commits and pauses), Terragon (work checkpointed and pushed)                                                         | Stopping a container session removes the container, so unpushed commits go with it (`stopSession`, `session-runtime.ts`). On a server the directory is kept. |
| Review comments and failed CI go back to the agent that did the work | partial | P1   | Orchestrator, Copilot **(unverified for PR comments)**                                                                       | Runs have AddressReviews and Fix modes. Nothing ties them to the session that wrote the branch.                                                                 |
| Merge and clean up from the screen            | todo    | P2   | Conductor (merge, archive the workspace), Vibe Kanban                                                                                        |                                                                                                                                                                 |
| Quality gate before the push                  | done    | P0   | Polaris only among these                                                                                                                     | Enigma gate on runs; sessions install Enigma when the resolved settings ask.                                                                                   |
| Checkpoints and rollback inside a session     | todo    | P2   | Terragon (checkpoints)                                                                                                                       | Claude Code's own rewind already works inside the terminal.                                                                                                     |

## 4. Intake and orchestration

| Item                                          | Status  | Prio | Who has it                                                                                                                             | Notes                                                                                     |
| --------------------------------------------- | ------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GitHub events and mentions                    | done    | P0   | Copilot, Cursor, Terragon, Omnara, OpenHands                                                                                           |                                                                                           |
| Board of tasks moving through states          | partial | P1   | Vibe Kanban, Orchestrator                                                                                                              | Sessions are a list. Polaris Tasks is a board, and a session can be started for a task.  |
| Start from a tracker ticket (Linear, Jira)    | partial | P2   | Orca, Cursor, Devin, OpenHands (Linear)                                                                                                | Polaris Tasks already polls Linear and Jira; the session start is not offered there.      |
| Start from chat                               | todo    | P2   | Cursor (Slack), Devin (Slack, Teams), Omnara (Slack, Discord), Terragon (Slack)                                                        | Polaris Chat is in the same product.                                                      |
| Scheduled runs                                | todo    | P2   | OpenHands (schedules), Omnara (cron), Jules (scheduled tasks, linked from its docs)                                                    | Automations answer GitHub events only.                                                    |
| Same task to several agents, compare, keep one | todo   | P1   | Orca (fan one prompt across five agents, merge the winner), Crystal (compare approaches), Agent HQ **(unverified)**, Codex best-of-N **(unverified)** |                                                                              |
| Agent delegates to another session            | done    | P1   | Orca (CLI that agents drive)                                                                                                           | `agent_session_start` and `agent_session_prompt` MCP tools.                               |
| API for everything                            | partial | P2   | Devin, Conductor, Omnara, Cursor                                                                                                       | MCP tools cover sessions; runs have no tool.                                              |

## 5. Away from the desk

| Item                                          | Status  | Prio | Who has it                                                                                                                 | Notes                                                                                     |
| --------------------------------------------- | ------- | ---- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Notification when an agent needs you or ends  | todo    | P0   | Orca (notified when an agent finishes), Jules (browser notifications on completion or needs input), Terragon (browser)    | No agent event reaches the bell; only model-key expiry does.                              |
| Phone access                                  | partial | P1   | Orca (iOS, Android), Happy (iOS, Android, web, end-to-end encrypted), Cursor (iOS, PWA), Agent HQ (mobile)                | The dashboard works in a phone browser and MCP tools work from any client; no push.       |

## 6. Cost, limits and governance

| Item                                          | Status  | Prio | Who has it                                                                                     | Notes                                                                                     |
| --------------------------------------------- | ------- | ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Usage limits by person, role, repo, org       | done    | P0   | Cursor (spend limit), Agent HQ (governance)                                                    | Runs only.                                                                                |
| Token and cost per session                    | todo    | P1   | Cursor (API pricing per model)                                                                 | Sessions record no tokens, so limits and costs skip them.                                 |
| Usage dashboard                               | partial | P2   | Agent HQ (metrics dashboard, preview)                                                          | Model catalogue has prices; nothing totals them.                                          |
| Which agents and models are allowed           | partial | P2   | Agent HQ (admins choose agents and models)                                                     | Repository and session permissions exist; no allow-list of CLIs or models.               |
| Secrets for the agent's environment           | partial | P1   | Cursor (secrets injected at start), Codex cloud (environment)                                  | Runs get provider keys and filter secrets by shell policy; sessions take no variables.    |
| Shared MCP servers for agents                 | partial | P2   | Agent HQ (MCP registry), Copilot (repository MCP settings)                                     | Polaris's own MCP server is written in; no other server can be added from the dashboard.  |

---

## Gaps, in the order to build them

Every item follows the repository rule: nothing here may ask the operator for a
command, a file edit or a log, and every setting has a working default in code.

### 1. Tell me when an agent needs me (P0, S)

- **Outcome:** a session that stops on a permission prompt or a question puts a
  notification in the bell and, where allowed, a browser notification; a finished
  turn or a failed run does too, at a lower level.
- **Why:** the whole point of running agents in the background is not watching
  them. Today the "Needs you" state exists and nobody is told.
- **Approach:** the state transition is already computed in
  `recordSessionEvents` (`session-service.ts`). On a transition into `waiting`,
  and on run completion in `agent-run-service.ts`, write a notification through
  the existing notification and browser-notice path, with a per-user preference
  defaulting to on for "needs you" and off for "finished". Debounce per session
  so a chatty agent is one notification, not twenty.

### 2. Never lose work on Stop (P0, S)

- **Outcome:** stopping a container session that has commits or edits not on
  GitHub says so, and offers to push the branch first; the sweep does the push
  without asking.
- **Why:** the container is removed with everything in it. A six-hour sweep can
  destroy a day of agent work silently.
- **Approach:** before teardown in `stopSession`, run `git status --porcelain`
  and `git log @{u}..` (or against the base ref) inside the container through the
  existing exec path, commit anything dirty as a work-in-progress commit, and push
  the session branch with the installation token the clone already used. The
  dialog uses the design system's dialog, never `confirm`.

### 3. See what the agent changed (P0, M)

- **Outcome:** a Changes tab on the session: files changed against the base ref,
  a syntax-highlighted diff, refreshed while the agent works.
- **Why:** every comparable tool has this; without it the only way to review is
  to take the terminal or wait for a pull request.
- **Approach:** a server action that runs `git diff --stat` and `git diff`
  against `baseRef` in the session's container or server directory. Mind the
  16 KiB exec output cap: read the diff through the container-files readers, or
  page it per file. Render with the existing code surface.

### 4. Ship from the session (P0, M)

- **Outcome:** "Open a pull request" on the session pushes its branch, opens a
  pull request with a generated title and body, and shows its checks; the
  session links the PR and the PR links the session.
- **Why:** turning agent work into a reviewable change is the step every tool
  above makes one click.
- **Approach:** reuse the GitHub App installation token minting the runs already
  use; the body can be written by the session's own agent (one prompt asking for
  a summary) or by the platform model. Store the PR number on `AgentSession`
  (additive migration). Respect the repository's push policy: read-only blocks
  it with the reason, as the button rather than as an error.

### 5. Diff comments and CI failures go back to the agent (P1, M)

- **Outcome:** comments on diff lines, review comments on the PR and failed
  checks become the session's next prompt, with file and line.
- **Why:** closes the loop without copy and paste; Orchestrator and Vibe Kanban
  are built around it.
- **Approach:** on the Changes tab, collect comments into one prompt and send it
  through `promptSessionAction`. For GitHub, the webhook already receives review
  and check events (`agent-webhook.ts`): when the PR's branch belongs to a live
  session, route the event to that session instead of starting a run.

### 6. A board for sessions (P1, M)

- **Outcome:** sessions grouped by Needs you, Working, Idle, Ready for review,
  Done, with the "needs you" column first; start a session from a task card.
- **Why:** past three sessions a list stops answering "what should I look at".
- **Approach:** a view over the existing states plus the PR state from item 4.
  Starting from Tasks reuses `startSessionAction` with `taskId`, which already
  exists; add the entry point to the task menu behind the same permission check.

### 7. Repository setup script (P1, M)

- **Outcome:** a repository can say what to install before the agent starts
  (dependencies, a database, seed data), set from the repository dialog, used by
  both runs and sessions.
- **Why:** an agent that cannot run the tests writes worse code; Codex, Cursor,
  Jules and Conductor all have this.
- **Approach:** a text field on `AgentRepo` (additive, null by default), passed
  as `setupScript` in `agent-run-context.ts` and run after the clone in
  `PREPARE_WORKTREE`, base64-encoded like the hook script so no newline reaches
  the boot environment. Show its output in the boot steps.

### 8. Same task, several agents (P1, L)

- **Outcome:** one prompt starts two to five sessions with different agents or
  models; a compare view puts their diffs side by side; keeping one opens its PR
  and stops the rest.
- **Why:** different models solve the same task differently, and comparing is
  cheaper than retrying.
- **Approach:** a `groupId` on `AgentSession`, a start form that fans out through
  `startSessionAction`, and the Changes tab from item 3 in columns. The per-account
  ceiling applies to the fan-out as a whole and is checked before any session
  starts.

### 9. Token use and cost per session (P1, M)

- **Outcome:** each session shows tokens and an estimated cost; usage limits
  count sessions as well as runs.
- **Approach:** Claude Code's hook payloads carry the transcript path; read usage
  from it in the container at turn end and post it with the event. Other CLIs
  report what their hooks give, and "unknown" is shown as unknown, never zero.
  Price from `AgentModel.costInput` and `costOutput`.

### 10. Answer a permission prompt with a button (P1, S)

- **Outcome:** the "Asking permission" event shows Allow and Deny, from the
  session page, the board and the notification.
- **Approach:** send the CLI's own keystroke for the choice through the paste
  path, per CLI in `agent-clis.ts`; only for CLIs whose prompt is known.

### 11. Variables and secrets for sessions (P1, M)

- **Outcome:** a repository's agent variables (an API base URL, a test token)
  reach its sessions and runs, encrypted at rest, never shown back.
- **Approach:** reuse the encrypted-variable storage Deploy already has; deliver
  through the boot environment, each value passed through `guardEnv()`, and keep
  the shell policy's secret filtering for public repositories.

### Later (P2)

| Item                                 | Size | Approach                                                                                                                                         |
| ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live preview of the app being built  | L    | Expose a port of the session container through the edge with an explicit Traefik `priority`, rendered by the pure route renderer and written with `writeDynamicFile`. |
| Plan-first switch on a session       | S    | Start the CLI in its plan mode where it has one (Claude Code's permission mode), listed per CLI.                                                 |
| Pause and resume                     | M    | Keep the container's volume on sweep, restart with the CLI's resume flag in the kept home.                                                       |
| Scheduled automations                | S    | A schedule trigger on `AgentAutomation` driven by the existing cron jobs (`lib/cron/jobs.ts`).                                                   |
| Start from Chat                      | M    | A mention in a channel starts a session; updates post back through the channel's webhook, never as the user.                                    |
| Network egress policy                | L    | Allow-list per repository applied to the session container's network.                                                                            |
| Extra MCP servers per repository     | M    | Merge into the `.mcp.json` Polaris already writes; tokens stored encrypted.                                                                      |
| Allowed CLIs and models              | S    | An administrator allow-list read by `agentChoicesFor` and the model picker.                                                                      |
| Files and images in a prompt         | M    | Upload into the worktree and reference the path in the pasted prompt.                                                                            |

---

## Claims that could not be verified

Found only in press or third-party write-ups, or absent from the page checked.
Do not cite these as fact until a primary source is found.

- Codex cloud best-of-N (several attempts per task, `--attempts` on
  `codex cloud exec`): third-party blogs only; not on the Codex cloud page.
- Agent HQ sending one task to several agents to compare: press coverage only;
  GitHub's own announcement does not say it.
- Copilot opening a draft pull request and iterating on PR review comments: not
  on the page checked.
- Jules environment snapshots and how it publishes a branch or pull request:
  third-party guides only.
- Happy push notifications: not stated on its README or site.
- Coder task status reporting (`coder_report_task`): seen in a mirrored commit,
  not in Coder's docs.
- Conductor checkpoints and notifications, Sculptor pairing mode and
  checkpoints: not found on the pages checked.
- Devin playbooks, snapshots and billing units: not on the docs landing page.
- Cursor taking over an agent in the IDE: the page describes remote desktop
  takeover only.
