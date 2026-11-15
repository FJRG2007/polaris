/**
 * Tool parameters a server asks to see as HTTP headers: a property of a
 * tool's `inputSchema` marked `"x-mcp-header": "Region"` has its value sent
 * as `Mcp-Param-Region` on the `tools/call` request, beside the body
 * (SEP-2243; MCP 2026-07-28, Streamable HTTP, "Custom Headers from Tool
 * Parameters"). Stripe's server marks `livemode` and `stripe_context` this
 * way.
 *
 * The SDK in use (1.32.x) does not do it, so it is done here, as the spec
 * words it:
 * - a marked property counts only where a chain of `properties` keys reaches
 *   it, has a primitive type (`string`, `integer`, `boolean`), and a header
 *   name that is an RFC 9110 token, unique in any casing. Anything else makes
 *   the whole tool invalid, and an invalid tool is left out of the list.
 * - a value that is not plain printable ASCII - a CR or LF among them, a
 *   leading or trailing space, or text that already looks like the sentinel -
 *   is sent as `=?base64?<utf-8 base64>?=`, so a value can never break out of
 *   its header. A null or absent value sends no header.
 *
 * Pure: every rule here is asserted in `test/polar/connectors/param-headers`.
 */

const PREFIX = "Mcp-Param-";
const MARK = "x-mcp-header";
/** RFC 9110 section 5.1 `token`: no space, control character or delimiter. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TYPES = new Set(["string", "integer", "boolean"]);
const SENTINEL_START = "=?base64?";
const SENTINEL_END = "?=";

/**
 * Keywords whose subschemas a `properties` chain may not pass through. A mark
 * found under any of them makes the tool invalid.
 */
const UNREACHABLE = [
    "items",
    "prefixItems",
    "additionalItems",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
    "oneOf",
    "anyOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "$defs",
    "definitions"
];
/** Of those, the ones whose value is a map of name to subschema. */
const MAPS = new Set(["patternProperties", "dependentSchemas", "dependencies", "$defs", "definitions"]);

export interface ParamHeader {
    /** The property keys from the schema root to the marked property. */
    path: string[];
    /** The full header name, `Mcp-Param-<mark>`. */
    header: string;
}

export type ParamHeaderScan =
    { valid: true; headers: ParamHeader[] } | { valid: false; reason: string };

/** The marked properties of `inputSchema`, or why the tool is invalid. */
export function scanParamHeaders(inputSchema: unknown): ParamHeaderScan {
    const headers: ParamHeader[] = [];
    const seen = new Map<string, string>();
    const visit = (node: unknown, path: string[], reachable: boolean): string | null => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return null;
        const schema = node as Record<string, unknown>;
        const where = path.length ? path.join(".") : "<root>";
        if (MARK in schema) {
            if (!reachable || !path.length)
                return `${where}: ${MARK} is only allowed on a property reached through properties`;
            const name = schema[MARK];
            if (typeof name !== "string" || !TOKEN.test(name))
                return `${where}: ${MARK} must be a non-empty HTTP token`;
            if (typeof schema.type !== "string" || !TYPES.has(schema.type))
                return `${where}: ${MARK} is only allowed on a string, integer or boolean`;
            const prior = seen.get(name.toLowerCase());
            if (prior !== undefined) return `${MARK} "${name}" repeats "${prior}"`;
            seen.set(name.toLowerCase(), name);
            headers.push({ path, header: `${PREFIX}${name}` });
        }
        const properties = schema.properties;
        if (properties && typeof properties === "object" && !Array.isArray(properties)) {
            for (const [key, child] of Object.entries(properties)) {
                const fault = visit(child, [...path, key], reachable);
                if (fault) return fault;
            }
        }
        for (const keyword of UNREACHABLE) {
            const sub = schema[keyword];
            if (!sub || typeof sub !== "object") continue;
            const branches = Array.isArray(sub)
                ? sub
                : MAPS.has(keyword)
                  ? Object.values(sub)
                  : [sub];
            for (const branch of branches) {
                const fault = visit(branch, [...path, `<${keyword}>`], false);
                if (fault) return fault;
            }
        }
        return null;
    };
    const fault = visit(inputSchema, [], true);
    return fault ? { valid: false, reason: fault } : { valid: true, headers };
}

/**
 * A primitive argument as the header's text: a string as it is, a boolean as
 * `true`/`false`, a safe integer in decimal. Null for anything else (a
 * fraction, an object), which sends no header.
 */
export function paramText(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    return null;
}

/**
 * `text` as a header value: unchanged when it is printable ASCII with no
 * space at either end and does not look like the sentinel, the sentinel
 * around its UTF-8 Base64 otherwise. The result never holds a control
 * character or a byte past 0x7E.
 */
export function encodeParamValue(text: string): string {
    let plain = !/^[ \t]|[ \t]$/.test(text);
    if (plain && text.startsWith(SENTINEL_START) && text.endsWith(SENTINEL_END)) plain = false;
    for (let index = 0; plain && index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code < 0x20 || code > 0x7e) plain = false;
    }
    if (plain) return text;
    return `${SENTINEL_START}${Buffer.from(text, "utf8").toString("base64")}${SENTINEL_END}`;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
    let node = root;
    for (const key of path) {
        if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
        if (!Object.hasOwn(node, key)) return undefined;
        node = (node as Record<string, unknown>)[key];
    }
    return node;
}

/**
 * The `Mcp-Param-*` headers one call to a tool with `inputSchema` carries for
 * `input`. None for a tool whose marks are invalid: such a tool is never
 * listed, and one stored before this rule only loses its headers.
 */
export function paramHeadersFor(inputSchema: unknown, input: unknown): Record<string, string> {
    const scan = scanParamHeaders(inputSchema);
    const sent: Record<string, string> = {};
    if (!scan.valid) return sent;
    for (const { path, header } of scan.headers) {
        const text = paramText(valueAt(input, path));
        if (text !== null) sent[header] = encodeParamValue(text);
    }
    return sent;
}

/**
 * `fetch` with `headers` added to the one request that is a `tools/call` of
 * `tool`, and to no other: the SDK sends the initialize handshake and its
 * notifications through the same function.
 */
export function withParamHeaders<F extends (url: string | URL, init?: RequestInit) => Promise<Response>>(
    fetch: F,
    tool: string,
    headers: Readonly<Record<string, string>>
): F {
    if (!Object.keys(headers).length) return fetch;
    return (async (url: string | URL, init: RequestInit = {}) => {
        if ((init.method ?? "GET").toUpperCase() !== "POST" || !isToolCall(init.body, tool))
            return fetch(url, init);
        const merged = new Headers(init.headers);
        for (const [name, value] of Object.entries(headers)) merged.set(name, value);
        return fetch(url, { ...init, headers: merged });
    }) as F;
}

function isToolCall(body: unknown, tool: string): boolean {
    if (typeof body !== "string") return false;
    try {
        const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } };
        return message?.method === "tools/call" && message.params?.name === tool;
    } catch {
        return false;
    }
}
