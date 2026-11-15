# Agent Orchestrator parity ledger (Polar Code and Tasks)

What [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator)
("AO", Apache-2.0) does, what Polaris does today, and the work units that close
the gap. Polar Code is where coding-agent sessions run (real CLIs, in a
container on the session pool or on the operator's own machine); Tasks is the
Tasks app. "Both" means the engine lands in Polar Code and Tasks gets a view
or entry point onto it.

- Source read: AO `main` at `e4ded08c6f150a632909e84bcc65d8cf772b4c2f`
  (2026-11-15), shallow clone, read only. Product docs:
  `docs.orchestrator.inc/plugins/agents` (agent matrix) and `/guides/cloud`.
- Polaris side read at this branch's base (`2e03701152`).
- Inventory was taken mechanically: every directory in
  `backend/internal/adapters/agent/` (41 registered in
  `adapters/agent/registry/registry.go` `Constructors()`, plus 13 helper
  packages), every directory in `adapters/chatdriver/` (27), every package in
  `backend/internal/` (55) and `backend/internal/service/` (31), every route in
  `frontend/src/renderer/routes/` (17), every file in `packages/mobile/app/` (52).
- Paths below without a prefix are AO paths relative to its repository root.
  Polaris paths start at `dashboard/`.

## Licensing and how to take code

AO is Apache-2.0; Polaris is AGPL-3.0 (`NOTICE.md`). Apache-2.0 code may be
included in a GPLv3/AGPL-3.0 work. Obligations for any unit that copies or
closely translates AO code or text:

1. Add a "Third-party code" section to `NOTICE.md` if it is not there yet, with
   one entry: "Agent Orchestrator, Copyright its contributors, Apache License
   2.0, github.com/OrchestratorInc/agent-orchestrator, commit e4ded08c6f15".
   AO ships no NOTICE file of its own (only `LICENSE`), so there is no upstream
   notice text to carry.
2. A file copied as is keeps any license header it has, and gains a line saying
   it was modified and where it came from (Apache-2.0 section 4b).
3. A translation of logic (Go to TypeScript) is a derivative: put a one-line
   `Ported from <AO path> (Apache-2.0)` comment at the top of the new module.
4. Never use the AO name, logo or "Orchestrator" branding on a screen (Apache-2.0
   section 6, and the repo's "no internal tech names" rule). Agent logos are
   sourced from each vendor per the logo policy, not lifted from AO's
   `frontend/src/renderer/assets/agents/`.

AO's backend is Go (`backend/`), its desktop renderer and mobile app are
TypeScript (`frontend/`, `packages/mobile`, `packages/shared`). Each unit in
section 4 says **port** (rewrite Go logic in TS) or **vendor** (copy TS from
`packages/shared` or `frontend/src` with attribution). Vendoring is only
worthwhile for pure, dependency-free TS: `packages/shared/files/diff-parser.ts`,
`files/file-annotations.ts`, `files/file-formats.ts`, `chat/ansi.ts`,
`artifacts/deliverables.ts`, `artifacts/turn-artifacts.ts`,
`session/interface-transition-poll.ts`. Everything else is either Go or tied to
AO's daemon API and Electron/React Native, and is ported.

## The one difference that shapes everything

AO is a desktop daemon on the user's own computer: it runs each CLI in a PTY
(tmux / ConPTY) or drives it over stdio (ACP or `codex app-server`) in a git
worktree, with the CLI's own login on that computer. Polaris runs the same CLIs
inside a container per session on its session pool (`lib/agents/session-placement.ts`,
`session-container.ts`), in tmux (`session-commands.ts`), or on an enrolled
server, and the "This computer" runner relay (in progress on another branch)
adds the operator's own machine. So:

- AO's "use the CLI's existing sign-in" maps to Polaris's two cases: on the
  operator's own machine/server the tool's home is used untouched
  (`agent-signins.ts` header); in a container the sign-in is the user's own
  token/key or subscription login carried in (`agent-auth.ts`,
  `signin-runtime.ts`, `account-rotation.ts`). Polaris never proxies model
  traffic for a CLI session, which already matches AO; keep it that way.
- AO's worktree per worker = Polaris's clone per session (container boundary).
- AO's LAN listener + pairing for mobile has no equivalent need: Polaris is
  already a web server with accounts (see section 3).

---

## 1. Agent matrix

Columns:

- **Bin** - executable AO resolves (`binaryutil` calls in the adapter dir).
- **Install** - AO's first install plan on Linux
  (`backend/internal/service/systeminstall/agentplans.go`); "official" means the
  vendor's install script listed there.
- **TUI/Chat/Rev** - shipped Terminal UI worker, Chat (structured) and Reviewer
  support from the docs matrix (`docs.orchestrator.inc/plugins/agents`); the
  three not in that matrix (codewhale, memcode, minimax-code) are read from code.
- **Chat driver** - `adapters/chatdriver/<x>`: `acp` = generic Agent Client
  Protocol driver (`chatdriver/acp`), `app-server` = `codex app-server`
  JSON-lines driver (`chatdriver/codexappserver`), `own` = harness-specific.
- **Activity** - how AO learns working/idle/waiting: `hooks:<file>` = AO writes
  `ao hooks <agent> <event>` callbacks into that native hook file;
  `plugin` = AO installs a plugin/extension file the CLI loads;
  `terminal` = bounded parsing of the terminal composer
  (`adapters/agent/terminalui`, `<agent>/terminal_activity.go`);
  `notify` = the CLI's own notification command.
- **Auth** - login command AO runs in a terminal
  (`service/agentauth/plans.go`), plus env keys the adapter's `auth.go`
  recognises. Every adapter has an `auth.go` probe except codex/gemini/opencode
  (probed through their chat drivers) and dockeragent.
- **Models** - `modelcatalog` source when the harness has a native one.
- **Polaris** - `have` = in `packages/core/src/agent-clis.ts` with observation as
  stated; `partial` = listed but with a gap noted; `missing` = not in the
  catalogue (it still runs as a "custom agent" with no status).

| AO id | Name | Bin | Install (Linux) | TUI/Chat/Rev | Chat driver | Activity | Auth (login / keys) | Models | Polaris |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | Claude Code | `claude` | npm `@anthropic-ai/claude-code`, official | Y/Y/Y | `claudeacp` (ACP adapter + bundled Node, points `CLAUDE_CODE_EXECUTABLE` at the user's binary) | hooks:`settings.local.json` (payload-aware, subagent ids, turn interrupts) | `claude auth login` (subscription, Console, SSO, setup-token); `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`; multi-account config folders (`adapters/agentaccount/claude.go`) | provider-configured, `model_versions.go` | have: hooks, subagents, asks, transcript, usage, multi-account rotation (`session-hooks.ts`, `session-subagents.ts`, `account-rotation.ts`). Missing: ACP chat mode |
| codex | Codex | `codex` | npm `@openai/codex`, official | Y/Y/Y | `codexappserver` | hooks:`hooks.json` (payload-aware) | `codex login` (ChatGPT, device code, key); multi-account (`agentaccount/codex.go`) | app-server list | have: hooks, transcript decoder (`transcript-decoders.ts`). Missing: app-server chat, multi-account folders |
| opencode | opencode | `opencode` | npm `opencode-ai@latest`, official | Y/Y/Y | `opencodeacp` | plugin | `opencode auth login`; many provider keys | native cache | partial: output only |
| opencode-v2 | OpenCode 2 | `opencode-v2` | npm `@opencode/cli`, official (isolated home) | Y/Y/Y | `opencodev2acp` | plugin | `opencode auth login` | native cache | missing |
| grok | Grok Build | `grok` | official `x.ai/cli/install.sh` | Y/Y/Y | `grokacp` (`grok agent stdio`) | hooks (3 events) | `grok login`; `XAI_API_KEY` | - | missing |
| cursor | Cursor | `cursor-agent` | official `cursor.com/install` | Y/Y/Y | `cursoracp` | hooks:`hooks.json` | `cursor-agent login`; `CURSOR_API_KEY`; native SQLite chats (`cursorstore`) | - | partial: output only, `install: null` though an official script exists |
| qwen | Qwen Code | `qwen` | npm `@qwen-code/qwen-code@latest`, official | Y/Y/- | `qwenacp` (needs 0.16+) | hooks:`settings.json` (matcher groups) | keys: `DASHSCOPE_API_KEY`, `QWEN_API_KEY`, `BAILIAN_CODING_PLAN_API_KEY`, others | - | partial: output only |
| gemini | Gemini CLI | `gemini` | npm `@google/gemini-cli@latest` | Y/-/- | `geminiacp` (present in code, not in docs matrix) | hooks:`settings.json` (5 events) | `gemini` setup; `GEMINI_API_KEY` | - | have: hooks, transcript decoder |
| copilot | GitHub Copilot | `copilot` | npm `@github/copilot` | Y/-/Y | `copilotacp` (code only) | hooks | `copilot` login; `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | - | have: hooks |
| kimi | Kimi | `kimi` | official `code.kimi.com/kimi-code/install.sh` | Y/Y/Y | `kimiacp` | hooks:`config.toml` (8 events) | `kimi` login; `KIMI_API_KEY`, `MOONSHOT_API_KEY` | native | missing |
| muse | Muse | `muse` | official `dev.meta.ai/install.sh` | Y/-/Y | - | hooks (1) | `muse login`; `META_API_KEY` | - | missing |
| droid | Droid | `droid` | npm `droid`, official | Y/Y/Y | `droidacp` | hooks:`hooks.json` (payload-aware) | `FACTORY_API_KEY` | - | partial: output only, `install: null` |
| amp | Amp | `amp` | npm `@ampcode/cli`, official | Y/-/Y | - | plugin | `amp login`; `AMP_API_KEY` | - | partial: output only. Polaris installs `@sourcegraph/amp`; AO uses `@ampcode/cli` - verify against ampcode.com/manual |
| agy | Agy (Antigravity CLI) | `agy` | official `antigravity.google/cli/install.sh` | Y/-/Y | `agyacp` (code only) | hooks:`hooks.json` | `agy` login | - | missing |
| crush | Crush | `crush` | npm `@charmland/crush` | Y/-/Y | - | project config hook | `crush login`; ~21 provider keys | native providers | partial: output only |
| aider | Aider | `aider` | official `aider.chat/install.sh`, uv `aider-chat` | Y/-/Y | - | notify (`--notifications-command`) + terminal | no login; ~13 provider keys incl. `AIDER_*` | provider list | partial: output only |
| goose | Goose | `goose` | official `download_cli.sh` | Y/-/- | - | hooks:`hooks.json` | `goose configure`; provider keys | - | partial: output only, `install: null` |
| auggie | Auggie | `auggie` | npm `@augmentcode/auggie` | Y/-/Y | - | hooks:`settings.local.json` | `auggie login` | - | missing |
| continue | Continue | `cn` | npm `@continuedev/cli` | Y/-/- | - | terminal + notify (5 events) | `cn login` | provider list | missing |
| devin | Devin for Terminal | `devin` | official `cli.devin.ai/install.sh` | Y/-/Y | - | hooks:`config.local.json` | `devin auth login`; `DEVIN_API_KEY` | - | missing |
| omp | OMP (oh-my-pi) | `omp` | bun, official `omp.sh/install` | Y/Y/- | `ompacp` (needs 15+) | plugin (extension file) | `omp setup` | native DB | missing |
| hermes | Hermes Agent | `hermes` | official installer (`planHermesInstaller`) | Y/Y/- | `hermesacp` | terminal resume | `hermes model`; many provider keys | - | missing |
| cline | Cline | `cline` | npm `cline@latest` | Y/-/Y | - | hooks (hook payload) | `cline auth`; `CLINE_API_KEY` | provider list | partial: output only |
| kiro | Kiro | `kiro-cli` | `planKiroInstall` (official) | Y/-/Y | - | hooks (hook file) + terminal | `kiro-cli login`; `KIRO_API_KEY` | - | missing |
| kilocode | Kilo Code | `kilo` | npm `@kilocode/cli` | Y/-/Y | - | plugin | `kilo auth login`; provider keys | native cache | missing |
| vibe | Mistral Vibe | `vibe` | uv `mistral-vibe` | Y/-/- | - | hooks:`hooks.toml` (3) | `vibe --setup`; `MISTRAL_API_KEY` | - | missing |
| pi | Pi | `pi` | npm `@earendil-works/pi-coding-agent` | Y/Y/Y | `piacp` | plugin (`--extension`) | `pi` login; provider keys | local store | missing |
| kimchi | Kimchi | `kimchi` | official GitHub release script | Y/Y/Y | `kimchiacp` | hooks:`hooks.local.json` (8) | `kimchi` login; `KIMCHI_API_KEY` | local store | missing |
| prime-agent | Prime Agent | `prime-agent` | official `app.primeintellect.ai/prime-agent/install.sh` | Y/-/- | - | plugin (`--extension`) | many provider keys incl. `ANTHROPIC_OAUTH_TOKEN` | package catalog | missing |
| autohand | Autohand | `autohand` | npm `autohand-cli`, official | Y/-/Y | - | hooks:`config.json` | `autohand login`; `AUTOHAND_API_KEY` | provider list | missing |
| fx | fx (experimental) | `fx` | official `fx.sh/setup.sh` | Y/-/- | - | runtime env | `fx login` | gateway + connections | missing |
| command-code | Command Code | `cmd` | npm `command-code` | Y/Y/- | `commandcodeacp` | hooks:`settings.json` (4) | `command-code login` | - | missing |
| unreal-agent | Unreal Agent | (built into AO) | n/a | -/Y/- | `unrealagent` | - | provider keys | - | n/a: AO's own bundled harness, nothing to install |
| docker-agent | Docker Agent | `docker-agent` | brew / official binary (macOS, Linux) | -/Y/- | `dockeragentacp` | - | `docker-agent setup`; config from `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` | - | missing (chat-only, depends on ACP unit) |
| mimo-code | MiMo Code | `mimo` | npm `@mimo-ai/cli` (0.1.14+) | Y/-/- | - | terminal | `mimo auth login` | native cache | missing |
| deepseek-harness | DeepSeek | `dsh` | npm `@deepseek-ai/dsh` | Y/Y/- | `deepseekharnessacp` | - | `dsh --profile web`; `DEEPSEEK_API_KEY` | - | missing |
| openhands | OpenHands | `openhands` | uv `openhands`, official | Y/-/- | - | hooks:`hooks.json` | `openhands` setup; `LLM_API_KEY` | - | partial: output only |
| stakpak | Stakpak | `stakpak` | official `stakpak.dev/install.sh` | Y/-/- | - | terminal | `stakpak auth login`; `STAKPAK_API_KEY` | - | missing |
| codewhale | Codewhale | `codewhale` | manual (AO does not install it) | Y/-/- (code) | - | hooks:`managed_config.toml` | `codewhale auth set --provider deepseek` | - | missing |
| memcode | memcode | `memcode` | official `memcode.ai/install.sh` | Y/-/- (code) | - | hooks:`hooks.json` (4) | `MEMCODE_API_TOKEN` | - | missing |
| minimax-code | MiniMax Code | `mcode` | official `filecdn.minimax.chat/public/install.sh`, npm `@minimax-ai/code` | Y/-/- (code) | - | terminal | `MAVIS_ACCESS_TOKEN`, `MINIMAX_API_KEY` | - | missing |

Polaris entries AO does not have: `openclaw` and the custom agent
(`CUSTOM_AGENT_CLI`). Keep both.

Totals: AO 41 harnesses (40 installable + Unreal built in). Polaris has 14 of
them; 4 with hook observation (claude, codex, gemini, copilot), 10 output-only;
27 missing.

Shared AO helper packages behind the matrix (all ported, none vendored):

| AO helper | Role | Polaris equivalent |
| --- | --- | --- |
| `adapters/agent/agentbase` | model flag, config spec, native resume | `agentModelArgs`/`agentEffortArgs` in `agent-clis.ts` |
| `hooksjson` | one writer for the matcher-group hook file (claude, goose, qwen, agy, droid, kimchi) | `claudeHookSettings` only (`session-hooks.ts`) |
| `hookutil` | atomic hook-file writes | boot script writes files from `asFile()` |
| `activitystate` / `activitydispatch` | event name -> active/idle/waiting_input/blocked/exited, per agent | `normalizeHookEvent` (Claude-shaped) |
| `authprobe` | auth status + identity without reading tokens | `agent-readiness.ts`, `key-status.ts` (keys only) |
| `modelcatalog` | normalise each CLI's native model list | `model-catalog.ts` (models.dev only) |
| `terminalui` | composer readiness from bounded terminal output | none |
| `nativeconfig` / `importcopy` / `cursorstore` | provider session dirs, import and relocate native history | `session-history.ts` (Claude/Codex/Gemini transcripts) |
| `binaryutil` | resolve binary incl. `~/.cargo/bin`, `~/.<tool>/bin` | `binaries` list, PATH only |
| `chatdriver/persistenthost` | keep the stdio provider alive across daemon restarts | tmux already survives web restarts |
| `chatdriver/processenv`, `opencodeidentity`, `citation`, `commanddetail` | env scrub, identity, citations, tool-call detail | partly in transcript decoders |
| `adapters/reviewer/*` (22 reviewer adapters + `agentrestore`) | reviewer launch per CLI, separate registry | agent-runtime Review mode (`packages/agent-runtime`) |

## 2. Feature matrix

Size: S under a day of agent work, M one agent run, L two or more runs.

### 2.1 Orchestration and the board

| Feature | AO behaviour (source) | Polaris today | Gap | Target | Size |
| --- | --- | --- | --- | --- | --- |
| Orchestrator plans and fans out | A project's orchestrator session gets the `using-ao` skill (`backend/internal/skillassets/using-ao`) and drives workers through the `ao` CLI: `ao spawn`, `ao send`, `ao session ls/get/kill/claim-pr`, `ao preview` (`docs/cli/README.md`); children shown under it (`OrchestratorChildrenSection.tsx`), replaceable (`OrchestratorReplacementDialog.tsx`) | Runs with a coordinator, task graph, dispatch, inbox, gates, variants (`lib/agents/orchestration-plan.ts`, `orchestration-service.ts`, `automations/code-review/orchestration/`) | Coordinator tools are not exposed as a session-callable surface with the AO verbs (send to a worker, list children with PR/CI state, claim PR, preview); per-role default agent and model per project (`ProjectAgentRoleControls.tsx`); generated title + task slug per worker | Polar | M |
| Tasks as the plan | Workers come from the orchestrator chat; no tracker of its own beyond GitHub/GitLab issues (`adapters/tracker/github`, `gitlab`) | `tasks/hand-to-agent.tsx` opens one session from a task and comments on it | A plan's tasks become Tasks items; each item's status follows its session's derived status; starting a run from a Tasks list/sprint | Tasks | M |
| Board with lanes | Lanes from derived status: Working, Needs you, In review, Ready to merge (`SessionsBoard.tsx`, `BoardEmptyStates.tsx`) | `agents-roadmap.md` item 6 open; no session board | Board view over sessions + PR facts | Both (Polar board; Tasks board column mapping) | M |
| Status derivation | Display status never stored; computed: terminated/merged, needs_input (waiting_input, blocked), PR pipeline (ci_failed, draft, changes_requested, merge_conflict, mergeable, approved, review_pending, pr_open), working, no_signal, idle (`docs/architecture.md` "Status derivation") | Session state from hooks (`session-live.ts`, `polar-code-status.tsx`), PR link (`session-review.ts`) | Pure `deriveStatus(facts)` with this precedence, shared by board, list, Tasks, push | Both | S |
| Worktrees | `adapters/workspace/gitworktree`, `scratch`, `forkseed`, `router` | clone per session in a container (`session-runtime.ts`); "This computer" relay in progress | On the operator's machine use a worktree, not a clone (relay branch) | Polar | M (after relay) |
| Cues (one-click project actions) | `service/cue`, `CuesDialog.tsx`, `CueRunMenu.tsx`, `ao cue create/list` | `code-starters.ts` (starter prompts) | Saved per-repository actions runnable on a session | Polar | S |
| Recurring automations | `service/automation`, `AutomationsView.tsx`, `_shell.automations.tsx` | GitHub-event automations for runs (`agent-webhook.ts`); schedule trigger is a roadmap P2 | Schedule trigger that opens a session | Polar | S |

### 2.2 Feedback loop, review, PRs

| Feature | AO behaviour (source) | Polaris today | Gap | Target | Size |
| --- | --- | --- | --- | --- | --- |
| SCM observer | Polls PRs per session, stores durable `pr`, `pr_checks`, `pr_comment` facts, ProviderID-primary identity (`docs/scm-observer.md`, `adapters/scm/github`, `gitlab`, `observe/`) | GitHub App webhooks for runs (`agent-webhook.ts`); `linkedPullRequest` reads on demand | Durable PR facts per session, fed by webhook with a poll fallback | Polar | M |
| CI failure, review comment, merge conflict -> owning worker | Lifecycle detects actionable feedback and sends it to the session (TUI runtime or Chat queue); agent/system messages batch into one turn, typed messages get their own (`docs/architecture.md` "Feedback routing flow", `lifecycle/`) | Manual: `failingChecksPrompt`, `reviewPrompt` (`session-review-loop.ts`) sent by a person; prompt queue (`session-prompt-queue.ts`) | Automatic routing with dedupe per fact, the batching rule, an opt-out per session, and a cap on retries | Polar | M |
| Reviewer agent | Separate reviewer registry (`adapters/reviewer`), `review/` engine, auto-review on new PR heads (`autoreview/`), interactive reviewers isolated in a gateway with a pinned tree and no checkout access (`reviewgateway/`, ADR 0002), picker (`ReviewerPicker.tsx`), reviewer chat (`ReviewerChatSurface.tsx`) | Code-review automation on PR events (`review-gate.ts`, `automations/code-review/`), agent-runtime Review/IncrementalReview modes | Review a session's PR with a chosen reviewer CLI on each new head, result shown in the session and fed back by the loop above | Polar | M |
| PR timeline | `PRTabPane.tsx`, `PRComments.tsx`, `PRCommentComposer.tsx`, `PRActions.tsx`, `PRPills.tsx`, `PRStack.tsx`, `PRSummaryDisplay.tsx` | Open PR from the session (`openSessionPullRequest`), changes list and diff | Timeline (checks, reviews, comments, commits), reply to a comment, merge from the screen | Polar | M |
| Claim an existing PR | `ao session claim-pr`, upstream PRs from forks | none | Attach an existing PR to a session | Polar | S |

### 2.3 Session surface

| Feature | AO behaviour (source) | Polaris today | Gap | Target | Size |
| --- | --- | --- | --- | --- | --- |
| Chat mode over ACP / app-server | `service/chat` controller, `chatdriver/acp` + 20 provider bindings, `codexappserver`; queue, steer, approvals, elicitation (`ElicitationDock.tsx`), TUI<->Chat handoff (`SessionInterfaceSwitch.tsx`), hibernation | TUI in tmux; structured view from hooks + transcript decoders for Claude/Codex/Gemini | Structured chat for any ACP agent; this is what makes the 27 missing agents first-class rather than terminal-only | Polar | L |
| Terminal | `terminal/` WebSocket per session, `XtermTerminal.tsx`, shell tabs (`service/shellterm`), titles (`service/terminaltitle`) | Session terminal exists (tmux attach) | Extra shell tabs per session | Polar | S |
| Agents started by hand in a shell | `service/shellagent` notices them | n/a in containers | Only for "This computer" | Polar | S (after relay) |
| Browser per worker | `browserruntime`, `browserchrome` (user's Chrome), `browserstream` (frames + remote input), `ao browser`, `BrowserPanel.tsx` | Path-based preview proxy (`session-preview.ts`); Polar browser tools (`lib/polar/browser-tools.ts`) for the assistant, not sessions | Agent-driven headless browser inside the session container with a streamed view | Polar | L |
| Preview dev server | `previewserver/` (configured command per project), `ao preview start/status/stop` | Detects listening ports and proxies them (`session-preview.ts`) | Configured preview command per repository | Polar | S |
| Attachments | `attachmentstore/`, staged attachments in composer | `session-attachments.ts` | Parity; nothing material | - | - |
| Artifacts | `sessionartifacts/`, `artifactversions/`, `renderpage/`, `ArtifactsView.tsx`, `_shell.artifacts.tsx` | none for sessions | Deliverables folder per session, versions, render, share | Polar | M |
| Files and diff | `filesnapshot/`, `workspacewatch/`, `SessionFileExplorer.tsx`, `WorkspaceDiffView.tsx`, `DiffSelectionMenu.tsx` (send a selection to the agent) | `session-files.ts`, `session-changes.ts`, `session-review.ts` | Send a diff selection back as a prompt | Polar | S |
| Fork | `service/sessionfork` (worktree, branch, native memory) | `session-fork.ts` | Parity check only | - | - |
| Import native history | `service/sessionimport`, `importer`, `SessionImportDialog.tsx` | none | Only meaningful on "This computer" | Polar | M (after relay) |
| Subagents | `SubagentPanel.tsx`, `SubagentTeam.tsx` | `session-subagents.ts`, `polar-code-subagents.tsx` | Parity | - | - |
| Side chats | `IndependentSideChats.tsx`, `sideConversation.ts` | Polar threads | Parity enough | - | - |
| Split panes requested by agents | `service/panes` | none | Low value on web | - | skip |
| Computer use | `service/computeruse`, `adapters/cuadriver` (Cua Driver) | none | Desktop-only; skip for containers | - | skip |
| Awake / closed-lid wake | `service/awake`, `mobilebridge/lidawake.go`, ADR 0005/0006 | n/a (server) | Not applicable | - | skip |
| Session search | `service/sessionsearch` | session list | Full-text search over sessions | Polar | S |
| Sharing and teams | `TeamsSection.tsx`, `ShareSessionDialog.tsx`, `share/` | Polar sharing (`lib/polar/share*.ts`), orgs | Parity | - | - |

### 2.4 Accounts, keys, usage

| Feature | AO behaviour (source) | Polaris today | Gap | Target | Size |
| --- | --- | --- | --- | --- | --- |
| Use the CLI's own sign-in | Runs the user's binary with its own login; login plans run the CLI's documented login command in a terminal, logout only where documented (`service/agentauth/plans.go`) | Own machine: untouched home. Container: token/key carried in (`agent-auth.ts`, `signin-runtime.ts`, `signin-screen.ts`) | Login commands for the 27 new CLIs; a "sign in inside the session" flow that captures the resulting credential file into the user's encrypted store for the next container | Polar | M |
| Subscription accounts | Claude Code and Codex accounts as separate CLI config folders, session pinned to one, switch restarts the agent (`adapters/agentaccount`, `service/agentaccounts`, `ao account switch`) | Rotation across the owner's accounts on a usage limit (`account-rotation.ts`) | Codex multi-account; explicit per-session account switch | Polar | M |
| Usage-limit handling | `UsageLimitNotice.tsx`, `service/usage/limit_history.go` | `account-rotation.ts`, `agent-usage-limits.ts` | Limit history view | Polar | S |
| Provider keys | `providerkeys/` env credentials, never in argv; tmux via a 0600 file read and deleted | BYOK model keys (`model-keys.ts`), credentials per CLI (`agent-clis.ts` `credentials`) | Credential lists for new CLIs; CLIs like crush/goose/pi read ~20 provider env names | Polar | S (in catalog units) |
| Usage and cost | `service/usage` collectors (Claude, Codex, OpenCode DB, Qwen, Goose, Grok, Pi family), `pricing/`, budgets, `UsageView.tsx` | `session-usage.ts` (Claude transcript), `lib/polar/usage.ts`, `credit.ts` | Collectors for more CLIs; per-session cost; budget view | Polar | M |
| Model catalogue per harness | Native discovery merged with provider sources, cached, enable/disable filter (`docs/harnesses/model-catalogs.md`, `adapters/agent/modelcatalog`) | models.dev catalogue (`model-catalog.ts`), `opencode-model.ts` | Native lists (opencode/kilo/mimo caches, codex app-server, pi/kimchi stores) | Polar | M |
| Install and update CLIs | `service/systeminstall` plans per OS, version refresh, update advisory, update when idle | `install` string per CLI run by the boot script (`session-runtime.ts`), readiness (`agent-readiness.ts`) | Install strings for new CLIs; version shown per session | Polar | S |
| Telemetry | `telemetrymeta`, `deliverytelemetry`, PostHog | - | Skipped by request | - | skip |

### 2.5 Away from the desk and remote

| Feature | AO behaviour (source) | Polaris today | Gap | Target | Size |
| --- | --- | --- | --- | --- | --- |
| Notifications | `notify/` fan-out, `NotificationCenter.tsx` | Notifications + web push (`lib/notifications/dispatch.ts`, `web-push.ts`, `account/notifications/push-card.tsx`) | Agent events (needs input, approval, CI failed, PR ready) as notification kinds with deep links to the session | Both | S |
| Push to phones | Expo push service relaying to APNs/FCM (`push/expo.go`, `push/dispatcher.go`), device registry (`mobilebridge/pushdevices.go`), presence of the open app suppresses push (`presence/`) | Web push to subscribed browsers/PWA | Suppress push while the session is open on that device; action buttons (reply/approve) | Both | S |
| Mobile app | Expo/React Native app, 52 route files (section 3) | PWA (`app/manifest.ts`, `public/sw.js`), desktop Electron, TV | Phone-shaped session surfaces | Both | L |
| Pairing | LAN listener off by default, rotating 8-char password hashed, per-source lockout, QR with host+port only (ADR 0001); Tailscale and a `cloudflared` quick tunnel raced `lan > tailscale > tunnel` (ADR 0004); pairing codes, host keys, access devices (`mobilebridge/`) | Not needed: Polaris has accounts on its own domain; QR sign-in device flow exists | "Open on phone" QR on a session using the existing device sign-in | Polar | S |
| Cloud agents | Hosted control plane runs workers in a remote sandbox; Claude Code, Codex, Cursor, OpenCode connected in Settings; GitHub App repo grant; switching agent passes a summary plus the full conversation file; artifacts copied with limits (25 MiB/file, 200 files or 500 MiB/session); archive removes the sandbox, restore makes a new one from a checkpoint (`docs.orchestrator.inc/guides/cloud`, `CloudSessionChatSurface.tsx`, `cloud-workspace/`) | Container sessions on the pool keep running with no laptop (`session-placement.ts`, `session-spares.ts`), work saved on stop (`session-work.ts`) | Switch agent mid-session with a handoff; restore a stopped session into a new container from its saved branch | Polar | M |
| Coder workspaces | `CoderTemplatePicker.tsx`, `CoderSettingsSection.tsx` | Enrolled servers in the pool | None needed | - | skip |
| Self-hosted remote host | Ubuntu VM runs AO as a user service behind a tunnel, paired to the account (`docs/self-hosted-remote.md`, `ao remote-host`) | Enrolled servers (`machine-enrollment`), runner pools | Parity; the "This computer" relay covers the desktop case | - | - |

### 2.6 Internal package inventory (every package, so nothing is skipped silently)

`backend/internal/` (55): `adapters` (section 1), `agentlaunch` (persisted argv - Polaris boot env), `artifactversions` / `sessionartifacts` / `renderpage` (artifacts row), `attachmentstore` (have), `autoreview` / `review` / `reviewgateway` (reviewer row), `browserchrome` / `browserruntime` / `browserstream` (browser row), `caller` (which session issued a CLI call - Polaris session token on MCP), `cdc` (change data capture - `session-live.ts`), `cli` (the `ao` CLI - becomes coordinator MCP tools), `clienttz` (display preferences), `codexops` (Codex operation admission - account unit), `config` / `daemon` / `daemonmeta` / `datadirlock` / `runfile` / `httpd` / `reqid` / `process` / `processalive` / `procmem` / `tmuxbin` / `termtheme` / `testenv` / `storage` / `lifecyclelog` (daemon plumbing, no user-facing parity), `devimport` / `legacyimport` (AO data migrations, skip), `deliverytelemetry` / `telemetrymeta` (skip), `domain` / `ports` (vocabulary), `filesnapshot` / `workspacewatch` (files row), `gitdefault` (default branch - have in `session-branch.ts`), `integration` (tests), `lifecycle` / `session_manager` / `sessionguard` / `observe` (status + feedback rows), `mobilebridge` / `presence` / `push` (section 2.5), `notify` (notifications row), `preview` / `previewserver` (preview row), `pricing` (usage row), `providerkeys` (keys row), `skillassets` (orchestrator row), `terminal` (terminal row).

`backend/internal/service/` (31): `agent`, `agentaccounts`, `agentauth`, `automation`, `awake`, `browser`, `chat`, `computeruse`, `cue`, `devimport`, `fsbrowser` (remote folder picker - relay), `githubpat` (PAT for `gh` - Polaris uses the GitHub App), `hookprocess` (ignore hooks from other Claude processes - Polaris containers are single-session), `importer`, `linkpreview` (Polaris has link previews), `notification`, `panes`, `pr`, `project`, `report` (bug report - skip), `review`, `session`, `sessionfork`, `sessionimport`, `sessionsearch`, `settings`, `shellagent`, `shellterm`, `systemcheck` / `systeminstall` (install row), `terminaltitle`, `usage`. Each is mapped in the tables above.

Renderer routes (17): `__root`, `_shell`, `_shell.index` (home), `_shell.new` (new task), `_shell.sessions`, `_shell.sessions.index`, `_shell.sessions.$sessionId`, `_shell.projects.$projectId` (board), `_shell.projects.$projectId_.sessions.$sessionId`, `_shell.projects.$projectId_.settings`, `_shell.host.$hostId.project.$projectId`, `_shell.host.$hostId.project.$projectId_.session.$sessionId`, `_shell.host.$hostId.session.$sessionId` (remote hosts), `_shell.artifacts`, `_shell.automations`, `_shell.usage`, `_shell.settings`. All map to rows above.

---

## 3. Mobile

### 3.1 AO's mobile app, every screen

`packages/mobile/app/` (Expo Router, `expo ~57`, `react-native 0.86.3`,
`expo-notifications`):

| Group | Files | What it does |
| --- | --- | --- |
| Shell | `_layout.tsx`, `(tabs)/_layout.tsx`, `+native-intent.ts` | Root stack, tab bar, deep links |
| Tabs | `(tabs)/(workers)/index.tsx` + `_layout.tsx`, `(tabs)/(projects)/projects.tsx` + `_layout.tsx`, `(tabs)/compose.tsx` | Workers list, projects, compose |
| Onboarding and pairing | `onboarding.tsx`, `connect.tsx`, `pair.tsx` | First run, connect to a desktop/host, scan pairing QR |
| Sessions | `session/[id].tsx`, `spawn.tsx`, `conversation-actions.tsx`, `shell/[handleId].tsx` | Chat with approvals, start a worker (agent + model), actions, terminal |
| Project | `project/[id].tsx` | Board for one project |
| Review and PRs | `prs/index.tsx` + `_layout.tsx`, `review/[sessionId].tsx`, `reviewer/[reviewId].tsx` | PR list, session review, reviewer result |
| Files | `files/[sessionId]/index.tsx`, `folder.tsx`, `file.tsx`, `review.tsx` | Browse the worktree, read a file, review changes |
| Artifacts | `artifacts/[sessionId].tsx`, `artifact/[sessionId].tsx`, `artifact-version/[sessionId].tsx`, `render.tsx` | Deliverables and versions |
| Preview and browser | `preview/[id].tsx`, `browser/[id].tsx` | Dev-server preview, worker browser |
| Notifications | `notifications/index.tsx` + `_layout.tsx` | Inbox |
| Cloud | `cloud/new-project.tsx`, `cloud/terminal.tsx`, `settings/cloud/index.tsx`, `settings/cloud/agent/[agent].tsx` | Cloud projects and agent connections |
| Settings | `settings/index.tsx` + `_layout.tsx`, `settings/theme.tsx`, `settings/machine/[id]/index.tsx`, `settings/machine/[id]/edit.tsx` | Settings, theme, paired machines |
| Sheets | `sheets/account.tsx`, `agent.tsx`, `artifact-history.tsx`, `cloud-plan.tsx`, `composer-picker.tsx`, `conversation-usage.tsx`, `files-branch.tsx`, `files-changes.tsx`, `machine-name.tsx`, `model.tsx`, `review-actions.tsx` | Bottom sheets: account, agent and model pickers, usage, file branch/changes, review actions |

Pairing protocol: see 2.5 (LAN listener + bearer password, Tailscale,
Cloudflare quick tunnel, pairing codes and host keys in `mobilebridge/`). Push:
Expo push service to APNs/FCM.

### 3.2 Decision: PWA first, no native app now

Polaris delivers the mobile experience as phone-shaped routes of the existing
web app, installed as the PWA it already is, with web push for alerts. Reasons:

1. **Each Polaris is its own server on its own domain.** AO's native app talks
   to one daemon it paired with; a store app for Polaris would need a
   per-instance connect flow, a store review for every release, and a version
   that can lag the server (the repo already tracks clients facing many host
   versions). The web app is always the server's own version.
2. **Pairing is already solved.** AO needs LAN listeners, passwords, tunnels
   and Tailscale because its daemon is loopback-only. Polaris is reachable over
   HTTPS with accounts, 2FA, trusted devices and QR device sign-in; adding a
   second auth path would add attack surface for nothing.
3. **Push already exists.** Web push is wired (`lib/notifications/web-push.ts`,
   `public/sw.js`) and reaches Android browsers and iOS home-screen web apps
   (iOS 16.4 and later support web push for installed web apps). AO's Expo push
   would also require Polaris to operate push credentials (APNs key, FCM
   project) that a self-hosted operator does not have, breaking the "no setup"
   rule.
4. **The operator never touches a terminal.** A native app means signing keys,
   store accounts and builds; a PWA ships with the Update button.
5. **No new client to maintain.** Polaris already maintains desktop Electron,
   a browser extension and TV clients.

What a native shell would add, if ever needed: background reliability of push
on iOS, and share-sheet intake. Revisit only if web push proves unreliable on
iOS in real use; a thin wrapper (for example Capacitor around the same routes)
would then be the path, not a React Native rewrite.

Phone surfaces to build (units U17-U18): workers list grouped by derived
status, session chat with approve/deny and reply, compose/spawn with agent and
model pickers, notifications inbox, PR list and reviewer result, files and
changes review, preview, terminal (read and type), and an "Open on phone" QR on
the desktop session page using the existing device sign-in.

---

## 4. Build order (work units)

Each unit fits one agent run (~60 tool calls), lists its files and
dependencies, and is marked **port** or **vendor**. Units in the same wave are
independent and can run in parallel. Every unit follows `agent-rules.md`
(i18n en-US/es-ES, Zod at boundaries, code defaults for every setting, rerunnable
migrations, extension version bump when `packages/core/src` changes).

### Wave 1 (no dependencies)

**U1 - Catalogue: npm-installed CLIs.** Add `auggie`, `continue` (bin `cn`),
`kilocode` (bin `kilo`), `mimo-code` (bin `mimo`), `minimax-code` (bin `mcode`),
`deepseek-harness` (bin `dsh`), `command-code` (bin `cmd`), `autohand`,
`opencode-v2` to `AGENT_CLIS` with binaries, install, home, docs, credentials
(env names from each adapter's `auth.go`), headless/model/effort only where the
vendor docs confirm them. Files: `packages/core/src/agent-clis.ts`, its tests,
agent logos (sourced per logo policy), i18n for labels. Also re-check Polaris
`amp` install package against ampcode.com/manual. Port (data only). Size M.

**U2 - Catalogue: script-installed CLIs.** Same for `grok`, `kimi`, `pi`,
`devin`, `kiro` (bin `kiro-cli`), `vibe`, `agy`, `muse`, `prime-agent`, `fx`,
`omp`, `kimchi`, `hermes`, `stakpak`, `memcode`, `codewhale` (manual install:
`install: null` with docs link), and fill `install` for `cursor`, `goose`,
`droid` from the official scripts in `agentplans.go`. A pipe-to-shell install
string must come from the vendor's docs, not only from AO. Skip `unreal-agent`
(AO-internal) and `docker-agent` (chat-only, lands with U9). Files as U1.
Port. Size M.

**U3 - Shared hook writer and activity mapping.** TS equivalent of
`hooksjson` + `activitystate` + `activitydispatch`: one renderer for the
matcher-group hook file, a per-CLI `{file, events, timeout}` table, and
event -> state mapping (`active | idle | waiting_input | blocked | exited`).
Wire claude through it unchanged, then add codex `hooks.json`, gemini
`settings.json`, copilot, qwen `settings.json`, goose/droid/agy/openhands
`hooks.json`, kimchi `hooks.local.json`, auggie `settings.local.json`,
devin `config.local.json`, autohand `config.json` (only those already in the
catalogue when this lands; the table makes adding the rest one row each).
Files: `lib/agents/session-hooks.ts`, new `lib/agents/hook-files.ts`,
`session-commands.ts` (boot writes via `asFile()`), `packages/core/src/agent-clis.ts`
(`observe`), tests. Respect the control-character rule (base64 via `asFile`).
Port. Size M.

**U4 - Status derivation and PR facts store.** Pure `deriveSessionStatus(facts)`
with AO's precedence (2.1), plus a `SessionPullFacts` table (PR number/state,
draft, mergeable, checks summary, review decision, unresolved comments,
updated_at) written from the existing GitHub App webhook path
(`agent-webhook.ts`) and a bounded poll fallback in `lib/cron/jobs.ts` for
sessions with an open PR. Files: `packages/db/prisma/schema.prisma` + migration,
new `lib/agents/session-status.ts`, `lib/agents/session-pr-facts.ts`, webhook
handler, tests. Port. Size M.

**U5 - Agent notification kinds and phone deep links.** Notification kinds for
needs input, approval asked, CI failed, PR ready/merged, session ended; deep
link to the session; suppress push while that session is open in a focused
tab of the same user (AO `presence/` idea). Files: `lib/notifications/*`,
`session-live.ts` hook-up, i18n, tests. Port (idea only). Size S.

**U6 - Sign-in commands for every catalogued CLI.** Extend `LOGIN_COMMANDS`
(`signin-runtime.ts`) with the documented login and logout commands from
`service/agentauth/plans.go` (logout only where AO lists a documented one),
run in a sign-in terminal, and capture the resulting credential file into the
user's encrypted store so the next container starts signed in. Never read or
log the token beyond storing it; never route model traffic. Files:
`lib/agents/signin-runtime.ts`, `signin-screen.ts`, `agent-signins.ts`,
`agent-auth.ts`, i18n, tests. Depends on nothing (rows for CLIs not yet in the
catalogue are added by U1/U2 later as one line each). Port. Size M.

**U7 - Native model lists.** Per-CLI native discovery merged with the models.dev
catalogue, cached, last good kept on failure, manual entry always allowed:
opencode/kilo/mimo model caches, codex model list, pi/kimchi local stores,
omp DB (read only). Runs inside the session machine (container or own
machine) through the existing exec path, output parsed with Zod and bounded.
Files: `lib/agents/model-catalog.ts`, new `lib/agents/native-models.ts`,
`components/polar/code-model-picker.tsx`, tests. Port. Size M.

### Wave 2

**U8 - Plugin/extension and terminal activity.** For CLIs whose status comes
from a plugin (opencode, kilocode, amp, pi/omp/prime-agent `--extension`,
crush project config) write the plugin file at boot that posts to Polaris's
hook endpoint; for the rest (aider notifications command, continue, mimo,
minimax, stakpak, hermes) a bounded terminal-composer reader in the spirit of
`terminalui/composer.go`, conservative (unknown = no signal, never "idle").
Files: `lib/agents/hook-files.ts`, new `lib/agents/terminal-activity.ts`,
`session-commands.ts`, tests. Depends: U3, U1, U2. Port. Size M.

**U9 - ACP client and normalisation.** A TypeScript Agent Client Protocol
client over the session process's stdio (through hostd exec or a tmux-held
pipe), translating ACP updates into Polaris's history rows (the same shape
`transcript-decoders.ts` produces) and approvals into `session-permissions.ts`.
Before writing it, check npm for an official ACP TypeScript SDK and prefer it
over a hand-written client if it is maintained (dependency policy). Files: new
`lib/agents/acp/*`, `session-runtime.ts` (spawn mode), tests with recorded
frames. Port of `chatdriver/acp` semantics. Size L - split: U9a protocol and
transport, U9b event normalisation and approvals.

**U10 - Feedback routing.** On a new PR fact (U4): failing checks, new
actionable review comments, merge conflict -> enqueue one prompt to the owning
session via `session-prompt-queue.ts`, built with `failingChecksPrompt` /
`reviewPrompt`. Dedupe per fact id, batch adjacent system messages into one
turn but never merge with a typed message, per-session switch (default on),
stop after N automatic rounds per PR head. Files: new
`lib/agents/session-feedback.ts`, `session-review-loop.ts`, session settings UI,
i18n, tests. Depends: U4. Port. Size M.

**U11 - Session board.** Polar Code board grouped by `deriveSessionStatus`:
Needs you, Working, In review (pr_open/review_pending/ci_pending), Fix needed
(ci_failed/changes_requested/merge_conflict), Ready to merge, Done; filters by
repository/agent/person; live via `session-live.ts`; SWR first paint; virtualised
columns. Files: new board route under Polar Code, components, i18n, tests.
Depends: U4. Port (layout idea from `SessionsBoard.tsx`, no code). Size M.

**U12 - PR timeline and actions.** Session PR tab: checks, reviews, comments,
commits from U4 facts plus on-demand reads; reply to a comment; merge (respecting
branch protection and the user's permission); claim an existing PR for a
session. Files: `lib/agents/session-review.ts`, new components, actions, i18n,
tests. Depends: U4. Port. Size M.

**U13 - Codex multi-account and explicit account switch.** Codex accounts as
separate stored sign-ins (AO keeps one CLI config folder per account); a
session is pinned to one and can be moved, restarting the agent with resume.
Extend rotation in `account-rotation.ts` to Codex. Files: `account-rotation.ts`,
`agent-auth.ts`, session actions, i18n, tests. Depends: U6. Port. Size M.

### Wave 3

**U14 - ACP provider bindings.** Launch argv and capability policy for the
ACP-capable agents (claude via the Claude Code ACP adapter, gemini, qwen 0.16+,
kimi, cursor, droid, grok `agent stdio`, opencode, opencode-v2, pi, omp 15+,
kimchi, hermes, command-code, deepseek-harness, copilot, agy, docker-agent) and
the Codex `app-server` driver (newline JSON, answer server->client requests or
the turn stalls - `chatdriver/codexappserver/rpc.go`). A "Chat / Terminal"
switch per session. Depends: U9, U1, U2. Port. Size L - split U14a (Claude,
Gemini, Qwen, Kimi, Cursor), U14b (the rest), U14c (Codex app-server).

**U15 - Reviewer agent for session PRs.** Pick a reviewer CLI per repository;
on each new PR head of a session (AO `autoreview/`) run it read-only in a
separate container on a pinned checkout with no push credentials (the
`reviewgateway` boundary, ADR 0002), store the result, show it on the PR tab,
and feed requested changes through U10. Reuse agent-runtime Review mode where
it fits. Files: `review-gate.ts`, new `lib/agents/session-reviewer.ts`, U12
components, settings, i18n, tests. Depends: U4, U10, U12. Port. Size M.

**U16 - Orchestrator verbs for the coordinator + Tasks link.** Expose to a
coordinator session (MCP tools on the session's existing MCP config,
`session-hooks.ts` `mcpConfig`): spawn worker (agent, model, prompt), send to
worker, list children with derived status, claim PR, preview URL. Per-repository
default agent/model per role (coordinator, worker, reviewer). In Tasks: a run's
tasks are created as Tasks items, their status follows the session, and a run
can start from a Tasks selection. Files: `orchestration-service.ts`, MCP route,
`tasks/hand-to-agent.tsx`, tasks actions, i18n, tests. Depends: U4, U11. Port.
Size L - split U16a (coordinator tools + roles), U16b (Tasks two-way link).

**U17 - Phone surfaces, part 1.** Mobile layouts of: workers list by status
(from U11), session chat with approve/deny and reply, notifications inbox,
"Open on phone" QR with the existing device sign-in. Responsive routes, not a
separate app; push actions (reply/approve) where the platform supports
notification actions. Files: Polar Code session/board components, `public/sw.js`
actions, i18n, tests. Depends: U5, U11. Size M.

**U18 - Phone surfaces, part 2.** Compose/spawn with agent and model sheets,
PR list and reviewer result, files/changes review, preview, terminal input on
touch. Depends: U12, U15, U17. Size M.

### Wave 4 (bigger or after other branches)

**U19 - Usage collectors and cost.** Per-CLI usage readers (OpenCode DB, Qwen,
Goose, Grok, Pi family, Codex) into `session-usage.ts`, prices from the model
catalogue, per-session cost, limit history. Depends: U1, U2, U7. Port. Size M.

**U20 - Artifacts.** A deliverables folder per session, versions on change,
rendered view, share link through Polaris's public-link primitives; vendor
`packages/shared/artifacts/deliverables.ts` and `turn-artifacts.ts` if they fit
unchanged (keep headers, NOTICE entry). Size M.

**U21 - Agent switch and restore.** Switch a session to another agent with a
summary plus a file holding the full conversation (AO Cloud's handoff); restore
a stopped session into a new container from its saved WIP branch
(`session-work.ts`). Depends: U9 for chat-mode sessions. Size M.

**U22 - Worker browser.** Headless Chromium inside the session container driven
by the agent (MCP browser tools), frames streamed to the session page with
remote input. Size L.

**U23 - "This computer" extras.** After the runner relay merges: worktrees
instead of clones, import native history, notice hand-started agents in shell
tabs. Size M.

**U24 - Small items.** Cues per repository, schedule trigger for sessions,
configured preview command, session search, send a diff selection to the agent,
extra shell tabs. Each S; one run can take two or three.

### Dependency summary

| Unit | Depends on |
| --- | --- |
| U1, U2, U3, U4, U5, U6, U7 | - |
| U8 | U1, U2, U3 |
| U9 | - (can start in wave 1 if capacity allows) |
| U10, U11, U12 | U4 |
| U13 | U6 |
| U14 | U9, U1, U2 |
| U15 | U4, U10, U12 |
| U16 | U4, U11 |
| U17 | U5, U11 |
| U18 | U12, U15, U17 |
| U19 | U1, U2, U7 |
| U20, U22, U24 | - |
| U21 | U9 |
| U23 | runner relay branch |

## Not taken, with the reason

- Telemetry (`telemetrymeta`, `deliverytelemetry`, PostHog): out of scope.
- Computer use (`service/computeruse`, Cua Driver), awake and closed-lid wake
  (`service/awake`, ADR 0005/0006), agent-requested split panes
  (`service/panes`): desktop-window features with no server-side meaning.
- LAN listener, tunnels and pairing passwords (ADR 0001/0004): Polaris is
  already an authenticated HTTPS server.
- Coder templates, AO account and Cloud control plane: Polaris's session pool and
  enrolled servers fill that role.
- Unreal Agent: bundled inside AO; nothing to install.
- Legacy/dev data import (`legacyimport`, `devimport`) and daemon plumbing
  (section 2.6).
