/**
 * Rate-limit counters are keyed per visitor IP, per link and per account, so
 * the table only stays bounded if counters whose window has run out are
 * deleted. These pin that a counter records when its window ends, that the
 * sweep removes exactly the ones past it, and that counters written before the
 * window end was recorded are aged out too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Counter {
    id: string;
    key: string;
    count: number;
    windowStart: Date;
    expiresAt: Date | null;
}

type Where = Record<string, unknown>;

const state = vi.hoisted(() => ({ rows: [] as Counter[], nextId: 0 }));

function matches(row: Counter, where: Where): boolean {
    return Object.entries(where).every(([field, condition]) => {
        if (field === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
        const value = row[field as keyof Counter];
        if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
            const ops = condition as { lt?: Date; in?: unknown[] };
            if (ops.lt) return value instanceof Date && value.getTime() < ops.lt.getTime();
            if (ops.in) return ops.in.includes(value);
            throw new Error("unsupported filter");
        }
        return (value ?? null) === condition;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        rateLimitCounter: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                state.rows.find((row) => row.key === where.key) ?? null,
            upsert: async ({
                where,
                create,
                update
            }: {
                where: { key: string };
                create: Omit<Counter, "id">;
                update: Partial<Counter>;
            }) => {
                const existing = state.rows.find((row) => row.key === where.key);
                if (existing) Object.assign(existing, update);
                else state.rows.push({ id: `c${state.nextId++}`, ...create });
            },
            update: async ({ where }: { where: { key: string } }) => {
                state.rows.find((row) => row.key === where.key)!.count++;
            },
            findMany: async ({ where, take }: { where: Where; take: number }) =>
                state.rows
                    .filter((row) => matches(row, where))
                    .slice(0, take)
                    .map(({ id }) => ({ id })),
            deleteMany: async ({ where }: { where: Where }) => {
                const before = state.rows.length;
                state.rows = state.rows.filter((row) => !matches(row, where));
                return { count: before - state.rows.length };
            }
        }
    }
}));

import { rateLimit, sweepRateLimits } from "@/lib/rate-limit-service";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function legacy(key: string, windowStart: Date): Counter {
    return { id: `c${state.nextId++}`, key, count: 1, windowStart, expiresAt: null };
}

beforeEach(() => {
    state.rows = [];
    state.nextId = 0;
});

describe("rate-limit counter sweep", () => {
    it("records when a new window runs out", async () => {
        const before = Date.now();
        await rateLimit("analytics:203.0.113.5", 10, 15 * MINUTE);
        const row = state.rows[0]!;
        expect(row.expiresAt!.getTime() - row.windowStart.getTime()).toBe(15 * MINUTE);
        expect(row.windowStart.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("deletes the counters past their window, and keeps the ones still counting", async () => {
        await rateLimit("analytics:203.0.113.5", 10, MINUTE);
        await rateLimit("unlock:link:198.51.100.7", 5, HOUR);
        const deleted = await sweepRateLimits(new Date(Date.now() + 2 * MINUTE));
        expect(deleted).toBe(1);
        expect(state.rows.map((row) => row.key)).toEqual(["unlock:link:198.51.100.7"]);
    });

    it("ages out counters written before their window end was recorded", async () => {
        const now = Date.now();
        state.rows.push(
            legacy("forms:203.0.113.9", new Date(now - 25 * HOUR)),
            legacy("signin:203.0.113.5", new Date(now - 30 * MINUTE))
        );
        expect(await sweepRateLimits(new Date(now))).toBe(1);
        expect(state.rows.map((row) => row.key)).toEqual(["signin:203.0.113.5"]);
    });

    it("starts a fresh window, with a fresh end, once the old one has run out", async () => {
        await rateLimit("mc-wake:install", 1, MINUTE);
        const first = state.rows[0]!.expiresAt!.getTime();
        state.rows[0]!.windowStart = new Date(Date.now() - 2 * MINUTE);
        expect((await rateLimit("mc-wake:install", 1, MINUTE)).ok).toBe(true);
        expect(state.rows).toHaveLength(1);
        expect(state.rows[0]!.expiresAt!.getTime()).toBeGreaterThanOrEqual(first);
    });
});
