/**
 * An answer a provider stops in the middle of is carried on by the next step,
 * the way free-claude-code does it: the next model sees what was written as
 * its own reply and is asked to continue, and what it repeats of that is cut
 * off before the reader sees it. A tool call that had started, a structured
 * answer and a refusal of the call itself are not carried on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({
    prisma: { userModelKey: { updateMany: vi.fn(async () => ({ count: 1 })) } }
}));

const { routeMiddleware } = await import("@/lib/polar/router/chain");
const { continuationSuffix, continuationParams, continuable, withoutOverlap } = await import(
    "@/lib/polar/router/continuation"
);
const { resetRouteHealth } = await import("@/lib/polar/router/health");
const { resetKeyAdmission } = await import("@/lib/polar/router/limits");

beforeEach(() => {
    resetRouteHealth();
    resetKeyAdmission();
});

const DOWN = Object.assign(new Error("refused"), {
    statusCode: 503,
    responseBody: JSON.stringify({ error: { message: "upstream unavailable" } })
});
const DROPPED = new TypeError("terminated");
const CONTENT = Object.assign(new Error("refused"), {
    statusCode: 400,
    responseBody: JSON.stringify({ error: { message: "content policy" } })
});

/** A stream that sends `parts`, then fails with `error`. */
function breaking(parts: unknown[], error: unknown) {
    return {
        stream: new ReadableStream({
            start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.enqueue({ type: "error", error });
                controller.close();
            }
        })
    };
}

function whole(parts: unknown[]) {
    return {
        stream: new ReadableStream({
            start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.close();
            }
        })
    };
}

const text = (id: string, ...deltas: string[]) => [
    { type: "text-start", id },
    ...deltas.map((delta) => ({ type: "text-delta", id, delta }))
];
const FINISH = { type: "finish", finishReason: "stop", usage: {} };

function model(modelId: string, answer: (options: { prompt: unknown[] }) => unknown) {
    return {
        specificationVersion: "v4",
        provider: "test.chat",
        modelId,
        supportedUrls: {},
        doGenerate: vi.fn(),
        doStream: vi.fn(async (options: { prompt: unknown[] }) => answer(options))
    };
}

const step = (fake: ReturnType<typeof model>, provider: string, keyId: string) => ({
    model: () => fake as never,
    modelId: fake.modelId,
    provider,
    keyId,
    free: false,
    reasoning: false,
    coolingUntil: null,
    coolingReason: null,
    routeReasoning: "inherit" as const
});

const PROMPT = [{ role: "user", content: [{ type: "text", text: "Write a haiku" }] }];

async function read(middleware: ReturnType<typeof routeMiddleware>, extra: object = {}) {
    const result = (await middleware.wrapStream!({
        doGenerate: vi.fn(),
        doStream: vi.fn(),
        params: { prompt: PROMPT, ...extra } as never,
        model: {} as never
    })) as { stream: ReadableStream<{ type: string; delta?: string; id?: string; error?: unknown }> };
    const parts: Array<{ type: string; delta?: string; id?: string; error?: unknown }> = [];
    const reader = result.stream.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parts.push(value);
        }
    } catch (error) {
        parts.push({ type: "thrown", error });
    }
    return parts;
}

const written = (parts: Array<{ type: string; delta?: string }>) =>
    parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");

describe("an answer cut off halfway", () => {
    it("is carried on by the next step, which sees what was written", async () => {
        const first = model("a", () => breaking(text("t1", "Old pond, "), DOWN));
        const second = model("b", () => whole([...text("t2", "frog jumps in."), { type: "text-end", id: "t2" }, FINISH]));
        const parts = await read(routeMiddleware([step(first, "groq", "k1"), step(second, "openai", "k2")]));

        expect(written(parts)).toBe("Old pond, frog jumps in.");
        expect(parts.some((part) => part.type === "thrown" || part.type === "error")).toBe(false);
        // The broken block is closed before the next one opens.
        const ends = parts.findIndex((part) => part.type === "text-end" && part.id === "t1");
        const starts = parts.findIndex((part) => part.type === "text-start" && part.id === "t2");
        expect(ends).toBeGreaterThan(-1);
        expect(ends).toBeLessThan(starts);
        const prompt = second.doStream.mock.calls[0]![0].prompt as Array<{ role: string; content: Array<{ text: string }> }>;
        expect(prompt.at(-2)).toEqual({ role: "assistant", content: [{ type: "text", text: "Old pond, " }] });
        expect(prompt.at(-1)!.role).toBe("user");
        expect(prompt.at(-1)!.content[0]!.text).toContain("Continue the assistant response exactly");
    });

    it("cuts off what the next model repeats", async () => {
        const first = model("a", () => breaking(text("t1", "Old pond, a frog"), DOWN));
        const second = model("b", () => whole([...text("t2", "a frog", " jumps in."), FINISH]));
        const parts = await read(routeMiddleware([step(first, "groq", "k1"), step(second, "openai", "k2")]));
        expect(written(parts)).toBe("Old pond, a frog jumps in.");
    });

    it("asks the same step again after a dropped connection when it is the only one", async () => {
        let calls = 0;
        const only = model("a", () => {
            calls++;
            return calls === 1
                ? breaking(text("t1", "Old pond, "), DROPPED)
                : whole([...text("t2", "frog jumps in."), FINISH]);
        });
        const parts = await read(routeMiddleware([step(only, "groq", "k1")]));
        expect(written(parts)).toBe("Old pond, frog jumps in.");
    });

    it("ends on the error when the call itself was refused", async () => {
        const first = model("a", () => breaking(text("t1", "Old pond, "), CONTENT));
        const second = model("b", () => whole([...text("t2", "frog"), FINISH]));
        const parts = await read(routeMiddleware([step(first, "groq", "k1"), step(second, "openai", "k2")]));
        expect(["error", "thrown"]).toContain(parts.at(-1)?.type);
        expect(second.doStream).not.toHaveBeenCalled();
    });

    it("ends on the error once a tool call has started", async () => {
        const first = model("a", () =>
            breaking([...text("t1", "Let me look."), { type: "tool-input-start", id: "c1", toolName: "search" }], DOWN)
        );
        const second = model("b", () => whole([...text("t2", "frog"), FINISH]));
        const parts = await read(routeMiddleware([step(first, "groq", "k1"), step(second, "openai", "k2")]));
        expect(["error", "thrown"]).toContain(parts.at(-1)?.type);
        expect(second.doStream).not.toHaveBeenCalled();
    });

    it("does not continue a structured answer", async () => {
        const first = model("a", () => breaking(text("t1", "{\"a\":"), DOWN));
        const second = model("b", () => whole([...text("t2", "1}"), FINISH]));
        const parts = await read(routeMiddleware([step(first, "groq", "k1"), step(second, "openai", "k2")]), {
            responseFormat: { type: "json" }
        });
        expect(["error", "thrown"]).toContain(parts.at(-1)?.type);
    });

    it("stops after a bounded number of continuations", async () => {
        const flaky = model("a", () => breaking(text("t", "x"), DROPPED));
        const parts = await read(routeMiddleware([step(flaky, "groq", "k1")]));
        expect(["error", "thrown"]).toContain(parts.at(-1)?.type);
        // The first stream, then at most two continuations.
        expect(flaky.doStream.mock.calls.length).toBeLessThanOrEqual(3);
    });
});

describe("the continuation helpers", () => {
    it("keep only what is new after the written text", () => {
        expect(continuationSuffix("Old pond, a frog", "Old pond, a frog jumps")).toBe(" jumps");
        expect(continuationSuffix("Old pond, a frog", "a frog jumps")).toBe(" jumps");
        expect(continuationSuffix("Old pond", "splash")).toBe("splash");
        expect(continuationSuffix("", "splash")).toBe("splash");
    });

    it("say which failures are worth carrying on from", () => {
        expect(continuable(DOWN)).toBe(true);
        expect(continuable(DROPPED)).toBe(true);
        expect(continuable(CONTENT)).toBe(false);
    });

    it("add the written text and the instruction, mentioning tools only when there are some", () => {
        const plain = continuationParams({ prompt: PROMPT } as never, "Old pond");
        const last = plain.prompt.at(-1) as { content: Array<{ text: string }> };
        expect(last.content[0]!.text).not.toContain("tool calls");
        const tooled = continuationParams({ prompt: PROMPT, tools: [{ type: "function", name: "x" }] } as never, "Old pond");
        expect((tooled.prompt.at(-1) as { content: Array<{ text: string }> }).content[0]!.text).toContain("tool calls");
    });

    it("drop a second stream-start and pass everything else", async () => {
        const out = withoutOverlap(
            whole([{ type: "stream-start", warnings: [] }, ...text("t", "new"), FINISH]).stream as ReadableStream<{ type: string }>,
            ""
        );
        const parts: Array<{ type: string }> = [];
        const reader = out.getReader();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parts.push(value);
        }
        expect(parts.map((part) => part.type)).toEqual(["text-start", "text-delta", "finish"]);
    });
});
