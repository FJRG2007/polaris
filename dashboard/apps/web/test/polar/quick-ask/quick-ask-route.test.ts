/**
 * POST /api/polar/quick: Quick AI in the search panel streams Polar's answer
 * with no tools and writes nothing to a chat; a refusal or a provider failure
 * comes back in a shape the panel names in words (`quickAskErrorOf`).
 */

import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = { id: "u1", name: "Ada", isAdmin: false, viewingAs: null as null | string };

const state = {
    limited: false,
    refusal: null as null | string,
    fail: null as null | Error,
    calls: [] as { prompt: unknown; tools: unknown }[],
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
vi.mock("@/lib/polar/claude-subscription/model", () => ({
    subscriptionFailureOf: () => null,
    localFailureOf: () => null
}));
const OPTION = { provider: "opencode", providerName: "OpenCode Zen", model: "free-1", name: "Free 1" };
vi.mock("@/lib/polar/models", () => ({
    answeredBy: <T>(resolved: T) => resolved,
    reasoningFor: () => undefined,
    rememberRefusal: () => undefined,
    failedTurn: () => ({ option: OPTION, credential: { source: "instance" }, tried: [] }),
    resolvePolarModel: async () =>
        state.refusal ?? {
            model: new MockLanguageModelV4({
                doStream: async (options) => {
                    state.calls.push({ prompt: options.prompt, tools: options.tools });
                    if (state.fail) throw state.fail;
                    return {
                        stream: simulateReadableStream({
                            chunks: [
                                { type: "stream-start" as const, warnings: [] },
                                { type: "text-start" as const, id: "t" },
                                { type: "text-delta" as const, id: "t", delta: "Paris" },
                                { type: "text-delta" as const, id: "t", delta: " is the capital." },
                                { type: "text-end" as const, id: "t" },
                                {
                                    type: "finish" as const,
                                    finishReason: { unified: "stop" as const, raw: "stop" },
                                    usage: {
                                        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                                        outputTokens: { total: 5, text: 5, reasoning: 0 }
                                    }
                                }
                            ]
                        })
                    };
                }
            }),
            option: OPTION,
            credential: { source: "own" }
        }
}));
vi.mock("@polaris/db", () => ({
    prisma: new Proxy(
        {},
        {
            get: () => {
                state.writes++;
                return {};
            }
        }
    )
}));

const { POST } = await import("@/app/api/polar/quick/route");
const { quickAskErrorOf } = await import("@/lib/polar/quick-ask");

const CHOICE = { kind: "language", provider: "auto", model: "auto", intelligence: "balanced", payer: null };

function ask(body: unknown): Promise<Response> {
    return POST(
        new Request("http://polaris.test/api/polar/quick", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
    );
}

beforeEach(() => {
    state.limited = false;
    state.refusal = null;
    state.fail = null;
    state.calls = [];
    state.recorded = [];
    state.writes = 0;
    USER.viewingAs = null;
});

describe("POST /api/polar/quick", () => {
    it("streams the answer with the model named, no tools and nothing stored", async () => {
        const response = await ask({
            turns: [
                { role: "user", text: "Capital of France?" },
                { role: "assistant", text: "Paris." },
                { role: "user", text: "And its population?" }
            ],
            choice: CHOICE
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain('"delta":"Paris"');
        expect(text).toContain('"delta":" is the capital."');
        expect(text).toContain('"model":"Free 1"');
        // The follow-up carries the conversation before it.
        expect(JSON.stringify(state.calls[0]?.prompt)).toContain("Capital of France?");
        expect(JSON.stringify(state.calls[0]?.prompt)).toContain("And its population?");
        expect(state.calls[0]?.tools).toBeUndefined();
        expect(state.writes).toBe(0);
        expect(state.recorded).toHaveLength(1);
        expect(state.recorded[0]).toMatchObject({ surface: "helper", threadId: null });
    });

    it("refuses a conversation that does not end on a question", async () => {
        const response = await ask({ turns: [{ role: "assistant", text: "Hi" }], choice: CHOICE });
        expect(response.status).toBe(400);
        expect(state.calls).toHaveLength(0);
    });

    it("names no model set up as no_key, in words the panel has", async () => {
        state.refusal = "no_key";
        const response = await ask({ turns: [{ role: "user", text: "Hi" }], choice: CHOICE });
        expect(response.status).toBe(409);
        expect(quickAskErrorOf(await response.text()).code).toBe("no_key");
    });

    it("names a rate limit", async () => {
        state.limited = true;
        const response = await ask({ turns: [{ role: "user", text: "Hi" }], choice: CHOICE });
        expect(response.status).toBe(429);
        expect(quickAskErrorOf(await response.text()).code).toBe("rate_limited");
    });

    it("refuses somebody viewing as another person", async () => {
        USER.viewingAs = "u2";
        const response = await ask({ turns: [{ role: "user", text: "Hi" }], choice: CHOICE });
        expect(response.status).toBe(403);
        expect(quickAskErrorOf(await response.text()).code).toBe("not_allowed");
    });

    it("reports a provider's failure mid-stream with the provider named", async () => {
        state.fail = new APICallError({
            message: "Too many requests",
            url: "https://opencode.ai/zen/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 429,
            responseBody: '{"error":{"message":"Rate limit exceeded"}}'
        });
        const response = await ask({ turns: [{ role: "user", text: "Hi" }], choice: CHOICE });
        const text = await response.text();
        const line = text.split("\n").find((entry) => entry.includes('"type":"error"'));
        expect(line).toBeDefined();
        const part = JSON.parse(line!.replace(/^data: /, "")) as { errorText: string };
        const failure = quickAskErrorOf(part.errorText);
        expect(failure.provider).toBe("OpenCode Zen");
        expect(failure.code).not.toBe("failed");
    });
});

describe("quickAskErrorOf", () => {
    it("reads a dropped connection as offline and anything else as failed", () => {
        expect(quickAskErrorOf("Failed to fetch").code).toBe("offline");
        expect(quickAskErrorOf("something odd").code).toBe("failed");
        expect(quickAskErrorOf(undefined).code).toBe("failed");
    });
});
