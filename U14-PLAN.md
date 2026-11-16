# U14a - ACP sessions: what is done, what remains

## Done (branch feat/ao-acp-sessions, on top of U9)

- Driver: `lib/agents/acp/session-driver.ts` (`AcpSessionDriver`, injectable
  deps) and `acp/session-drivers.ts` (one per session on `globalThis`, real
  deps). Starts the agent, waits for its pipe, `initialize`, `session/load`
  when the agent can and a vendor id is stored (replay not stored), else
  `session/new`; stores rows with `storeHistoryRows`, closing rows at turn
  end; `prompt` / `permission` / `tool.start` / `turn.end` / `turn.failed`
  through `recordSessionEvents`; restarts the agent on first use after the
  connection ended (dashboard restart, agent exit).
- Routing in `session-runtime.ts`: `promptSession`, `interruptSession`,
  `changeSessionMode` go to the driver when `usesAcp(placement)`;
  `stopSession` closes it; `switchSessionSurface` stores the surface and, on
  leaving Chat, closes the driver and kills the `polaris-acp` window.
- U14a bindings: `lib/agents/acp/providers.ts` (Claude via
  `@agentclientprotocol/claude-agent-acp@0.99.1`, Gemini `--acp`, Qwen
  `--acp` 0.16+, Kimi `acp`, Cursor `acp`).
- `AgentSession.surface` (migration `20271120000200_agent_session_surface`,
  default `terminal`), Chat / Terminal picker in the Polar Code thread,
  `/api/polar/code/surface`, en-US + es-ES.

## Remaining

1. Not exercised in a real container: Docker is not available here. Unverified:
   `npx -y` of the Claude adapter inside the session image (network, npm cache
   as the run-as user), and each CLI's ACP mode against a live agent. The
   per-agent fixtures are composed from docs, not captured.
2. Chat on an agent whose terminal runs it interactively leaves that terminal
   agent running beside the ACP one, in the same checkout. Consider stopping
   the interface window on entering Chat.
3. Qwen's 0.16 floor is recorded but not checked before launch; an older Qwen
   exits and the driver reports "The agent exited as soon as it started."
4. The surface is only switchable on a running session; the start form has no
   Chat option yet.
5. U14b (the remaining ACP agents) and U14c (Codex app-server).

## Next round - status (2026-11-16)

1. DONE 9258fe257a - entering Chat stops the terminal's agent
   (`terminalAgentStopCommand`: runner turn interrupted + interface window
   closed, or every process under the main window's shell ended once the agent
   flag exists); leaving Chat hands the conversation back
   (`conversationHandBackCommand` writes `agent-session-id` for a runner, else
   `resumeAgent` when the terminal is at its shell). `startAcpAgent` also runs
   the stop before every launch. Shell logic not executed (no tmux test run).
2. DONE 52aa1599fb - version floor (`meetsFloor`, `deps.version`), refusal
   `TOO_OLD`, i18n `text.acpTooOld`. Gap: Polaris does not update an old Qwen
   itself; the sentence says to use Terminal.
3. DONE c57f70acb9 + test fix - Conversation picker in the start composer,
   `surface` taken by `polarCodeStart` (own Zod enum, no core schema change),
   applied after creation by `withSurface` when `chatAvailable`.
4. DONE 5124e69a0a - one `polaris-acp-test-u14` container on lirio-0 (node:24,
   no credentials, removed, none left): adapter 0.99.1, Gemini 0.66.0, Qwen
   0.26.5 all answered `initialize`; line 1 of claude/gemini/qwen fixtures is
   now the real frame. Not exercised: session/new and a prompt (needs sign-in),
   kimi and cursor.
5. DONE - U14b: bindings in `acp/providers.ts`, each from the vendor's own
   docs (source named in the file header):

   | Agent | Launch | Floor | Modes |
   | --- | --- | --- | --- |
   | droid | `droid exec --output-format acp` | - | - |
   | grok | `grok agent stdio` | - | - |
   | opencode | `opencode acp` | - | - (1.19.5 offers build/plan as a `mode` config option, not ACP modes) |
   | omp | `omp acp` | 15.0.0 (release "Add ACP conformance support") | - |
   | kimchi | `kimchi --mode acp` | 0.0.7 | default / plan / yolo |
   | hermes | `hermes acp` (needs Hermes's `acp` extra) | - | - |
   | command-code | `command-code acp` (docs: `cmd acp`, same npm entry) | - | default / auto-accept / plan / bypass |
   | deepseek-harness | `dsh --profile acp` | - | none (README: modes, session/load unsupported) |
   | copilot | `copilot --acp` | - | - |
   | agy | `agy acp` | - | - |

   No binding: pi (no vendor ACP mode, only third-party pi-acp adapters),
   opencode-v2 and docker-agent (not in core's catalogue, so no session can
   carry them; Docker Agent also has no terminal mode).
   Real `initialize` captured on lirio-0 (`polaris-acp-test-u14b`, node:24, no
   credentials, removed) for command-code 1.88.2, droid 1.1.0, opencode 1.19.5,
   copilot 1.0.105: line 1 of their fixtures. Composed: grok, omp, kimchi,
   hermes, dsh (no stable npm release two weeks old), agy.
   Gaps: grok's docs advise `--no-auto-update` in automation but not its
   position in `agent stdio`, so it is not passed; Hermes without the `acp`
   extra fails as "exited as soon as it started"; agy's ACP arrived in 1.5.0
   per third-party release notes only, so no floor.
6. NOT STARTED - U14c, Codex `app-server` driver.
