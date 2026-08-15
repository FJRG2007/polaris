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

vi.mock("@/lib/chat/access", () => ({
    reachableChannelIds: async () => reachable
}));

vi.mock("@/lib/chat/messages", () => ({
    decorateMessages: async (_actor: unknown, rows: { id: string; channelId: string }[]) =>
        rows.map((row) => ({ ...row, authorName: null, reactions: [], attachments: [] }))
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findMany: async (query: { where: Record<string, unknown> }) => {
                asked = query;
                return [{ id: "message-1", channelId: MINE }];
            }
        },
        chatChannel: {
            findMany: async () => [
                { id: MINE, name: "release", spaceId: "space-1" }
            ]
        }
    }
}));

const { searchMessages } = await import("@/lib/chat/search");
const core = await import("@polaris/core");

const actor = { id: "ada" };

/** A whole filter, so each test can change one field of it. */
function query(partial: Partial<core.ChatSearchInput> = {}): core.ChatSearchInput {
    return core.chatSearchSchema.parse(partial);
}

beforeEach(() => {
    asked = null;
    reachable = new Set([MINE, ALSO_MINE]);
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
        const hits = await searchMessages(
            actor,
            query({ term: "x", channelId: THEIRS })
        );
        expect(hits).toEqual([]);
        expect(asked).toBeNull();
    });

    it("finds nothing at all for somebody in no conversations", async () => {
        reachable = new Set();
        expect(await searchMessages(actor, query({ term: "x" }))).toEqual([]);
        expect(asked).toBeNull();
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
