/**
 * What somebody who joined later reads, through the functions the screens call.
 *
 * `history-visibility.test.ts` pins the rule itself; this pins that the channel
 * page, a thread and the guard on the setting all go through it. With the
 * setting off, a reader who joined at `joined` is shown nothing written before
 * that; with it on (the default), everything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const joined = new Date("2026-10-10T00:00:00Z");
const before = new Date("2026-10-01T00:00:00Z");
const after = new Date("2026-10-12T00:00:00Z");

function row(id: string, createdAt: Date, parentId: string | null = null) {
    return {
        id,
        createdAt,
        channelId: "c1",
        parentId,
        authorId: "ada",
        body: id,
        deletedAt: null,
        editedAt: null,
        kind: "text",
        replyCount: 0,
        lastReplyAt: null,
        quotedId: null,
        forwarded: false
    };
}

/** Oldest first, as the channel is: two from before the reader joined, two after,
 *  and a thread whose root is old and whose reply is new. */
const all = [
    row("old-1", before),
    row("old-2", new Date(before.getTime() + 1000)),
    row("new-1", after),
    row("new-2", new Date(after.getTime() + 1000)),
    row("reply", new Date(after.getTime() + 2000), "old-1")
];

type Where = {
    channelId?: string;
    parentId?: null;
    id?: { in: string[] };
    createdAt?: { lt?: Date; gt?: Date };
    OR?: ({ id: string } | { parentId: string })[];
    AND?: { createdAt?: { gte: Date } }[];
};

/** The parts of a message query these readers use, answered the way the
 *  database would. */
function findMany(args: { where: Where; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) {
    const { where } = args;
    let rows = all.filter((message) => {
        if (where.id && !where.id.in.includes(message.id)) return false;
        if (where.parentId === null && message.parentId !== null) return false;
        if (where.createdAt?.lt && !(message.createdAt < where.createdAt.lt)) return false;
        if (where.createdAt?.gt && !(message.createdAt > where.createdAt.gt)) return false;
        if (
            where.OR &&
            !where.OR.some((branch) =>
                "id" in branch ? branch.id === message.id : branch.parentId === message.parentId
            )
        ) {
            return false;
        }
        return (where.AND ?? []).every(
            (clause) => !clause.createdAt || message.createdAt >= clause.createdAt.gte
        );
    });
    if (args.orderBy?.createdAt === "desc") rows = [...rows].reverse();
    return args.take === undefined ? rows : rows.slice(0, args.take);
}

/** Whether the setting is off for this channel, and who may change it. */
let closed = false;
let administers = false;
const written: { channel?: unknown; space?: unknown } = {};

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findMany: async (args: Parameters<typeof findMany>[0]) => findMany(args),
            findFirst: async ({ where }: { where: { id: string } }) =>
                all.find((message) => message.id === where.id) ?? null,
            findUnique: async ({ where }: { where: { id: string } }) =>
                all.find((message) => message.id === where.id) ?? null
        },
        chatReaction: { findMany: async () => [] },
        chatAttachment: { findMany: async () => [] },
        chatStar: { findMany: async () => [] },
        contactName: { findMany: async () => [] },
        userBlock: { findMany: async () => [] },
        chatChannel: {
            findUnique: async () => ({ kind: "text" }),
            // Only the history lookup asks this file for channels. The channel
            // row is older than the space join, as reading one leaves behind.
            findMany: async () =>
                closed
                    ? [
                          {
                              id: "c1",
                              kind: "text",
                              spaceId: "s1",
                              private: false,
                              newcomerHistory: "off",
                              members: [{ createdAt: before }],
                              space: { newcomerHistory: true, members: [{ createdAt: joined }] }
                          }
                      ]
                    : [],
            update: async ({ data }: { data: unknown }) => {
                written.channel = data;
                return {};
            }
        },
        chatSpace: {
            update: async ({ data }: { data: unknown }) => {
                written.space = data;
                return {};
            }
        },
        chatChannelMember: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
        user: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/chat/access", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/chat/access")>();
    return {
        ...real,
        requireChannel: async (_actor: unknown, channelId: string) => ({
            channelId,
            spaceId: "s1",
            kind: "text",
            archived: false,
            member: true,
            mayPost: true,
            mayAdminister: administers,
            mayModerate: false
        }),
        requirePostable: async () => undefined,
        reachableChannelIds: async () => new Set<string>(["c1"]),
        requireSpace: async () => {
            if (!administers) throw new real.ChatAccessError();
        }
    };
});
vi.mock("@/lib/privacy-service", () => ({
    receiptsBetween: async () => null,
    maySee: async () => true,
    allowedBy: async (_viewer: unknown, _field: string, ids: readonly string[]) => new Set(ids)
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => ({ keepEditHistory: false }) }));
vi.mock("@/lib/chat/room-mentions", () => ({
    announceRoomMention: async () => undefined,
    refuseRoomMention: async () => undefined
}));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => undefined
}));
vi.mock("@/lib/chat/attachments", () => ({ discardChannelFiles: async () => undefined }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/access/grants", () => ({
    dropGrantsFor: async () => undefined,
    grantedSubjects: async () => []
}));
vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: async () => [],
    readsOrgWhere: () => ({})
}));
vi.mock("@polaris/auth", () => ({ can: async () => true }));

const { readChannel, readThread } = await import("@/lib/chat/messages");
const chat = await import("@/lib/chat/chat-service");

const reader = { id: "grace" };
const ids = (rows: readonly { id: string }[]) => rows.map((message) => message.id);

beforeEach(() => {
    closed = false;
    administers = false;
    delete written.channel;
    delete written.space;
});

describe("a channel page", () => {
    it("starts at the join when history is hidden", async () => {
        closed = true;
        const page = await readChannel(reader, "c1");
        expect(ids(page.messages)).toEqual(["new-1", "new-2"]);
    });

    it("shows everything when it is not", async () => {
        const page = await readChannel(reader, "c1");
        expect(ids(page.messages)).toEqual(["old-1", "old-2", "new-1", "new-2"]);
    });
});

describe("a thread", () => {
    it("shows only the replies written since the join when history is hidden", async () => {
        closed = true;
        expect(ids(await readThread(reader, "old-1"))).toEqual(["reply"]);
    });

    it("shows the root and every reply when it is not", async () => {
        expect(ids(await readThread(reader, "old-1"))).toEqual(["old-1", "reply"]);
    });
});

describe("changing the setting", () => {
    it("is refused to somebody who does not run the channel or the space", async () => {
        await expect(
            chat.setNewcomerHistory(reader, { scope: "channel", channelId: "c1", value: "off" })
        ).rejects.toThrow();
        await expect(
            chat.setNewcomerHistory(reader, { scope: "space", spaceId: "s1", value: false })
        ).rejects.toThrow();
        expect(written).toEqual({});
    });

    it("is written for whoever does", async () => {
        administers = true;
        await chat.setNewcomerHistory(reader, { scope: "channel", channelId: "c1", value: "off" });
        await chat.setNewcomerHistory(reader, { scope: "space", spaceId: "s1", value: false });
        expect(written).toEqual({
            channel: { newcomerHistory: "off" },
            space: { newcomerHistory: false }
        });
    });
});
