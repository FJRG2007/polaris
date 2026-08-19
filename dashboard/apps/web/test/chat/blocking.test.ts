/**
 * What a block actually stops in a conversation.
 *
 * Three things are asserted here and each of them is a decision rather than a
 * consequence, which is why none is left to the reading of the code.
 *
 * **A conversation cannot be opened in either direction, and the refusal says
 * nothing about which side set it.** The sentence is the same for both, because
 * one that distinguished them would tell somebody they had been blocked - and
 * that is the one thing this feature must never do.
 *
 * **Writing splits.** Somebody who blocked a person is refused, plainly and with
 * the way back in the sentence: there is nothing to hide from them. Somebody who
 * has been blocked is NOT refused - their message is taken and goes nowhere -
 * because an error that appears where messages used to send is the announcement
 * by another name. Getting this backwards is silent in both directions, so both
 * are asserted.
 *
 * **`@everyone` does not reach past it.** It is the one call that pings a whole
 * room without addressing anybody, which makes it the obvious way around a block
 * if nothing checks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface BlockRow {
    blockerId: string;
    blockedId: string;
}

let blocks: BlockRow[] = [];

/** The conversation every test acts in. A one-to-one unless a test says
 *  otherwise, since that is where blocking does most of its work. */
let room = { id: "dm-1", kind: "dm", spaceId: null as string | null, private: true };

/** Who was told about the `@everyone`, in the order the notifications went out. */
let told: string[] = [];

/** What was written into the conversation, so a message that was NOT refused can
 *  be shown to have actually landed. */
let sent: { authorId: string; body: string }[] = [];

const people = [
    { id: "ada", name: "Ada Lovelace" },
    { id: "grace", name: "Grace Hopper" }
];

/** Everybody in the room. Both tests' rooms hold the same two people. */
const membership = [{ userId: "ada" }, { userId: "grace" }];

function within(clause: unknown): string[] | null {
    if (typeof clause !== "object" || clause === null) return null;
    const value = (clause as { in?: string[] }).in;
    return Array.isArray(value) ? value : null;
}

/** The `where` shapes `lib/blocks` writes, applied to the rows in memory. */
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

vi.mock("@polaris/auth", () => ({
    // Everybody here has the chat and may start a group; this file is about
    // blocking and not about capabilities, which have their own test.
    can: async () => true
}));

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/chat/rules", () => ({
    rulesForChannel: async () => (await import("@polaris/core")).DEFAULT_CHAT_RULES
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/notices", () => ({
    postNotice: async () => undefined,
    postSpaceNotice: async () => undefined
}));
vi.mock("@/lib/chat/attachments", () => ({
    isInlineImage: () => false,
    discardAttachments: async () => undefined,
    discardChannelFiles: async () => undefined
}));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => [],
    unfurl: async () => undefined
}));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map(), MAX_NICKNAME: 40 }));
vi.mock("@/lib/notifications/presence", () => ({ onlineUserIds: () => new Set(["ada", "grace"]) }));
vi.mock("@/lib/notification-service", () => ({
    createNotification: async ({ userId }: { userId: string }) => {
        told.push(userId);
    }
}));

vi.mock("@polaris/db", () => {
    const client = {
        userBlock: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                blocks.filter((row) => matches(row, where)),
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                blocks.find((row) => matches(row, where)) ?? null
        },
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                people.find((person) => person.id === where.id) ?? null,
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                people.filter((person) => where.id.in.includes(person.id))
        },
        chatChannel: {
            // A direct message that already exists, so `openDirect` gets as far
            // as the block check rather than trying to create one.
            findUnique: async ({ where }: { where: Record<string, unknown> }) =>
                "dmKey" in where
                    ? { id: room.id }
                    : { ...room, ownerId: null, archived: false, space: null, slowmode: 0 },
            update: async () => undefined
        },
        chatSpace: { findUnique: async () => null },
        chatSpaceMember: { findUnique: async () => null, findMany: async () => [] },
        chatChannelMember: {
            findUnique: async () => ({ role: "member" }),
            findMany: async ({ where }: { where: { userId?: { not?: string } } }) =>
                membership
                    .filter((row) => row.userId !== where.userId?.not)
                    .map((row) => ({
                        ...row,
                        muted: false,
                        mutedUntil: null,
                        user: {
                            name: people.find((person) => person.id === row.userId)?.name ?? ""
                        }
                    })),
            upsert: async () => undefined
        },
        chatMessage: {
            findUnique: async () => null,
            findFirst: async () => null,
            findMany: async () => [],
            count: async () => 0,
            create: async ({ data }: { data: { authorId: string; body: string } }) => {
                sent.push({ authorId: data.authorId, body: data.body });
                return { id: "m1", createdAt: new Date() };
            },
            update: async () => undefined
        },
        chatReaction: { findMany: async () => [] },
        chatAttachment: { findMany: async () => [] },
        chatStar: { findMany: async () => [] },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client)
    };
    return { prisma: client };
});

const chat = await import("../../src/lib/chat/chat-service");
const messages = await import("../../src/lib/chat/messages");
const mentions = await import("../../src/lib/chat/room-mentions");
const { ChatRuleError } = await import("../../src/lib/chat/access");

const ada = { id: "ada" };
const grace = { id: "grace" };

beforeEach(() => {
    blocks = [];
    told = [];
    sent = [];
    room = { id: "dm-1", kind: "dm", spaceId: null, private: true };
});

describe("opening a conversation", () => {
    it("opens normally when nobody has blocked anybody", async () => {
        await expect(chat.openDirect(ada, ["grace"])).resolves.toBe("dm-1");
    });

    it("is refused when the one asking has blocked the other", async () => {
        blocks.push({ blockerId: "ada", blockedId: "grace" });
        await expect(chat.openDirect(ada, ["grace"])).rejects.toThrow(
            "You cannot start that conversation"
        );
    });

    it("is refused the same way when the other has blocked the one asking", async () => {
        blocks.push({ blockerId: "grace", blockedId: "ada" });
        // Deliberately the same sentence. A different one here is how somebody
        // finds out they have been blocked.
        await expect(chat.openDirect(ada, ["grace"])).rejects.toThrow(
            "You cannot start that conversation"
        );
    });
});

describe("writing into one", () => {
    it("refuses somebody writing to a person they blocked, and says how to undo it", async () => {
        blocks.push({ blockerId: "ada", blockedId: "grace" });
        await expect(messages.send(ada, { channelId: "dm-1", body: "Hello" })).rejects.toThrow(
            ChatRuleError
        );
        await expect(messages.send(ada, { channelId: "dm-1", body: "Hello" })).rejects.toThrow(
            "Unblock them to send a message"
        );
        expect(sent).toEqual([]);
    });

    it("takes the message from somebody who has been blocked, and carries it nowhere", async () => {
        blocks.push({ blockerId: "ada", blockedId: "grace" });
        // Grace does not know, so nothing about her screen changes: the message
        // is accepted and stored. What it does not do is reach Ada, which the
        // toasts and the unread count are what enforce.
        await expect(messages.send(grace, { channelId: "dm-1", body: "Hello" })).resolves.toBe(
            "m1"
        );
        expect(sent).toEqual([{ authorId: "grace", body: "Hello" }]);
    });

    it("leaves an ordinary conversation alone", async () => {
        await expect(messages.send(ada, { channelId: "dm-1", body: "Hello" })).resolves.toBe("m1");
        expect(sent).toHaveLength(1);
    });
});

describe("a mention of the whole room", () => {
    beforeEach(() => {
        // `@everyone` is deliberately ignored in a one-to-one conversation, so
        // this one has to be a group.
        room = { id: "dm-1", kind: "group", spaceId: null, private: true };
    });

    it("tells everybody in the room", async () => {
        await mentions.announceRoomMention("dm-1", "ada", "@everyone stand up", "m1");
        expect(told).toEqual(["grace"]);
    });

    it("does not tell somebody who blocked whoever wrote it", async () => {
        blocks.push({ blockerId: "grace", blockedId: "ada" });
        await mentions.announceRoomMention("dm-1", "ada", "@everyone stand up", "m1");
        expect(told).toEqual([]);
    });

    it("still tells somebody the writer blocked", async () => {
        // The other direction, which must not be confused with it: Ada shutting
        // Grace out says nothing about what Grace is told.
        blocks.push({ blockerId: "ada", blockedId: "grace" });
        await mentions.announceRoomMention("dm-1", "ada", "@everyone stand up", "m1");
        expect(told).toEqual(["grace"]);
    });
});
