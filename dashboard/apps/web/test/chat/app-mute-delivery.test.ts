/**
 * Chat muted as a whole from the app menu holds back every message toast -
 * and with it the chime and the desktop notice, which are drawn from them -
 * the same as a conversation's own mute does, and lets them through again once
 * the mute runs out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    holds: null as string | null,
    holdQueries: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannelMember: {
            findMany: async () => [
                { channelId: "c1", muted: false, mutedUntil: null, locked: false, lastReadAt: null }
            ]
        },
        chatMessage: {
            findMany: async () => [
                {
                    id: "bob-says",
                    createdAt: new Date(Date.now() - 1000),
                    authorId: "bob",
                    channelId: "c1",
                    body: "<p>hello</p>",
                    attachments: [],
                    channel: { id: "c1", name: "general", kind: "channel", spaceId: "s1", members: [] }
                }
            ]
        },
        user: {
            findMany: async (query: { where: { notifyHolds?: unknown; id: { in: string[] } } }) => {
                if (query.where.notifyHolds) {
                    state.holdQueries.push(query.where);
                    return state.holds && query.where.id.in.includes("alice")
                        ? [{ id: "alice", notifyHolds: state.holds }]
                        : [];
                }
                return [{ id: "bob", name: "Bob" }];
            }
        }
    }
}));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set(["c1"]) }));
vi.mock("@/lib/chat/notify", () => ({
    notifyLevels: async () => new Map([["c1", "all"]]),
    readerTeams: async () => new Set(),
    mentionsReader: () => false
}));
vi.mock("@/lib/chat/history-visibility", () => ({
    historyFloors: async () => new Map(),
    readableWhere: () => ({})
}));
vi.mock("@/lib/chat/age-gate", () => ({ ageClearedWhere: () => ({}) }));
vi.mock("@/lib/blocks", () => ({ blockedBy: async () => new Set() }));

const { messageToasts } = await import("@/lib/chat/toasts");
const { chatMutedUsers } = await import("@/lib/chat/app-mute");

const actor = { id: "alice" } as Parameters<typeof messageToasts>[0];
const mute = (until: string | null) => JSON.stringify({ mutes: { "app:chat": { until } } });

describe("Chat muted from the app menu", () => {
    beforeEach(() => {
        state.holds = null;
        state.holdQueries = [];
    });

    it("announces as usual while Chat is not muted", async () => {
        const toasts = await messageToasts(actor, ["c1"]);
        expect(toasts.map((toast) => toast.messageId)).toEqual(["bob-says"]);
    });

    it("announces nothing while Chat is muted until turned back on", async () => {
        state.holds = mute(null);
        expect(await messageToasts(actor, ["c1"])).toEqual([]);
    });

    it("announces nothing before a timed mute ends, and again after it", async () => {
        state.holds = mute(new Date(Date.now() + 60_000).toISOString());
        expect(await messageToasts(actor, ["c1"])).toEqual([]);
        state.holds = mute(new Date(Date.now() - 60_000).toISOString());
        expect((await messageToasts(actor, ["c1"])).length).toBe(1);
    });

    it("reads only the accounts whose holds name the key", async () => {
        state.holds = mute(null);
        expect(await chatMutedUsers(["alice", "bob", "alice"])).toEqual(new Set(["alice"]));
        expect(state.holdQueries).toEqual([
            { id: { in: ["alice", "bob"] }, notifyHolds: { contains: '"app:chat"' } }
        ]);
        expect(await chatMutedUsers([])).toEqual(new Set());
    });
});
