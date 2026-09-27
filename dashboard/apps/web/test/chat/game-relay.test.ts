/**
 * Which Chat messages are shown to their readers inside a game.
 *
 * Exactly the ones the corner note would have been for - the same mute, the same
 * notify level, the same blocks - and only for accounts that turned it on. What
 * is pinned: the author never gets their own; a muted conversation, one set to
 * nothing, and one set to mentions without a mention stay quiet; a blocked
 * author reaches nobody; and nothing is asked at all where no app can show it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const AUTHOR = "11111111-1111-4111-8111-111111111111";
const ANA = "22222222-2222-4222-8222-222222222222";
const BEN = "33333333-3333-4333-8333-333333333333";

const fake = vi.hoisted(() => ({
    offered: true,
    message: null as null | Record<string, unknown>,
    readers: [] as { userId: string; muted: boolean; mutedUntil: Date | null }[],
    levels: new Map<string, string>(),
    blocked: new Map<string, Set<string>>(),
    relayed: [] as Record<string, unknown>[],
    asked: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: { findUnique: async () => fake.message },
        chatChannelMember: {
            findMany: async (query: unknown) => {
                fake.asked.push(query);
                return fake.readers;
            }
        },
        user: { findUnique: async () => ({ name: "Carla" }) }
    }
}));
vi.mock("@/lib/app-extensions/registry", () => ({
    relaysChatToGames: async () => fake.offered,
    relayChatMessage: async (message: Record<string, unknown>) => {
        fake.relayed.push(message);
    }
}));
vi.mock("@/lib/chat/notify", () => ({
    notifyLevels: async (userId: string, ids: string[]) =>
        new Map(ids.map((id) => [id, fake.levels.get(userId) ?? "all"])),
    readerTeams: async () => new Set<string>(),
    mentionsReader: (body: string, userId: string) => body.includes(`@${userId}`)
}));
vi.mock("@/lib/blocks", () => ({
    blockedBy: async (userId: string) => fake.blocked.get(userId) ?? new Set()
}));

const { relayToGames } = await import("@/lib/chat/game-relay");

function message(body: string, overrides: Record<string, unknown> = {}) {
    return {
        id: "m1",
        body,
        authorId: AUTHOR,
        channelId: "c1",
        deletedAt: null,
        attachments: [],
        channel: {
            spaceId: null,
            name: "",
            members: [
                { userId: AUTHOR, user: { name: "Carla" } },
                { userId: ANA, user: { name: "Ana" } },
                { userId: BEN, user: { name: "Ben" } }
            ]
        },
        ...overrides
    };
}

beforeEach(() => {
    fake.offered = true;
    fake.message = message("see you at spawn");
    fake.readers = [
        { userId: ANA, muted: false, mutedUntil: null },
        { userId: BEN, muted: false, mutedUntil: null }
    ];
    fake.levels = new Map();
    fake.blocked = new Map();
    fake.relayed = [];
    fake.asked = [];
});

describe("relaying a message into a game", () => {
    it("reaches every reader who turned it on, as their side of the conversation reads", async () => {
        await relayToGames("m1");
        expect(fake.relayed).toEqual([
            { userId: ANA, author: "Carla", conversation: "Carla, Ben", inChannel: false, text: "see you at spawn" },
            { userId: BEN, author: "Carla", conversation: "Carla, Ana", inChannel: false, text: "see you at spawn" }
        ]);
    });

    it("only asks for readers who turned it on, and never the author", async () => {
        await relayToGames("m1");
        expect(fake.asked[0]).toMatchObject({
            where: { channelId: "c1", userId: { not: AUTHOR }, user: { messagesInGame: true } }
        });
    });

    it("stays quiet where the corner note would", async () => {
        fake.readers = [
            { userId: ANA, muted: true, mutedUntil: null },
            { userId: BEN, muted: false, mutedUntil: null }
        ];
        fake.levels.set(BEN, "none");
        await relayToGames("m1");
        expect(fake.relayed).toEqual([]);
    });

    it("keeps a conversation followed for mentions to the messages that name the reader", async () => {
        fake.levels.set(ANA, "mentions");
        fake.levels.set(BEN, "mentions");
        fake.message = message(`over here @${BEN}`);
        await relayToGames("m1");
        expect(fake.relayed.map((one) => one.userId)).toEqual([BEN]);
    });

    it("does not carry a blocked author's message", async () => {
        fake.blocked.set(ANA, new Set([AUTHOR]));
        await relayToGames("m1");
        expect(fake.relayed.map((one) => one.userId)).toEqual([BEN]);
    });

    it("asks nothing where no installed app can show a message in a game", async () => {
        fake.offered = false;
        await relayToGames("m1");
        expect(fake.asked).toEqual([]);
        expect(fake.relayed).toEqual([]);
    });

    it("leaves a deleted message alone", async () => {
        fake.message = message("gone", { deletedAt: new Date() });
        await relayToGames("m1");
        expect(fake.relayed).toEqual([]);
    });
});
