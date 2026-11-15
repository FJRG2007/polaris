# U3 hook files - what is left

Done in this branch (`dashboard/packages/core/src/agent-hook-files.ts`,
`dashboard/apps/web/src/lib/agents/hook-activity.ts`, the first-run program in
`session-commands.ts`):

- JSON hook files from `AGENT_HOOK_FILES`: qwen, goose, droid, openhands,
  kimchi, devin, command-code, cursor, agy, autohand (plus codex, gemini,
  copilot in `agent-clis.ts`).
- `AGENT_HOOK_WRITERS`, with two new first-run answer kinds (`text`, whole
  file Polaris owns, never over a foreign file; `block`, a managed TOML block
  between `# polaris: managed hooks` markers): auggie (relay scripts + settings),
  kimi and vibe (TOML), opencode, kilocode, mimo-code, amp (plugins), pi, omp,
  prime-agent (extensions loaded with `hookArgs: --extension ...`).

Not covered, and why:

1. crush - nothing to port: Agent Orchestrator writes no activity hooks for it
   (`crush/hooks.go` only manages a system-prompt file and the model).
2. codewhale - reports through a `[lifecycle_outbox]` webhook named in a
   managed config that `CODEWHALE_MANAGED_CONFIG_PATH` points at. Needs that
   variable in the launch environment and a route that reads Codewhale's
   lifecycle payloads; neither the payload shape nor the route exists here.
3. kiro - hooks live in an agent definition (`.kiro/agents/<name>.json`) that
   applies only when the CLI starts with that agent selected; needs the
   definition written plus a `hookArgs` agent flag, after reading
   `kiro/hooks.go` in full.
4. cline (`.clinerules` hook scripts, session id from the payload), muse
   (env-prefixed command, state in AO's data dir), memcode (context-chunk
   hooks and a launch witness) - each a custom format; port from their
   `hooks.go` with the `text`/`block` answers.
5. Persist `hookActivity()` per session: U4 (`deriveSessionStatus`) consumes
   it. Today only `sessionEndIsSwap` is wired (events route).

Unverified here (no Docker on this machine): that each tool loads the file
from the path written. The plugins were compiled and driven with events in
`test/agents/hook-writers.test.ts`; the tools themselves were not run.
prime-agent builds without `--extension` will refuse the flag (AO probes
`--help` first; Polaris does not).
