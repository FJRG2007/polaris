/**
 * The Model Context Protocol, as Polaris speaks it.
 *
 * An agent working on somebody's repository needs to reach the instance that
 * asked it to: read the task it was given, move it to In Progress, leave what it
 * found as a comment, start a second session for the part it cannot do here. MCP
 * is how coding agents are given tools, so exposing Polaris as an MCP server is
 * what makes any of them able to do that without a wrapper per agent.
 *
 * Hand-written rather than taken from the reference implementation, for one
 * reason: the transport that ships with the SDK wants a Node HTTP server, and
 * this runs as a Next route handler with a `Request` and a `Response`. What is
 * left after that is JSON-RPC 2.0 over one POST - a few hundred lines with no
 * dependency, a pure function, and a test suite that does not need a socket.
 *
 * Stateless on purpose. Every call carries its own credential and is authorised
 * on its own, so there is no session to lose, nothing to clean up after an agent
 * that went away, and no way for a second request to inherit the first one's
 * authority. It costs the streaming half of the transport, which nothing here
 * needs: these are tools that return an answer, not a subscription.
 */

import { z } from "zod";
import { toJsonSchema } from "./json-schema";
import type { Permission } from "@polaris/core";

/** The revision of MCP this speaks. Sent back on initialize when the client asks
 *  for something else, which is the protocol's own way of saying "this is what I
 *  have" rather than refusing to talk. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Revisions whose request shapes this handles. A client asking for one of these
 *  is answered in the one it asked for. */
const SPOKEN_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Who is calling, resolved from their credential before any tool runs. */
export interface McpCaller {
    readonly userId: string;
    readonly isAdmin: boolean;
    /** What the presented key may do, already intersected with what its owner
     *  holds. A tool asks for one of these and gets it or does not run. */
    readonly scopes: readonly Permission[];
}

/** What a tool gives back. Text because that is what a model reads; `structured`
 *  alongside it for the clients that would rather have the object than parse the
 *  prose back out of it. */
export interface McpToolResult {
    readonly text: string;
    readonly structured?: unknown;
}

/**
 * A refusal written for the model.
 *
 * The distinction this class exists to make: a tool that says "that space has no
 * status called Done" is telling the model something it can act on, and the
 * sentence should reach it verbatim. Anything ELSE that throws - a query that
 * failed, a host that could not be reached - is describing the inside of the
 * instance, and its message goes no further than the server log. Without the
 * separation the honest choice is between leaking connection strings to whoever
 * holds a key and making every refusal useless.
 */
export class McpRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpRefusal";
    }
}

export interface McpTool<Input = never> {
    readonly name: string;
    /** One line, in the words of somebody deciding whether to call it. This is
     *  the whole basis on which a model chooses, so it says what the tool does
     *  and what it does NOT. */
    readonly description: string;
    /** Typed by what it PARSES TO rather than by what arrives: a schema with
     *  defaults on it accepts less than it produces, and pinning both to one type
     *  would make every tool with an optional argument unassignable. */
    readonly input: z.ZodType<Input, z.ZodTypeDef, unknown>;
    /** The scope a key must carry. Null for a tool that only needs a valid key,
     *  which so far is nothing that reads or writes anybody's data. */
    readonly scope: Permission | null;
    /** Whether calling it can change anything. Advertised to the client, which is
     *  what lets an agent be run in a mode that may look but not touch. */
    readonly readOnly: boolean;
    run(input: Input, caller: McpCaller): Promise<McpToolResult>;
}

/** A tool as MCP describes it on the wire. */
export function describeTool(tool: McpTool<never>): Record<string, unknown> {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: toJsonSchema(tool.input as z.ZodTypeAny),
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly }
    };
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: JsonRpcId;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

/** The codes JSON-RPC reserves, and the ones the tools actually produce. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

const requestSchema = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.record(z.unknown()).optional()
});

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * A tool that refused, reported the way MCP wants it.
 *
 * The distinction is worth keeping: a JSON-RPC error means the call could not
 * happen - the method does not exist, the arguments were the wrong shape - and
 * the client handles it. A tool result with `isError` means the call happened and
 * the answer is a refusal, which the MODEL handles, and which is what "you do not
 * have permission to move that task" is. Reporting the second as the first hides
 * it from the only party who can do anything about it.
 */
function toolFailure(id: JsonRpcId, message: string): JsonRpcResponse {
    return ok(id, { content: [{ type: "text", text: message }], isError: true });
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface McpServerInfo {
    readonly name: string;
    readonly version: string;
    /** Shown by clients that offer the server's own instructions to the model. */
    readonly instructions: string;
}

/**
 * Answer one message.
 *
 * Returns null for a notification, which by JSON-RPC gets no response at all -
 * the route turns that into an empty 202. Never throws: a tool that does is
 * reported as a failed tool call, because an exception escaping here would be a
 * 500 with a stack trace in it going to whoever holds a key.
 */
export async function handleMcpMessage(
    message: unknown,
    tools: readonly McpTool<never>[],
    caller: McpCaller,
    server: McpServerInfo
): Promise<JsonRpcResponse | null> {
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) {
        const id = (message as { id?: JsonRpcId } | null)?.id ?? null;
        return fail(id, RPC_INVALID_REQUEST, "Not a JSON-RPC 2.0 request");
    }

    const { method, params } = parsed.data;
    const id = parsed.data.id ?? null;
    // A message with no id is a notification. The only ones a client sends here
    // are lifecycle announcements, and none of them needs anything doing.
    const isNotification = parsed.data.id === undefined;

    switch (method) {
        case "initialize": {
            const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
            return ok(id, {
                protocolVersion: SPOKEN_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: server.name, version: server.version },
                instructions: server.instructions
            });
        }
        case "ping":
            return ok(id, {});
        case "tools/list":
            return ok(id, { tools: tools.map(describeTool) });
        case "tools/call":
            return callTool(id, params ?? {}, tools, caller);
        default:
            if (isNotification) return null;
            return fail(id, RPC_METHOD_NOT_FOUND, `Polaris does not answer ${method}`);
    }
}

async function callTool(
    id: JsonRpcId,
    params: Record<string, unknown>,
    tools: readonly McpTool<never>[],
    caller: McpCaller
): Promise<JsonRpcResponse> {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return fail(id, RPC_INVALID_PARAMS, `There is no tool called ${name || "(unnamed)"}`);

    // Scope before shape. A caller who may not use the tool at all should not
    // learn its argument names by being told which of them they got wrong.
    if (tool.scope && !caller.scopes.includes(tool.scope)) {
        return toolFailure(id, `This key cannot ${tool.name}. It needs the ${tool.scope} scope.`);
    }

    const args = tool.input.safeParse(params.arguments ?? {});
    if (!args.success) {
        const first = args.error.issues[0];
        const where = first?.path.join(".");
        return fail(id, RPC_INVALID_PARAMS, where ? `${where}: ${first?.message}` : (first?.message ?? "Bad arguments"));
    }

    try {
        const result = await tool.run(args.data as never, caller);
        return ok(id, {
            content: [{ type: "text", text: result.text }],
            ...(result.structured === undefined ? {} : { structuredContent: result.structured })
        });
    } catch (error) {
        // A refusal was written for the model and reaches it as written. Anything
        // else is the inside of the instance - a failed query, an unreachable
        // host - and is logged here rather than handed to whoever holds the key.
        if (error instanceof McpRefusal) return toolFailure(id, error.message);
        console.error(`mcp: ${tool.name} failed`, error);
        return toolFailure(id, `${tool.name} could not be completed. Polaris has logged why.`);
    }
}
