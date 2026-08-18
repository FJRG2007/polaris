/**
 * Answering a message that is no longer there.
 *
 * Both menus already hide Reply on a deleted message, which covers everything
 * except the case that actually happens: the message is taken back while somebody
 * has the reply box open. Nothing stopped that reply, so what landed was a quote
 * of a tombstone - a line reading "message deleted" above an answer to nothing,
 * and a way to keep a deleted message present in the conversation after its author
 * had taken it out.
 *
 * The rule is only about NEW replies. A reply written before the deletion keeps
 * its quote and keeps saying "message deleted", because that is what makes the
 * rest of the conversation readable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MessageRow {
    id: string;
    channelId: string;
    parentId: string | null;
    replyToId: string | null;
    deletedAt: Date | null;
    authorId: string | null;
    replyCount: number;
}

let messages: MessageRow[] = [];
let created: Record<string, unknown> | null = null;

vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return {
        ...actual,
        requireChannel: async () => ({ channelId: "c1", mayPost: true, mayModerate: false }),
        requirePostable: async () => ({ channelId: "c1", mayPost: true, mayModerate: false })
    };
});
vi.mock("@/lib/chat/rules", () => ({
    rulesForChannel: async () => ({
        maxMessageLength: 4000,
        maxPerMinute: 0,
        maxAttachments: 5,
        maxAttachmentMib: 20,
        editWindowMinutes: 0,
        deleteLeavesTrace: true,
        keepEditHistory: true
    })
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/room-mentions", () => ({ announceRoomMention: async () => undefined }));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => null
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async () => true,
    maySee: async () => true,
    receiptsBetween: async () => new Map()
}));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                messages.find((row) => row.id === where.id) ?? null,
            findMany: async () => [],
            create: async ({ data }: { data: Record<string, unknown> }) => {
                created = data;
                return { id: "new", createdAt: new Date() };
            },
            update: async () => undefined,
            count: async () => 0
        },
        chatChannel: {
            update: async () => undefined,
            // Read by the send path for the room's own wait between messages.
            findUnique: async () => ({ slowmode: 0 })
        },
        chatChannelMember: { updateMany: async () => undefined, findMany: async () => [] },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
            run({
                chatMessage: {
                    create: async ({ data }: { data: Record<string, unknown> }) => {
                        created = data;
                        return { id: "new", createdAt: new Date() };
                    },
                    update: async () => undefined
                },
                chatChannel: { update: async () => undefined },
                chatChannelMember: {
                    updateMany: async () => undefined,
                    upsert: async () => undefined
                }
            })
    }
}));

const { send } = await import("@/lib/chat/messages");

const actor = { id: "u1" };
const input = { channelId: "c1", body: "sure", parentId: null };

function message(id: string, deleted: boolean, parentId: string | null = null): MessageRow {
    return {
        id,
        channelId: "c1",
        parentId,
        replyToId: null,
        deletedAt: deleted ? new Date() : null,
        authorId: "u2",
        replyCount: 0
    };
}

beforeEach(() => {
    created = null;
    messages = [message("live", false), message("gone", true)];
});

describe("replying", () => {
    it("quotes a message that is still there", async () => {
        await send(actor, input, [], { messageId: "live", forwarded: false });
        expect(created?.replyToId).toBe("live");
    });

    it("refuses to quote one that was deleted", async () => {
        await expect(
            send(actor, input, [], { messageId: "gone", forwarded: false })
        ).rejects.toThrow(/deleted/i);
        expect(created).toBeNull();
    });

    it("refuses to answer in a thread whose root was deleted", async () => {
        await expect(send(actor, { ...input, parentId: "gone" }, [])).rejects.toThrow(/deleted/i);
        expect(created).toBeNull();
    });

    it("still answers in a thread whose root is there", async () => {
        await send(actor, { ...input, parentId: "live" }, []);
        expect(created?.parentId).toBe("live");
    });
});
