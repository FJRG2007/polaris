/**
 * A turn whose model Polar chose keeps going when that model cannot answer:
 * the same model through an aggregator first, then the next model that fits.
 * A model the person picked by hand is not switched behind their back.
 *
 * The providers' clients are replaced by fakes, so the whole way from the
 * resolution to the router's answer is the real code.
 */

import { z } from "zod";
import { generateText, tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
    log: [] as Array<{ provider: string; model: string; tools: string[] }>,
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
            const answer = async (options: { tools?: Array<{ name: string }> }) => {
                calls.log.push({
                    provider: name,
                    model: modelId,
                    tools: (options.tools ?? []).map((entry) => entry.name)
                });
                const refusal = calls.refuse.get(name);
                if (refusal) throw refusal;
                return {
                    content: [{ type: "text", text: `${name} answered` }],
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
            ["groq", "own"],
            ["mistral", "own"],
            ["xai", "own"],
            ["deepseek", "own"],
            ["cerebras", "own"],
            ["moonshot", "own"],
            ["openrouter", "own"]
        ]),
    polarCredentialFor: async (_user: string, provider: string) => ({
        provider,
        secret: `${provider}-key`,
        source: "own",
        keyId: `${provider}-row`
    }),
    // Every stored key has its row, which a refusal cools down.
    polarCredentialsFor: async (_user: string, provider: string) => [
        { provider, secret: `${provider}-key`, source: "own", keyId: `${provider}-row` }
    ]
}));

// The cool-down written on a key row; every other read is the real client's.
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

function catalogue(provider: string, modelId: string, cost: number) {
    return {
        slug: `${provider}/${modelId}`,
        provider,
        modelId,
        name: modelId,
        contextTokens: 100_000,
        outputTokens: 8_000,
        effortRungs: [],
        reasoning: false,
        attachment: false,
        costInput: cost,
        costOutput: cost,
        inputModalities: ["text"],
        releaseDate: null
    };
}

vi.mock("@/lib/agents/model-catalog", () => ({
    listCatalogModels: async () => [
        catalogue("groq", "llama-3.3-70b-versatile", 0.05),
        catalogue("mistral", "mistral-small-latest", 0.2),
        catalogue("openrouter", "meta-llama/llama-3.3-70b-instruct", 0.1),
        catalogue("openrouter", "openai/gpt-mini", 0.3),
        // Four more providers the person holds keys for, each dearer than the
        // rest: Automatic keeps a stand-in from three of them at most.
        catalogue("xai", "grok-mini", 1),
        catalogue("deepseek", "deepseek-chat", 1),
        catalogue("cerebras", "qwen-3-32b", 1),
        catalogue("moonshot", "kimi-k2", 1)
    ]
}));

const models = await import("@/lib/polar/models");
const { automaticChoice } = await import("@/lib/polar/shared");
const { PLAIN_TURN, failingProviders } = await import("@/lib/polar/automatic");
const { resetRouteHealth } = await import("@/lib/polar/router/health");
const { isRoutable } = await import("@/lib/polar/router/chain");
const { STEPS_MOST } = await import("@/lib/polar/router/plan");
const { pinnedByHand, turnStandIns } = await import("@/lib/polar/turn-fallback");
const { parseCatalogPayload } =
    await vi.importActual<typeof import("@/lib/agents/model-catalog")>("@/lib/agents/model-catalog");

function refusal(status: number, body: unknown) {
    return Object.assign(new Error("refused"), {
        statusCode: status,
        responseBody: JSON.stringify(body)
    });
}

const GROQ_RATE = refusal(429, {
    error: { message: "Rate limit reached", type: "tokens", code: "rate_limit_exceeded" }
});
const MISTRAL_CREDIT = refusal(402, {
    object: "error",
    message: "You have insufficient funds",
    type: "payment_required",
    code: "payment_required"
});

const choice = (provider: string, model: string) => ({
    kind: "language" as const,
    provider,
    model,
    intelligence: "balanced" as const,
    payer: null
});

const setPower = tool({
    description: "Turns a device on or off",
    inputSchema: z.object({ on: z.boolean() })
});

beforeEach(() => {
    calls.log = [];
    calls.refuse = new Map();
    resetRouteHealth();
});

describe("which refusals hand the turn on", () => {
    it("moves past credit, rate limits, outages, a model gone and a refused key", () => {
        expect(isRoutable(MISTRAL_CREDIT)).toBe(true);
        expect(isRoutable(GROQ_RATE)).toBe(true);
        expect(isRoutable(refusal(503, { error: { message: "unavailable" } }))).toBe(true);
        expect(isRoutable(refusal(404, { error: { code: "model_not_found" } }))).toBe(true);
        expect(isRoutable(refusal(401, { error: { code: "invalid_api_key" } }))).toBe(true);
    });

    it("never moves past a malformed request: every model would refuse it", () => {
        expect(isRoutable(refusal(400, { error: { message: "messages: bad shape" } }))).toBe(false);
    });
});

describe("a model picked by hand against one Polar chose", () => {
    const auto = automaticChoice();
    const list = [choice("mistral", "mistral-small-latest"), choice("groq", "llama"), auto];

    it("keeps a model picked by hand to itself", () => {
        const picked = choice("mistral", "mistral-small-latest");
        expect(pinnedByHand(picked, picked)).toBe(true);
        expect(turnStandIns(picked, [picked], picked, false, auto)).toEqual([]);
    });

    it("walks on to the rest of Polar's list and then Automatic when the person left it on Automatic", () => {
        expect(pinnedByHand(auto, list[0]!)).toBe(false);
        expect(turnStandIns(auto, list, list[0]!, false, auto)).toEqual([list[1], auto]);
    });

    it("stays on the list when the list is all the turn may use", () => {
        expect(turnStandIns(auto, list, list[0]!, true, auto)).toEqual([list[1]]);
    });

    it("hands a retired model's replacement on to Automatic", () => {
        const retired = choice("mistral", "retired");
        const first = choice("groq", "llama");
        expect(turnStandIns(retired, [retired], first, false, auto)).toEqual([auto]);
    });

    it("adds nothing to Automatic, which plans its own stand-ins", () => {
        expect(turnStandIns(auto, [auto], auto, false, auto)).toEqual([]);
    });
});

describe("the same model through an aggregator", () => {
    it("reads one model's names at different providers alike", () => {
        expect(models.modelIdentity("llama-3.3-70b-versatile")).toBe(
            models.modelIdentity("meta-llama/llama-3.3-70b-instruct")
        );
        expect(models.modelIdentity("mistral-small-latest")).toBe(
            models.modelIdentity("mistralai/mistral-small")
        );
        expect(models.modelIdentity("llama-3.1-8b-instant")).not.toBe(
            models.modelIdentity("llama-3.3-70b-versatile")
        );
    });

    it("plans Automatic's model on the person's OpenRouter key right after its own provider", async () => {
        const resolved = await models.resolvePolarModel("fb-1", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.option.model).toBe("llama-3.3-70b-versatile");
        expect(resolved.standIns?.[0]?.option).toMatchObject({
            provider: "openrouter",
            model: "meta-llama/llama-3.3-70b-instruct"
        });
    });
});

describe("a turn falling back", () => {
    it("answers a Groq rate limit through the person's OpenRouter key, with the same tools", async () => {
        calls.refuse.set("groq", GROQ_RATE);
        const resolved = await models.resolvePolarModel("fb-2", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        const answer = await generateText({
            model: resolved.model,
            prompt: "Turn the lamp off",
            tools: { set_power: setPower },
            maxRetries: 0
        });
        expect(answer.text).toBe("openrouter answered");
        expect(calls.log.map((entry) => entry.provider)).toEqual(["groq", "openrouter"]);
        expect(calls.log[1]).toEqual({
            provider: "openrouter",
            model: "meta-llama/llama-3.3-70b-instruct",
            tools: ["set_power"]
        });
        expect(models.answeredBy(resolved).option.provider).toBe("openrouter");
        // Remembered: the next turn starts past Groq rather than on it.
        expect(failingProviders("fb-2")).toEqual(new Set(["groq"]));
        const next = await models.resolvePolarModel("fb-2", automaticChoice("fast"), PLAIN_TURN);
        if (typeof next === "string") throw new Error(next);
        expect(next.option.provider).not.toBe("groq");
    });

    it("hands a list model out of credit to Automatic's plan, naming who answered", async () => {
        calls.refuse.set("mistral", MISTRAL_CREDIT);
        const listed = await models.resolvePolarModel(
            "fb-3",
            choice("mistral", "mistral-small-latest"),
            PLAIN_TURN
        );
        const auto = await models.resolvePolarModel("fb-3", automaticChoice("fast"), PLAIN_TURN);
        if (typeof listed === "string" || typeof auto === "string") throw new Error("no model");
        const turn = models.followedBy("fb-3", listed, [auto]);
        const answer = await generateText({ model: turn.model, prompt: "Hi", maxRetries: 0 });
        expect(answer.text).toBe("groq answered");
        expect(models.answeredBy(turn).option.provider).toBe("groq");
    });

    it("skips a key with no credit on the next turn instead of asking it first again", async () => {
        calls.refuse.set("mistral", MISTRAL_CREDIT);
        const turn = async () => {
            const listed = await models.resolvePolarModel(
                "fb-8",
                choice("mistral", "mistral-small-latest"),
                PLAIN_TURN
            );
            const auto = await models.resolvePolarModel("fb-8", automaticChoice("fast"), PLAIN_TURN);
            if (typeof listed === "string" || typeof auto === "string") throw new Error("no model");
            return models.followedBy("fb-8", listed, [auto]);
        };
        const first = await generateText({ model: (await turn()).model, prompt: "Hi", maxRetries: 0 });
        expect(first.text).toBe("groq answered");
        expect(calls.log.map((entry) => entry.provider)).toEqual(["mistral", "groq"]);
        calls.log = [];
        const second = await turn();
        const answer = await generateText({ model: second.model, prompt: "Hi", maxRetries: 0 });
        expect(answer.text).toBe("groq answered");
        expect(calls.log.map((entry) => entry.provider)).toEqual(["groq"]);
        expect(models.answeredBy(second).option.provider).toBe("groq");
    });

    it("leaves a model picked by hand with no other provider to fall to", async () => {
        calls.refuse.set("mistral", MISTRAL_CREDIT);
        const pinned = await models.resolvePolarModel(
            "fb-4",
            choice("mistral", "mistral-small-latest"),
            PLAIN_TURN
        );
        if (typeof pinned === "string") throw new Error(pinned);
        expect(pinned.standIns ?? []).toEqual([]);
        const failure = await generateText({ model: pinned.model, prompt: "Hi", maxRetries: 0 }).catch(
            (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(Error);
        expect(calls.log.map((entry) => entry.provider)).toEqual(["mistral"]);
    });

    it("never asks one model on one key twice, and stays within the plan's bound", async () => {
        const auto = await models.resolvePolarModel("fb-5", automaticChoice("fast"), PLAIN_TURN);
        if (typeof auto === "string") throw new Error(auto);
        const turn = models.followedBy("fb-5", auto, Array.from({ length: 20 }, () => auto));
        const steps = turn.routed?.steps ?? [];
        expect(steps.length).toBe(auto.routed?.steps.length);
        expect(steps.length).toBeLessThanOrEqual(STEPS_MOST);
    });
});

describe("the person's OpenRouter key, whatever else they hold", () => {
    it("is planned even past the three other providers Automatic keeps", async () => {
        const resolved = await models.resolvePolarModel("fb-6", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        const providers = (resolved.routed?.steps ?? []).map((entry) => entry.provider);
        expect(providers).toContain("openrouter");
        // Four others were held; three of them are kept.
        const others = new Set(providers.filter((name) => !["groq", "openrouter"].includes(name)));
        expect(others.size).toBe(3);
    });

    it("answers when every other provider refuses, with the same tools", async () => {
        for (const name of ["groq", "mistral", "xai", "deepseek", "cerebras", "moonshot"]) {
            calls.refuse.set(name, name === "mistral" ? MISTRAL_CREDIT : GROQ_RATE);
        }
        const resolved = await models.resolvePolarModel("fb-7", automaticChoice("fast"), PLAIN_TURN);
        if (typeof resolved === "string") throw new Error(resolved);
        const answer = await generateText({
            model: resolved.model,
            prompt: "Turn the lamp off",
            tools: { set_power: setPower },
            maxRetries: 0
        });
        expect(answer.text).toBe("openrouter answered");
        expect(calls.log.at(-1)?.tools).toEqual(["set_power"]);
        expect(models.answeredBy(resolved).option.provider).toBe("openrouter");
    });
});

describe("models that cannot call tools", () => {
    it("never reach the catalogue Polar picks from, so no turn is sent to one", () => {
        const rows = parseCatalogPayload({
            groq: {
                models: {
                    "llama-3.3-70b-versatile": {
                        id: "llama-3.3-70b-versatile",
                        tool_call: true,
                        limit: { context: 131_072, output: 32_768 }
                    },
                    "whisper-large-v3": { id: "whisper-large-v3", tool_call: false, limit: { context: 448 } },
                    "llama-guard-4": { id: "llama-guard-4", limit: { context: 131_072 } }
                }
            }
        });
        expect(rows.map((row) => row.modelId)).toEqual(["llama-3.3-70b-versatile"]);
    });
});
