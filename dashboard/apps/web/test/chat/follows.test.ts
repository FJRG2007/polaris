/**
 * Announcement channels: who may follow one into where, who may publish, and
 * that a message published twice reaches each follower once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface ChannelRow {
    id: string;
    name: string;
    kind: string;
    spaceId: string | null;
    membersMaySend: boolean;
    archived: boolean;
}

const state = {
    channels: new Map<string, ChannelRow>(),
    admins: new Set<string>(),
    follows: [] as { id: string; sourceChannelId: string; targetChannelId: string }[],
    message: null as Record<string, unknown> | null,
    copies: new Set<string>(),
    created: [] as Record<string, unknown>[]
};

function channel(row: Partial<ChannelRow> & { id: string }): ChannelRow {
    return { name: row.id, kind: "text", spaceId: "space-a", membersMaySend: true, archived: false, ...row };
}

function reset(): void {
    state.channels = new Map(
        [
            channel({ id: "news", spaceId: "space-a", membersMaySend: false }),
            channel({ id: "plain", spaceId: "space-a" }),
            channel({ id: "mine", spaceId: "space-b" }),
            channel({ id: "voice-b", spaceId: "space-b", kind: "voice" }),
            channel({ id: "theirs", spaceId: "space-c" })
        ].map((row) => [row.id, row])
    );
    state.admins = new Set(["space-b"]);
    state.follows = [];
    state.message = {
        id: "m-1",
        channelId: "news",
        kind: "text",
        body: "Release day",
        parentId: null,
        deletedAt: null,
        audience: [],
        publishedFromId: null,
        attachments: []
    };
    state.copies = new Set();
    state.created = [];
}

vi.mock("@/lib/chat/access", () => {
    class ChatAccessError extends Error {
        constructor(readonly text: { key: string } = { key: "errors.notInConversation" }) {
            super(text.key);
        }
    }
    class ChatRuleError extends ChatAccessError {}
    return {
        ChatAccessError,
        ChatRuleError,
        requireChannel: async (_actor: unknown, id: string) => {
            const row = state.channels.get(id);
            if (!row) throw new ChatAccessError();
            return { channelId: id, spaceId: row.spaceId, kind: row.kind, archived: row.archived };
        },
        requireSpace: async (_actor: unknown, spaceId: string) => {
            if (!state.admins.has(spaceId)) throw new ChatAccessError({ key: "errors.spaceAdminOnly" });
            return "admin";
        },
        spaceAccess: async (_actor: unknown, spaceId: string) => (state.admins.has(spaceId) ? "admin" : "member"),
        reachableSpaceIds: async () => new Set(["space-a", "space-b"])
    };
});

vi.mock("@/lib/chat/live", () => ({ publishChatChange: vi.fn() }));
vi.mock("@/lib/chat/chat-lock", () => ({ unhideOnMessage: vi.fn(async () => undefined) }));

vi.mock("@polaris/db", () => {
    class PrismaClientKnownRequestError extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    }
    const key = (where: { sourceChannelId_targetChannelId: { sourceChannelId: string; targetChannelId: string } }) =>
        where.sourceChannelId_targetChannelId;
    const tx = {
        chatMessage: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const unique = `${data.channelId}:${data.publishedFromId}`;
                if (state.copies.has(unique)) throw new PrismaClientKnownRequestError("P2002");
                state.copies.add(unique);
                state.created.push(data);
                return { createdAt: new Date() };
            }
        },
        chatChannel: { update: async () => ({}) }
    };
    return {
        Prisma: { PrismaClientKnownRequestError },
        prisma: {
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
            chatChannel: {
                findUnique: async ({ where }: { where: { id: string } }) => {
                    const row = state.channels.get(where.id);
                    return row ? { ...row, space: { name: `Space ${row.spaceId}` } } : null;
                }
            },
            chatMessage: { findUnique: async () => state.message },
            chatChannelFollow: {
                findUnique: async ({ where }: { where: Parameters<typeof key>[0] }) => {
                    const pair = key(where);
                    const row = state.follows.find(
                        (follow) =>
                            follow.sourceChannelId === pair.sourceChannelId &&
                            follow.targetChannelId === pair.targetChannelId
                    );
                    if (!row) return null;
                    return {
                        id: row.id,
                        source: { spaceId: state.channels.get(row.sourceChannelId)?.spaceId ?? null },
                        target: { spaceId: state.channels.get(row.targetChannelId)?.spaceId ?? null }
                    };
                },
                count: async () => state.follows.length,
                upsert: async ({ create }: { create: { sourceChannelId: string; targetChannelId: string } }) => {
                    const row = { id: `f-${state.follows.length + 1}`, ...create };
                    state.follows.push(row);
                    return { id: row.id };
                },
                deleteMany: async ({ where }: { where: { id: string } }) => {
                    state.follows = state.follows.filter((row) => row.id !== where.id);
                    return { count: 1 };
                },
                findMany: async () => state.follows.map((row) => ({ targetChannelId: row.targetChannelId }))
            }
        }
    };
});

const follows = await import("@/lib/chat/follows");
const me = { id: "ada" };

beforeEach(reset);

describe("following an announcement channel", () => {
    it("follows into a text channel the follower administers, once", async () => {
        const first = await follows.follow(me, { sourceChannelId: "news", targetChannelId: "mine" });
        const again = await follows.follow(me, { sourceChannelId: "news", targetChannelId: "mine" });
        expect(again).toBe(first);
        expect(state.follows).toHaveLength(1);
    });

    it("refuses a source that is not an announcement channel", async () => {
        await expect(follows.follow(me, { sourceChannelId: "plain", targetChannelId: "mine" })).rejects.toThrow(
            "errors.follow.notAnnouncement"
        );
    });

    it("refuses a target that is not text, or in a space the follower does not run", async () => {
        await expect(follows.follow(me, { sourceChannelId: "news", targetChannelId: "voice-b" })).rejects.toThrow(
            "errors.follow.badTarget"
        );
        state.channels.set("theirs", channel({ id: "theirs", spaceId: "space-c" }));
        await expect(follows.follow(me, { sourceChannelId: "news", targetChannelId: "theirs" })).rejects.toThrow(
            "errors.spaceAdminOnly"
        );
        await expect(follows.follow(me, { sourceChannelId: "news", targetChannelId: "news" })).rejects.toThrow(
            "errors.follow.badTarget"
        );
    });

    it("stops at the follower cap", async () => {
        const core = await import("@polaris/core");
        for (let index = 0; index < core.MAX_CHANNEL_FOLLOWERS; index++) {
            state.follows.push({ id: `x-${index}`, sourceChannelId: "news", targetChannelId: `t-${index}` });
        }
        await expect(follows.follow(me, { sourceChannelId: "news", targetChannelId: "mine" })).rejects.toThrow(
            "errors.follow.tooMany"
        );
    });

    it("lets only an administrator of either side unfollow", async () => {
        state.follows.push({ id: "f-1", sourceChannelId: "news", targetChannelId: "mine" });
        state.admins = new Set();
        await expect(follows.unfollow(me, { sourceChannelId: "news", targetChannelId: "mine" })).rejects.toThrow(
            "errors.spaceAdminOnly"
        );
        state.admins = new Set(["space-a"]);
        await follows.unfollow(me, { sourceChannelId: "news", targetChannelId: "mine" });
        expect(state.follows).toHaveLength(0);
    });
});

describe("publishing", () => {
    beforeEach(() => {
        state.follows.push({ id: "f-1", sourceChannelId: "news", targetChannelId: "mine" });
        state.follows.push({ id: "f-2", sourceChannelId: "news", targetChannelId: "plain" });
        state.admins = new Set(["space-a"]);
    });

    it("copies the message to every follower, signed and linked to its origin", async () => {
        expect(await follows.publish(me, { messageId: "m-1" })).toEqual({ delivered: 2, already: 0 });
        expect(state.created[0]).toMatchObject({
            authorId: null,
            body: "Release day",
            authorLabel: "Space space-a · #news",
            publishedFromId: "m-1",
            publishedFromChannelId: "news"
        });
    });

    it("delivers a message published twice only once", async () => {
        await follows.publish(me, { messageId: "m-1" });
        expect(await follows.publish(me, { messageId: "m-1" })).toEqual({ delivered: 0, already: 2 });
        expect(state.created).toHaveLength(2);
    });

    it("refuses anybody who does not administer the source", async () => {
        state.admins = new Set(["space-b"]);
        await expect(follows.publish(me, { messageId: "m-1" })).rejects.toThrow("errors.spaceAdminOnly");
        expect(state.created).toHaveLength(0);
    });

    it("refuses a thread reply, a copy, and a message with files", async () => {
        state.message = { ...state.message, parentId: "root" };
        await expect(follows.publish(me, { messageId: "m-1" })).rejects.toThrow("errors.follow.notPublishable");
        state.message = { ...state.message, parentId: null, publishedFromId: "elsewhere" };
        await expect(follows.publish(me, { messageId: "m-1" })).rejects.toThrow("errors.follow.notPublishable");
        state.message = { ...state.message, publishedFromId: null, attachments: [{ id: "file" }] };
        await expect(follows.publish(me, { messageId: "m-1" })).rejects.toThrow("errors.follow.filesNotPublished");
    });

    it("refuses a message from a channel that is not an announcement channel", async () => {
        state.message = { ...state.message, channelId: "plain" };
        await expect(follows.publish(me, { messageId: "m-1" })).rejects.toThrow("errors.follow.notAnnouncement");
    });
});
