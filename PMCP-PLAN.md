# Polar reaches Polaris through its MCP server - plan and status

Branch `feat/polar-polaris-mcp`.

## Done (committed)

- `lib/mcp/in-process.ts`: in-process MCP connection (`tools/list`, `tools/call`
  through `handleMcpMessage`). Reusable by the native session agent.
- `McpCaller.hidden`: tools a person switched off are left off `tools/list`,
  refused on `tools/call`, and never named by `polaris_search`/`polaris_tools`.
- `lib/polar/tools.ts`: every Polaris tool call goes through the MCP server;
  switches (`off`, `serversOff`) passed in, mapped by tool name (stored prefs
  unchanged).
- `tool-relevance.ts`: model is sent only discovery (`read_current_view`,
  `find_tools`, `polaris_search`, `polaris_tools`) plus loaded tools, capped at
  `LOADED_MAX` (40) per request; `find_tools` loads by `names`, by English
  `query`, or lists an `area` (paged, language-independent); every answer
  carries the areas. Connector tools are in the same catalog (area = connector
  name) and no longer sent on every request.
- Settings: Polaris tools grouped by category inside the built-in connector,
  search matches category labels.
- Tests: `test/polar/polaris-mcp-parity.test.ts` (68 core tools reachable with
  permissions, refused without, hidden when off), `discovery-languages.test.ts`
  (es/de/ja, Polaris + connector tools), `prompt-size.test.ts` (sizes).

## Remaining

1. Connector spec points still without a fake-server test each:
   pagination (implemented in `connectors/session.ts` `checkConnector`),
   SSE + Streamable HTTP (both implemented), OAuth refresh (implemented),
   annotations -> approvals (implemented in `connectors/policy.ts`),
   structuredContent / isError (implemented). Missing in code:
   - `notifications/tools/list_changed`: connector sessions are per call, so no
     live notification is received; the list refreshes on Check only. Needs a
     long-lived client or refresh-on-call-miss.
   - (done) embedded `resource` content now shows its text.
     shown as `[resource]` in `connectorOutputText`; show its text.
2. Rebase onto origin/main before handing over (fix/polar-mcp-connectors had no
   commits beyond main when checked).
3. Final verification: tsc, vitest test/polar test/mcp test/i18n.
