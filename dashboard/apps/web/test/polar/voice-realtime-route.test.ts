/**
 * The realtime voice routes: opening a call mints a secret only on the
 * person's own OpenAI key and answers it without the key; a tool call runs
 * only on a session the person may read, with the body validated. Both
 * refuse a view-as session and an over-limit caller.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = "sk-fixture-own-key";

const state = {
    user: { id: OWNER, viewingAs: null as string | null } as { id: string; viewingAs: string | null } | null,
    limited: false,
    session: true,
    source: "own" as "own" | "instance" | null,
    minted: true,
    mints: [] as Array<Record<string, unknown>>,
    runs: [] as Array<Record<string, unknown>>
};

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.user
            ? { ...state.user, isAdmin: false, name: "Ada" }
            : NextResponse.json({ error: "unauthorized" }, { status: 401 })
}));
vi.mock("@/lib/polar/access", () => ({
    polarCaller: async () => (await import("@/lib/api-session")).apiUser(),
    polarAccessFor: async () => ({ use: true, spend: true, web: true, connectors: true }),
    polarKeySources: async () => new Map(state.source ? [["openai", state.source]] : []),
    polarCredentialFor: async (_user: string, provider: string, payer: string | null) =>
        state.source && payer === state.source
            ? { provider, source: state.source, secret: KEY, baseUrl: null, gatewayModel: null }
            : null
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !state.limited }) }));
vi.mock("@/lib/polar/code", () => ({
    polarCodeThread: async (_user: unknown, id: string) =>
        state.session ? { session: { id, title: "Login" }, entries: [] } : null
}));
vi.mock("@/lib/polar/voice-deps", () => ({ delegateDeps: () => ({ fake: true }) }));
vi.mock("@/lib/polar/voice-realtime", () => ({
    mintRealtimeSecret: async (input: Record<string, unknown>) => {
        state.mints.push(input);
        return state.minted ? { value: "ek_fixture", expiresAt: 1_800_000_000 } : null;
    },
    runRealtimeTool: async (input: Record<string, unknown>) => {
        state.runs.push(input);
        return { output: '{"sent":"x"}', open: null, sent: [], explained: {} };
    }
}));

const mint = await import("@/app/api/polar/voice/realtime/route");
const tool = await import("@/app/api/polar/voice/realtime/tool/route");

function post(path: string, body: unknown): Request {
    return new Request(`http://polaris.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}

const open = (body: unknown = { sessionId: SESSION, lang: "en-US" }) =>
    mint.POST(post("/api/polar/voice/realtime", body));
const run = (body: unknown = { sessionId: SESSION, name: "send_message", arguments: '{"text":"go"}' }) =>
    tool.POST(post("/api/polar/voice/realtime/tool", body));

beforeEach(() => {
    state.user = { id: OWNER, viewingAs: null };
    state.limited = false;
    state.session = true;
    state.source = "own";
    state.minted = true;
    state.mints = [];
    state.runs = [];
});

describe("POST /api/polar/voice/realtime", () => {
    it("mints on the person's own key and answers the secret, never the key", async () => {
        const response = await open();
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({ value: "ek_fixture", expiresAt: 1_800_000_000 });
        expect(text).not.toContain(KEY);
        expect(state.mints[0]).toMatchObject({ apiKey: KEY, viewed: { id: SESSION, title: "Login" }, lang: "en-US" });
    });

    it("is 409 no_key on the deployment's key or none", async () => {
        state.source = "instance";
        expect(await (await open()).json()).toEqual({ error: "no_key" });
        state.source = null;
        const response = await open();
        expect(response.status).toBe(409);
        expect(state.mints).toHaveLength(0);
    });

    it("refuses view-as, a limit, a bad body, and a session not the person's", async () => {
        state.user = { id: OWNER, viewingAs: "someone" };
        expect((await open()).status).toBe(403);
        state.user = { id: OWNER, viewingAs: null };
        state.limited = true;
        expect((await open()).status).toBe(429);
        state.limited = false;
        expect((await open({ sessionId: "nope" })).status).toBe(400);
        expect((await open({ sessionId: SESSION, extra: 1 })).status).toBe(400);
        expect((await open("{")).status).toBe(400);
        state.session = false;
        expect((await open()).status).toBe(404);
        expect(state.mints).toHaveLength(0);
    });

    it("is 502 when OpenAI mints nothing", async () => {
        state.minted = false;
        expect((await open()).status).toBe(502);
    });

    it("is 401 signed out", async () => {
        state.user = null;
        expect((await open()).status).toBe(401);
    });
});

describe("POST /api/polar/voice/realtime/tool", () => {
    it("runs the tool on the session on screen and answers its output", async () => {
        const response = await run();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ output: '{"sent":"x"}', open: null, sent: [], explained: {} });
        expect(state.runs[0]).toMatchObject({ viewed: SESSION, name: "send_message", arguments: '{"text":"go"}', tail: [] });
    });

    it("refuses a session not the person's, view-as, a limit, and a bad body", async () => {
        state.session = false;
        expect((await run()).status).toBe(404);
        state.session = true;
        state.user = { id: OWNER, viewingAs: "someone" };
        expect((await run()).status).toBe(403);
        state.user = { id: OWNER, viewingAs: null };
        state.limited = true;
        expect((await run()).status).toBe(429);
        state.limited = false;
        expect((await run({ sessionId: SESSION, name: "Not A Tool", arguments: "{}" })).status).toBe(400);
        expect((await run({ sessionId: SESSION, name: "send_message" })).status).toBe(400);
        expect(state.runs).toHaveLength(0);
    });
});
