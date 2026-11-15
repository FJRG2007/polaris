/**
 * Talking to a connector: an OAuth token near its end is refreshed once
 * however many calls need it at the same moment, the new tokens are stored on
 * top of what is stored by then, and a callback only ever finishes a sign-in
 * the caller started.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "0190a000-0000-7000-8000-000000000001";

const state = vi.hoisted(() => ({
    owner: "",
    secret: null as Record<string, unknown> | null,
    refreshes: [] as string[],
    finishes: 0,
    bearers: [] as string[],
    duringRefresh: null as null | (() => void),
    /** An access token the server answers 401 to. */
    rejects: null as string | null
}));

vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.test" }));
vi.mock("@/lib/polar/connectors/fetch", () => ({
    connectorFetch: () => async () => new Response()
}));
vi.mock("@/lib/polar/connectors/store", () => {
    const found = (ownerId: string, id: string) =>
        ownerId === state.owner && id === ID
            ? {
                  row: {
                      id: ID,
                      ownerId: state.owner,
                      name: "Linear",
                      url: "https://mcp.linear.app/mcp",
                      transport: "http",
                      auth: "oauth",
                      enabled: true,
                      tools: [],
                      policies: {},
                      status: "ok",
                      lastError: null,
                      checkedAt: null
                  },
                  secret: state.secret ? structuredClone(state.secret) : null
              }
            : null;
    return {
        ownConnector: async (ownerId: string, id: string) => found(ownerId, id),
        connectorPolicy: async () => ({ who: "everyone", hosts: [], privateNetwork: false }),
        updateSecret: async (
            ownerId: string,
            id: string,
            change: (
                secret: unknown
            ) => { secret: Record<string, unknown> | null; result: unknown } | null
        ) => {
            if (!found(ownerId, id)) return null;
            const next = change(state.secret ? structuredClone(state.secret) : null);
            if (!next) return null;
            state.secret = next.secret;
            return next.result;
        },
        recordCheck: async () => undefined,
        viewOf: () => ({})
    };
});
vi.mock("@/lib/polar/connectors/oauth", async (original) => ({
    ...(await original<typeof import("@/lib/polar/connectors/oauth")>()),
    refreshTokens: async (_fetch: unknown, _client: unknown, refreshToken: string) => {
        state.refreshes.push(refreshToken);
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.duringRefresh?.();
        return { accessToken: "fresh", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 };
    },
    finishAuthorization: async () => {
        state.finishes += 1;
        return { accessToken: "a", refreshToken: "r", expiresAt: null };
    }
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: class {
        async connect() {}
        async close() {}
        async callTool() {
            if (state.rejects && state.bearers.at(-1) === `Bearer ${state.rejects}`) {
                throw Object.assign(new Error("Unauthorized"), { code: 401 });
            }
            return { content: [] };
        }
        async listTools() {
            return { tools: [] };
        }
    }
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
    StreamableHTTPClientTransport: class {
        constructor(_url: URL, options: { requestInit: { headers: { authorization: string } } }) {
            state.bearers.push(options.requestInit.headers.authorization);
        }
    }
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class {} }));

const session = await import("@/lib/polar/connectors/session");

const CLIENT = {
    clientId: "c",
    clientSecret: null,
    tokenEndpoint: "https://auth.example.test/token",
    authMethod: "none",
    resource: "https://mcp.linear.app/mcp"
};

beforeEach(() => {
    state.owner = OWNER;
    state.secret = {
        client: CLIENT,
        tokens: { accessToken: "old", refreshToken: "r1", expiresAt: Date.now() - 1 }
    };
    state.refreshes = [];
    state.finishes = 0;
    state.bearers = [];
    state.duringRefresh = null;
    state.rejects = null;
});

describe("a token the server turns away", () => {
    const call = () => session.callConnectorTool(OWNER, ID, "search", {});

    it("is refreshed and the call made again, whatever its stored expiry said", async () => {
        state.secret = {
            client: CLIENT,
            tokens: { accessToken: "old", refreshToken: "r1", expiresAt: null }
        };
        state.rejects = "old";
        await expect(call()).resolves.toEqual({ content: [] });
        expect(state.refreshes).toEqual(["r1"]);
        expect(state.bearers).toEqual(["Bearer old", "Bearer fresh"]);
        expect((state.secret as { tokens: { accessToken: string } }).tokens.accessToken).toBe(
            "fresh"
        );
    });

    it("asks for a sign-in when there is no refresh token to spend", async () => {
        state.secret = {
            client: CLIENT,
            tokens: { accessToken: "old", refreshToken: null, expiresAt: null }
        };
        state.rejects = "old";
        await expect(call()).rejects.toMatchObject({ code: "sign_in" });
        expect(state.refreshes).toEqual([]);
    });

    it("asks for a sign-in when the refreshed token is turned away too, refreshing once", async () => {
        state.secret = {
            client: CLIENT,
            tokens: { accessToken: "old", refreshToken: "r1", expiresAt: null }
        };
        state.rejects = "old";
        state.duringRefresh = () => {
            state.rejects = "fresh";
        };
        await expect(call()).rejects.toMatchObject({ code: "sign_in" });
        expect(state.refreshes).toEqual(["r1"]);
    });
});

describe("refreshing an OAuth token", () => {
    it("spends the refresh token once for calls made together, and stores what it got", async () => {
        await Promise.all([
            session.callConnectorTool(OWNER, ID, "search", {}),
            session.callConnectorTool(OWNER, ID, "search", {}),
            session.callConnectorTool(OWNER, ID, "search", {})
        ]);
        expect(state.refreshes).toEqual(["r1"]);
        expect(state.bearers).toEqual(["Bearer fresh", "Bearer fresh", "Bearer fresh"]);
        expect(state.secret?.tokens).toMatchObject({ accessToken: "fresh", refreshToken: "r2" });
    });

    it("keeps a sign-in started while it ran", async () => {
        state.duringRefresh = () => {
            state.secret = { ...state.secret, pending: { stateHash: "h" } };
        };
        await session.callConnectorTool(OWNER, ID, "search", {});
        expect(state.secret).toMatchObject({
            pending: { stateHash: "h" },
            tokens: { accessToken: "fresh" }
        });
    });

    it("leaves tokens from a sign-in that finished while it ran", async () => {
        state.duringRefresh = () => {
            state.secret = {
                ...state.secret,
                tokens: { accessToken: "signed", refreshToken: "s1", expiresAt: null }
            };
        };
        await session.callConnectorTool(OWNER, ID, "search", {});
        expect(state.secret?.tokens).toMatchObject({ accessToken: "signed", refreshToken: "s1" });
        expect(state.bearers).toEqual(["Bearer signed"]);
    });
});

describe("finishSignIn", () => {
    it("never finishes a sign-in another person started", async () => {
        state.secret = {
            pending: {
                ...CLIENT,
                stateHash: "h",
                verifier: "v",
                redirectUri: "x",
                expiresAt: Date.now() + 60_000
            }
        };
        expect(await session.finishSignIn(OTHER, `${ID}.state`, "code")).toBeNull();
        expect(state.finishes).toBe(0);
        expect(state.secret).toHaveProperty("pending");
    });
});
