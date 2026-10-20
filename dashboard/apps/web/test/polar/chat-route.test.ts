/**
 * POST /api/polar/chat: who may talk to Polar, what a request has to look like,
 * and what happens when the model reaches for a tool that changes something.
 *
 * The model is the AI SDK's own mock, streaming real parts through the real
 * `streamText`, so the approval a write tool waits for is the SDK's, not a
 * stand-in for it.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { MockLanguageModelV4 } from "ai/test";
import { tool, type LanguageModelV4StreamPart, type UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Ada",
    isAdmin: false,
    viewingAs: null
};
const THREAD = "22222222-2222-4222-8222-222222222222";

const state = {
    user: USER as typeof USER | { viewingAs: string } | "anonymous",
    limited: false,
    resolved: "ok" as "ok" | "no_key" | "unknown_model" | "retired-then-ok",
    owned: true,
    parts: [] as LanguageModelV4StreamPart[],
    executed: [] as string[],
    saved: [] as unknown[],
    titled: [] as unknown[][],
    resolveCalls: 0,
    ensured: [] as unknown[][],
    signals: [] as unknown[],
    source: "own" as "own" | "instance",
    hit: null as null | { used: number; amount: number; period: string },
    recorded: [] as unknown[]
};

vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/polar/usage", () => ({
    answerUsage: (usage?: { inputTokens?: number; outputTokens?: number }) => ({
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: null
    }),
    polarLimitReached: async () => state.hit,
    recordPolarUsage: async (entry: unknown) => void state.recorded.push(entry)
}));

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.user === "anonymous"
            ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
            : { ...USER, ...(state.user as object) }
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !state.limited }) }));
vi.mock("@/lib/polar/attachments", () => ({
    inlinePolarFiles: async (_user: string, messages: unknown) => messages
}));
vi.mock("@/lib/polar/memory", () => ({
    MEMORY_APPROVAL: { polar_remember: "user-approval" },
    polarMemoryEnabled: async () => true,
    polarMemoryPrompt: async () => "",
    polarMemoryTools: () => ({})
}));
vi.mock("@/lib/polar/threads", () => ({
    ensurePolarThread: async (...args: unknown[]) => {
        state.ensured.push(args);
        return state.owned ? { temporary: false } : null;
    },
    polarThreadInstructions: async () => null,
    savePolarMessages: async (...args: unknown[]) => void state.saved.push(args)
}));
vi.mock("@/lib/polar/titles", () => ({
    startPolarTitle: (...args: unknown[]) => void state.titled.push(args)
}));

/** The first step streams `state.parts`; any step after a tool ran just answers. */
function model() {
    let step = 0;
    return new MockLanguageModelV4({
        doStream: async () => ({
            stream: new ReadableStream({
                start(controller) {
                    for (const part of step++ === 0 ? state.parts : says("Here you go."))
                        controller.enqueue(part);
                    controller.close();
                }
            })
        })
    });
}

const OPTION = {
    provider: "anthropic",
    providerName: "Anthropic",
    model: "m-1",
    name: "M 1",
    reasoning: false
};

vi.mock("@/lib/polar/models", () => ({
    polarModelOptions: async () => [
        { provider: "anthropic", models: [{ provider: "anthropic", model: "m-1" }] }
    ],
    reasoningFor: () => undefined,
    resolvePolarModel: async (_user: string, choice: { model: string }, signals?: unknown) => {
        state.resolveCalls++;
        state.signals.push(signals);
        if (state.resolved === "no_key") return "no_key";
        if (state.resolved === "unknown_model") return "unknown_model";
        if (state.resolved === "retired-then-ok" && choice.model === "retired")
            return "unknown_model";
        return { model: model(), option: OPTION, credential: { source: state.source } };
    }
}));

vi.mock("@/lib/polar/tools", () => ({
    polarTools: async () => ({
        tools: {
            read_tasks: tool({
                description: "Lists tasks",
                inputSchema: z.object({}),
                execute: async () => {
                    state.executed.push("read_tasks");
                    return { ok: true, text: "none" };
                }
            }),
            delete_task: tool({
                description: "Deletes a task",
                inputSchema: z.object({ id: z.string() }),
                execute: async () => {
                    state.executed.push("delete_task");
                    return { ok: true, text: "deleted" };
                }
            })
        },
        approval: { delete_task: "user-approval" },
        described: {}
    })
}));

const route = await import("../../src/app/api/polar/chat/route");

const USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
};

function says(text: string): LanguageModelV4StreamPart[] {
    return [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } }
    ];
}

function calls(toolName: string, input: object): LanguageModelV4StreamPart[] {
    return [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
        { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } }
    ];
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        threadId: THREAD,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Tidy my tasks" }] }],
        choice: {
            kind: "language",
            provider: "anthropic",
            model: "m-1",
            intelligence: "balanced",
            payer: null
        },
        context: { route: "/tasks", title: "Tasks" },
        ...overrides
    };
}

function post(payload: unknown): Promise<Response> {
    return route.POST(
        new Request("https://polaris.test/api/polar/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: typeof payload === "string" ? payload : JSON.stringify(payload)
        })
    );
}

beforeEach(() => {
    state.user = USER;
    state.limited = false;
    state.resolved = "ok";
    state.source = "own";
    state.hit = null;
    state.recorded = [];
    state.owned = true;
    state.parts = says("Done.");
    state.executed = [];
    state.saved = [];
    state.titled = [];
    state.resolveCalls = 0;
    state.ensured = [];
    state.signals = [];
});

describe("who may talk to Polar", () => {
    it("turns away a request with no session", async () => {
        state.user = "anonymous";
        expect((await post(body())).status).toBe(401);
    });

    it("refuses an administrator viewing as somebody else", async () => {
        state.user = { viewingAs: "someone-else" };
        const answer = await post(body());
        expect(answer.status).toBe(403);
        expect(await answer.json()).toEqual({ error: "view_as" });
    });

    it("slows down a person sending too fast", async () => {
        state.limited = true;
        expect((await post(body())).status).toBe(429);
    });

    it("answers a thread that belongs to somebody else as not found", async () => {
        state.owned = false;
        expect((await post(body())).status).toBe(404);
    });
});

describe("what a request has to look like", () => {
    it.each([
        ["not JSON", "{"],
        ["a thread id that is not a uuid", body({ threadId: "abc" })],
        ["no messages", body({ messages: [] })],
        ["a message that is not a UI message", body({ messages: [{ hello: "world" }] })],
        ["a page route with a query string", body({ context: { route: "/tasks?token=x" } })],
        [
            "an unknown intelligence",
            body({ choice: { provider: "anthropic", model: "m-1", intelligence: "huge" } })
        ]
    ])("refuses %s", async (_name, payload) => {
        const answer = await post(payload);
        expect(answer.status).toBe(400);
        expect(state.resolveCalls).toBe(0);
    });

    it("says so when there is no key to spend", async () => {
        state.resolved = "no_key";
        const answer = await post(body());
        expect(answer.status).toBe(409);
        expect(await answer.json()).toEqual({ error: "no_key" });
    });

    it("answers with the first available model when the chosen one was retired", async () => {
        state.resolved = "retired-then-ok";
        const answer = await post(
            body({
                choice: {
                    provider: "anthropic",
                    model: "retired",
                    intelligence: "balanced",
                    payer: null
                }
            })
        );
        expect(answer.status).toBe(200);
        const text = await answer.text();
        expect(text).toContain('"fellBackFrom":"retired"');
    });

    it("keeps the thread's model for a command's turn, and stores it otherwise", async () => {
        await (await post(body({ remember: false }))).text();
        expect(state.ensured[0]?.[3]).toBeNull();
        await (await post(body())).text();
        expect(state.ensured[1]?.[3]).toMatchObject({ provider: "anthropic", model: "m-1" });
    });

    it("hands the model resolver what the turn carries, for Automatic", async () => {
        await (await post(body())).text();
        expect(state.signals[0]).toEqual({
            files: 0,
            tools: false,
            contextChars: "Tidy my tasks".length,
            lastChars: "Tidy my tasks".length
        });
    });

    it("refuses a turn on the shared key past an administrator's ceiling", async () => {
        state.source = "instance";
        state.hit = { used: 120, amount: 100, period: "day" };
        const answer = await post(body());
        expect(answer.status).toBe(429);
        expect(await answer.json()).toEqual({
            error: "usage_limit",
            used: 120,
            amount: 100,
            period: "day"
        });
    });

    it("never caps a person's own key", async () => {
        state.hit = { used: 120, amount: 100, period: "day" };
        const answer = await post(body());
        expect(answer.status).toBe(200);
    });

    it("puts what the answer spent on it and in the ledger", async () => {
        const answer = await post(body());
        const text = await answer.text();
        expect(text).toMatch(/"usage":\{"inputTokens":\d+,"outputTokens":\d+/);
        await vi.waitFor(() => expect(state.recorded).toHaveLength(1));
        expect(state.recorded[0]).toMatchObject({ payer: "own", threadId: THREAD });
    });

    it("streams an answer and saves the turn", async () => {
        const answer = await post(body());
        expect(answer.status).toBe(200);
        const text = await answer.text();
        expect(text).toContain("Done.");
        // How long the turn worked, for the line its steps fold into.
        expect(text).toMatch(/"workedMs":\d+/);
        expect(state.saved).toHaveLength(1);
    });

    it("asks for the thread's title once the reply has finished, not before", async () => {
        const answer = await post(body());
        expect(state.titled).toHaveLength(0);
        expect(await answer.text()).toContain("Done.");
        expect(state.titled).toHaveLength(1);
        const [userId, threadId, , finished] = state.titled[0] as [
            string,
            string,
            unknown,
            UIMessage[]
        ];
        expect([userId, threadId]).toEqual([USER.id, THREAD]);
        expect(finished.map((message) => message.role)).toEqual(["user", "assistant"]);
    });
});

describe("tools", () => {
    it("runs a read tool without asking", async () => {
        state.parts = calls("read_tasks", {});
        const text = await (await post(body())).text();
        expect(state.executed).toEqual(["read_tasks"]);
        expect(text).not.toContain("tool-approval-request");
        expect(text).toContain("Here you go.");
    });

    it("stops a write tool at an approval and does not run it", async () => {
        state.parts = calls("delete_task", { id: "ENG-1" });
        const text = await (await post(body())).text();
        expect(text).toContain("tool-approval-request");
        expect(state.executed).toEqual([]);
    });
});
