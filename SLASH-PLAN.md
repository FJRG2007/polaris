# Code session subagent tree - remaining work

Branch `feat/polar-slash-subtree`. Item 1 (Enigma slash commands) is committed.
Item 2 has its decoder committed; the wiring below is not done.

## Done

- `dashboard/apps/web/src/lib/agents/session-subagents.ts` - `decodeSubagentTree(events)`
  turns Claude Code hook payloads (PreToolUse/PostToolUse of `Agent`, or `Task`
  before 2.1; `SubagentStart`; tool events carrying `agent_id`; `SubagentStop`
  with `agent_transcript_path`; `Stop`/`StopFailure`/`SessionEnd`) into nodes
  with type, description, status (running/done/failed/stopped), times, steps and
  a checked transcript path. `subagentDuration()`.
- Tests: `dashboard/apps/web/test/agents/session-subagents.test.ts` (fixtures of
  each payload shape).
- Field names checked against code.claude.com/docs/en/hooks: tool events inside a
  subagent carry `agent_id` and `agent_type`; the launcher is `Agent` with
  `description`, `prompt`, `subagent_type`, `model`. The SubagentStart/Stop input
  sections were not in the fetched part of the page; `agent_transcript_path` is
  treated as optional.

## Next

1. Register `{ event: "SubagentStart", matcher: null }` in `HOOK_EVENTS`
   (`apps/web/src/lib/agents/session-hooks.ts:50`) and map it in
   `CLAUDE_EVENT_KINDS`. That needs a new kind `"subagent.start"` in
   `AGENT_SESSION_EVENTS` (`packages/core/src/agent-sessions.ts:96`) - a core
   change, so bump `apps/extension/package.json` and its package-lock entry to
   0.1.171 - plus a label in `apps/web/src/lib/agents/words.ts:305` and both
   locales.
2. Keep the subagent id on stored events. `AgentSessionEvent` has only
   `kind/detail/subject` (`packages/db/prisma/schema.prisma:9224`). Additive,
   re-runnable migration: `ALTER TABLE "AgentSessionEvent" ADD COLUMN IF NOT
   EXISTS "agentId" TEXT` (nullable) and `"ref" TEXT` for the tool_use_id /
   transcript path. Fill them in `apps/web/src/app/api/agents/sessions/[id]/events/route.ts`
   from the raw payload (validate: agent id `^[A-Za-z0-9_-]{1,64}$`). Never
   `prisma format`; check `test/updates/migrations-rerunnable.test.ts`.
3. Feed the decoder: map stored rows back to payload-shaped records (or add a
   row-shaped adapter beside `decodeSubagentTree`) in the Code thread read
   (`/api/polar/code/thread`, `lib/polar/code.ts`) and return `subagents` on
   `PolarCodeThread`.
4. UI in `apps/web/src/components/polar/polar-code.tsx`: a collapsible node per
   subagent (description, type, status chip, live duration, its steps), list
   with `overscroll-contain`, all copy via i18n en-US/es-ES at similar lengths.
5. Stop: Claude Code has no per-subagent stop in hooks (a SubagentStop exit 2
   only keeps one running). Offer "Stop" on a running node that stops the turn
   (existing `/stop` path, `code-commands.ts`) with the note that it stops the
   whole turn.
6. Transcript: open `transcriptPath` through the existing session files reader
   (`lib/agents/session-files.ts`, which today refuses absolute paths - add a
   narrow allowance for `~/.claude/projects/**/subagents/*.jsonl`) and decode it
   with `decodeClaudeLine` without its `isSidechain` skip
   (`transcript-decoders.ts:189`).
7. Parity doc: update the "Subagents" and "Agent view" rows in
   `docs/polar-claude-code-parity.md`.
8. Full web suite (`npx vitest run --maxWorkers=3`) and tsc
   (`-p tsconfig.typecheck.json`) before committing.
