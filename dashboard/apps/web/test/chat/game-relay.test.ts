/**
 * Which Chat messages are shown to their readers inside a game.
 *
 * Exactly the ones the corner note would have been for - the same mute, the same
 * notify level, the same blocks - and only for accounts that turned it on. What
 * is pinned: the author never gets their own; a reader of a public channel with
 * no row on it is reached, and one who lost the conversation or Chat is not; a
 * muted conversation, one set to nothing, and one set to mentions without a
 * mention stay quiet; a blocked author reaches nobody; and nothing is asked at
 * all where no app can show it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const AUTHOR = "11111111-1111-4111-8111-111111111111";
const ANA = "22222222-2222-4222-8222-222222222222";
const BEN = "33333333-3333-4333-8333-333333333333";
const DANI = "44444444-4444-4444-8444-444444444444";

interface Member {
    userId: string;
    name: string;
    muted: boolean;
    mutedUntil: Date | null;
}

interface MemberQuery {
    where: { userId?: { not?: string; in?: string[] } };
    select: Record<string, unknown>;
}

const fake = vi.hoisted(() => ({
    offered: true,
    message: null as null | Record<string, unknown>,
    members: [] as Member[],
    optedIn: new Set<string>(),
    reaches: new Map<string, Set<string>>(),
    chatUse: new Set<string>(),
    levels: new Map<string, string>(),
    blocked: new Map<string, Set<string>>(),
    relayed: [] as Record<string, unknown>[],
    asked: [] as unknown[],
    namesRead: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: { findUnique: async () => fake.message },
        chatChannelMember: {
            findMany: async (query: MemberQuery) => {
                fake.asked.push(query);
                if (query.select.user) {
                    fake.namesRead += 1;
                    return fake.members.map((member) => ({ userId: member.userId, user: { name: member.name } }));
                }
                const only = query.where.userId?.in;
                if (only) return fake.members.filter((member) => only.includes(member.userId));
                return fake.members
                    .filter((member) => member.userId !== query.where.userId?.not && fake.optedIn.has(member.userId))
                    .map((member) => ({ userId: member.userId }));
            }
        },
        user: {
            findUnique: async () => ({ name: "Carla" }),
            findMany: async (query: { where: { id: { not: string } } }) => {
                fake.asked.push(query);
                return [...fake.optedIn].filter((id) => id !== query.where.id.not).map((id) => ({ id }));
            }
        }
    }
}));
vi.mock("@/lib/app-extensions/registry", () => ({
    chatRelayer: async () =>
        fake.offered
            ? async (message: Record<string, unknown>) => {
                  fake.relayed.push(message);
              }
            : null
}));
vi.mock("@/lib/chat/access", () => ({
    messageable: async (ids: string[]) => new Set(ids.filter((id) => fake.chatUse.has(id))),
    reachableChannelIds: async (actor: { id: string }) => fake.reaches.get(actor.id) ?? new Set()
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
        channel: { spaceId: null, name: "" },
        ...overrides
    };
}

function member(userId: string, name: string, muted = false): Member {
    return { userId, name, muted, mutedUntil: null };
}

beforeEach(() => {
    fake.offered = true;
    fake.message = message("see you at spawn");
    fake.members = [member(AUTHOR, "Carla"), member(ANA, "Ana"), member(BEN, "Ben")];
    fake.optedIn = new Set([ANA, BEN]);
    fake.reaches = new Map([AUTHOR, ANA, BEN, DANI].map((id) => [id, new Set(["c1"])]));
    fake.chatUse = new Set([AUTHOR, ANA, BEN, DANI]);
    fake.levels = new Map();
    fake.blocked = new Map();
    fake.relayed = [];
    fake.asked = [];
    fake.namesRead = 0;
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

    it("reads nobody's name when nobody turned it on", async () => {
        fake.optedIn = new Set();
        await relayToGames("m1");
        expect(fake.namesRead).toBe(0);
        expect(fake.relayed).toEqual([]);
    });

    it("reaches a reader of a public channel they never joined, and reads no member list for it", async () => {
        fake.message = message("raid at dusk", { channel: { spaceId: "s1", name: "builders" } });
        fake.optedIn = new Set([ANA, DANI]);
        await relayToGames("m1");
        expect(fake.relayed.map((one) => one.userId)).toEqual([ANA, DANI]);
        expect(fake.relayed[1]).toMatchObject({ conversation: "builders", inChannel: true });
        expect(fake.namesRead).toBe(0);
    });

    it("skips an account that no longer reaches the conversation or has lost Chat", async () => {
        fake.reaches.set(ANA, new Set());
        fake.chatUse.delete(BEN);
        await relayToGames("m1");
        expect(fake.relayed).toEqual([]);
    });

    it("stays quiet where the corner note would", async () => {
        fake.members = [member(AUTHOR, "Carla"), member(ANA, "Ana", true), member(BEN, "Ben")];
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
