/**
 * Polar's spend: a cost only where the catalogue has both prices, and the
 * administrator's token ceilings stop the shared key for the people they name.
 * An answer's tool calls are counted per tool, and the month sums them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    rules: [] as {
        subjectType: string;
        subjectId: string;
        metric: string;
        period: string;
        amount: number;
    }[],
    spent: 0,
    audioSeconds: 0,
    roles: [] as string[],
    where: null as unknown,
    toolRows: [] as unknown[],
    toolGroups: [] as { tool: string; _sum: { calls: number | null } }[],
    groups: [] as unknown[][],
    threads: [] as { threadId: string }[]
};

vi.mock("@polaris/db", () => ({
    prisma: {
        agentUsageLimit: { findMany: async () => state.rules },
        userRole: { findMany: async () => state.roles.map((roleId) => ({ roleId })) },
        groupMember: { findMany: async () => [] },
        polarToolUse: {
            createMany: async ({ data }: { data: unknown[] }) => {
                state.toolRows.push(...data);
                return { count: data.length };
            },
            groupBy: async () => state.toolGroups
        },
        polarUsage: {
            groupBy: async ({ by }: { by: string[] }) =>
                by[0] === "threadId" ? state.threads : (state.groups.shift() ?? []),
            aggregate: async ({ where }: { where: unknown }) => {
                state.where = where;
                return {
                    _sum: {
                        inputTokens: state.spent,
                        outputTokens: 0,
                        audioSeconds: state.audioSeconds
                    }
                };
            }
        }
    }
}));

const {
    answerUsage,
    monthStart,
    toolCallCounts,
    polarMonthUsage,
    polarLimitReached,
    recordPolarToolUse,
    AUDIO_TOKENS_PER_SECOND
} = await import("@/lib/polar/usage");

beforeEach(() => {
    state.rules = [];
    state.spent = 0;
    state.audioSeconds = 0;
    state.roles = [];
    state.where = null;
    state.toolRows = [];
    state.toolGroups = [];
    state.groups = [];
    state.threads = [];
});

describe("toolCallCounts", () => {
    it("counts each tool an answer called, a connector's tool by its own name", () => {
        expect(
            toolCallCounts([
                { type: "text", text: "Looking." },
                { type: "tool-web_search", state: "output-available" },
                { type: "tool-web_search", state: "output-available" },
                { type: "dynamic-tool", toolName: "github__list_issues", state: "output-error" },
                { type: "reasoning", text: "..." }
            ])
        ).toEqual([
            { tool: "web_search", calls: 2 },
            { tool: "github__list_issues", calls: 1 }
        ]);
    });

    it("is empty for an answer with no tool calls", () => {
        expect(toolCallCounts([{ type: "text", text: "Hi" }])).toEqual([]);
    });
});

describe("recordPolarToolUse", () => {
    it("writes one row per tool, and nothing for an answer that called none", async () => {
        await recordPolarToolUse({ userId: "u-1", threadId: "t-1", parts: [{ type: "text", text: "Hi" }] });
        expect(state.toolRows).toEqual([]);
        await recordPolarToolUse({
            userId: "u-1",
            threadId: "t-1",
            parts: [{ type: "tool-read_file" }, { type: "tool-read_file" }]
        });
        expect(state.toolRows).toEqual([{ userId: "u-1", threadId: "t-1", tool: "read_file", calls: 2 }]);
    });
});

describe("polarMonthUsage", () => {
    it("names the month's tools by their summed calls and counts the chats that spent", async () => {
        state.groups = [
            [
                {
                    provider: "openai",
                    model: "gpt-x",
                    payer: "own",
                    _count: { _all: 3 },
                    _sum: { inputTokens: 30, outputTokens: 6, costUsd: 0.01 }
                }
            ],
            []
        ];
        state.toolGroups = [
            { tool: "web_search", _sum: { calls: 7 } },
            { tool: "read_file", _sum: { calls: null } }
        ];
        state.threads = [{ threadId: "t-1" }, { threadId: "t-2" }];
        const usage = await polarMonthUsage("u-1", new Date("2026-11-16T10:00:00Z"));
        expect(usage.tools).toEqual([
            { tool: "web_search", calls: 7 },
            { tool: "read_file", calls: 0 }
        ]);
        expect(usage.chats).toBe(2);
        expect(usage.models).toHaveLength(1);
    });
});

describe("answerUsage", () => {
    it("prices tokens per million from the catalogue", () => {
        expect(
            answerUsage(
                { inputTokens: 1_000_000, outputTokens: 500_000 },
                { costInput: 3, costOutput: 15 }
            )
        ).toEqual({ inputTokens: 1_000_000, outputTokens: 500_000, costUsd: 10.5 });
    });

    it("keeps the cached and reasoning counts only when the provider reports them", () => {
        const spent = answerUsage(
            {
                inputTokens: 1000,
                outputTokens: 400,
                inputTokenDetails: {
                    noCacheTokens: 200,
                    cacheReadTokens: 800,
                    cacheWriteTokens: 0
                },
                outputTokenDetails: { textTokens: 100, reasoningTokens: 300 }
            },
            { costInput: null, costOutput: null }
        );
        expect(spent).toMatchObject({ cachedTokens: 800, reasoningTokens: 300 });
        const plain = answerUsage(
            {
                inputTokens: 10,
                outputTokens: 5,
                inputTokenDetails: {
                    noCacheTokens: undefined,
                    cacheReadTokens: undefined,
                    cacheWriteTokens: undefined
                },
                outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }
            },
            { costInput: null, costOutput: null }
        );
        expect(plain).not.toHaveProperty("cachedTokens");
        expect(plain).not.toHaveProperty("reasoningTokens");
    });

    it("gives no cost when a price is missing, and counts nothing as zero", () => {
        expect(
            answerUsage({ inputTokens: 10, outputTokens: 5 }, { costInput: 3, costOutput: null })
                .costUsd
        ).toBeNull();
        expect(answerUsage(undefined, { costInput: null, costOutput: null })).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            costUsd: null
        });
    });
});

describe("monthStart", () => {
    it("is the first of the month in UTC", () => {
        expect(monthStart(new Date("2026-10-20T15:00:00Z")).toISOString()).toBe(
            "2026-10-01T00:00:00.000Z"
        );
    });
});

describe("polarLimitReached", () => {
    it("lets everyone through when there are no token rules", async () => {
        expect(await polarLimitReached("u1")).toBeNull();
    });

    it("stops a person at a rule on their role, counting only the shared key", async () => {
        state.rules = [
            { subjectType: "role", subjectId: "r1", metric: "tokens", period: "day", amount: 100 }
        ];
        state.roles = ["r1"];
        state.spent = 100;
        expect(await polarLimitReached("u1")).toEqual({ used: 100, amount: 100, period: "day" });
        expect(state.where).toMatchObject({ userId: "u1", payer: "instance" });
    });

    it("ignores rules about somebody else and spend under the ceiling", async () => {
        state.rules = [
            { subjectType: "user", subjectId: "u2", metric: "tokens", period: "day", amount: 1 },
            {
                subjectType: "everyone",
                subjectId: "",
                metric: "tokens",
                period: "month",
                amount: 1000
            }
        ];
        state.spent = 999;
        expect(await polarLimitReached("u1")).toBeNull();
    });

    it("counts transcribed audio toward the token ceiling", async () => {
        state.rules = [
            {
                subjectType: "everyone",
                subjectId: "",
                metric: "tokens",
                period: "day",
                amount: 3200
            }
        ];
        state.audioSeconds = 100;
        expect(AUDIO_TOKENS_PER_SECOND).toBe(32);
        expect(await polarLimitReached("u1")).toEqual({ used: 3200, amount: 3200, period: "day" });
        state.audioSeconds = 99;
        expect(await polarLimitReached("u1")).toBeNull();
    });
});
