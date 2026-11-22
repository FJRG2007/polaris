/**
 * Searching messages, and the one thing about it that has to be right.
 *
 * A filter narrows; it never widens. The conversations a search runs over are
 * the ones the reader can currently reach, resolved on every search - so naming
 * a channel they are not in narrows to nothing rather than reaching into it. A
 * `channelId` arriving from a browser is a request, not a permission, and this
 * is the test that says so.
 *
 * The rest is what the filters mean: whole inclusive days, "with a link" being
 * about a scheme rather than the word, and system lines staying out of an answer
 * to "what did somebody say".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the query was asked for, so the filters can be read back. */
let asked: { where: Record<string, unknown> } | null = null;

/** Real uuids, because the filter schema insists on them - which is itself a
 *  small guard: a channel id that is not one never reaches the query. */
const MINE = "11111111-1111-4111-8111-111111111111";
const ALSO_MINE = "22222222-2222-4222-8222-222222222222";
const THEIRS = "33333333-3333-4333-8333-333333333333";

let reachable = new Set<string>([MINE, ALSO_MINE]);

/** When the reader joined MINE, if it hides history from people who join later. */
let joinedMine: Date | null = null;

vi.mock("@/lib/chat/access", () => ({
    reachableChannelIds: async () => reachable
}));

/** What the reader hid and locked, and the one proof this tab holds. */
let concealed = { hidden: new Set<string>(), locked: new Set<string>(), hideLocked: false };
const GOOD_PROOF = "good-proof";
vi.mock("@/lib/chat/chat-lock", () => ({
    concealedFor: async () => concealed,
    lockCodeHash: async () => "hash",
    readUnlockProof: (proof: string | null | undefined) => proof === GOOD_PROOF
}));

vi.mock("@/lib/chat/messages", () => ({
    decorateMessages: async (_actor: unknown, rows: { id: string; channelId: string }[]) =>
        rows.map((row) => ({ ...row, authorName: null, reactions: [], attachments: [] }))
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        // The disappearing-messages mode, read on every send: never set here.
        setting: { findUnique: async () => null },
        // Nobody here has deleted a chat for themselves.
        chatChannelMember: { findMany: async () => [] },
        chatMessage: {
            findMany: async (query: { where: Record<string, unknown> }) => {
                asked = query;
                return [{ id: "message-1", channelId: MINE }];
            }
        },
        chatChannel: {
            findMany: async (query: { where: Record<string, unknown> }) =>
                JSON.stringify(query.where).includes("newcomerHistory")
                    ? joinedMine
                        ? [
                              {
                                  id: MINE,
                                  kind: "text",
                                  spaceId: "space-1",
                                  private: true,
                                  newcomerHistory: "off",
                                  members: [{ createdAt: joinedMine }],
                                  space: { newcomerHistory: true, members: [] }
                              }
                          ]
                        : []
                    : [{ id: MINE, name: "release", spaceId: "space-1" }]
        }
    }
}));

const { searchMessages, olderThan, newerThan, encodeSharedCursor, decodeSharedCursor } = await import(
    "@/lib/chat/search"
);
const core = await import("@polaris/core");

const actor = { id: "ada" };

/** A whole filter, so each test can change one field of it. */
function query(partial: Partial<core.ChatSearchInput> = {}): core.ChatSearchInput {
    return core.chatSearchSchema.parse(partial);
}

beforeEach(() => {
    asked = null;
    reachable = new Set([MINE, ALSO_MINE]);
    joinedMine = null;
    concealed = { hidden: new Set(), locked: new Set(), hideLocked: false };
});

describe("what somebody who joined later finds", () => {
    it("is only what was said since they joined, where earlier history is hidden", async () => {
        joinedMine = new Date("2026-10-10T00:00:00Z");
        await searchMessages(actor, query({ term: "release" }));
        const [readable] = (asked?.where.AND ?? []) as { AND: unknown[] }[];
        expect(readable?.AND[0]).toEqual({
            OR: [
                { channelId: { notIn: [MINE] } },
                { channelId: MINE, createdAt: { gte: joinedMine } }
            ]
        });
    });

    it("is everything they can reach, where it is shown", async () => {
        await searchMessages(actor, query({ term: "release" }));
        const [readable] = (asked?.where.AND ?? []) as { AND: unknown[] }[];
        expect(readable?.AND[0]).toEqual({});
        // Never what has disappeared, whatever the floor.
        expect(readable?.AND[1]).toEqual({
            OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]
        });
    });
});

describe("what a search may reach", () => {
    it("looks in every conversation the reader is in", async () => {
        await searchMessages(actor, query({ term: "release" }));
        expect(asked?.where.channelId).toEqual({ in: [MINE, ALSO_MINE] });
    });

    it("narrows to one when asked, and only when it is theirs", async () => {
        await searchMessages(actor, query({ term: "x", channelId: MINE }));
        expect(asked?.where.channelId).toEqual({ in: [MINE] });
    });

    it("finds nothing in a conversation the reader is not in", async () => {
        // The whole point. Naming somebody else's channel is a request that
        // narrows to the empty set, never a way into it.
        const hits = await searchMessages(actor, query({ term: "x", channelId: THEIRS }));
        expect(hits).toEqual([]);
        expect(asked).toBeNull();
    });

    it("finds nothing at all for somebody in no conversations", async () => {
        reachable = new Set();
        expect(await searchMessages(actor, query({ term: "x" }))).toEqual([]);
        expect(asked).toBeNull();
    });

    it("leaves hidden and locked conversations out of a search across everything", async () => {
        concealed = { hidden: new Set([MINE]), locked: new Set([ALSO_MINE]), hideLocked: false };
        expect(await searchMessages(actor, query({ term: "release" }))).toEqual([]);
        expect(asked).toBeNull();
        reachable = new Set([MINE, ALSO_MINE, THEIRS]);
        await searchMessages(actor, query({ term: "release" }));
        expect(asked?.where.channelId).toEqual({ in: [THEIRS] });
    });

    it("searches a locked conversation only with this tab's proof for it", async () => {
        concealed = { hidden: new Set(), locked: new Set([MINE]), hideLocked: false };
        expect(await searchMessages(actor, query({ term: "x", channelId: MINE }))).toEqual([]);
        expect(asked).toBeNull();
        expect(
            await searchMessages(actor, query({ term: "x", channelId: MINE }), "forged")
        ).toEqual([]);
        expect(asked).toBeNull();
        await searchMessages(actor, query({ term: "x", channelId: MINE }), GOOD_PROOF);
        expect(asked?.where.channelId).toEqual({ in: [MINE] });
    });

    it("searches a hidden conversation when it is the one open", async () => {
        concealed = { hidden: new Set([MINE]), locked: new Set(), hideLocked: false };
        await searchMessages(actor, query({ term: "x", channelId: MINE }));
        expect(asked?.where.channelId).toEqual({ in: [MINE] });
    });

    it("refuses to answer an empty search", async () => {
        // No term and no filter is a request for the whole archive.
        expect(await searchMessages(actor, query())).toEqual([]);
        expect(asked).toBeNull();
    });
});

describe("what the filters mean", () => {
    it("matches text without caring about case", async () => {
        await searchMessages(actor, query({ term: "Release" }));
        expect(asked?.where.body).toEqual({ contains: "Release", mode: "insensitive" });
    });

    it("leaves out what Polaris said itself", async () => {
        await searchMessages(actor, query({ term: "joined" }));
        expect(asked?.where.kind).toBe("text");
    });

    it("leaves out deleted messages", async () => {
        await searchMessages(actor, query({ term: "x" }));
        expect(asked?.where.deletedAt).toBeNull();
    });

    it("asks for an image by its type rather than its name", async () => {
        await searchMessages(actor, query({ has: "image" }));
        expect(asked?.where.attachments).toEqual({
            some: { contentType: { startsWith: "image/" } }
        });
    });

    it("asks for a link by its scheme, so the word does not match", async () => {
        await searchMessages(actor, query({ has: "link" }));
        expect(asked?.where.body).toEqual({ contains: "http", mode: "insensitive" });
    });

    it("reads both ends of a date range as whole days", async () => {
        await searchMessages(actor, query({ after: "2026-08-01", before: "2026-08-31" }));
        const range = asked?.where.createdAt as { gte: Date; lte: Date };
        expect(range.gte.getHours()).toBe(0);
        expect(range.gte.getDate()).toBe(1);
        // Inclusive: "before the 31st" that excluded the 31st is nobody's
        // reading of it.
        expect(range.lte.getDate()).toBe(31);
        expect(range.lte.getHours()).toBe(23);
    });
});

describe("what comes back", () => {
    it("says where each hit was said", async () => {
        const hits = await searchMessages(actor, query({ term: "release" }));
        expect(hits).toHaveLength(1);
        expect(hits[0]?.channelName).toBe("release");
        expect(hits[0]?.inSpace).toBe(true);
    });
});

describe("the gallery's pages", () => {
    const at = (iso: string) => new Date(iso);
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

    /** What the database does with the clause: (createdAt, id) strictly older. */
    function matches(row: { createdAt: Date; id: string }, clause: ReturnType<typeof olderThan>): boolean {
        const [earlier, tie] = clause.OR;
        if (row.createdAt < earlier.createdAt.lt) return true;
        return row.createdAt.getTime() === tie.createdAt.getTime() && row.id < tie.id.lt;
    }

    it("walks messages sent in the same millisecond across a page edge, each once", () => {
        // Newest first, ties broken by id, as the query orders them.
        const rows = [
            { createdAt: at("2026-11-02T10:00:00.005Z"), id: id(9) },
            { createdAt: at("2026-11-02T10:00:00.005Z"), id: id(8) },
            { createdAt: at("2026-11-02T10:00:00.005Z"), id: id(7) },
            { createdAt: at("2026-11-02T10:00:00.004Z"), id: id(6) },
            { createdAt: at("2026-11-02T10:00:00.004Z"), id: id(5) }
        ];
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard++) {
            const decoded = decodeSharedCursor(cursor);
            const page = rows.filter((row) => !decoded || matches(row, olderThan(decoded))).slice(0, 2);
            seen.push(...page.map((row) => row.id));
            const last = page.at(-1);
            if (page.length < 2 || !last) break;
            cursor = encodeSharedCursor({ createdAt: last.createdAt.toISOString(), id: last.id });
        }
        expect(seen).toEqual(rows.map((row) => row.id));
    });

    it("refuses a cursor that is not one", () => {
        expect(decodeSharedCursor("yesterday")).toBeNull();
        expect(decodeSharedCursor(null)).toBeNull();
    });

    it("asks the database for the tuple and the tie-broken order", async () => {
        const before = { createdAt: at("2026-11-02T10:00:00.005Z"), id: id(8) };
        await searchMessages(actor, query({ channelId: MINE }), null, { media: true, before, take: 60 });
        const sent = asked as unknown as { where: { AND: unknown[] }; orderBy: unknown; take: number };
        expect(sent.where.AND).toContainEqual(olderThan(before));
        expect(sent.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
        expect(sent.take).toBe(60);
    });
});

describe("a conversation's pages either side of a millisecond", () => {
    type Row = { createdAt: Date; id: string };
    type Bound = { lt?: Date; lte?: Date; gt?: Date; gte?: Date };
    type Clause = ReturnType<typeof olderThan> | ReturnType<typeof newerThan>;
    const at = (ms: number) => new Date(Date.UTC(2026, 10, 2, 10, 0, 0, ms));
    const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

    /** What the database does with one condition on the instant. */
    function within(value: Date, bound: Bound | Date): boolean {
        if (bound instanceof Date) return value.getTime() === bound.getTime();
        const t = value.getTime();
        if (bound.lt && !(t < bound.lt.getTime())) return false;
        if (bound.lte && !(t <= bound.lte.getTime())) return false;
        if (bound.gt && !(t > bound.gt.getTime())) return false;
        if (bound.gte && !(t >= bound.gte.getTime())) return false;
        return true;
    }

    /** The whole clause, range bound and tie-break together. */
    function matches(row: Row, clause: Clause): boolean {
        if (!within(row.createdAt, clause.createdAt)) return false;
        return clause.OR.some((branch) => {
            if (!within(row.createdAt, branch.createdAt)) return false;
            if (!("id" in branch)) return true;
            const idBound = branch.id as { lt?: string; gt?: string };
            return idBound.lt !== undefined ? row.id < idBound.lt : row.id > (idBound.gt ?? "");
        });
    }

    const byTime = (a: Row, b: Row) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1);
    // Oldest first. Three messages share 5 ms and two share 4 ms.
    const rows: Row[] = [
        { createdAt: at(3), id: id(1) },
        { createdAt: at(4), id: id(5) },
        { createdAt: at(4), id: id(6) },
        { createdAt: at(5), id: id(7) },
        { createdAt: at(5), id: id(8) },
        { createdAt: at(5), id: id(9) },
        { createdAt: at(6), id: id(10) }
    ].sort(byTime);

    it("walks upwards across a shared millisecond, each message once", () => {
        const seen: string[] = [];
        let cursor: Row | null = null;
        for (let guard = 0; guard < 10; guard++) {
            const from = cursor;
            const page = [...rows]
                .reverse()
                .filter((row) => !from || matches(row, olderThan(from)))
                .slice(0, 2);
            seen.push(...page.map((row) => row.id));
            cursor = page.at(-1) ?? null;
            if (page.length < 2) break;
        }
        expect(seen).toEqual([...rows].reverse().map((row) => row.id));
    });

    it("walks downwards across a shared millisecond, each message once", () => {
        const seen: string[] = [];
        let cursor: Row | null = null;
        for (let guard = 0; guard < 10; guard++) {
            const from = cursor;
            const page = rows.filter((row) => !from || matches(row, newerThan(from))).slice(0, 2);
            seen.push(...page.map((row) => row.id));
            cursor = page.at(-1) ?? null;
            if (page.length < 2) break;
        }
        expect(seen).toEqual(rows.map((row) => row.id));
    });

    it("centres on a message whose millisecond it shares, leaving none out and none twice", () => {
        const target = rows.find((row) => row.id === id(8));
        if (!target) throw new Error("fixture");
        const above = rows.filter((row) => matches(row, olderThan(target)));
        const below = rows.filter((row) => matches(row, newerThan(target)));
        expect(above.map((row) => row.id)).toEqual([id(1), id(5), id(6), id(7)]);
        expect(below.map((row) => row.id)).toEqual([id(9), id(10)]);
        expect([...above, target, ...below]).toEqual(rows);
    });

    it("bounds the range at the cursor so an index scan starts there", () => {
        const cursor = { createdAt: at(5), id: id(8) };
        expect(olderThan(cursor).createdAt).toEqual({ lte: cursor.createdAt });
        expect(newerThan(cursor).createdAt).toEqual({ gte: cursor.createdAt });
    });
});
