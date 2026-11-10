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
              },
    polarCredentialsFor: async (_user: string, provider: string) =>
        provider === "deepseek" && !state.spend
            ? []
            : [
                  {
                      provider,
                      secret: `${provider}-key`,
                      source: provider === "deepseek" ? "instance" : "own"
                  }
              ]
}));

vi.mock("@/lib/polar/usage", () => ({
    routeRecord: () => ({ keyId: null, fellBack: null }),
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

const DEEPSEEK_BALANCE = refusal(402, {
    error: { message: "Insufficient Balance", type: "unknown_error", code: "invalid_request_error" }
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

const params = { prompt: [], maxOutputTokens: 16_384 } as never;

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
