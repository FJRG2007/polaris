# Polar router: what remains

Branch `fix/polar-routing`. Items 1-5 of the brief are done (commits ac45420cbb,
e942f6e6f9). Items 6 and 7 are not built. This file lists why and what to do next.

## 6. Subscriptions answering chat: blocked on a terms decision

Anthropic's Agent SDK docs (code.claude.com/docs/en/agent-sdk/overview, read
2026-11-16): "Unless previously approved, Anthropic does not allow third party
developers to offer claude.ai login or rate limits for their products, including
agents built on the Claude Agent SDK. Use the API key authentication methods
described in the Quickstart instead."

If Polar Chat turns ran on a Claude Pro/Max sign-in, Polaris (software other
people install) would be offering claude.ai rate limits inside its own product.
That holds even when the official CLI runs in headless mode
(`claude -p --output-format stream-json`, already built in
`packages/agent-runtime/agents/claude.ts` around line 1189). Code sessions are a
different case: the person runs Anthropic's own CLI as Claude Code. A chat turn
that uses the CLI only to borrow the subscription is not.

Decision for the operator: get Anthropic's approval, or keep subscriptions for
Code sessions only. The ChatGPT/Codex terms need the same check before Codex
sign-ins answer chat.

If it is approved, the build is:
1. Add a `RouteStep` kind backed by a `LanguageModelV4` adapter. Its `doStream`
   starts `claude -p --output-format stream-json --input-format stream-json` on
   the runner or server that holds the sign-in, using the existing session-runtime
   boot (env through `guardEnv`, files through `asFile`). It maps
   `assistant`/`stream_event` lines to text, reasoning and tool parts.
2. Expose Polaris's chat tools to the CLI through the Polaris MCP
   (`--mcp-config`, `--allowedTools mcp__polaris__*`), and turn the built-in file
   and shell tools off for chat (`--disallowedTools`).
3. Map the CLI's usage-limit result to `rate` (the 5-hour window) and its auth
   failure to `key`, so the router passes over a spent subscription.
4. Plan subscriptions after the API keys (`breadthFirst` keeps a place for them).

## 7. Every provider in Polar Code: blocked on the native agent

API-key models are meant to run Polar Code sessions on Polar's own agent
(memory `polar-native-agent-for-api`). Main does not have that agent yet: a grep
for a native session agent under `apps/web/src/lib` and `packages` turns up
nothing, and sessions still start an external CLI (`lib/agents/session-*.ts`).
The operator's parity rule ("keep the CLI path until parity is shown") means this
work can't switch the session model path. Next steps, in order:
1. Inventory the tools and prompts of the CLI being replaced
   (docs/polar-claude-code-parity.md, sections 2 and 7.5).
2. Build the native loop on `routedModel` (`lib/polar/router/plan.ts`), so code
   sessions get the same plan, logging, reasoning rule and failure trail as chat.
3. List every provider key in the session model picker (`apiKeyOptionsFor` in
   `lib/agents/model-keys.ts` already returns one row per key).
