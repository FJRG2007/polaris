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
interface MemberRow {
    userId: string;
    lastReadAt: Date | null;
    lastSeenAt?: Date | null;
    lastDeliveredAt: Date | null;
}
/** The other people in the conversation, as the membership table has them. */
let others: MemberRow[] = [];
let receiptsAllowed = true;
/** Members whose own setting withholds their ticks from the reader. */
let hidden = new Set<string>();

let announced: {
    kind: string;
    channelId: string;
    actorId: string;
    audience?: readonly string[];
}[] = [];
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
    publishChatChange: (change: {
        kind: string;
        channelId: string;
        actorId: string;
        audience?: readonly string[];
    }) => {
        announced.push(change);
    }
}));

vi.mock("@/lib/privacy-service", () => ({
    receiptsBetween: async () => receiptsAllowed,
    receiptsAmong: async (_viewer: unknown, ids: readonly string[]) =>
        new Set(receiptsAllowed ? ids.filter((id) => !hidden.has(id)) : []),
    maySee: async () => true,
    allowedBy: async () => new Set<string>()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: { findUnique: async () => ({ kind }), findMany: async () => [] },
        chatChannelMember: {
            findUnique: async () => mark,
            findFirst: async () => others[0] ?? null,
            findMany: async ({ take }: { take?: number }) => others.slice(0, take),
            upsert: async () => undefined,
            updateMany: async () => undefined
        },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }))
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

vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map<string, string>() }));

const { deliveryOf, markRead, receiptsFor } = await import("@/lib/chat/messages");
const { GROUP_RECEIPT_MAX_MEMBERS } = await import("@/lib/chat/group-receipts");

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
    hidden = new Set();
    announced = [];
    stamped = [];
    mark = { lastReadAt: null, lastDeliveredAt: null };
    others = [{ userId: "grace", lastReadAt: null, lastDeliveredAt: null }];
    messages = [message("m1", "grace", 0), message("m2", "ada", 1), message("m3", "grace", 2)];
});

describe("catching up", () => {
    it("announces it to their own screens and to the person whose ticks it moves", async () => {
        await markRead(ada, { channelId: "c1", messageId: "m3" });
        expect(announced).toEqual([
            { kind: "read", channelId: "c1", actorId: "ada", audience: ["ada", "grace"] }
        ]);
    });

    it("does not tell them when the ticks are not theirs to see", async () => {
        // The frame arrives at the instant the message was opened, so sending it
        // to somebody the setting withholds the ticks from is the fact itself.
        receiptsAllowed = false;
        await markRead(ada, { channelId: "c1", messageId: "m3" });
        expect(announced.at(-1)?.audience).toEqual(["ada"]);
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
        // Still announced, and to nobody but the reader: the count in the rail is
        // not a one-to-one feature, and nothing in a channel of fifty draws who
        // has read what.
        expect(announced).toHaveLength(1);
        expect(announced[0]?.audience).toEqual(["ada"]);
    });
});

describe("the ticks, asked for on their own", () => {
    it("answers for the reader's own messages", async () => {
        others = [{ userId: "grace", lastReadAt: messages[1]!.createdAt, lastDeliveredAt: null }];
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
        others = [{ userId: "grace", lastReadAt: messages[1]!.createdAt, lastDeliveredAt: null }];

        const delivery = await deliveryOf(ada, "m2");
        expect(delivery).toEqual({
            sentAt: messages[1]!.createdAt.toISOString(),
            deliveredAt: delivered.toISOString(),
            readAt: read.toISOString(),
            state: "read",
            readers: null
        });
    });

    it("say how far it got even when the moments were never recorded", async () => {
        others = [{ userId: "grace", lastReadAt: messages[1]!.createdAt, lastDeliveredAt: null }];
        const delivery = await deliveryOf(ada, "m2");
        // An old message: read, and nobody wrote down when.
        expect(delivery).toMatchObject({ state: "read", readAt: null, deliveredAt: null });
    });

    it("are nobody else's message to ask about", async () => {
        expect(await deliveryOf(ada, "m1")).toBeNull();
    });
});

describe("in a group", () => {
    const at = (row: number) => messages[row]!.createdAt;

    beforeEach(() => {
        kind = "group";
        others = [
            { userId: "grace", lastReadAt: null, lastDeliveredAt: null },
            { userId: "linus", lastReadAt: null, lastDeliveredAt: null }
        ];
    });

    it("turns read only once every other member has read it", async () => {
        others[0]!.lastReadAt = at(1);
        others[1]!.lastDeliveredAt = at(1);
        expect(await receiptsFor(ada, "c1", ["m2"])).toEqual({ m2: "delivered" });
        others[1]!.lastReadAt = at(2);
        expect(await receiptsFor(ada, "c1", ["m2"])).toEqual({ m2: "read" });
    });

    it("never counts a member whose ticks are withheld as having read it", async () => {
        others[0]!.lastReadAt = at(1);
        others[1]!.lastReadAt = at(1);
        hidden = new Set(["linus"]);
        expect(await receiptsFor(ada, "c1", ["m2"])).toEqual({ m2: "delivered" });

        const delivery = await deliveryOf(ada, "m2");
        expect(delivery?.readers).toEqual([
            { id: "grace", name: "Grace", state: "read" },
            { id: "linus", name: "Linus", state: "unknown" }
        ]);
    });

    it("keeps a read tick when a member puts the conversation back to unread", async () => {
        others[0]!.lastReadAt = at(0);
        others[0]!.lastSeenAt = at(2);
        others[1]!.lastReadAt = at(2);
        expect(await receiptsFor(ada, "c1", ["m2"])).toEqual({ m2: "read" });
    });

    it("shows nothing to a reader who withholds their own", async () => {
        receiptsAllowed = false;
        expect(await receiptsFor(ada, "c1", ["m2"])).toEqual({});
        expect(await deliveryOf(ada, "m2")).toBeNull();
    });

    it("lists who has read it, read first", async () => {
        others[1]!.lastReadAt = at(1);
        const delivery = await deliveryOf(ada, "m2");
        expect(delivery?.state).toBe("sent");
        expect(delivery?.readers).toEqual([
            { id: "linus", name: "Linus", state: "read" },
            { id: "grace", name: "Grace", state: "sent" }
        ]);
    });

    it("tells the members whose ticks a read moves, and nobody withheld", async () => {
        hidden = new Set(["linus"]);
        await markRead(ada, { channelId: "c1", messageId: "m3" });
        expect(announced.at(-1)?.audience).toEqual(["ada", "grace"]);
        // Nothing is stamped on a group message: the marks answer it.
        expect(stamped).toHaveLength(0);
    });

    it("has no ticks past the cap", async () => {
        others = Array.from({ length: GROUP_RECEIPT_MAX_MEMBERS }, (_, index) => ({
            userId: `member-${index}`,
            lastReadAt: at(2),
            lastDeliveredAt: at(2)
        }));
        expect(await receiptsFor(ada, "c1", ["m2"])).toEqual({});
        await markRead(ada, { channelId: "c1", messageId: "m3" });
        expect(announced.at(-1)?.audience).toEqual(["ada"]);
    });
});
