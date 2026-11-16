# OC20 - remaining work

Landed in `97a8bad354`: `polaris-agent acp` (`dashboard/apps/web/src/lib/polar/native/acp-agent.ts`,
`acp-workspace.ts`), the editor setup block (`lib/polar/acp-setup.ts`, `app/(app)/polar/settings/polar-editors.tsx`),
tests in `test/polar/native/acp-agent.test.ts` and `test/polar/acp-setup.test.ts`.

The four follow-ups below are designed but not written. All facts were checked against SDK 2.2.0
(`node_modules/@agentclientprotocol/sdk/dist/v1/schema/types.gen.d.ts`) and the code.

## 1. session/load

- Advertise `agentCapabilities.loadSession: true`.
- Keep each ACP conversation in the native engine's transcript folder: `transcriptDir()` from `native/launch.ts`,
  `<sessionId>.jsonl`. Add an `AcpStore { append(id, line); read(id): string | null }` dep (file store by default,
  in-memory in tests), and append every line the engine writes in `writeTranscript`.
- Split the session/new body into `open(sessionId, cwd, client)`. On `session/load` (`LoadSessionRequest`:
  `sessionId`, `cwd`, `mcpServers`), check the id against `CONVERSATION_ID` (`native/resume.ts`), read the file, and
  return `sessionNotFound` when it is missing. Then call `engine.restore(replayTranscript(text))`.
- Replay before answering, as the spec asks: user text blocks as `user_message_chunk`, assistant text as
  `agent_message_chunk`, each `tool_use` as a `tool_call` with `status: "completed"` (use `describeCall`), and a
  `tool_result` with `is_error` as a `tool_call_update` with `failed`. Skip `isSidechain` and `isCompactSummary`
  records. Then call `engine.start("resume")` and return `{ modes, configOptions }`.
- Test: run a turn on a session, close it, open a new connection with the same in-memory store, call
  `session/load`, and assert the replayed updates and that the next prompt's model input holds the earlier turn.

## 2. Model choice in the editor

- Stable in 2.2.0: `session/set_config_option` (`SetSessionConfigOptionRequest`: `sessionId`, `configId`, `value`)
  and `configOptions` on the new/load responses. `set_model` is not in the stable method list.
- Add a `select` option to `configOptions` with `id: "model"`, `category: "model"`, `currentValue` = the session's
  model (`POLARIS_MODEL`, default `polar`), and `options` taken from `GET {POLARIS_URL}/api/v1/models` with the key
  (OpenAI shape `data[].id`, Zod-validated and bounded). Fetch the list once per process. If the current model is
  not in the list, put it first.
- On `set_config_option`, accept only `configId === "model"` and a listed value, call
  `engine.setModel(deps.model(value), value)`, and return the full `configOptions`.
- Tests: the option is listed, it switches the model (the next prompt goes to the second mock), and an unknown
  value is refused.

## 3. MCP servers and custom tools

- Custom tools: `lib/polar/custom-tools/session-tools.ts` refuses every session whose place is `computer`
  (`COMPUTER_REFUSAL`), and the tools route takes only a session token. An editor's agent runs on the person's
  computer, so the existing policy says custom tools are not offered there. Changing that is the owner's decision,
  not this unit's.
- MCP: the native engine has no MCP client (grep `native/` - only `custom-tools.ts` mentions it). To honour
  `mcpServers` (stdio `command/args/env`; http `url/headers` when `mcpCapabilities.http`), the engine first needs an
  MCP client that maps each server's tools to `NativeTool`s, with gate `ask`. That is engine work, OC2c-sized.
  Until then, advertise `mcpCapabilities: { http: false, sse: false }` so editors only offer stdio, and say in the
  agent's first `agent_message_chunk` that the listed servers are not mounted.

## 4. Settings block follows permissions

- New server action `editorSetupAccessAction()` beside the routing settings. It calls `requireUser()`, then
  `use = (await polarAccessFor(user.id)).use` (`lib/polar/access.ts`, the check `compat/auth.ts` makes), then
  `keys = (await scopesAvailableTo(user.id, user.isAdmin)).includes("polar.use")` (`@polaris/auth`, the check
  `createApiKeyAction` makes).
- `EditorsCard`: the heading renders at once, and a skeleton covers only the block while the check runs. If `use`
  is false, show the reason ("Your account is not allowed to use Polar") with no snippet. If `keys` is false, show
  the snippet with the placeholder key, hide "Create a key", and say that keys with the Polar permission are not
  available to the account.
- i18n en-US + es-ES within the length rule. Add a component test with the action mocked for all three states.
