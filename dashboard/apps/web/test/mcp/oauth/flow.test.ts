/**
 * The OAuth flow end to end, through the real route handlers and the real
 * consent action, against an in-memory database: discovery, registration,
 * consent, code exchange, calling /api/mcp with the token, refresh, and every
 * attack the design is meant to stop - a replayed code or refresh token, a
 * stolen code without its verifier, a token presented for another audience, a
 * scope a refresh tries to add, a permission the person no longer holds.
 *
 * What is mocked is what needs a request scope or a network: the client
 * address, the session, the rate limiter, the audit log and the origin.
 */

import { createHash, randomBytes } from "node:crypto";
import { createFakeDb, type FakeUser } from "./fake-db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://polaris.example.test";

const state = vi.hoisted(() => ({
    origin: "https://polaris.example.test",
    permissions: new Set<string>(["tasks.read", "tasks.manage", "deploy.read"]),
    user: { id: "", name: "Ada", email: "ada@example.test", isAdmin: false, sessionId: "s1" } as {
        id: string;
        name: string;
        email: string;
        isAdmin: boolean;
        sessionId: string;
        viewingAs?: unknown;
    },
    rateLimited: false,
    buckets: [] as string[],
    audit: [] as { action: string; actorId: string | null }[],
    db: null as unknown as ReturnType<typeof import("./fake-db").createFakeDb>
}));

const ADA: FakeUser = {
    id: "0190a5b8-0000-7000-8000-00000000ada0",
    name: "Ada",
    email: "ada@example.test",
    username: "ada",
    isAdmin: false,
    bannedAt: null
};
const BOB: FakeUser = { ...ADA, id: "0190a5b8-0000-7000-8000-000000000b0b", name: "Bob", username: "bob" };

vi.mock("@polaris/db", () => ({
    get prisma() {
        return state.db.prisma;
    }
}));
vi.mock("@polaris/auth", () => ({
    getUserPermissions: async () => new Set(state.permissions),
    scopesAvailableTo: async () => [...state.permissions]
}));
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/deploy/api/http", () => ({
    throttleDeployKey: async () => null,
    tooManyCalls: (seconds: number) => `Too many calls. Try again in ${seconds}s.`
}));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.5" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (bucket: string) => {
        state.buckets.push(bucket);
        return state.rateLimited ? { ok: false, retryAfterMs: 30_000 } : { ok: true, retryAfterMs: 0 };
    }
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: { action: string; actorId: string | null }) => {
        state.audit.push({ action: event.action, actorId: event.actorId });
    }
}));
vi.mock("@/lib/network-rules", () => ({ evaluateAccountAccess: async () => ({ allowed: true }) }));
vi.mock("@/lib/agents/session-service", () => ({
    sessionForToken: async (token: string) => (token.startsWith("session-token-") ? { id: token.slice(14) } : null),
    sessionOwner: async () => ADA.id
}));
vi.mock("@/lib/api-key-auth", () => ({
    authenticateApiKey: async (request: Request) =>
        request.headers.get("authorization") === "Bearer plk_test.good"
            ? { keyId: "key-1", userId: ADA.id, scopes: ["tasks.read"], projectId: null }
            : null
}));
vi.mock("@/lib/mcp/oauth/origin", () => ({
    originOf: () => state.origin,
    currentOrigin: async () => state.origin
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/account/security/action-messages", () => ({ localized: async (result: unknown) => result }));
vi.mock("@/lib/notes/access", () => ({
    NoteAccessError: class extends Error {},
    requirePlacement: async () => undefined
}));
vi.mock("@/lib/notes/note-service", () => ({ createNote: async () => "33333333-3333-4333-8333-333333333333" }));
vi.mock("@/lib/notes/shelf-service", () => ({}));

const { createFakeDb: makeDb } = await import("./fake-db");
const register = await import("@/app/api/oauth/register/route");
const token = await import("@/app/api/oauth/token/route");
const revoke = await import("@/app/api/oauth/revoke/route");
const mcp = await import("@/app/api/mcp/route");
const resourceMetadata = await import("@/app/.well-known/oauth-protected-resource/[[...path]]/route");
const serverMetadata = await import("@/app/.well-known/oauth-authorization-server/[[...path]]/route");
const { answerAuthorizationAction } = await import("@/app/oauth/authorize/actions");
const { listConnectedApps, revokeConnectedApp } = await import("@/lib/mcp/oauth/grants");

const REDIRECT = "http://127.0.0.1/callback";

function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registerClient(body: Record<string, unknown> = {}) {
    const response = await register.POST(
        new Request(`${ORIGIN}/api/oauth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                client_name: "Test Assistant",
                redirect_uris: [REDIRECT],
                token_endpoint_auth_method: "none",
                ...body
            })
        })
    );
    return { status: response.status, body: (await response.json()) as Record<string, string> };
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
    return new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:49200/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "opaque-state",
        resource: `${ORIGIN}/api/mcp`,
        scope: "tasks.read deploy.read",
        ...extra
    }).toString();
}

async function tokenCall(params: Record<string, string>, headers: Record<string, string> = {}) {
    const response = await token.POST(
        new Request(`${ORIGIN}/api/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
            body: new URLSearchParams(params).toString()
        })
    );
    return {
        status: response.status,
        headers: response.headers,
        body: (await response.json()) as Record<string, string | number>
    };
}

async function mcpCall(accessToken: string | null, message: Record<string, unknown>) {
    const response = await mcp.POST(
        new Request(`${ORIGIN}/api/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message })
        })
    );
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

/** The whole happy path: register, consent, exchange. */
async function connect(scopes: string[] = ["tasks.read", "deploy.read"], requested = "tasks.read deploy.read") {
    const client = (await registerClient()).body;
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(client.client_id!, challenge, { scope: requested });
    const answer = await answerAuthorizationAction({ query, allow: true, scopes });
    const back = new URL(answer.redirectTo!);
    const code = back.searchParams.get("code")!;
    const tokens = await tokenCall({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:49200/callback",
        client_id: client.client_id!,
        resource: `${ORIGIN}/api/mcp`
    });
    return { client, code, verifier, back, tokens };
}

beforeEach(() => {
    state.db = makeDb([ADA, BOB]);
    state.origin = ORIGIN;
    state.permissions = new Set(["tasks.read", "tasks.manage", "deploy.read"]);
    state.user = { id: ADA.id, name: "Ada", email: ADA.email, isAdmin: false, sessionId: "s1" };
    state.rateLimited = false;
    state.audit = [];
    ADA.bannedAt = null;
});

describe("discovery", () => {
    it("challenges an anonymous call with where to find the metadata", async () => {
        const answer = await mcpCall(null, { method: "tools/list" });
        expect(answer.status).toBe(401);
        expect(answer.headers.get("www-authenticate")).toContain(
            `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`
        );
    });

    it("serves resource metadata at the suffixed and root paths, and nothing else", async () => {
        for (const path of [["api", "mcp"], undefined]) {
            const response = await resourceMetadata.GET(new Request(`${ORIGIN}/x`), {
                params: Promise.resolve({ path })
            });
            const body = (await response.json()) as { resource: string; authorization_servers: string[] };
            expect(body.resource).toBe(`${ORIGIN}/api/mcp`);
            expect(body.authorization_servers).toEqual([ORIGIN]);
        }
        const other = await resourceMetadata.GET(new Request(`${ORIGIN}/x`), {
            params: Promise.resolve({ path: ["api", "v1"] })
        });
        expect(other.status).toBe(404);
    });

    it("serves authorization server metadata whose issuer is the origin", async () => {
        const response = await serverMetadata.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({}) });
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.issuer).toBe(ORIGIN);
        expect(body.token_endpoint).toBe(`${ORIGIN}/api/oauth/token`);
        expect((body.scopes_supported as string[]).length).toBeGreaterThan(0);
    });
});

describe("registration", () => {
    it("registers a public client and stores nothing secret", async () => {
        const { status, body } = await registerClient();
        expect(status).toBe(201);
        expect(body.client_id).toMatch(/^pmc_/);
        expect(body.client_secret).toBeUndefined();
    });

    it("hands a confidential client a secret once, and keeps only its hash", async () => {
        const { body } = await registerClient({ token_endpoint_auth_method: "client_secret_post" });
        expect(body.client_secret).toMatch(/^pms_/);
        const stored = state.db.tables.oAuthClient![0]!;
        expect(stored.secretHash).not.toBe(body.client_secret);
        expect(JSON.stringify(state.db.tables)).not.toContain(body.client_secret);
    });

    it("is throttled", async () => {
        state.rateLimited = true;
        const { status, body } = await registerClient();
        expect(status).toBe(429);
        expect(body.error).toBe("slow_down");
    });

    it("refuses a body over the cap without reading it", async () => {
        const response = await register.POST(
            new Request(`${ORIGIN}/api/oauth/register`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "x".repeat(40_000) })
            })
        );
        expect(response.status).toBe(413);
    });
});

describe("consent and code exchange", () => {
    it("issues a code to the registered address with state and iss, and tokens for it", async () => {
        const { back, tokens } = await connect();
        expect(back.origin).toBe("http://127.0.0.1:49200");
        expect(back.searchParams.get("state")).toBe("opaque-state");
        expect(back.searchParams.get("iss")).toBe(ORIGIN);
        expect(tokens.status).toBe(200);
        expect(tokens.headers.get("cache-control")).toBe("no-store");
        expect(tokens.body.token_type).toBe("Bearer");
        expect(tokens.body.access_token).toMatch(/^pmo_/);
        expect(tokens.body.refresh_token).toMatch(/^pmr_/);
        expect(tokens.body.scope).toBe("deploy.read tasks.read");
        // Only hashes are kept.
        const dump = JSON.stringify(state.db.tables);
        for (const secret of [tokens.body.access_token, tokens.body.refresh_token]) {
            expect(dump).not.toContain(String(secret));
        }
        expect(state.audit.map((entry) => entry.action)).toContain("account.oauth.connected");
    });

    it("grants only what was ticked and what the person holds, with what it implies", async () => {
        state.permissions = new Set(["tasks.read", "tasks.manage"]);
        const { tokens } = await connect(["tasks.manage", "deploy.read", "users.manage"], "tasks.manage deploy.read users.manage");
        expect(tokens.body.scope).toBe("tasks.read tasks.manage");
    });

    it("sends a denial back as access_denied and issues nothing", async () => {
        const client = (await registerClient()).body;
        const answer = await answerAuthorizationAction({
            query: authorizeQuery(client.client_id!, pkce().challenge),
            allow: false,
            scopes: []
        });
        const back = new URL(answer.redirectTo!);
        expect(back.searchParams.get("error")).toBe("access_denied");
        expect(back.searchParams.get("code")).toBeNull();
        expect(state.db.tables.oAuthCode).toHaveLength(0);
    });

    it("re-checks a tampered form instead of trusting it (no redirect to an unregistered address)", async () => {
        const client = (await registerClient()).body;
        const query = authorizeQuery(client.client_id!, pkce().challenge, {
            redirect_uri: "https://attacker.example/steal"
        });
        const answer = await answerAuthorizationAction({ query, allow: true, scopes: ["tasks.read"] });
        expect(answer.redirectTo).toBeUndefined();
        expect(answer.error).toBe("consent.errors.redirect");
        expect(state.db.tables.oAuthCode).toHaveLength(0);
    });

    it("refuses an administrator who is viewing as somebody else", async () => {
        state.user = { ...state.user, viewingAs: { id: "other" } };
        const client = (await registerClient()).body;
        const answer = await answerAuthorizationAction({
            query: authorizeQuery(client.client_id!, pkce().challenge),
            allow: true,
            scopes: ["tasks.read"]
        });
        expect(answer.error).toBe("consent.errors.viewingAs");
    });

    it("will not exchange a code without its verifier, and leaves it for the real app", async () => {
        const client = (await registerClient()).body;
        const { verifier, challenge } = pkce();
        const answer = await answerAuthorizationAction({
            query: authorizeQuery(client.client_id!, challenge),
            allow: true,
            scopes: ["tasks.read"]
        });
        const code = new URL(answer.redirectTo!).searchParams.get("code")!;
        const base = {
            grant_type: "authorization_code",
            code,
            redirect_uri: "http://127.0.0.1:49200/callback",
            client_id: client.client_id!
        };
        expect((await tokenCall({ ...base, code_verifier: pkce().verifier })).body.error).toBe("invalid_grant");
        expect((await tokenCall({ ...base, code_verifier: verifier, redirect_uri: "http://127.0.0.1:1/other" })).body.error).toBe(
            "invalid_grant"
        );
        const other = (await registerClient()).body;
        expect((await tokenCall({ ...base, code_verifier: verifier, client_id: other.client_id! })).body.error).toBe(
            "invalid_grant"
        );
        expect(
            (await tokenCall({ ...base, code_verifier: verifier, resource: "https://other.example/api/mcp" })).body.error
        ).toBe("invalid_target");
        expect((await tokenCall({ ...base, code_verifier: verifier })).status).toBe(200);
    });

    it("ends the grant when a code is exchanged twice", async () => {
        const { client, code, verifier, tokens } = await connect();
        const replay = await tokenCall({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: "http://127.0.0.1:49200/callback",
            client_id: client.client_id!
        });
        expect(replay.body.error).toBe("invalid_grant");
        expect((await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status).toBe(401);
        expect(state.audit.map((entry) => entry.action)).toContain("account.oauth.replay-detected");
    });

    it("refuses an expired code", async () => {
        const client = (await registerClient()).body;
        const { verifier, challenge } = pkce();
        const answer = await answerAuthorizationAction({
            query: authorizeQuery(client.client_id!, challenge),
            allow: true,
            scopes: ["tasks.read"]
        });
        state.db.tables.oAuthCode![0]!.expiresAt = new Date(Date.now() - 1000);
        const result = await tokenCall({
            grant_type: "authorization_code",
            code: new URL(answer.redirectTo!).searchParams.get("code")!,
            code_verifier: verifier,
            redirect_uri: "http://127.0.0.1:49200/callback",
            client_id: client.client_id!
        });
        expect(result.body.error).toBe("invalid_grant");
    });
});

describe("calling /api/mcp with the token", () => {
    it("acts as the person, with the approved scopes", async () => {
        const { tokens } = await connect();
        const answer = await mcpCall(String(tokens.body.access_token), {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        expect(answer.status).toBe(200);
        expect(answer.body?.result.structuredContent.scopes).toEqual(["deploy.read", "tasks.read"]);
    });

    it("refuses a tool whose scope was not approved, before reading its arguments", async () => {
        const { tokens } = await connect(["tasks.read"]);
        const answer = await mcpCall(String(tokens.body.access_token), {
            method: "tools/call",
            params: { name: "deploy_projects", arguments: {} }
        });
        expect(answer.body?.result.isError).toBe(true);
        expect(answer.body?.result.content[0].text).toContain("deploy.read");
    });

    it("never exceeds what the person holds right now", async () => {
        const { tokens } = await connect();
        state.permissions = new Set(["tasks.read"]);
        const answer = await mcpCall(String(tokens.body.access_token), {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        expect(answer.body?.result.structuredContent.scopes).toEqual(["tasks.read"]);
    });

    it("narrows tokens already issued when the person connects the app again with less", async () => {
        const { client, tokens } = await connect();
        const again = await answerAuthorizationAction({
            query: authorizeQuery(client.client_id!, pkce().challenge, { scope: "tasks.read deploy.read" }),
            allow: true,
            scopes: ["tasks.read"]
        });
        expect(again.redirectTo).toContain("code=");
        const whoami = await mcpCall(String(tokens.body.access_token), {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        expect(whoami.body?.result.structuredContent.scopes).toEqual(["tasks.read"]);
        const refreshed = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: client.client_id!
        });
        expect(refreshed.body.scope).toBe("tasks.read");
    });

    it("is refused on another origin of the same instance (audience binding)", async () => {
        const { tokens } = await connect();
        state.origin = "https://other-name.example.test";
        const answer = await mcpCall(String(tokens.body.access_token), { method: "tools/list" });
        expect(answer.status).toBe(401);
        expect(answer.headers.get("www-authenticate")).toContain('error="invalid_token"');
    });

    it("is refused once expired, once its person is banned, and for a refresh token", async () => {
        const first = await connect();
        expect((await mcpCall(String(first.tokens.body.refresh_token), { method: "tools/list" })).status).toBe(401);
        ADA.bannedAt = new Date();
        expect((await mcpCall(String(first.tokens.body.access_token), { method: "tools/list" })).status).toBe(401);
        ADA.bannedAt = null;
        for (const row of state.db.tables.oAuthToken!) row.expiresAt = new Date(Date.now() - 1);
        expect((await mcpCall(String(first.tokens.body.access_token), { method: "tools/list" })).status).toBe(401);
    });

    it("holds back tool calls over the credential's budget", async () => {
        const { tokens } = await connect();
        state.rateLimited = true;
        const answer = await mcpCall(String(tokens.body.access_token), {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        expect(answer.body?.result.isError).toBe(true);
        expect(answer.body?.result.content[0].text).toContain("Too many calls");
    });

    it("gives each agent session its own budget, not one per person", async () => {
        const whoami = { method: "tools/call", params: { name: "polaris_whoami", arguments: {} } };
        state.buckets = [];
        await mcpCall("session-token-one", whoami);
        await mcpCall("session-token-two", whoami);
        expect(state.buckets).toContain("mcp-call:session:one");
        expect(state.buckets).toContain("mcp-call:session:two");
        expect(state.buckets.some((bucket) => bucket.includes("user:"))).toBe(false);
    });

    it("still accepts an API key, as before", async () => {
        const answer = await mcpCall("plk_test.good", { method: "tools/list" });
        expect(answer.status).toBe(200);
        expect(Array.isArray(answer.body?.result.tools)).toBe(true);
    });

    it("advertises read-only and destructive hints on every tool", async () => {
        const answer = await mcpCall("plk_test.good", { method: "tools/list" });
        for (const tool of answer.body?.result.tools as { name: string; annotations: Record<string, boolean> }[]) {
            expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
            expect(typeof tool.annotations.destructiveHint, tool.name).toBe("boolean");
            if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint, tool.name).toBe(false);
        }
    });
});

describe("refresh", () => {
    it("rotates the refresh token and ends the grant when an old one is replayed", async () => {
        const { client, tokens } = await connect();
        const next = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: client.client_id!
        });
        expect(next.status).toBe(200);
        expect(next.body.refresh_token).not.toBe(tokens.body.refresh_token);
        expect((await mcpCall(String(next.body.access_token), { method: "tools/list" })).status).toBe(200);

        const replay = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: client.client_id!
        });
        expect(replay.body.error).toBe("invalid_grant");
        // Everything under the grant is gone - the thief's copy and the app's.
        expect((await mcpCall(String(next.body.access_token), { method: "tools/list" })).status).toBe(401);
        const again = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(next.body.refresh_token),
            client_id: client.client_id!
        });
        expect(again.body.error).toBe("invalid_grant");
        expect(await listConnectedApps(ADA.id)).toHaveLength(0);
    });

    it("may narrow the scopes but never add one", async () => {
        const { client, tokens } = await connect(["tasks.read"]);
        const widened = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: client.client_id!,
            scope: "tasks.read deploy.read"
        });
        expect(widened.body.error).toBe("invalid_scope");
    });

    it("is bound to the client it was issued to", async () => {
        const { tokens } = await connect();
        const other = (await registerClient()).body;
        const stolen = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: other.client_id!
        });
        expect(stolen.body.error).toBe("invalid_grant");
    });

    it("checks a confidential client's secret, and says invalid_client when it is wrong", async () => {
        const client = (await registerClient({ token_endpoint_auth_method: "client_secret_basic" })).body;
        const basic = (secret: string) =>
            `Basic ${Buffer.from(`${encodeURIComponent(client.client_id!)}:${encodeURIComponent(secret)}`).toString("base64")}`;
        const wrong = await tokenCall({ grant_type: "refresh_token", refresh_token: "pmr_x" }, { authorization: basic("pms_wrong") });
        expect(wrong.status).toBe(401);
        expect(wrong.body.error).toBe("invalid_client");
        expect(wrong.headers.get("www-authenticate")).toContain("Basic");
        const right = await tokenCall(
            { grant_type: "refresh_token", refresh_token: "pmr_x" },
            { authorization: basic(client.client_secret!) }
        );
        expect(right.body.error).toBe("invalid_grant");
    });
});

describe("revocation and the connected-apps list", () => {
    it("revokes an access token alone, and a refresh token with its grant", async () => {
        const { client, tokens } = await connect();
        const post = (value: string, clientId = client.client_id!) =>
            revoke.POST(
                new Request(`${ORIGIN}/api/oauth/revoke`, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ token: value, client_id: clientId }).toString()
                })
            );
        // Another app cannot revoke it, and is told nothing either way.
        const other = (await registerClient()).body;
        expect((await post(String(tokens.body.access_token), other.client_id!)).status).toBe(200);
        expect((await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status).toBe(200);

        expect((await post(String(tokens.body.access_token))).status).toBe(200);
        expect((await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status).toBe(401);
        expect(await listConnectedApps(ADA.id)).toHaveLength(1);

        expect((await post(String(tokens.body.refresh_token))).status).toBe(200);
        expect(await listConnectedApps(ADA.id)).toHaveLength(0);
        expect((await post("pmo_unknown")).status).toBe(200);
    });

    it("lists the app for its person only, and only they can disconnect it", async () => {
        const { tokens } = await connect();
        const apps = await listConnectedApps(ADA.id);
        expect(apps).toHaveLength(1);
        expect(apps[0]?.name).toBe("Test Assistant");
        expect(apps[0]?.redirectHost).toBe("127.0.0.1");
        expect(await listConnectedApps(BOB.id)).toHaveLength(0);

        expect(await revokeConnectedApp(BOB.id, apps[0]!.id)).toBe(false);
        expect((await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status).toBe(200);
        expect(await revokeConnectedApp(ADA.id, apps[0]!.id)).toBe(true);
        expect((await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status).toBe(401);
    });

    it("audits a change made through a tool, naming the connection", async () => {
        state.permissions = new Set(["tasks.read", "notes.use"]);
        const written = await connect(["notes.use"], "notes.use");
        const created = await mcpCall(String(written.tokens.body.access_token), {
            method: "tools/call",
            params: { name: "notes_create", arguments: { title: "From an assistant", body: "Hello" } }
        });
        expect(created.body?.result.isError).toBeUndefined();
        expect(state.audit.filter((entry) => entry.action === "mcp.tool.called")).toEqual([
            { action: "mcp.tool.called", actorId: ADA.id }
        ]);
        state.audit = [];
        const { tokens } = await connect(["tasks.read"]);
        await mcpCall(String(tokens.body.access_token), {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        // A read is not written to the activity log.
        expect(state.audit.map((entry) => entry.action)).not.toContain("mcp.tool.called");
    });
});
