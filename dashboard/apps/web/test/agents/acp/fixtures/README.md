Recorded Agent Client Protocol frames for the ACP client tests.

`prompt-turn.jsonl` is one agent's side of a whole conversation - initialize,
a new session, and a prompt turn with a plan, a message, a tool call that asks
for permission and completes - taken from the examples in the protocol's own
documentation (agentclientprotocol.com: Initialization, Prompt Turn, Tool
Calls). The ids are the ones a client numbering its requests from 0 gets:
initialize 0, session/new 1, session/prompt 2.
