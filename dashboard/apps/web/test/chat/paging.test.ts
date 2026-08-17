/**
 * Reading a conversation a page at a time, in both directions.
 *
 * The screen holds a window rather than the whole channel - it drops what it has
 * scrolled away from so a long conversation cannot end up entirely in the
 * browser - and a window can only move if the server says, at each edge, whether
 * there is more that way. That is what `olderThan` and `newerThan` are, and the
 * thing worth pinning is that both are *cursors* and not counts: a page asks for
 * one more row than it returns, and the extra row is the whole answer.
 *
 * An id rather than a timestamp, because two messages can share a millisecond
 * and a timestamp cursor would step over one of them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Fifty is the page; these are ordered oldest first, as the channel is. */
const all = Array.from({ length: 130 }, (_, index) => ({
    id: `m${String(index).padStart(3, "0")}`,
    createdAt: new Date(1_700_000_000_000 + index * 1000),
    channelId: "c1",
    parentId: null,
    authorId: "ada",
    body: `message ${index}`,
    deletedAt: null,
    editedAt: null,
    kind: "text",
    replyCount: 0,
    lastReplyAt: null,
    quotedId: null,
    forwarded: false
}));

const byId = new Map(all.map((row) => [row.id, row]));

/** Just the parts of the query these two functions use. The decoration pass
 *  asks for quoted messages by id with no order and no limit, so both are
 *  optional here. */
function findMany(args: {
    where: { createdAt?: { lt?: Date; gt?: Date }; id?: { in: string[] } };
    orderBy?: { createdAt: "asc" | "desc" };
    take?: number;
}) {
    const from = args.where.createdAt;
    const wanted = args.where.id?.in;
    let rows = all.filter((row) => {
        if (wanted) return wanted.includes(row.id);
        if (from?.lt) return row.createdAt < from.lt;
        if (from?.gt) return row.createdAt > from.gt;
        return true;
    });
    if (args.orderBy?.createdAt === "desc") rows = [...rows].reverse();
    return args.take === undefined ? rows : rows.slice(0, args.take);
}

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findMany: async (args: Parameters<typeof findMany>[0]) => findMany(args),
            findFirst: async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null
        },
        chatReaction: { findMany: async () => [] },
        chatAttachment: { findMany: async () => [] },
        chatStar: { findMany: async () => [] },
        contactName: { findMany: async () => [] },
        chatChannel: { findUnique: async () => ({ kind: "text" }) },
        chatChannelMember: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
        user: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/chat/access", () => ({
    // What the real one answers with, because the reader uses it: a page marks
    // the conversation delivered, and only a one-to-one conversation stamps the
    // moment on the messages themselves.
    requireChannel: async (_actor: unknown, channelId: string) => ({
        channelId,
        spaceId: null,
        kind: "text",
        archived: false,
        member: true,
        mayPost: true,
        mayAdminister: false,
        mayModerate: false
    }),
    requirePostable: async () => undefined,
    reachableChannelIds: async () => new Set<string>(),
    ChatAccessError: class extends Error {},
    ChatRuleError: class extends Error {}
}));

// Nobody here has said anything about forwarding, so everybody may - which is
// what an account that has never opened the privacy screen is on.
vi.mock("@/lib/privacy-service", () => ({
    receiptsBetween: async () => null,
    maySee: async () => true,
    allowedBy: async (_viewer: unknown, _field: string, ids: readonly string[]) => new Set(ids)
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => ({ keepEditHistory: false }) }));
vi.mock("@/lib/chat/room-mentions", () => ({ announceRoomMention: async () => undefined }));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => undefined
}));

const { readChannel, readSince } = await import("@/lib/chat/messages");

const actor = { id: "ada" };

beforeEach(() => {
    vi.clearAllMocks();
});

describe("upwards, into the history", () => {
    it("opens on the newest page, oldest first", async () => {
        const page = await readChannel(actor, "c1");
        expect(page.messages).toHaveLength(50);
        expect(page.messages[0]?.id).toBe("m080");
        expect(page.messages[49]?.id).toBe("m129");
    });

    it("points at the page above, by the oldest id it returned", async () => {
        const page = await readChannel(actor, "c1");
        expect(page.olderThan).toBe("m080");

        const older = await readChannel(actor, "c1", page.olderThan!);
        expect(older.messages[0]?.id).toBe("m030");
        expect(older.messages[49]?.id).toBe("m079");
    });

    it("says nothing above once the last page is short of a full one", async () => {
        const first = await readChannel(actor, "c1");
        const second = await readChannel(actor, "c1", first.olderThan!);
        const third = await readChannel(actor, "c1", second.olderThan!);
        expect(third.messages).toHaveLength(30);
        expect(third.olderThan).toBeNull();
    });
});

describe("downwards, back out of it", () => {
    it("points at the page below while there is one", async () => {
        const page = await readSince(actor, "c1", "m000");
        expect(page.messages[0]?.id).toBe("m001");
        expect(page.messages).toHaveLength(50);
        expect(page.newerThan).toBe("m050");
    });

    it("says nothing below once it reaches the live end", async () => {
        const page = await readSince(actor, "c1", "m100");
        expect(page.messages).toHaveLength(29);
        // Null is what tells a screen it is holding the newest message, which is
        // what decides whether a new one is appended or ignored.
        expect(page.newerThan).toBeNull();
    });

    it("answers nothing at all when there is nothing after it", async () => {
        const page = await readSince(actor, "c1", "m129");
        expect(page.messages).toEqual([]);
        expect(page.newerThan).toBeNull();
    });
});
