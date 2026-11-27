/**
 * `@everyone` in a large space: the roster is read a page at a time with a
 * cursor, never in one go; each page's notifications are written a bounded
 * number at a time; each reader is told once per message however often the
 * fan-out runs; and `@here` starts from who is online rather than the roster.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "00000000-0000-4000-8000-0000000000aa";
const AUTHOR = "00000000-0000-4000-8000-000000000000";

const state = vi.hoisted(() => ({
    members: [] as string[],
    online: new Set<string>(),
    memberQueries: [] as { where: Record<string, unknown>; take?: number }[],
    inFlight: 0,
    peak: 0,
    notified: [] as { userId: string; dedupKey?: string | null; once?: boolean }[]
}));

function page(query: { where: Record<string, unknown>; take?: number }) {
    state.memberQueries.push(query);
    const where = query.where as { userId?: { gt?: string; in?: string[] } };
    let rows = [...state.members].sort();
    if (where.userId?.gt) rows = rows.filter((id) => id > where.userId!.gt!);
    if (where.userId?.in) rows = rows.filter((id) => where.userId!.in!.includes(id));
    return rows.slice(0, query.take ?? rows.length).map((userId) => ({ userId }));
}

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findUnique: async () => ({
                id: "c1",
                name: "general",
                kind: "text",
                spaceId: SPACE,
                private: false,
                orgId: null,
                space: { orgId: null }
            })
        },
        chatSpaceMember: { findMany: async (query: never) => page(query) },
        chatChannelMember: { findMany: async (query: never) => page(query) },
        user: { findUnique: async () => ({ name: "Author" }) }
    }
}));
vi.mock("@/lib/notifications/presence", () => ({ onlineUserIds: () => state.online }));
vi.mock("@/lib/chat/notify", () => ({
    muteStates: async () => () => ({ conversation: false, app: false }),
    silencedIn: async () => new Set<string>()
}));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/chat/chat-lock", () => ({ lockedFor: async () => new Set<string>() }));
vi.mock("@/lib/chat/text", () => ({ chatWordsFor: async () => (key: string) => key }));
vi.mock("@/lib/chat/isolation", () => ({ chatAlertShelf: async () => null }));
vi.mock("@/lib/workspace-scope", () => ({ recipientShelf: async () => null }));
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { userId: string; dedupKey?: string; once?: boolean }) => {
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        state.inFlight--;
        state.notified.push(input);
        return "created";
    }
}));

import {
    announceRoomMention,
    ROOM_MENTION_CONCURRENCY,
    ROOM_MENTION_PAGE
} from "@/lib/chat/room-mentions";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

beforeEach(() => {
    state.members = Array.from({ length: 1201 }, (_, n) => id(n + 1));
    state.online = new Set();
    state.memberQueries = [];
    state.inFlight = 0;
    state.peak = 0;
    state.notified = [];
});

describe("@everyone fan-out", () => {
    it("pages the roster with a cursor and a take, never all of it at once", async () => {
        await announceRoomMention("c1", AUTHOR, "@everyone hi", "m1");
        expect(state.memberQueries.length).toBe(Math.ceil(1201 / ROOM_MENTION_PAGE));
        for (const query of state.memberQueries) expect(query.take).toBe(ROOM_MENTION_PAGE);
        expect(state.memberQueries[0]!.where).not.toHaveProperty("userId");
        expect(state.memberQueries[1]!.where).toHaveProperty("userId.gt");
        expect(state.notified).toHaveLength(1201);
    });

    it("writes at most ROOM_MENTION_CONCURRENCY notifications at once", async () => {
        await announceRoomMention("c1", AUTHOR, "@everyone hi", "m1");
        expect(state.peak).toBeGreaterThan(1);
        expect(state.peak).toBeLessThanOrEqual(ROOM_MENTION_CONCURRENCY);
    });

    it("marks every notification with one key per message, so a rerun tells nobody twice", async () => {
        await announceRoomMention("c1", AUTHOR, "@everyone hi", "m1");
        expect(new Set(state.notified.map((row) => row.dedupKey))).toEqual(
            new Set(["chat.room-mention:m1"])
        );
        expect(state.notified.every((row) => row.once === true)).toBe(true);
    });
});

describe("@here fan-out", () => {
    it("reads only the online people, and tells only those in the room", async () => {
        state.online = new Set([id(5), id(9), "00000000-0000-4000-8000-ffffffffffff"]);
        await announceRoomMention("c1", AUTHOR, "@here anyone?", "m2");
        expect(state.notified.map((row) => row.userId).sort()).toEqual([id(5), id(9)]);
        // One bounded membership check of the online ids, not a walk of the roster.
        expect(state.memberQueries).toHaveLength(1);
        expect(state.memberQueries[0]!.where).toHaveProperty("userId.in");
        expect(state.memberQueries[0]!.take).toBe(ROOM_MENTION_PAGE);
    });
});
