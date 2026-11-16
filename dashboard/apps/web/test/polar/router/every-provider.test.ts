/**
 * A turn walks every provider the person holds and names what really
 * happened: a long list of one provider's models never pushes the others out
 * of the plan, every refusal is logged with what the provider said (scrubbed),
 * a model's reasoning never reaches another model, and a turn that asked
 * several models and got no answer names each of them - not the first one.
 */

import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({
    prisma: {
        userModelKey: { updateMany: vi.fn(async () => ({ count: 1 })) }
    }
}));

const { routeMiddleware, withoutReasoning } = await import("@/lib/polar/router/chain");
const { breadthFirst, routedModel, STEPS_MOST } = await import("@/lib/polar/router/plan");
const { resetRouteHealth } = await import("@/lib/polar/router/health");
const { resetKeyAdmission } = await import("@/lib/polar/router/limits");
const { withoutEarlierReasoning } = await import("@/lib/polar/reasoning-replay");

beforeEach(() => {
    resetRouteHealth();
    resetKeyAdmission();
});

function refusal(status: number, body: unknown) {
    return Object.assign(new Error("refused"), {
        statusCode: status,
        responseBody: JSON.stringify(body)
    });
}

function fakeModel(modelId: string, answer: (params: unknown) => Promise<unknown>) {
    return {
        specificationVersion: "v4",
        provider: "test.chat",
        modelId,
        supportedUrls: {},
        doGenerate: vi.fn(answer),
        doStream: vi.fn(answer)
    };
}

const step = (model: ReturnType<typeof fakeModel>, provider: string, keyId?: string) => ({
    model: () => model as never,
    modelId: model.modelId,
    provider,
    free: false,
    reasoning: false,
    keyId,
    coolingUntil: null,
    coolingReason: null,
    routeReasoning: "inherit" as const
});

const noWait = { sleep: vi.fn(async () => undefined) };

function generate(middleware: ReturnType<typeof routeMiddleware>, params: unknown) {
    return middleware.wrapGenerate!({
        doGenerate: vi.fn(),
        doStream: vi.fn(),
        params: params as never,
        model: {} as never
    });
}

/** Whether a call sent any reasoning part back. */
const sentReasoning = (params: unknown) =>
    JSON.stringify((params as { prompt: unknown }).prompt).includes('"type":"reasoning"');

describe("the plan keeps a place for every key", () => {
    it("never lets one provider's many models crowd the others out", () => {
        const many = Array.from({ length: 20 }, (_, index) => ({
            provider: "openrouter",
            keyId: "or1",
            id: `or-${index}`
        }));
        const others = ["groq", "anthropic", "cerebras"].map((provider) => ({
            provider,
            keyId: provider,
            id: provider
        }));
        const kept = breadthFirst([...many, ...others], STEPS_MOST);
        expect(kept).toHaveLength(STEPS_MOST);
        expect(kept[0]!.id).toBe("or-0");
        expect(kept.slice(-3).map((entry) => entry.id)).toEqual(["groq", "anthropic", "cerebras"]);
    });

    it("keeps every account of the same provider", () => {
        const steps = [
            ...Array.from({ length: 20 }, (_, index) => ({
                provider: "mistral",
                keyId: "m1",
                id: `m-${index}`
            })),
            { provider: "openrouter", keyId: "or-a", id: "a" },
            { provider: "openrouter", keyId: "or-b", id: "b" }
        ];
        const kept = breadthFirst(steps, 8);
        expect(kept).toHaveLength(8);
        expect(kept.map((entry) => entry.keyId)).toEqual(
            expect.arrayContaining(["m1", "or-a", "or-b"])
        );
    });

    it("leaves a short plan as it is", () => {
        const steps = [
            { provider: "a", keyId: "1" },
            { provider: "a", keyId: "1" },
            { provider: "b" }
        ];
        expect(breadthFirst(steps, 16)).toEqual(steps);
    });
});

describe("every refusal is logged with what the provider said, scrubbed", () => {
    it("logs provider, model, kind, status and the body without the key or account", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const first = fakeModel("mistral-large", () =>
            Promise.reject(
                refusal(401, {
                    message: "Unauthorized key sk-abcdef0123456789 for org_8f7d6c5b4a",
                    request_id: "0123456789abcdef0123456789abcdef"
                })
            )
        );
        const second = fakeModel("llama", async () => "ok");
        await generate(
            routeMiddleware([step(first, "mistral", "k1"), step(second, "groq", "k2")], noWait),
            { prompt: [] }
        );
        const line = warn.mock.calls
            .map((call) => String(call[0]))
            .find((text) => text.includes("mistral/mistral-large"));
        warn.mockRestore();
        expect(line).toContain("(401, key)");
        expect(line).toContain("Unauthorized");
        expect(line).not.toContain("sk-abcdef0123456789");
        expect(line).not.toContain("8f7d6c5b4a");
        expect(line).not.toContain("0123456789abcdef0123456789abcdef");
    });
});

describe("a model's reasoning stays with that model", () => {
    const prompt = [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
            role: "assistant",
            content: [
                {
                    type: "reasoning",
                    text: "thinking",
                    providerOptions: { anthropic: { signature: "sig" } }
                },
                { type: "tool-call", toolCallId: "t1", toolName: "x", input: {} }
            ]
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: "t1",
                    toolName: "x",
                    output: { type: "text", value: "1" }
                }
            ]
        }
    ];

    it("strips reasoning parts and nothing else", () => {
        const stripped = withoutReasoning(prompt as never);
        expect(sentReasoning({ prompt: stripped })).toBe(false);
        expect(JSON.stringify(stripped)).toContain("tool-call");
        expect(withoutReasoning([] as never)).toEqual([]);
    });

    it("sends the turn's reasoning back to the step that wrote it, and not to the one that continues", async () => {
        const seen: Array<{ model: string; reasoning: boolean }> = [];
        let refuseNow = false;
        const first = fakeModel("claude", async (params) => {
            seen.push({ model: "claude", reasoning: sentReasoning(params) });
            if (refuseNow) {
                throw refusal(429, {
                    type: "error",
                    error: { type: "rate_limit_error", message: "slow down" }
                });
            }
            return "a";
        });
        const second = fakeModel("llama", async (params) => {
            seen.push({ model: "llama", reasoning: sentReasoning(params) });
            return "b";
        });
        const middleware = routeMiddleware(
            [step(first, "anthropic", "k1"), step(second, "openrouter", "k2")],
            noWait
        );
        await generate(middleware, { prompt });
        refuseNow = true;
        await generate(middleware, { prompt });
        expect(seen[0]).toEqual({ model: "claude", reasoning: true });
        expect(seen.at(-1)).toEqual({ model: "llama", reasoning: false });
    });
});

describe("a turn that asked many models remembers each refusal", () => {
    it("lists every refused step in order, for the failure to name", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const planned = (model: ReturnType<typeof fakeModel>, provider: string, keyId: string) => ({
            ...step(model, provider, keyId),
            option: { provider, providerName: provider, name: model.modelId } as never,
            credential: { provider, keyId, source: "own" } as never
        });
        const mistral = fakeModel("mistral-large", () =>
            Promise.reject(refusal(401, { message: "Unauthorized" }))
        );
        const cerebras = fakeModel("gpt-oss", () =>
            Promise.reject(refusal(402, { type: "payment_required_error", message: "billing" }))
        );
        const routed = routedModel([
            planned(mistral, "mistral", "k1"),
            planned(cerebras, "cerebras", "k2")
        ]);
        await expect(
            (routed.model as unknown as { doGenerate: (p: unknown) => Promise<unknown> }).doGenerate({
                prompt: []
            })
        ).rejects.toBeTruthy();
        warn.mockRestore();
        expect(routed.answered()).toBeNull();
        expect(routed.refusals().map((entry) => [entry.step.provider, entry.kind])).toEqual([
            ["mistral", "key"],
            ["cerebras", "credit"]
        ]);
    });
});

describe("an earlier turn's reasoning is never replayed", () => {
    const message = (id: string, role: "user" | "assistant", parts: unknown[]) =>
        ({ id, role, parts }) as UIMessage;

    it("drops reasoning before the last message the person sent, and keeps the answer in progress", () => {
        const messages = [
            message("1", "user", [{ type: "text", text: "hi" }]),
            message("2", "assistant", [
                { type: "reasoning", text: "old" },
                { type: "text", text: "hello" }
            ]),
            message("3", "user", [{ type: "text", text: "go" }]),
            message("4", "assistant", [
                { type: "reasoning", text: "now" },
                { type: "text", text: "..." }
            ])
        ];
        const out = withoutEarlierReasoning(messages);
        expect(out[1]!.parts).toEqual([{ type: "text", text: "hello" }]);
        expect(out[3]!.parts).toHaveLength(2);
        expect(out[0]).toBe(messages[0]);
    });
});
