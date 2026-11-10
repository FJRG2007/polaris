/**
 * Polar's router walks every step of its plan - the chosen model on each of
 * its provider's keys, then the fallbacks - until one answers: a refused key
 * hands the call to the next key of the same provider, an outage to another
 * provider, a key with no credit to a free model, and only the last step
 * standing is retried after a wait. A stream that fails before it says
 * anything is routed past like a refusal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userModelKey: {
            updateMany: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
                db.updates.push(args);
                return { count: 1 };
            })
        }
    }
}));

const { routeMiddleware, backoffMs, heldStream, isRoutable, NoRouteError } =
    await import("@/lib/polar/router/chain");
const { resetRouteHealth, coolingOf } = await import("@/lib/polar/router/health");
const { resetKeyAdmission } = await import("@/lib/polar/router/limits");
const { classifyProviderFailure } = await import("@/lib/polar/provider-failure");

beforeEach(() => {
    db.updates.length = 0;
    resetRouteHealth();
    resetKeyAdmission();
});

function refusal(status: number, body: unknown, headers?: Record<string, string>) {
    return Object.assign(new Error("refused"), {
        statusCode: status,
        responseBody: JSON.stringify(body),
        ...(headers ? { responseHeaders: headers } : {})
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
const BAD_REQUEST = refusal(400, { error: { message: "messages: bad shape" } });

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

type Fake = ReturnType<typeof fakeModel>;

const step = (
    model: Fake,
    provider: string,
    extra: Partial<{
        keyId: string;
        free: boolean;
        reasoning: boolean;
        outputTokens: number;
        routeReasoning: "inherit" | "off" | "high";
        limits: Record<string, number | null>;
        coolingUntil: Date;
        coolingReason: string;
        spent: boolean;
    }> = {}
) => ({
    model: () => model as never,
    modelId: model.modelId,
    provider,
    free: extra.free ?? false,
    reasoning: extra.reasoning ?? true,
    outputTokens: extra.outputTokens,
    keyId: extra.keyId,
    limits: extra.limits as never,
    coolingUntil: extra.coolingUntil ?? null,
    coolingReason: extra.coolingReason ?? null,
    routeReasoning: extra.routeReasoning ?? ("inherit" as const),
    spent: extra.spent
});

const params = { prompt: [], maxOutputTokens: 16_384, reasoning: "medium" } as never;
const webSearch = {
    prompt: [],
    tools: [{ type: "provider", id: "anthropic.web_search_20250305", name: "web_search", args: {} }]
} as never;

const noWait = { sleep: vi.fn(async () => undefined) };

function generate(middleware: ReturnType<typeof routeMiddleware>, call = params) {
    return middleware.wrapGenerate!({
        doGenerate: vi.fn(),
        doStream: vi.fn(),
        params: call,
        model: {} as never
    });
}

function stream(middleware: ReturnType<typeof routeMiddleware>, call = params) {
    return middleware.wrapStream!({
        doGenerate: vi.fn(),
        doStream: vi.fn(),
        params: call,
        model: {} as never
    });
}

/** A stream result from these parts. */
function streamOf(parts: unknown[]) {
    return {
        stream: new ReadableStream({
            start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.close();
            }
        })
    };
}

async function partsOf(result: { stream: ReadableStream<unknown> }) {
    const found: unknown[] = [];
    const reader = result.stream.getReader();
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return found;
        found.push(value);
    }
}

describe("key rotation", () => {
    it("hands a refused key's call to the next key of the same provider", async () => {
        const first = fakeModel("llama", () => Promise.reject(GROQ_KEY));
        const second = fakeModel("llama", async () => "second key");
        const answered = vi.fn();
        const answer = await generate(
            routeMiddleware(
                [step(first, "groq", { keyId: "k1" }), step(second, "groq", { keyId: "k2" })],
                { onAnswered: answered, ...noWait }
            )
        );
        expect(answer).toBe("second key");
        expect(answered).toHaveBeenCalledWith(1, "key");
    });

    it("cools a refused key down on its row and puts it back once it answers", async () => {
        const first = fakeModel("llama", () => Promise.reject(GROQ_KEY));
        const second = fakeModel("llama", async () => "ok");
        await generate(
            routeMiddleware(
                [step(first, "groq", { keyId: "k1" }), step(second, "groq", { keyId: "k2" })],
                noWait
            )
        );
        await vi.waitFor(() => expect(db.updates.length).toBeGreaterThanOrEqual(2));
        const cooled = db.updates.find((update) => update.data.coolingReason === "key");
        expect(cooled?.where).toEqual({ id: "k1" });
        expect(cooled?.data.coolingUntil).toBeInstanceOf(Date);
        expect(coolingOf({ provider: "groq", model: "llama", keyId: "k1" }, false)?.kind).toBe(
            "key"
        );
        const used = db.updates.find((update) => (update.where as { id: string }).id === "k2");
        expect(used?.data.lastUsedAt).toBeInstanceOf(Date);
    });

    it("steps over a key that is cooling down, and asks it last rather than not at all", async () => {
        const cooled = fakeModel("llama", async () => "cooled");
        const ready = fakeModel("llama", () => Promise.reject(GROQ_KEY));
        const until = new Date(Date.now() + 60_000);
        const answer = await generate(
            routeMiddleware(
                [
                    step(cooled, "groq", { keyId: "k1", coolingUntil: until, coolingReason: "rate" }),
                    step(ready, "groq", { keyId: "k2" })
                ],
                noWait
            )
        );
        expect(ready.doGenerate).toHaveBeenCalledOnce();
        expect(answer).toBe("cooled");
    });

    it("asks a key with no credit for a free model only", async () => {
        const paid = fakeModel("deepseek-reasoner", () => Promise.reject(DEEPSEEK_BALANCE));
        const paidAgain = fakeModel("deepseek-chat", async () => "paid");
        const free = fakeModel("deepseek-free", async () => "free");
        const answer = await generate(
            routeMiddleware(
                [
                    step(paid, "deepseek", { keyId: "k1" }),
                    step(paidAgain, "deepseek", { keyId: "k1" }),
                    step(free, "deepseek", { keyId: "k1", free: true })
                ],
                noWait
            )
        );
        expect(paidAgain.doGenerate).not.toHaveBeenCalled();
        expect(answer).toBe("free");
    });
});

describe("across providers", () => {
    it("moves past a whole provider that is down", async () => {
        const down = refusal(500, { error: { message: "internal" } });
        const one = fakeModel("a", () => Promise.reject(down));
        const twoSame = fakeModel("b", async () => "same provider");
        const other = fakeModel("c", async () => "other provider");
        const answer = await generate(
            routeMiddleware(
                [
                    step(one, "groq", { keyId: "k1" }),
                    step(twoSame, "groq", { keyId: "k2" }),
                    step(other, "openrouter", { keyId: "k3" })
                ],
                noWait
            )
        );
        expect(twoSame.doGenerate).not.toHaveBeenCalled();
        expect(answer).toBe("other provider");
    });

    it("keeps the call as it was on its own provider and reserves another's own length", async () => {
        const own = fakeModel("qwen-32b", () => Promise.reject(GROQ_KEY));
        const other = fakeModel("openai/gpt-mini", async () => "other");
        await generate(
            routeMiddleware(
                [
                    step(own, "groq", { keyId: "k1" }),
                    step(other, "openrouter", { keyId: "k2", outputTokens: 4_000 })
                ],
                noWait
            )
        );
        expect(own.doGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ maxOutputTokens: 16_384 })
        );
        expect(other.doGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ maxOutputTokens: 4_000 })
        );
    });

    it("does not switch providers for a turn that sends a provider-only tool", async () => {
        const own = fakeModel("claude", () => Promise.reject(ANTHROPIC_OVERLOADED));
        const other = fakeModel("openai/gpt-mini", async () => "other");
        const failure = await generate(
            routeMiddleware(
                [step(own, "anthropic", { keyId: "k1" }), step(other, "openrouter")],
                noWait
            ),
            webSearch
        ).catch((error: unknown) => error);
        expect(classifyProviderFailure(failure).kind).toBe("busy");
        expect(other.doGenerate).not.toHaveBeenCalled();
    });

    it("walks on past a fallback that is refused too", async () => {
        const first = fakeModel("a", () => Promise.reject(GROQ_KEY));
        const second = fakeModel("b", () => Promise.reject(GROQ_RATE));
        const third = fakeModel("c", async () => "third");
        const answer = await generate(
            routeMiddleware(
                [
                    step(first, "groq", { keyId: "k1" }),
                    step(second, "openrouter", { keyId: "k2" }),
                    step(third, "deepseek", { keyId: "k3" })
                ],
                noWait
            )
        );
        expect(answer).toBe("third");
    });

    it("surfaces a refusal another model would meet the same way", async () => {
        const first = fakeModel("a", () => Promise.reject(BAD_REQUEST));
        const second = fakeModel("b", async () => "b");
        const failure = await generate(
            routeMiddleware([step(first, "groq"), step(second, "openrouter")], noWait)
        ).catch((error: unknown) => error);
        expect(failure).toBe(BAD_REQUEST);
        expect(second.doGenerate).not.toHaveBeenCalled();
        expect(isRoutable(BAD_REQUEST)).toBe(false);
    });

    it("walks on when the step that answered is refused later in the turn", async () => {
        const first = fakeModel("a", async () => "a");
        first.doGenerate.mockResolvedValueOnce("a").mockRejectedValueOnce(GROQ_RATE);
        const second = fakeModel("b", async () => "b");
        const middleware = routeMiddleware(
            [step(first, "groq", { keyId: "k1" }), step(second, "openrouter")],
            noWait
        );
        expect(await generate(middleware)).toBe("a");
        expect(await generate(middleware)).toBe("b");
        expect(await generate(middleware)).toBe("b");
        expect(first.doGenerate).toHaveBeenCalledTimes(2);
    });

    it("keeps the step that answered for the turn's later steps", async () => {
        const first = fakeModel("a", () => Promise.reject(GROQ_KEY));
        const second = fakeModel("b", async () => "b");
        const middleware = routeMiddleware(
            [step(first, "groq", { keyId: "k1" }), step(second, "openrouter")],
            noWait
        );
        await generate(middleware);
        await generate(middleware);
        expect(first.doGenerate).toHaveBeenCalledOnce();
        expect(second.doGenerate).toHaveBeenCalledTimes(2);
    });
});

describe("reasoning per step", () => {
    it("keeps the call's effort, forces a step's own, and sends none to a model that cannot", async () => {
        const forced = fakeModel("a", () => Promise.reject(GROQ_KEY));
        const off = fakeModel("b", () => Promise.reject(GROQ_KEY));
        const plain = fakeModel("c", async () => "c");
        await generate(
            routeMiddleware(
                [
                    step(forced, "groq", { keyId: "k1", routeReasoning: "high" }),
                    step(off, "groq", { keyId: "k2", routeReasoning: "off" }),
                    step(plain, "groq", { keyId: "k3", reasoning: false })
                ],
                noWait
            )
        );
        expect(forced.doGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ reasoning: "high" })
        );
        expect(off.doGenerate).toHaveBeenCalledWith(expect.objectContaining({ reasoning: "none" }));
        expect(plain.doGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ reasoning: undefined })
        );
    });
});

describe("retries", () => {
    it("retries the last step standing after the wait the provider asked for", async () => {
        const limited = refusal(
            429,
            { error: { code: "rate_limit_exceeded" } },
            { "retry-after": "2" }
        );
        const model = fakeModel("a", async () => "ok");
        model.doGenerate.mockRejectedValueOnce(limited);
        const sleep = vi.fn(async () => undefined);
        const answer = await generate(routeMiddleware([step(model, "groq")], { sleep }));
        expect(answer).toBe("ok");
        expect(sleep).toHaveBeenCalledOnce();
        expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThanOrEqual(2_000);
    });

    it("moves on at once instead of waiting when another step fits", async () => {
        const first = fakeModel("a", () => Promise.reject(GROQ_RATE));
        const second = fakeModel("b", async () => "b");
        const sleep = vi.fn(async () => undefined);
        await generate(routeMiddleware([step(first, "groq"), step(second, "openrouter")], { sleep }));
        expect(sleep).not.toHaveBeenCalled();
        expect(first.doGenerate).toHaveBeenCalledOnce();
    });

    it("gives up after its retries, with the provider's refusal", async () => {
        const model = fakeModel("a", () => Promise.reject(ANTHROPIC_OVERLOADED));
        const failure = await generate(routeMiddleware([step(model, "anthropic")], noWait)).catch(
            (error: unknown) => error
        );
        expect(failure).toBe(ANTHROPIC_OVERLOADED);
        expect(model.doGenerate).toHaveBeenCalledTimes(4);
    });

    it("does not wait longer than a chat can hold open", async () => {
        const later = refusal(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "600" });
        const model = fakeModel("a", () => Promise.reject(later));
        const sleep = vi.fn(async () => undefined);
        await generate(routeMiddleware([step(model, "groq")], { sleep })).catch(() => undefined);
        expect(sleep).not.toHaveBeenCalled();
    });

    it("doubles its wait, with a little jitter", () => {
        expect(backoffMs(1, null, () => 0)).toBe(1_000);
        expect(backoffMs(3, null, () => 0)).toBe(4_000);
        expect(backoffMs(10, null, () => 0)).toBe(20_000);
        expect(backoffMs(1, 7_000, () => 0)).toBe(7_000);
    });
});

describe("a key's own allowance", () => {
    it("steps over a key at its calls-a-minute limit to the next one", async () => {
        const first = fakeModel("a", async () => "first");
        const second = fakeModel("a", async () => "second");
        const middleware = () =>
            routeMiddleware(
                [
                    step(first, "groq", { keyId: "k1", limits: { requestsPerMinute: 1, concurrency: null } }),
                    step(second, "groq", { keyId: "k2" })
                ],
                noWait
            );
        expect(await generate(middleware())).toBe("first");
        expect(await generate(middleware())).toBe("second");
    });

    it("refuses at once on a key that spent its day, as a rate limit", async () => {
        const model = fakeModel("a", async () => "never");
        const failure = await generate(
            routeMiddleware([step(model, "groq", { keyId: "k1", spent: true })], noWait)
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(NoRouteError);
        expect(classifyProviderFailure(failure).kind).toBe("rate");
        expect(model.doGenerate).not.toHaveBeenCalled();
    });
});

describe("streams", () => {
    it("routes past a stream that fails before it says anything", async () => {
        const failing = fakeModel("a", async () =>
            streamOf([{ type: "stream-start", warnings: [] }, { type: "error", error: ANTHROPIC_OVERLOADED }])
        );
        const working = fakeModel("b", async () =>
            streamOf([
                { type: "stream-start", warnings: [] },
                { type: "text-delta", id: "1", delta: "hi" },
                { type: "finish", finishReason: "stop", usage: {} }
            ])
        );
        const result = (await stream(
            routeMiddleware([step(failing, "anthropic"), step(working, "openrouter")], noWait)
        )) as { stream: ReadableStream<unknown> };
        const parts = (await partsOf(result)) as Array<{ type: string }>;
        expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-delta", "finish"]);
    });

    it("hands a stream back whole once it has said something, and frees its slot at the end", async () => {
        const release = vi.fn();
        const held = await heldStream(
            streamOf([
                { type: "response-metadata" },
                { type: "text-delta", id: "1", delta: "a" },
                { type: "error", error: new Error("late") }
            ]) as never,
            release
        );
        const parts = (await partsOf(held as never)) as Array<{ type: string }>;
        expect(parts.map((part) => part.type)).toEqual(["response-metadata", "text-delta", "error"]);
        expect(release).toHaveBeenCalledOnce();
    });
});
