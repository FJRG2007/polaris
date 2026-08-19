/**
 * What a pasted Polaris link turns into, for the person reading it.
 *
 * The rule with teeth is the second one, and it is the reason this is resolved
 * per reader at all: **reach is the reader's, not the sender's.** Whoever pasted
 * the link could obviously see the room. The person scrolling past it may not be
 * in that space, may not be in that organization, and must not learn what the
 * room is called by being shown a card about it.
 *
 * So an out-of-reach reference comes back carrying nothing - no name, no
 * excerpt, no author, no conversation - and every one of those is asserted
 * separately. A leak here is one field, and one field is the whole leak.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface ChannelRow {
    id: string;
    name: string;
    kind: string;
    members: { userId: string; user: { name: string } }[];
}

interface MessageRow {
    id: string;
    body: string;
    kind: string;
    authorId: string | null;
    channelId: string;
    deletedAt: Date | null;
    createdAt: Date;
}

const VOICE = "0193aaaa-1111-4222-8333-444444444444";
const SECRET = "0193cccc-2222-4333-8444-555555555555";
const ROOM = "0193dddd-3333-4444-8555-666666666666";
const SAID = "0193bbbb-5555-4666-8777-888888888888";

let reachable = new Set<string>();

const channels: ChannelRow[] = [
    { id: VOICE, name: "Standup", kind: "voice", members: [] },
    { id: SECRET, name: "Payroll", kind: "text", members: [] },
    { id: ROOM, name: "General", kind: "text", members: [] }
];

const messages: MessageRow[] = [
    {
        id: SAID,
        body: "The deploy finished",
        kind: "text",
        authorId: "grace",
        channelId: ROOM,
        deletedAt: null,
        createdAt: new Date("2026-08-19T10:00:00Z")
    }
];

vi.mock("@/lib/chat/access", () => ({
    reachableChannelIds: async () => reachable
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                channels.filter((channel) => where.id.in.includes(channel.id))
        },
        chatMessage: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                messages.filter((message) => where.id.in.includes(message.id))
        },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                [{ id: "grace", name: "Grace Hopper" }].filter((person) =>
                    where.id.in.includes(person.id)
                )
        }
    }
}));

const { chatReferencesIn, resolveChatReferences } = await import("@/lib/chat/references");

const ada = { id: "ada" };

beforeEach(() => {
    reachable = new Set([VOICE, ROOM]);
    messages[0]!.deletedAt = null;
});

describe("a conversation somebody pasted", () => {
    it("comes back as itself when the reader is in it", async () => {
        const found = (await resolveChatReferences(ada, [`channel/${VOICE}`])).get(
            `channel/${VOICE}`
        );
        expect(found?.reachable).toBe(true);
        expect(found?.name).toBe("Standup");
        expect(found?.channelKind).toBe("voice");
    });

    it("comes back carrying nothing at all when the reader is not", async () => {
        const found = (await resolveChatReferences(ada, [`channel/${SECRET}`])).get(
            `channel/${SECRET}`
        );
        expect(found?.reachable).toBe(false);
        // Each of these on its own would be the leak.
        expect(found?.name).toBe("");
        expect(found?.channelKind).toBe("");
        expect(found?.channelId).toBe("");
    });

    it("is still in the answer, so the screen draws something rather than a raw link", async () => {
        const resolved = await resolveChatReferences(ada, [`channel/${SECRET}`]);
        expect(resolved.has(`channel/${SECRET}`)).toBe(true);
    });
});

describe("a message somebody pasted", () => {
    it("comes back with what it said and who said it", async () => {
        const found = (await resolveChatReferences(ada, [`message/${SAID}`])).get(
            `message/${SAID}`
        );
        expect(found?.reachable).toBe(true);
        expect(found?.authorName).toBe("Grace Hopper");
        expect(found?.excerpt).toBe("The deploy finished");
        expect(found?.name).toBe("General");
        expect(found?.channelId).toBe(ROOM);
    });

    it("carries nothing when the reader cannot reach the conversation it is in", async () => {
        reachable = new Set();
        const found = (await resolveChatReferences(ada, [`message/${SAID}`])).get(
            `message/${SAID}`
        );
        expect(found?.reachable).toBe(false);
        expect(found?.excerpt).toBe("");
        expect(found?.authorName).toBe("");
        expect(found?.channelId).toBe("");
    });

    it("carries nothing once it has been taken back", async () => {
        // A tombstone belongs to the conversation it is in. A card quoting one
        // somewhere else would be a quote of something that was deleted.
        messages[0]!.deletedAt = new Date();
        const found = (await resolveChatReferences(ada, [`message/${SAID}`])).get(
            `message/${SAID}`
        );
        expect(found?.reachable).toBe(false);
        expect(found?.excerpt).toBe("");
    });

    it("carries nothing when there is no such message", async () => {
        const missing = "0193ffff-9999-4999-8999-999999999999";
        const found = (await resolveChatReferences(ada, [`message/${missing}`])).get(
            `message/${missing}`
        );
        expect(found?.reachable).toBe(false);
    });
});

describe("what is worth looking for at all", () => {
    it("does not parse a message that plainly points at nothing", () => {
        expect(chatReferencesIn("just a sentence")).toEqual([]);
    });

    it("finds the stored form", () => {
        expect(chatReferencesIn(`[#Standup](polaris:channel/${VOICE})`)).toEqual([
            `channel/${VOICE}`
        ]);
    });

    it("finds a task, which is resolved against the reader too", () => {
        const task = "0193eeee-7777-4888-8999-aaaaaaaaaaaa";
        expect(chatReferencesIn(`[a task](polaris:task/${task})`)).toEqual([`task/${task}`]);
    });

    it("leaves a document and a note to whoever gives those two a reach check", () => {
        // Deliberate, and stated so nobody reads their absence as an oversight:
        // they keep the label they were written with until somebody can answer
        // whether this reader may open them.
        const doc = "0193eeee-7777-4888-8999-bbbbbbbbbbbb";
        expect(chatReferencesIn(`[a doc](polaris:doc/${doc})`)).toEqual([]);
    });

    it("answers nothing for a reference set that names nothing in Chat", async () => {
        expect((await resolveChatReferences(ada, [])).size).toBe(0);
    });
});
