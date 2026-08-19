/**
 * Deciding not to hear from somebody.
 *
 * The direction is the whole of it, and it is the thing that fails silently:
 * `blockedBy` answers "who has this reader shut out" and `blockersOf` answers
 * "who has shut this reader out", they are one column apart, and swapping them
 * breaks the feature in a way nothing on screen would show. Using the first
 * where the second was meant lets a blocked account go on ringing somebody's
 * telephone; using the second where the first was meant hides messages from
 * somebody who never blocked anybody. So both are asserted, in both directions,
 * rather than left to read correctly.
 *
 * The other rule with teeth is that a block is never announced. What is asserted
 * for that is the count on a search: somebody who has blocked the searcher must
 * not turn up in the "and some you may not write to" number, because a number is
 * an answer too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface BlockRow {
    blockerId: string;
    blockedId: string;
    createdAt: Date;
}

let blocks: BlockRow[] = [];

/** Ticks once per block set, so "newest first" has something to sort on: two
 *  rows written in the same millisecond would order arbitrarily and the
 *  assertion would pass or fail by luck. */
let clock = 0;

const accounts = [
    { id: "ada", name: "Ada Lovelace", email: "ada@example.com", username: "ada", bannedAt: null },
    {
        id: "grace",
        name: "Grace Hopper",
        email: "grace@example.com",
        username: "grace",
        bannedAt: null
    },
    {
        id: "alan",
        name: "Alan Turing",
        email: "alan@example.com",
        username: "alan",
        bannedAt: null
    }
];

/** The `in` of a where clause, whichever column it was written against. */
function within(clause: unknown): string[] | null {
    if (typeof clause !== "object" || clause === null) return null;
    const value = (clause as { in?: string[] }).in;
    return Array.isArray(value) ? value : null;
}

/** One `where` from `userBlock.findMany`, applied to the rows in memory. Only
 *  the three shapes the service actually writes: one column pinned and the other
 *  matched against a list, or the two of them under an OR. */
function matches(row: BlockRow, where: Record<string, unknown>): boolean {
    const clauses = Array.isArray(where.OR) ? (where.OR as Record<string, unknown>[]) : [where];
    return clauses.some((clause) => {
        if (typeof clause.blockerId === "string" && clause.blockerId !== row.blockerId)
            return false;
        if (typeof clause.blockedId === "string" && clause.blockedId !== row.blockedId)
            return false;
        const blockers = within(clause.blockerId);
        if (blockers && !blockers.includes(row.blockerId)) return false;
        const blocked = within(clause.blockedId);
        if (blocked && !blocked.includes(row.blockedId)) return false;
        return true;
    });
}

vi.mock("@/lib/rich-text/mention-service", () => ({
    like: (term: string) => ({ contains: term })
}));

vi.mock("@/lib/privacy-service", () => ({
    discoverableBy: async (_viewer: { id: string }, userIds: readonly string[]) => new Set(userIds)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                accounts.find((person) => person.id === where.id) ?? null,
            findMany: async ({ where }: { where: Record<string, unknown> }) => {
                const not = (where.id as { not?: string } | undefined)?.not;
                const term = (
                    (where.OR as { name?: { contains: string } }[] | undefined)?.[0]?.name
                        ?.contains ?? ""
                ).toLowerCase();
                return accounts.filter((person) => {
                    if (person.id === not) return false;
                    if (!term) return true;
                    return [person.name, person.email, person.username].some((field) =>
                        field.toLowerCase().includes(term)
                    );
                });
            }
        },
        userBlock: {
            count: async ({ where }: { where: { blockerId: string } }) =>
                blocks.filter((row) => row.blockerId === where.blockerId).length,
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                blocks.find((row) => matches(row, where)) ?? null,
            findMany: async ({
                where,
                orderBy
            }: {
                where: Record<string, unknown>;
                orderBy?: { createdAt?: "asc" | "desc" };
            }) => {
                const found = blocks
                    .filter((row) => matches(row, where))
                    .map((row) => ({
                        ...row,
                        blocked: accounts.find((person) => person.id === row.blockedId)
                    }));
                if (orderBy?.createdAt === "desc") {
                    found.sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
                }
                return found;
            },
            upsert: async ({
                where
            }: {
                where: { blockerId_blockedId: { blockerId: string; blockedId: string } };
            }) => {
                const pair = where.blockerId_blockedId;
                const held = blocks.find(
                    (row) => row.blockerId === pair.blockerId && row.blockedId === pair.blockedId
                );
                if (!held) blocks.push({ ...pair, createdAt: new Date(++clock) });
                return pair;
            },
            deleteMany: async ({ where }: { where: { blockerId: string; blockedId: string } }) => {
                const before = blocks.length;
                blocks = blocks.filter(
                    (row) =>
                        !(row.blockerId === where.blockerId && row.blockedId === where.blockedId)
                );
                return { count: before - blocks.length };
            }
        }
    }
}));

const blocking = await import("../../src/lib/blocks");
const search = await import("../../src/lib/people-search");

beforeEach(() => {
    blocks = [];
    clock = 0;
});

describe("setting one", () => {
    it("stores it in one direction", async () => {
        await blocking.block("ada", "grace");
        expect(await blocking.blockedBy("ada", ["grace"])).toEqual(new Set(["grace"]));
        // Grace has blocked nobody. The row says who decided, and she did not.
        expect(await blocking.blockedBy("grace", ["ada"])).toEqual(new Set());
    });

    it("is the same block however many times it is set", async () => {
        await blocking.block("ada", "grace");
        await blocking.block("ada", "grace");
        expect(blocks).toHaveLength(1);
    });

    it("refuses to block yourself", async () => {
        await expect(blocking.block("ada", "ada")).rejects.toThrow(blocking.BlockError);
    });

    it("refuses an account that is gone", async () => {
        await expect(blocking.block("ada", "nobody")).rejects.toThrow(blocking.BlockError);
    });

    it("lifts cleanly, and lifting one that was never set is not an error", async () => {
        await blocking.block("ada", "grace");
        await blocking.unblock("ada", "grace");
        await blocking.unblock("ada", "grace");
        expect(await blocking.blockedBy("ada", ["grace"])).toEqual(new Set());
    });
});

describe("which direction it is", () => {
    it("tells who this reader shut out from who shut this reader out", async () => {
        await blocking.block("grace", "ada");

        // Ada has blocked nobody, and must not be told about Grace's decision by
        // a function that answers the other question.
        expect(await blocking.blockedBy("ada", ["grace"])).toEqual(new Set());
        expect(await blocking.blockersOf("ada", ["grace"])).toEqual(new Set(["grace"]));
        // And the mirror, from Grace's side.
        expect(await blocking.blockedBy("grace", ["ada"])).toEqual(new Set(["ada"]));
        expect(await blocking.blockersOf("grace", ["ada"])).toEqual(new Set());
    });

    it("counts either direction as out of reach", async () => {
        await blocking.block("grace", "ada");
        expect(await blocking.blockedBetween("ada", ["grace", "alan"])).toEqual(new Set(["grace"]));
        expect(await blocking.blockedBetween("grace", ["ada", "alan"])).toEqual(new Set(["ada"]));
        expect(await blocking.blockedEitherWay("ada", "grace")).toBe(true);
        expect(await blocking.blockedEitherWay("ada", "alan")).toBe(false);
    });

    it("never puts somebody out of reach of themselves", async () => {
        expect(await blocking.blockedEitherWay("ada", "ada")).toBe(false);
        expect(await blocking.blockedBetween("ada", ["ada"])).toEqual(new Set());
    });
});

describe("the list somebody lifts one from", () => {
    it("names them, newest first", async () => {
        await blocking.block("ada", "grace");
        await blocking.block("ada", "alan");
        const listed = await blocking.listBlocked("ada");
        expect(listed.map((person) => person.name)).toEqual(["Alan Turing", "Grace Hopper"]);
    });
});

/**
 * The search behind every picker.
 *
 * Both directions leave, and neither is counted. The count exists so a picker
 * can say "one account here cannot be written to" instead of implying nobody
 * matched - which is exactly what must not be said about a block.
 */
describe("finding somebody", () => {
    it("leaves out somebody this searcher blocked", async () => {
        await blocking.block("ada", "grace");
        const found = await search.findPeople({ id: "ada" }, "grace", { reachableOnly: false });
        expect(found.people).toEqual([]);
        expect(found.withheld).toBe(0);
    });

    it("leaves out somebody who blocked this searcher, and says nothing about it", async () => {
        await blocking.block("grace", "ada");
        const found = await search.findPeople({ id: "ada" }, "grace", { reachableOnly: false });
        expect(found.people).toEqual([]);
        // The one that would give it away.
        expect(found.withheld).toBe(0);
    });

    it("still finds everybody else", async () => {
        await blocking.block("ada", "grace");
        const found = await search.findPeople({ id: "ada" }, "alan", { reachableOnly: false });
        expect(found.people.map((person) => person.id)).toEqual(["alan"]);
    });
});
