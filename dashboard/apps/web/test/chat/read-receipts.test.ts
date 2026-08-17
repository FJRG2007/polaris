/**
 * What happens when somebody catches up.
 *
 * Reading a conversation used to be silent on the wire, and two screens were
 * wrong because of it: the unread count on whatever else that person had open,
 * which stayed up until the page was reloaded, and the ticks under the other
 * person's messages, which stayed grey until something else reloaded them.
 *
 * The moments are the second half. The membership row is monotonic - it says how
 * far somebody has got now - so it can say whether a message has been read and
 * never when. That is stamped on the message itself, once, and bounded by the
 * mark it replaces so a conversation opened for the tenth time only stamps what
 * arrived since the ninth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MessageRow {
    id: string;
    channelId: string;
    authorId: string | null;
    createdAt: Date;
    deletedAt: Date | null;
    deliveredAt: Date | null;
    readAt: Date | null;
}

const SENT = new Date("2026-08-17T10:00:00Z");

let kind = "dm";
let messages: MessageRow[] = [];
let mark: { lastReadAt: Date | null; lastDeliveredAt: Date | null } | null = null;
/** The other person in the conversation, as the membership table has them. */
let other: { userId: string; lastReadAt: Date | null; lastDeliveredAt: Date | null } | null = null;
let receiptsAllowed = true;

let announced: { kind: string; channelId: string; actorId: string }[] = [];
let stamped: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];

vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return {
        ...actual,
        requireChannel: async (_actor: unknown, channelId: string) => ({
            channelId,
            spaceId: null,
            kind,
            archived: false,
            member: true,
            mayPost: true,
            mayAdminister: false,
            mayModerate: false
        })
    };
});

vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: { kind: string; channelId: string; actorId: string }) => {
        announced.push(change);
    }
}));

vi.mock("@/lib/privacy-service", () => ({
    receiptsBetween: async () => receiptsAllowed,
    maySee: async () => true,
    allowedBy: async () => new Set<string>()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: { findUnique: async () => ({ kind }) },
        chatChannelMember: {
            findUnique: async () => mark,
            findFirst: async () => other,
            upsert: async () => undefined,
            updateMany: async () => undefined
        },
        chatMessage: {
            findFirst: async ({ where }: { where: { id: string } }) =>
                messages.find((row) => row.id === where.id) ?? null,
            findUnique: async ({ where }: { where: { id: string } }) =>
                messages.find((row) => row.id === where.id) ?? null,
            findMany: async ({ where }: { where: { id?: { in: string[] }; authorId?: string } }) =>
                messages.filter(
                    (row) =>
                        (!where.id || where.id.in.includes(row.id)) &&
                        (!where.authorId || row.authorId === where.authorId) &&
                        !row.deletedAt
                ),
            updateMany: async (args: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                stamped.push(args);
                return { count: 0 };
            }
        }
    }
}));

const { deliveryOf, markRead, receiptsFor } = await import("@/lib/chat/messages");

const ada = { id: "ada" };

function message(id: string, authorId: string | null, minutes: number): MessageRow {
    return {
        id,
        channelId: "c1",
        authorId,
        createdAt: new Date(SENT.getTime() + minutes * 60_000),
        deletedAt: null,
        deliveredAt: null,
        readAt: null
    };
}

beforeEach(() => {
    kind = "dm";
    receiptsAllowed = true;
    announced = [];
    stamped = [];
    mark = { lastReadAt: null, lastDeliveredAt: null };
    other = { userId: "grace", lastReadAt: null, lastDeliveredAt: null };
    messages = [message("m1", "grace", 0), message("m2", "ada", 1), message("m3", "grace", 2)];
});

describe("catching up", () => {
    it("announces it, so the other screens of the same person can take the count down", async () => {
        await markRead(ada, { channelId: "c1", messageId: "m3" });
        expect(announced).toEqual([{ kind: "read", channelId: "c1", actorId: "ada" }]);
    });

    it("says nothing when the mark would go backwards", async () => {
        mark = { lastReadAt: messages[2]!.createdAt, lastDeliveredAt: null };
        await markRead(ada, { channelId: "c1", messageId: "m1" });
        expect(announced).toHaveLength(0);
        expect(stamped).toHaveLength(0);
    });

    it("stamps the moment on what it crossed, bounded by the mark it replaces", async () => {
        mark = { lastReadAt: messages[0]!.createdAt, lastDeliveredAt: null };
        await markRead(ada, { channelId: "c1", messageId: "m3" });
        const where = stamped.at(-1)?.where as {
            authorId: { not: string };
            readAt: null;
            createdAt: { lte: Date; gt?: Date };
        };
        // Not the reader's own messages, not the ones already stamped, and
        // nothing older than what they had already read.
        expect(where.authorId).toEqual({ not: "ada" });
        expect(where.readAt).toBeNull();
        expect(where.createdAt.lte).toEqual(messages[2]!.createdAt);
        expect(where.createdAt.gt).toEqual(messages[0]!.createdAt);
    });

    it("stamps nothing outside a one-to-one conversation", async () => {
        kind = "text";
        await markRead(ada, { channelId: "c1", messageId: "m3" });
        expect(stamped).toHaveLength(0);
        // Still announced: the count in the rail is not a one-to-one feature.
        expect(announced).toHaveLength(1);
    });
});

describe("the ticks, asked for on their own", () => {
    it("answers for the reader's own messages", async () => {
        other = { userId: "grace", lastReadAt: messages[1]!.createdAt, lastDeliveredAt: null };
        const marks = await receiptsFor(ada, "c1", ["m2"]);
        expect(marks).toEqual({ m2: "read" });
    });

    it("answers nothing where there are no ticks to show", async () => {
        receiptsAllowed = false;
        expect(await receiptsFor(ada, "c1", ["m2"])).toEqual({});
    });

    it("asks nothing at all for an empty list", async () => {
        expect(await receiptsFor(ada, "c1", [])).toEqual({});
    });
});

describe("the three moments", () => {
    it("are the ones recorded on the message", async () => {
        const delivered = new Date("2026-08-17T10:05:00Z");
        const read = new Date("2026-08-17T10:06:00Z");
        messages[1] = { ...messages[1]!, deliveredAt: delivered, readAt: read };
        other = { userId: "grace", lastReadAt: messages[1]!.createdAt, lastDeliveredAt: null };

        const delivery = await deliveryOf(ada, "m2");
        expect(delivery).toEqual({
            sentAt: messages[1]!.createdAt.toISOString(),
            deliveredAt: delivered.toISOString(),
            readAt: read.toISOString(),
            state: "read"
        });
    });

    it("say how far it got even when the moments were never recorded", async () => {
        other = { userId: "grace", lastReadAt: messages[1]!.createdAt, lastDeliveredAt: null };
        const delivery = await deliveryOf(ada, "m2");
        // An old message: read, and nobody wrote down when.
        expect(delivery).toMatchObject({ state: "read", readAt: null, deliveredAt: null });
    });

    it("are nobody else's message to ask about", async () => {
        expect(await deliveryOf(ada, "m1")).toBeNull();
    });
});
