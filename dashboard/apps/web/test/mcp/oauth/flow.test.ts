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
    ip: "203.0.113.5" as string | undefined,
    buckets: [] as string[],
    audit: [] as { action: string; actorId: string | null }[],
    /** What a metadata-document address serves, by address. */
    documents: new Map<string, unknown>(),
    fetches: [] as string[],
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
const BOB: FakeUser = {
    ...ADA,
    id: "0190a5b8-0000-7000-8000-000000000b0b",
    name: "Bob",
    username: "bob"
};

vi.mock("@polaris/db", () => ({
    get prisma() {
        return state.db.prisma;
    }
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
    configuredRequest: async (
        address: string,
        _init: unknown,
        options: { allowPrivate: boolean }
    ) => {
        expect(options.allowPrivate).toBe(false);
        state.fetches.push(address);
        const document = state.documents.get(address);
        return document === undefined
            ? new Response("not found", { status: 404 })
            : new Response(JSON.stringify(document), {
                  headers: { "content-type": "application/json; charset=utf-8" }
              });
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
vi.mock("@/lib/request-context", () => ({ clientIp: async () => state.ip }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (bucket: string) => {
        state.buckets.push(bucket);
        return state.rateLimited
            ? { ok: false, retryAfterMs: 30_000 }
            : { ok: true, retryAfterMs: 0 };
    }
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: { action: string; actorId: string | null }) => {
        state.audit.push({ action: event.action, actorId: event.actorId });
    }
}));
vi.mock("@/lib/network-rules", () => ({ evaluateAccountAccess: async () => ({ allowed: true }) }));
vi.mock("@/lib/agents/session-service", () => ({
    sessionForToken: async (token: string) =>
        token.startsWith("session-token-") ? { id: token.slice(14) } : null,
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
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/account/security/action-messages", () => ({
    localized: async (result: unknown) => result
}));
vi.mock("@/lib/notes/access", () => ({
    NoteAccessError: class extends Error {},
    requirePlacement: async () => undefined
}));
vi.mock("@/lib/notes/note-service", () => ({
    createNote: async () => "33333333-3333-4333-8333-333333333333"
}));
vi.mock("@/lib/notes/shelf-service", () => ({}));

const { createFakeDb: makeDb } = await import("./fake-db");
const register = await import("@/app/api/oauth/register/route");
const token = await import("@/app/api/oauth/token/route");
const revoke = await import("@/app/api/oauth/revoke/route");
const mcp = await import("@/app/api/mcp/route");
const resourceMetadata = await import(
    "@/app/.well-known/oauth-protected-resource/[[...path]]/route"
);
const serverMetadata = await import(
    "@/app/.well-known/oauth-authorization-server/[[...path]]/route"
);
const { answerAuthorizationAction } = await import("@/app/oauth/authorize/actions");
const { listConnectedApps, revokeConnectedApp } = await import("@/lib/mcp/oauth/grants");
const { changeAppScopesAction, setAppIpPolicyAction } = await import(
    "@/app/(app)/account/assistants/connected-app-actions"
);

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
    return {
        status: response.status,
        headers: response.headers,
        body: text ? (JSON.parse(text) as Record<string, any>) : null
    };
}

/** The whole happy path: register, consent, exchange. */
async function connect(
    scopes: string[] = ["tasks.read", "deploy.read"],
    requested = "tasks.read deploy.read"
) {
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
    state.ip = "203.0.113.5";
    state.audit = [];
    state.documents = new Map();
    state.fetches = [];
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
            const body = (await response.json()) as {
                resource: string;
                authorization_servers: string[];
            };
            expect(body.resource).toBe(`${ORIGIN}/api/mcp`);
            expect(body.authorization_servers).toEqual([ORIGIN]);
        }
        const other = await resourceMetadata.GET(new Request(`${ORIGIN}/x`), {
            params: Promise.resolve({ path: ["api", "v1"] })
        });
        expect(other.status).toBe(404);
    });

    it("serves authorization server metadata whose issuer is the origin", async () => {
        const response = await serverMetadata.GET(new Request(`${ORIGIN}/x`), {
            params: Promise.resolve({})
        });
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.issuer).toBe(ORIGIN);
        expect(body.token_endpoint).toBe(`${ORIGIN}/api/oauth/token`);
        expect((body.scopes_supported as string[]).length).toBeGreaterThan(0);
    });
});

/**
 * ChatGPT, as OpenAI documents it (developers.openai.com/plugins/build/auth):
 * it reads the resource metadata, then the authorization server's, and - since
 * Polaris advertises client_id_metadata_document_supported and RFC 9207's iss -
 * skips registration and names itself by its stable metadata document, sending
 * people back to its stable redirect address. The document below is the one
 * https://chatgpt.com/oauth/client.json serves.
 */
describe("ChatGPT", () => {
    const CHATGPT = "https://chatgpt.com/oauth/client.json";
    const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
    const document = {
        client_id: CHATGPT,
        client_uri: "https://chatgpt.com/",
        redirect_uris: [CHATGPT_REDIRECT],
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "ChatGPT",
        logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
        token_endpoint_auth_signing_alg: "RS256",
        jwks_uri: "https://chatgpt.com/oauth/jwks.json"
    };

    it("connects through its metadata document, end to end", async () => {
        state.documents.set(CHATGPT, document);

        // Discovery, from the 401's challenge.
        const challenge = await mcpCall(null, { method: "tools/list" });
        const pointer = /resource_metadata="([^"]+)"/.exec(
            challenge.headers.get("www-authenticate") ?? ""
        )![1]!;
        const resourcePath = new URL(pointer).pathname.split("/").slice(3);
        const resourceDoc = (await (
            await resourceMetadata.GET(new Request(pointer), {
                params: Promise.resolve({ path: resourcePath })
            })
        ).json()) as { resource: string; authorization_servers: string[] };
        const serverDoc = (await (
            await serverMetadata.GET(
                new Request(
                    `${resourceDoc.authorization_servers[0]}/.well-known/oauth-authorization-server`
                ),
                { params: Promise.resolve({}) }
            )
        ).json()) as Record<string, unknown>;
        expect(serverDoc.client_id_metadata_document_supported).toBe(true);
        expect(serverDoc.authorization_response_iss_parameter_supported).toBe(true);
        expect(serverDoc.code_challenge_methods_supported).toContain("S256");
        expect(serverDoc.token_endpoint_auth_methods_supported).toContain("none");

        // Authorization, with the resource echoed and PKCE.
        const { verifier, challenge: codeChallenge } = pkce();
        const query = new URLSearchParams({
            response_type: "code",
            client_id: CHATGPT,
            redirect_uri: CHATGPT_REDIRECT,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            state: "chatgpt-state",
            resource: resourceDoc.resource,
            scope: "tasks.read"
        }).toString();
        const answer = await answerAuthorizationAction({
            query,
            allow: true,
            scopes: ["tasks.read"]
        });
        expect(answer.error).toBeUndefined();
        const back = new URL(answer.redirectTo!);
        expect(`${back.origin}${back.pathname}`).toBe(CHATGPT_REDIRECT);
        expect(back.searchParams.get("iss")).toBe(serverDoc.issuer);
        expect(back.searchParams.get("state")).toBe("chatgpt-state");

        // The exchange, as a public client: no secret, no assertion.
        const tokens = await tokenCall({
            grant_type: "authorization_code",
            code: back.searchParams.get("code")!,
            code_verifier: verifier,
            redirect_uri: CHATGPT_REDIRECT,
            client_id: CHATGPT,
            resource: resourceDoc.resource
        });
        expect(tokens.status).toBe(200);
        const call = await mcpCall(String(tokens.body.access_token), {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        expect(call.status).toBe(200);

        // Known by its document, read once; nothing was registered.
        expect(state.fetches).toEqual([CHATGPT]);
        expect(state.db.tables.oAuthClient).toHaveLength(1);
        expect(state.db.tables.oAuthClient![0]).toMatchObject({
            clientId: CHATGPT,
            source: "metadata",
            tokenAuthMethod: "none"
        });
    });

    it("says the app's details could not be read when its document is unreachable, and logs why", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { challenge } = pkce();
        const query = new URLSearchParams({
            response_type: "code",
            client_id: CHATGPT,
            redirect_uri: CHATGPT_REDIRECT,
            code_challenge: challenge,
            code_challenge_method: "S256"
        }).toString();
        const answer = await answerAuthorizationAction({
            query,
            allow: true,
            scopes: ["tasks.read"]
        });
        expect(answer).toEqual({ error: "consent.errors.clientDetails" });
        const lines = warn.mock.calls.map((call) => String(call[0]));
        warn.mockRestore();
        expect(lines).toContain(
            `polaris: oauth metadata document refused ${JSON.stringify({
                client_id: CHATGPT,
                reason: "the address answered 404, not 200"
            })}`
        );
        expect(lines.some((line) => line.startsWith("polaris: oauth authorization refused"))).toBe(
            true
        );
        expect(lines.join("\n")).not.toContain(challenge);
    });
});

/**
 * The clients that connected before ChatGPT's fix, end to end, so changing how
 * a metadata document is read can never lock them out: Claude Code through its
 * metadata document (as https://claude.ai/oauth/claude-code-client-metadata
 * serves it, with only the legacy single method), and an app registered through
 * RFC 7591 dynamic registration.
 */
describe("clients that already connect", () => {
    async function authorizeAndExchange(clientId: string, redirectUri: string) {
        const { verifier, challenge } = pkce();
        const query = authorizeQuery(clientId, challenge, { redirect_uri: redirectUri });
        const answer = await answerAuthorizationAction({
            query,
            allow: true,
            scopes: ["tasks.read"]
        });
        expect(answer.error).toBeUndefined();
        const back = new URL(answer.redirectTo!);
        expect(back.searchParams.get("iss")).toBe(ORIGIN);
        const tokens = await tokenCall({
            grant_type: "authorization_code",
            code: back.searchParams.get("code")!,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            client_id: clientId,
            resource: `${ORIGIN}/api/mcp`
        });
        expect(tokens.status).toBe(200);
        const call = await mcpCall(String(tokens.body.access_token), {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        expect(call.status).toBe(200);
        return back;
    }

    it("Claude Code, through its metadata document and a loopback port of its own", async () => {
        const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
        state.documents.set(CLAUDE_CODE, {
            client_id: CLAUDE_CODE,
            client_name: "Claude Code",
            client_uri: "https://claude.ai",
            redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none"
        });
        const back = await authorizeAndExchange(CLAUDE_CODE, "http://localhost:51234/callback");
        expect(back.origin).toBe("http://localhost:51234");
        expect(state.db.tables.oAuthClient![0]).toMatchObject({
            clientId: CLAUDE_CODE,
            source: "metadata",
            tokenAuthMethod: "none"
        });
    });

    it("an app registered through RFC 7591", async () => {
        const { status, body } = await registerClient();
        expect(status).toBe(201);
        const back = await authorizeAndExchange(body.client_id!, "http://127.0.0.1:49200/callback");
        expect(back.origin).toBe("http://127.0.0.1:49200");
        expect(state.fetches).toEqual([]);
    });

    it("still refuses a return address either one never registered", async () => {
        const { body } = await registerClient();
        const { challenge } = pkce();
        const answer = await answerAuthorizationAction({
            query: authorizeQuery(body.client_id!, challenge, {
                redirect_uri: "https://attacker.example/cb"
            }),
            allow: true,
            scopes: ["tasks.read"]
        });
        expect(answer).toEqual({ error: "consent.errors.redirect" });
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

    it("logs a throttled address once per window, not once per request", async () => {
        state.rateLimited = true;
        state.ip = "198.51.100.77";
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            for (let i = 0; i < 5; i++) expect((await registerClient()).status).toBe(429);
            const lines = warn.mock.calls.map(([line]) => String(line));
            expect(lines.filter((line) => line.includes("rate limited"))).toHaveLength(1);
        } finally {
            warn.mockRestore();
        }
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
        const { tokens } = await connect(
            ["tasks.manage", "deploy.read", "users.manage"],
            "tasks.manage deploy.read users.manage"
        );
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
        const answer = await answerAuthorizationAction({
            query,
            allow: true,
            scopes: ["tasks.read"]
        });
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
        expect((await tokenCall({ ...base, code_verifier: pkce().verifier })).body.error).toBe(
            "invalid_grant"
        );
        expect(
            (
                await tokenCall({
                    ...base,
                    code_verifier: verifier,
                    redirect_uri: "http://127.0.0.1:1/other"
                })
            ).body.error
        ).toBe("invalid_grant");
        const other = (await registerClient()).body;
        expect(
            (await tokenCall({ ...base, code_verifier: verifier, client_id: other.client_id! }))
                .body.error
        ).toBe("invalid_grant");
        expect(
            (
                await tokenCall({
                    ...base,
                    code_verifier: verifier,
                    resource: "https://other.example/api/mcp"
                })
            ).body.error
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
        expect(
            (await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status
        ).toBe(401);
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
    it("introduces itself with its title and its icons on the origin the client used", async () => {
        const { tokens } = await connect();
        const answer = await mcpCall(String(tokens.body.access_token), {
            method: "initialize",
            params: { protocolVersion: "2025-11-25" }
        });
        const info = answer.body?.result.serverInfo;
        expect(info.title).toBe("Polaris");
        expect(info.icons.map((icon: { src: string }) => icon.src)).toEqual([
            `${ORIGIN}/icon.svg`,
            `${ORIGIN}/polaris-mark-192.png`,
            `${ORIGIN}/polaris-mark-512.png`
        ]);
    });

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
            query: authorizeQuery(client.client_id!, pkce().challenge, {
                scope: "tasks.read deploy.read"
            }),
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
        expect(
            (await mcpCall(String(first.tokens.body.refresh_token), { method: "tools/list" }))
                .status
        ).toBe(401);
        ADA.bannedAt = new Date();
        expect(
            (await mcpCall(String(first.tokens.body.access_token), { method: "tools/list" })).status
        ).toBe(401);
        ADA.bannedAt = null;
        for (const row of state.db.tables.oAuthToken!) row.expiresAt = new Date(Date.now() - 1);
        expect(
            (await mcpCall(String(first.tokens.body.access_token), { method: "tools/list" })).status
        ).toBe(401);
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
        for (const tool of answer.body?.result.tools as {
            name: string;
            annotations: Record<string, boolean>;
        }[]) {
            expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
            expect(typeof tool.annotations.destructiveHint, tool.name).toBe("boolean");
            if (tool.annotations.readOnlyHint)
                expect(tool.annotations.destructiveHint, tool.name).toBe(false);
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
        expect(
            (await mcpCall(String(next.body.access_token), { method: "tools/list" })).status
        ).toBe(200);

        const replay = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: client.client_id!
        });
        expect(replay.body.error).toBe("invalid_grant");
        // Everything under the grant is gone - the thief's copy and the app's.
        expect(
            (await mcpCall(String(next.body.access_token), { method: "tools/list" })).status
        ).toBe(401);
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
        const client = (await registerClient({ token_endpoint_auth_method: "client_secret_basic" }))
            .body;
        const basic = (secret: string) =>
            `Basic ${Buffer.from(`${encodeURIComponent(client.client_id!)}:${encodeURIComponent(secret)}`).toString("base64")}`;
        const wrong = await tokenCall(
            { grant_type: "refresh_token", refresh_token: "pmr_x" },
            { authorization: basic("pms_wrong") }
        );
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
        expect(
            (await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status
        ).toBe(200);

        expect((await post(String(tokens.body.access_token))).status).toBe(200);
        expect(
            (await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status
        ).toBe(401);
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
        expect(
            (await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status
        ).toBe(200);
        expect(await revokeConnectedApp(ADA.id, apps[0]!.id)).toBe(true);
        expect(
            (await mcpCall(String(tokens.body.access_token), { method: "tools/list" })).status
        ).toBe(401);
    });

    it("audits a change made through a tool, naming the connection", async () => {
        state.permissions = new Set(["tasks.read", "notes.use"]);
        const written = await connect(["notes.use"], "notes.use");
        const created = await mcpCall(String(written.tokens.body.access_token), {
            method: "tools/call",
            params: {
                name: "notes_create",
                arguments: { title: "From an assistant", body: "Hello" }
            }
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

describe("changing what a connected app may do", () => {
    async function whoami(accessToken: string) {
        const answer = await mcpCall(accessToken, {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        return answer.body?.result.structuredContent.scopes as string[] | undefined;
    }

    it("takes a scope away on the app's very next call, and refresh cannot bring it back", async () => {
        const { client, tokens } = await connect();
        const access = String(tokens.body.access_token);
        const [app] = await listConnectedApps(ADA.id);

        const result = await changeAppScopesAction({ id: app!.id, scopes: ["tasks.read"] });
        expect(result).toEqual({ scopes: ["tasks.read"] });

        const refused = await mcpCall(access, {
            method: "tools/call",
            params: { name: "deploy_projects", arguments: {} }
        });
        expect(refused.body?.result.isError).toBe(true);
        expect(refused.body?.result.content[0].text).toContain("deploy.read");
        expect(await whoami(access)).toEqual(["tasks.read"]);

        const next = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: client.client_id!
        });
        expect(next.body.scope).toBe("tasks.read");
        const widened = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(next.body.refresh_token),
            client_id: client.client_id!,
            scope: "tasks.read deploy.read"
        });
        expect(widened.body.error).toBe("invalid_scope");
        expect(state.audit.map((entry) => entry.action)).toContain("account.oauth.updated");
    });

    it("gives back a scope the app asked for, on the token it already holds", async () => {
        const { tokens } = await connect(["tasks.read"], "tasks.read deploy.read");
        const access = String(tokens.body.access_token);
        expect(await whoami(access)).toEqual(["tasks.read"]);
        const [app] = await listConnectedApps(ADA.id);
        expect([...app!.requestable].sort()).toEqual(["deploy.read", "tasks.read"]);

        const result = await changeAppScopesAction({
            id: app!.id,
            scopes: ["tasks.read", "deploy.read"]
        });
        expect(result.scopes?.sort()).toEqual(["deploy.read", "tasks.read"]);
        expect((await whoami(access))?.sort()).toEqual(["deploy.read", "tasks.read"]);
    });

    it("adds what the app did not ask for only when it is offered and the person holds it", async () => {
        state.permissions = new Set(["tasks.read", "tasks.manage", "deploy.read"]);
        const { tokens } = await connect(["tasks.read"], "tasks.read");
        const [app] = await listConnectedApps(ADA.id);

        // Not asked for, but offered and held: the person's to give. Not offered
        // over MCP at all: dropped.
        const result = await changeAppScopesAction({
            id: app!.id,
            scopes: ["tasks.read", "deploy.read", "users.manage"]
        });
        expect(result.scopes).toEqual(["deploy.read", "tasks.read"]);
        expect((await whoami(String(tokens.body.access_token)))?.sort()).toEqual([
            "deploy.read",
            "tasks.read"
        ]);
        // What it asked for is still what it asked for.
        expect((await listConnectedApps(ADA.id))[0]!.requestable).toEqual(["tasks.read"]);

        // Asked for but not held: refused.
        state.permissions = new Set(["tasks.read"]);
        const second = await connect(["tasks.read"], "tasks.read tasks.manage");
        const apps = await listConnectedApps(ADA.id);
        const latest = apps.find((entry) => entry.requestable.includes("tasks.manage"))!;
        const narrowed = await changeAppScopesAction({
            id: latest.id,
            scopes: ["tasks.manage"]
        });
        expect(narrowed.scopes).toEqual(["tasks.read"]);
        expect(await whoami(String(second.tokens.body.access_token))).toEqual(["tasks.read"]);
    });

    it("refuses an empty set, somebody else's app, and a disconnected one", async () => {
        await connect();
        const [app] = await listConnectedApps(ADA.id);
        expect((await changeAppScopesAction({ id: app!.id, scopes: [] })).error).toBe(
            "connectedApps.pickOne"
        );

        state.user = { ...state.user, id: BOB.id };
        expect((await changeAppScopesAction({ id: app!.id, scopes: ["tasks.read"] })).error).toBe(
            "connectedApps.changeFailed"
        );

        state.user = { ...state.user, id: ADA.id };
        await revokeConnectedApp(ADA.id, app!.id);
        expect((await changeAppScopesAction({ id: app!.id, scopes: ["tasks.read"] })).error).toBe(
            "connectedApps.changeFailed"
        );
        expect(
            (await changeAppScopesAction({ id: "not-a-uuid", scopes: ["tasks.read"] })).error
        ).toBe("connectedApps.changeFailed");
    });

    it("reads a grant from before requests were kept as asking for what it holds", async () => {
        const { tokens } = await connect(["tasks.read"], "tasks.read deploy.read");
        const grant = state.db.tables.oAuthGrant![0]!;
        grant.requestedScopes = null;
        const [app] = await listConnectedApps(ADA.id);
        expect(app!.requestable).toEqual(["tasks.read"]);
        // Anything more is marked as not asked for on the page, and still the
        // person's to give.
        const result = await changeAppScopesAction({
            id: app!.id,
            scopes: ["tasks.read", "deploy.read"]
        });
        expect(result.scopes).toEqual(["deploy.read", "tasks.read"]);
        expect((await whoami(String(tokens.body.access_token)))?.sort()).toEqual([
            "deploy.read",
            "tasks.read"
        ]);
    });
});

describe("where a connected app may call from", () => {
    const whoami = { method: "tools/call", params: { name: "polaris_whoami", arguments: {} } };

    async function connected() {
        const result = await connect();
        const [app] = await listConnectedApps(ADA.id);
        return { ...result, app: app!, access: String(result.tokens.body.access_token) };
    }

    function refresh(clientId: string, refreshToken: string) {
        return tokenCall({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: clientId
        });
    }

    it("lets everything through by default, as before", async () => {
        const { app, access } = await connected();
        expect(app.ipPolicy.mode).toBe("none");
        expect(app.approvedIp).toBe("203.0.113.5");
        state.ip = "198.51.100.20";
        expect((await mcpCall(access, whoami)).status).toBe(200);
    });

    it("locks to the address it was approved from, on calls and on refresh", async () => {
        const { app, access, client, tokens } = await connected();
        expect(
            await setAppIpPolicyAction({ id: app.id, policy: { mode: "origin" } })
        ).toMatchObject({ policy: { mode: "origin" } });
        expect((await mcpCall(access, whoami)).status).toBe(200);

        state.ip = "198.51.100.20";
        const refused = await mcpCall(access, whoami);
        expect(refused.status).toBe(403);
        expect(refused.body?.error_description).toContain("not allowed from this IP address");
        const renewed = await refresh(client.client_id!, String(tokens.body.refresh_token));
        expect(renewed.body.error).toBe("invalid_grant");
        expect(String(renewed.body.error_description)).toContain("IP address");

        // The refusal is on the connection and in the activity, once.
        const [after] = await listConnectedApps(ADA.id);
        expect(after!.lastRefusedIp).toBe("198.51.100.20");
        expect(
            state.audit.filter((entry) => entry.action === "account.oauth.ip-refused")
        ).toHaveLength(1);

        // The refresh token was not spent by the refusal.
        state.ip = "203.0.113.5";
        const back = await refresh(client.client_id!, String(tokens.body.refresh_token));
        expect(back.status).toBe(200);
    });

    it("applies an allow list and a deny list, IPv4 and IPv6", async () => {
        const { app, access } = await connected();
        await setAppIpPolicyAction({
            id: app.id,
            policy: {
                mode: "list",
                allow: ["198.51.100.0/24", "2001:db8::/32"],
                deny: ["198.51.100.66"]
            }
        });
        for (const [ip, status] of [
            ["198.51.100.20", 200],
            ["198.51.100.66", 403],
            ["2001:db8:1::5", 200],
            ["2001:db9::5", 403],
            ["203.0.113.5", 403],
            [undefined, 403]
        ] as const) {
            state.ip = ip;
            expect((await mcpCall(access, whoami)).status, String(ip)).toBe(status);
        }
    });

    it("follows the person's live sessions", async () => {
        const { app, access } = await connected();
        await setAppIpPolicyAction({ id: app.id, policy: { mode: "sessions" } });
        const later = new Date(Date.now() + 60_000);
        const sessions = state.db.tables.session!;

        state.ip = "198.51.100.20";
        expect((await mcpCall(access, whoami)).status).toBe(403);

        sessions.push({
            userId: ADA.id,
            expiresAt: later,
            ipAddress: "198.51.100.20",
            state: null
        });
        expect((await mcpCall(access, whoami)).status).toBe(200);

        // Another person's session, an expired one, or one awaiting approval
        // does not count.
        state.ip = "192.0.2.9";
        sessions.push({ userId: BOB.id, expiresAt: later, ipAddress: "192.0.2.9", state: null });
        sessions.push({
            userId: ADA.id,
            expiresAt: new Date(Date.now() - 60_000),
            ipAddress: "192.0.2.9",
            state: null
        });
        sessions.push({
            userId: ADA.id,
            expiresAt: later,
            ipAddress: null,
            state: { ip: "192.0.2.9", approval: "pending" }
        });
        expect((await mcpCall(access, whoami)).status).toBe(403);

        // A session that moved counts at its new address; IPv6 by its /64.
        sessions.push({
            userId: ADA.id,
            expiresAt: later,
            ipAddress: "198.51.100.30",
            state: { ip: "2001:db8:aa:bb::1", approval: "approved" }
        });
        state.ip = "2001:db8:aa:bb:ffff::2";
        expect((await mcpCall(access, whoami)).status).toBe(200);
        state.ip = "2001:db8:aa:bc::1";
        expect((await mcpCall(access, whoami)).status).toBe(403);

        // Signing out everywhere stops it.
        sessions.length = 0;
        state.ip = "198.51.100.20";
        expect((await mcpCall(access, whoami)).status).toBe(403);
    });

    it("validates the rule, and only the owner may set it", async () => {
        const { app, access } = await connected();
        expect(
            (await setAppIpPolicyAction({ id: app.id, policy: { mode: "list", allow: ["nope"] } }))
                .error
        ).toBe("connectedApps.ip.failed");
        expect((await setAppIpPolicyAction({ id: app.id, policy: { mode: "list" } })).error).toBe(
            "connectedApps.ip.failed"
        );
        state.user = { ...state.user, id: BOB.id };
        expect(
            (await setAppIpPolicyAction({ id: app.id, policy: { mode: "sessions" } })).error
        ).toBe("connectedApps.ip.failed");
        state.user = { ...state.user, id: ADA.id };
        state.ip = "198.51.100.20";
        expect((await mcpCall(access, whoami)).status).toBe(200);

        // Back to anywhere.
        await setAppIpPolicyAction({ id: app.id, policy: { mode: "origin" } });
        expect((await mcpCall(access, whoami)).status).toBe(403);
        await setAppIpPolicyAction({ id: app.id, policy: { mode: "none" } });
        expect((await mcpCall(access, whoami)).status).toBe(200);
        expect(state.audit.map((entry) => entry.action)).toContain("account.oauth.ip-rule-changed");
    });

    it("cannot lock to an origin a connection never recorded", async () => {
        const { app } = await connected();
        state.db.tables.oAuthGrant![0]!.approvedIp = null;
        expect((await setAppIpPolicyAction({ id: app.id, policy: { mode: "origin" } })).error).toBe(
            "connectedApps.ip.noOrigin"
        );
    });
});

describe("the finer scopes, and the grants made before them", () => {
    async function scopesOf(accessToken: string) {
        const answer = await mcpCall(accessToken, {
            method: "tools/call",
            params: { name: "polaris_whoami", arguments: {} }
        });
        return answer.body?.result.structuredContent.scopes as string[] | undefined;
    }

    it("offers mail's scopes, and no scope of an app that is not installed", async () => {
        const response = await serverMetadata.GET(new Request(`${ORIGIN}/x`), {
            params: Promise.resolve({})
        });
        const offered = ((await response.json()) as { scopes_supported: string[] })
            .scopes_supported;
        expect(offered).toEqual(expect.arrayContaining(["mail.read", "mail.send"]));
        for (const absent of ["calendar.use", "calendar.read", "places.read", "gameservers.read"])
            expect(offered).not.toContain(absent);
        const challenge = (await mcpCall(null, { method: "tools/list" })).headers.get(
            "www-authenticate"
        );
        expect(challenge).toContain("mail.send");
        expect(challenge).not.toContain("places.");
    });

    it("holds a finer scope only while the person holds the permission it stands on", async () => {
        state.permissions = new Set(["tasks.read", "mail.use"]);
        const { tokens } = await connect(["tasks.read", "mail.read"], "tasks.read mail.read");
        const access = String(tokens.body.access_token);
        expect(tokens.body.scope).toBe("mail.read tasks.read");
        expect(await scopesOf(access)).toEqual(["mail.read", "tasks.read"]);

        state.permissions = new Set(["tasks.read"]);
        expect(await scopesOf(access)).toEqual(["tasks.read"]);
        const refused = await mcpCall(access, {
            method: "tools/call",
            params: { name: "mail_list", arguments: {} }
        });
        expect(refused.body?.result.isError).toBe(true);
        expect(refused.body?.result.content[0].text).toContain("mail.read");
    });

    it("never grants a finer scope the person cannot hold, at consent", async () => {
        state.permissions = new Set(["tasks.read"]);
        const { tokens } = await connect(["tasks.read", "mail.send"], "tasks.read mail.send");
        expect(tokens.body.scope).toBe("tasks.read");
    });

    it("lets a new scope be added to a grant made before it existed", async () => {
        state.permissions = new Set(["tasks.read", "mail.use"]);
        const { tokens } = await connect(["tasks.read"], "tasks.read");
        const [app] = await listConnectedApps(ADA.id);
        const result = await changeAppScopesAction({
            id: app!.id,
            scopes: ["tasks.read", "mail.read"]
        });
        expect(result.scopes).toEqual(["mail.read", "tasks.read"]);
        expect(await scopesOf(String(tokens.body.access_token))).toEqual([
            "mail.read",
            "tasks.read"
        ]);
    });

    it("keeps an old grant's stored scopes exactly, honouring the ones it knows", async () => {
        state.permissions = new Set(["tasks.read", "calendar.use"]);
        const { tokens } = await connect(["tasks.read"], "tasks.read");
        // As a grant from before the split was stored: the old calendar scope,
        // and one this Polaris has never heard of.
        const stored = JSON.stringify(["tasks.read", "calendar.use", "bogus.scope"]);
        state.db.tables.oAuthGrant![0]!.scopes = stored;
        for (const row of state.db.tables.oAuthToken!) row.scopes = stored;

        const [app] = await listConnectedApps(ADA.id);
        expect(app!.scopes).toEqual(["calendar.use", "tasks.read"]);
        expect(await scopesOf(String(tokens.body.access_token))).toEqual([
            "calendar.use",
            "tasks.read"
        ]);
        // Reading it changed nothing.
        expect(state.db.tables.oAuthGrant![0]!.scopes).toBe(stored);
    });

    it("leaves alone, when permissions change, a scope the dialog did not show", async () => {
        state.permissions = new Set(["tasks.read", "deploy.read", "home.read"]);
        await connect(["tasks.read"], "tasks.read");
        // Places' scope, held from when it was installed; it is not now.
        state.db.tables.oAuthGrant![0]!.scopes = JSON.stringify(["tasks.read", "places.read"]);
        const [app] = await listConnectedApps(ADA.id);
        const result = await changeAppScopesAction({
            id: app!.id,
            scopes: ["tasks.read", "deploy.read"]
        });
        expect(result.scopes).toEqual(["deploy.read", "places.read", "tasks.read"]);
    });

    it("drops the old calendar scope when the person unticks it", async () => {
        state.permissions = new Set(["tasks.read", "calendar.use"]);
        await connect(["tasks.read"], "tasks.read");
        state.db.tables.oAuthGrant![0]!.scopes = JSON.stringify(["tasks.read", "calendar.use"]);
        const [app] = await listConnectedApps(ADA.id);
        const result = await changeAppScopesAction({ id: app!.id, scopes: ["tasks.read"] });
        expect(result.scopes).toEqual(["tasks.read"]);
    });
});
