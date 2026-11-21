/**
 * A mention whose every model refused for good - no credit, a key refused, a
 * model gone - says who refused and links to the provider settings, instead
 * of "try again in a moment", which can never work. A refusal that may pass
 * (a rate limit, an outage) still offers Try again. The log names the step
 * that refused last, not the model first chosen.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
const state = vi.hoisted(() => ({
    refusals: [] as Array<{ step: { option: { providerName: string } }; kind: string }>,
    thrown: null as unknown
}));

vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: true, spend: true, web: true, connectors: true })
}));
vi.mock("@/lib/polar/automatic", () => ({
    PLAIN_TURN: {},
    noteModelEchoed: () => undefined,
    noteToolMarkup: () => undefined,
    toolMarkupIn: () => false
}));
// The turn is planned as the panel plans it (`turn-plan.ts`); here it is the
// mocked resolver's answer, on Automatic.
vi.mock("@/lib/polar/turn-plan", async () => {
    const models = await import("@/lib/polar/models");
    return {
        lastPolarChoice: async () => ({ kind: "language", provider: "automatic", model: "automatic", payer: null }),
        planPolarTurn: async (userId: string, choice: any, signals: any, access: any) => {
            planned.push({ choice, signals });
            const resolved = await models.resolvePolarModel(userId, choice, signals, access);
            return typeof resolved === "string" ? resolved : { resolved, choice, fellBackFrom: null };
        }
    };
});
const planned: { choice: any; signals: any }[] = [];
vi.mock("@/lib/polar/models", () => ({
    resolvePolarModel: async () => ({
        model: { id: "labs-devstral" },
        option: { provider: "mistral", model: "labs-devstral", providerName: "Mistral" },
        credential: { source: "own" },
        routed: { refusals: () => state.refusals }
    }),
    answeredBy: (value: unknown) => value
}));
vi.mock("@/lib/polar/usage", () => ({ polarLimitReached: async () => false }));
vi.mock("ai", () => ({
    generateText: async () => {
        throw state.thrown;
    }
}));

const { answerMentionWithReason } = await import("@/lib/polar/mention-answer");

/** Words that show their key and values, so the test reads what was said. */
const words = ((key: string, values?: Record<string, string>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key) as never;

const turn = { userId: "u1", words, system: "s", prompt: "p", where: "a chat mention" };

function refusal(status: number, body: unknown) {
    return Object.assign(new Error("refused"), { statusCode: status, responseBody: JSON.stringify(body) });
}

const step = (providerName: string) => ({ option: { providerName } });
const CEREBRAS_402 = refusal(402, {
    message: "Payment required to access this resource.",
    type: "payment_required_error",
    code: "payment_required"
});

beforeEach(() => {
    warn.mockClear();
});

describe("a mention every provider refused", () => {
    it("names who refused and why, with the way to fix it, when nothing can pass", async () => {
        state.refusals = [
            { step: step("Mistral"), kind: "credit" },
            { step: step("Mistral"), kind: "model" },
            { step: step("OpenRouter"), kind: "paid" },
            { step: step("Groq"), kind: "model" },
            { step: step("Cerebras"), kind: "credit" }
        ];
        state.thrown = CEREBRAS_402;
        const answer = await answerMentionWithReason(turn);
        expect(answer.problem).toBe("providersRefused");
        expect(answer.text).toBe(
            "polar.providersRefused(polar.refusedBy.credit(Mistral, OpenRouter, Cerebras); polar.refusedBy.model(Mistral, Groq)) [polar.setUpProviders](/polar/settings/providers)"
        );
        // The provider that refused last, not the one Automatic chose first.
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/^polar: a chat mention failed at Cerebras \(402, credit\)/);
    });

    it("says so for a single model whose key was refused", async () => {
        state.refusals = [];
        state.thrown = refusal(401, { error: { message: "Invalid API key", code: "invalid_api_key" } });
        const answer = await answerMentionWithReason(turn);
        expect(answer.problem).toBe("providersRefused");
        expect(answer.text).toContain("polar.refusedBy.key(Mistral)");
    });

    it("still offers Try again when a refusal may pass", async () => {
        state.refusals = [
            { step: step("Mistral"), kind: "credit" },
            { step: step("Groq"), kind: "rate" }
        ];
        state.thrown = refusal(429, { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } });
        expect(await answerMentionWithReason(turn)).toEqual({ text: "polar.failed", problem: "failed" });
    });
});
