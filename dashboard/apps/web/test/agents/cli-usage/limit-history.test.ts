import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    create: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentLimitHit: { create: db.create, deleteMany: db.deleteMany, findMany: db.findMany },
        agentSession: { groupBy: db.groupBy }
    }
}));

import { codeUsageFor, monthStart, noteLimitHit } from "@/lib/agents/limit-history";

const NOW = Date.UTC(2026, 10, 17, 12);

beforeEach(() => {
    for (const fn of Object.values(db)) fn.mockReset().mockResolvedValue(undefined);
});

describe("noteLimitHit", () => {
    it("records the hit and clears everybody's hits older than 30 days", async () => {
        await noteLimitHit(
            { userId: "u1", sessionId: "s1", cli: "codex", accountId: "a1", resetAt: NOW + 60_000, outcome: "rotated" },
            NOW
        );
        expect(db.create.mock.calls[0]![0].data).toEqual({
            userId: "u1",
            sessionId: "s1",
            cli: "codex",
            accountId: "a1",
            resetAt: new Date(NOW + 60_000),
            outcome: "rotated"
        });
        expect(db.deleteMany).toHaveBeenCalledWith({
            where: { createdAt: { lt: new Date(NOW - 30 * 86_400_000) } }
        });
    });

    it("never throws when the write fails", async () => {
        db.create.mockRejectedValue(new Error("down"));
        db.deleteMany.mockRejectedValue(new Error("down"));
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(
            noteLimitHit({ userId: "u1", sessionId: "s1", cli: "claude", accountId: null, resetAt: null, outcome: "waiting" })
        ).resolves.toBeUndefined();
        quiet.mockRestore();
    });
});

describe("codeUsageFor", () => {
    it("sums this month's sessions per agent, most spent first, and lists the last 14 days of hits", async () => {
        db.groupBy.mockResolvedValue([
            { cli: "opencode", _count: { _all: 2 }, _sum: { tokensIn: 100, tokensOut: 10, costUsd: null } },
            { cli: "codex", _count: { _all: 1 }, _sum: { tokensIn: 5, tokensOut: 5, costUsd: 1.5 } }
        ]);
        db.findMany.mockResolvedValue([
            { id: "h1", sessionId: "s1", cli: "codex", outcome: "waiting", resetAt: null, createdAt: new Date(NOW) }
        ]);
        const usage = await codeUsageFor("u1", new Date(NOW));
        expect(usage.byAgent.map((row) => row.cli)).toEqual(["codex", "opencode"]);
        expect(usage.byAgent[1]).toEqual({ cli: "opencode", sessions: 2, tokens: 110, costUsd: null });
        expect(usage.limits).toEqual([
            { id: "h1", sessionId: "s1", cli: "codex", outcome: "waiting", resetAt: null, at: new Date(NOW).toISOString() }
        ]);
        expect(db.groupBy.mock.calls[0]![0].where).toEqual({ startedById: "u1", createdAt: { gte: monthStart(new Date(NOW)) } });
        expect(db.findMany.mock.calls[0]![0]).toMatchObject({ take: 50, where: { createdAt: { gte: new Date(NOW - 14 * 86_400_000) } } });
    });
});
