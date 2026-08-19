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
let channels: { id: string }[] = [];
let grouped: { channelId: string; _count: { _all: number } }[] = [];
let sinceCounts: Record<string, number> = {};

vi.mock("@polaris/db", () => ({
    prisma: {
        // Nobody has blocked anybody here; blocking has its own test.
        userBlock: { findMany: async () => [] },
        chatChannelMember: { findMany: async () => members },
        chatChannel: { findMany: async () => channels },
        chatMessage: {
            groupBy: async () => grouped,
            count: async ({ where }: { where: { channelId: string } }) => sinceCounts[where.channelId] ?? 0
        }
    }
}));

const { unreadTotal } = await import("@/lib/chat/chat-service");

/** A membership in a conversation, read up to `at` or never opened. */
function member(channelId: string, at: Date | null = null, mute?: { muted: boolean; mutedUntil: Date | null }) {
    return { channelId, lastReadAt: at, muted: mute?.muted ?? false, mutedUntil: mute?.mutedUntil ?? null };
}

beforeEach(() => {
    members = [];
    channels = [];
    grouped = [];
    sinceCounts = {};
});

describe("what is waiting in Chat", () => {
    it("is nothing for somebody in no conversation", async () => {
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 0, conversations: 0 });
    });

    it("adds up the conversations that have something in them", async () => {
        members = [member("a"), member("b"), member("c")];
        channels = [{ id: "a" }, { id: "b" }, { id: "c" }];
        grouped = [
            { channelId: "a", _count: { _all: 3 } },
            { channelId: "b", _count: { _all: 2 } }
        ];
        // Three messages in one and two in another, and the third is silent.
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 5, conversations: 2 });
    });

    it("counts only what arrived after they last caught up", async () => {
        const read = new Date("2026-08-18T10:00:00Z");
        members = [member("a", read)];
        channels = [{ id: "a" }];
        grouped = [{ channelId: "a", _count: { _all: 40 } }];
        sinceCounts = { a: 2 };
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 2, conversations: 1 });
    });

    it("says nothing about a muted conversation", async () => {
        // A mute is somebody asking not to be told, and a badge is being told.
        members = [member("a", null, { muted: true, mutedUntil: null })];
        channels = [{ id: "a" }];
        grouped = [{ channelId: "a", _count: { _all: 9 } }];
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 0, conversations: 0 });
    });

    it("counts one whose mute has run out", async () => {
        // Nothing runs to clear the flag when the end passes, so it is worked
        // out rather than read - the same way the rail works it out.
        members = [member("a", null, { muted: true, mutedUntil: new Date("2020-01-01T00:00:00Z") })];
        channels = [{ id: "a" }];
        grouped = [{ channelId: "a", _count: { _all: 4 } }];
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 4, conversations: 1 });
    });

    it("leaves out an archived conversation", async () => {
        members = [member("a"), member("b")];
        // Only the live one comes back from the channel query.
        channels = [{ id: "a" }];
        grouped = [
            { channelId: "a", _count: { _all: 1 } },
            { channelId: "b", _count: { _all: 50 } }
        ];
        expect(await unreadTotal({ id: "u1" })).toEqual({ messages: 1, conversations: 1 });
    });
});
