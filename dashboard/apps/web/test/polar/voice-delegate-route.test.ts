/**
 * POST /api/polar/voice/delegate: who may call it, what it refuses, that it
 * runs on the person's helper model and records what that spent, and that a
 * provider failure is a 502 rather than a crash.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const state = {
    user: { id: OWNER, viewingAs: null as string | null } as { id: string; viewingAs: string | null } | null,
    limited: false,
    session: true,
    model: true,
    spend: true,
    fail: false,
    runs: [] as Array<Record<string, unknown>>,
    recorded: 0
};

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.user
            ? { ...state.user, isAdmin: false, name: "Ada" }
            : NextResponse.json({ error: "unauthorized" }, { status: 401 })
}));
vi.mock("@/lib/polar/access", async () => (await import("./fixtures/open-polar-access")).openPolarAccess());
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !state.limited }) }));
vi.mock("@/lib/polar/code", () => ({
    polarCodeThread: async (_user: unknown, id: string) =>
        state.session ? { session: { id, title: "Login" }, entries: [] } : null,
    polarCodeOverview: async () => ({ sessions: [] }),
    polarCodePrompt: async () => ({}),
    polarCodeInterrupt: async () => ({}),
    polarCodeModel: async () => ({})
}));
vi.mock("@/lib/polar/models", () => ({
    resolvePolarModel: async () => (state.model ? { model: "fallback" } : "no_model")
}));
vi.mock("@/lib/polar/preferences", () => ({ polarPreferences: async () => ({ helperModel: null }) }));
vi.mock("@/lib/polar/helper-model", () => ({
    polarHelperModel: async () => ({
        resolved: { model: "helper", option: { providerName: "Groq" } },
        source: "automatic"
    }),
    helperMaySpend: async () => state.spend,
    helperReasoning: () => undefined,
    recordHelperUsage: async () => {
        state.recorded += 1;
    }
}));
vi.mock("@/lib/polar/voice-delegate", () => ({
    runVoiceDelegation: async (input: Record<string, unknown>) => {
        state.runs.push(input);
        if (state.fail) throw new Error("provider said no");
        return {
            say: "Sent that to Login.",
            outcome: { open: null, sent: [{ sessionId: SESSION, at: "2026-11-16T10:00:00.000Z" }], explained: { [SESSION]: 1 } },
            usage: undefined
        };
    }
}));

const route = await import("@/app/api/polar/voice/delegate/route");

function turn(body: unknown): Request {
    return new Request("http://polaris.test/api/polar/voice/delegate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}

const good = { text: "fix the login test", sessionId: SESSION, tail: ["assistant: Hi."], lang: "es-ES" };

beforeEach(() => {
    state.user = { id: OWNER, viewingAs: null };
    state.limited = false;
    state.session = true;
    state.model = true;
    state.spend = true;
    state.fail = false;
    state.runs = [];
    state.recorded = 0;
});

describe("POST /api/polar/voice/delegate", () => {
    it("runs the turn on the helper model and answers what to say and what was sent", async () => {
        const response = await route.POST(turn(good));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            say: "Sent that to Login.",
            open: null,
            sent: [{ sessionId: SESSION, at: "2026-11-16T10:00:00.000Z" }],
            explained: { [SESSION]: 1 }
        });
        expect(state.runs[0]).toMatchObject({
            model: "helper",
            viewed: { id: SESSION, title: "Login" },
            text: "fix the login test",
            tail: ["assistant: Hi."],
            lang: "es-ES"
        });
        expect(state.recorded).toBe(1);
    });

    it("refuses somebody signed out, a viewer, and too many turns", async () => {
        state.user = null;
        expect((await route.POST(turn(good))).status).toBe(401);
        state.user = { id: OWNER, viewingAs: "someone" };
        expect((await route.POST(turn(good))).status).toBe(403);
        state.user = { id: OWNER, viewingAs: null };
        state.limited = true;
        expect((await route.POST(turn(good))).status).toBe(429);
    });

    it("refuses a body that is not a turn", async () => {
        expect((await route.POST(turn("{"))).status).toBe(400);
        expect((await route.POST(turn({ text: "hi" }))).status).toBe(400);
        expect((await route.POST(turn({ ...good, sessionId: "nope" }))).status).toBe(400);
        expect(state.runs).toEqual([]);
    });

    it("refuses a session the person cannot read", async () => {
        state.session = false;
        expect((await route.POST(turn(good))).status).toBe(404);
        expect(state.runs).toEqual([]);
    });

    it("says when no key can run it, or the shared one is spent", async () => {
        state.model = false;
        const none = await route.POST(turn(good));
        expect(none.status).toBe(409);
        expect(await none.json()).toEqual({ error: "no_model" });
        state.model = true;
        state.spend = false;
        const spent = await route.POST(turn(good));
        expect(await spent.json()).toEqual({ error: "limit" });
    });

    it("answers 502 when the provider fails", async () => {
        state.fail = true;
        const response = await route.POST(turn(good));
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "failed" });
    });
});
