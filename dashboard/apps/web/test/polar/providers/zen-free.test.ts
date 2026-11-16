/**
 * OpenCode Zen's free models for a person with no key: the catalogue answers
 * with them when nothing else would, never lists a priced model, and an
 * administrator's switch takes them away.
 */

import { ZEN_MODELS_ANSWER } from "../fixtures/zen-models";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    sources: new Map<string, "own" | "instance">(),
    policy: null as string | null
};

vi.mock("@/lib/api-session", () => ({ apiUser: async () => null }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/auth", () => ({ resolveGlobalStatements: async () => [] }));
vi.mock("@/lib/polar/router/store", () => ({ polarRouting: async () => ({ fallbacks: [] }) }));
vi.mock("@/lib/polar/usage", () => ({ polarLimitReached: async () => false }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => state.policy,
    setSetting: async () => undefined
}));
vi.mock("@/lib/agents/model-keys", () => ({
    keySourcesFor: async () => state.sources,
    instanceKeysAreShared: async () => false,
    chatCredentialFor: async () => ({ provider: "openai", source: "own", secret: "sk" }),
    chatCredentialsFor: async () => [{ provider: "openai", source: "own", secret: "sk" }]
}));
vi.mock("@/lib/agents/model-catalog", () => ({
    listCatalogModels: async () => [
        {
            slug: "openai/mini",
            provider: "openai",
            modelId: "mini",
            name: "Mini",
            contextTokens: 100_000,
            outputTokens: 10_000,
            effortRungs: [],
            reasoning: false,
            attachment: false,
            costInput: 1,
            costOutput: 2,
            inputModalities: ["text"],
            releaseDate: null
        }
    ],
    latestCatalogModels: async () => []
}));
vi.mock("@/lib/polar/provider-windows", () => ({
    providerWindows: async () => new Map(),
    WINDOW_PROVIDERS: []
}));

const { polarModelOptions, languageModel } = await import("@/lib/polar/models");
const { polarCredentialsFor } = await import("@/lib/polar/access");
const zen = await import("@/lib/polar/zen-free");
const { ZEN_FREE_SLUG } = await import("@/lib/polar/shared");

const ACCESS = { use: true, spend: false, web: true, connectors: false };

beforeEach(() => {
    state.sources = new Map();
    state.policy = null;
    zen.resetZenCache(async () => ZEN_MODELS_ANSWER);
});

describe("Zen's free list", () => {
    it("keeps only free chat models served on OpenCode's own host", () => {
        const models = zen.freeZenModels(ZEN_MODELS_ANSWER);
        expect(models.map((model) => model.id)).toEqual(["big-pickle", "deepseek-v4.1-flash-free"]);
        expect(models[1]).toMatchObject({
            attachment: true,
            inputs: ["text", "image"],
            reasoning: true,
            baseUrl: "https://opencode.ai/inference/openai/v1"
        });
    });

    it("hides a priced model", () => {
        const ids = zen.freeZenModels(ZEN_MODELS_ANSWER).map((model) => model.id);
        expect(ids).not.toContain("fixture-priced");
    });

    it("reads an answer that is not a list as no models", () => {
        expect(zen.freeZenModels({ error: "nope" })).toEqual([]);
        expect(zen.freeZenModels(null)).toEqual([]);
    });

    it("reads the list once, then serves it from the cache", async () => {
        const reader = vi.fn(async () => ZEN_MODELS_ANSWER);
        zen.resetZenCache(reader);
        await zen.zenFreeModels(0);
        await zen.zenFreeModels(1000);
        expect(reader).toHaveBeenCalledTimes(1);
        // Stale: answered at once from the last list, refreshed behind it.
        const stale = await zen.zenFreeModels(11 * 60_000);
        expect(stale).toHaveLength(2);
        expect(reader).toHaveBeenCalledTimes(2);
    });

    it("keeps the last good list when a refresh fails", async () => {
        let fail = false;
        zen.resetZenCache(async () => {
            if (fail) throw new Error("offline");
            return ZEN_MODELS_ANSWER;
        });
        await zen.zenFreeModels(0);
        fail = true;
        await zen.zenFreeModels(11 * 60_000);
        expect(await zen.zenFreeModels(11 * 60_000 + 1)).toHaveLength(2);
    });
});

describe("the catalogue with no keys", () => {
    it("answers with Zen's free models", async () => {
        const options = await polarModelOptions("u1", ACCESS);
        expect(options.map((option) => option.provider)).toEqual([ZEN_FREE_SLUG]);
        expect(options[0]!.models.map((model) => model.model)).toEqual([
            "big-pickle",
            "deepseek-v4.1-flash-free"
        ]);
        expect(options[0]!.models.every((model) => model.costInput === 0)).toBe(true);
    });

    it("leaves Zen out for a person whose own key answers", async () => {
        state.sources = new Map([["openai", "own"]]);
        const options = await polarModelOptions("u1", ACCESS);
        expect(options.map((option) => option.provider)).toEqual(["openai"]);
    });

    it("leaves Zen out once an administrator switched it off", async () => {
        state.policy = JSON.stringify({
            use: { who: "everyone", userIds: [], groupIds: [], guests: false },
            spend: { who: "admins", userIds: [], groupIds: [], guests: false },
            freeModels: false
        });
        expect(await polarModelOptions("u1", ACCESS)).toEqual([]);
        expect(await polarCredentialsFor("u1", ZEN_FREE_SLUG, null, ACCESS)).toEqual([]);
    });

    it("offers nothing to an account that may not use Polar", async () => {
        expect(await polarModelOptions("u1", { ...ACCESS, use: false })).toEqual([]);
    });

    it("spends the public key, never one of the person's", async () => {
        const [credential] = await polarCredentialsFor("u1", ZEN_FREE_SLUG, null, ACCESS);
        expect(credential).toMatchObject({ provider: ZEN_FREE_SLUG, secret: "public" });
        expect(await polarCredentialsFor("u1", ZEN_FREE_SLUG, "own", ACCESS)).toEqual([]);
    });

    it("calls the address the list names for the model, with the public key", async () => {
        await zen.zenFreeModels();
        const calls: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
            return new Response(
                JSON.stringify({
                    id: "c1",
                    object: "chat.completion",
                    created: 0,
                    model: "big-pickle",
                    choices: [
                        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }
                    ],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
                }),
                { status: 200, headers: { "content-type": "application/json" } }
            );
        }) as typeof fetch;
        try {
            const model = languageModel(zen.zenCredential(), "big-pickle");
            const { generateText } = await import("ai");
            const result = await generateText({ model, prompt: "hello" });
            expect(result.text).toBe("hi");
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(calls).toEqual(["https://opencode.ai/inference/openai/v1/chat/completions Bearer public"]);
    });
});
