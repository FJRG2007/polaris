/**
 * The tools this Polaris offers over MCP right now, and the scopes they use.
 *
 * Core's own tools are one reviewed list (`tools/index.ts`). The installable
 * apps add theirs through the extension registry, and only while they are
 * installed: an app that is not here has no tools on the list, a call to one is
 * a call to a tool that does not exist, and its scopes are not offered to
 * anybody. That is read on every request, not once, so installing or removing
 * an app changes what an assistant sees on its next call.
 *
 * An app's tool is held to what core's are: a name a model can address and no
 * other tool already has, and a scope from the table, because a tool with no
 * scope or a scope nobody can be granted would either be open to every
 * credential or to none. One that breaks either rule is left out and logged.
 *
 * Server-only.
 */

import { MCP_TOOLS } from "./tools";
import { toolScopes, type McpTool } from "./protocol";
import { isLegacyScope, isMcpScope, orderScopes, type McpScope } from "./scope-table";

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

/** Every tool, core's first and then the installed apps', in that order. */
export async function mcpTools(): Promise<McpTool<never>[]> {
    // Loaded here rather than at the top: the registry reaches every installed
    // app's extension, which the core list has no need of.
    const { appMcpTools } = await import("@/lib/app-extensions/registry");
    const tools: McpTool<never>[] = [...MCP_TOOLS];
    const taken = new Set(tools.map((tool) => tool.name));
    for (const { app, tool } of await appMcpTools()) {
        const scopes = toolScopes(tool);
        const problem = !TOOL_NAME.test(tool.name)
            ? "a name a model cannot address"
            : taken.has(tool.name)
              ? "a name another tool already has"
              : scopes.length === 0 || !scopes.every(isMcpScope)
                ? "no scope from the table"
                : null;
        if (problem) {
            console.error(`polaris: ${app}'s MCP tool ${tool.name} has ${problem}; left out.`);
            continue;
        }
        taken.add(tool.name);
        tools.push(tool);
    }
    return tools;
}

/**
 * The scopes a credential can be granted now: every one some available tool
 * asks for, in the table's order. A scope kept only for older grants is not
 * among them - the grants that hold it keep it, and nobody is offered it anew.
 */
export function scopesOf(tools: readonly McpTool<never>[]): McpScope[] {
    const used = new Set<McpScope>();
    for (const tool of tools) {
        for (const scope of toolScopes(tool)) if (!isLegacyScope(scope)) used.add(scope);
    }
    return orderScopes(used);
}
