/**
 * POST /api/polar/btw: a side question is one call to the chat's model with
 * no tools, answered from the context it is sent, and nothing of it is written
 * to the thread - the question and the answer never enter the conversation.
 */

import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = { id: "u1", name: "Ada", isAdmin: false, viewingAs: null as null | string };
const THREAD = "22222222-2222-4222-8222-222222222222";

const state = {
    limited: false,
    owned: true,
    answer: "It was config/polar.ts." as string | Error,
    calls: [] as { prompt: unknown; tools: unknown; toolChoice: unknown }[],
    recorded: [] as Record<string, unknown>[],
    writes: 0
};

vi.mock("@/lib/polar/access", async () =>
    (await import("../fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/api-session", () => ({ apiUser: async () => USER }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !state.limited }) }));
vi.mock("@/lib/polar/usage", () => ({
    routeRecord: () => ({ keyId: null, fellBack: null }),
    answerUsage: () => ({ inputTokens: 10, outputTokens: 5, costUsd: null }),
    polarLimitReached: async () => null,
    recordPolarUsage: async (entry: Record<string, unknown>) => void state.recorded.push(entry)
}));
vi.mock("@/lib/polar/models", () => ({
    answeredBy: <T>(resolved: T) => resolved,
    reasoningFor: () => undefined,
    resolvePolarModel: async () => ({
        model: new MockLanguageModelV4({
            doGenerate: async (options) => {
                state.calls.push({
                    prompt: options.prompt,
                    tools: options.tools,
                    toolChoice: options.toolChoice
                });
                if (state.answer instanceof Error) throw state.answer;
                return {
                    content: [{ type: "text" as const, text: state.answer }],
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage: {
                        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 5, text: 5, reasoning: 0 }
                    },
                    warnings: []
                };
            }
        }),
        option: { provider: "anthropic", providerName: "Anthropic", model: "m-1", name: "M 1" },
        credential: { source: "own" }
    })
}));
vi.mock("@polaris/db", () => {
    const write = () => {
        state.writes++;
        return {};
    };
    return {
        prisma: {
            polarThread: {
                count: async () => (state.owned ? 1 : 0),
                update: write,
                create: write
            },
            polarMessage: {
                create: write,
                createMany: write,
                update: write,
                updateMany: write,
                upsert: write
            },
            $transaction: write
        }
    };
});

const { POST } = await import("@/app/api/polar/btw/route");

const CHOICE = { provider: "anthropic", model: "m-1" };

function ask(body: unknown): Promise<Response> {
    return POST(
        new Request("http://localhost/api/polar/btw", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
    );
}

const base = {
    question: "What was the config file called?",
    context: "User: Edit the config\n\nPolar: [tool read_file: config/polar.ts]",
    choice: CHOICE,
    threadId: THREAD
};

beforeEach(() => {
    state.limited = false;
    state.owned = true;
    state.answer = "It was config/polar.ts.";
    state.calls = [];
    state.recorded = [];
    state.writes = 0;
});

describe("POST /api/polar/btw", () => {
    it("answers from the context it is sent, with no tools, and writes nothing to the thread", async () => {
        const response = await ask(base);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ answer: "It was config/polar.ts.", model: "M 1" });
        expect(state.calls).toHaveLength(1);
        expect(state.calls[0]?.tools).toBeUndefined();
        // AI SDK 7 fills in `{ type: "auto" }` whenever no choice is given, tools
        // or not; with none sent there is nothing for it to choose.
        expect(state.calls[0]?.toolChoice).toEqual({ type: "auto" });
        const sent = JSON.stringify(state.calls[0]?.prompt);
        expect(sent).toContain("config/polar.ts");
        expect(sent).toContain("What was the config file called?");
        expect(sent).toContain("no tools");
        expect(state.writes).toBe(0);
        expect(state.recorded[0]).toMatchObject({
            threadId: THREAD,
            messageId: null,
            surface: "helper"
        });
    });

    it("replays the earlier side questions with the ask", async () => {
        await ask({ ...base, earlier: [{ question: "Which branch?", answer: "main" }] });
        const sent = JSON.stringify(state.calls[0]?.prompt);
        expect(sent).toContain("Which branch?");
        expect(sent).toContain("A: main");
    });

    it("refuses more earlier exchanges than it replays, an empty question and unknown fields", async () => {
        const earlier = Array.from({ length: 21 }, (_, at) => ({ question: `q${at}`, answer: "a" }));
        expect((await ask({ ...base, earlier })).status).toBe(400);
        expect((await ask({ ...base, question: "   " })).status).toBe(400);
        expect((await ask({ ...base, extra: true })).status).toBe(400);
        expect(state.calls).toHaveLength(0);
    });

    it("keeps another person's thread off the usage row", async () => {
        state.owned = false;
        await ask(base);
        expect(state.recorded[0]).toMatchObject({ threadId: null });
    });

    it("says it failed without a word of the provider's error", async () => {
        state.answer = new Error("upstream secret detail");
        const response = await ask(base);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "failed" });
    });

    it("holds the rate limit", async () => {
        state.limited = true;
        expect((await ask(base)).status).toBe(429);
        expect(state.calls).toHaveLength(0);
    });
});
