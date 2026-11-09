/**
 * A session's usage, summed from its Claude Code transcript.
 *
 * What is pinned: a response written as several lines is counted once from its
 * last line, the response counted by the previous read is not counted again,
 * a synthetic or subagent-free line with no usage is ignored, the cost uses
 * the catalogue price with cache multipliers, and a write that lost a race to
 * another read adds nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    row: { usageMessageId: null as string | null, costUsd: null as number | null },
    updates: [] as Record<string, unknown>[],
    prices: {} as Record<string, { costInput: number; costOutput: number }>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findUnique: async () => state.row,
            updateMany: async (args: Record<string, unknown>) => {
                state.updates.push(args);
                return { count: 1 };
            }
        }
    }
}));
vi.mock("@/lib/agents/model-catalog", () => ({
    getCatalogModel: async (slug: string) => state.prices[slug] ?? null
}));

import {
    claudeLineUsage,
    foldTurns,
    priceSlugs,
    recordSessionUsage,
    turnCost,
    type TurnUsage
} from "@/lib/agents/session-usage";

const line = (id: string, usage: Record<string, number>, model = "claude-sonnet-4-5-20250929") =>
    JSON.stringify({ type: "assistant", uuid: `u-${id}`, message: { id, model, usage, content: [] } });

const turn = (messageId: string, over: Partial<TurnUsage> = {}): TurnUsage => ({
    messageId,
    model: "claude-sonnet-4-5",
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    ...over
});

beforeEach(() => {
    state.row = { usageMessageId: null, costUsd: null };
    state.updates = [];
    state.prices = {};
});

describe("claudeLineUsage", () => {
    it("reads an assistant line's usage", () => {
        expect(
            claudeLineUsage(
                line("m1", {
                    input_tokens: 3,
                    output_tokens: 40,
                    cache_read_input_tokens: 1000,
                    cache_creation_input_tokens: 200
                })
            )
        ).toEqual({
            messageId: "m1",
            model: "claude-sonnet-4-5-20250929",
            input: 3,
            output: 40,
            cacheRead: 1000,
            cacheWrite: 200
        });
    });

    it("ignores user lines, synthetic turns and garbage", () => {
        expect(claudeLineUsage(JSON.stringify({ type: "user", message: { content: "hi" } }))).toBeNull();
        expect(claudeLineUsage(line("m2", { input_tokens: 0, output_tokens: 0 }, "<synthetic>"))).toBeNull();
        expect(claudeLineUsage("not json")).toBeNull();
        expect(claudeLineUsage(JSON.stringify({ type: "assistant", message: { id: "x" } }))).toBeNull();
    });
});

describe("foldTurns", () => {
    it("counts each response once, from its last line", () => {
        const { turns, last } = foldTurns(
            [turn("a", { output: 1 }), turn("a", { output: 9 }), turn("b")],
            null
        );
        expect(turns.map((row) => [row.messageId, row.output])).toEqual([
            ["a", 9],
            ["b", 5]
        ]);
        expect(last).toBe("b");
    });

    it("leaves out the response the previous read counted", () => {
        const { turns, last } = foldTurns([turn("b"), turn("c")], "b");
        expect(turns.map((row) => row.messageId)).toEqual(["c"]);
        expect(last).toBe("c");
    });
});

describe("prices", () => {
    it("tries the dated name and then the undated one", () => {
        expect(priceSlugs("claude-sonnet-4-5-20250929")).toEqual([
            "anthropic/claude-sonnet-4-5-20250929",
            "anthropic/claude-sonnet-4-5"
        ]);
        expect(priceSlugs("")).toEqual([]);
    });

    it("prices cache writes at 1.25x and reads at 0.1x the input", () => {
        const cost = turnCost(turn("a", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }), {
            input: 3,
            output: 15
        });
        expect(cost).toBeCloseTo(3 + 3 * 1.25 + 3 * 0.1 + 15, 6);
    });
});

describe("recordSessionUsage", () => {
    it("adds the tokens and the cost, guarded on the id last counted", async () => {
        state.prices["anthropic/claude-sonnet-4-5"] = { costInput: 3, costOutput: 15 };
        state.row = { usageMessageId: "a", costUsd: 1 };
        await recordSessionUsage("s-1", [turn("a"), turn("b", { input: 1_000_000, output: 0 })]);
        expect(state.updates).toHaveLength(1);
        const update = state.updates[0] as { where: unknown; data: Record<string, unknown> };
        expect(update.where).toEqual({ id: "s-1", usageMessageId: "a" });
        expect(update.data.tokensIn).toEqual({ increment: 1_000_000 });
        expect(update.data.tokensOut).toEqual({ increment: 0 });
        expect(update.data.usageMessageId).toBe("b");
        expect(update.data.costUsd).toBeCloseTo(4, 6);
    });

    it("counts tokens but leaves the cost alone for an unpriced model", async () => {
        await recordSessionUsage("s-1", [turn("z", { model: "mystery" })]);
        const update = state.updates[0] as { data: Record<string, unknown> };
        expect(update.data.tokensIn).toEqual({ increment: 10 });
        expect("costUsd" in update.data).toBe(false);
    });

    it("writes nothing when only the counted response was read again", async () => {
        state.row = { usageMessageId: "a", costUsd: null };
        await recordSessionUsage("s-1", [turn("a")]);
        await recordSessionUsage("s-1", []);
        expect(state.updates).toHaveLength(0);
    });
});
