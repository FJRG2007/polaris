/**
 * The two tools that keep a growing catalogue findable.
 *
 * `polaris_search` finds a thing - a door, a server, a note - across every app
 * the connection reaches, by whatever the person called it, and says which
 * tool acts on it (`lib/mcp/search.ts`). `polaris_tools` finds a tool: the
 * catalogue grouped by category, narrowed by what the model is trying to do.
 *
 * `tools/list` stays complete either way. Hiding tools until they are asked
 * for would rely on clients acting on `tools/list_changed`, which not every
 * assistant does; these only make a long list easier to choose from.
 *
 * Neither needs a scope of its own. Each answers only what the caller's
 * scopes already reach: a provider the caller may not use is never asked, and
 * a tool it cannot call is listed as needing the scope it lacks.
 */

import { z } from "zod";
import { refLine } from "../search";
import * as core from "@polaris/core";
import { MCP_CATEGORIES, type McpCategory } from "../scope-table";
import { toolCategory, toolScopes, type McpTool } from "../protocol";

/** The catalogue as the caller sees it, and every app's search provider -
 *  loaded when a call runs: the catalogue module imports this one. */
async function catalogue() {
    const { mcpSearchProviders, mcpTools } = await import("../catalog");
    const [tools, providers] = await Promise.all([mcpTools(), mcpSearchProviders()]);
    return { tools, providers };
}

const searchInput = z.object({
    query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe(
            'What to find, in the person\'s own words and language: "puerta", "the minecraft server", "factura octubre".'
        ),
    limit: z.number().int().min(1).max(50).default(15).describe("How many results, best first.")
});

const searchTool: McpTool<z.infer<typeof searchInput>> = {
    name: "polaris_search",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Search everything",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Find anything this connection can reach - devices, cameras, rooms, routines, game servers, events, tasks, notes, files, mail, apps - by name, kind or place, in any language. Returns each match with its app, kind, id, and the tools to call next. Use it first when unsure where something lives.",
    input: searchInput,
    category: "polaris",
    scope: null,
    readOnly: true,
    async run(input, caller) {
        const { searchEverywhere } = await import("../search");
        const { tools, providers } = await catalogue();
        const answer = await searchEverywhere({
            query: input.query,
            caller,
            providers,
            tools,
            limit: input.limit
        });
        const lines = answer.refs.map(refLine);
        const missing = answer.missing.length
            ? `\n(No answer in time from: ${answer.missing.join(", ")}. Their own tools may still find it.)`
            : "";
        return {
            text:
                lines.length === 0
                    ? `Nothing this connection can reach matches "${input.query}".${missing}`
                    : (answer.note ? `${answer.note}\n` : "") + lines.join("\n") + missing,
            structured: {
                results: answer.refs,
                matched: answer.matched,
                missing: answer.missing
            }
        };
    }
};

const toolsInput = z.object({
    intent: z
        .string()
        .trim()
        .max(200)
        .default("")
        .describe(
            'What you are trying to do, in any language ("switch on a light", "leer correo"). Empty lists every tool.'
        ),
    category: z.enum(MCP_CATEGORIES).optional().describe("Only the tools of one category.")
});

/** A tool as `polaris_tools` lists it. */
interface ToolRow {
    readonly name: string;
    readonly title: string;
    readonly category: McpCategory;
    readonly purpose: string;
    readonly readOnly: boolean;
    /** The scopes it needs, any one of which will do, when the caller has none. */
    readonly needs: readonly string[];
}

const TOOL_FIELDS: readonly core.SearchField<ToolRow>[] = [
    { text: (row) => row.title, weight: 1 },
    { text: (row) => row.name.replace(/_/g, " "), weight: 0.9 },
    { text: (row) => row.purpose, weight: 0.6 },
    { text: (row) => row.category, weight: 0.6 }
];

/** The first sentence of a description: what the tool is for. */
function purposeOf(description: string): string {
    const end = description.search(/\.(\s|$)/);
    return end === -1 ? description : description.slice(0, end + 1);
}

const toolsTool: McpTool<z.infer<typeof toolsInput>> = {
    name: "polaris_tools",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List tools by category",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The tools this Polaris offers, grouped by category (home, mail, calendar, games, ...) with what each is for and whether this connection may call it. Pass an intent to narrow it to the tools for one job.",
    input: toolsInput,
    category: "polaris",
    scope: null,
    readOnly: true,
    async run(input, caller) {
        const { tools } = await catalogue();
        const rows = tools
            .map(
                (tool): ToolRow => ({
                    name: tool.name,
                    title: tool.title ?? tool.name,
                    category: toolCategory(tool),
                    purpose: purposeOf(tool.description),
                    readOnly: tool.readOnly,
                    needs: toolScopes(tool).some((scope) => caller.scopes.includes(scope))
                        ? []
                        : toolScopes(tool)
                })
            )
            .filter((row) => !input.category || row.category === input.category);
        const found = core.matchForModel(rows, input.intent, TOOL_FIELDS, {
            one: "tool",
            other: "tools"
        });
        // Grouped in the categories' own order; within one, best match first.
        const groups = MCP_CATEGORIES.map((category) => ({
            category,
            tools: found.items.filter((row) => row.category === category)
        })).filter((group) => group.tools.length > 0);
        const text = groups
            .map(
                (group) =>
                    `${group.category}:\n${group.tools
                        .map(
                            (row) =>
                                `  ${row.name} - ${row.purpose}${
                                    row.needs.length ? ` (needs the ${row.needs[0]} scope)` : ""
                                }`
                        )
                        .join("\n")}`
            )
            .join("\n");
        return {
            text: (found.note ? `${found.note}\n` : "") + (text || "No tools."),
            structured: { categories: groups, matched: found.matched }
        };
    }
};

export const DISCOVERY_TOOLS: readonly McpTool<never>[] = [
    searchTool as unknown as McpTool<never>,
    toolsTool as unknown as McpTool<never>
];
