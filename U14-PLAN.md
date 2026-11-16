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
