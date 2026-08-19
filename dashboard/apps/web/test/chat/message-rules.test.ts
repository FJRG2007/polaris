/**
 * What the rules actually do to a message.
 *
 * The four that would be expensive to get wrong:
 *
 * - an edit past the window is refused, and a moderator is never bound by it;
 * - the text being replaced is recorded only while the scope keeps history, so
 *   turning history off stops it being written rather than merely hidden;
 * - "no trace" removes the row and the bytes, and "leaves a line" does not;
 * - a message with replies under it is never removed outright, whatever the
 *   setting says, because the replies hang off it by foreign key and would go
 *   with it. That one is somebody else's messages, so it is asserted rather
 *   than trusted to a comment.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAccessError, ChatRuleError } from "@/lib/chat/access";
import { DEFAULT_CHAT_RULES, type ChatRules } from "@polaris/core";

const SENT = new Date("2026-08-15T12:00:00Z");

let rules: ChatRules = DEFAULT_CHAT_RULES;

/** The one message every test acts on. */
let message: {
    id: string;
    channelId: string;
    authorId: string | null;
    body: string;
    parentId: string | null;
    replyCount: number;
    deletedAt: Date | null;
    createdAt: Date;
};

/** What the fake database was asked to do. */
let written: {
    updates: { id: string; data: Record<string, unknown> }[];
    deletes: string[];
    edits: { messageId: string; body: string }[];
    discarded: string[];
    /** Attachment rows dropped, which a tombstone does as well as a hard delete:
     *  the line stays, the files do not. */
    unattached: string[];
    /** Reactions dropped, for the same reason. */
    cleared: string[];
};

/**
 * Whether the conversation is a channel in a space the actor owns, which is the
 * only way anybody administers one - in a direct message everybody is equal, so
 * there is no moderator to test with.
 */
let moderator = false;

/**
 * Whether the conversation is a group this actor started.
 *
 * The one standing that is not a space's: a group has no administrators, so
 * without its owner being able to take a message down, nothing could be done
 * about what anybody posts into one.
 */
let groupOwner = false;

/** How many messages the actor has sent in the last minute. */
let recent = 0;

vi.mock("@/lib/chat/rules", () => ({
    rulesForChannel: async () => rules
}));

vi.mock("@/lib/chat/attachments", () => ({
    isInlineImage: () => false,
    discardAttachments: async (messageId: string) => {
        written.discarded.push(messageId);
    }
}));

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/db", () => {
    const client = {
        // Nobody has blocked anybody here; blocking has its own test.
        userBlock: { findMany: async () => [] },
        chatChannel: {
            findUnique: async () => ({
                id: "channel-1",
                spaceId: moderator ? "space-1" : null,
                kind: moderator ? "text" : groupOwner ? "group" : "dm",
                ownerId: groupOwner ? "ada" : null,
                private: false,
                archived: false,
                space: { archived: false }
            }),
            update: async () => undefined
        },
        chatSpace: {
            findUnique: async () => ({ ownerId: "ada", orgId: null, visibility: "private" })
        },
        chatSpaceMember: { findUnique: async () => null },
        chatChannelMember: {
            findUnique: async () => ({ role: "member" }),
            findMany: async () => [],
            upsert: async () => undefined
        },
        chatMessage: {
            findUnique: async () => message,
            findFirst: async () => null,
            findMany: async () => [],
            count: async () => recent,
            create: async () => ({ id: "new", createdAt: SENT }),
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                written.updates.push({ id: where.id, data });
                return message;
            },
            delete: async ({ where }: { where: { id: string } }) => {
                written.deletes.push(where.id);
                return message;
            }
        },
        chatMessageEdit: {
            create: async ({ data }: { data: { messageId: string; body: string } }) => {
                written.edits.push({ messageId: data.messageId, body: data.body });
                return data;
            },
            findMany: async () => []
        },
        chatReaction: {
            findMany: async () => [],
            deleteMany: async ({ where }: { where: { messageId: string } }) => {
                written.cleared.push(where.messageId);
                return { count: 0 };
            }
        },
        chatAttachment: {
            findMany: async () => [],
            deleteMany: async ({ where }: { where: { messageId: string } }) => {
                written.unattached.push(where.messageId);
                return { count: 0 };
            }
        },
        chatStar: { findMany: async () => [] },
        user: { findMany: async () => [] },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client)
    };
    return { prisma: client };
});

const actor = { id: "ada" };

beforeEach(() => {
    rules = DEFAULT_CHAT_RULES;
    moderator = false;
    groupOwner = false;
    recent = 0;
    written = { updates: [], deletes: [], edits: [], discarded: [], unattached: [], cleared: [] };
    message = {
        id: "message-1",
        channelId: "channel-1",
        authorId: "ada",
        body: "before",
        parentId: null,
        replyCount: 0,
        deletedAt: null,
        createdAt: SENT
    };
    vi.setSystemTime(new Date("2026-08-15T12:30:00Z"));
});

describe("editing", () => {
    it("is allowed however long ago it was said, by default", async () => {
        const { edit } = await import("@/lib/chat/messages");
        message.createdAt = new Date("2019-01-01T00:00:00Z");
        await edit(actor, { messageId: "message-1", body: "after" });
        expect(written.updates.at(-1)?.data.body).toBe("after");
    });

    it("is refused past a window the instance set", async () => {
        const { edit } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, editWindowMinutes: 15 };
        await expect(edit(actor, { messageId: "message-1", body: "after" })).rejects.toBeInstanceOf(
            ChatRuleError
        );
        expect(written.updates).toHaveLength(0);
    });

    it("says how long the window was, so the refusal is actionable", async () => {
        const { edit } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, editWindowMinutes: 60 };
        message.createdAt = new Date("2026-08-15T10:00:00Z");
        await expect(edit(actor, { messageId: "message-1", body: "after" })).rejects.toThrow(
            /1 hour/
        );
    });

    it("records what it used to say, in the same write", async () => {
        const { edit } = await import("@/lib/chat/messages");
        await edit(actor, { messageId: "message-1", body: "after" });
        expect(written.edits).toEqual([{ messageId: "message-1", body: "before" }]);
    });

    it("records nothing when the instance keeps no history", async () => {
        const { edit } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, keepEditHistory: false };
        await edit(actor, { messageId: "message-1", body: "after" });
        expect(written.edits).toHaveLength(0);
        expect(written.updates.at(-1)?.data.body).toBe("after");
    });

    it("refuses a message longer than this kind of conversation allows", async () => {
        const { edit } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, maxMessageLength: 5 };
        await expect(
            edit(actor, { messageId: "message-1", body: "far too long" })
        ).rejects.toBeInstanceOf(ChatRuleError);
    });

    it("is nobody else's to do, moderator or not", async () => {
        const { edit } = await import("@/lib/chat/messages");
        moderator = true;
        message.channelId = "channel-1";
        message.authorId = "grace";
        await expect(edit(actor, { messageId: "message-1", body: "after" })).rejects.toThrow(
            /your own/
        );
    });
});

describe("deleting", () => {
    it("leaves a line saying so, by default", async () => {
        const { remove } = await import("@/lib/chat/messages");
        await remove(actor, "message-1");
        expect(written.deletes).toHaveLength(0);
        expect(written.updates.at(-1)?.data).toMatchObject({ body: "" });
        expect(written.updates.at(-1)?.data.deletedAt).toBeInstanceOf(Date);
    });

    it("takes the files with it even when the line stays", async () => {
        const { remove } = await import("@/lib/chat/messages");
        await remove(actor, "message-1");
        // The tombstone carries no text, no files and no reactions - which is
        // how it is drawn. Keeping the bytes would leave a photograph nothing
        // can reach on somebody's NAS for the life of the instance.
        expect(written.discarded).toEqual(["message-1"]);
        expect(written.unattached).toEqual(["message-1"]);
        expect(written.cleared).toEqual(["message-1"]);
    });

    it("takes the row and the files when the instance wants no trace", async () => {
        const { remove } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, deleteLeavesTrace: false };
        await remove(actor, "message-1");
        expect(written.deletes).toEqual(["message-1"]);
        // "No trace" that left the bytes on the NAS would be a claim the storage
        // does not back.
        expect(written.discarded).toEqual(["message-1"]);
    });

    it("still leaves a tombstone when replies hang off it", async () => {
        const { remove } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, deleteLeavesTrace: false };
        message.replyCount = 3;
        await remove(actor, "message-1");
        // Deleting the row would cascade to three messages other people wrote.
        expect(written.deletes).toHaveLength(0);
        expect(written.updates.at(-1)?.data).toMatchObject({ body: "" });
    });

    it("is refused past the window, like an edit", async () => {
        const { remove } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, editWindowMinutes: 15 };
        await expect(remove(actor, "message-1")).rejects.toBeInstanceOf(ChatRuleError);
    });

    it("is somebody else's message to take down in a group you started", async () => {
        const { remove } = await import("@/lib/chat/messages");
        groupOwner = true;
        message.authorId = "grace";
        await remove(actor, "message-1");
        expect(written.updates.at(-1)?.data).toMatchObject({ body: "" });
    });

    it("is not, in a group somebody else started", async () => {
        const { remove } = await import("@/lib/chat/messages");
        message.authorId = "grace";
        await expect(remove(actor, "message-1")).rejects.toBeInstanceOf(ChatAccessError);
    });

    it("never binds somebody moderating the room", async () => {
        const { remove } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, editWindowMinutes: 15 };
        moderator = true;
        message.authorId = "grace";
        await remove(actor, "message-1");
        expect(written.updates.at(-1)?.data).toMatchObject({ body: "" });
    });
});

describe("how fast somebody may talk", () => {
    it("is unlimited by default", async () => {
        const { send } = await import("@/lib/chat/messages");
        recent = 5000;
        await expect(
            send(actor, { channelId: "channel-1", body: "hello", parentId: null })
        ).resolves.toBeDefined();
    });

    it("refuses once the limit is reached", async () => {
        const { send } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, maxPerMinute: 3 };
        recent = 3;
        await expect(
            send(actor, { channelId: "channel-1", body: "hello", parentId: null })
        ).rejects.toBeInstanceOf(ChatRuleError);
    });

    it("allows the one that reaches it", async () => {
        const { send } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, maxPerMinute: 3 };
        recent = 2;
        await expect(
            send(actor, { channelId: "channel-1", body: "hello", parentId: null })
        ).resolves.toBeDefined();
    });

    it("counts an emoji as the one character somebody typed", async () => {
        const { send } = await import("@/lib/chat/messages");
        rules = { ...DEFAULT_CHAT_RULES, maxMessageLength: 2 };
        // Two code points, four UTF-16 units. A limit that counted the latter
        // would refuse this at half its stated length.
        await expect(
            send(actor, { channelId: "channel-1", body: "👍👍", parentId: null })
        ).resolves.toBeDefined();
    });
});
