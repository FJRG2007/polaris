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

## Next round (asked by the coordinator, not started - turn limit)

1. Gap 3: in `switchSessionSurface` (`session-runtime.ts`), on entering Chat
   stop the terminal agent first: `interruptSession` path, then kill the
   interface window (`commands.INTERFACE_WINDOW`) and stop the runner's agent
   process in the main window; on leaving Chat, after `acpStopCommand`,
   `resumeAgent(sessionId, vendorSessionId)` when a vendor id is stored.
   Test the command order in `test/agents/acp`.
2. Gap 4: before `start` in `AcpSessionDriver.open`, when `binding.minVersion`
   is set run `qwen --version` through `runInSession` (new dep `version()`),
   compare semver, and throw `AcpRefusal("Qwen Code 0.16 or later is needed
   for Chat. Update it on the session's machine, or use Terminal.")`; add the
   sentence to `EXACT` in `words.ts` and `agents.json` en-US/es-ES.
3. Gap 5: a Chat / Terminal option in the start form (`polar-code.tsx` start
   area near the `PermissionModePicker` at the start composer), shown only
   when `acpProviders.chatAvailable(cli, place)`; pass `surface` through
   `SessionCreateInput` -> `createSession` data -> the start action's Zod
   schema; reuse `SessionSurfacePicker`.
4. Gap 1/2: one throwaway `polaris-acp-test-*` container on lirio-0 from the
   session image, no credentials; `npx -y @agentclientprotocol/claude-agent-acp@0.99.1`
   resolves; `gemini --acp` / `qwen --acp` answer `initialize`; save the real
   frames over `test/agents/acp/fixtures/agents/{gemini,qwen}.jsonl` lines 1;
   remove the container.
5. U14b: bindings for droid, grok (`agent stdio`), opencode, opencode-v2, pi,
   omp 15+, kimchi, hermes, command-code, deepseek-harness, copilot, agy,
   docker-agent - each only with a flag from the vendor's docs (core's
   `acp` field lists AO's args as a starting point, not a source).
