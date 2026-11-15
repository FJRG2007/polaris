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
| AskUserQuestion with choices | `tools-reference` | Card with numbered options, multi-select, free text and Skip (`polar-code-asks.tsx`); the PreToolUse hook waits for the answer and returns `updatedInput` (`session-hooks.ts`, `session-permissions.ts`) | Claude Code only; not exercised in a real container yet | Same card for Polar's loop | - | have |
| Plan mode and plan review | `permission-modes#analyze-before-you-edit-with-plan-mode` | Plan mode is a picked permission mode (`--permission-mode plan`); ExitPlanMode shown as a plan card with Approve or Keep planning (`polar-code-asks.tsx`) | Claude Code only; Polar's loop has no plan mode | Polar's loop withholds write tools until the plan is approved | M | partial |
| Subagents (custom agents in `.claude/agents`) | `sub-agents` | `polar_task` in Polar's own loop (`web/lib/polar/subagents`): a child run with its own context, a subset of the parent's tools (`tools.ts`: never more; approval-gated tools run only on a standing grant, none for `explore`) and its own model through the router, any provider; returns only its report (`toModelOutput`). Parallel calls, `background` (bell notice + report injected into the next turn), `resume` by id, steering while running. Types: built-in `general`, read-only `explore`, and each Polar agent with a description (`agents/store.ts`). Bounds: depth 1, 4 running per person, 8 per turn, 16 steps, 400k tokens, 15 min; the parent's stop stops foreground children. Runs persisted (`PolarSubagentRun`); cards, list and transcript in the chat (`components/polar/polar-subagents.tsx`). Technique: Claude Code's Task tool + opencode's `mode: subagent` agents (description-driven delegation, per-agent tools and model). `SubagentStop` observed (`session-hooks.ts`); coordinator and worker sessions (`orchestration-service.ts`) | Live list is polled (2.5 s) rather than pushed; definitions are not read from repo agent files; a custom agent's connector list does not narrow a child further than the parent | Push list updates over the run stream; read `.claude/agents` from a Code task's repository | S | partial |
| Agent view / many sessions at once | `agent-view` | Code history beside chats (`web/lib/polar/code-history.ts`), background chat runs (`web/lib/polar/runs.ts`), a per-chat list of running and ended subagents (`polar-subagents.tsx`), capacity and queue | No board of all sessions with state | Board over `AgentSession` state that already exists | S | partial |
| Agent teams and cross-session messaging | `agent-teams`, `cross-session-messaging` | MCP tools to list, start, read and prompt sessions (`web/lib/mcp/tools/sessions.ts`, `orchestration.ts`) | No shared task list across a team | Reuse orchestration plan as the shared list | M | partial |
| Dynamic workflows (scripted subagent fan-out) | `workflows` | Orchestration plan graph (`web/lib/agents/orchestration-plan.ts`) | No rerunnable script | Later; orchestration covers the common case | L | partial |
| `/goal` completion condition | `goal` | Chat has it (`web/lib/polar/goals.ts`) | Not for Code sessions | Judge after each Code turn with the same evaluator | S | partial |
| Advisor tool (escalate to a stronger model) | `advisor` | Router and fallback, no consult tool | | A tool that asks another model from the router, any provider | S | missing |
| Worktree per parallel session | `worktrees` | Fresh clone on its own branch per session (`session-branch.ts`, `session-commands.ts`) | Local worktrees need the runner | Runner creates `git worktree` per session | S after runner | partial |
| Checkpoints and rewind (code and conversation) | `checkpointing` | Chat versions and branches (`web/lib/polar/versions.ts`); no code checkpoints | Cannot rewind files | Snapshot the checkout per turn (git stash-like ref on the session branch) so it works for every engine | M | partial |
| `/compact` and auto-compact | `commands`, `context-window` | Chat compaction and auto (`web/lib/polar/compaction.ts`, `preferences.ts`); `/compact` forwarded to CLIs (`code-commands.ts`) | | | - | have |
| `/context` view of what fills the window | `debug-your-config` | None | | Chat knows its token counts (`usage.ts`); show them per part | S | missing |
| Effort and fast mode | `model-config`, `fast-mode` | Reasoning in compat routes (`compat/route-model.ts`); effort in the run runtime (`dashboard/packages/agent-runtime/effort.ts`); Automatic picks fast models (`automatic.ts`) | No effort picker in Polar Chat or Code | Map one effort scale to each provider's knob | S | partial |
| Model picker | `model-config` | `web/lib/polar/models.ts`, `components/polar/code-model-picker.tsx`; changeable mid-session in the Code thread for Claude Code, among the models of the source it signs in with (`modelCommand` in `session-commands.ts`: `--model` on the next turn, `/model` in an open interface) | Other CLIs keep the model they started with | | - | have |
| Fallback when a model fails | `model-config` | Router chain with key rotation and cooldowns (`router/chain.ts`, `turn-fallback.ts`); beyond Claude Code | | | - | have |

## 3. Sessions and history

| Claude Code feature | Doc | Polaris today | Gap | Provider-agnostic design note | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Resume / continue / session picker | `sessions` | Chat threads; Code `/resume` and history (`code-commands.ts`, `code-history.ts`) | | | - | have |
| Name, branch, fork | `sessions#branch-a-session` | Rename; Chat versions; Code fork (`session-fork.ts`) | | | - | have |
| Export transcript | `sessions#export-and-locate-session-data` | Chat Markdown or JSON (`web/lib/polar/export.ts`); Code history stored (`session-history.ts`) | No export for Code threads | Same exporter over the stored Code history | S | partial |
| Share a session | `claude-code-on-the-web#share-sessions` | Chat share links (`share.ts`); sessions can be shared (`docs/features/agents.md`) | | | - | have |
| Turns that survive closing the tab | `claude-code-on-the-web` | Chat runs (`runs.ts`); Code sessions run in tmux | | | - | have |
| Queue a message while busy, take it back | `claude-code-on-the-web#take-back-a-queued-message` | Not found | | Queue on the session row, pasted when the agent goes idle | S | missing |
| Resume a session started in a local terminal | `remote-control#resume-sessions-after-stopping-the-server` | None | | Runner lists transcripts in the CLI's own folder and resumes one in its PTY (phase 2) | M | missing |

## 4. Customization

| Claude Code feature | Doc | Polaris today | Gap | Provider-agnostic design note | Size | Status |
| --- | --- | --- | --- | --- | --- | --- |
| CLAUDE.md / AGENTS.md project memory | `memory` | Code: the CLI reads it. Chat: project instructions (`web/lib/polar/projects.ts`); Enigma contract into sessions (`core/enigma.ts`) | Polar's own loop reads no repo memory file | Phase 3 loop loads `AGENTS.md`, then `CLAUDE.md`, nested by directory | S | partial |
| Auto memory | `memory` | `polar_remember` memories (`web/lib/polar/memory.ts`) | Per person, not per project | Add a project scope | S | partial |
| Built-in slash commands | `commands` | Code: 12 commands, 5 forwarded per CLI (`code-commands.ts`); Chat slash list (`slash.ts`) | Most of Claude Code's ~110 commands absent; terminal pickers unreachable | Polaris owns pickers (model, resume, permissions) and sends the result as flags or keystrokes | M | partial |
| Custom slash commands | `skills` | Per-person commands (`web/lib/polar/commands.ts`) | Not read from the repo | Read `.claude/commands` and `.agents` equivalents in phase 3 | S | partial |
| Skills | `skills` | Per-person skills, skills.sh and GitHub import, Enigma catalogue (`web/lib/polar/skills/`); handed to Code (`code.ts` `agentSkills`) | | | - | have |
| Hooks (user-defined) | `hooks`, `hooks-guide` | Polaris installs its own hooks into the CLI to observe (`session-hooks.ts`) and answer approvals (`session-permissions.ts`) | No user hooks; none in Polar's loop | One event vocabulary (already normalised in `core/agent-sessions.ts`) fired by the runner for every engine | M | partial |
| Plugins and marketplaces | `plugins/overview`, `plugins/create-marketplace` | Polaris app marketplace exists for apps, not for agent extensions | No bundle of skills + commands + agents + hooks + MCP | Plugin = a folder in Claude Code's manifest shape; installed per person or org; reused by every engine | M | missing |
| MCP client, remote servers with OAuth | `mcp` | Connectors catalog with OAuth (`web/lib/polar/connectors/`), per-server switches (`tool-servers.ts`) | | | - | have |
| MCP client, local stdio servers | `mcp` | None | Needs a machine to run on | Runner spawns stdio servers and bridges them | S after runner | missing |
| Polaris as an MCP server | `mcp` | `web/lib/mcp/`; written into every session (`mcpConfig`) | | | - | have |
| Output styles | `output-styles` | Enigma output style preference (`web/lib/polar/enigma-prefs.ts`), writing settings | No user-defined style files | Style = a system-prompt fragment, same for every provider | S | partial |
| Status line | `statusline` | None | | Session footer: model, branch, context use, cost | S | missing |
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
