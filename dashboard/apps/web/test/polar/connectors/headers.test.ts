/**
 * Header auth: what a connector may send as its own headers, that they are
 * stored with the secret and never shown, that they reach the server on every
 * request, and that a catalog address that needs its trailing slash keeps it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ID = "0190a000-0000-7000-8000-000000000001";

const state = vi.hoisted(() => ({
    rows: [] as Record<string, unknown>[],
    sent: [] as Record<string, string>[]
}));

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_DB_PROVIDER: "sqlite", POLARIS_MASTER_KEY: "key" })
}));
vi.mock("@polaris/storage", () => ({
    CredentialDecryptError: class extends Error {},
    encryptSecret: (plain: string) => ({
        ciphertext: Buffer.from(plain),
        nonce: Buffer.from("n"),
        keyId: "k"
    }),
    decryptSecret: (blob: { ciphertext: Buffer }) => blob.ciphertext.toString()
}));
vi.mock("@/lib/polar/access", () => ({
    readPolarPolicy: async () => ({
        connectors: { who: "everyone", hosts: [], privateNetwork: false }
    })
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.test" }));
vi.mock("@/lib/polar/connectors/fetch", () => ({
    connectorFetch: () => async () => new Response()
}));
vi.mock("@polaris/db", () => {
    const own = (where: { id?: string; ownerId: string }) =>
        state.rows.filter(
            (row) => row.ownerId === where.ownerId && (!where.id || row.id === where.id)
        );
    return {
        prisma: {
            polarConnector: {
                findMany: async ({ where }: { where: { ownerId: string } }) => own(where),
                findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
                    own(where)[0] ?? null,
                create: async ({ data }: { data: Record<string, unknown> }) => {
                    const row = {
                        id: ID,
                        enabled: true,
                        tools: [],
                        toolPolicies: {},
                        status: "new",
                        lastError: null,
                        checkedAt: null,
                        ...data
                    };
                    state.rows.push(row);
                    return row;
                }
            }
        }
    };
});
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: class {
        async connect() {}
        async close() {}
        async callTool() {
            return { content: [] };
        }
    }
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
    StreamableHTTPClientTransport: class {
        constructor(_url: URL, options: { requestInit: { headers?: Record<string, string> } }) {
            state.sent.push(options.requestInit.headers ?? {});
        }
    }
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class {} }));

const rules = await import("@/lib/polar/connectors/policy");
const store = await import("@/lib/polar/connectors/store");
const session = await import("@/lib/polar/connectors/session");

const POLICY = { who: "everyone" as const, hosts: [], privateNetwork: false };
const BOOKING = {
    name: "Booking.com",
    url: "https://demandapi-mcp.booking.com/v1/sp/mcp/",
    auth: "headers",
    catalogId: "booking",
    headers: [
        { name: "X-Booking-Affiliate-Id", value: "1234" },
        { name: "x-booking-authorization", value: "demand-key" }
    ]
};

beforeEach(() => {
    state.rows = [];
    state.sent = [];
});

describe("header names and values", () => {
    const parse = (headers: unknown) =>
        rules.connectorInputSchema.safeParse({
            name: "Server",
            url: "https://mcp.example.com/mcp",
            auth: "headers",
            headers
        });

    it("refuses reserved, malformed, repeated and too many headers", () => {
        for (const name of [
            "Authorization",
            "host",
            "Cookie",
            "content-type",
            "Content-Length",
            "proxy-authorization",
            "mcp-session-id",
            "bad name",
            "x:y",
            ""
        ]) {
            expect(parse([{ name, value: "v" }]).success).toBe(false);
        }
        expect(parse([{ name: "x-a", value: "1" }, { name: "X-A", value: "2" }]).success).toBe(
            false
        );
        const many = Array.from({ length: rules.HEADER_LIMIT + 1 }, (_, index) => ({
            name: `x-h${index}`,
            value: "v"
        }));
        expect(parse(many).success).toBe(false);
        expect(parse([]).success).toBe(false);
        expect(parse(undefined).success).toBe(false);
    });

    it("refuses control characters and oversized values", () => {
        for (const value of ["a\nb", "a\rb", "a\u0000b", "", "x".repeat(rules.HEADER_VALUE_MAX + 1)]) {
            expect(parse([{ name: "x-key", value }]).success).toBe(false);
        }
        const ok = parse([{ name: "X-Key", value: "  secret  " }]);
        expect(ok.success && ok.data.headers).toEqual([{ name: "x-key", value: "secret" }]);
    });

    it("sends the stored headers for headers auth and the bearer otherwise", () => {
        expect(
            rules.connectorRequestHeaders("headers", {
                headers: { "x-key": "v", authorization: "smuggled" }
            })
        ).toEqual({ "x-key": "v" });
        expect(rules.connectorRequestHeaders("bearer", { bearer: "t" })).toEqual({
            authorization: "Bearer t"
        });
        expect(rules.connectorRequestHeaders("none", {})).toEqual({});
    });
});

describe("a header connector end to end", () => {
    it("keeps Booking's trailing slash, stores the headers encrypted, and never shows them", async () => {
        const input = rules.connectorInputSchema.parse(BOOKING);
        const created = await store.createConnector(OWNER, input, POLICY);
        expect(typeof created).toBe("object");
        const row = state.rows[0]!;
        expect(row.url).toBe("https://demandapi-mcp.booking.com/v1/sp/mcp/");
        expect(JSON.parse(Buffer.from(row.secret as Buffer).toString())).toEqual({
            headers: { "x-booking-affiliate-id": "1234", "x-booking-authorization": "demand-key" }
        });
        const [view] = await store.listConnectorViews(OWNER);
        expect(view?.signedIn).toBe(true);
        expect(JSON.stringify(view)).not.toContain("demand-key");
    });

    it("refuses a catalog id with somebody else's address, and strips the slash elsewhere", async () => {
        const forged = rules.connectorInputSchema.parse({
            ...BOOKING,
            url: "https://evil.example.com/v1/sp/mcp/"
        });
        expect(await store.createConnector(OWNER, forged, POLICY)).toBe("address");
        const custom = rules.connectorInputSchema.parse({
            name: "Custom",
            url: "https://mcp.example.com/mcp/"
        });
        await store.createConnector(OWNER, custom, POLICY);
        expect(state.rows[0]?.url).toBe("https://mcp.example.com/mcp");
    });

    it("sends the headers on a call", async () => {
        const input = rules.connectorInputSchema.parse(BOOKING);
        await store.createConnector(OWNER, input, POLICY);
        await session.callConnectorTool(OWNER, ID, "search", {});
        expect(state.sent).toEqual([
            { "x-booking-affiliate-id": "1234", "x-booking-authorization": "demand-key" }
        ]);
    });
});
