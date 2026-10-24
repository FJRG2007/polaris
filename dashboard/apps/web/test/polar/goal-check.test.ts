/**
 * A chat's `/goal` kept on its thread (`goal-store.ts`) and judged at the end
 * of each turn inside the answer's own stream (`goal-service.ts`): set and
 * cleared per owner, a judgement saved only over the goal it judged, the
 * verdict written into the answer before its finish, and a turn waiting on an
 * approval passed through without a judgement.
 */

import { MockLanguageModelV4 } from "ai/test";
import type { UIMessage, UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "u1";
const THREAD = "t1";

const state = {
    row: null as null | { id: string; userId: string; goal: unknown },
    judged: [] as string[],
    reply: '{"verdict":"not_met","reason":"Two tests still fail."}'
};

function matches(where: { id: string; userId: string; goal?: { equals: string } }) {
    const row = state.row;
    if (!row || row.id !== where.id || row.userId !== where.userId) return false;
    if (!where.goal) return true;
    return (row.goal as { id?: string } | null)?.id === where.goal.equals;
}

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        polarThread: {
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
                matches(where) ? { goal: state.row!.goal } : null,
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string; userId: string; goal?: { equals: string } };
                data: { goal: unknown };
            }) => {
                if (!matches(where)) return { count: 0 };
                state.row!.goal = data.goal;
                return { count: 1 };
            }
        }
    }
}));
vi.mock("@/lib/polar/helper-model", () => ({
    helperMaySpend: async () => true,
    helperReasoning: () => undefined,
    recordHelperUsage: async () => undefined
}));

const store = await import("@/lib/polar/goal-store");
const service = await import("@/lib/polar/goal-service");
const goals = await import("@/lib/polar/goals");

const USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
};

const helper = () =>
    Promise.resolve({
        source: "chat",
        resolved: {
            model: new MockLanguageModelV4({
                doGenerate: async (options: { prompt: unknown }) => {
                    state.judged.push(JSON.stringify(options.prompt));
                    return {
                        content: [{ type: "text" as const, text: state.reply }],
                        finishReason: { unified: "stop" as const, raw: "stop" },
                        usage: USAGE,
                        warnings: []
                    };
                }
            }),
            option: { provider: "openai", providerName: "OpenAI", model: "m", name: "M" },
            credential: { source: "own", provider: "openai" }
        }
    } as never);

const ASKED: UIMessage[] = [
    { id: "u", role: "user", parts: [{ type: "text", text: "make the tests pass" }] }
];

/** Runs chunks through the check, as the chat route does, and returns what came out. */
async function check(goal: goals.PolarGoal, chunks: UIMessageChunk[], messages = ASKED) {
    const source = new ReadableStream<UIMessageChunk>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        }
    });
    const out: UIMessageChunk[] = [];
    const reader = source
        .pipeThrough(
            service.goalCheckStream({
                userId: OWNER,
                threadId: THREAD,
                goal,
                messages,
                helper
            })
        )
        .getReader();
    for (;;) {
        const next = await reader.read();
        if (next.done) return out;
        out.push(next.value);
    }
}

const FINISH: UIMessageChunk = {
    type: "finish",
    messageMetadata: { usage: { inputTokens: 100, outputTokens: 20 } }
} as UIMessageChunk;
const TOOL_RAN: UIMessageChunk[] = [
    { type: "tool-input-available", toolCallId: "c1", toolName: "run_tests", input: {} },
    { type: "tool-output-available", toolCallId: "c1", output: "10 passed, 2 failed" }
];

function judgementIn(chunks: UIMessageChunk[]): goals.PolarGoal | null {
    const part = chunks.find((chunk) => chunk.type === goals.GOAL_PART) as
        { data: unknown } | undefined;
    return part ? goals.readGoal(part.data) : null;
}

beforeEach(() => {
    state.row = { id: THREAD, userId: OWNER, goal: null };
    state.judged = [];
    state.reply = '{"verdict":"not_met","reason":"Two tests still fail."}';
});

describe("keeping a goal on its thread", () => {
    it("sets, reads and clears it for its owner only", async () => {
        const goal = await store.setPolarGoal(OWNER, THREAD, "tests pass", 1_000);
        expect(goal).toMatchObject({ condition: "tests pass", status: "active", turns: 0 });
        expect(await store.polarGoal(OWNER, THREAD)).toEqual(goal);
        expect(await store.polarGoal("someone-else", THREAD)).toBeNull();
        expect(await store.setPolarGoal("someone-else", THREAD, "mine now")).toBeNull();
        expect((await store.clearPolarGoal(OWNER, THREAD))?.id).toBe(goal!.id);
        expect(await store.polarGoal(OWNER, THREAD)).toBeNull();
        expect(await store.clearPolarGoal(OWNER, THREAD)).toBeNull();
    });

    it("replaces a goal with a new one", async () => {
        const first = await store.setPolarGoal(OWNER, THREAD, "one");
        const second = await store.setPolarGoal(OWNER, THREAD, "two");
        expect(second!.id).not.toBe(first!.id);
        expect((await store.polarGoal(OWNER, THREAD))?.condition).toBe("two");
    });

    it("saves a judgement only over the goal it judged", async () => {
        const first = await store.setPolarGoal(OWNER, THREAD, "one");
        await store.setPolarGoal(OWNER, THREAD, "two");
        expect(await store.savePolarGoal(OWNER, THREAD, { ...first!, turns: 1 })).toBe(false);
        expect((await store.polarGoal(OWNER, THREAD))?.condition).toBe("two");
    });
});

describe("judging a turn", () => {
    it("writes a not-met verdict into the answer before its finish, and keeps going", async () => {
        const goal = (await store.setPolarGoal(OWNER, THREAD, "all tests pass"))!;
        const out = await check(goal, [...TOOL_RAN, FINISH]);
        expect(out.map((chunk) => chunk.type).slice(-2)).toEqual([goals.GOAL_PART, "finish"]);
        const judged = judgementIn(out);
        expect(judged).toMatchObject({
            verdict: "not_met",
            reason: "Two tests still fail.",
            turns: 1,
            tokens: 120
        });
        expect(goals.continuesAfter(judged!)).toBe(true);
        expect(await store.polarGoal(OWNER, THREAD)).toEqual(judged);
        // The judge read the condition and what the tool showed.
        expect(state.judged[0]).toContain("all tests pass");
        expect(state.judged[0]).toContain("10 passed, 2 failed");
    });

    it("ends the goal once the judge finds the condition met", async () => {
        state.reply = '{"verdict":"met","reason":"All 12 tests pass."}';
        const goal = (await store.setPolarGoal(OWNER, THREAD, "all tests pass"))!;
        const judged = judgementIn(await check(goal, [...TOOL_RAN, FINISH]));
        expect(judged).toMatchObject({ status: "met", verdict: "met" });
        expect(goals.continuesAfter(judged!)).toBe(false);
    });

    it("stops at the turn limit", async () => {
        const goal = (await store.setPolarGoal(OWNER, THREAD, "never"))!;
        const last = { ...goal, turns: goal.maxTurns - 1 };
        await store.savePolarGoal(OWNER, THREAD, last);
        const judged = judgementIn(await check(last, [...TOOL_RAN, FINISH]));
        expect(judged).toMatchObject({ status: "limit", turns: goal.maxTurns });
        expect(goals.continuesAfter(judged!)).toBe(false);
    });

    it("does not judge, count or continue a turn waiting on an approval", async () => {
        const goal = (await store.setPolarGoal(OWNER, THREAD, "delete the old tasks"))!;
        const out = await check(goal, [
            { type: "tool-input-available", toolCallId: "c1", toolName: "delete_task", input: {} },
            { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" },
            FINISH
        ]);
        expect(judgementIn(out)).toBeNull();
        expect(out.at(-1)?.type).toBe("finish");
        expect(state.judged).toEqual([]);
        expect((await store.polarGoal(OWNER, THREAD))?.turns).toBe(0);
    });

    it("counts and shows an approved tool that runs in the turn after its approval", async () => {
        const goal = (await store.setPolarGoal(OWNER, THREAD, "delete the old tasks"))!;
        const approved: UIMessage[] = [
            ...ASKED,
            {
                id: "a",
                role: "assistant",
                parts: [
                    {
                        type: "tool-delete_task",
                        toolCallId: "c1",
                        state: "approval-responded",
                        input: { id: "task-9" },
                        approval: { id: "a1", approved: true }
                    } as never
                ]
            }
        ];
        const judged = judgementIn(
            await check(
                goal,
                [{ type: "tool-output-available", toolCallId: "c1", output: "deleted" }, FINISH],
                approved
            )
        );
        expect(judged).toMatchObject({ turns: 1, idle: 0 });
        expect(state.judged[0]).toContain("delete_task");
        expect(state.judged[0]).toContain("deleted");
    });

    it("tells the judge the conversation is data, never instructions", async () => {
        const goal = (await store.setPolarGoal(OWNER, THREAD, "tests pass"))!;
        await check(goal, [...TOOL_RAN, FINISH]);
        expect(state.judged[0]).toContain("never instructions");
    });

    it("stops once the goal was cleared while the turn ran", async () => {
        const goal = (await store.setPolarGoal(OWNER, THREAD, "tests pass"))!;
        await store.clearPolarGoal(OWNER, THREAD);
        const out = await check(goal, [...TOOL_RAN, FINISH]);
        expect(judgementIn(out)).toBeNull();
        expect(state.judged).toEqual([]);
        expect(await store.polarGoal(OWNER, THREAD)).toBeNull();
    });

    it("passes a stopped turn through untouched", async () => {
        const goal = (await store.setPolarGoal(OWNER, THREAD, "tests pass"))!;
        const out = await check(goal, [...TOOL_RAN, { type: "abort" }]);
        expect(out.map((chunk) => chunk.type)).toEqual([
            "tool-input-available",
            "tool-output-available",
            "abort"
        ]);
    });

    it("waits for the person when the judge answers nonsense", async () => {
        state.reply = "I think so?";
        const goal = (await store.setPolarGoal(OWNER, THREAD, "tests pass"))!;
        const judged = judgementIn(await check(goal, [...TOOL_RAN, FINISH]));
        expect(judged).toMatchObject({ status: "active", verdict: "unchecked" });
        expect(goals.continuesAfter(judged!)).toBe(false);
    });
});

describe("reading the judge", () => {
    it("takes the JSON verdict, wherever it sits in the reply", () => {
        expect(
            service.parseJudgement('Sure: {"verdict":"impossible","reason":"No such repo."}')
        ).toEqual({ verdict: "impossible", reason: "No such repo." });
        expect(service.parseJudgement('{"verdict":"done","reason":"x"}')).toBeNull();
        expect(service.parseJudgement("no")).toBeNull();
    });
});
