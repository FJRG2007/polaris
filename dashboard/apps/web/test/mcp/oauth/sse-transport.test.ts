/**
 * The legacy HTTP+SSE transport at /api/mcp/sse, through the real route
 * handlers against the in-memory database: a stream opens only for a credential
 * /api/mcp itself accepts, replies arrive on the stream, scopes, budgets and the
 * OAuth audience are the streamable endpoint's, and a session answers only to
 * the credential that opened it.
 *
 * Mocked as in flow.test.ts: what needs a request scope or a network.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createFakeDb, type FakeUser } from "./fake-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const sse = await import("@/app/api/mcp/sse/route");
const resourceMetadata = await import(
    "@/app/.well-known/oauth-protected-resource/[[...path]]/route"
);
const { answerAuthorizationAction } = await import("@/app/oauth/authorize/actions");
const { STREAMS_PER_CREDENTIAL, openSessionCount } = await import("@/lib/mcp/sse-sessions");

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
    state.audit = [];
    ADA.bannedAt = null;
});

/** Every stream a test opened, closed after it so none outlives it. */
const opened: AbortController[] = [];
afterEach(() => {
    for (const controller of opened.splice(0)) controller.abort();
});

/** Reads an event stream frame by frame, skipping keep-alive comments. */
function frames(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return async function next(): Promise<{ event: string; data: string }> {
        for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.startsWith(":")) continue;
                const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
                const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "";
                return { event, data };
            }
            const { value, done } = await reader.read();
            if (done) throw new Error("The stream ended");
            buffer += decoder.decode(value, { stream: true });
        }
    };
}

function auth(credential: string | null): Record<string, string> {
    return credential ? { authorization: `Bearer ${credential}` } : {};
}

async function openStream(credential: string | null) {
    const controller = new AbortController();
    opened.push(controller);
    const response = await sse.GET(
        new Request(`${ORIGIN}/api/mcp/sse`, {
            headers: { accept: "text/event-stream", ...auth(credential) },
            signal: controller.signal
        })
    );
    return { response, controller };
}

async function post(endpoint: string, credential: string | null, message: Record<string, unknown>) {
    return sse.POST(
        new Request(new URL(endpoint, ORIGIN), {
            method: "POST",
            headers: { "content-type": "application/json", ...auth(credential) },
            body: JSON.stringify({ jsonrpc: "2.0", ...message })
        })
    );
}

/** A stream opened with the credential, and the address it says to POST to. */
async function session(credential: string) {
    const { response, controller } = await openStream(credential);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const next = frames(response.body!);
    const first = await next();
    return { next, endpoint: first.data, event: first.event, controller };
}

const whoami = { id: 7, method: "tools/call", params: { name: "polaris_whoami", arguments: {} } };

describe("opening the stream", () => {
    it("refuses without a credential, with the challenge that starts OAuth", async () => {
        const { response } = await openStream(null);
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain(
            `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`
        );
        expect(openSessionCount()).toBe(0);
    });

    it("refuses a token minted for another origin of the same instance", async () => {
        const { tokens } = await connect();
        state.origin = "https://other-name.example.test";
        const { response } = await openStream(String(tokens.body.access_token));
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    });

    it("opens with an OAuth token and names the address to post to first", async () => {
        const { tokens } = await connect();
        const { event, endpoint } = await session(String(tokens.body.access_token));
        expect(event).toBe("endpoint");
        expect(endpoint).toMatch(/^\/api\/mcp\/sse\?sessionId=[0-9a-f-]{36}$/);
    });

    it("forgets the session once the client goes away", async () => {
        const credential = String((await connect()).tokens.body.access_token);
        const { endpoint, controller } = await session(credential);
        expect(openSessionCount()).toBe(1);
        controller.abort();
        expect(openSessionCount()).toBe(0);
        expect((await post(endpoint, credential, whoami)).status).toBe(404);
    });

    it("caps the streams one credential holds open", async () => {
        const credential = String((await connect()).tokens.body.access_token);
        for (let i = 0; i < STREAMS_PER_CREDENTIAL; i++) await session(credential);
        const { response } = await openStream(credential);
        expect(response.status).toBe(429);
    });

    it("is described by the endpoint's own resource metadata", async () => {
        const response = await resourceMetadata.GET(new Request(`${ORIGIN}/x`), {
            params: Promise.resolve({ path: ["api", "mcp", "sse"] })
        });
        expect(response.status).toBe(200);
        const metadata = (await response.json()) as { resource: string };
        expect(metadata.resource).toBe(`${ORIGIN}/api/mcp`);
    });
});

describe("posting to the session", () => {
    it("answers on the stream, as the person, with the approved scopes", async () => {
        const credential = String((await connect()).tokens.body.access_token);
        const { next, endpoint } = await session(credential);
        expect((await post(endpoint, credential, whoami)).status).toBe(202);
        const reply = await next();
        expect(reply.event).toBe("message");
        const message = JSON.parse(reply.data) as { id: number; result: any };
        expect(message.id).toBe(7);
        expect(message.result.structuredContent.scopes).toEqual(["deploy.read", "tasks.read"]);
    });

    it("refuses a tool whose scope was not approved", async () => {
        const credential = String((await connect(["tasks.read"])).tokens.body.access_token);
        const { next, endpoint } = await session(credential);
        await post(endpoint, credential, {
            id: 8,
            method: "tools/call",
            params: { name: "deploy_projects", arguments: {} }
        });
        const message = JSON.parse((await next()).data) as { result: any };
        expect(message.result.isError).toBe(true);
        expect(message.result.content[0].text).toContain("deploy.read");
    });

    it("refuses without a credential, and once the token has expired", async () => {
        const credential = String((await connect()).tokens.body.access_token);
        const { endpoint } = await session(credential);
        const anonymous = await post(endpoint, null, whoami);
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get("www-authenticate")).toContain("resource_metadata=");
        for (const row of state.db.tables.oAuthToken!) row.expiresAt = new Date(Date.now() - 1);
        expect((await post(endpoint, credential, whoami)).status).toBe(401);
    });

    it("answers only the credential that opened the stream", async () => {
        const credential = String((await connect()).tokens.body.access_token);
        const { endpoint } = await session(credential);
        // A valid credential of the same person is still somebody else's session.
        expect((await post(endpoint, "plk_test.good", whoami)).status).toBe(404);
        const malformed = "/api/mcp/sse?sessionId=not-a-session";
        expect((await post(malformed, credential, whoami)).status).toBe(404);
        const unknown = `/api/mcp/sse?sessionId=${randomUUID()}`;
        expect((await post(unknown, credential, whoami)).status).toBe(404);
    });

    it("keeps the session across a token refresh of the same grant", async () => {
        const { client, tokens } = await connect();
        const { next, endpoint } = await session(String(tokens.body.access_token));
        const refreshed = await tokenCall({
            grant_type: "refresh_token",
            refresh_token: String(tokens.body.refresh_token),
            client_id: client.client_id!
        });
        const credential = String(refreshed.body.access_token);
        expect((await post(endpoint, credential, whoami)).status).toBe(202);
        expect(JSON.parse((await next()).data).id).toBe(7);
    });

    it("works with an API key, under the key's own scopes", async () => {
        const { next, endpoint } = await session("plk_test.good");
        expect((await post(endpoint, "plk_test.good", whoami)).status).toBe(202);
        const message = JSON.parse((await next()).data) as { result: any };
        expect(message.result.structuredContent.scopes).toEqual(["tasks.read"]);
    });

    it("accepts a notification and puts nothing on the stream", async () => {
        const credential = String((await connect()).tokens.body.access_token);
        const { next, endpoint } = await session(credential);
        const note = { method: "notifications/initialized" };
        expect((await post(endpoint, credential, note)).status).toBe(202);
        expect((await post(endpoint, credential, whoami)).status).toBe(202);
        // The first thing on the stream is the reply to the call, not the note.
        expect(JSON.parse((await next()).data).id).toBe(7);
    });

    it("holds back calls over the credential's budget, as /api/mcp does", async () => {
        const credential = String((await connect()).tokens.body.access_token);
        const { next, endpoint } = await session(credential);
        state.rateLimited = true;
        expect((await post(endpoint, credential, whoami)).status).toBe(202);
        const message = JSON.parse((await next()).data) as { result: any };
        expect(message.result.isError).toBe(true);
        expect(message.result.content[0].text).toContain("Too many calls");
    });
});
