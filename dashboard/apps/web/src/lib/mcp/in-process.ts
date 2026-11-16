/**
 * Polaris's MCP server, reached in-process: the connector a client inside
 * Polaris uses (Polar's chat, its subagents, a native agent session) instead
 * of an HTTP round trip to `/api/mcp`.
 *
 * Every message goes through `handleMcpMessage`, the same function the HTTP
 * endpoint answers with, so `tools/list` is the list an external assistant
 * with the same scopes gets, and a `tools/call` is held to the same scope
 * check, the same input parse, the same record-level checks inside each tool
 * and the same refusal wording. Only the caller is built differently: from
 * the signed-in person rather than from a key (`polarCaller`), and with the
 * tools they switched off `hidden`, which the protocol itself enforces.
 *
 * No token is minted and nothing leaves the process. Server-only.
 */

import {
    handleMcpMessage,
    offeredTo,
    RPC_INVALID_PARAMS,
    type McpCaller,
    type McpServerInfo,
    type McpTool
} from "./protocol";

/** A tool as `tools/list` describes it. */
export interface McpToolDescriptor {
    readonly name: string;
    readonly title?: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly annotations?: Record<string, unknown>;
}

/** How one `tools/call` went, read back from its JSON-RPC answer. */
export type McpCallOutcome =
    /** The tool ran, or refused in words written for the model (`isError`). */
    | { readonly kind: "result"; readonly ok: boolean; readonly text: string; readonly structured: unknown }
    /** The arguments did not parse against the tool's own schema. */
    | { readonly kind: "invalid"; readonly message: string }
    /** No tool by that name is offered to this caller. */
    | { readonly kind: "missing" };

export interface McpConnection {
    /** `tools/list` as this caller. */
    list(): Promise<McpToolDescriptor[]>;
    /** `tools/call` as this caller. */
    call(name: string, args: unknown): Promise<McpCallOutcome>;
}

/** What the server says about itself in-process; only `initialize` reads it. */
const IN_PROCESS_SERVER: McpServerInfo = {
    name: "polaris",
    // i18n-ignore read by a client, not shown to a person
    title: "Polaris",
    version: "1",
    instructions: ""
};

/** Loaded on first use: the catalogue reaches every installed app's extension. */
async function catalogueTools(): Promise<readonly McpTool<never>[]> {
    const { mcpTools } = await import("./catalog");
    return mcpTools();
}

/**
 * A connection to this Polaris's MCP server as `caller`. `tools` is the
 * catalogue to answer from; left out, the live one (`mcpTools`) is read once
 * per connection, so an app installed mid-conversation shows on the next turn.
 */
export function connectInProcess(
    caller: McpCaller,
    tools?: readonly McpTool<never>[]
): McpConnection {
    let loaded: Promise<readonly McpTool<never>[]> | null = tools ? Promise.resolve(tools) : null;
    const catalogue = () => (loaded ??= catalogueTools());
    let sequence = 0;
    const send = async (method: string, params?: Record<string, unknown>) =>
        handleMcpMessage(
            { jsonrpc: "2.0", id: ++sequence, method, ...(params ? { params } : {}) },
            await catalogue(),
            caller,
            IN_PROCESS_SERVER
        );
    return {
        async list() {
            const reply = await send("tools/list");
            const result = reply && "result" in reply ? reply.result : null;
            return ((result as { tools?: McpToolDescriptor[] } | null)?.tools ?? []).slice();
        },
        async call(name, args) {
            const offered = (await catalogue()).some(
                (tool) => tool.name === name && offeredTo(tool, caller)
            );
            if (!offered) return { kind: "missing" };
            const reply = await send("tools/call", { name, arguments: args ?? {} });
            if (!reply) return { kind: "missing" };
            if ("error" in reply && reply.error) {
                if (reply.error.code !== RPC_INVALID_PARAMS) return { kind: "missing" };
                return { kind: "invalid", message: reply.error.message };
            }
            const result = (reply as { result?: unknown }).result as {
                content?: { type: string; text?: string }[];
                structuredContent?: unknown;
                isError?: boolean;
            };
            const text = (result.content ?? [])
                .filter((part) => part.type === "text" && typeof part.text === "string")
                .map((part) => part.text)
                .join("\n");
            return {
                kind: "result",
                ok: result.isError !== true,
                text,
                structured: result.structuredContent ?? null
            };
        }
    };
}
