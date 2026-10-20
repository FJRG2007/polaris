/**
 * The suggested next message and the helper model it is written with: what a
 * model's answer is cleaned into, which answers earn one, that switched off
 * means no call, and how the helper model falls back when a pick cannot be
 * served.
 */

import type { UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const THREAD = "22222222-2222-4222-8222-222222222222";

const state = {
    recorded: [] as unknown[],
    hit: null as null | object,
    /** What resolvePolarModel answers, by the model asked for. */
    serve: {} as Record<string, "ok" | "no_key" | "unknown_model">,
    asked: [] as string[]
};

vi.mock("@/lib/polar/usage", () => ({
    answerUsage: () => ({ inputTokens: 1, outputTokens: 1, costUsd: null }),
    polarLimitReached: async () => state.hit,
    recordPolarUsage: async (entry: unknown) => void state.recorded.push(entry)
}));
vi.mock("@/lib/polar/models", () => ({
    reasoningFor: () => undefined,
    resolvePolarModel: async (_user: string, choice: { provider: string; model: string }) => {
        state.asked.push(`${choice.provider}/${choice.model}`);
        const answer = state.serve[choice.model] ?? "no_key";
        if (answer !== "ok") return answer;
        return resolved(choice.model, "own");
    }
}));

function resolved(model: string, source: "own" | "instance") {
    return {
        model: new MockLanguageModelV4({ doGenerate: async () => generated("x") }),
        option: {
            provider: "openai",
            providerName: "OpenAI",
            model,
            name: model,
            reasoning: false
        },
        credential: { source, provider: "openai" }
    } as never;
}

const USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
};

const generated = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: USAGE,
    warnings: []
});

const { sanitizeSuggestion, suggestsAfter, startPolarSuggestion, settledPolarSuggestion } =
    await import("@/lib/polar/suggestions");
const { polarHelperModel } = await import("@/lib/polar/helper-model");

function exchange(answer: Partial<UIMessage> = {}): UIMessage[] {
    return [
        { id: "u1", role: "user", parts: [{ type: "text", text: "How do I deploy my app?" }] },
        {
            id: "a1",
            role: "assistant",
            parts: [{ type: "text", text: "Open Deploy and pick the repository." }],
            ...answer
        }
    ];
}

function helperAnswering(text: string | Error) {
    const calls: unknown[] = [];
    const model = new MockLanguageModelV4({
        doGenerate: async (options) => {
            calls.push(options);
            if (text instanceof Error) throw text;
            return generated(text);
        }
    });
    const base = resolved("mini", "own") as { option: unknown; credential: unknown };
    return { helper: { resolved: { ...base, model }, source: "automatic" } as never, calls };
}

beforeEach(() => {
    state.recorded = [];
    state.hit = null;
    state.serve = {};
    state.asked = [];
});

describe("sanitizeSuggestion", () => {
    it.each([
        ["How do I add a domain?", "How do I add a domain?"],
        ['"Show me the logs."', "Show me the logs"],
        ["Suggestion: Set up a database", "Set up a database"],
        ["- **Roll it back**", "Roll it back"],
        ["Add a custom domain \u{1F680}\nSecond line", "Add a custom domain"],
        ["  ¿Y cómo lo actualizo?  ", "¿Y cómo lo actualizo?"]
    ])("cleans %j", (raw, expected) => {
        expect(sanitizeSuggestion(raw)).toBe(expected);
    });

    it.each([
        ["NONE"],
        ["none."],
        [""],
        ["?"],
        [
            "Here is a long explanation of what the user might want to ask next, which goes on far past what a next message is"
        ]
    ])("gives nothing for %j", (raw) => {
        expect(sanitizeSuggestion(raw)).toBeNull();
    });

    it("never keeps a control character", () => {
        expect(sanitizeSuggestion("Show\u0007 me")).toBe("Show me");
    });
});

describe("suggestsAfter", () => {
    it("follows a finished answer with words", () => {
        expect(suggestsAfter(exchange().at(-1))).toBe(true);
    });

    it("skips a failure, an empty answer and one waiting on an approval", () => {
        const failure = exchange({ parts: [{ type: "data-polar-failure", data: {} } as never] });
        expect(suggestsAfter(failure.at(-1))).toBe(false);
        expect(suggestsAfter(exchange({ parts: [] }).at(-1))).toBe(false);
        const waiting = exchange({
            parts: [
                { type: "text", text: "Shall I?" },
                { type: "tool-delete_app", toolCallId: "t", state: "approval-requested" } as never
            ]
        });
        expect(suggestsAfter(waiting.at(-1))).toBe(false);
        expect(suggestsAfter(exchange()[0])).toBe(false);
    });
});

describe("startPolarSuggestion", () => {
    it("writes one for the newest answer and counts what it spent", async () => {
        const { helper, calls } = helperAnswering("Add a custom domain");
        startPolarSuggestion(OWNER, THREAD, exchange(), Promise.resolve(helper));
        expect(await settledPolarSuggestion(OWNER, THREAD, "a1")).toBe("Add a custom domain");
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(calls[0])).toContain("Open Deploy");
        expect(state.recorded).toHaveLength(1);
        expect(state.recorded[0]).toMatchObject({
            userId: OWNER,
            threadId: THREAD,
            messageId: null
        });
    });

    it("answers nothing for another person, or for an older answer", async () => {
        const { helper } = helperAnswering("Add a custom domain");
        startPolarSuggestion(OWNER, THREAD, exchange(), Promise.resolve(helper));
        expect(await settledPolarSuggestion(STRANGER, THREAD, "a1")).toBeNull();
        expect(await settledPolarSuggestion(OWNER, THREAD, "older")).toBeNull();
    });

    it("makes no call when switched off (no helper)", async () => {
        const { calls } = helperAnswering("Add a custom domain");
        startPolarSuggestion(OWNER, THREAD, exchange(), Promise.resolve(null));
        expect(await settledPolarSuggestion(OWNER, THREAD, "a1")).toBeNull();
        expect(calls).toHaveLength(0);
        expect(state.recorded).toHaveLength(0);
    });

    it("gives up quietly when the provider fails", async () => {
        const { helper } = helperAnswering(new Error("402 out of credit"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        startPolarSuggestion(OWNER, THREAD, exchange(), Promise.resolve(helper));
        expect(await settledPolarSuggestion(OWNER, THREAD, "a1")).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("stops at the shared key's ceiling", async () => {
        const base = helperAnswering("Add a custom domain");
        const helper = {
            ...(base.helper as object),
            resolved: {
                ...(base.helper as { resolved: object }).resolved,
                credential: { source: "instance", provider: "openai" }
            }
        } as never;
        state.hit = { scope: "everyone" };
        startPolarSuggestion(OWNER, THREAD, exchange(), Promise.resolve(helper));
        expect(await settledPolarSuggestion(OWNER, THREAD, "a1")).toBeNull();
        expect(base.calls).toHaveLength(0);
    });
});

describe("polarHelperModel", () => {
    const chat = resolved("chat-model", "own");

    it("uses the person's pick when it can be served", async () => {
        state.serve = { mini: "ok", auto: "ok" };
        const helper = await polarHelperModel(OWNER, chat, {
            provider: "openai",
            model: "mini",
            payer: null
        });
        expect(helper.source).toBe("chosen");
        expect(state.asked).toEqual(["openai/mini"]);
    });

    it("falls back to Automatic when the pick's key is gone", async () => {
        state.serve = { mini: "no_key", auto: "ok" };
        const helper = await polarHelperModel(OWNER, chat, {
            provider: "openai",
            model: "mini",
            payer: "own"
        });
        expect(helper.source).toBe("automatic");
        expect(state.asked).toEqual(["openai/mini", "auto/auto"]);
    });

    it("is Automatic with no pick, and the chat's own model when nothing else serves", async () => {
        state.serve = { auto: "ok" };
        expect((await polarHelperModel(OWNER, chat, null)).source).toBe("automatic");
        state.serve = {};
        const helper = await polarHelperModel(OWNER, chat, null);
        expect(helper.source).toBe("chat");
        expect(helper.resolved).toBe(chat);
    });
});
