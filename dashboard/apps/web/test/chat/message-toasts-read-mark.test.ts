/**
 * Sending a message never announces the one it answered.
 *
 * Posting wakes every other tab and the desktop app with a "posted" frame for
 * that conversation. They ask what is new there, and the newest message that is
 * not the reader's own is the one they were replying to - read already, and
 * chimed for as if it had just arrived. Nothing at or before the read mark is
 * news.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    lastReadAt: null as Date | null,
    messages: [] as { id: string; createdAt: Date; authorId: string }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannelMember: {
            findMany: async () => [
                { channelId: "c1", muted: false, mutedUntil: null, locked: false, lastReadAt: state.lastReadAt }
            ]
        },
        chatMessage: {
            findMany: async () =>
                [...state.messages]
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
                    .map((message) => ({
                        ...message,
                        channelId: "c1",
                        body: `<p>${message.id}</p>`,
                        attachments: [],
                        channel: { id: "c1", name: "general", kind: "channel", spaceId: "s1", members: [] }
                    }))
        },
        user: { findMany: async () => [{ id: "bob", name: "Bob" }] }
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

const actor = { id: "alice" } as Parameters<typeof messageToasts>[0];
const at = (seconds: number) => new Date(Date.now() - 60_000 + seconds * 1000);

describe("message toasts and the read mark", () => {
    beforeEach(() => {
        state.messages = [{ id: "bob-asks", createdAt: at(0), authorId: "bob" }];
        state.lastReadAt = null;
    });

    it("announces a message nobody has read", async () => {
        const toasts = await messageToasts(actor, ["c1"]);
        expect(toasts.map((toast) => toast.messageId)).toEqual(["bob-asks"]);
    });

    it("stays quiet once the reader answered, which marks everything before read", async () => {
        // Alice's reply is hers and never listed; posting moved her mark to it.
        state.lastReadAt = at(5);
        expect(await messageToasts(actor, ["c1"])).toEqual([]);
    });

    it("still announces what arrived after the mark", async () => {
        state.lastReadAt = at(5);
        state.messages.push({ id: "bob-again", createdAt: at(9), authorId: "bob" });
        const toasts = await messageToasts(actor, ["c1"]);
        expect(toasts.map((toast) => toast.messageId)).toEqual(["bob-again"]);
    });
});
