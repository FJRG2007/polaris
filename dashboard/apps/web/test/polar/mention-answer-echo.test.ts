/**
 * A mention answered with an echo of its prompt is that model failing: the
 * next model is asked, and when every one echoes the reader gets the normal
 * "couldn't answer" sentence - never the echo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The answer each model gives, by model id. */
let answers: Record<string, string> = {};
const echoed = new Set<string>();
const asked: string[] = [];
const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
vi.spyOn(console, "warn").mockImplementation(() => undefined);

const MODELS = ["rekaai/reka-edge", "qwen/qwen3.8-27b", "mistral-medium-latest", "last-one"];

vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: true, spend: true, web: true, connectors: true })
}));
vi.mock("@/lib/polar/automatic", () => ({
    PLAIN_TURN: {},
    noteModelEchoed: (_user: string, provider: string, model: string) => echoed.add(`${provider}/${model}`)
}));
// Automatic leaves out what was noted, as `unusableModels` makes it do.
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
    resolvePolarModel: async () => {
        const model = MODELS.find((id) => !echoed.has(`openrouter/${id}`));
        if (!model) return "no_key";
        return {
            model: { id: model },
            option: { provider: "openrouter", model, providerName: "OpenRouter" },
            credential: { source: "own" }
        };
    },
    answeredBy: (value: unknown) => value
}));
vi.mock("@/lib/polar/usage", () => ({
    polarLimitReached: async () => false,
    answerUsage: () => ({}),
    routeRecord: () => ({}),
    recordPolarUsage: async () => undefined
}));
vi.mock("ai", () => ({
    generateText: async ({ model }: { model: { id: string } }) => {
        asked.push(model.id);
        return { text: answers[model.id] ?? "", totalUsage: {} };
    }
}));

const { answerMentionWithReason } = await import("@/lib/polar/mention-answer");

const turn = {
    userId: "u1",
    words: ((key: string) => key) as never,
    system: "You are Polar.",
    prompt: '<conversation>\n</conversation>\n\n<question from="Javier">\nque tgal?\n</question>',
    where: "a chat mention",
    echo: { question: "que tgal?", names: ["Javier"] }
};

beforeEach(() => {
    echoed.clear();
    asked.length = 0;
    info.mockClear();
});

describe("a mention answered with an echo", () => {
    it("asks the next model and posts its real reply", async () => {
        answers = {
            "rekaai/reka-edge": "Javier: @polar que tgal?",
            "qwen/qwen3.8-27b": "¡Hola Javier! Todo bien, ¿y tú?"
        };
        const answer = await answerMentionWithReason(turn);
        expect(answer).toEqual({ text: "¡Hola Javier! Todo bien, ¿y tú?", problem: null });
        expect(asked).toEqual(["rekaai/reka-edge", "qwen/qwen3.8-27b"]);
        expect(echoed.has("openrouter/rekaai/reka-edge")).toBe(true);
        // Which model answered is logged, the answer is not.
        expect(info).toHaveBeenCalledWith("polar: a chat mention answered by openrouter/qwen/qwen3.8-27b (own)");
    });

    it("says it could not answer when every model echoes", async () => {
        answers = Object.fromEntries(MODELS.map((id) => [id, "Javier: que tgal?"]));
        const answer = await answerMentionWithReason(turn);
        expect(answer).toEqual({ text: "polar.failed", problem: "failed" });
        expect(asked.length).toBeLessThanOrEqual(3);
    });
});
