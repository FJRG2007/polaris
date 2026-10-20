/**
 * Polar connectors: the rules about a remote MCP server somebody connected,
 * kept pure so every one of them can be asserted.
 *
 * - What a connector is when it is added (`connectorInputSchema`), and the one
 *   form its address is stored in (`canonicalServerUrl`, the MCP spec's
 *   canonical server URI: no fragment, no credentials, no trailing slash).
 * - What its tools are called in a chat: `mcp_<connector>__<tool>`, so one can
 *   never stand in for one of Polaris's own, and two connectors can never
 *   answer to the same name.
 * - What a tool may do before anybody says so. The three answers Claude's
 *   connectors give a tool - always allow, needs approval, blocked - and the
 *   default ChatGPT uses: a tool is a write unless the server marks it
 *   `readOnlyHint`, and one marked `destructiveHint` always asks.
 * - What a tool answers, as the model reads it: somebody else's text, capped
 *   and fenced, never an instruction (`fenceConnectorOutput`).
 * - Which addresses a deployment lets anybody connect: `shared.ts`, which the
 *   admin screen reads too.
 */

import { z } from "zod";
import { createHash } from "node:crypto";

export const CONNECTOR_TRANSPORTS = ["http", "sse"] as const;
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

export const CONNECTOR_AUTHS = ["none", "bearer", "oauth"] as const;
export type ConnectorAuth = (typeof CONNECTOR_AUTHS)[number];

export const TOOL_POLICIES = ["allow", "ask", "block"] as const;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];

/** More connectors than one person keeps; bounds every list and every turn. */
export const CONNECTOR_LIMIT = 20;
/** Tools read from one server; a server listing more is cut here. */
export const CONNECTOR_TOOL_LIMIT = 100;
/** A tool's answer as the model reads it, in characters. */
export const OUTPUT_MAX = 20_000;
/** A tool's input schema, serialized; a bigger one is not offered. */
export const SCHEMA_MAX = 16_000;
/** A call's input, serialized. */
export const INPUT_MAX = 64_000;
/** Provider tool names stop at 64 characters. */
const TOOL_NAME_MAX = 64;
const PREFIX = "mcp_";

/** A name as somebody typed it, trimmed and with its inner spaces collapsed. */
export function normalizeConnectorName(raw: string): string {
    return raw.trim().replace(/\s+/g, " ");
}

/**
 * The address as the MCP spec's canonical server URI, or null for one that
 * cannot be a server: not http(s), carrying credentials, or too long. Plain
 * http is only for a server on the deployment's own network (`insecure`).
 */
export function canonicalServerUrl(raw: string, insecure = false): string | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && !(insecure && url.protocol === "http:")) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    const text = url.href.replace(/\/+$/, "");
    return text.length <= 2048 ? text : null;
}

export const connectorInputSchema = z
    .object({
        name: z
            .string()
            .transform(normalizeConnectorName)
            .pipe(z.string().min(1).max(40)),
        url: z.string().trim().min(1).max(2048),
        transport: z.enum(CONNECTOR_TRANSPORTS).default("http"),
        auth: z.enum(CONNECTOR_AUTHS).default("none"),
        /** The bearer token or API key, for `bearer`. */
        token: z.string().trim().max(4096).optional(),
        /** A client registered by hand, for a server with no registration. */
        clientId: z.string().trim().max(512).optional(),
        clientSecret: z.string().trim().max(4096).optional()
    })
    .superRefine((value, context) => {
        if (value.auth === "bearer" && !value.token) {
            context.addIssue({ code: "custom", path: ["token"], message: "required" });
        }
        if (value.clientSecret && !value.clientId) {
            context.addIssue({ code: "custom", path: ["clientId"], message: "required" });
        }
    });
export type ConnectorInput = z.infer<typeof connectorInputSchema>;

export const toolPolicySchema = z.enum(TOOL_POLICIES);

export const connectorPatchSchema = z
    .object({
        enabled: z.boolean().optional(),
        /** One tool's answer, by the tool's own name. */
        tool: z
            .object({ name: z.string().min(1).max(128), policy: toolPolicySchema })
            .optional()
    })
    .refine((value) => value.enabled !== undefined || value.tool !== undefined);

/** One tool as the server described it, as stored. */
export const cachedToolSchema = z.object({
    name: z.string().min(1).max(128),
    title: z.string().max(200).nullable().default(null),
    description: z.string().max(2000).default(""),
    inputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }),
    readOnly: z.boolean().default(false),
    destructive: z.boolean().default(true)
});
export type CachedTool = z.infer<typeof cachedToolSchema>;

/** A stored tool list, read total: an entry that no longer reads is dropped. */
export function readCachedTools(raw: unknown): CachedTool[] {
    if (!Array.isArray(raw)) return [];
    const tools: CachedTool[] = [];
    for (const entry of raw.slice(0, CONNECTOR_TOOL_LIMIT)) {
        const parsed = cachedToolSchema.safeParse(entry);
        if (parsed.success) tools.push(parsed.data);
    }
    return tools;
}

/** A stored policy map, read total. */
export function readToolPolicies(raw: unknown): Record<string, ToolPolicy> {
    const policies: Record<string, ToolPolicy> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return policies;
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        const parsed = toolPolicySchema.safeParse(value);
        if (parsed.success) policies[name] = parsed.data;
    }
    return policies;
}

/** The MCP `tools/list` entry, as untrusted as anything the server says. */
const listedToolSchema = z.object({
    name: z.string().min(1).max(128),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    annotations: z
        .object({
            title: z.string().optional(),
            readOnlyHint: z.boolean().optional(),
            destructiveHint: z.boolean().optional()
        })
        .passthrough()
        .optional()
});

/**
 * A server's tool list as Polar keeps it: each entry checked, its text cut to
 * size, a schema too big or not an object left out with its tool, and no
 * name twice.
 */
export function toCachedTools(listed: readonly unknown[]): CachedTool[] {
    const tools: CachedTool[] = [];
    const seen = new Set<string>();
    for (const entry of listed) {
        if (tools.length >= CONNECTOR_TOOL_LIMIT) break;
        const parsed = listedToolSchema.safeParse(entry);
        if (!parsed.success || seen.has(parsed.data.name)) continue;
        const schema = parsed.data.inputSchema ?? { type: "object" };
        if (schema.type !== "object" || JSON.stringify(schema).length > SCHEMA_MAX) continue;
        seen.add(parsed.data.name);
        const readOnly = parsed.data.annotations?.readOnlyHint === true;
        tools.push({
            name: parsed.data.name,
            title: (parsed.data.title ?? parsed.data.annotations?.title ?? null)?.slice(0, 200) ?? null,
            description: (parsed.data.description ?? "").slice(0, 2000),
            inputSchema: schema,
            readOnly,
            // The MCP default for a tool that writes is destructive.
            destructive: !readOnly && parsed.data.annotations?.destructiveHint !== false
        });
    }
    return tools;
}

/**
 * What a tool does with no answer stored: a read runs, anything else asks.
 * A server that says nothing about a tool is describing a write.
 */
export function defaultToolPolicy(tool: Pick<CachedTool, "readOnly">): ToolPolicy {
    return tool.readOnly ? "allow" : "ask";
}

export function effectiveToolPolicy(
    tool: Pick<CachedTool, "name" | "readOnly">,
    policies: Readonly<Record<string, ToolPolicy>>
): ToolPolicy {
    return policies[tool.name] ?? defaultToolPolicy(tool);
}

/** The connector's part of a tool name: lowercase letters, digits and "_". */
export function connectorSlug(name: string): string {
    const slug = name
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 20);
    return slug || "server";
}

function shortHash(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * The name a connector's tool goes by in a chat. Every character a provider
 * refuses becomes "_", and a name past the providers' 64 is cut and given a
 * hash of the whole, so it stays one name per tool. The connector's id is in
 * the hash too, so two connectors of the same name stay apart.
 */
export function connectorToolName(connector: { id: string; name: string }, tool: string): string {
    const safe = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
    const base = `${PREFIX}${connectorSlug(connector.name)}__${safe}`;
    if (base.length <= TOOL_NAME_MAX && safe === tool) return base;
    const hash = shortHash(`${connector.id}\u0000${tool}`);
    return `${base.slice(0, TOOL_NAME_MAX - hash.length - 1)}_${hash}`;
}

export function isConnectorToolName(name: string): boolean {
    return name.startsWith(PREFIX);
}

/**
 * Whether a call's input fits the tool's own schema at the top level: an
 * object, no larger than `INPUT_MAX`, every required key present, every key
 * it describes of the type it says, and no key it does not when it closes
 * them. The server checks the rest - this only refuses what is plainly not a
 * call to this tool before it leaves the deployment.
 */
export function inputFits(schema: Record<string, unknown>, input: unknown): boolean {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    let size: number;
    try {
        size = JSON.stringify(input).length;
    } catch {
        return false;
    }
    if (size > INPUT_MAX) return false;
    const values = input as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, { type?: unknown }>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
        if (typeof key === "string" && !(key in values)) return false;
    }
    for (const [key, value] of Object.entries(values)) {
        const described = properties[key];
        if (!described) {
            if (schema.additionalProperties === false) return false;
            continue;
        }
        const types = Array.isArray(described.type) ? described.type : [described.type];
        if (described.type !== undefined && !types.some((type) => typeMatches(type, value))) {
            return false;
        }
    }
    return true;
}

function typeMatches(type: unknown, value: unknown): boolean {
    switch (type) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return Number.isInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "array":
            return Array.isArray(value);
        case "object":
            return Boolean(value) && typeof value === "object" && !Array.isArray(value);
        case "null":
            return value === null;
        default:
            return true;
    }
}

/** The parts of an MCP `tools/call` result Polar reads. */
const callResultSchema = z.object({
    content: z.array(z.object({ type: z.string() }).passthrough()).default([]),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional()
});

/**
 * A tool's answer as text: every text part in order, anything else named by
 * its kind, structured content as JSON when there is no text, and all of it
 * cut to `OUTPUT_MAX`.
 */
export function connectorOutputText(result: unknown): { text: string; isError: boolean } {
    const parsed = callResultSchema.safeParse(result);
    if (!parsed.success) return { text: "", isError: true };
    const pieces: string[] = [];
    for (const part of parsed.data.content) {
        if (part.type === "text" && typeof part.text === "string") pieces.push(part.text);
        else if (part.type === "resource_link" && typeof part.uri === "string") {
            pieces.push(`[${part.type}: ${part.uri}]`);
        } else pieces.push(`[${part.type}]`);
    }
    if (pieces.length === 0 && parsed.data.structuredContent !== undefined) {
        try {
            pieces.push(JSON.stringify(parsed.data.structuredContent));
        } catch {
            // Not serializable is nothing to show.
        }
    }
    let text = pieces.join("\n");
    if (text.length > OUTPUT_MAX) text = `${text.slice(0, OUTPUT_MAX)}\n[cut at ${OUTPUT_MAX} characters]`;
    return { text, isError: parsed.data.isError === true };
}

const FENCE = "untrusted_connector_output";

/** A connector's answer, fenced so the model reads it as quoted content. */
export function fenceConnectorOutput(connector: string, text: string): string {
    const clean = text.replace(new RegExp(`</?${FENCE}[^>]*>`, "gi"), "");
    return [
        `<${FENCE} connector="${connector.replace(/["<>]/g, "")}">`,
        clean,
        `</${FENCE}>`
    ].join("\n");
}
