# Agent catalogue - remaining work

The 38 terminal agents Agent Orchestrator (AO) runs are all in
`dashboard/packages/core/src/agent-clis.ts` (see `docs/agent-catalogue.md`).
What is left, each item needing a value verified against AO source or the tool's
own docs before it is written:

1. Hooks for the new agents. AO writes hooks for kimi, devin, kiro, kilocode,
   vibe, muse, agy, autohand, kimchi, prime-agent, omp, codewhale, mimo-code,
   command-code, memcode, pi, auggie, cline, crush, cursor, droid, goose, qwen,
   amp, opencode, openhands (`backend/internal/adapters/agent/<name>/hooks.go`).
   Port each format into a `firstRun` assert like `codexHooks()` and teach
   `normalizeHookEvent` (`apps/web/src/lib/agents/session-hooks.ts`) its event
   names, then flip `observe` to `hooks`.
2. Model choice: most new agents take `--model`. Add `model: { provider, flag }`
   once the models.dev provider for each is confirmed (AO
   `docs/harnesses/model-catalogs.md`, `adapters/agent/modelcatalog`).
3. Headless one-turn flags (`auggie --print`, `qwen -p`, ...), checked per tool.
4. An ACP client in the session runtime that starts `binary + acp` and speaks
   Agent Client Protocol; the `acp` field already records the arguments.
5. Docker Agent (ACP only), OpenCode 2 (binary name unverified), Unreal Agent
   (built into AO): add once 4 exists / the binary is confirmed.
6. Replace AO's logo copies with each vendor's official brand-kit file when one
   can be fetched (the dev machine has no DNS).
