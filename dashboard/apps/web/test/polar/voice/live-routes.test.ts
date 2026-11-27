/**
 * The live voice routes of a Polar chat: opening a call mints a secret only
 * on a key of the person's own that can talk live, answers it without the
 * key, and refuses another person's thread, a view-as session and an
 * over-limit caller; saving an exchange validates the body and writes a
 * question and its reply into a thread the person owns.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = "sk-fixture-own-key";

const state = {
    user: { id: OWNER, viewingAs: null as string | null },
    limited: false,
    threadOwner: OWNER as string | null,
    sources: new Map<string, string>([["openai", "own"]]),
    baseUrl: null as string | null,
    minted: true,
    mints: [] as Array<Record<string, unknown>>,
    ensured: [] as unknown[][],
    saved: [] as Array<{ messages: unknown[]; parents: Array<string | null> }>
};

vi.mock("@/lib/polar/access", () => ({
    polarCaller: async () => ({ ...state.user, isAdmin: false, name: "Ada" }),
    polarAccessFor: async () => ({ use: true, spend: true, web: true, connectors: true }),
    polarKeySources: async () => state.sources,
    polarCredentialFor: async (_user: string, provider: string, payer: string | null) =>
        state.sources.get(provider) === "own" && payer === "own"
            ? { provider, source: "own", secret: KEY, baseUrl: state.baseUrl, gatewayModel: null }
            : null
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !state.limited }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarThread: {
            findUnique: async () => (state.threadOwner ? { userId: state.threadOwner } : null)
        }
    }
}));
vi.mock("@/lib/polar/voice-realtime", () => ({
    mintLiveSecret: async (input: Record<string, unknown>) => {
        state.mints.push(input);
        return state.minted ? { value: "ek_fixture", expiresAt: 1_800_000_000 } : null;
    }
}));
vi.mock("@/lib/polar/threads", () => ({
    ensurePolarThread: async (...args: unknown[]) => {
        state.ensured.push(args);
        return state.threadOwner === OTHER ? null : { temporary: Boolean(args[5]) };
    },
    savePolarMessages: async (
        _user: string,
        _thread: string,
        messages: unknown[],
        parentOf: (index: number) => string | null
    ) => {
        state.saved.push({ messages, parents: messages.map((_, index) => parentOf(index)) });
    }
}));

const live = await import("@/app/api/polar/voice/live/route");
const turn = await import("@/app/api/polar/voice/live/turn/route");

function post(path: string, body: unknown): Request {
    return new Request(`http://polaris.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}
const open = (body: unknown = { threadId: THREAD, lang: "en-US" }) => live.POST(post("/api/polar/voice/live", body));
const exchange = {
    threadId: THREAD,
    parentId: "m0",
    user: { id: "u1", text: "Hi" },
    assistant: { id: "a1", text: "Hello" }
};
const save = (body: unknown = exchange) => turn.POST(post("/api/polar/voice/live/turn", body));

beforeEach(() => {
    state.user = { id: OWNER, viewingAs: null };
    state.limited = false;
    state.threadOwner = OWNER;
    state.sources = new Map([["openai", "own"]]);
    state.baseUrl = null;
    state.minted = true;
    state.mints = [];
    state.ensured = [];
    state.saved = [];
});

describe("POST /api/polar/voice/live", () => {
    it("mints on the person's own key and answers the secret only", async () => {
        const response = await open();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({ value: "ek_fixture", expiresAt: 1_800_000_000 });
        expect(text).not.toContain(KEY);
        expect(state.mints).toEqual([{ apiKey: KEY, lang: "en-US" }]);
    });
    it("mints for a new chat that has no row yet", async () => {
        state.threadOwner = null;
        expect((await open()).status).toBe(200);
    });
    it("409 no_key on the deployment's key, no key, or a custom address", async () => {
        for (const sources of [new Map([["openai", "instance"]]), new Map<string, string>()]) {
            state.sources = sources;
            const response = await open();
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual({ error: "no_key" });
        }
        state.sources = new Map([["openai", "own"]]);
        state.baseUrl = "https://proxy.example.test/v1";
        expect((await open()).status).toBe(409);
        expect(state.mints).toEqual([]);
    });
    it("404 on another person's thread", async () => {
        state.threadOwner = OTHER;
        expect((await open()).status).toBe(404);
        expect(state.mints).toEqual([]);
    });
    it("refuses view-as, over the limit, and a bad body", async () => {
        state.user = { id: OWNER, viewingAs: OTHER };
        expect((await open()).status).toBe(403);
        state.user = { id: OWNER, viewingAs: null };
        state.limited = true;
        expect((await open()).status).toBe(429);
        state.limited = false;
        expect((await open({ threadId: "nope" })).status).toBe(400);
        expect((await open({ threadId: THREAD, extra: 1 })).status).toBe(400);
        expect((await open("{not json")).status).toBe(400);
        expect(state.mints).toEqual([]);
    });
    it("502 when the provider does not mint", async () => {
        state.minted = false;
        expect((await open()).status).toBe(502);
    });
});

describe("POST /api/polar/voice/live/turn", () => {
    it("saves the question after its parent and the reply after the question", async () => {
        const response = await save();
        expect(response.status).toBe(200);
        expect(state.saved).toEqual([
            {
                messages: [
                    { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] },
                    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hello" }] }
                ],
                parents: ["m0", "u1"]
            }
        ]);
        expect(state.ensured[0]).toEqual([OWNER, THREAD, "Hi", null, null, false]);
    });
    it("files a new chat under the current project", async () => {
        const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        await save({ ...exchange, projectId: project });
        expect(state.ensured[0]?.[4]).toBe(project);
        expect((await save({ ...exchange, projectId: "not-a-uuid" })).status).toBe(400);
    });
    it("keeps a new chat temporary", async () => {
        await save({ ...exchange, temporary: true });
        expect(state.ensured[0]?.[5]).toBe(true);
    });
    it("404 on another person's thread, nothing saved", async () => {
        state.threadOwner = OTHER;
        expect((await save()).status).toBe(404);
        expect(state.saved).toEqual([]);
    });
    it("400 on a field it does not take or an empty line", async () => {
        expect((await save({ ...exchange, system: { id: "s", text: "x" } })).status).toBe(400);
        expect((await save({ ...exchange, assistant: { id: "a1", text: "" } })).status).toBe(400);
        expect(state.saved).toEqual([]);
    });
    it("refuses view-as", async () => {
        state.user = { id: OWNER, viewingAs: OTHER };
        expect((await save()).status).toBe(403);
    });
});
