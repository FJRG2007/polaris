# MCP: tools, search and categories

Polaris is one MCP server (`/api/mcp`) for every app installed in it. A model
connects once and reaches home, mail, calendar, games and the rest through it, so
two things matter more than any single tool: the model has to be able to find
what it is looking for, and a person has to be able to read what they are
granting. This page is how to add to it without breaking either.

| Piece | Where |
| --- | --- |
| Protocol, `McpTool`, `toolCategory` | `apps/web/src/lib/mcp/protocol.ts` |
| Scopes and categories | `apps/web/src/lib/mcp/scope-table.ts` |
| Core tools and search providers | `apps/web/src/lib/mcp/tools/*.ts`, listed in `tools/index.ts` |
| `polaris_search`, `polaris_tools` | `apps/web/src/lib/mcp/tools/discovery.ts`, `lib/mcp/search.ts` |
| Tolerant matching | `packages/core/src/entity-match.ts` |
| Labels | `apps/web/messages/<locale>/mcp.json` |

## Add a tool

1. Write it with `defineMcpTool` (core) or `host.mcp.defineTool` (an
   installable app). Required: `name` (`<app>_<verb>`, lowercase), `description`
   (the first sentence is what `polaris_tools` shows), a Zod `input`, `scope`,
   and `readOnly`. Set `destructive` and `idempotent` on anything that writes.
2. `category` is optional: without it the tool is listed under its first
   scope's category. Set it only when that would be wrong.
3. Register it. Core: add it to the list in `tools/index.ts`. An app: return it
   from the `mcpTools` hook of its extension (see
   `apps/places/src/lib/places-extension.ts`). The catalogue
   (`lib/mcp/catalog.ts`) drops, and logs, an app tool whose name is taken or
   whose scope is not in the table.
4. If it takes a search text, match with `findEntities` / `matchForModel` from
   `@polaris/core`, never `includes()`. They fold accents and case, know the
   English and Spanish words for each kind of thing ("puerta" finds a lock),
   forgive typos, and never answer empty while something is reachable: with
   no match they return the closest rows, bounded, with a sentence that says
   so. A store too large to list (mail) filters in its own query first and
   ranks what comes back.
5. Enforce everything finer than the scope inside `run`, with the same checks
   the app's screens use (`placesReach`, the task layer's visible scope). The
   scope only says the credential may use the tool.
6. Test it the way `test/mcp/app-tools-places-games.test.ts` does: through
   `handleMcpMessage`, with the scopes a real grant would carry.

## Add a search provider

Every app that owns things a person names (devices, servers, notes) should be
findable from `polaris_search`. A provider:

```ts
host.mcp.defineSearch({
    id: "databases.connections",          // unique, <app>.<what>
    app: "databases",
    category: "databases",
    scope: "databases.read",              // or a list, any one of which will do
    async search(query, caller, limit) {
        const rows = await reachableConnections(caller.userId, limit);
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            kind: "database",
            where: row.server,
            keywords: [row.engine],       // found by these, not shown
            next: [{ tool: "databases_query", args: { connectionId: row.id } }]
        }));
    }
});
```

- Return candidates, not a verdict. Ranking happens once, in `searchEverywhere`,
  so every app's hits are ordered by the same rule. A provider that reads more
  rows than `limit` passes them through `preferMatches` so what it drops is what
  the query did not name.
- Return only what the caller reaches. The provider is asked only when the
  caller holds its scope; per-item access is the provider's job.
- It has `PROVIDER_TIMEOUT_MS` (4 s) and `PROVIDER_LIMIT` (200 hits). One that
  throws or runs out of time is left out and named in the answer; the search
  still answers.
- `next` steps naming a tool the caller cannot call are removed for you.
- Register it: core in `MCP_SEARCH_PROVIDERS` (`tools/index.ts`), an app from
  the `mcpSearch` hook of its extension.

## Add a category

1. Add the id to `MCP_CATEGORIES` in `scope-table.ts`, where the order is the
   order screens and `polaris_tools` show them.
2. Add `categories.<id>` to `messages/<locale>/mcp.json` in every locale. A test
   (`test/mcp/scope-table.test.ts`) fails while any locale lacks it.
3. File scopes under it: a permission in `PERMISSION_CATEGORIES` (a `Record` over
   every permission, so a new permission without a category does not compile),
   a finer MCP-only scope by its `category` in `MCP_ONLY_SCOPES`.

## Add a scope

One line in `scope-table.ts` and its label `scopes.<area>_<verb>` in each
locale's `mcp.json`. Mark it `sensitive` when it acts outside Polaris or on the
physical world (sending mail, unlocking a door): the consent screen never ticks
it for the person, and a category's "allow everything" box leaves it alone.
