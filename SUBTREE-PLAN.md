# Code session subagent tree - remaining work

Done on `feat/code-subagent-tree`: SubagentStart hook, `agentId`/`agentType`/`ref`
on `AgentSessionEvent` (migration `20271119000000`), the route storing them,
`subagents` on `PolarCodeThread`, the tree under the Code thread
(`components/polar/polar-code-subagents.tsx`), Stop on a running node (stops the
turn), i18n en-US/es-ES, parity doc, tests. A subagent's tool calls are
kept out of the main agent's events (`sessionEvents` reads `agentId: null`).

## Not done

1. Open a subagent's own transcript. `ref` on its `subagent.end` row holds
   `agent_transcript_path` (checked; absolute or `~/...`, under
   `~/.claude/projects/**/subagents/*.jsonl` in practice). Read it through
   `lib/agents/session-files.ts` (which refuses absolute paths today - add a
   narrow allowance for that pattern), decode with `decodeClaudeLine` without its
   `isSidechain` skip (`transcript-decoders.ts`), and add an "Open transcript"
   action on a finished node. `PolarCodeThread` strips `transcriptPath` today so
   no machine path reaches the browser; serve it by agent id from the server.
