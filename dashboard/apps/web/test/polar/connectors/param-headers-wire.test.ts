/**
 * `Mcp-Param-*` headers on the wire: a connector call goes through the real
 * MCP SDK client and Streamable HTTP transport, and only the network is
 * replaced, so what is asserted is the request a server would receive.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ID = "0190a000-0000-7000-8000-000000000001";

interface Seen {
    method: string;
    rpc: string | null;
    headers: Headers;
}

const state = vi.hoisted(() => ({
    transport: "http",
    tools: [] as unknown[],
    seen: [] as Seen[]
}));

/** A minimal MCP server, answering the handshake and one tool call. */
async function server(_url: string | URL, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    state.seen.push({ method, rpc: body?.method ?? null, headers: new Headers(init.headers) });
    if (method !== "POST" || !body) return new Response(null, { status: 405 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
        body.method === "initialize"
            ? {
                  protocolVersion: body.params.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "test", version: "1.0.0" }
              }
            : { content: [{ type: "text", text: "ok" }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
}

vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.test" }));
vi.mock("@/lib/polar/connectors/fetch", () => ({ connectorFetch: () => server }));
vi.mock("@/lib/polar/connectors/store", () => ({
    ownConnector: async (ownerId: string, id: string) =>
        ownerId === OWNER && id === ID
            ? {
                  row: {
                      id: ID,
                      ownerId: OWNER,
                      name: "Stripe",
                      url: "https://mcp.stripe.example.test",
                      transport: state.transport,
                      auth: "bearer",
                      enabled: true,
                      tools: state.tools,
                      policies: {},
                      status: "ok",
                      lastError: null,
                      checkedAt: null
                  },
                  secret: { token: "t" }
              }
            : null,
    connectorPolicy: async () => ({ who: "everyone", hosts: [], privateNetwork: false })
}));

const session = await import("@/lib/polar/connectors/session");

const STRIPE_READ = {
    name: "stripe_api_read",
    title: null,
    description: "",
    readOnly: true,
    destructive: false,
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string" },
            livemode: { type: "boolean", "x-mcp-header": "Livemode" },
            stripe_context: { type: "string", "x-mcp-header": "Stripe-Context" }
        }
    }
};

const toolCall = () => {
    const found = state.seen.filter((entry) => entry.rpc === "tools/call");
    expect(found).toHaveLength(1);
    return found[0].headers;
};
const paramNames = (headers: Headers) =>
    [...headers.keys()].filter((name) => name.startsWith("mcp-param-")).sort();

beforeEach(() => {
    state.tools = [STRIPE_READ];
    state.seen = [];
});

describe("a tool call to a connector", () => {
    it("carries the marked arguments as Mcp-Param headers, and the others not", async () => {
        await session.callConnectorTool(OWNER, ID, "stripe_api_read", {
            path: "/v1/customers",
            livemode: true,
            stripe_context: "acct_1Abc"
        });
        const headers = toolCall();
        expect(paramNames(headers)).toEqual(["mcp-param-livemode", "mcp-param-stripe-context"]);
        expect(headers.get("mcp-param-livemode")).toBe("true");
        expect(headers.get("mcp-param-stripe-context")).toBe("acct_1Abc");
        expect(headers.get("authorization")).toBe("Bearer t");
    });

    it("leaves them off every request that is not the call", async () => {
        await session.callConnectorTool(OWNER, ID, "stripe_api_read", { livemode: false });
        const others = state.seen.filter((entry) => entry.rpc !== "tools/call");
        expect(others.length).toBeGreaterThan(0);
        for (const entry of others) expect(paramNames(entry.headers)).toEqual([]);
        expect(toolCall().get("mcp-param-livemode")).toBe("false");
    });

    it("encodes a value that would break the header instead of sending it raw", async () => {
        const hostile = "acct_1\r\nSet-Cookie: session=stolen";
        await session.callConnectorTool(OWNER, ID, "stripe_api_read", {
            stripe_context: hostile
        });
        const headers = toolCall();
        expect(headers.get("set-cookie")).toBeNull();
        expect(headers.get("mcp-param-stripe-context")).toBe(
            `=?base64?${Buffer.from(hostile, "utf8").toString("base64")}?=`
        );
        expect(headers.get("mcp-param-livemode")).toBeNull();
    });

    it("sends none for a tool it has never seen listed", async () => {
        state.tools = [];
        await session.callConnectorTool(OWNER, ID, "stripe_api_read", { livemode: true });
        expect(paramNames(toolCall())).toEqual([]);
    });
});
