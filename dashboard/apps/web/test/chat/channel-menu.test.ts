/**
 * What a right-click on a channel does on the server: duplicating it, and
 * catching up on it from the list.
 *
 * A duplicate is the same room under a new name - settings, the people of a
 * private one, the access rules - and never what was said in it. It is an
 * administrator's, and a name already used in the space is refused rather than
 * made twice.
 *
 * Marking read from the list skips a channel the reader cannot open instead of
 * failing the whole heading, and marks up to the newest message in the channel
 * itself, where the badge counts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let administers = true;
let spaceOf: string | null = "space-1";
let clash = false;
let nextOrder: number | null = 20;
let source: Row = {};
let grants: Row[] = [];
let created: Row = {};
let copiedGrants: Row[] = [];
let reachable = new Set<string>();
let marked: string[] = [];

vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));

vi.mock("@/lib/chat/access", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/chat/access")>();
    const access = (channelId: string) => ({
        channelId,
        spaceId: spaceOf,
        kind: "text",
        archived: false,
        member: true,
        mayPost: true,
        mayAdminister: administers
    });
    return {
        ...real,
        requireChannel: async (_actor: unknown, channelId: string) => access(channelId),
        channelAccess: async (_actor: unknown, channelId: string) =>
            reachable.has(channelId) ? access(channelId) : null,
        requireSpace: async () => {
            if (!administers) throw new real.ChatAccessError("Only an admin of this space can do that");
            return "admin";
        }
    };
});

const tx = {
    chatChannel: {
        create: async ({ data }: { data: Row }) => {
            created = data;
            return { id: "channel-copy" };
        }
    },
    accessGrant: {
        findMany: async () => grants,
        createMany: async ({ data }: { data: Row[] }) => {
            copiedGrants = data;
            return { count: data.length };
        }
    }
};

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findUniqueOrThrow: async () => source,
            findFirst: async ({ where }: { where: Row }) => {
                if ("name" in where) return clash ? { id: "other" } : null;
                return nextOrder === null ? null : { order: nextOrder };
            }
        },
        chatMessage: {
            findFirst: async ({ where }: { where: { channelId: string; id?: string } }) =>
                where.id
                    ? { createdAt: new Date("2026-09-29T10:00:00Z") }
                    : { id: `${where.channelId}-newest` },
            updateMany: async () => ({ count: 0 })
        },
        chatChannelMember: {
            findUnique: async () => null,
            findFirst: async () => null,
            upsert: async ({ update }: { update: { lastReadMessageId: string } }) => {
                marked.push(update.lastReadMessageId);
                return {};
            }
        },
        $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
    }
}));

const chat = await import("@/lib/chat/chat-service");
const messages = await import("@/lib/chat/messages");
const { freeCopyName } = await import("@/lib/chat/copy-name");

const ada = { id: "ada" };

beforeEach(() => {
    administers = true;
    spaceOf = "space-1";
    clash = false;
    nextOrder = 20;
    grants = [];
    created = {};
    copiedGrants = [];
    reachable = new Set();
    marked = [];
    source = {
        spaceId: "space-1",
        categoryId: "category-1",
        kind: "voice",
        topic: "Friday games",
        private: false,
        slowmode: 30,
        userLimit: 8,
        order: 10,
        members: [{ userId: "grace", role: "member" }]
    };
});

describe("duplicating a channel", () => {
    it("copies its settings under the new name, straight under the original", async () => {
        const id = await chat.duplicateChannel(ada, { channelId: "channel-1", name: "games-2" });
        expect(id).toBe("channel-copy");
        expect(created).toMatchObject({
            spaceId: "space-1",
            categoryId: "category-1",
            name: "games-2",
            kind: "voice",
            topic: "Friday games",
            private: false,
            slowmode: 30,
            userLimit: 8,
            order: 15,
            createdById: "ada"
        });
        // An open channel's member rows are read marks and mutes, not access.
        expect(created.members).toBeUndefined();
    });

    it("goes after the last one when nothing follows it", async () => {
        nextOrder = null;
        await chat.duplicateChannel(ada, { channelId: "channel-1", name: "games-2" });
        expect(created.order).toBe(10 + 1024);
    });

    it("keeps the people of a private channel, and the one who copied it", async () => {
        source = { ...source, private: true };
        await chat.duplicateChannel(ada, { channelId: "channel-1", name: "games-2" });
        expect(created.members).toEqual({
            create: [
                { userId: "grace", role: "member" },
                { userId: "ada", role: "admin" }
            ]
        });
    });

    it("copies the access rules, with nothing used up yet", async () => {
        grants = [
            {
                id: "grant-1",
                subjectType: "chat.channel",
                subjectId: "channel-1",
                principalType: "user",
                principalId: "grace",
                capability: "read",
                uses: 3,
                lastUsedAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                grantedById: "someone"
            }
        ];
        await chat.duplicateChannel(ada, { channelId: "channel-1", name: "games-2" });
        expect(copiedGrants).toEqual([
            {
                subjectType: "chat.channel",
                subjectId: "channel-copy",
                principalType: "user",
                principalId: "grace",
                capability: "read",
                grantedById: "ada"
            }
        ]);
    });

    it("refuses a name already used in the space", async () => {
        clash = true;
        await expect(
            chat.duplicateChannel(ada, { channelId: "channel-1", name: "games" })
        ).rejects.toThrow("A channel with that name is already here");
    });

    it("refuses somebody who does not run the space", async () => {
        administers = false;
        await expect(
            chat.duplicateChannel(ada, { channelId: "channel-1", name: "games-2" })
        ).rejects.toThrow(/admin/);
    });

    it("refuses a conversation that is not in a space", async () => {
        spaceOf = null;
        await expect(
            chat.duplicateChannel(ada, { channelId: "channel-1", name: "games-2" })
        ).rejects.toThrow("Only a channel in a space can be duplicated");
    });
});

describe("the name a copy is offered", () => {
    it("takes the first number nobody in the space has used", () => {
        expect(freeCopyName("games", new Set(["games", "games-2"]))).toBe("games-3");
    });

    it("stays whole and free at the length limit", () => {
        const long = "a".repeat(60);
        const offered = freeCopyName(long, new Set([long]));
        expect(offered).toHaveLength(60);
        expect(offered.endsWith("-2")).toBe(true);
    });
});

describe("marking conversations read from the list", () => {
    it("marks each one it can open up to its newest message, and skips the rest", async () => {
        reachable = new Set(["channel-1", "channel-3"]);
        await messages.markChannelsRead(ada, {
            channelIds: ["channel-1", "channel-2", "channel-3", "channel-1"]
        });
        expect(marked).toEqual(["channel-1-newest", "channel-3-newest"]);
    });
});
