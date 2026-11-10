/**
 * A free OpenRouter account works out of the box: a model Polar chose that is
 * refused for want of credit or by a rate limit hands the call to a stand-in
 * once, Automatic never ranks a paid model first for an account that just
 * proved it cannot pay, and the helper falls back to the chat's own model.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: true, spend: false }),
    polarKeySources: async () => new Map([["openrouter", "own"]]),
    polarCredentialFor: async () => ({ provider: "openrouter", secret: "own-key", source: "own" }),
    polarCredentialsFor: async () => [{ provider: "openrouter", secret: "own-key", source: "own" }]
}));

function catalogue(modelId: string, cost: number, reasoning = false) {
    return {
        slug: `openrouter/${modelId}`,
        provider: "openrouter",
        modelId,
        name: modelId,
        contextTokens: 100_000,
        outputTokens: 10_000,
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
        // Non-reasoning and paid: the fast route ranks it ahead of the free ones.
        catalogue("openai/gpt-mini", 0.1),
        catalogue("openai/gpt-nano", 0.2),
        catalogue("liquid/lfm-3-1.7b:free", 0, true),
        catalogue("meta/llama:free", 0, true)
    ]
}));

const { isFreeModel, creditMiddleware, PaidModelError } = await import("@/lib/polar/credit");
const { isRoutable: standInRetry } = await import("@/lib/polar/router/chain");
const { classifyProviderFailure } = await import("@/lib/polar/provider-failure");
const { answeredBy, resolvePolarModel, withStandIn } = await import("@/lib/polar/models");
const { polarHelperModel } = await import("@/lib/polar/helper-model");
const { automaticChoice } = await import("@/lib/polar/shared");
const { PLAIN_TURN, noteNoCredit, unpaidProviders, UNPAID_MS } =
    await import("@/lib/polar/automatic");

/** OpenRouter's 429 for a shared free model saturated upstream. */
function upstreamBusy() {
    return Object.assign(new Error("Too Many Requests"), {
        statusCode: 429,
        responseBody: JSON.stringify({
            error: {
                code: 429,
                message:
                    "liquid/lfm-3-1.7b:free is temporarily rate-limited upstream. Please retry shortly.",
                metadata: {
                    provider_error_code: "model_rate_limit_exceeded",
                    limit_source: "upstream_provider",
                    is_byok: false
                }
            }
        })
    });
}

function paymentRequired() {
    return Object.assign(new Error("Payment Required"), {
        statusCode: 402,
        responseBody: JSON.stringify({ error: { code: 402, message: "Insufficient credits." } })
    });
}

/** A language model that answers, or refuses, every call the same way. */
function fakeModel(modelId: string, answer: () => Promise<unknown>) {
    return {
        specificationVersion: "v4",
        provider: "openrouter.chat",
        modelId,
        supportedUrls: {},
        doGenerate: vi.fn(answer),
        doStream: vi.fn(answer)
    };
}

const option = (model: string, reasoning = false) => ({
    provider: "openrouter",
    providerName: "OpenRouter",
    model,
    name: model,
    reasoning,
    attachment: false,
    contextTokens: 0,
    providerContextTokens: null,
    costInput: 0,
    costOutput: 0,
    inputs: [],
    releaseDate: null
});
const credential = { provider: "openrouter", secret: "k", source: "own" } as never;
const params = { prompt: [], reasoning: "low" } as never;


describe("the refusals a stand-in may answer", () => {
    it("reads OpenRouter's upstream 429 as busy, not as this key's rate limit", () => {
        expect(classifyProviderFailure(upstreamBusy()).kind).toBe("busy");
        expect(
            classifyProviderFailure(Object.assign(new Error("x"), { statusCode: 429 })).kind
        ).toBe("rate");
    });

    it("hands over on a 402, a paid-model refusal or a 429, and nothing else", () => {
        expect(standInRetry(upstreamBusy())).toBe(true);
        expect(standInRetry(paymentRequired())).toBe(true);
        expect(standInRetry(new PaidModelError(paymentRequired()))).toBe(true);
        expect(standInRetry({ lastError: upstreamBusy() })).toBe(true);
        // Another key or another provider answers these.
        expect(standInRetry(Object.assign(new Error("x"), { statusCode: 401 }))).toBe(true);
        expect(standInRetry(Object.assign(new Error("x"), { statusCode: 500 }))).toBe(true);
        expect(standInRetry(Object.assign(new Error("x"), { statusCode: 400 }))).toBe(false);
        expect(standInRetry(new Error("socket hang up"))).toBe(false);
    });

    it("counts a :free model or a zero price as free, an unknown price as not", () => {
        const free = (provider: string, model: string, cost: number | null, out?: number | null) =>
            isFreeModel({ provider, model, costInput: cost, costOutput: out });
        expect(free("openrouter", "a/b:free", null)).toBe(true);
        expect(free("groq", "a/b", 0, 0)).toBe(true);
        expect(free("openrouter", "a/b", null, null)).toBe(false);
        expect(free("groq", "a/b", 0, 2)).toBe(false);
        // `:free` is OpenRouter's marker, nobody else's.
        expect(free("groq", "a/b:free", null)).toBe(false);
    });
});

describe("creditMiddleware", () => {
    it("tells the caller a provider refused for want of credit", async () => {
        const noCredit = vi.fn();
        await creditMiddleware(null, noCredit).wrapGenerate!({
            doGenerate: () => Promise.reject(paymentRequired()),
            doStream: vi.fn(),
            params,
            model: {} as never
        }).catch(() => undefined);
        expect(noCredit).toHaveBeenCalledOnce();
    });

    it("does not mark the account unpaid when a smaller answer is affordable", async () => {
        const noCredit = vi.fn();
        const afford = Object.assign(new Error("Payment Required"), {
            statusCode: 402,
            responseBody: JSON.stringify({
                error: {
                    code: 402,
                    message: "You requested up to 32000 tokens, but can only afford 4000."
                }
            })
        });
        const doGenerate = vi.fn().mockRejectedValueOnce(afford).mockResolvedValue("answer");
        const model = { doGenerate } as never;
        const result = await creditMiddleware(null, noCredit).wrapGenerate!({
            doGenerate: () => doGenerate(),
            doStream: vi.fn(),
            params: { ...params, maxOutputTokens: 32000 },
            model
        });
        expect(result).toBe("answer");
        expect(noCredit).not.toHaveBeenCalled();
    });
});

describe("withStandIn and answeredBy", () => {
    it("names the stand-in only once it has answered", async () => {
        const busy = fakeModel("liquid/lfm-3-1.7b:free", () => Promise.reject(upstreamBusy()));
        const other = fakeModel("meta/llama:free", async () => ({ content: [] }));
        const chosen = { model: busy as never, option: option(busy.modelId), credential };
        const wrapped = withStandIn(chosen, {
            model: other as never,
            option: option(other.modelId),
            credential
        });
        expect(answeredBy(wrapped).option.model).toBe("liquid/lfm-3-1.7b:free");
        await (
            wrapped.model as unknown as { doGenerate: (p: unknown) => Promise<unknown> }
        ).doGenerate(params);
        expect(answeredBy(wrapped).option.model).toBe("meta/llama:free");
    });
});

describe("Automatic for a free OpenRouter account", () => {
    it("backs a paid first pick with a free one", async () => {
        const resolved = await resolvePolarModel("fresh-1", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.option.model).toBe("openai/gpt-mini");
        expect(resolved.standIns?.map((entry) => entry.option.model)).toEqual([
            "liquid/lfm-3-1.7b:free",
            "openai/gpt-nano"
        ]);
    });

    it("offers only free models once the account refused for want of credit", async () => {
        noteNoCredit("broke", "openrouter");
        expect(unpaidProviders("broke")).toEqual(new Set(["openrouter"]));
        const resolved = await resolvePolarModel("broke", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.option.model).toBe("liquid/lfm-3-1.7b:free");
        // A free first pick is backed by another free one, never a paid one.
        expect(resolved.standIns?.map((entry) => entry.option.model)).toEqual(["meta/llama:free"]);
    });

    it("forgets the refusal after a while", () => {
        const now = Date.now();
        noteNoCredit("later", "openrouter", now);
        expect(unpaidProviders("later", now + UNPAID_MS + 1).size).toBe(0);
    });
});

describe("the helper on a free account", () => {
    it("falls back to the chat's own model when its pick is refused", async () => {
        const chatModel = fakeModel("meta/llama:free", async () => ({ content: [] }));
        const chat = {
            model: chatModel as never,
            option: option("meta/llama:free", true),
            credential
        };
        const helper = await polarHelperModel("helper-1", chat, null);
        expect(helper.source).toBe("automatic");
        expect(helper.resolved.standIns?.at(-1)?.option.model).toBe("meta/llama:free");
    });

    it("is the chat's model alone when the two are the same", async () => {
        const chatModel = fakeModel("openai/gpt-mini", async () => ({ content: [] }));
        const chat = { model: chatModel as never, option: option("openai/gpt-mini"), credential };
        const helper = await polarHelperModel("helper-2", chat, null);
        expect(helper.resolved.standIns?.map((entry) => entry.option.model)).toEqual([
            "liquid/lfm-3-1.7b:free",
            "openai/gpt-nano"
        ]);
    });
});
