# Polar: Claude Code parity ledger

Target: Polar does everything Claude Code does, on any AI provider, and can also
drive a Claude Code (or Codex, opencode...) session running on the operator's own
computer from any device.

Researched 2026-11-14 against the official docs index
(https://code.claude.com/docs/llms.txt). Doc links below drop the common prefix
`https://code.claude.com/docs/en/`. Polaris paths use two abbreviations:
`web/` = `dashboard/apps/web/src/`, `core/` = `dashboard/packages/core/src/`.

Two engines exist today, and every row says which one it is about:

- **Polar Chat**: Polaris's own provider-agnostic loop
  (`web/app/api/polar/chat/route.ts`, `web/lib/polar/`), with the model router
  (`web/lib/polar/router/`). It has no filesystem or shell tools.
- **Polar Code**: a vendor CLI (15 of them, `core/agent-clis.ts`) in tmux inside a
  container on the box or an enrolled server (`web/lib/agents/session-*.ts`),
  observed through hooks written into the CLI's own config.

Status: **have** (works as Claude Code does), **partial** (exists for one engine
or one surface, or with a missing piece), **missing**. Size: S under a day of
agent time, M a few days, L a week or more.

## Summary

| Status | Count |
| --- | --- |
| have | 21 |
| partial | 33 |
| missing | 26 |
| **total** | **80** |

The single largest gap: **nothing runs on the operator's own computer.** The
desktop app is a client of the instance (`desktop/README.md`: "Nothing of Polaris
runs here"), enrollment needs Linux or macOS with SSH and Docker
(`web/lib/enrollment-*`), and so "local" sessions, Remote Control, teleport and
local MCP servers all wait on one piece: a runner daemon on the PC.

The second: **Polar has no coding loop of its own.** Coding is delegated to
vendor CLIs. Provider-agnostic coding works today only through CLIs that are
themselves provider-agnostic (opencode via `web/lib/agents/opencode-model.ts`) or
through Polaris's Anthropic- and OpenAI-compatible API (`web/lib/polar/compat/`,
`/api/v1/messages`), which lets the real Claude Code CLI run on any provider.

## 1. Surfaces and where sessions run

| Claude Code feature | Doc | Polaris today | Gap | Provider-agnostic design note | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Terminal CLI (interactive REPL) | `quickstart`, `interactive-mode` | `dashboard/packages/cli` is deploy and auth only | No terminal client for Polar | `polaris code` TUI as a thin client of the same session API the web uses; runs the loop on the runner | L | missing |
| Desktop app Code tab: local sessions, terminal, file editor, diff, preview | `desktop` | Web workspace has files, preview, diff, terminal (`web/components/polar/polar-code-workspace.tsx`, `session-preview.ts`, `session-changes.ts`); Electron app has no agent (`desktop/src/main/`) | Desktop cannot run or host a session | Desktop bundles the runner (phase 1) and shows the same Polar Code screens pointed at "This computer" | M | partial |
| VS Code / JetBrains extension | `vs-code`, `jetbrains` | None | No IDE surface | Speak Agent Client Protocol (ACP) so any ACP editor works; a VS Code extension embeds the Polar Code thread | L | missing |
| Cloud sessions from browser | `claude-code-on-the-web` | Polar Code containers on the box or a pool (`session-placement.ts`, `session-queue.ts`, `session-spares.ts`) | None at the core | Already engine-agnostic | - | have |
| Cloud environments: setup script, env vars, network level | `cloud-environments` | Repo setup script and session secrets (`session-runtime.ts` `repoSetup`, `model-keys.ts` `sessionSecretsFor`); private network per box (`session-network.ts`) | No per-environment network access level (none / limited / full) or allowlist | Egress policy enforced by the container network, not by the CLI, so it holds for every engine | M | partial |
| Mobile app (start, monitor, steer) | `mobile` | Installable web app, responsive Polar, web push (`web/lib/notifications/web-push.ts`) | No native app; fine for now | PWA is enough until push reliability on iOS says otherwise | - | partial |
| Remote Control: continue a local session from phone or web | `remote-control` | None | No local sessions to reach | Runner opens an outbound WebSocket to Polaris; Polaris relays prompts, interrupts and approvals; no inbound ports (phase 1) | L | missing |
| `--cloud` (local to cloud) and `--teleport` (cloud to local) | `claude-code-on-the-web#move-tasks-between-terminal-and-cloud` | Fork carries the conversation where the CLI can (`session-fork.ts`); work saved before a container goes (`session-work.ts`) | No move between machines | Push the branch plus the transcript; the other side resumes with the CLI's own resume flag, or Polar's loop replays its stored history | M | missing |
| Dispatch: message a task from the phone to the desktop | `desktop#sessions-from-dispatch` | None | Needs the runner | Same as starting a session with placement "my computer" from the phone | S after runner | missing |
| Trusted devices for Remote Control | `remote-control#trusted-devices` | Account trusted devices exist (`web/app/(app)/account/sessions/trusted-devices-card.tsx`) | Not tied to sessions | Reuse: a runner enrolls as a trusted device of the account | S | partial |
| QR to connect a device | `remote-control#connect-from-another-device` | QR device sign-in flow (`web/lib/cli/sign-in.ts`) | Not used for runner pairing | Reuse the device flow to pair the runner | S | partial |
| Chrome integration | `chrome` | Polar Chat browser tool through the Polaris extension (`web/lib/polar/browser-tools.ts`, `browser-relay.ts`) | Not offered to Code sessions | Expose the browser relay as an MCP server to sessions | M | partial |
| Computer use | `computer-use` | None | | Runner-side MCP server for screenshots and input; opt-in per session | L | missing |
| Slack / team chat mention | `slack` | Agents mention triggers on GitHub (`core/agents.ts` `AGENT_TRIGGERS`); nothing in Polaris Chat found | No "@Polar do this" in Polaris Chat | Polaris Chat mention starts a Code session in the thread's linked repo | M | missing |
| Deep links that open a session | `deep-links` | `polaris://` links in desktop (`desktop/src/main/deep-links.ts`) | No link that opens a session with repo and prompt | Add a `code` route to the existing scheme | S | partial |
| Multiple machines / pools | `self-hosted-environments` | Placement over enrolled servers, best-of-K (`session-placement.ts`) | | | - | have |

## 2. Agent loop and built-in tools

| Claude Code feature | Doc | Polaris today | Gap | Provider-agnostic design note | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Read / Write / Edit / Glob / Grep / Bash tools | `tools-reference` | Code: the vendor CLI's own. Chat: none; repository reading is read-only through host APIs (`web/lib/polar/code-host-tools.ts`, `code-task.ts`) | Polar's own loop cannot edit or run anything | A tool-execution protocol: the loop (any model, existing router) calls tools that execute on the runner or in a session container (phase 3) | L | partial |
| PowerShell tool on Windows | `tools-reference` | None | | Runner picks the shell per OS | S after runner | missing |
| WebSearch / WebFetch | `tools-reference` | Provider-executed search when available, Polaris's own otherwise (`web/lib/polar/web.ts`, `web-sources.ts`) | | | - | have |
| Tool search over many tools | `agent-sdk/tool-search` | `find_tools` and per-turn relevance (`web/lib/polar/tool-relevance.ts`) | | | - | have |
| LSP / code intelligence | `plugins/code-intelligence` | None | | LSP runs next to the code (runner or container), exposed as a tool | M | missing |
| NotebookEdit | `tools-reference` | None | | Plain tool in phase 3 | S | missing |
| Image and file input | `interactive-mode` | Chat attachments (`web/lib/polar/attachments.ts`); files into the checkout for Code (`session-attachments.ts`) | | | - | have |
| Voice dictation | `voice-dictation` | `web/lib/polar/voice.ts`, `transcribe-audio.ts` | | | - | have |
| Background shell tasks and Monitor | `tools-reference` (Monitor, TaskOutput) | Only inside the vendor CLI | Not visible in Polaris; Polar's loop has background subagents (`polar_task` with `background`) but no background shell process | Background processes owned by the runner, listed in the session sidebar | M | missing |
| Todo list (TodoWrite / Task tools) shown live | `agent-sdk/todo-tracking` | Read from the todo tool call in each hook payload (Claude Code TodoWrite and TaskCreate/TaskUpdate, Codex `update_plan`, Gemini CLI `write_todos`, opencode `todowrite`) in `web/lib/agents/session-asks.ts`, kept on the session and shown above the reply box (`polar-code-asks.tsx`) | Polar's own loop has no todo tool yet | Polar's loop gets its own todo tool with the same shape | - | have |
| AskUserQuestion with choices | `tools-reference` | Card with numbered options, multi-select, free text and Skip (`polar-code-asks.tsx`, `AskCard`); the PreToolUse hook waits for the answer and returns `updatedInput` (`session-hooks.ts`, `session-permissions.ts`). Polar's own loop, any provider: `polar_ask` has no execute, so the turn ends on the call; the same card above the composer answers it as the call's output and the turn goes on; the open call survives a reload and shows on other devices; a message written instead settles it as unanswered (`web/lib/polar/ask.ts`, `components/polar/polar-ask.tsx`). Inline forms from a closed field set (`polar_form`, `web/lib/polar/forms.ts`), checked server-side | Code: not exercised in a real container yet | | - | have |
| Plan mode and plan review | `permission-modes#analyze-before-you-edit-with-plan-mode` | Plan mode is a picked permission mode (`--permission-mode plan`); ExitPlanMode shown as a plan card with Approve or Keep planning (`polar-code-asks.tsx`) | Claude Code only; Polar's loop has no plan mode | Polar's loop withholds write tools until the plan is approved | M | partial |
| Subagents (custom agents in `.claude/agents`) | `sub-agents` | `polar_task` in Polar's own loop (`web/lib/polar/subagents`): a child run with its own context, a subset of the parent's tools (`tools.ts`: never more; approval-gated tools run only on a standing grant, none for `explore`) and its own model through the router, any provider; returns only its report (`toModelOutput`). Parallel calls, `background` (bell notice + report injected into the next turn), `resume` by id, steering while running. Types: built-in `general`, read-only `explore`, and each Polar agent with a description (`agents/store.ts`). Bounds: depth 1, 4 running per person, 8 per turn, 16 steps, 400k tokens, 15 min; the parent's stop stops foreground children. Runs persisted (`PolarSubagentRun`); cards, list and transcript in the chat (`components/polar/polar-subagents.tsx`). Technique: Claude Code's Task tool + opencode's `mode: subagent` agents (description-driven delegation, per-agent tools and model). A Code session's own subagents as a live tree under its thread (`components/polar/polar-code-subagents.tsx`): `SubagentStart`/`SubagentStop` registered, each stored event keeps its `agentId`, type and call id or transcript path, decoded into launches with type, description, status, duration and tool steps (`lib/agents/session-subagents.ts`); Stop on a running one stops the turn, since Claude Code has no per-subagent stop; a finished one opens to its own transcript, looked up by agent id on the server and read only from `~/.claude/projects/**/subagents/*.jsonl` (`lib/agents/session-files.ts`); coordinator and worker sessions (`orchestration-service.ts`) | Live list is polled (2.5 s) rather than pushed; definitions are not read from repo agent files; a custom agent's connector list does not narrow a child further than the parent | Push list updates over the run stream; read `.claude/agents` from a Code task's repository | S | partial |
| Agent view / many sessions at once | `agent-view` | Code history beside chats (`web/lib/polar/code-history.ts`), background chat runs (`web/lib/polar/runs.ts`), a per-chat list of running and ended subagents (`polar-subagents.tsx`), a Code session's subagent tree (`polar-code-subagents.tsx`), capacity and queue | No board of all sessions with state | Board over `AgentSession` state that already exists | S | partial |
| Agent teams and cross-session messaging | `agent-teams`, `cross-session-messaging` | MCP tools to list, start, read and prompt sessions (`web/lib/mcp/tools/sessions.ts`, `orchestration.ts`) | No shared task list across a team | Reuse orchestration plan as the shared list | M | partial |
| Dynamic workflows (scripted subagent fan-out) | `workflows` | Orchestration plan graph (`web/lib/agents/orchestration-plan.ts`) | No rerunnable script | Later; orchestration covers the common case | L | partial |
| `/goal` completion condition | `goal` | Chat has it (`web/lib/polar/goals.ts`) | Not for Code sessions | Judge after each Code turn with the same evaluator | S | partial |
| Advisor tool (escalate to a stronger model) | `advisor` | Router and fallback, no consult tool | | A tool that asks another model from the router, any provider | S | missing |
| Worktree per parallel session | `worktrees` | Fresh clone on its own branch per session (`session-branch.ts`, `session-commands.ts`) | Local worktrees need the runner | Runner creates `git worktree` per session | S after runner | partial |
| Checkpoints and rewind (code and conversation) | `checkpointing` | Chat versions and branches (`web/lib/polar/versions.ts`); no code checkpoints | Cannot rewind files | Snapshot the checkout per turn (git stash-like ref on the session branch) so it works for every engine | M | partial |
| `/compact` and auto-compact | `commands`, `context-window` | Chat compaction and auto (`web/lib/polar/compaction.ts`, `preferences.ts`), with a conservative 32k window assumed when the model's is unknown; `/compact` forwarded to CLIs (`code-commands.ts`) | | | - | have |
| `/context` view of what fills the window | `debug-your-config` | Code `/context` card (`web/components/polar/polar-code-status.tsx`): used vs window as Claude Code counts it (input side), split into fresh input, cache reads, cache writes, output from the transcript's last main-thread turn (`session-usage.ts` `contextUsage`) | Claude Code's own categories (system prompt, tools, memory files) are not in the transcript or hooks | - | - | have |
| Effort and fast mode | `model-config`, `fast-mode` | Reasoning in compat routes (`compat/route-model.ts`); effort in the run runtime (`dashboard/packages/agent-runtime/effort.ts`); Automatic picks fast models (`automatic.ts`) | No effort picker in Polar Chat or Code | Map one effort scale to each provider's knob | S | partial |
| Model picker | `model-config` | `web/lib/polar/models.ts`, `components/polar/code-model-picker.tsx`; changeable mid-session in the Code thread for Claude Code, among the models of the source it signs in with (`modelCommand` in `session-commands.ts`: `--model` on the next turn, `/model` in an open interface) | Other CLIs keep the model they started with | | - | have |
| Fallback when a model fails | `model-config` | Router chain with key rotation and cooldowns (`router/chain.ts`, `turn-fallback.ts`); beyond Claude Code | | | - | have |

## 3. Sessions and history

| Claude Code feature | Doc | Polaris today | Gap | Provider-agnostic design note | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Resume / continue / session picker | `sessions` | Chat threads; Code `/resume` and history (`code-commands.ts`, `code-history.ts`) | | | - | have |
| Name, branch, fork | `sessions#branch-a-session` | Rename; Chat versions; Code fork (`session-fork.ts`) | | | - | have |
| Export transcript | `sessions#export-and-locate-session-data` | Chat Markdown or JSON (`web/lib/polar/export.ts`); Code Markdown or JSONL from the thread (`web/lib/polar/code-transcript.ts`, `/api/polar/code/transcript`, `/export [jsonl]` and the session bar's download menu) | - | - | - | have |
| Share a session | `claude-code-on-the-web#share-sessions` | Chat share links (`share.ts`); sessions can be shared (`docs/features/agents.md`) | | | - | have |
| Turns that survive closing the tab | `claude-code-on-the-web` | Chat runs (`runs.ts`); Code sessions run in tmux | | | - | have |
| Queue a message while busy, take it back | `claude-code-on-the-web#take-back-a-queued-message` | `AgentQueuedPrompt` table (`web/lib/agents/session-prompt-queue.ts`): queued while `working`, shown above the reply box on every device, editable or taken back, one sent per `turn.end` | Not exercised in a container | - | - | have |
| Resume a session started in a local terminal | `remote-control#resume-sessions-after-stopping-the-server` | None | | Runner lists transcripts in the CLI's own folder and resumes one in its PTY (phase 2) | M | missing |

## 4. Customization

| Claude Code feature | Doc | Polaris today | Gap | Provider-agnostic design note | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| CLAUDE.md / AGENTS.md project memory | `memory` | Code: the CLI reads it. Chat: project instructions (`web/lib/polar/projects.ts`); Enigma contract into sessions (`core/enigma.ts`) | Polar's own loop reads no repo memory file | Phase 3 loop loads `AGENTS.md`, then `CLAUDE.md`, nested by directory | S | partial |
| Auto memory | `memory` | `polar_remember` memories (`web/lib/polar/memory.ts`) | Per person, not per project | Add a project scope | S | partial |
| Built-in slash commands | `commands` | Code: 12 commands, 5 forwarded per CLI (`code-commands.ts`); Chat slash list (`slash.ts`) | Most of Claude Code's ~110 commands absent; terminal pickers unreachable | Polaris owns pickers (model, resume, permissions) and sends the result as flags or keystrokes | M | partial |
| Custom slash commands | `skills` | Per-person commands (`web/lib/polar/commands.ts`); Enigma's commands (`/gate`, `/handoff`, `/improve`, `/qa` in 1.73.0) read from the pinned release tarball beside its skills (`enigma-catalogue.ts`, stored once per version) and listed in both "/" menus while Enigma is on for the person (`enigma-commands.ts`, `enigma-slash.ts`): Code sends them to the session's agent as typed, Chat offers only those whose instructions need no shell or checkout and loads them like skills (none of the 1.73.0 four qualify) | Not read from the repo; whether a command runs in Chat is read from its instructions, since the package does not say | Read `.claude/commands` and `.agents` equivalents in phase 3 | S | partial |
| Skills | `skills` | Per-person skills, skills.sh and GitHub import, Enigma catalogue (`web/lib/polar/skills/`); handed to Code (`code.ts` `agentSkills`) | | | - | have |
| Hooks (user-defined) | `hooks`, `hooks-guide` | Polaris installs its own hooks into the CLI to observe (`session-hooks.ts`) and answer approvals (`session-permissions.ts`) | No user hooks; none in Polar's loop | One event vocabulary (already normalised in `core/agent-sessions.ts`) fired by the runner for every engine | M | partial |
| Plugins and marketplaces | `plugins/overview`, `plugins/create-marketplace` | Polaris app marketplace exists for apps, not for agent extensions | No bundle of skills + commands + agents + hooks + MCP | Plugin = a folder in Claude Code's manifest shape; installed per person or org; reused by every engine | M | missing |
| MCP client, remote servers with OAuth | `mcp` | Connectors catalog with OAuth (`web/lib/polar/connectors/`), per-server switches (`tool-servers.ts`) | | | - | have |
| MCP client, local stdio servers | `mcp` | None | Needs a machine to run on | Runner spawns stdio servers and bridges them | S after runner | missing |
| Polaris as an MCP server | `mcp` | `web/lib/mcp/`; written into every session (`mcpConfig`) | | | - | have |
| Output styles | `output-styles` | Enigma output style preference (`web/lib/polar/enigma-prefs.ts`), writing settings | No user-defined style files | Style = a system-prompt fragment, same for every provider | S | partial |
| Status line | `statusline` | Line under the Code reply box (`web/lib/polar/code-status.ts`): model, effort, context %, cost, branch, each only when reported | Rate-limit windows not shown | - | - | have |
| Settings precedence (user, project, managed) | `settings` | Policy tiers for runs (`resolveAgentPolicy`, `agent-defaults-service.ts`) | Not for Polar Code or Chat | Reuse the tier resolver | M | partial |
| Keybindings and vim mode | `keybindings` | None | | Low value in a web UI; TUI client only | S | missing |
| Channels: push external events into a session | `channels` | PR comments and CI failures sent back (`session-review-loop.ts`); automations post via webhooks | No generic event into a live session | Automation action "prompt session" | S | partial |
| Notifications when a session needs you | `hooks-guide`, `remote-control#mobile-push-notifications` | Bell and web push, replaced per session (`web/lib/agents/agent-notices.ts`) | | | - | have |

## 5. Permissions and safety

| Claude Code feature | Doc | Polaris today | Gap | Provider-agnostic design note | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Permission modes (default, acceptEdits, plan, auto, dontAsk, bypass) | `permission-modes` | Code: a mode picked at start and changeable mid-session for Claude Code (default, acceptEdits, plan, bypass; `permissionModeCommand` in `session-commands.ts`), else each CLI's bypass flag (`autonomyArgs` in `core/agent-clis.ts`). Chat: always allow / ask per tool (`tool-grants.ts`) | auto and dontAsk not offered; other CLIs keep two modes | Polar's loop implements all six | M | partial |
| Approve a permission prompt from anywhere | `permission-modes` | `PermissionRequest` hook answered from the UI (`session-permissions.ts`), Claude Code only | Other CLIs not covered | Same hook for CLIs that have one; PTY keystroke otherwise | M | partial |
| Allow / deny rules with patterns | `permissions` | Per-tool grants (`tool-grants.ts`) | No `Bash(npm test:*)` style rules | Shared rule grammar evaluated by the runner before any tool runs | M | partial |
| Auto mode (classifier approves safe actions) | `auto-mode-config` | None | | Classifier = a cheap model from the router; denies by default on error | M | missing |
| Sandboxed Bash, network isolation | `sandboxing` | Container per session; private network | No filesystem or network sandbox on the PC | Runner uses OS sandboxing where available; containers stay the default for untrusted repos | L | partial |

## 6. Programmatic, CI and accounting

| Claude Code feature | Doc | Polaris today | Gap | Provider-agnostic design note | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Headless `-p`, JSON / stream-JSON output | `headless` | HTTP: `/api/v1/chat`, `/api/v1/responses`, `/api/v1/messages` (`web/app/api/v1/`) answer one model step | No headless agentic run over the API | `POST /api/v1/code/runs` with stream output, same engine as the UI | M | partial |
| Agent SDK | `agent-sdk/overview` | None | | Publish the phase 3 loop as a package once its tool protocol is stable | L | missing |
| LLM gateway (Claude Code on other models) | `llm-gateway-protocol` | Anthropic- and OpenAI-compatible routes with tier mapping (`web/lib/polar/compat/`, `polar-routing.tsx`) | | | - | have |
| GitHub Actions / @mention bot | `github-actions` | Agents app: triggers, modes, runners (`dashboard/packages/agent-runtime`, `core/agents.ts`) | | | - | have |
| `gh` inside the session | `github-actions` | Pinned GitHub CLI installed at boot (checksum-checked, `web/lib/agents/session-gh.ts`), run through a wrapper that mints a one-repository token per run from the session's credential helper (`GH_TOKEN` only in that process) | Not exercised in a real container yet | | - | have |
| Code Review on pull requests | `code-review` | Review modes and gate (`agent-runtime/modes.ts`, `review-gate.ts`, `core/review.ts`) | | | - | have |
| GitLab CI | `gitlab-ci-cd` | GitLab read through host APIs only (`code-host-tools.ts`) | No GitLab runs | Second host adapter for the Agents app | M | missing |
| Local `/code-review`, `/security-review` | `code-review-local` | Forwarded to Claude Code only (`code-commands.ts`); Enigma gate | Not for other engines | Skill-based review in Polar's loop | S | partial |
| Scheduled tasks (cloud, desktop, `/loop`) | `routines`, `scheduled-tasks` | Event triggers only (`AGENT_TRIGGERS`) | No cron | Cron trigger on the Agents app and on Polar threads | M | partial |
| Cost and usage (`/cost`, `/usage`, `/stats`) | `costs` | Chat usage and spend limits (`web/lib/polar/usage.ts`), session cost from transcript (`session-usage.ts`) | | | - | have |
| OpenTelemetry monitoring | `monitoring-usage` | None | | Emit spans per turn and tool | M | missing |
| Artifacts (shareable pages from a session) | `artifacts` | Polar visuals (`visual-tool.ts`), shared links (`share.ts`) | No page published from a Code session | Session publishes a page into Drive with a share link | M | missing |

## Prior art (OSS)

Every repository below was checked on GitHub on 2026-11-14 and its README read.
`In plan` names the phase that takes the idea.

| Project | Link | License | What it does | Ideas worth taking for Polar | In plan | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Orca | https://github.com/stablyai/orca | MIT | Desktop fleet of vendor CLIs (Claude Code, Codex...) on your subscription; desktop, mobile, remote runtime | Pair a remote server or any SSH host; mobile app pinged when an agent needs you; parallel worktrees; a CLI that can do anything the app does (agents create worktrees, start workers); scheduled automations; computer use | 1, 2, 4, 5 | Polar Code's PTY + hooks design already follows Orca (memory: agent-sessions) |
| Happy | https://github.com/slopus/happy | MIT | Mobile, web and desktop client for Claude, Codex, Grok and ACP agents, with a relay server | End-to-end encrypted relay between devices; reuse the subscriptions already paid for; any ACP agent plugs in as a harness; multiplayer steering of one session; push through APNs/FCM | 1, 5 | Closest match to "control my local Claude Code from the phone" |
| CloudCLI (Claude Code UI) | https://github.com/siteboon/claudecodeui | AGPL-3.0 | Web and mobile UI over Claude Code, OpenCode, Cursor CLI, Codex | Session list and resume over the CLI's own transcripts; file explorer with editing; git stage and commit from the UI; desktop companion app | 2 | AGPL: take ideas only, no code |
| Omnara | https://github.com/omnara-ai/omnara | Apache-2.0 | Self-hostable managed agent platform: any model, tools, skills, memory, subagents | `omnarad` daemon on each machine connects out, so commands run there with no inbound ports; every step stored in Postgres for durable resume; config changed mid-conversation; per-tool permissions; cron triggers; REST API, SDK and CLI | 1, 3, 4, 5 | Architecture nearest to Polaris (server + workers + machine daemon) |
| Vibe Kanban | https://github.com/BloopAI/vibe-kanban | Apache-2.0 | Kanban over 10+ coding agents, a workspace (branch, terminal, dev server) per issue | Inline diff comments sent back to the agent; preview browser with devtools and device emulation; PR with generated description and merge | 0, 4 | Polaris already has the review loop (`session-review-loop.ts`) |
| Crystal | https://github.com/stravu/crystal | MIT | Parallel Codex and Claude Code sessions in git worktrees | Worktree per session, compare approaches side by side | 1 | Deprecated, replaced by Nimbalyst |
| opencode | https://github.com/anomalyco/opencode | MIT | Open-source coding agent, any provider | Built-in `plan` agent that is read-only, a `general` subagent; reference for a provider-agnostic loop | 3 | Moved from `sst/opencode`; already a Polar Code engine |
| Codex CLI | https://github.com/openai/codex | Apache-2.0 | OpenAI's terminal coding agent | Native Windows install via PowerShell; sign-in with the paid plan | 1 | Already a Polar Code engine |
| goose | https://github.com/aaif-goose/goose | Apache-2.0 | Extensible agent on 15+ providers, API keys or existing subscriptions | Custom distributions with preset providers and extensions | 4 | Moved from `block/goose` |
| OpenHands | https://github.com/OpenHands/OpenHands | MIT | Runs OpenHands, Claude Code, Codex, Gemini, OpenCode or any ACP agent locally, remotely or in the cloud | ACP as the one interface to any agent; LLM profiles | 3, 5 | |
| Cline | https://github.com/cline/cline | Apache-2.0 | Coding agent as SDK, IDE extension or CLI | One core shipped three ways, interactive or headless | 5 | Roo Code (`RooCodeInc/Roo-Code`) is archived, dropped |
| Aider | https://github.com/Aider-AI/aider | Apache-2.0 | Terminal pair programmer on almost any LLM, local models included | Repository map for context on large repos | 3 | |
| Crush | https://github.com/charmbracelet/crush | FSL-1.1-MIT | Terminal agent on any OpenAI- or Anthropic-compatible API | Switch model mid-session keeping context; LSP for context | 3 | Source-available, converts to MIT later |
| Continue | https://github.com/continuedev/continue | Apache-2.0 | Open-source coding agent | Nothing beyond the above found in its README | - | |
| Agent Client Protocol | https://github.com/agentclientprotocol/agent-client-protocol | Apache-2.0 | Protocol connecting any editor to any agent | Polar speaks ACP as an agent (editors) and as a client (drives ACP agents) | 3, 5 | Used by Happy and OpenHands |

Techniques several projects converged on, and adopted here:

1. **Outbound-only machine daemon plus a relay.** Claude Code Remote Control
   (`remote-control#connection-and-security`), Omnara's `omnarad`, Happy's relay
   server, Orca's remote server. No inbound port on the PC. Phase 1.
2. **Wrap the vendor CLI in a PTY, observe through its hooks.** Orca, Vibe
   Kanban, CloudCLI, and Polar Code today. Phase 1 reuses it on the PC.
3. **One worktree per parallel session.** Claude Code `worktrees`, Crystal, Vibe
   Kanban, Orca. Phase 1.
4. **ACP as the agent interface.** Happy, OpenHands, Zed. Phases 3 and 5.
5. **Durable step log for resume anywhere.** Claude Code stores the transcript
   server-side while Remote Control is on; Omnara stores every step in Postgres.
   Phase 2.

## Build order

Ordered by what unlocks the most. Each phase is usable on its own.

**Phase 0: finish the vendor-CLI path that already works (S each, about a week
in total).** Todo list decoded and shown; AskUserQuestion answered with buttons;
permission mode picker (default, acceptEdits, plan, bypass) mapped per CLI and
switchable mid-session; plan approval card; status line; queued messages;
`/goal` for Code; effort picker; Code transcript export; agent board.

**Phase 1: the backbone, a runner on the operator's computer plus a relay (L).**

- `polaris-runner`: Windows, macOS, Linux; shipped inside the desktop installer
  and as a standalone service; pairs with the QR device flow and enrolls as a
  trusted device; one outbound WebSocket to Polaris, no inbound port.
- Hosts PTYs for vendor CLIs with the same hooks Polar Code writes in containers
  (`session-hooks.ts`), posting to the runner instead of over SSH.
- New placement "This computer" in `session-placement.ts`; a git worktree per
  session; the machine's own CLI sign-ins, so no credentials leave it.
- Polaris relays prompt, interrupt, approve and terminal through the existing
  session stream (`session-live.ts`); web push already reaches the phone.

Result: start, continue and control Claude Code, Codex or opencode on the PC
from any device. Dispatch, local stdio MCP and PowerShell come free.

**Phase 2: attach to what already runs on the PC (M).** The runner lists the
CLIs' own transcripts and resumes one in its PTY; a `polaris claude` shim starts
the vendor CLI already attached. Teleport both ways (branch + transcript).
Transcript stored on Polaris for resume after a drop.

**Phase 3: Polar's own provider-agnostic coding loop (L).** Extend the Polar
Chat loop with a tool-execution protocol whose tools run on the runner or in a
container: Read, Write, Edit, Glob, Grep, Bash or PowerShell, background tasks,
todo, AskUserQuestion, Task (subagents), plan mode, all six permission modes,
allow and deny rules, file checkpoints, `AGENTS.md` / `CLAUDE.md` loading, user
hooks on the normalised event vocabulary. Runs on any model through the existing
router, so fallback and key rotation come with it. Offered in Polar Code as the
engine "Polar", beside the vendor CLIs.

**Phase 4: extensibility (M each).** Plugins in Claude Code's manifest shape;
output style files; settings precedence; agent teams on the orchestration plan;
cron for the Agents app and Polar threads; channels (automation prompts a live
session); auto mode classifier; advisor tool; Chrome relay as an MCP server for
sessions; network levels for cloud environments.

**Phase 5: more surfaces (L each).** `polaris code` TUI; ACP agent endpoint and a
VS Code extension; headless runs API and an SDK; GitLab; LSP; computer use;
OpenTelemetry; artifacts from sessions.

## Decisions for the operator

1. **Where the runner lives.** Inside the desktop app only (simplest, stops when
   the app quits), or a system service installed with it (keeps running, like
   the VPN helper does). Recommended: system service, installed by the desktop
   app, also available alone for headless machines.
2. **Windows execution.** Native PowerShell, or require WSL 2 for the
   Linux-shaped CLIs. Recommended: native first, WSL as an option per session.
3. **Driving Claude Code on the PC.** Through Polaris's runner (PTY + hooks, any
   CLI, any provider, needs nothing from Anthropic), or through Claude Code's own
   Remote Control (needs a claude.ai subscription and routes through Anthropic,
   `remote-control#requirements`). Recommended: runner; it is the only path that
   works for every engine.
4. **Transcript storage while relayed.** Stored on Polaris (resume after a drop,
   history on every device) or end-to-end encrypted pass-through as Happy does
   (Polaris cannot read it, no server-side history). Recommended: stored, since
   Polaris is self-hosted by the same operator.
5. **What a remote device may approve.** Whether a phone may switch a local
   session to bypass mode or approve Bash, or only answer prompts. Recommended:
   prompts yes, bypass only from a trusted device with a second factor.
6. **Polar's loop: build or adopt.** Extend Polar Chat's loop (one router, one
   UI, most work) or embed opencode as the provider-agnostic engine and spend the
   effort on the runner. Recommended: phase 3 on Polar's own loop, since the
   router, tools, skills and connectors already live there; opencode stays as an
   engine.

## 7. Daily-driver parity: Enigma, multi-account, memory, effort (researched 2026-11-15)

The bar: an operator who runs Claude Code through Enigma every day (several
accounts, hooks, gate, skills, recall, code graph, handoff, subagents, `gh`)
starts the same model in Polar Code and notices no difference, except that it
keeps running with the PC off and can be steered from any device. Codex,
opencode and the other engines get the same treatment where their CLIs allow.

Sources for this section: `enigma --help` and `enigma <cmd> --help` for the
commands named below (Enigma 1.73.x on the dev machine), the operator's
`~/.claude/settings.json` (hooks, status line, permissions and env keys only,
no values), the Enigma repository README and `docs/notes/` (`multi-account.md`,
`local-api-server.md`, `recall.md`, `handoff.md`, `host-integration.md`), and
the Polaris files cited per row. Nothing here was exercised in a container (no
Docker on this machine).

### 7.1 What Enigma gives the operator every day

| Capability | Command / mechanism | What it gives daily |
| --- | --- | --- |
| Multi-account | `enigma account add/use/login/transfer/sessions`, `enigma <tool> <account>` | Several logins per tool (Claude, Codex, opencode, Kimi), each in its own config dir (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, an XDG pair), switched without logging out; every account inherits skills, memory file and mirrored settings; `transfer` reuses a live OAuth login without the refresh-token ping-pong |
| Cross-account transcripts | config `share-sessions` (default on) or `shared-store` | A conversation recorded under account A resumes under account B (`--resume` sees it), so switching accounts mid-task keeps the thread |
| Profiles | `enigma profile add/use/set` | One account per tool pinned under a name ("work" = claude:acme + codex:acme) |
| Account rotation | `enigma api --rotation round-robin/least-used/fill-first/random`, `api-account-pool` | On a usage limit (429, `rate_limit_error`, limit wording) the account cools down (reported reset, else 2 min doubling to 30 min) and the request reruns on the next account; overload (529) is deliberately not a trigger; streams hold back the first 160 chars so the retry is invisible. Only in the local API, not in interactive sessions |
| Skills and operating contract | `enigma install`, `enigma skills` | Policy skills plus the CLAUDE.md contract in every agent |
| Hooks | settings.json: `PostToolUse` Edit/Write -> `__post-edit-hook` (guardrails, trim); `PreToolUse` Bash -> `__attribution-guard`, `__push-guard`, `__browser-guard`; `PreToolUse` Agent/Task + `SubagentStart/Stop` -> `__subagent-hook`; `Stop` -> `__verify-hook`, `__codegraph-hook stop`; `SessionStart` -> `__codegraph-hook`, `__handoff-hook claude` (startup, clear); `UserPromptSubmit` -> `__codegraph-hook prompt`; `PostToolUse` Bash -> `__ci-hook rewake` | Conventions enforced after every edit, no co-author trailers, guarded pushes, headless-only browsers, subagent bounds, unfinished-work check at turn end, a CI watch that wakes the agent |
| Gate | `enigma gate axi run` (`/gate`) | Review, tests, lint, docs, push, PR and CI before work lands |
| Verify | `enigma verify [--all]`, `verify parity` | Turn-end check for stubs and unfinished markers plus the project's verify command |
| Guardrails | `enigma guardrails list/check/stats` | Convention rules (UUID keys, Prisma default...) checked by the post-edit hook |
| Recall | `enigma recall sync/search/...`, MCP `enigma_recall*` | Hybrid keyword + vector memory built from the person's own transcripts (Claude and Codex rollouts), scoped to the current project (`basename(cwd)`) |
| Code graph | `enigma codegraph index/ask/callers/skeleton/map/grep/report`, MCP | Structural code intelligence; a `report` page a new session reads; refreshed by the prompt and stop hooks |
| Handoff and relay | `enigma handoff save/show`, `/handoff`, `enigma relay "<task>"` | One page per git root (`~/.enigma/handoff/<sha1(root)>.md`) delivered once to the next fresh session; `relay` chains fresh headless sessions through handoffs |
| Compression | `enigma compress`, MCP `enigma_compress/retrieve` | Fewer tokens on logs and JSON, reversible |
| Status line | `enigma statusline` (settings `statusLine`) | Badge, model, context, cost, live gate progress |
| Isolated agents | `enigma agent install/run` (Helio, Orion, Vega) | Specialist agents whose skills and MCP servers never load into the normal one |
| Config | `enigma config set k=v`; keys include `parallel-subagents`, `subagent-limit`, `subagent-turns`, `compact-window`, `output-style`, `minimal-code`, `bypass-*` | Subagent fan-out limits, compaction window, terse output |
| Host integration | `enigma config --json`, `enigma memory render`, `enigma serve --http --data-dir --token-file` | A multi-tenant JSON API for recall, code graph and compression (`X-Enigma-Tenant`), built for Polaris; single writer per store |

Plain Claude Code settings the operator also relies on: `model: opus[1m]`,
`autoCompactWindow: 400000`, `permissions.defaultMode: bypassPermissions` with
19 deny rules, three plugins (one an LSP), voice dictation.

Finding on the operator's own machine: the `PreToolUse` Bash matcher holds
`__attribution-guard` 10 times, `__browser-guard` 30 times and `__push-guard`
twice, so every Bash call spawns about 42 hook processes. Repeated
`enigma install` runs appear to append rather than merge. This matters for
Polar too: a session home now persists (7.2), and the boot runs
`enigma install` every time (`core/enigma.ts:412-440`), so the same growth can
happen there. To check against Enigma 1.73.0 before relying on persisted homes.

### 7.2 What Polar Code sessions get from Enigma today

| Enigma capability | In Polar sessions today | Where | Gap | Design note |
| --- | --- | --- | --- | --- |
| Install + skills + contract | have | `core/enigma.ts:361` (`enigmaSetupScript`, checksum-pinned release), `:412-440` (`enigmaConfigureScript`); boot `web/lib/agents/session-commands.ts:1112-1123` | - | - |
| Hooks (post-edit, verify, guards, subagent, codegraph, handoff) | partial | Scope `all` wires them; scope `policies` passes `--no-hooks` and skips `commands,dashboard,statusline,mcp` (`core/enigma.ts:213-220`) | The policies scope loses every hook | Fine as an explicit choice; the scope picker should say the hooks go with it |
| Gate | have | `core/enigma.ts:287` (`enigmaGateArgv`), applied in `enigmaConfigureScript` | Not exercised in a container | - |
| Config keys | have | `core/enigma.ts:271` (`enigmaConfigArgv`, key/value allowlist) | - | - |
| Launcher (`enigma claude`) | have | `web/lib/agents/session-runtime.ts:238`; boot falls back to the bare binary, `session-commands.ts:1165-1176` | - | - |
| Multi-account on the box | partial | Home kept per owner per box: `session-commands.ts:109` (`AGENT_HOME`), `:119` (`agentHomeSource` = `agent-homes/u-<owner>`), bind in `web/lib/agents/session-container.ts:60-80`; the boot tells the person `enigma account add` exists (`session-commands.ts:1175`) | Accounts made with `enigma account` live on one box only; Polaris's own stored sign-ins (`web/lib/agents/model-keys.ts:1080` `signinAccountsFor`) are a separate list; neither rotates | One account list: Polaris's stored sign-ins, written into the home per turn (already done by `refreshCredentials`, `session-runtime.ts:419`) |
| Rotation on a usage limit | have, not exercised in a container | `web/lib/agents/account-rotation.ts` (`limitOf` classifier, Enigma-style cooling, `handleTurnFailure`, `resumeLimitedSessions` on the `agent-queue` cron), wired from `web/app/api/agents/sessions/[id]/events/route.ts` | The failed turn is re-sent through the prompt queue, so a session whose agent interface is open keeps the credentials its running process started with until it is relaunched; no per-session "switch accounts on a limit" setting yet; no proactive switch at a threshold | 7.5 item 2 |
| Auto memory (CLI) | partial, keyed wrong | `~/.claude/projects/<project>/memory/` lands in the persisted home, so it survives on the same box. But a repository checkout is always `/session/repo` (`session-runtime.ts:77`), and Claude Code derives `<project>` from the git repository path (`memory#storage-location`), so every repository of one owner on one box shares ONE memory dir | Cross-repo bleed on one box; nothing on another box of the pool or after a home reset | 7.5 item 1 |
| Handoff | partial, keyed wrong | Same home; Enigma keys it by `sha1(git root)` (`handoff.md`), and the root is always `/session/repo` | A handoff saved in repo A can be delivered to the next fresh session of repo B | 7.5 item 1 |
| Recall | missing in practice | Recall is opt-in (`config recall`) and Polaris does not turn it on; its project key is `basename(cwd)` = `repo` for every repository | No past-session memory; switched on, every repository would be one project | 7.5 item 1: seed from Polaris's stored Code history (`web/lib/agents/session-history.ts`) or call `enigma serve` with tenant = person |
| Code graph | partial | Hooks index on prompt and stop when scope is `all`; the index lives in the persisted home | Rebuilt per box; project key collides the same way | Same keying fix |
| Status line | missing in the UI | `statusline` skipped for scope `policies`; with `all` it renders only inside the terminal | Polar's thread has no footer | Phase 0 status line row (section 4) reads model, context and cost Polaris already has (`session-usage.ts`) |
| Subagents | have (the CLI's own), observed | `SubagentStop` observed (`session-hooks.ts`); Enigma `__subagent-hook` with scope `all` | Tree view in flight (slash2) | - |
| `gh` | have, unverified | `web/lib/agents/session-gh.ts` | The person's own `gh` login is not reused | Goal ledger G8 |
| Effort | missing | The model picker hides intelligence for agent sessions (`web/components/polar/elements/model-selector.tsx:199`); only `--model` is passed (`core.agentModelArgs`, `session-runtime.ts:241`) | No `--effort` / `-c model_reasoning_effort=` / `--variant` | 7.4 |
| Queued prompts | partial | The machine already queues a prompt as a file when the runner takes prompts (`session-commands.ts:964` `queuePromptCommand`, used by `promptSession`, `session-runtime.ts:950`) | No visible queue, no take-back | 7.5 item 4 |

Confirmed gaps from the goal ledger:

- **(a) Memory does not follow the work.** It persists only per owner per box,
  under a key that is the same for every repository, and nothing (auto memory,
  handoff, recall, code graph) is carried to another box or survives a home
  reset. Claude Code's docs say auto memory is machine-local and "not shared
  across machines or cloud environments" (`memory#storage-location`), so this
  is Polaris's to solve.
- **(b) No account switch on a usage limit.** Claude Code reports the cause as
  the `StopFailure` matcher value `rate_limit` (others: `overloaded`,
  `authentication_failed`, `billing_error`, `account_on_hold`...; `hooks`), and
  Polaris already receives that event, but only refusals are acted on. The
  pieces to rotate exist: credentials are re-resolved before every prompt
  (`refreshCredentials`, `session-runtime.ts:419`), the session carries an
  `accountId` (`session-runtime.ts:378`), refused accounts are cooled the way
  the router cools keys (`signin-refusal.ts`, `COOLING_MS`), and Enigma's
  `api-rotation.ts` has the classifier and backoff to copy.

### 7.3 How people actually work with these tools (sources read 2026-11-15)

| Pattern | What the vendors and tools do | Source | What Polar takes |
| --- | --- | --- | --- |
| Cloud session while the laptop is shut | Claude Code cloud sessions keep running and are steered from web, phone, desktop, or `claude -p "msg" --cloud <id>`; history is restored when an idle VM is reclaimed, background shells and subagents are not | https://code.claude.com/docs/en/claude-code-on-the-web | Already the model; add "send a follow-up" to a running session from the CLI and the phone |
| Queued message, take back | A message sent while Claude works queues; the X on it returns the text to the box until Claude reads it | same page, "Take back a queued message" | 7.5 item 4 |
| Cloud to local | `claude --teleport` pulls branch + conversation; the local copy then diverges; terminal to cloud only through the Desktop app | same page | Phase 2 teleport both ways |
| Remote Control of a local session | `claude remote-control` (server mode, URL + QR on spacebar, `--spawn same-dir/worktree`), `claude --rc`, `/rc`; conversation and subagent progress in sync on every device; filesystem and MCP stay local. Needs a claude.ai subscription; unavailable with an API key, with `ANTHROPIC_BASE_URL` pointed at a gateway, or with feature flags off | https://code.claude.com/docs/en/remote-control | Confirms decision 3: Polaris's runner is the only path that works for every engine and for sessions on Polaris's own gateway |
| Codex in the cloud | A workspace per task that keeps running while the computer sleeps; environments with install script, network level, secrets; `codex cloud` picker, `codex cloud exec --env <id> --attempts 1-4` (best-of-N), `codex apply <task>` | https://learn.chatgpt.com/docs/cloud, https://learn.chatgpt.com/docs/developer-commands?surface=cli | `apply` is teleport of a diff |
| Codex remote control | `codex remote-control start/stop/pair` (experimental), `codex app-server --listen ws://...`, `codex --remote <ws-url>`, `codex resume --remote` | developer-commands page above | The runner can drive Codex through its app-server instead of a PTY where present |
| opencode headless | `opencode serve` (OpenAPI 3.1, `127.0.0.1:4096`, basic auth by `OPENCODE_SERVER_PASSWORD`), SSE `/event`; the TUI is a client of the same server | https://opencode.ai/docs/server/ | Same: structured control instead of keystrokes |
| Phone clients for local agents | Happy (E2E relay, Claude/Codex/ACP), Omnara (`omnarad` outbound daemon), Orca (fleet + mobile ping) | Prior art table above | Phase 1 relay shape |
| Parallel local sessions | claude-squad: tmux + a git worktree per session, background auto-yes (`-y`), review before apply; AGPL-3.0 (ideas only) | https://github.com/smtg-ai/claude-squad | Worktree per runner session |
| Multi-account switching | No native Claude Code feature (open request). Community: claude-swap (`auto` loop polls every 60 s, takes Claude Code's credential lock), ccswap (`auto` on a usage threshold), clauth (fallback chain while open), teamclaude (proxy, switches at 98 % quota), ccdaddy, cux (drain / balanced / manual) | Web search summary, repositories not individually read: https://github.com/realiti4/claude-swap, https://awesome.ecosyste.ms/projects/github.com%2Fipfans%2Fccswap, https://docs.rs/crate/clauth/0.7.3, https://awesome.ecosyste.ms/projects/github.com%2Fkarpeleslab%2Fteamclaude, https://github.com/anthropics/claude-code/issues/64376 | Two converged strategies: switch on the limit error (reactive) and switch before it from a usage threshold (proactive). Polar does reactive first, proactive once the 5-hour window is read |
| Gateway with key pools | claude-code-router: one local endpoint for Claude Code and Codex, credential pools, key rotation, ordered fallback models (MIT) | https://github.com/musistudio/claude-code-router | Polaris's compat API + router already does this for API keys (`router/chain.ts`); subscriptions need the session-level rotation instead |
| Usage windows | ccusage: reads the local transcripts of 19 tools; daily, monthly, session reports and Claude's 5-hour blocks; a status line (MIT) | https://github.com/ryoppippi/ccusage | Proactive rotation and the status line read the same 5-hour window from `session-usage.ts` |
| Memory | Claude Code: CLAUDE.md + auto memory (first 200 lines / 25 KB of `MEMORY.md`), per repository, machine-local, relocatable with `autoMemoryDirectory`; subagents get `memory: user/project/local` dirs | https://code.claude.com/docs/en/memory, https://code.claude.com/docs/en/sub-agents | 7.5 item 1 uses `autoMemoryDirectory` |
| Effort | Claude Code: `low/medium/high/xhigh/max`, `/effort`, `--effort`, `CLAUDE_CODE_EFFORT_LEVEL`, per-model `modelSettings`, subagent and skill frontmatter `effort`; `ultrathink` raises one turn to `xhigh`; Opus 5.5 defaults to `medium` | https://code.claude.com/docs/en/model-config | 7.4 |

### 7.4 Effort and deep-thinking UX spec

What the references do:

- **DeepSeek chat-demo** (https://github.com/deepseek-ai/chat-demo, MIT): two
  pill toggles in the row under the input, left of voice and send:
  "DeepThink" (tooltip "Think before responding to solve reasoning problems")
  and "Search", each a `button` with `aria-pressed`
  (`src/components/chatInput/ChatInput.tsx:203-228`). The choice is a global
  setting kept in localStorage (`src/services/settings.ts`, key
  `chat-demo:thinking`) and sent as `thinking: {type: "enabled" | "disabled"}`
  on an Anthropic-compatible Messages request (`src/services/api/types.ts:175-183`;
  models `deepseek-flash`, `deepseek-v4-pro`). Thinking streams as its own
  block and the reply shows "Thought for N seconds".
- **Provider knobs** (official docs read, except where noted):

| Provider | Parameter | Levels | Default | Notes |
| --- | --- | --- | --- | --- |
| Anthropic | `output_config.effort` | `low`, `medium`, `high`, `xhigh`, `max` (per model) | `medium` on Opus 5.5 and Haiku 5.5, `high` elsewhere | Adaptive thinking always on for Opus 5.5 (disabling it is a 400); changing top-level effort mid-conversation can break the prompt cache, per-message effort keeps it. https://platform.claude.com/docs/en/build-with-claude/effort |
| OpenAI | `reasoning.effort` (Responses), `reasoning_effort` (Chat) | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (per model) | model-dependent, `medium` on GPT-5.5 and 5.6 | Some models refuse `none` or `minimal`. https://developers.openai.com/api/docs/guides/reasoning |
| DeepSeek | `thinking: {type}` + `reasoning_effort` (OpenAI shape), or `output_config.effort` / `reasoning.effort: none` (Anthropic shape) | `low`, `high`, `max`; `minimal` -> low, `medium` and `xhigh` -> high | thinking on, `high` | https://api-docs.deepseek.com/guides/thinking_mode |
| Google | `thinking_level` | `minimal`, `low`, `medium`, `high`, `xhigh` (per model) | per model (medium or high) | `thinkingBudget` is not on the page read. https://aistudio.google.com/docs/thinking |
| Codex CLI | `model_reasoning_effort` (config or `-c`) | `minimal` .. `xhigh` | - | Values from secondary sources only; verify against the official config reference before shipping |
| Claude Code CLI | `--effort`, `/effort <level>`, `CLAUDE_CODE_EFFORT_LEVEL` | as Anthropic | as Anthropic | `ultrathink` = one turn at `xhigh` |

Polaris already has the axis: Chat's composer "intelligence"
(`fast/balanced/deep/max`, `web/lib/polar/shared.ts:17`) maps to AI SDK levels
(`web/lib/polar/models.ts:237`), routes can force a level
(`web/lib/polar/routing.ts:25`), compat requests map names
(`web/lib/polar/compat/anthropic-request.ts:384`), and the Agents runtime stores
effort as a position on [0, 1] resolved against each model's published ladder,
rounding down (`dashboard/packages/agent-runtime/effort.ts:45,92`). So the
section 2 row "No effort picker in Polar Chat or Code" is half true: Chat has
one, inside the model menu, with four steps; Code has none.

The spec:

| Element | Decision |
| --- | --- |
| Where | A pill beside the model chip in the composer row, in Chat and in Code (DeepSeek's position), not only inside the model menu. One click opens a segmented control; the pill shows the current label |
| Levels shown | The ladder of the selected model, labelled Fast, Balanced, Deep, Extra deep, Max; steps the model does not publish are hidden, never greyed; a model that does not reason shows no pill |
| Storage | The position on [0, 1] (`agent-runtime/effort.ts`), per person and per model like Claude Code's `modelSettings`; a thread remembers its own last value |
| Deep-thinking toggle | Where thinking is a switch rather than a ladder (DeepSeek, Haiku at `high` or below), the pill becomes an on/off "Think" toggle in the same place |
| One-turn boost | Typing `ultrathink`, or a "Think harder" action on a reply, runs that one turn at `xhigh` (Claude Code parity) without changing the saved level |
| Mapping | Anthropic `output_config.effort` (Code: `--effort`); OpenAI `reasoning.effort` / `reasoning_effort`; DeepSeek `thinking` + `reasoning_effort`; Gemini `thinking_level`; Codex `-c model_reasoning_effort=`; opencode `--variant` (already in `agent-runtime`). Always through `resolveRung`, so no provider receives a level it lacks |
| Automatic (router) | Effort follows the tier the router picks: fast models at low, one step up on a retry after a failed or truncated turn, `xhigh` for long agentic runs; a forced route level (`routing.ts`) wins over Automatic; the person's explicit pick wins over both |
| Cache | Change effort only at a turn boundary; on Anthropic models that support it, send the change per message so the cache holds |
| Code sessions | A start flag per CLI; mid-session for Claude Code send `/effort <level>` the way the model change is sent (`changeSessionModel`, `session-runtime.ts:1038`); other CLIs take it on the next relaunch |
| Caps | An org cap (like Claude Code's `maxEffortLevel`) clamps the ladder; the pill says why a step is missing |

### 7.5 Build list, in order

| # | Item | Size | Files | Notes |
| --- | --- | --- | --- | --- |
| 1 | **Memory that follows the person and the repository.** (a) Key every per-repo store by the repository: `autoMemoryDirectory` = `~/.polaris/memory/<owner>__<repo>` in the settings Polaris writes for the CLI, and the checkout at `/session/<owner>__<repo>` (or the same key exported for Enigma), so handoff (`sha1(root)`), recall (`basename(cwd)`) and code graph stop colliding. (b) Carry it across boxes: on save, pack the memory dir, the handoff page and the code-graph report into a per person + repo store; on boot, restore them before the agent starts. (c) Turn recall on and seed it from stored Code transcripts, or call `enigma serve` with tenant = person. (d) The same for Codex (`AGENTS.md` + Enigma handoff) and for Polar Chat projects | M | `web/lib/agents/session-runtime.ts` (`CONTAINER_WORKDIR`, boot env), `web/lib/agents/session-commands.ts` (`START_AGENT` restore and save steps), `web/lib/agents/session-hooks.ts` (settings it writes), `web/lib/agents/session-work.ts` (save), `web/lib/agents/session-history.ts` (seed), `core/enigma.ts` (recall config key), new `web/lib/agents/session-memory.ts`, a Prisma model for the store, tests beside each | Fixes a live cross-repo bleed before adding anything; the per-box copy stays as the fast path. **(a) and (b) built 2026-11-15 for container sessions** (one person, own home): checkout at `/session/repos/<owner>__<name>` (`session-memory.ts` `repoCheckoutDir`; sessions started earlier keep their stored workdir), `autoMemoryDirectory` = `/home/node/.polaris/memory/<owner>__<name>`, and `memory-sync.sh` restores before the agent starts and uploads after each Stop/SessionEnd to `/api/agents/sessions/:id/memory` (hook token; stored per person + repo in `AgentRepoMemory`, 2 MB cap). Handoff pages are matched by the `root` in their `.json`, not by a guessed hash. Shown and cleared in the repository dialog. Not yet: server sessions, shared homes, recall index, code-graph report, Codex. Not exercised in a container |
| 2 | **Account rotation on a usage limit.** On `turn.failed` whose hook error is `rate_limit` or limit wording (port Enigma's `classifyAccountError`), cool the account until its reported reset (else 2 min doubling to 30 min), set the session's `accountId` to the next usable sign-in of that CLI in the person's order, refresh credentials, and resume the same conversation with a "continue" prompt (open interface: relaunch with `--resume <vendor id>` through `resumeAgent`, `session-runtime.ts:1100`). A notice in the thread names both accounts. All accounts cooling: say when the first frees and queue the prompt. Never on `overloaded` | M | `web/app/api/agents/sessions/[id]/events/route.ts`, new `web/lib/agents/account-rotation.ts` (classifier + pick, pure, tested), `web/lib/agents/signin-refusal.ts` (shared cooling), `web/lib/agents/model-keys.ts` (`signinAccountsFor`, order), `web/lib/agents/session-runtime.ts` (`refreshCredentials`, `resumeAgent`), a session setting "switch accounts on a limit" (default on with two or more sign-ins) | Proactive switch at a 5-hour threshold later, from `session-usage.ts` |
| 3 | **Effort picker** per 7.4 | S | `web/components/polar/elements/model-selector.tsx` (pill; drop the agent-session exclusion), `web/lib/polar/shared.ts`, `web/lib/polar/models.ts`, `core/agent-clis.ts` (effort args per CLI), `web/lib/agents/session-runtime.ts` (start flag, mid-session `/effort`), `dashboard/packages/agent-runtime/effort.ts` (reuse), i18n tables | - |
| 4 | **Queued messages with take-back.** Store queued prompts on the session; show them above the reply box with an X; deliver on idle through the existing `queuePromptCommand` | S | `web/lib/agents/session-runtime.ts` (`promptSession`), `web/lib/agents/session-service.ts`, `web/components/polar/polar-code.tsx`, a Prisma field | - |
| 5 | **Live multi-device sync, pushed.** `web/lib/agents/session-live.ts` is an in-process EventEmitter, and the page keeps a poll because changes made by another process are missed (`web/components/polar/polar-code.tsx:1201`). Publish session changes on a cross-process bus (Postgres `LISTEN/NOTIFY` on the existing database) and stream them; the poll becomes a slow safety net | M | `web/lib/agents/session-live.ts`, `web/app/api/agents/sessions/[id]/live/route.ts`, `web/components/polar/polar-code.tsx`, `web/components/polar/polar-code-workspace.tsx` | Prerequisite for runner sessions, whose events arrive from outside the web process |
| 6 | **Runner phase 1** (see "Build order", phase 1). (a) `polaris-runner` as a system service installed by the desktop app, also standalone; (b) one outbound WebSocket to Polaris, reconnecting, no inbound port; (c) a PTY host running the same hook script as containers, plus structured control where the CLI offers it (`codex app-server`, `opencode serve`); (d) placement "This computer" with a git worktree per session; (e) pairing by the QR device flow, enrolled as a trusted device | L | new `runner/` package; `desktop/src/main/` (installer, service registration, tray state); `web/lib/agents/session-placement.ts`; `web/lib/cli/sign-in.ts` (pairing); `web/app/(app)/account/sessions/trusted-devices-card.tsx`; a new `web/app/api/runner/` WebSocket endpoint; `web/lib/agents/session-hooks.ts` (hook target) | Decisions 1, 2 and 5 above still apply |
| 7 | **Attach to sessions already running on the PC** (phase 2). The runner lists the CLIs' transcripts (Claude `~/.claude/projects`, every Enigma account dir, Codex rollouts), resumes one in its PTY, and a `polaris claude` shim starts new ones attached; the transcript is stored on Polaris | M | `runner/` (transcript readers), `web/lib/agents/session-history.ts`, `web/lib/polar/code-history.ts`, `web/components/polar/polar-code.tsx` | Enigma's per-account dirs are the case to test |

Order rationale: 1 and 2 are what the operator hits every day in today's
cloud sessions (forgetting, and stopping on a limit), and both reuse pieces
that exist. 3 and 4 are small and close Phase 0. 5 has to land before 6,
because runner events come from outside the web process. 6 and 7 are the "the
PC is the machine" half.

## 8. Built-in slash commands (inventory 2026-11-15)

Source: Claude Code's command reference (https://code.claude.com/docs/en/commands)
and the /goal page (https://code.claude.com/docs/en/goal), read 2026-11-15. Code
sessions run the real CLI, so a command is either run by Polaris
(`lib/polar/code-commands.ts`, `LOCAL`) or typed into the CLI in its own spelling
(`FORWARDED`). A command that opens a picker inside the terminal is never typed:
nothing here can answer that picker, so it gets Polaris's own control or is not
applicable. Bundled skills (/run, /verify, /debug, /batch, /loop, /dataviz,
/design, /slides...) are skills, not commands: they reach a session through
Polar's skills and the person's own "/" commands, so they are not listed one by one.

"Owned elsewhere" = being built by another change at the time of writing.

| Command | What it does | Polar Chat | Polar Code | Decision |
| --- | --- | --- | --- | --- |
| /goal [condition\|clear] | Keep working across turns until a condition holds, judged after each turn | Built (`goals.ts`) | Built | Polaris runs it for every CLI: kept on `AgentSession.goal`, judged on `turn.end` (`lib/agents/session-goal.ts`), continued through the normal prompt path, bar above the composer |
| /help | List commands | Built | Built | Opens the "/" list |
| /clear [name] | Empty context | Built (new chat) | Built | Handed to the CLI (`/new` on Codex and opencode) |
| /compact [instructions] | Summarize to free context | Built | Built | Handed to the CLI (`/compress` on Gemini) |
| /context | Context usage grid | Built | Context bar | Owned elsewhere |
| /usage, /cost, /stats | Session cost and plan limits | Built (/usage) | Not built | Owned elsewhere with the status line work; the CLI's /usage opens a dialog |
| /model [model] | Switch model | Built (picker) | Start: built; running: model pill | Polaris UI; the CLI picker is never typed |
| /effort | Reasoning effort | Effort pill | Effort pill | Already built |
| /permissions | Allow/ask/deny rules | Tool grants | Mode pill and approvals card | Polaris UI; rules are Polaris's own approvals, not the CLI's dialog |
| /plan [description] | Enter plan mode, optionally with a task | n/a | Built (Claude Code) | Handed to Claude Code with its words; the mode pill follows the reported mode |
| /review, /code-review | Review a PR or the diff | n/a | Built (Claude Code) | Handed over |
| /security-review | Security review of the branch | n/a | Built (Claude Code) | Handed over |
| /simplify [target] | Clean up the changed code | n/a | Built (Claude Code) | Handed over |
| /init | Write CLAUDE.md | n/a | Built | Handed over (Claude Code, Codex, opencode) |
| /diff | Review working-tree changes | n/a | Built | Opens the workspace's changes |
| /rename [name] | Rename the session | Built | Built | Polaris history title |
| /resume [session] | Resume a conversation | Built | Built | Opens Polaris history |
| /stop | Stop the current turn | Built | Built | Polaris interrupt |
| /exit | End the CLI | n/a | Built | Ends the session (same as Stop on its page); Continue starts a new one on the branch |
| /copy [N] | Copy the Nth newest answer | Built | Built | Polaris, to the clipboard |
| /export [filename] | Export the conversation | Built | Not built | Owned elsewhere (transcript export) |
| /branch [name], /fork [prompt] | Branch the conversation | Built (/branch) | Continue on an ended session | Not built for a running session: the CLI forks into its own background session Polaris does not track |
| /memory | Edit CLAUDE.md, auto memory | Built | Not built | Repository memory is Polaris's (`repo-memory-store.ts`); the CLI's editor is a picker |
| /rewind | Restore an earlier point | Not built | Not built | Picker in the terminal; checkpoints live in the CLI |
| /btw [question] | Side question outside the conversation | n/a | Not built | Overlay in the terminal; ask Polar Chat beside the session instead |
| /recap | One-line session summary | n/a | Not built | Printed in the terminal, never in the transcript Polaris reads |
| /agents, /list-agents, /tasks, /subtask | Subagents and background work | n/a | Not built | Owned elsewhere (subagent tree) |
| /mcp, /hooks, /skills, /plugin, /reload-*, /config, /status, /output-style | Configure the CLI | Polaris settings | Not applicable | Polaris writes the session's MCP config, hooks and skills at boot (`session-runtime.ts`); the dialogs are pickers |
| /add-dir, /cd | Working directories | n/a | Not applicable | One checkout per session container |
| /login, /logout, /setup-bedrock, /setup-vertex, /web-setup | Accounts and providers | n/a | Not applicable | Sign-ins and keys are Polaris's (Agents keys screen, account rotation) |
| /doctor, /heapdump, /debug, /bug, /feedback, /insights, /team-onboarding | Diagnostics and reports | n/a | Not applicable | About the local install; Polaris owns the session's machine |
| /background, /desktop, /teleport, /remote-control, /remote-env, /mobile, /restart, /upgrade, /usage-credits, /rate-limit-options, /passes, /privacy-settings, /install-github-app, /install-slack-app, /autofix-pr, /ultrareview, /schedule, /artifacts, /chrome, /import, /advisor, /fast, /autocompact, /auto-mode-setup, /sandbox | Anthropic account, apps and local-terminal features | n/a | Not applicable | Tied to an Anthropic account or the local terminal; Polaris has its own equivalents (sessions page, limits, GitHub app) where one exists |
| /theme, /color, /tui, /focus, /vim, /keybindings, /terminal-setup, /scroll-speed, /statusline, /voice, /ide, /radio, /stickers, /powerup, /release-notes | Terminal look and extras | n/a | Not applicable | Terminal only; status line owned elsewhere |
