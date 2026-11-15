# U3 hook files - what is left

Done in this branch: one renderer and per-CLI table
(`dashboard/packages/core/src/agent-hook-files.ts`), event -> activity mapping
(`dashboard/apps/web/src/lib/agents/hook-activity.ts`), Claude Code rendered
through the shared `hookGroup`, and hook files for qwen, goose, droid,
openhands, kimchi, devin, command-code, cursor, agy and autohand (plus the
existing codex, gemini, copilot).

Not covered yet, each needing a writer the first-run program does not have
(it edits JSON only). Source: AO `backend/internal/adapters/agent/<name>/hooks.go`.

1. auggie - `.augment/settings.local.json` must point at executable script
   files (`.augment/ao-hooks/ao-<event>`), not a shell command; needs the boot
   script to write one relay script per event, then one table row.
2. TOML hook files: kimi (`config.toml`, 8 events), vibe (`.vibe/hooks.toml`, 3),
   codewhale (`managed_config.toml`). Needs a TOML-aware writer.
3. Plugin/extension files: opencode, opencode-v2, kilocode, amp, pi, omp,
   prime-agent, crush (JS/TS plugin or extension the CLI loads).
4. kiro - hooks live in an agent definition (`.kiro/agents/ao.json`) that only
   applies when the CLI is started with that agent selected; needs a launch flag.
5. cline (`.clinerules` hook scripts + payload session id), muse (env-prefixed
   command, hook state in AO's data dir), memcode (context-chunk hooks and a
   launch witness), mimo-code - each a custom format.
6. Persist `hookActivity()` per session: U4 (`deriveSessionStatus`) is where it
   is consumed. Today only `sessionEndIsSwap` is wired (events route).
