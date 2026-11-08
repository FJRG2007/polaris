/**
 * A model Polar chose that is refused hands the turn to a stand-in from any
 * provider the person may spend on, not only its own: its own provider first,
 * then the others in Automatic's order, never a key the person may not spend
 * or one past the administrator's ceiling, and never another provider when
 * the turn sends a tool only its own provider runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ spend: true, limited: false }));

vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: true, spend: state.spend }),
    polarKeySources: async () =>
        new Map([
            ["groq", "own"],
            ["openrouter", "own"],
            ...(state.spend ? [["deepseek", "instance"] as const] : [])
        ]),
    polarCredentialFor: async (_user: string, provider: string) =>
        provider === "deepseek" && !state.spend
            ? null
            : {
                  provider,
                  secret: `${provider}-key`,
                  source: provider === "deepseek" ? "instance" : "own"
              }
}));

vi.mock("@/lib/polar/usage", () => ({
    polarLimitReached: async () =>
        state.limited ? { used: 10, amount: 10, period: "day" as const } : null
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
        outputTokens: 8_000,
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
        catalogue("groq", "llama-fast", 0.05),
        catalogue("groq", "qwen-32b", 0.3, true),
        catalogue("groq", "gemma-free", 0, true),
        catalogue("openrouter", "openai/gpt-mini", 0.1),
        catalogue("openrouter", "meta/llama:free", 0, true),
        catalogue("deepseek", "deepseek-chat", 0.2)
    ]
}));

const { standInFits, standInMiddleware } = await import("@/lib/polar/credit");
const { answeredBy, rememberRefusal, resolvePolarModel, withStandIn } =
    await import("@/lib/polar/models");
const { automaticChoice } = await import("@/lib/polar/shared");
const { PLAIN_TURN, failingProviders, noteNoCredit, unpaidProviders } =
    await import("@/lib/polar/automatic");

beforeEach(() => {
    state.spend = true;
    state.limited = false;
});

function refusal(status: number, body: unknown) {
    return Object.assign(new Error("refused"), {
        statusCode: status,
        responseBody: JSON.stringify(body)
    });
}

const GROQ_RATE = refusal(429, {
    error: { message: "Rate limit reached", type: "tokens", code: "rate_limit_exceeded" }
});
const GROQ_KEY = refusal(401, {
    error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" }
});
const DEEPSEEK_BALANCE = refusal(402, {
    error: { message: "Insufficient Balance", type: "unknown_error", code: "invalid_request_error" }
});
const ANTHROPIC_OVERLOADED = refusal(529, {
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" }
});

function fakeModel(modelId: string, answer: () => Promise<unknown>) {
    return {
        specificationVersion: "v4",
        provider: "test.chat",
        modelId,
        supportedUrls: {},
        doGenerate: vi.fn(answer),
        doStream: vi.fn(answer)
    };
}

const target = (
    model: ReturnType<typeof fakeModel>,
    provider: string,
    free = false,
    outputTokens?: number
) => ({ model: () => model as never, provider, free, reasoning: true, outputTokens });

const params = { prompt: [], maxOutputTokens: 16_384 } as never;
const webSearch = {
    prompt: [],
    tools: [{ type: "provider", id: "anthropic.web_search_20250305", name: "web_search", args: {} }]
} as never;

describe("which stand-in fits which refusal", () => {
    const tools = { tools: [] } as never;
    it("leaves a refused key and an outage to another provider", () => {
        expect(standInFits("key", "groq", { provider: "groq", free: true }, tools)).toBe(false);
        expect(standInFits("key", "groq", { provider: "openrouter", free: false }, tools)).toBe(
            true
        );
        expect(standInFits("down", "groq", { provider: "groq", free: false }, tools)).toBe(false);
    });

    it("hands a key with no credit only its own free models", () => {
        expect(
            standInFits("credit", "deepseek", { provider: "deepseek", free: false }, tools)
        ).toBe(false);
        expect(standInFits("credit", "deepseek", { provider: "deepseek", free: true }, tools)).toBe(
            true
        );
        expect(standInFits("paid", "openrouter", { provider: "groq", free: false }, tools)).toBe(
            true
        );
    });

    it("lets any model answer a rate limit, a busy model or a missing one", () => {
        for (const kind of ["rate", "busy", "model"] as const) {
            expect(standInFits(kind, "groq", { provider: "groq", free: false }, tools)).toBe(true);
        }
    });

    it("keeps a turn that sends a provider-only tool with its own provider", () => {
        expect(
            standInFits("busy", "anthropic", { provider: "openrouter", free: true }, webSearch)
        ).toBe(false);
        expect(
            standInFits("busy", "anthropic", { provider: "anthropic", free: false }, webSearch)
        ).toBe(true);
    });
});

describe("standInMiddleware across providers", () => {
    it("skips its own provider for a refused key and asks the next provider", async () => {
        const own = fakeModel("qwen-32b", async () => "own");
        const other = fakeModel("openai/gpt-mini", async () => "other");
        const onStandIn = vi.fn();
        const onRefused = vi.fn();
        const answer = await standInMiddleware(
            "groq",
            [target(own, "groq"), target(other, "openrouter", false, 4_000)],
            { onStandIn, onRefused }
        ).wrapGenerate!({
            doGenerate: () => Promise.reject(GROQ_KEY),
            doStream: vi.fn(),
            params,
            model: {} as never
        });
        expect(answer).toBe("other");
        expect(own.doGenerate).not.toHaveBeenCalled();
        expect(onStandIn).toHaveBeenCalledWith(1);
        expect(onRefused).toHaveBeenCalledWith("key");
        // Another provider's model reserves its own answer length.
        expect(other.doGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ maxOutputTokens: 4_000 })
        );
    });

    it("tries its own provider first for a rate limit, keeping the call as it was", async () => {
        const own = fakeModel("qwen-32b", async () => "own");
        const other = fakeModel("openai/gpt-mini", async () => "other");
        const answer = await standInMiddleware(
            "groq",
            [target(own, "groq"), target(other, "openrouter")],
            { onStandIn: () => undefined }
        ).wrapGenerate!({
            doGenerate: () => Promise.reject(GROQ_RATE),
            doStream: vi.fn(),
            params,
            model: {} as never
        });
        expect(answer).toBe("own");
        expect(own.doGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ maxOutputTokens: 16_384 })
        );
    });

    it("moves a key with no credit to another provider when its own has nothing free", async () => {
        const ownPaid = fakeModel("deepseek-reasoner", async () => "own");
        const other = fakeModel("gemma-free", async () => "other");
        const answer = await standInMiddleware(
            "deepseek",
            [target(ownPaid, "deepseek"), target(other, "groq", true)],
            { onStandIn: () => undefined }
        ).wrapStream!({
            doStream: () => Promise.reject(DEEPSEEK_BALANCE),
            doGenerate: vi.fn(),
            params,
            model: {} as never
        });
        expect(answer).toBe("other");
        expect(ownPaid.doStream).not.toHaveBeenCalled();
    });

    it("does not switch providers for a turn that sends a provider-only tool", async () => {
        const other = fakeModel("openai/gpt-mini", async () => "other");
        const failure = await standInMiddleware("anthropic", [target(other, "openrouter")], {
            onStandIn: () => undefined
        }).wrapStream!({
            doStream: () => Promise.reject(ANTHROPIC_OVERLOADED),
            doGenerate: vi.fn(),
            params: webSearch,
            model: {} as never
        }).catch((error: unknown) => error);
        expect(failure).toBe(ANTHROPIC_OVERLOADED);
        expect(other.doStream).not.toHaveBeenCalled();
    });

    it("asks one stand-in at most, even with more in line", async () => {
        const first = fakeModel("openai/gpt-mini", () => Promise.reject(GROQ_RATE));
        const second = fakeModel("deepseek-chat", async () => "second");
        const failure = await standInMiddleware(
            "groq",
            [target(first, "openrouter"), target(second, "deepseek")],
            { onStandIn: () => undefined }
        ).wrapGenerate!({
            doGenerate: () => Promise.reject(GROQ_KEY),
            doStream: vi.fn(),
            params,
            model: {} as never
        }).catch((error: unknown) => error);
        expect(failure).toBe(GROQ_RATE);
        expect(second.doGenerate).not.toHaveBeenCalled();
    });
});

describe("Automatic's stand-ins across providers", () => {
    it("lines up its own provider first, then the others in Automatic's order", async () => {
        const resolved = await resolvePolarModel("cross-1", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.option.model).toBe("llama-fast");
        expect(resolved.standIns?.map((entry) => entry.option.model)).toEqual([
            "gemma-free",
            "qwen-32b",
            "openai/gpt-mini",
            "deepseek-chat"
        ]);
    });

    it("leaves out this Polaris's key once the administrator's ceiling is reached", async () => {
        state.limited = true;
        const resolved = await resolvePolarModel("cross-2", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.standIns?.map((entry) => entry.option.provider)).not.toContain("deepseek");
    });

    it("never offers this Polaris's key to somebody who may not spend it", async () => {
        state.spend = false;
        const resolved = await resolvePolarModel("cross-3", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.standIns?.map((entry) => entry.option.provider)).not.toContain("deepseek");
    });

    it("offers a provider that refused for want of credit only its free models", async () => {
        noteNoCredit("cross-4", "groq");
        const resolved = await resolvePolarModel("cross-4", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.option.model).toBe("openai/gpt-mini");
        expect(resolved.standIns?.map((entry) => entry.option.model)).toEqual([
            "meta/llama:free",
            "deepseek-chat",
            "gemma-free"
        ]);
    });
});

describe("what a cross-provider stand-in leaves behind", () => {
    const option = (provider: string, model: string) => ({
        provider,
        providerName: provider,
        model,
        name: model,
        reasoning: false,
        attachment: false,
        contextTokens: 0,
        providerContextTokens: null,
        costInput: 0.1,
        costOutput: 0.1,
        inputs: [],
        releaseDate: null
    });
    const credentialOf = (provider: string) => ({ provider, secret: "k", source: "own" }) as never;

    it("names and bills the model that answered, and remembers the refusal", async () => {
        const broke = fakeModel("deepseek-chat", () => Promise.reject(DEEPSEEK_BALANCE));
        const other = fakeModel("llama-fast", async () => ({ content: [] }));
        const chosen = {
            model: broke as never,
            option: option("deepseek", "deepseek-chat"),
            credential: credentialOf("deepseek"),
            onRefused: (kind: Parameters<typeof rememberRefusal>[2]) =>
                rememberRefusal("cross-5", "deepseek", kind)
        };
        const wrapped = withStandIn(chosen, {
            model: other as never,
            option: option("groq", "llama-fast"),
            credential: credentialOf("groq")
        });
        await (
            wrapped.model as unknown as { doGenerate: (p: unknown) => Promise<unknown> }
        ).doGenerate(params);
        expect(answeredBy(wrapped).option.provider).toBe("groq");
        expect(unpaidProviders("cross-5")).toEqual(new Set(["deepseek"]));
    });

    it("puts a provider whose key was refused last, but not one whose model was busy", () => {
        rememberRefusal("cross-6", "groq", "key");
        rememberRefusal("cross-6", "openrouter", "busy");
        expect(failingProviders("cross-6")).toEqual(new Set(["groq"]));
    });

    it("adds the chat's model to the same single retry rather than a second one", () => {
        const a = fakeModel("a", async () => "a");
        const b = fakeModel("b", async () => "b");
        const c = fakeModel("c", async () => "c");
        const once = withStandIn(
            { model: a as never, option: option("groq", "a"), credential: credentialOf("groq") },
            { model: b as never, option: option("openrouter", "b"), credential: credentialOf("x") }
        );
        const twice = withStandIn(once, {
            model: c as never,
            option: option("deepseek", "c"),
            credential: credentialOf("deepseek")
        });
        expect(twice.base).toBe(a);
        expect(twice.standIns?.map((entry) => entry.option.model)).toEqual(["b", "c"]);
    });
});
