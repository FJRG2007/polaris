Recorded Agent Client Protocol frames for the ACP client tests.

`prompt-turn.jsonl` is one agent's side of a whole conversation - initialize,
a new session, and a prompt turn with a plan, a message, a tool call that asks
for permission and completes - taken from the examples in the protocol's own
documentation (agentclientprotocol.com: Initialization, Prompt Turn, Tool
Calls). The ids are the ones a client numbering its requests from 0 gets:
initialize 0, session/new 1, session/prompt 2.

`agents/<cli>.jsonl` is the same conversation for each agent with a provider
binding (`lib/agents/acp/providers.ts`): initialize, a new session, and a turn
with a message in chunks, a tool call that asks for permission and completes,
and the end of the turn. They are composed from the protocol's schema and each
vendor's documented ACP behaviour (the Claude adapter's modes are Claude Code's
permission modes; Cursor documents `agent` / `plan` / `ask` and the
`allow-once` / `reject-once` options), not captured from a running CLI: no agent
was run to make them. Line order: initialize (id 0), session/new (id 1), the
updates, a permission request (id 7), the prompt's result (id 2).
