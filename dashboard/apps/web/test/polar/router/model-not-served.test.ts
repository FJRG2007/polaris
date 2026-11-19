/**
 * A model the provider's index lists but its API does not serve - Mistral's
 * 400 `invalid_model` for `labs-leanstral-1-5-1` - is a model refusal, kept
 * out for a day, and never offered by Automatic again on the next turn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({
    prisma: { userModelKey: { updateMany: async () => ({ count: 1 }) } }
}));

const { classifyProviderFailure } = await import("@/lib/polar/provider-failure");
const health = await import("@/lib/polar/router/health");
const automatic = await import("@/lib/polar/automatic");

const HOUR = 60 * 60_000;
const MISTRAL_BODY = '{"message":"Invalid model: labs-leanstral-1-5-1","type":"invalid_model","code":"1500"}';

function refusal(statusCode: number, responseBody: string) {
    return Object.assign(new Error("refused"), { statusCode, responseBody });
}

beforeEach(() => health.resetRouteHealth());

describe("a model the provider does not serve", () => {
    it("reads Mistral's invalid_model as a model refusal, not `other`", () => {
        expect(classifyProviderFailure(refusal(400, MISTRAL_BODY))).toEqual({ kind: "model", status: 400 });
    });

    it("reads OpenAI's model_not_found and a bare 404 the same way", () => {
        const openai = '{"error":{"message":"The model `gpt-x` does not exist","code":"model_not_found"}}';
        expect(classifyProviderFailure(refusal(404, openai)).kind).toBe("model");
        expect(classifyProviderFailure(refusal(404, "")).kind).toBe("model");
        expect(classifyProviderFailure(refusal(400, '{"message":"Invalid model: x"}')).kind).toBe("model");
    });

    it("stays out for a day on the key that was refused", async () => {
        const now = Date.now();
        const subject = { provider: "mistral", model: "labs-leanstral-1-5-1", keyId: "k1" };
        await health.noteRefusal(subject, "model", refusal(400, MISTRAL_BODY), now);
        const cause = health.coolingOf(subject, false, now + 12 * HOUR);
        expect(cause?.kind).toBe("model");
        expect(health.coolingOf(subject, false, now + 25 * HOUR)).toBeNull();
    });

    it("stays out on a credential with no key row too", async () => {
        const now = Date.now();
        const subject = { provider: "mistral", model: "labs-leanstral-1-5-1" };
        await health.noteRefusal(subject, "model", refusal(400, MISTRAL_BODY), now);
        expect(health.coolingOf(subject, false, now + HOUR)?.kind).toBe("model");
    });

    it("is not among Automatic's candidates once noted", () => {
        const model = (id: string) => ({
            provider: "mistral",
            providerName: "Mistral",
            model: id,
            name: id,
            reasoning: false,
            attachment: false,
            contextTokens: 128_000,
            providerContextTokens: null,
            costInput: 0,
            costOutput: 0,
            inputs: ["text"],
            releaseDate: null
        });
        const providers = [
            { provider: "mistral", name: "Mistral", payers: ["own" as const], models: [model("labs-leanstral-1-5-1"), model("mistral-medium-latest")] }
        ];
        automatic.noteModelGone("u-gone", "mistral", "labs-leanstral-1-5-1");
        const picked = automatic.automaticCandidates(
            providers,
            automatic.PLAIN_TURN,
            new Set(),
            new Set(),
            new Set(),
            automatic.unusableModels("u-gone")
        );
        expect(picked.map((entry) => entry.model)).toEqual(["mistral-medium-latest"]);
        expect(automatic.unusableModels("someone-else").size).toBe(0);
    });
});
