/**
 * How much of Chat is waiting for one person, across the whole of it.
 *
 * This is what puts a number on the tab icon and on the Chat entry, so it is
 * read by somebody who is not in Chat and cannot see what it is counting. That
 * makes the exclusions the important part: a count they cannot take down, or one
 * they asked not to be given, is a badge that gets ignored - and an ignored badge
 * costs the message it was there for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The rows the queries below read, per case. */
let members: { channelId: string; lastReadAt: Date | null; muted: boolean; mutedUntil: Date | null }[] = [];
let channels: { id: string; spaceId: string | null; orgId: string | null }[] = [];
let spaces: { id: string; orgId: string | null }[] = [];
/** Every countable message, by conversation and when it was written. */
let posted: { channelId: string; createdAt: Date }[] = [];
/** What each grouped count was asked, so a case can pin the question itself. */
let asked: GroupWhere[] = [];

type Branch = { channelId: string; createdAt: { gt: Date } } | { channelId: { in: string[] } };
interface GroupWhere {
    deletedAt: null;
    authorId: { notIn: string[] };
    kind: { not: string };
    parentId: null;
    OR: Branch[];
}

/** The grouped count, answered from `posted` the way the database would: a
 *  message counts when any one branch takes it. */
function groupBy({ where }: { where: GroupWhere }) {
    asked.push(where);
    const counts = new Map<string, number>();
    for (const message of posted) {
        const taken = where.OR.some((branch) =>
            typeof branch.channelId === "string"
                ? branch.channelId === message.channelId &&
                  "createdAt" in branch &&
                  message.createdAt > branch.createdAt.gt
                : branch.channelId.in.includes(message.channelId)
        );
        if (taken) counts.set(message.channelId, (counts.get(message.channelId) ?? 0) + 1);
    }
    return [...counts].map(([channelId, all]) => ({ channelId, _count: { _all: all } }));
}

/** `count` messages in one conversation, all written at `at`. */
function say(channelId: string, count: number, at = new Date("2026-08-18T09:00:00Z")) {
    for (let index = 0; index < count; index += 1) posted.push({ channelId, createdAt: at });
}
/** The chats the open shelf shows: the shared one unless a case says otherwise. */
let shelfChats = new Set<string | null>([null]);

vi.mock("@/lib/chat/isolation", () => ({
    readableChatScopes: async () => shelfChats,
    currentChatOrgId: async () => null,
    orgChatPeople: async () => new Set()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        // Nobody has blocked anybody here; blocking has its own test.
        userBlock: { findMany: async () => [] },
        chatChannelMember: { findMany: async () => members },
        chatChannel: { findMany: async () => channels },
        chatSpace: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                spaces.filter((space) => where.id.in.includes(space.id))
        },
        chatMessage: {
            groupBy: async (query: { where: GroupWhere }) => groupBy(query),
            // Not asked any more: one grouped query answers every conversation.
            count: async () => {
                throw new Error("counted one conversation at a time");
            }
        }
    }
}));

const { unreadTotal } = await import("@/lib/chat/chat-service");

/** A membership in a conversation, read up to `at` or never opened. */
function member(channelId: string, at: Date | null = null, mute?: { muted: boolean; mutedUntil: Date | null }) {
    return { channelId, lastReadAt: at, muted: mute?.muted ?? false, mutedUntil: mute?.mutedUntil ?? null };
}

/** A live conversation, in the shared chat unless it is filed elsewhere. */
function room(id: string, filed: { spaceId?: string; orgId?: string } = {}) {
    return { id, spaceId: filed.spaceId ?? null, orgId: filed.orgId ?? null };
}

beforeEach(() => {
    members = [];
    channels = [];
    spaces = [];
    posted = [];
    asked = [];
    shelfChats = new Set([null]);
});

describe("what is waiting in Chat", () => {
    it("is nothing for somebody in no conversation", async () => {
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 0, conversations: 0 });
    });

    it("adds up the conversations that have something in them", async () => {
        members = [member("a"), member("b"), member("c")];
        channels = [room("a"), room("b"), room("c")];
        say("a", 3);
        say("b", 2);
        // Three messages in one and two in another, and the third is silent.
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 5, conversations: 2 });
    });

    it("counts only what arrived after they last caught up", async () => {
        const read = new Date("2026-08-18T10:00:00Z");
        members = [member("a", read)];
        channels = [room("a")];
        // Thirty-eight read before the mark, two written after it.
        say("a", 38, new Date("2026-08-18T09:00:00Z"));
        say("a", 2, new Date("2026-08-18T11:00:00Z"));
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 2, conversations: 1 });
    });

    it("says nothing about a muted conversation", async () => {
        // A mute is somebody asking not to be told, and a badge is being told.
        members = [member("a", null, { muted: true, mutedUntil: null })];
        channels = [room("a")];
        say("a", 9);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 0, conversations: 0 });
    });

    it("counts one whose mute has run out", async () => {
        // Nothing runs to clear the flag when the end passes, so it is worked
        // out rather than read - the same way the rail works it out.
        members = [member("a", null, { muted: true, mutedUntil: new Date("2020-01-01T00:00:00Z") })];
        channels = [room("a")];
        say("a", 4);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 4, conversations: 1 });
    });

    it("leaves out an archived conversation", async () => {
        members = [member("a"), member("b")];
        // Only the live one comes back from the channel query.
        channels = [room("a")];
        say("a", 1);
        say("b", 50);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 1, conversations: 1 });
    });
});

describe("what is waiting in Chat, on the open shelf", () => {
    it("leaves out an organization's own chat while somebody is on another shelf", async () => {
        // The rail on the personal shelf does not list Acme's conversations,
        // so the badge there must not count them either.
        members = [member("mine"), member("acme")];
        channels = [room("mine"), room("acme", { orgId: "acme" })];
        say("mine", 1);
        say("acme", 7);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 1, conversations: 1 });
    });

    it("counts only that organization's chat on its own shelf", async () => {
        shelfChats = new Set(["acme"]);
        members = [member("mine"), member("acme")];
        channels = [room("mine"), room("acme", { orgId: "acme" })];
        say("mine", 1);
        say("acme", 7);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 7, conversations: 1 });
    });

    it("files a room in a space by the space, as the rail does", async () => {
        shelfChats = new Set(["acme"]);
        spaces = [{ id: "eng", orgId: "acme" }];
        members = [member("general")];
        channels = [room("general", { spaceId: "eng" })];
        say("general", 3);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 3, conversations: 1 });

        shelfChats = new Set([null]);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 0, conversations: 0 });
    });
});

describe("what is waiting in Chat, asked of the database", () => {
    it("is one grouped question however many conversations there are", async () => {
        // The rail and the badge read this on every page. One count per
        // conversation was forty-one round trips for forty conversations.
        const read = new Date("2026-08-18T10:00:00Z");
        members = [member("a", read), member("b", read), member("c"), member("d")];
        channels = [room("a"), room("b"), room("c"), room("d")];
        say("a", 3, new Date("2026-08-18T09:00:00Z"));
        say("a", 1, new Date("2026-08-18T11:00:00Z"));
        say("b", 2, new Date("2026-08-18T11:00:00Z"));
        say("c", 5);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 8, conversations: 3 });
        expect(asked).toHaveLength(1);
    });

    it("asks after the mark where there is one, and from the start where there is not", async () => {
        const read = new Date("2026-08-18T10:00:00Z");
        members = [member("a", read), member("c"), member("d")];
        channels = [room("a"), room("c"), room("d")];
        await unreadTotal({ id: "u1" });
        expect(asked[0]?.OR).toEqual([
            // The ones never opened share a branch: their threshold is the same.
            { channelId: { in: ["c", "d"] } },
            { channelId: "a", createdAt: { gt: read } }
        ]);
    });

    it("keeps the exclusions the badge has always had", async () => {
        members = [member("a")];
        channels = [room("a")];
        await unreadTotal({ id: "u1" });
        // Deleted messages, thread replies, lines Polaris wrote itself and the
        // reader's own - and, with nobody blocked here, nobody else.
        expect(asked[0]).toMatchObject({
            deletedAt: null,
            parentId: null,
            kind: { not: "system" },
            authorId: { notIn: ["u1"] }
        });
    });

    it("stops a conversation's count at the cap", async () => {
        members = [member("a")];
        channels = [room("a")];
        say("a", 150);
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 99, conversations: 1 });
    });
});
