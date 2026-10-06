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
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { toJsonSchema } from "./json-schema";
import { scopeCategory, type McpCategory, type McpScope } from "./scope-table";

/** The revision of MCP this speaks. Sent back on initialize when the client asks
 *  for something else, which is the protocol's own way of saying "this is what I
 *  have" rather than refusing to talk. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Revisions whose request shapes this handles. A client asking for one of these
 *  is answered in the one it asked for. */
const SPOKEN_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Who is calling, resolved from their credential before any tool runs. */
export interface McpCaller {
    readonly userId: string;
    readonly isAdmin: boolean;
    /** What the presented key may do, already intersected with what its owner
     *  holds. A tool asks for one of these and gets it or does not run. */
    readonly scopes: readonly McpScope[];
    /** The key that is calling, for the audit trail of anything a tool changes.
     *  Absent for a session's own token, which is not a key. */
    readonly keyId?: string | null;
    /** Set on a token minted from a Deploy project: the deploy tools reach that
     *  project and no other. */
    readonly projectId?: string | null;
    /** The connected app (an OAuth grant) that is calling, when the credential
     *  is an access token rather than a key. Exactly one of this and `keyId` is
     *  set for a person's own client; neither for a session's token. */
    readonly grantId?: string | null;
    /** The agent session whose own token is calling. Set only when neither
     *  `keyId` nor `grantId` is, so each session spends its own budget. */
    readonly sessionId?: string | null;
    /** For a connected app: the database connections its person let the
     *  database tools reach. Null or absent is every one the person can open,
     *  which is what a key and a session's own token reach. */
    readonly databaseIds?: readonly string[] | null;
}

/** What a tool gives back. Text because that is what a model reads; `structured`
 *  alongside it for the clients that would rather have the object than parse the
 *  prose back out of it. */
export interface McpToolResult {
    readonly text: string;
    readonly structured?: unknown;
    /** Pictures that go with the text - a camera's frame - sent as MCP image
     *  content after it. Every revision this speaks defines image content, and a
     *  client that draws no pictures still has the sentence. */
    readonly images?: readonly McpImage[];
}

/** One picture in a tool's answer: the bytes as base64, and what they are. */
export interface McpImage {
    readonly data: string;
    readonly mimeType: string;
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
    /** The scope a key must carry, or a list of which any one will do (a tool
     *  that still answers a scope it was split out of). Null for a tool that
     *  only needs a valid key, which so far is nothing that reads or writes
     *  anybody's data. */
    readonly scope: McpScope | readonly McpScope[] | null;
    /** The heading `polaris_tools` lists it under, the same one its scope is
     *  grouped under on the consent screen (`MCP_CATEGORIES`). Optional so an
     *  app built before it existed still loads; left out, it is read from the
     *  tool's scope (`toolCategory`). Every tool here sets it; a test holds
     *  them to that. */
    readonly category?: McpCategory;
    /** Whether calling it can change anything. Advertised to the client, which is
     *  what lets an agent be run in a mode that may look but not touch. */
    readonly readOnly: boolean;
    /** For a tool that changes something: whether the change can destroy or
     *  overwrite what was there (true, the default) or only adds (false). A
     *  client asks before a destructive call, so marking an additive one as
     *  destructive costs a confirmation and marking a destructive one additive
     *  costs the confirmation that mattered. */
    readonly destructive?: boolean;
    /** Calling it twice with the same arguments does nothing the first call did
     *  not. */
    readonly idempotent?: boolean;
    /** What a client shows a person in place of the name. */
    readonly title?: string;
    run(input: Input, caller: McpCaller): Promise<McpToolResult>;
}

/** The scopes any one of which lets a caller use a tool; empty for none. */
export function toolScopes(tool: Pick<McpTool<never>, "scope">): readonly McpScope[] {
    if (tool.scope === null) return [];
    return typeof tool.scope === "string" ? [tool.scope] : tool.scope;
}

/** The heading a tool is listed under: its own, else its first scope's. */
export function toolCategory(tool: Pick<McpTool<never>, "scope" | "category">): McpCategory {
    if (tool.category) return tool.category;
    const [first] = toolScopes(tool);
    return first ? scopeCategory(first) : "polaris";
}

/**
 * A tool, typed by what its schema parses to, as the catalogue holds it.
 *
 * The catalogue is one list of tools whose inputs all differ, so each is
 * stored with its input type erased; this is the one place that erasure
 * happens, after the compiler has checked the tool against its own schema.
 */
export function defineMcpTool<Input>(tool: McpTool<Input>): McpTool<never> {
    return tool as unknown as McpTool<never>;
}

/** A tool as MCP describes it on the wire. */
export function describeTool(tool: McpTool<never>): Record<string, unknown> {
    const destructive = !tool.readOnly && (tool.destructive ?? true);
    return {
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: toJsonSchema(tool.input as z.ZodTypeAny),
        annotations: {
            ...(tool.title ? { title: tool.title } : {}),
            readOnlyHint: tool.readOnly,
            destructiveHint: destructive,
            idempotentHint: tool.readOnly || (tool.idempotent ?? false),
            // Everything these tools reach is this Polaris and nothing past it.
            openWorldHint: false
        }
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
    return {
        jsonrpc: "2.0",
        id,
        error: data === undefined ? { code, message } : { code, message, data }
    };
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
export function toolFailure(id: JsonRpcId, message: string): JsonRpcResponse {
    return ok(id, { content: [{ type: "text", text: message }], isError: true });
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface McpServerInfo {
    readonly name: string;
    /** What a client shows people instead of `name` (MCP 2025-06-18 on). */
    readonly title?: string;
    readonly version: string;
    /** The mark a client draws beside the server (MCP 2025-11-25, SEP-973). */
    readonly icons?: readonly Icon[];
    /** Shown by clients that offer the server's own instructions to the model. */
    readonly instructions: string;
}

/** Revisions compare as their dates do. */
const TITLE_SINCE = "2025-06-18";
const ICONS_SINCE = "2025-11-25";

/** `serverInfo` in the revision the client agreed to: `title` and `icons` only
 *  where that revision defines them, so a client on an older one is sent the
 *  shape it was written against. */
function serverInfoFor(server: McpServerInfo, version: string) {
    return {
        name: server.name,
        ...(server.title && version >= TITLE_SINCE ? { title: server.title } : {}),
        version: server.version,
        ...(server.icons?.length && version >= ICONS_SINCE ? { icons: server.icons } : {})
    };
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
    // A message with no id is a notification, and JSON-RPC 2.0 says a notification
    // gets no response - not even to a method that would otherwise have answered.
    // The only ones a client sends here are lifecycle announcements, and none of
    // them needs anything doing; answering one anyway would hand a conformant
    // client a response with no request to match it to.
    if (parsed.data.id === undefined) return null;

    switch (method) {
        case "initialize": {
            const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
            const version = SPOKEN_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION;
            return ok(id, {
                protocolVersion: version,
                capabilities: { tools: { listChanged: false } },
                serverInfo: serverInfoFor(server, version),
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
    if (!tool)
        return fail(id, RPC_INVALID_PARAMS, `There is no tool called ${name || "(unnamed)"}`);

    // Scope before shape. A caller who may not use the tool at all should not
    // learn its argument names by being told which of them they got wrong.
    const needs = toolScopes(tool);
    if (needs.length > 0 && !needs.some((scope) => caller.scopes.includes(scope))) {
        return toolFailure(
            id,
            `This connection cannot ${tool.name}. It needs the ${needs[0]} scope.`
        );
    }

    const args = tool.input.safeParse(params.arguments ?? {});
    if (!args.success) {
        const first = args.error.issues[0];
        const where = first?.path.join(".");
        return fail(
            id,
            RPC_INVALID_PARAMS,
            where ? `${where}: ${first?.message}` : (first?.message ?? "Bad arguments")
        );
    }

    try {
        const result = await tool.run(args.data as never, caller);
        return ok(id, {
            content: [
                { type: "text", text: result.text },
                ...(result.images ?? []).map((image) => ({
                    type: "image",
                    data: image.data,
                    mimeType: image.mimeType
                }))
            ],
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
