import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    chatChannel: { findMany: vi.fn() },
    chatMessage: { findUnique: vi.fn() }
}));
vi.mock("@polaris/db", () => ({ prisma: db }));

import * as history from "@/lib/chat/history-visibility";

const joined = new Date("2026-10-10T00:00:00Z");
const actor = { id: "user-1" };

describe("newcomersReadHistory", () => {
    it("shows history by default everywhere", () => {
        expect(
            history.newcomersReadHistory(
                { kind: "text", spaceId: "s", newcomerHistory: "inherit" },
                null
            )
        ).toBe(true);
        expect(
            history.newcomersReadHistory(
                { kind: "group", spaceId: null, newcomerHistory: "inherit" },
                null
            )
        ).toBe(true);
    });
    it("follows the space default, and a channel overrides it", () => {
        expect(
            history.newcomersReadHistory(
                { kind: "text", spaceId: "s", newcomerHistory: "inherit" },
                false
            )
        ).toBe(false);
        expect(
            history.newcomersReadHistory(
                { kind: "text", spaceId: "s", newcomerHistory: "on" },
                false
            )
        ).toBe(true);
        expect(
            history.newcomersReadHistory(
                { kind: "text", spaceId: "s", newcomerHistory: "off" },
                true
            )
        ).toBe(false);
    });
    it("never restricts a 1:1 conversation", () => {
        expect(
            history.newcomersReadHistory(
                { kind: "dm", spaceId: null, newcomerHistory: "off" },
                false
            )
        ).toBe(true);
    });
});

describe("historyFloor", () => {
    const base = {
        readsHistory: false,
        spaceId: "s",
        private: false,
        channelJoinedAt: new Date(0),
        spaceJoinedAt: joined
    };
    it("is open when history is shown", () => {
        expect(history.historyFloor({ ...base, readsHistory: true })).toBeNull();
    });
    it("uses the space join for an open channel, not the row reading leaves", () => {
        expect(history.historyFloor({ ...base, channelJoinedAt: new Date() })).toEqual(joined);
    });
    it("uses being added for a private channel or a group", () => {
        expect(
            history.historyFloor({
                ...base,
                private: true,
                channelJoinedAt: joined,
                spaceJoinedAt: new Date(0)
            })
        ).toEqual(joined);
        expect(history.historyFloor({ ...base, spaceId: null, channelJoinedAt: joined })).toEqual(
            joined
        );
    });
});

describe("where clauses", () => {
    it("adds nothing when nothing is hidden", () => {
        expect(history.sinceClause(null)).toEqual({});
        expect(history.readableWhere(new Map())).toEqual({});
    });
    it("bounds only the conversations with a floor", () => {
        expect(history.readableWhere(new Map([["c1", joined]]))).toEqual({
            OR: [{ channelId: { notIn: ["c1"] } }, { channelId: "c1", createdAt: { gte: joined } }]
        });
        expect(history.isReadable(joined, new Date("2026-10-09T00:00:00Z"))).toBe(false);
        expect(history.isReadable(joined, joined)).toBe(true);
        expect(history.isReadable(null, new Date(0))).toBe(true);
    });
});

describe("a late joiner", () => {
    beforeEach(() => vi.clearAllMocks());

    it("reads nothing from before joining when the setting is off", async () => {
        db.chatChannel.findMany.mockResolvedValue([
            {
                id: "c1",
                kind: "text",
                spaceId: "s",
                private: false,
                newcomerHistory: "inherit",
                members: [],
                space: { newcomerHistory: false, members: [{ createdAt: joined }] }
            }
        ]);
        expect(await history.readableSince(actor, "c1")).toEqual(joined);
        db.chatMessage.findUnique.mockResolvedValue({
            createdAt: new Date("2026-10-01T00:00:00Z")
        });
        await expect(history.requireReadable(actor, "c1", "m-old")).rejects.toThrow();
        db.chatMessage.findUnique.mockResolvedValue({
            createdAt: new Date("2026-10-11T00:00:00Z")
        });
        await expect(history.requireReadable(actor, "c1", "m-new")).resolves.toBeUndefined();
    });

    it("reads everything when the setting is on", async () => {
        db.chatChannel.findMany.mockResolvedValue([]);
        expect(await history.readableSince(actor, "c1")).toBeNull();
        await expect(history.requireReadable(actor, "c1", "m-old")).resolves.toBeUndefined();
        expect(db.chatMessage.findUnique).not.toHaveBeenCalled();
    });
});
