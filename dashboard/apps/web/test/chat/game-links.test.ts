/**
 * A conversation an app has linked a game server to: the badge, which opens the
 * server's page only for somebody who could open it anyway; `/online` answered
 * as a line in the conversation, only where the linked app answers it and not
 * as often as a room can type it; and what somebody may link at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    message: null as null | Record<string, unknown>,
    links: [] as Record<string, unknown>[],
    answers: [] as string[],
    asked: [] as unknown[],
    posted: [] as { channelId: string; body: string; actorId: string }[],
    limited: false,
    rateKeys: [] as string[],
    opens: new Set<string>(),
    memberships: [] as { channel: { id: string; name: string } }[],
    reachable: new Set<string>(),
    levels: new Map<string, string>(),
    spaces: [] as Record<string, unknown>[],
    spaceQuery: null as unknown
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: { findUnique: async () => fake.message },
        chatChannelMember: { findMany: async () => fake.memberships },
        chatSpace: {
            findMany: async (query: unknown) => {
                fake.spaceQuery = query;
                return fake.spaces;
            }
        }
    }
}));
vi.mock("@/lib/app-extensions/registry", () => ({
    chatGameLinks: async () => fake.links,
    answerChatCommand: async (input: unknown) => {
        fake.asked.push(input);
        return fake.answers;
    }
}));
vi.mock("@/lib/chat/notices", () => ({
    postNoticeBody: async (channelId: string, body: string, actorId: string) => {
        fake.posted.push({ channelId, body, actorId });
    }
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        fake.rateKeys.push(key);
        return { ok: !fake.limited, retryAfterMs: 0 };
    }
}));
vi.mock("@/lib/effective-access", () => ({
    effectiveCanOn: async (_user: string, _permission: string, ref: { id: string }) =>
        fake.opens.has(ref.id)
}));
vi.mock("@/lib/chat/access", () => ({
    reachableSpaceIds: async () => fake.reachable,
    spaceAccess: async (_actor: unknown, spaceId: string) => fake.levels.get(spaceId) ?? null
}));

const { commandIn } = await import("@/lib/chat/chat-command");
const links = await import("@/lib/chat/game-links");

const LINK = {
    channelId: "c1",
    installedAppId: "survival",
    ownerId: "owner",
    name: "Survival",
    game: "Minecraft",
    logo: "/logos/minecraft.webp",
    commands: [{ name: "online", description: "Who is playing right now" }]
};

beforeEach(() => {
    fake.message = {
        body: "/online",
        channelId: "c1",
        parentId: null,
        kind: "text",
        deletedAt: null
    };
    fake.links = [LINK];
    fake.answers = ["1 of 10 playing on Survival: Ada"];
    fake.asked = [];
    fake.posted = [];
    fake.limited = false;
    fake.rateKeys = [];
    fake.opens = new Set();
    fake.memberships = [];
    fake.reachable = new Set();
    fake.levels = new Map();
    fake.spaces = [];
    fake.spaceQuery = null;
});

describe("a message that is a command", () => {
    it("is a slash and one word, and nothing else", () => {
        expect(commandIn("/online")).toBe("online");
        expect(commandIn("  /Status  ")).toBe("status");
        expect(commandIn("/online please")).toBeNull();
        expect(commandIn("see /online")).toBeNull();
        expect(commandIn("/")).toBeNull();
        expect(commandIn("//online")).toBeNull();
    });
});

describe("answering a command", () => {
    it("writes the linked app's answer into the conversation, as whoever asked", async () => {
        await links.answerCommand("m1", "ada");
        expect(fake.asked).toEqual([{ channelId: "c1", command: "online" }]);
        expect(fake.posted).toEqual([
            { channelId: "c1", body: "1 of 10 playing on Survival: Ada", actorId: "ada" }
        ]);
        expect(fake.rateKeys).toEqual(["chat-command:c1"]);
    });

    it("asks nothing where no linked app offers that command", async () => {
        fake.message = { ...fake.message!, body: "/status" };
        await links.answerCommand("m1", "ada");
        fake.links = [];
        fake.message = { ...fake.message!, body: "/online" };
        await links.answerCommand("m1", "ada");
        expect(fake.asked).toEqual([]);
        expect(fake.posted).toEqual([]);
        expect(fake.rateKeys).toEqual([]);
    });

    it("leaves a thread reply, a deleted message and ordinary words alone", async () => {
        fake.message = { ...fake.message!, parentId: "root" };
        await links.answerCommand("m1", "ada");
        fake.message = { ...fake.message!, parentId: null, deletedAt: new Date() };
        await links.answerCommand("m1", "ada");
        fake.message = { ...fake.message!, deletedAt: null, body: "who is /online?" };
        await links.answerCommand("m1", "ada");
        expect(fake.asked).toEqual([]);
    });

    it("stops answering a room that asks too often", async () => {
        fake.limited = true;
        await links.answerCommand("m1", "ada");
        expect(fake.asked).toEqual([]);
        expect(fake.posted).toEqual([]);
    });
});

describe("the badge", () => {
    it("links to the server's page only for somebody who may open it", async () => {
        let views = await links.gameLinksFor({ id: "ada" }, ["c1"]);
        expect(views.get("c1")).toEqual([
            {
                installedAppId: "survival",
                name: "Survival",
                game: "Minecraft",
                logo: "/logos/minecraft.webp",
                href: null,
                commands: LINK.commands
            }
        ]);
        fake.opens = new Set(["survival"]);
        views = await links.gameLinksFor({ id: "ada" }, ["c1"]);
        expect(views.get("c1")?.[0]?.href).toBe("/apps/installed/survival");
    });

    it("draws only a mark this dashboard serves itself", async () => {
        fake.links = [{ ...LINK, logo: "https://elsewhere.test/logo.png" }];
        const views = await links.gameLinksFor({ id: "ada" }, ["c1"]);
        expect(views.get("c1")?.[0]?.logo).toBeNull();
    });
});

describe("what may be linked", () => {
    it("is the groups somebody is in, and only the spaces they run", async () => {
        fake.memberships = [
            { channel: { id: "g2", name: "Zeta" } },
            { channel: { id: "g1", name: "" } }
        ];
        fake.reachable = new Set(["s-owned", "s-admin", "s-member"]);
        fake.levels = new Map([
            ["s-owned", "owner"],
            ["s-admin", "admin"],
            ["s-member", "member"]
        ]);
        fake.spaces = [
            {
                id: "s-owned",
                name: "ExampleSMP",
                channels: [
                    { id: "v1", name: "voice", kind: "voice", private: false, members: [] },
                    { id: "t1", name: "general", kind: "text", private: false, members: [] },
                    { id: "t2", name: "staff", kind: "text", private: true, members: [] },
                    { id: "t3", name: "mine", kind: "text", private: true, members: [{ id: "m" }] }
                ]
            }
        ];
        const linkable = await links.linkableConversations("ada");
        expect(linkable.groups).toEqual([
            { id: "g1", name: "Unnamed group" },
            { id: "g2", name: "Zeta" }
        ]);
        expect(fake.spaceQuery).toMatchObject({ where: { id: { in: ["s-owned", "s-admin"] } } });
        expect(linkable.spaces[0]?.channels.map((channel) => channel.id)).toEqual([
            "v1",
            "t1",
            "t3"
        ]);
    });
});
