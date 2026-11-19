/**
 * A line Polaris wrote is reacted to and answered like any message.
 *
 * "The call ended after 1 hour 48 minutes" and "Grace joined" used to be inert:
 * no hover, no bar, no menu. They now take a reaction and a reply the way
 * Discord's do, so the server has to take both - under the same checks a
 * person's message gets, nothing looser - and the quote over a reply has to say
 * the sentence rather than "somebody who has left" over a row of mentions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The message module is a large graph and the first import pays for it; under
// the parallel suite that can outrun the default timeout without anything
// hanging.
vi.setConfig({ testTimeout: 15000 });

vi.mock("@/lib/privacy-service", () => ({
    receiptsBetween: async () => null,
    maySee: async () => true,
    allowedBy: async (_viewer: unknown, _field: string, ids: readonly string[]) => new Set(ids)
}));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return { ...actual, reachableChannelIds: async () => new Set(["channel-1"]) };
});
vi.mock("@/lib/chat/rules", () => ({
    rulesForChannel: async () => ({
        keepEditHistory: false,
        maxMessageLength: 4000,
        maxPerMinute: 0,
        deleteLeavesTrace: true,
        editWindowMinutes: 0
    })
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/room-mentions", () => ({
    announceRoomMention: async () => undefined,
    refuseRoomMention: async () => undefined
}));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => undefined
}));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

const SENT = new Date("2026-11-17T00:11:00Z");

/** The line being answered: Grace started a call. Nobody wrote it. */
const line = {
    id: "notice-1",
    channelId: "channel-1",
    authorId: null as string | null,
    kind: "system",
    body: "[Grace H](polaris:user/grace) started a call",
    parentId: null,
    replyToId: null as string | null,
    forwarded: false,
    attachments: [] as { id: string }[],
    replyCount: 0,
    lastReplyAt: null,
    editedAt: null,
    deletedAt: null as Date | null,
    createdAt: SENT,
    expiresAt: null
};

/** Ada's reply to it. */
const reply = {
    ...line,
    id: "reply-1",
    authorId: "ada" as string | null,
    kind: "text",
    body: "good call",
    replyToId: "notice-1"
};

/** Whether the conversation lets Ada write, which is the one gate both actions share. */
let membership: { role: string } | null;
let reactions: Record<string, unknown>[];
let written: Record<string, unknown> | undefined;

vi.mock("@polaris/db", () => {
    const client = {
        userBlock: { findMany: async () => [] },
        chatChannel: {
            findMany: async () => [],
            findUnique: async () => ({
                id: "channel-1",
                spaceId: null,
                kind: "group",
                ownerId: null,
                private: true,
                archived: false,
                space: null
            }),
            update: async () => undefined
        },
        chatChannelMember: {
            findUnique: async () => membership,
            findFirst: async () => null,
            findMany: async () => [],
            updateMany: async () => undefined,
            upsert: async () => undefined
        },
        setting: { findUnique: async () => null },
        chatMessage: {
            findUnique: async () => line,
            findFirst(args: { where?: { id?: unknown } } = {}) {
                return typeof args.where?.id === "string"
                    ? this.findUnique(args as never)
                    : Promise.resolve(null);
            },
            findMany: async ({ where }: { where?: { id?: { in?: string[] } } }) =>
                where?.id?.in?.includes(line.id) ? [line] : [],
            count: async () => 0,
            create: async ({ data }: { data?: Record<string, unknown> } = {}) => {
                written = data;
                return { id: "reply-1", createdAt: SENT };
            },
            update: async () => line
        },
        chatReaction: {
            findMany: async () => [],
            findFirst: async () => null,
            findUnique: async () => null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                reactions.push(data);
                return { id: "reaction-1" };
            },
            delete: async () => undefined
        },
        chatAttachment: { findMany: async () => [] },
        chatStar: { findMany: async () => [] },
        user: {
            findMany: async () => [
                { id: "grace", name: "Grace Hopper" },
                { id: "ada", name: "Ada" }
            ]
        },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client)
    };
    return { prisma: client };
});

const { decorateMessages, react, send } = await import("@/lib/chat/messages");

const ada = { id: "ada" };

beforeEach(() => {
    membership = { role: "member" };
    reactions = [];
    written = undefined;
    line.deletedAt = null;
    line.kind = "system";
    line.authorId = null;
    line.body = "[Grace H](polaris:user/grace) started a call";
});

describe("reacting to a line Polaris wrote", () => {
    it("is taken like a reaction to anybody's message", async () => {
        await expect(react(ada, { messageId: line.id, emoji: "👍" })).resolves.toBe(true);
        expect(reactions).toEqual([{ messageId: line.id, userId: "ada", emoji: "👍" }]);
    });

    it("is refused to somebody who may not write here, as any reaction is", async () => {
        membership = null;
        await expect(react(ada, { messageId: line.id, emoji: "👍" })).rejects.toThrow();
        expect(reactions).toHaveLength(0);
    });
});

describe("replying to a line Polaris wrote", () => {
    it("writes the reply pointing at it", async () => {
        await send(
            ada,
            { channelId: "channel-1", body: "good call" },
            [],
            { messageId: line.id, forwarded: false }
        );
        expect(written).toMatchObject({ replyToId: line.id, forwarded: false, kind: "text" });
    });

    it("is refused once the line is gone, as any reply is", async () => {
        line.deletedAt = SENT;
        await expect(
            send(ada, { channelId: "channel-1", body: "good call" }, [], {
                messageId: line.id,
                forwarded: false
            })
        ).rejects.toThrow();
        expect(written).toBeUndefined();
    });
});

describe("the quote over a reply to one", () => {
    it("says the sentence as the reader reads it, with nobody named as its author", async () => {
        const [view] = await decorateMessages(ada, [reply]);
        expect(view?.quote).toMatchObject({
            id: line.id,
            channelId: "channel-1",
            authorName: null,
            excerpt: "Grace Hopper started a call",
            deleted: false,
            notice: true
        });
    });

    it("says 'You' to the person the line is about", async () => {
        const [view] = await decorateMessages({ id: "grace" }, [reply]);
        expect(view?.quote?.excerpt).toBe("You started a call");
    });

    it("quotes a line drawn as a card as nothing, not as its marker", async () => {
        line.body = "polaris-activity:0190a1b2-0000-7000-8000-000000000001";
        const [view] = await decorateMessages(ada, [reply]);
        expect(view?.quote).toMatchObject({ excerpt: "", notice: true });
    });

    it("is not marked as one over a reply to somebody's message", async () => {
        line.kind = "text";
        line.authorId = "grace";
        line.body = "hello";
        const [view] = await decorateMessages(ada, [reply]);
        expect(view?.quote).toMatchObject({ authorName: "Grace Hopper", excerpt: "hello" });
        expect(view?.quote?.notice).toBeUndefined();
    });
});
