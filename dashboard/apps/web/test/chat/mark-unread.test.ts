/**
 * Putting a conversation back to unread.
 *
 * The one write in Chat that moves the read mark backwards, which is why it is
 * asserted rather than trusted: everything else that touches the mark is written
 * to refuse exactly this, and a bug here is either a conversation that will not
 * go unread or one that quietly un-reads itself.
 *
 * Three things have to hold.
 *
 * **The badge says one.** The mark lands on the message BEFORE the one being
 * picked up from, so that one is the first thing waiting. A mark that landed on
 * it would mark a conversation unread and then show nothing waiting, which reads
 * as a menu item that did nothing.
 *
 * **The boundary is what the badge counts.** A line Polaris wrote itself, a
 * reply inside a thread and the reader's own message are not things anybody is
 * waiting to read, so none of them may be picked as the boundary - otherwise the
 * count comes back zero for the same reason.
 *
 * **It never moves forwards.** Marking a conversation unread twice must not
 * leave somebody having read more of it than before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    authorId: string | null;
    kind: string;
    parentId: string | null;
    deletedAt: Date | null;
    createdAt: Date;
}

/** A conversation, oldest first. `at` is minutes past the hour, so the order is
 *  readable in the assertions rather than a wall of timestamps. */
function message(id: string, at: number, over: Partial<Row> = {}): Row {
    return {
        id,
        authorId: "grace",
        kind: "text",
        parentId: null,
        deletedAt: null,
        createdAt: new Date(Date.UTC(2026, 7, 19, 12, at)),
        ...over
    };
}

let conversation: Row[] = [];

/** The reader's own membership row, which is what this writes. */
let mark: { lastReadMessageId: string | null; lastReadAt: Date | null } = {
    lastReadMessageId: null,
    lastReadAt: null
};

/** What `update` was asked to write, so "wrote nothing" can be told apart from
 *  "wrote the same thing". */
let writes: { lastReadMessageId: string | null; lastReadAt: Date | null }[] = [];

/** Whether the other screens were told. A mark that moves without a frame is a
 *  badge that stays wrong until the page is reloaded. */
let announced = 0;

/** Whether `readAt` on any message was touched. It must not be: the reader did
 *  see those messages, and retracting a receipt would tell the other person
 *  something untrue. */
let receiptsTouched = 0;

vi.mock("@/lib/chat/live", () => ({
    publishChatChange: () => {
        announced += 1;
    }
}));

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/chat/rules", () => ({
    rulesForChannel: async () => (await import("@polaris/core")).DEFAULT_CHAT_RULES
}));
vi.mock("@/lib/chat/attachments", () => ({
    isInlineImage: () => false,
    discardAttachments: async () => undefined
}));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => [],
    unfurl: async () => undefined
}));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@/lib/blocks", () => ({ blockedBy: async () => new Set() }));
// Who a read is announced to. Its own rule with its own test - here it only has
// to answer, so the mark's own behaviour is what fails when something fails.
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async () => new Set(),
    maySee: async () => false,
    receiptsBetween: async () => false
}));

/** The `where` of a `chatMessage.findFirst`, as this module writes them. */
function keep(row: Row, where: Record<string, unknown>): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.parentId === null && row.parentId !== null) return false;
    const kind = where.kind as { not?: string } | undefined;
    if (kind?.not !== undefined && row.kind === kind.not) return false;
    const author = where.authorId as { not?: string } | undefined;
    if (author?.not !== undefined && row.authorId === author.not) return false;
    const when = where.createdAt as { lt?: Date } | undefined;
    if (when?.lt !== undefined && !(row.createdAt < when.lt)) return false;
    return true;
}

vi.mock("@polaris/db", () => {
    const client = {
        chatChannel: {
            findUnique: async () => ({
                id: "c1",
                spaceId: null,
                kind: "dm",
                ownerId: null,
                private: true,
                archived: false,
                space: null
            })
        },
        chatSpace: { findUnique: async () => null },
        chatSpaceMember: { findUnique: async () => null },
        chatChannelMember: {
            findUnique: async () => ({ ...mark, role: "member" }),
            findFirst: async () => ({ userId: "grace" }),
            update: async ({
                data
            }: {
                data: { lastReadMessageId: string | null; lastReadAt: Date | null };
            }) => {
                writes.push(data);
                mark = { ...data };
                return data;
            }
        },
        chatMessage: {
            findFirst: async ({
                where,
                orderBy
            }: {
                where: Record<string, unknown>;
                orderBy?: { createdAt?: "asc" | "desc" };
            }) => {
                const found = conversation.filter((row) => keep(row, where));
                if (orderBy?.createdAt === "desc") {
                    return found[found.length - 1] ?? null;
                }
                return found[0] ?? null;
            },
            updateMany: async () => {
                receiptsTouched += 1;
                return { count: 0 };
            }
        }
    };
    return { prisma: client };
});

const messages = await import("../../src/lib/chat/messages");

const ada = { id: "ada" };

/** Ada has read everything: the mark sits on the newest message. */
function caughtUp(): void {
    const newest = conversation[conversation.length - 1]!;
    mark = { lastReadMessageId: newest.id, lastReadAt: newest.createdAt };
}

beforeEach(() => {
    conversation = [message("m1", 1), message("m2", 2), message("m3", 3)];
    mark = { lastReadMessageId: null, lastReadAt: null };
    writes = [];
    announced = 0;
    receiptsTouched = 0;
});

describe("from the conversation list", () => {
    it("leaves the last thing somebody said waiting", async () => {
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1" });
        expect(writes).toEqual([
            { lastReadMessageId: "m2", lastReadAt: conversation[1]!.createdAt }
        ]);
    });

    it("tells the other screens", async () => {
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1" });
        expect(announced).toBe(1);
    });

    it("does not pick the reader's own message as the boundary", async () => {
        // Ada answered last. What is waiting is still Grace's message, and a
        // mark placed before Ada's own would show a badge of zero.
        conversation.push(message("m4", 4, { authorId: "ada" }));
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1" });
        expect(writes[0]?.lastReadMessageId).toBe("m2");
    });

    it("does not pick a line Polaris wrote itself", async () => {
        conversation.push(message("m4", 4, { authorId: null, kind: "system" }));
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1" });
        expect(writes[0]?.lastReadMessageId).toBe("m2");
    });

    it("does not pick a reply inside a thread", async () => {
        conversation.push(message("m4", 4, { parentId: "m1" }));
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1" });
        expect(writes[0]?.lastReadMessageId).toBe("m2");
    });

    it("writes nothing in a conversation nobody else has said anything in", async () => {
        conversation = [message("m1", 1, { authorId: "ada" })];
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1" });
        expect(writes).toEqual([]);
        expect(announced).toBe(0);
    });

    it("writes nothing when the conversation was never read in the first place", async () => {
        await messages.markUnread(ada, { channelId: "c1" });
        expect(writes).toEqual([]);
    });
});

describe("from a message", () => {
    it("picks the conversation up at that message", async () => {
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1", messageId: "m2" });
        expect(writes[0]?.lastReadMessageId).toBe("m1");
    });

    it("clears the mark when it is the first message in the conversation", async () => {
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1", messageId: "m1" });
        expect(writes).toEqual([{ lastReadMessageId: null, lastReadAt: null }]);
    });

    it("ignores a message that is not in this conversation", async () => {
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1", messageId: "somewhere-else" });
        expect(writes).toEqual([]);
    });
});

describe("what it must never do", () => {
    it("does not move the mark forwards when it is already further back", async () => {
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1", messageId: "m1" });
        // Already unread from the very beginning. Asking to be unread from the
        // last message would be asking to have read more of it.
        await messages.markUnread(ada, { channelId: "c1" });
        expect(writes).toHaveLength(1);
    });

    it("is not undone by asking twice for the same thing", async () => {
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1" });
        await messages.markUnread(ada, { channelId: "c1" });
        expect(writes).toHaveLength(1);
        expect(mark.lastReadMessageId).toBe("m2");
    });

    it("does not retract a receipt somebody has already been shown", async () => {
        caughtUp();
        await messages.markUnread(ada, { channelId: "c1" });
        expect(receiptsTouched).toBe(0);
    });
});
