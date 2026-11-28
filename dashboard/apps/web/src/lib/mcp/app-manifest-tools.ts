/**
 * The MCP tools an installed app declares in its manifest, as tools this
 * server lists and calls.
 *
 * Name, words, gate and shape come from the manifest (`core.appMcpToolDefinitions`),
 * so they are known and checked before the app's bundle is loaded: the scope a
 * key needs is the tool's permission, one of the app's own; the input is
 * checked against the declared fields by the server before the tool runs; and
 * the bundle's handler (`AppExtension.mcpToolHandlers`) only does the work,
 * its answer checked against the declared output before the caller sees it.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import { McpRefusal, type McpTool } from "./protocol";
import type { AppMcpToolHandler } from "@/lib/app-extensions/types";

type Handlers = () => Promise<Readonly<Record<string, AppMcpToolHandler>>>;

function manifestTool(tool: core.RegisteredAppMcpTool, handlers: Handlers): McpTool<never> {
    return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        input: core.appMcpToolInputSchema(tool) as never,
        scope: tool.permission as core.Permission,
        readOnly: tool.readOnly,
        ...(tool.readOnly ? {} : { destructive: tool.destructive ?? true }),
        run: async (input, caller) => {
            const handler = (await handlers().catch(() => ({}) as Record<string, AppMcpToolHandler>))[tool.name];
            if (!handler) throw new McpRefusal(`${tool.name} is not available right now: its app did not load.`);
            let answer: Awaited<ReturnType<AppMcpToolHandler>>;
            try {
                answer = await handler(input as Record<string, unknown>, { userId: caller.userId });
            } catch (caught) {
                console.error(`polaris: the ${tool.app} tool ${tool.name} failed:`, caught);
                throw new Error(`${tool.name} failed`);
            }
            if (answer.refused) throw new McpRefusal(answer.refused.slice(0, 300));
            const output = core.parseAppMcpToolOutput(tool, answer.output ?? {});
            if (!output) {
                console.error(`polaris: the ${tool.app} tool ${tool.name} answered off its declared output`);
                throw new Error(`${tool.name} answered off its declared output`);
            }
            return { text: JSON.stringify(output), structured: output };
        }
    };
}

/** The tools one installed app's manifest declares; none without its handlers. */
export function manifestMcpTools(app: string, handlers: Handlers | undefined): McpTool<never>[] {
    if (!handlers) return [];
    return core
        .appMcpToolDefinitions()
        .filter((tool) => tool.app === app)
        .map((tool) => manifestTool(tool, handlers));
}
