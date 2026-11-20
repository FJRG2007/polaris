/**
 * The @polar failure of 2026-11-20: every key the asker held refused, and the
 * OpenRouter key - no credit, but answering on free models the day before -
 * was only asked a paid model, for 16384 tokens when the mention wanted 2048.
 * Automatic now plans a provider's first free model behind its paid pick, and
 * a stand-in on another provider is never asked for more than the caller
 * wanted.
 *
 * The providers' clients are fakes; resolution, plan and router are the real
 * code.
 */

import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
    log: [] as Array<{ provider: string; model: string; maxOutputTokens: number | undefined }>,
    refuse: new Map<string, unknown>()
}));

vi.mock("@ai-sdk/mistral", async () => {
    const compatible = await import("@ai-sdk/openai-compatible");
    return {
        createMistral: () => (modelId: string) =>
            compatible.createOpenAICompatible({ name: "mistral", baseURL: "" })(modelId)
    };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
    createOpenAICompatible:
        ({ name }: { name: string }) =>
        (modelId: string) => {
            const answer = async (options: { maxOutputTokens?: number }) => {
                calls.log.push({ provider: name, model: modelId, maxOutputTokens: options.maxOutputTokens });
                const refusal = calls.refuse.get(`${name}/${modelId}`);
                if (refusal) throw refusal;
                return {
                    content: [{ type: "text", text: `${modelId} answered` }],
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 1, text: 1, reasoning: 0 }
                    },
                    warnings: []
                };
            };
            return {
                specificationVersion: "v4",
                provider: `${name}.chat`,
                modelId,
                supportedUrls: {},
                doGenerate: answer,
                doStream: answer
            };
        }
}));

vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: true, spend: false }),
    polarKeySources: async () =>
        new Map([
            ["mistral", "own"],
            ["openrouter", "own"]
        ]),
    polarCredentialFor: async (_user: string, provider: string) => ({
        provider,
        secret: `${provider}-key`,
        source: "own",
        keyId: `${provider}-row`
    }),
    polarCredentialsFor: async (_user: string, provider: string) => [
        { provider, secret: `${provider}-key`, source: "own", keyId: `${provider}-row` }
    ],
    // The free stand-in is for people with no key of their own: not this one.
    zenFreeAllowed: async () => false
}));

vi.mock("@polaris/db", async (original) => {
    const actual = await original<typeof import("@polaris/db")>();
    const rows = { updateMany: async () => ({ count: 1 }) };
    return {
        ...actual,
        prisma: new Proxy(actual.prisma, {
            get: (target, name, receiver) =>
                name === "userModelKey" ? rows : Reflect.get(target, name, receiver)
        })
    };
});

vi.mock("@/lib/polar/usage", () => ({
    routeRecord: () => ({ keyId: null, fellBack: null }),
    polarLimitReached: async () => null
}));

vi.mock("@/lib/polar/provider-windows", () => ({
    WINDOW_PROVIDERS: [],
    providerWindows: async () => new Map()
}));

function catalogue(provider: string, modelId: string, cost: number, reasoning = false) {
    return {
        slug: `${provider}/${modelId}`,
        provider,
        modelId,
        name: modelId,
        contextTokens: 100_000,
        outputTokens: 16_384,
        effortRungs: [],
        reasoning,
        attachment: false,
        costInput: cost,
        costOutput: cost,
        inputModalities: ["text"],
        releaseDate: null
    };
}

vi.mock("@/lib/agents/model-catalog", () => ({
    listCatalogModels: async () => [
        catalogue("mistral", "mistral-small-latest", 0.1),
        // A fast turn puts models that reason last, so OpenRouter's first
        // pick is the paid one and its free model comes after every paid one.
        catalogue("openrouter", "openai/gpt-mini", 0.2),
        catalogue("openrouter", "baidu/ernie-flash:free", 0, true)
    ]
}));

const models = await import("@/lib/polar/models");
const { automaticChoice } = await import("@/lib/polar/shared");
const { PLAIN_TURN } = await import("@/lib/polar/automatic");
const { resetRouteHealth } = await import("@/lib/polar/router/health");
const { stepOutputTokens } = await import("@/lib/polar/router/chain");

function refusal(status: number, body: unknown) {
    return Object.assign(new Error("refused"), { statusCode: status, responseBody: JSON.stringify(body) });
}

beforeEach(() => {
    calls.log = [];
    calls.refuse = new Map();
    resetRouteHealth();
});

describe("a key with no credit on Automatic's walk", () => {
    it("is answered by its provider's free model in the same turn", async () => {
        calls.refuse.set(
            "mistral/mistral-small-latest",
            refusal(402, { object: "error", message: "You need a subscription to access this API.", code: "2314" })
        );
        calls.refuse.set(
            "openrouter/openai/gpt-mini",
            refusal(402, {
                error: { message: "Insufficient credits. This account never purchased credits.", code: 402 }
            })
        );
        const resolved = await models.resolvePolarModel("free-1", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        const answer = await generateText({ model: resolved.model, maxRetries: 0, maxOutputTokens: 2_048, prompt: "hola" });
        expect(answer.text).toBe("baidu/ernie-flash:free answered");
        expect(models.answeredBy(resolved).option.model).toBe("baidu/ernie-flash:free");
        // Every step after the first is another provider's: none is asked for
        // more than the mention wanted.
        expect(calls.log.filter((entry) => entry.provider === "openrouter").map((entry) => entry.maxOutputTokens)).not.toContain(16_384);
        expect(calls.log.every((entry) => (entry.maxOutputTokens ?? 0) <= 2_048)).toBe(true);
    });
});

describe("the answer length a stand-in is asked for", () => {
    it("keeps the caller's cap when the step's own is larger or unset", () => {
        expect(stepOutputTokens(2_048, 16_384)).toBe(2_048);
        expect(stepOutputTokens(2_048, undefined)).toBe(2_048);
    });

    it("takes the step's cap when it is smaller or the caller set none", () => {
        expect(stepOutputTokens(32_000, 16_384)).toBe(16_384);
        expect(stepOutputTokens(undefined, 16_384)).toBe(16_384);
        expect(stepOutputTokens(undefined, undefined)).toBeUndefined();
    });
});
