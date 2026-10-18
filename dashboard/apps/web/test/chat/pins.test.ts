/**
 * Pinning a message for everybody in a conversation.
 *
 * The rule of who may (one function, asked by the screen and by the service),
 * how long a pin lasts, and what pinning refuses: a reader who may not, a line
 * Polaris wrote, a reply inside a thread, a deleted message, and the fifty-first
 * pin.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    message: null as null | Record<string, unknown>,
    channel: { kind: "text", ownerId: null, createdById: null, membersMayEdit: false },
    access: { mayPost: true, mayModerate: true },
    pinned: 0,
    updates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
    published: [] as Array<{ kind: string }>,
    notices: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findUnique: async () => db.message,
            count: async () => db.pinned,
            update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                db.updates.push(args);
                return {};
            },
            findMany: async () => []
        },
        chatChannel: { findUnique: async () => db.channel },
        user: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return {
        ChatAccessError: actual.ChatAccessError,
        pinsAllowed: actual.pinsAllowed,
        requireChannel: async () => db.access
    };
});

vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: { kind: string }) => db.published.push(change)
}));

vi.mock("@/lib/chat/notices", () => ({
    postNotice: async (_channelId: string, kind: string) => {
        db.notices.push(kind);
    }
}));

vi.mock("@/lib/chat/messages", () => ({
    MESSAGE_SELECT: {},
    decorateMessages: async () => []
}));

const { pinsAllowed } = await import("@/lib/chat/access");
const { pin, unpin } = await import("@/lib/chat/pins");
const { MAX_PINS, pinExpiry, pinInputSchema } = await import("@/lib/chat/pin-rules");

const ME = { id: "0190a000-0000-7000-8000-000000000001" };
const MESSAGE_ID = "0190a000-0000-7000-8000-0000000000aa";

beforeEach(() => {
    db.message = {
        channelId: "c1",
        kind: "text",
        parentId: null,
        deletedAt: null,
        pinnedAt: null,
        pinExpiresAt: null
    };
    db.channel = { kind: "text", ownerId: null, createdById: null, membersMayEdit: false };
    db.access = { mayPost: true, mayModerate: true };
    db.pinned = 0;
    db.updates.length = 0;
    db.published.length = 0;
    db.notices.length = 0;
});

describe("who may pin", () => {
    const base = {
        ownerId: "owner",
        createdById: "owner",
        membersMayEdit: false,
        mayModerate: false
    };

    it("either person in a direct message", () => {
        expect(pinsAllowed({ ...base, kind: "dm" }, "anyone")).toBe(true);
    });

    it("a group's owner, and everybody when the owner lets the group change it", () => {
        expect(pinsAllowed({ ...base, kind: "group" }, "owner")).toBe(true);
        expect(pinsAllowed({ ...base, kind: "group" }, "member")).toBe(false);
        expect(pinsAllowed({ ...base, kind: "group", membersMayEdit: true }, "member")).toBe(true);
    });

    it("whoever runs a space's channel, and nobody else", () => {
        expect(pinsAllowed({ ...base, kind: "text" }, "member")).toBe(false);
        expect(pinsAllowed({ ...base, kind: "text", mayModerate: true }, "member")).toBe(true);
        expect(pinsAllowed({ ...base, kind: "voice", mayModerate: true }, "member")).toBe(true);
    });
});

describe("how long a pin lasts", () => {
    const now = new Date("2026-10-08T12:00:00Z");

    it("a day, a week, a month, or until unpinned", () => {
        expect(pinExpiry("day", now)?.toISOString()).toBe("2026-10-09T12:00:00.000Z");
        expect(pinExpiry("week", now)?.toISOString()).toBe("2026-10-15T12:00:00.000Z");
        expect(pinExpiry("month", now)?.toISOString()).toBe("2026-11-07T12:00:00.000Z");
        expect(pinExpiry("forever", now)).toBeNull();
    });

    it("accepts only those four, for a message id", () => {
        expect(pinInputSchema.safeParse({ messageId: MESSAGE_ID, duration: "week" }).success).toBe(
            true
        );
        expect(pinInputSchema.safeParse({ messageId: MESSAGE_ID, duration: "year" }).success).toBe(
            false
        );
        expect(pinInputSchema.safeParse({ messageId: "not-an-id", duration: "day" }).success).toBe(
            false
        );
    });
});

describe("pinning", () => {
    it("pins for everybody, announces it once, and tells the other tabs", async () => {
        await pin(ME, { messageId: MESSAGE_ID, duration: "forever" });
        expect(db.updates[0]?.data).toMatchObject({ pinnedById: ME.id, pinExpiresAt: null });
        expect(db.updates[0]?.data.pinnedAt).toBeInstanceOf(Date);
        expect(db.published.map((change) => change.kind)).toEqual(["pins"]);
        expect(db.notices).toEqual(["pinned"]);
    });

    it("does not announce a pin that was only made to last longer", async () => {
        db.message = { ...db.message, pinnedAt: new Date(), pinExpiresAt: null };
        await pin(ME, { messageId: MESSAGE_ID, duration: "day" });
        expect(db.updates).toHaveLength(1);
        expect(db.notices).toEqual([]);
    });

    it("refuses somebody who may not", async () => {
        db.access = { mayPost: true, mayModerate: false };
        await expect(pin(ME, { messageId: MESSAGE_ID, duration: "week" })).rejects.toThrow();
        expect(db.updates).toEqual([]);
    });

    it("refuses in an archived conversation", async () => {
        db.access = { mayPost: false, mayModerate: true };
        await expect(pin(ME, { messageId: MESSAGE_ID, duration: "week" })).rejects.toThrow();
    });

    it("refuses a line Polaris wrote, a thread reply and a deleted message", async () => {
        for (const change of [{ kind: "system" }, { parentId: "p" }, { deletedAt: new Date() }]) {
            db.message = { ...db.message, ...change };
            await expect(pin(ME, { messageId: MESSAGE_ID, duration: "week" })).rejects.toThrow();
        }
        expect(db.updates).toEqual([]);
    });

    it("refuses one more than the conversation holds", async () => {
        db.pinned = MAX_PINS;
        await expect(pin(ME, { messageId: MESSAGE_ID, duration: "week" })).rejects.toThrow();
        expect(db.updates).toEqual([]);
    });

    it("unpins, and does nothing to a message that was not pinned", async () => {
        await unpin(ME, MESSAGE_ID);
        expect(db.updates).toEqual([]);
        db.message = { ...db.message, pinnedAt: new Date() };
        await unpin(ME, MESSAGE_ID);
        expect(db.updates[0]?.data).toEqual({
            pinnedAt: null,
            pinnedById: null,
            pinExpiresAt: null
        });
        expect(db.published.map((change) => change.kind)).toEqual(["pins"]);
    });
});
