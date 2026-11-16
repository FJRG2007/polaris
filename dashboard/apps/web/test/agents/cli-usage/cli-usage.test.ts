import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    getCatalogModel: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: { agentSession: { findUnique: db.findUnique, updateMany: db.updateMany } }
}));
vi.mock("@/lib/agents/model-catalog", () => ({ getCatalogModel: db.getCatalogModel }));

import {
    cliPriceSlugs,
    cliUsageCommand,
    parseUsageAnswer,
    readCliUsage,
    usageTotals,
    type UsageRow
} from "@/lib/agents/cli-usage";

const row = (overrides: Partial<UsageRow>): UsageRow => ({
    p: "openai",
    m: "gpt-5",
    f: 0,
    i: 0,
    o: 0,
    cr: 0,
    cw: 0,
    c: 0,
    n: 1,
    ...overrides
});

const answer = (rows: UsageRow[]) => `${JSON.stringify({ v: 1, rows })}\n`;

describe("parseUsageAnswer", () => {
    it("takes the program's line and refuses anything else", () => {
        expect(parseUsageAnswer(answer([row({ i: 5 })]))).toEqual([row({ i: 5 })]);
        expect(parseUsageAnswer("")).toBeNull();
        expect(parseUsageAnswer("{\"v\":2,\"rows\":[]}")).toBeNull();
        expect(parseUsageAnswer(answer([row({ i: -1 })]))).toBeNull();
        expect(parseUsageAnswer(answer([row({ m: "x".repeat(129) })]))).toBeNull();
        expect(parseUsageAnswer(answer(Array.from({ length: 65 }, () => row({}))))).toBeNull();
        expect(parseUsageAnswer("{\"v\":1,\"rows\":[{\"p\":\"a\"")).toBeNull();
    });
});

describe("cliPriceSlugs", () => {
    it("names the catalogue slugs a CLI's model may be under", () => {
        expect(cliPriceSlugs("openai", "gpt-5")).toEqual(["openai/gpt-5"]);
        expect(cliPriceSlugs("openrouter", "anthropic/claude-sonnet-4.5")).toEqual([
            "anthropic/claude-sonnet-4.5",
            "openrouter/anthropic/claude-sonnet-4.5"
        ]);
        expect(cliPriceSlugs("anthropic", "claude-sonnet-4-5-20250929")).toEqual([
            "anthropic/claude-sonnet-4-5-20250929",
            "anthropic/claude-sonnet-4-5"
        ]);
        expect(cliPriceSlugs("", "qwen3-coder-plus")).toEqual([]);
        expect(cliPriceSlugs("", "Tools/summaries")).toEqual([]);
        expect(cliPriceSlugs("openai", "unknown")).toEqual([]);
    });
});

describe("usageTotals", () => {
    it("takes a reported cost as it is and prices the rest from the catalogue", async () => {
        const totals = await usageTotals(
            [
                row({ f: 1, c: 0.5, i: 100, o: 10 }),
                row({ m: "gpt-5", i: 1_000_000, o: 1_000_000, cr: 1_000_000 }),
                row({ p: "", m: "mystery", i: 7, o: 3 })
            ],
            async (_provider, model) => (model === "gpt-5" ? { input: 1, output: 10 } : null)
        );
        expect(totals.tokensIn).toBe(2_000_107);
        expect(totals.tokensOut).toBe(1_000_013);
        // 0.5 reported + 1 (input) + 0.1 (cache read at a tenth) + 10 (output).
        expect(totals.costUsd).toBeCloseTo(11.6, 9);
    });

    it("says no cost when nothing was reported or priced, and keeps tokens within the column", async () => {
        const totals = await usageTotals([row({ i: 1e12, o: 1 })], async () => null);
        expect(totals).toEqual({ tokensIn: 2_000_000_000, tokensOut: 1, costUsd: null });
    });
});

describe("cliUsageCommand", () => {
    it("runs the reader with node, bounded, only for a CLI it reads", () => {
        const command = cliUsageCommand("opencode");
        expect(command).toContain("command -v node");
        expect(command).toContain("head -c 16000");
        expect(command).toMatch(/ 'opencode' 2>\/dev\/null/);
        expect(cliUsageCommand("claude")).toBeNull();
        expect(cliUsageCommand("cursor")).toBeNull();
    });
});

describe("readCliUsage", () => {
    const local = { cli: "opencode", place: "local", sharedHome: false };

    beforeEach(() => {
        db.findUnique.mockReset();
        db.updateMany.mockReset().mockResolvedValue({ count: 1 });
        db.getCatalogModel.mockReset().mockResolvedValue({ costInput: 2, costOutput: 8 });
    });

    it("sets the session's totals as floors, never lowering what was counted", async () => {
        const run = vi.fn(async () => ({ code: 0, output: answer([row({ i: 1_000_000, o: 100_000 })]) }));
        expect(await readCliUsage("s1", run, { row: local })).toBe("read");
        expect(run).toHaveBeenCalledOnce();
        expect(db.getCatalogModel).toHaveBeenCalledWith("openai/gpt-5");
        const [, tokens, cost] = db.updateMany.mock.calls.map((call) => call[0]);
        expect(tokens).toEqual({
            where: { id: "s1", tokensIn: { lte: 1_000_000 }, tokensOut: { lte: 100_000 } },
            data: { tokensIn: 1_000_000, tokensOut: 100_000 }
        });
        expect(cost.data.costUsd).toBeCloseTo(2.8, 9);
        expect(cost.where.OR).toEqual([{ costUsd: null }, { costUsd: { lte: cost.data.costUsd } }]);
    });

    it("reads only a session pool home that is the session's own", async () => {
        const run = vi.fn();
        expect(await readCliUsage("s1", run, { row: { ...local, place: "host" } })).toBe("skipped");
        expect(await readCliUsage("s1", run, { row: { ...local, sharedHome: true } })).toBe("skipped");
        expect(await readCliUsage("s1", run, { row: { ...local, cli: "claude" } })).toBe("skipped");
        expect(run).not.toHaveBeenCalled();
    });

    it("waits out the debounce unless it is the last read", async () => {
        db.updateMany.mockResolvedValueOnce({ count: 0 });
        const run = vi.fn(async () => ({ code: 0, output: answer([]) }));
        expect(await readCliUsage("s1", run, { row: local })).toBe("skipped");
        expect(run).not.toHaveBeenCalled();
        expect(await readCliUsage("s1", run, { row: local, final: true })).toBe("read");
        expect(db.updateMany.mock.calls[1]![0].where).toEqual({ id: "s1" });
    });

    it("writes nothing from an answer that is not one", async () => {
        const run = vi.fn(async () => ({ code: 0, output: "node: not found" }));
        expect(await readCliUsage("s1", run, { row: local })).toBe("unavailable");
        expect(db.updateMany).toHaveBeenCalledTimes(1);
    });

    it("looks the session up when the caller has not", async () => {
        db.findUnique.mockResolvedValue(null);
        expect(await readCliUsage("gone", vi.fn())).toBe("skipped");
    });
});
